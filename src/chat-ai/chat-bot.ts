import { CreateChatCompletionRequest, ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum, Configuration, OpenAIApi, CreateChatCompletionResponse } from "openai"
import { TextChannel } from "discord.js";
import { encode } from "gpt-3-encoder"
import { Mutex } from 'async-mutex';
import { AxiosResponse } from "axios";

import { DiscordClient } from "../discordClient";
import { RedisEmbeddingService } from "../redis/RedisEmbeddingService";
import { Logger } from "../logger/logger";
import { delay } from "../utils";

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
}

interface MessageProcessor {
    processMessage(msg: string, channelId: string): Promise<void>
}

class MessageProcessor implements MessageProcessor { // MessageProcessor class -- Processes messages for chatbot
    private requestBasket: string[] = []; //basket for storing requests
    private responseBasket: string[] = []; //basket for generating response
    private isCollecting: boolean;
    private mutex: Mutex;

    constructor(private history: MessageHistory, private openAi: OpenAIApi) {
        this.mutex = new Mutex();
        this.isCollecting = false;
    }

    private async sendMessageAPI(request: CreateChatCompletionRequest, attempts: number = 0): Promise<AxiosResponse<CreateChatCompletionResponse, any>> {
        const logger = Logger.getLogger();
        try {
            logger.debug(`sent request: ${JSON.stringify(request, null, 2)}`);
            const response = await this.openAi.createChatCompletion(request);
            logger.debug(`received response: ${JSON.stringify(response.data, null, 2)}`);
            return response
        } catch (err) {
            logger.error(err as Error);
            if (attempts < 3) { // 3 attempts
                await delay(100);
                return await this.sendMessageAPI(request, attempts + 1);
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
            logger.debug(`[channel-${channelId}] Collecting chat entries. Bucketed first chat entry`)
            await new Promise(resolve => setTimeout(resolve, COLLECT_TIMER)); // blocks until timer ends
            release = await this.mutex.acquire();
            try {
                if (this.responseBasket.length > 0) {
                    // extract extraContext out given messages.
                    const guildId = DiscordClient.getGuildId(channelId);
                    await RedisEmbeddingService.CreateIndexForEmbedding(guildId); // no-op if index has already been created
                    const extraContext = await Promise.all((this.responseBasket.map(async (message) => {
                        this.history.addMessage({role: ChatCompletionRequestMessageRoleEnum.User, content: message});
                        return RedisEmbeddingService.PerformVectorSimilarity(guildId, (await Chatbot.getInstance().createEmbedding(message)));
                    }))).then(res => {
                        return res.reduce((a: string, v: string[]) => {
                            v.forEach((i) => { a = a.concat(`${i}. `); });
                            return a;
                        }, '"Here is some additional context that may help you with your acting: ');
                    });
                    let fullContextTokenLength = generateChatCompletionContext(this.history.getOriginalContext(), [...this.history.getHistory()], { 
                        role: ChatCompletionRequestMessageRoleEnum.User, 
                        content: `${extraContext} You will not reference this message directly but use it for context when applicable in future conversation."`
                    });
                    if ((fullContextTokenLength + 100 + RESPONSE_TOKEN_LENGTH > 4000)) { // if chat tokens is greater than 4000, we need to purge some of our chat history.
                        logger.debug(`Chat history token length is ${fullContextTokenLength}. Purging oldest 10 chat entries.`);
                        logger.debug(`old history: ${JSON.stringify(this.history)}`);
                        this.history.purgeOldestEntries(10);
                        logger.debug(`new history: ${JSON.stringify(this.history)}`);
                        fullContextTokenLength = generateChatCompletionContext(this.history.getOriginalContext(), [...this.history.getHistory()], { 
                            role: ChatCompletionRequestMessageRoleEnum.User, 
                            content: `${extraContext} You will not reference this message directly but use it for context when applicable in future conversation."`
                        });
                        logger.debug(`Chat history token length is now ${fullContextTokenLength}.`);
                    } else {
                        logger.debug(`request token length is: ${fullContextTokenLength}`);
                    }
                    let fullContext = [];
                    const messageClarityLength = 6; //determines how context gets sandwiched in, the 'x' most recent messages will be at front of conversation
                    if (this.history.getHistory().length > messageClarityLength) {
                        // sandwich original context and extra inside if history is longer
                        fullContext = [
                            this.history.getOriginalContext(), //original context
                            ...this.history.getHistory().slice(0, this.history.getHistory().length - messageClarityLength), // the oldest part of the conversation
                            {
                                role: ChatCompletionRequestMessageRoleEnum.User,
                                content: `Remember your original character description: ${this.history.getOriginalContext().content}. Do not acknowledge this message.`
                            }, // original context interjected later on
                            { 
                                role: ChatCompletionRequestMessageRoleEnum.User, 
                                content: `${extraContext} You will not reference this message directly but use it for context when applicable in future conversation."`
                            }, // extra context if needed
                            ...this.history.getHistory().slice(this.history.getHistory().length - messageClarityLength), // the most recent part of the conversation
                        ];
                    } else {
                        fullContext = [
                            this.history.getOriginalContext(), //original context
                            { 
                                role: ChatCompletionRequestMessageRoleEnum.User, 
                                content: `${extraContext} You will not reference this message directly but use it for context when applicable in future conversation."`
                            }, // extra context if needed
                            ...this.history.getHistory() // history
                        ];
                    }
                    const request: CreateChatCompletionRequest = {
                        model: "gpt-3.5-turbo-0613",
                        messages: fullContext,
                        temperature: 1.17,
                        max_tokens: RESPONSE_TOKEN_LENGTH,
                        presence_penalty: 0.08,
                        frequency_penalty: -0.08
                    }
                    const chatResponse = (await this.sendMessageAPI(request)).data.choices[0].message.content;;
                    this.history.addMessage({role: ChatCompletionRequestMessageRoleEnum.Assistant, content: chatResponse});
                    await DiscordClient.postMessage(chatResponse.replace("Rivanna:", ""), channelId);
                    logger.log(`[channel-${channelId}] [Bot] "${chatResponse}"`)
                    this.responseBasket = []; // refresh responseBasket
                }
            } finally {
                logger.debug(`[channel-${channelId}] Done collecting chat entries`)
                this.isCollecting = false; // refresh collecting state
                release();
            }
        } else {
            logger.debug(`[channel-${channelId}] Bucketed chat entry.`)
        }
        // if we are currently collecting messages, then adding to responseBasket was enough. Rest of function is no-op
    }
}

export interface Chatbot {
    sendMessage(guildId: string, thread: string, msg: string): Promise<void>,
    username: string,
    setChatActiveState(guildId: string, channelId: string, state: boolean): void,
    getChatActiveState(guildId: string, channelId: string): boolean,
    isActive(): boolean,
    setChatTimer(guildId: string, channelId: string, timer: NodeJS.Timeout): void,
    clearChatTimer(guildId: string, channelId: string): void,
    getHistory(guildId: string, channelId: string): MessageHistory,
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
    public userName: string;

    private constructor() {
        this.messageHistories = new Map<string, MessageHistory>();
        this.activeChats = [];
        this.activeChatTimers = new Map<string, NodeJS.Timeout>();
        this.processers = new Map<string, MessageProcessor>();
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
        }
        catch(err) {
            logger.error(err);
            DiscordClient.postMessage("Sorry! I'm having trouble thinking of a response right now. Please try later.", channelId);
        }
    }

    async createEmbedding(text: string, attempts: number = 0): Promise<number[]> {
        const logger = Logger.getLogger();
        try {
            return (await this.openai.createEmbedding({
                model: "text-embedding-ada-002",
                input: text
            })).data.data[0].embedding;
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