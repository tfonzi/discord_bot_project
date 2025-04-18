import { encode } from "gpt-3-encoder"
import { Mutex } from 'async-mutex';
import OpenAI from 'openai';
import type { 
    ChatCompletion, 
    ChatCompletionCreateParams, 
    ChatCompletionMessageParam, 
    ChatCompletionContentPart
} from 'openai/resources/chat/completions';
import { OpenAI as OpenAIClient } from "openai";
import { AttachmentBuilder, TextChannel } from 'discord.js';
import { Buffer } from 'node:buffer';

import { DiscordClient } from "../utils/discordClient";
import { RedisEmbeddingService, VectorSimilarityResult } from "../redis/RedisEmbeddingService";
import { Logger } from "../logger/logger";
import { delay } from "../utils/utils";

const COLLECT_TIMER = 5000; //collect after 5 second
const RESPONSE_TOKEN_LENGTH = 250;
const CONTEXT_MAX_LENGTH = 16000;
const HISTORY_CONTEXT_RECALL_LENGTH = 10; // number of past history messages to include in context

type ChatBotResponse = {
    shouldRespond: boolean,
    response: string,
    shouldGenerateImage: boolean
}

function generateChatCompletionContext(originalContext: ChatCompletionMessageParam, chatHistory: ChatCompletionMessageParam[], extraContext: ChatCompletionMessageParam): number {
    let originalContextString = "";
    if (Array.isArray(originalContext.content)) {
        originalContext.content.forEach(part => {
            if (part.type === "text") {
                originalContextString = originalContextString.concat(part.text)
            }
        });
    } else {
        originalContextString = originalContext.content as string;
    }

    let extraContentString = "";
    if (Array.isArray(extraContext.content)) {
        extraContext.content.forEach(part => {
            if (part.type === "text") {
                extraContentString = extraContentString.concat(part.text)
            }
        });
    } else {
        extraContentString = extraContext.content as string;
    }
    const originalContextTokenLength = encode(originalContextString).length;
    const chatHistoryTokenLength = encode(chatHistory.reduce((totalString: string, chat) => { return totalString.concat(` ${chat.content}`); }, "")).length;
    const extraContextTokenLength = encode(extraContentString).length;
    return (2*originalContextTokenLength) + chatHistoryTokenLength + extraContextTokenLength;
}

interface MessageHistory {
    addMessage(message: ChatCompletionMessageParam),
    getOriginalContext(): ChatCompletionMessageParam,
    getHistory(): ChatCompletionMessageParam[],
    purgeOldestEntries(x: number)
}

// Define a type for storing message content (text + optional image URLs)
type MessageContent = {
    text: string;
    imageUrls?: string[];
}

class MessageHistory implements MessageHistory { // MessageHistory class -- modified queue for storing message history for Chatbot
    private storage: ChatCompletionMessageParam[] = [];

    constructor(private context: ChatCompletionMessageParam, private capacity: number = 100) {}

    addMessage(msg: ChatCompletionMessageParam): void { 
        let textContentToAdd: string | null = null;
        let roleToAdd = msg.role;

        if (typeof msg.content === 'string') {
            textContentToAdd = msg.content;
        } else if (Array.isArray(msg.content)) {
            // Iterate through parts to find the text content
            for (const part of msg.content) {
                if (part.type === 'text') {
                    textContentToAdd = part.text;
                    break; // Assume only one text part
                }
            }
        } else {
             // Handle null or other unexpected content types if necessary
             textContentToAdd = null;
        }
        
        // Only add if we found text content and role is storable
        if (textContentToAdd !== null && (roleToAdd === 'user' || roleToAdd === 'assistant' || roleToAdd === 'system')) {
             // Store only role and text content
             const messageToStore: ChatCompletionMessageParam = {
                role: roleToAdd,
                content: textContentToAdd
            };
            if(this.storage.length == this.capacity) {
                this.storage.splice(0,1);
            }
            this.storage.push(messageToStore);
        }
    }

    getOriginalContext(): ChatCompletionMessageParam {
        return this.context;
    }

    getHistory(): ChatCompletionMessageParam[] {
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
    processMessage(msg: string, channelId: string, imageUrls?: string[]): Promise<void>
}

class MessageProcessor implements MessageProcessor { // MessageProcessor class -- Processes messages for chatbot
    private requestBasket: MessageContent[] = []; 
    private responseBasket: MessageContent[] = []; 
    private isCollecting: boolean;
    private collectingTimer: NodeJS.Timeout
    private mutex: Mutex;

    constructor(private history: MessageHistory, private openai: OpenAI) {
        this.mutex = new Mutex();
        this.isCollecting = false;
    }

    private async sendWithRetry(request: ChatCompletionCreateParams, attempts: number = 0): Promise<ChatBotResponse> {
        const logger = Logger.getLogger();
        try {
            // Ensure messages array exists and add the user message
            if (!request.messages) {
                request.messages = [];
            }
            request.messages.push({ role: "user", content: "Create a response object based on the past conversation." });
            logger.verbose(`sent request: ${JSON.stringify(request, null, 2)}`);
            const response = await this.openai.chat.completions.create(request) as ChatCompletion;
            logger.verbose(`received response: ${JSON.stringify(response, null, 2)}`);
            let chatResponse: ChatBotResponse;
            if (response.choices[0].message.tool_calls) {
                chatResponse = JSON.parse(response.choices[0].message.tool_calls[0].function.arguments);
            } else if (response.choices[0].message.content) {
                chatResponse = JSON.parse(response.choices[0].message.content);
            } else {
                throw new Error(`tool_calls and content properties are both missing`);
            }
            if (chatResponse.shouldRespond && !chatResponse.response) {
                throw new Error('Rivanna returned "shouldRespond" as true, but with no response');
            }
            return chatResponse;
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

    private async sendInCharacterError(channelId: string, errorDescription: string): Promise<void> {
        const logger = Logger.getLogger();
        try {
            const openai = new OpenAIClient({ apiKey: process.env.OPENAI_TOKEN });
            const errorResponseGen = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: "Explain in character that you encountered a difficulty related to image generation. Keep it brief and apologize." },
                    { role: "user", content: `Problem: ${errorDescription}` }
                ],
                max_tokens: 100,
                temperature: 0.7
            });

            const inCharacterMessage = errorResponseGen.choices[0]?.message?.content?.trim();

            if (inCharacterMessage) {
                await DiscordClient.postMessage(inCharacterMessage, channelId);
                logger.log(`[channel-${channelId}] [Bot] Sent in-character error message: ${inCharacterMessage}`);
            } else {
                // Fallback to generic message if AI generation fails
                logger.error(new Error(`[channel-${channelId}] [Bot] Failed to generate in-character error message. Sending generic one.`));
                await DiscordClient.postMessage("Whoopsies!", channelId);
            }
        } catch (genError) {
            logger.error(new Error(`[channel-${channelId}] [Bot] Error generating in-character error message: ${genError instanceof Error ? genError.message : String(genError)}`));
            // Fallback to generic message on error
            await DiscordClient.postMessage("Sorry, I encountered an error with the image.", channelId);
        }
    }

    async processMessage(msg: string, channelId: string, imageUrls?: string[]): Promise<void> {
        const logger = Logger.getLogger();
        // Add MessageContent object to basket
        this.requestBasket.push({ text: msg, imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined }); 
        let release = await this.mutex.acquire();
        try {
            // Process requests, adding them to the response basket
            this.requestBasket.forEach(content => {
                logger.log(`[channel-${channelId}] [User] "${content.text}" ${content.imageUrls?.length ? `with ${content.imageUrls.length} image(s)` : ''}`);
                this.responseBasket.push(content); 
            });
            this.requestBasket = [];
        } finally {
            release();
        }
        
        if (!this.isCollecting) { 
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

                    // Combine *all* text and *all* image URLs from the bucket
                    let combinedText = "";
                    const allImageUrls: string[] = [];
                    
                    this.responseBasket.forEach(content => {
                        combinedText += content.text + "\n"; // Combine text messages
                        if (content.imageUrls) {
                            allImageUrls.push(...content.imageUrls); // Collect all image URLs
                        }
                        // Add only the text part of this specific user message to history
                        this.history.addMessage({content: content.text, role: "user"}); 
                    });
                    combinedText = combinedText.trim(); // Remove trailing newline
                    this.responseBasket = []; // Clear basket

                    // Generate context based on text history (ignores images)
                    const extraContext = await this.generateExtraContext(guildId, this.history);
                    DiscordClient.sendTyping(channelId);
                    
                    // Pass combined text and all collected image URLs to the API call
                    const chatResponse = await this.sendMessageToAPI("gpt-4o", this.history, extraContext, combinedText, allImageUrls);
                    
                    // --- Image Generation Block (remains the same) ---
                    if (chatResponse.shouldGenerateImage) {
                        // Step 1: Use GPT-4o to generate a concise image prompt
                        const openai = new OpenAIClient({ apiKey: process.env.OPENAI_TOKEN });
                        const promptGen = await openai.chat.completions.create({
                            model: "gpt-4o",
                            messages: [
                                { role: "system", content: "You are an expert at writing concise, vivid prompts for AI image generation. Given a user request and context, write a single-sentence prompt for an image generation model. Do not include any commentary, just the prompt. The context consists of previous messages + background information. Please do not hallucinate any of this into the image. The image provided should just be what was immediately requested, located at the end of the context." },
                                { role: "user", content: `Artist response right before the image is delievered: ${chatResponse.response}\nContext: ${extraContext}` }
                            ],
                            max_tokens: 400,
                            temperature: 0.7
                        });
                        const imagePrompt = promptGen.choices[0].message.content.trim();
                        logger.log(`[channel-${channelId}] [Bot] Generating image for prompt: ${imagePrompt}`);

                        // Step 2: Generate image using OpenAI image API requesting base64 data
                        const imageResponse = await openai.images.generate({
                            prompt: imagePrompt,
                            model: "dall-e-3",
                            style: "natural",
                            n: 1,
                            size: "1024x1024",
                            response_format: "b64_json" // Request base64 format
                        });

                        // Step 3: Decode base64 and send as attachment
                        const base64Data = imageResponse.data[0].b64_json;
                        if (base64Data) {
                            const imageBuffer = Buffer.from(base64Data, 'base64');
                            const attachment = new AttachmentBuilder(imageBuffer, { name: 'ai-generated-image.png' });
                            try {
                                // Get channel and send directly
                                const channel = await DiscordClient.getClient().channels.fetch(channelId);
                                // Type guard to ensure channel is TextChannel
                                if (channel instanceof TextChannel) {
                                    await channel.send({ files: [attachment] });
                                    logger.log(`[channel-${channelId}] [Bot] Posted generated image.`);
                                } else {
                                    // Log error if channel is not a TextChannel or null/undefined
                                    logger.error(new Error(`[channel-${channelId}] [Bot] Could not find a valid TextChannel to post image.`));
                                    await DiscordClient.postMessage("Sorry, I couldn't find the right channel to send the image.", channelId);
                                }
                            } catch (err) {
                                // Log error if sending fails
                                logger.error(new Error(`[channel-${channelId}] [Bot] Failed to send image attachment: ${err instanceof Error ? err.message : String(err)}`));
                                // Send in-character error message instead of generic one
                                await this.sendInCharacterError(channelId, "Failed to send the image file.");
                            }
                        } else {
                            // Log error if base64 data is missing
                            logger.error(new Error(`[channel-${channelId}] [Bot] Failed to retrieve base64 data for the image.`));
                            // Send in-character error message instead of generic one
                            await this.sendInCharacterError(channelId, "Could not generate the image data.");
                        }
                    } 
                    if(chatResponse.shouldRespond) {
                        const responseText = chatResponse.response.replace("Rivanna:", "");
                        await DiscordClient.postMessage(responseText, channelId);
                        // Add assistant's text response to history
                        this.history.addMessage({role: 'assistant', content: responseText}); 
                        logger.log(`[channel-${channelId}] [Bot] "${responseText}"`); 
                    }
                }
            } finally {
                logger.debug(`[channel-${channelId}] Done collecting chat entries`)
                this.isCollecting = false; // refresh collecting state
                release();
            }
        } else {
            logger.debug(`[channel-${channelId}] Bucketed chat entry, refreshing timer!.`)
            this.collectingTimer.refresh()
        }
        // if we are currently collecting messages, then adding to responseBasket was enough. Rest of function is no-op
    }

    async generateExtraContext(guildId: string, history: MessageHistory): Promise<string> {
        const logger = Logger.getLogger();
        const contextMessages: string[] = [];
        // History only contains text messages due to logic in addMessage
        const historyMessageStrings = history.getHistory().map(msg => msg.content as string); 
        
        if (historyMessageStrings.length > HISTORY_CONTEXT_RECALL_LENGTH) {
            contextMessages.push(...(historyMessageStrings.slice(historyMessageStrings.length - HISTORY_CONTEXT_RECALL_LENGTH)))
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

        let extraContentString = [...extraContextMap.values()].sort((a,b) => b.similarity - a.similarity).slice(0,10).reduce((a: string, v: VectorSimilarityResult) => {
            a = a.concat(`${v.result}. `);
            return a;
        }, '');

        // make copy of history, we will send a message to the API, see the response, and generate content based on that too.
        const historyCopy = history.makeCopy()
        let chatResponse = await this.sendMessageToAPI("gpt-4o", historyCopy, extraContentString, "", []);
        if (chatResponse.response) {
            logger.debug(`Generating additional context from what we think Rivanna will say: ${chatResponse.response}`);
            (await RedisEmbeddingService.PerformVectorSimilarity(guildId, (await Chatbot.getInstance().createEmbedding(chatResponse.response)))).forEach(result => {
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
        }

        const extraContext = [...extraContextMap.values()].sort((a,b) => b.similarity - a.similarity).slice(0,10);
        logger.debug(`Generating context based on the 10 following memories: ${JSON.stringify(extraContext)}`)
        extraContentString = extraContext.reduce((a: string, v: VectorSimilarityResult) => {
            a = a.concat(`${v.result}. `);
            return a;
        }, '');
        logger.debug(`Generated context string: ${extraContentString}`)

        return extraContentString;
    }

    async sendMessageToAPI(model: string, history: MessageHistory, extraContext: string, combinedText: string, collectedImageUrls?: string[]): Promise<ChatBotResponse> {
        const logger = Logger.getLogger();
        const extraContextRequest: ChatCompletionMessageParam = { 
            role: 'user',
            content: `"Here is some additional context that may help you with your acting: ${extraContext} You will not reference this message directly but use it for context when applicable in future conversation. Respond in JSON format. Your response must be a valid JSON object."`
        };
        
        this.purgeHistoryIfNeeded(history, extraContextRequest);

        // Construct the user message content (potentially multimodal)
        let userMessageContentParts: ChatCompletionContentPart[] = [
            { type: "text", text: combinedText } // Start with the combined text
        ];

        // Add all collected image URLs
        if (collectedImageUrls && collectedImageUrls.length > 0) {
            collectedImageUrls.forEach(url => {
                userMessageContentParts.push({ type: "image_url", image_url: { url: url } });
            });
        }
        
        // The user message to be added to the full context
        const userMessage: ChatCompletionMessageParam = {
            role: "user",
            // Use the array format if images are present, otherwise potentially just string?
            // Let's always use the array format for consistency when calling the vision model.
            content: userMessageContentParts 
        };

        // Reorganize conversation order
        let fullContext: ChatCompletionMessageParam[] = [];
        const messageClarityLength = 3; 
        const historyMessages = history.getHistory(); // Text-only history

        if (historyMessages.length > messageClarityLength) {
            fullContext = [
                history.getOriginalContext(), 
                ...historyMessages.slice(0, historyMessages.length - messageClarityLength), 
                extraContextRequest, 
                ...historyMessages.slice(historyMessages.length - messageClarityLength),
                userMessage // Add the current potentially multimodal user message at the end
            ];
        } else {
            fullContext = [
                history.getOriginalContext(), 
                extraContextRequest, 
                ...historyMessages,
                userMessage // Add the current potentially multimodal user message at the end
            ];
        }

        const request: ChatCompletionCreateParams = {
            model: model, // Ensure this is a vision-capable model like gpt-4o
            messages: fullContext,
            temperature: 1.17,
            max_tokens: RESPONSE_TOKEN_LENGTH, 
            presence_penalty: 0.08,
            frequency_penalty: -0.08,
            response_format: { type: "json_object"},
            tool_choice: {type: "function", function: {name: "CreateResponseObject"}},
            tools: [ 
                {
                    type: "function",
                    function: {
                        "name": "CreateResponseObject",
                        "description": "Creates a response object based on past conversation. If the user is asking for an image, set shouldGenerateImage to true and make the response the image prompt.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "shouldRespond": {
                                    "type": "boolean",
                                    "description": "Based on the conversation, whether Rivanna should respond at all."
                                },
                                "response": {
                                    "type": "string",
                                    "description": "If Rivanna chose to respond, this is her response or the image prompt."
                                },
                                "shouldGenerateImage": {
                                    "type": "boolean",
                                    "description": "Whether the user is asking for an image to be generated."
                                }
                            },
                            "required": ["shouldRespond", "shouldGenerateImage"]
                        }
                    }
                }
            ]
        };
        
        const response = await this.sendWithRetry(request);       
        logger.debug(`Got a chat response of: ${JSON.stringify(response)}`)
        
        return response;
    }

    async purgeHistoryIfNeeded(history: MessageHistory, extraContext: ChatCompletionMessageParam) {
        // Note: This calculation remains text-based.
        const logger = Logger.getLogger();
        let fullContextTokenLength = generateChatCompletionContext(history.getOriginalContext(), [...history.getHistory()], extraContext);
        if ((fullContextTokenLength + 100 + RESPONSE_TOKEN_LENGTH > CONTEXT_MAX_LENGTH)) { // if chat tokens is greater than CONTEXT_MAX_LENGTH, we need to purge some of our chat history.
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
    // Update signature
    sendMessage(guildId: string, channelId: string, msg: string, imageUrls?: string[]): Promise<void>; 
    username: string;
    setChatActiveState(guildId: string, channelId: string, state: boolean): void;
    getChatActiveState(guildId: string, channelId: string): boolean;
    isActive(): boolean;
    setChatTimer(guildId: string, channelId: string, timer: NodeJS.Timeout): void;
    refreshChatTimer(guildId: string, channelId: string): void;
    clearChatTimer(guildId: string, channelId: string): void;
    getHistory(guildId: string, channelId: string): MessageHistory;
    resetHistory(guildId: string, channelId: string): void;
    createEmbedding(text: string): Promise<number[]>
}

export class Chatbot implements Chatbot {
    private static instance: Chatbot;
    private messageHistories: Map<string, MessageHistory>;
    private activeChats: string[];
    private activeChatTimers: Map<string, NodeJS.Timeout>;
    private openai: OpenAI;
    private context: ChatCompletionMessageParam;
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
        Chatbot.instance.openai = new OpenAI({
            apiKey: key
        });
    }

    public static setContext(contextString: string) {
        Chatbot.EnsureExistance();
        Chatbot.instance.context = { role: 'system', content: contextString }
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

    // Update signature
    async sendMessage(guildId: string, channelId: string, msg: string, imageUrls?: string[]): Promise<void> { 
        const logger = Logger.getLogger();
        try {
            if (!this.context || !this.openai) {
                throw new Error("Missing Context or OpenAI key!");
            }
            if (!this.activeChats.includes(`${guildId}-${channelId}`)) {
                throw new Error("Cannot send message. Chat in this id is not active.");
            }
            if (!this.messageHistories.has(`${guildId}-${channelId}`)){ 
                this.messageHistories.set(`${guildId}-${channelId}`, new MessageHistory(this.context))
            }
            if (!this.processers.has(`${guildId}-${channelId}`)){ 
                this.processers.set(`${guildId}-${channelId}`, new MessageProcessor(this.messageHistories.get(`${guildId}-${channelId}`), this.openai));
            }
            // Pass imageUrls to processMessage
            await this.processers.get(`${guildId}-${channelId}`).processMessage(msg, channelId, imageUrls); 
            // Refresh the timer on message send
             await this.refreshChatTimer(guildId, channelId); 
        }
        catch(err) {
            logger.error(err);
            // Keep simple fallback error message here
            DiscordClient.postMessage("Sorry, something went wrong.", channelId); 
        }
    }

    async createEmbedding(text: string, attempts: number = 0): Promise<number[]> {
        const logger = Logger.getLogger();
        try {
            if (this.embeddingsCache.has(text)) {
                logger.debug("Embedding was cached!")
                return this.embeddingsCache.get(text);
            }
            const response = await this.openai.embeddings.create({
                model: "text-embedding-ada-002",
                input: text,
            });
            const embedding = response.data[0].embedding;
            this.embeddingsCache.set(text, embedding);
            return embedding;
        } catch (err) {
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