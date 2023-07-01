import { CreateChatCompletionRequest, ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum, Configuration, OpenAIApi, CreateChatCompletionResponse } from "openai"
import { TextChannel } from "discord.js";
import { encode } from "gpt-3-encoder"
import { Mutex } from 'async-mutex';
import { AxiosResponse } from "axios";

import { DiscordClient } from "../utils/discordClient";
import { RedisEmbeddingService, VectorSimilarityResult } from "../redis/RedisEmbeddingService";
import { Logger } from "../logger/logger";
import { delay } from "../utils/utils";

const COLLECT_TIMER = 3000; //collect after 3 second
const RESPONSE_TOKEN_LENGTH = 300;

function generateChatCompletionContext(originalContext: ChatCompletionRequestMessage, chatHistory: ChatCompletionRequestMessage[], extraContext: ChatCompletionRequestMessage): number {
    const originalContextTokenLength = encode(originalContext.content).length;
    const chatHistoryTokenLength = encode(chatHistory.reduce((totalString: string, chat) => { return totalString.concat(` ${chat.content}`); }, "")).length;
    const extraContextTokenLength = encode(extraContext.content).length;
    return (2*originalContextTokenLength) + chatHistoryTokenLength + extraContextTokenLength;
}

interface MessageHistory {
    addMessage(message: ChatCompletionRequestMessage),
    getOriginalContext(): ChatCompletionRequestMessage,
    getHistory(): ChatCompletionRequestMessage[],
    purgeOldestEntries(x: number)
}

class MessageHistory implements MessageHistory { // MessageHistory class -- modified queue for storing message history for Chatbot
    private storage: ChatCompletionRequestMessage[] = [];

    constructor(private context: ChatCompletionRequestMessage, private capacity: number = 50) {}

    addMessage(msg: ChatCompletionRequestMessage): void {

        if(this.storage.length == this.capacity) {
            this.storage.splice(0,1); //oldest message gets removed from history
        }
        this.storage.push(msg);
    }

    getOriginalContext(): ChatCompletionRequestMessage {
        return this.context;
    }

    getHistory(): ChatCompletionRequestMessage[] {
        return [...this.storage];
    }

    purgeOldestEntries(x: number) { // purges x number of chats from history
        if (this.storage.length <= x) {
            this.storage = [];
        } else {
            this.storage.splice(0, x);
        }
    }

    makeCopy(): MessageHistory { 
      const copy = new MessageHistory(this.context, this.capacity)
      this.storage.forEach(msg => {
        copy.addMessage(msg);
      })
      return copy;
    }
}

interface MessageProcessor {
    processMessage(msg: string, channelId: string): Promise<void>
}

class MessageProcessor implements MessageProcessor { // MessageProcessor class -- Processes messages for chatbot
    private requestBasket: string[] = []; //basket for storing requests
    private responseBasket: string[] = []; //basket for generating response
    private isCollecting: boolean;
    private collectingTimer: NodeJS.Timeout
    private mutex: Mutex;

    constructor(private history: MessageHistory, private openAi: OpenAIApi) {
        this.mutex = new Mutex();
        this.isCollecting = false;
    }

    private async sendWithRetry(request: CreateChatCompletionRequest, attempts: number = 0): Promise<AxiosResponse<CreateChatCompletionResponse, any>> {
        const logger = Logger.getLogger();
        try {
            logger.verbose(`sent request: ${JSON.stringify(request, null, 2)}`);
            const response = await this.openAi.createChatCompletion(request);
            logger.verbose(`received response: ${JSON.stringify(response.data, null, 2)}`);
            return response
        } catch (err) {
            logger.error(err as Error);
            if (attempts < 3) { // 3 attempts
                await delay(100);
                return await this.sendWithRetry(request, attempts + 1);
            } else {
                throw err;
            }
        }
    }

    async processMessage(msg: string, channelId: string): Promise<void> {
        const logger = Logger.getLogger();
        this.requestBasket.push(msg);
        let release = await this.mutex.acquire();
        try {
            //process in order
            this.requestBasket.forEach(msg => {
                logger.log(`[channel-${channelId}] [User] "${msg}"`)
                this.responseBasket.push(msg);
            });
            this.requestBasket = [];
        } finally {
            release();
        }
        let result = undefined;
        if (!this.isCollecting) { // if we are not collecting responses when we process a message, then it is the first message. Start collecting for any more messages that appear in timer span
            await DiscordClient.sendTyping(channelId);
            this.isCollecting = true;
            logger.debug(`[channel-${channelId}] Collecting chat entries. Bucketed first chat entry. Started timer!`)
            await new Promise(resolve => {
                this.collectingTimer = setTimeout(resolve, COLLECT_TIMER)
            }); // blocks until timer ends
            logger.debug(`[channel-${channelId}] Timer has completed!`)
            release = await this.mutex.acquire();
            try {
                if (this.responseBasket.length > 0) {
                    // extract extraContext out given messages.
                    const guildId = DiscordClient.getGuildId(channelId);
                    await RedisEmbeddingService.CreateIndexForEmbedding(guildId); // no-op if index has already been created

                    // add current message to history
                    this.responseBasket.forEach(async (message) => {
                        this.history.addMessage({role: ChatCompletionRequestMessageRoleEnum.User, content: message});
                    });
                    this.responseBasket = []; // refresh responseBasket

                    await DiscordClient.sendTyping(channelId);
                    const chatResponse = await this.sendMessageToAPI(this.history, (await this.generateExtraContext(guildId, this.history)))

                    await DiscordClient.postMessage(chatResponse.replace("Rivanna:", ""), channelId);
                    logger.log(`[channel-${channelId}] [Bot] "${chatResponse}"`)
                }
            } finally {
                logger.debug(`[channel-${channelId}] Done collecting chat entries`)
                this.isCollecting = false; // refresh collecting state
                release();
            }
        } else {
            logger.debug(`[channel-${channelId}] Bucketed chat entry, refreshing timer!.`)
            await DiscordClient.sendTyping(channelId);
            this.collectingTimer.refresh()
        }
        // if we are currently collecting messages, then adding to responseBasket was enough. Rest of function is no-op
    }

    async generateExtraContext(guildId: string, history: MessageHistory): Promise<string> {
        const logger = Logger.getLogger();
        const contextMessages: string[] = [];
        const historyMessageStrings = history.getHistory().map(msg => msg.content);
        const historyContextClarity = 7 // number of messages in history to generate context off from
        if (historyMessageStrings.length > historyContextClarity) {
            contextMessages.push(...(historyMessageStrings.slice(historyMessageStrings.length - historyContextClarity)))
        } else {
            contextMessages.push(...historyMessageStrings)
        }

        logger.debug(`Generating context from the following messages: ${JSON.stringify(contextMessages)}`)

        let extraContextMap = new Map<string, VectorSimilarityResult>();
        (await Promise.all((contextMessages.reverse().map(async (message, index) => {
            let vectorSimilarityResult = await RedisEmbeddingService.PerformVectorSimilarity(guildId, (await Chatbot.getInstance().createEmbedding(message)));
            vectorSimilarityResult = vectorSimilarityResult.map((result) => {
                return {result: result.result, similarity: result.similarity * (1 - 0.05*index)};
            });
            return vectorSimilarityResult;
        })))).flat().forEach(result => {
            // add new ones to map, add existing ones only if similarity is greater
            if (!extraContextMap.has(result.result)) {
                extraContextMap.set(result.result, result)
            } else {
                const current = extraContextMap.get(result.result)
                if (current.similarity < result.similarity) {
                    extraContextMap.set(result.result, result)
                }
            }
        });

        let extraContentString = [...extraContextMap.values()].sort((a,b) => b.similarity- a.similarity).slice(0,10).reduce((a: string, v: VectorSimilarityResult) => {
            a = a.concat(`${v.result}. `);
            return a;
        }, '');

        // make copy of history, we will send a message to the API, see the response, and generate content based on that too.
        const historyCopy = history.makeCopy()

        let chatResponse = await this.sendMessageToAPI(historyCopy, extraContentString);
        logger.debug(`Generating additional context from what we think Rivanna will say: ${chatResponse}`);
        (await RedisEmbeddingService.PerformVectorSimilarity(guildId, (await Chatbot.getInstance().createEmbedding(chatResponse)))).forEach(result => {
            result = {result: result.result, similarity: result.similarity*0.80}
            // add new ones to map, add existing ones only if similarity is greater
            if (!extraContextMap.has(result.result)) {
                extraContextMap.set(result.result, result)
            } else {
                const current = extraContextMap.get(result.result)
                if (current.similarity < result.similarity) {
                    extraContextMap.set(result.result, result)
                }
            }
        });

        const extraContext = [...extraContextMap.values()].sort((a,b) => b.similarity- a.similarity).slice(0,10);
        logger.debug(`Generating context based on the 10 following memories: ${JSON.stringify(extraContext)}`)
        extraContentString = extraContext.reduce((a: string, v: VectorSimilarityResult) => {
            a = a.concat(`${v.result}. `);
            return a;
        }, '');
        logger.debug(`Generated context string: ${extraContentString}`)

        return extraContentString;
    }

    async sendMessageToAPI(history: MessageHistory, extraContext: string) {
        const extraContextRequest: ChatCompletionRequestMessage = { 
            role: ChatCompletionRequestMessageRoleEnum.User, 
            content: `"Here is some additional context that may help you with your acting: ${extraContext} You will not reference this message directly but use it for context when applicable in future conversation."`
        }
        
        this.purgeHistoryIfNeeded(history, extraContextRequest);

        // Reorganize conversation order based on clarity length
        let fullContext: ChatCompletionRequestMessage[] = [];
        const messageClarityLength = 3; //determines how context gets sandwiched in, the 'x' most recent messages will be at front of conversation
        if (history.getHistory().length > messageClarityLength) {
            // sandwich original context and extra inside if history is longer
            fullContext = [
                history.getOriginalContext(), //original context
                ...history.getHistory().slice(0, history.getHistory().length - messageClarityLength), // the oldest part of the conversation
                extraContextRequest, // extra context if needed
                ...history.getHistory().slice(history.getHistory().length - messageClarityLength), // the most recent part of the conversation
            ];
        } else {
            fullContext = [
                history.getOriginalContext(), //original context
                extraContextRequest, // extra context if needed
                ...history.getHistory() // history
            ];
        }

        // Send message and get response back
        const request: CreateChatCompletionRequest = {
            model: "gpt-3.5-turbo-0613",
            messages: fullContext,
            temperature: 1.17,
            max_tokens: RESPONSE_TOKEN_LENGTH,
            presence_penalty: 0.08,
            frequency_penalty: -0.08
        }
        const chatResponse = (await this.sendWithRetry(request)).data.choices[0].message.content;
        history.addMessage({role: ChatCompletionRequestMessageRoleEnum.Assistant, content: chatResponse});
        return chatResponse;
    }

    async purgeHistoryIfNeeded(history: MessageHistory, extraContext: ChatCompletionRequestMessage) {
        const logger = Logger.getLogger();
        let fullContextTokenLength = generateChatCompletionContext(history.getOriginalContext(), [...history.getHistory()], extraContext);
        if ((fullContextTokenLength + 100 + RESPONSE_TOKEN_LENGTH > 4000)) { // if chat tokens is greater than 4000, we need to purge some of our chat history.
            logger.debug(`Chat history token length is ${fullContextTokenLength}. Purging oldest 10 chat entries.`);
            logger.debug(`old history: ${JSON.stringify(history)}`);
            history.purgeOldestEntries(10);
            logger.debug(`new history: ${JSON.stringify(history)}`);
            fullContextTokenLength = generateChatCompletionContext(history.getOriginalContext(), [...history.getHistory()], extraContext);
            logger.debug(`Chat history token length is now ${fullContextTokenLength}.`);
        }
    }
}

export interface Chatbot {
    sendMessage(guildId: string, thread: string, msg: string): Promise<void>,
    username: string,
    setChatActiveState(guildId: string, channelId: string, state: boolean): void,
    getChatActiveState(guildId: string, channelId: string): boolean,
    isActive(): boolean,
    setChatTimer(guildId: string, channelId: string, timer: NodeJS.Timeout): void,
    refreshChatTimer(guildId: string, channelId: string): void,
    clearChatTimer(guildId: string, channelId: string): void,
    getHistory(guildId: string, channelId: string): MessageHistory,
    resetHistory(guildId: string, channelId: string): void,
    createEmbedding(text: string): Promise<number[]>
}

export class Chatbot implements Chatbot {
    private static instance: Chatbot;
    private messageHistories: Map<string, MessageHistory>;
    private activeChats: string[];
    private activeChatTimers: Map<string, NodeJS.Timeout>;
    private openai: OpenAIApi;
    private context: ChatCompletionRequestMessage;
    private processers: Map<string, MessageProcessor>
    private embeddingsCache: Map<string, number[]>
    public userName: string;

    private constructor() {
        this.messageHistories = new Map<string, MessageHistory>();
        this.activeChats = [];
        this.activeChatTimers = new Map<string, NodeJS.Timeout>();
        this.processers = new Map<string, MessageProcessor>();
        this.embeddingsCache = new Map<string, number[]>();
    }

    private static EnsureExistance(){
        if (!Chatbot.instance) {
            Chatbot.instance = new Chatbot();
        }
    }

    public static getInstance() {
        Chatbot.EnsureExistance();
        return Chatbot.instance;
    }

    public static setKey(key: string) {
        Chatbot.EnsureExistance();
        Chatbot.instance.openai = new OpenAIApi(new Configuration({
            apiKey: key
        })); 
    }

    public static setContext(contextString: string) {
        Chatbot.EnsureExistance();
        Chatbot.instance.context = { role: ChatCompletionRequestMessageRoleEnum.System, content: contextString }
    }

    public static setUserName(userName: string) {
        Chatbot.EnsureExistance();
        Chatbot.instance.userName = userName;
    }

    getHistory(guildId: string, channelId: string): MessageHistory {
        if (this.messageHistories.has(`${guildId}-${channelId}`)) {
            return this.messageHistories.get(`${guildId}-${channelId}`)
        } else {
            throw new Error("There is no history for this chat!")
        }
    }

    resetHistory(guildId: string, channelId: string): void {
        if (this.messageHistories.has(`${guildId}-${channelId}`)) {
            this.messageHistories.delete(`${guildId}-${channelId}`);
        } else {
            throw new Error("There is no history for this chat!")
        }
    }

    setChatActiveState(guildId: string, channelId: string, state: boolean) {
        const logger = Logger.getLogger();
        logger.debug(`Set ${guildId}-${channelId} to ${state}`);
        if (state && !this.activeChats.includes(`${guildId}-${channelId}`)) {
            this.activeChats.push(`${guildId}-${channelId}`);
        } else if (!state && this.activeChats.includes(`${guildId}-${channelId}`)) {
            this.activeChats= this.activeChats.filter(x => x !== `${guildId}-${channelId}`);
            logger.debug(`new activeChats is: ${this.activeChats}`);
        }
    }

    getChatActiveState(guildId: string, channelId: string): boolean { // not great with scale
        return this.activeChats.includes(`${guildId}-${channelId}`);
    }

    isActive(): boolean {
        return this.activeChats.length > 0;
    }

    setChatTimer(guildId: string, channelId: string, timer: NodeJS.Timeout): void {
        if (this.activeChatTimers.has(`${guildId}-${channelId}`)) {
            throw new Error("A timer is already set!")
        }
        this.activeChatTimers.set(`${guildId}-${channelId}`, timer );
    }

    refreshChatTimer(guildId: string, channelId: string): void {
        if (!this.activeChatTimers.has(`${guildId}-${channelId}`)) {
            throw new Error("There is no timer to refresh!")
        }
        this.activeChatTimers.get(`${guildId}-${channelId}`).refresh();
    }

    clearChatTimer(guildId: string, channelId: string): void {
        if (!this.activeChatTimers.has(`${guildId}-${channelId}`)) {
            throw new Error("There is no timer to clear!")
        }
        clearTimeout(this.activeChatTimers.get(`${guildId}-${channelId}`));
        this.activeChatTimers.delete(`${guildId}-${channelId}`);
    }

    async sendMessage(guildId: string, channelId: string, msg: string): Promise<void> {
        const logger = Logger.getLogger();
        try {
            if (!this.context || !this.openai) {
                throw new Error("Missing Context or OpenAI key!");
            }
            if (!this.activeChats.includes(`${guildId}-${channelId}`)) {
                throw new Error("Cannot send message. Chat in this id is not active.");
            }
            if (!this.messageHistories.has(`${guildId}-${channelId}`)){ // populate new MessageHistory for channel if it does not exist
                this.messageHistories.set(`${guildId}-${channelId}`, new MessageHistory(this.context))
            }
            if (!this.processers.has(`${guildId}-${channelId}`)){ // populate new MessageProcessor for channel if it does not exist
                this.processers.set(`${guildId}-${channelId}`, new MessageProcessor(this.messageHistories.get(`${guildId}-${channelId}`), this.openai));
            }
            await this.processers.get(`${guildId}-${channelId}`).processMessage(msg, channelId);
            await this.refreshChatTimer(guildId, channelId);
        }
        catch(err) {
            logger.error(err);
            DiscordClient.postMessage("Sorry! I'm having trouble thinking of a response right now. Please try later.", channelId);
        }
    }

    async createEmbedding(text: string, attempts: number = 0): Promise<number[]> {
        const logger = Logger.getLogger();
        try {
            if (this.embeddingsCache.has(text)) {
                logger.debug("Embedding was cached!")
                return this.embeddingsCache.get(text);
            }
            // cache embedding result so we don't have to do unneccesary API calls
            const embedding = (await this.openai.createEmbedding({
                model: "text-embedding-ada-002",
                input: text
            })).data.data[0].embedding;

            this.embeddingsCache.set(text, embedding)
            return embedding
        } catch(err) {
            logger.error(err);
            if (attempts < 3) {
                await delay(100);
                return await this.createEmbedding(text, attempts + 1);
            } else {
                throw err;
            }
        }
    }
}