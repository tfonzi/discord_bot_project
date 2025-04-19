import { Mutex } from 'async-mutex';
import OpenAI from 'openai';
import type {
    ChatCompletionCreateParams,
    ChatCompletionMessageParam
} from 'openai/resources/chat/completions';
import { AttachmentBuilder } from 'discord.js';
import { Buffer } from 'node:buffer';

// V2 Imports
import { DiscordClientV2 } from "../utils/discordClientV2";
import { RedisEmbeddingServiceV2, VectorSimilarityResult } from "../redis/RedisEmbeddingServiceV2"; // Keep for potential future use
import { LoggerV2 } from "../logger/loggerV2";
import { Logger as PinoLogger } from 'pino';
import { delay } from "../utils/utils";
import { encode } from "gpt-3-encoder"; // Keep for potential token counting later

// --- Constants --- (Can be moved or made configurable)
const COLLECT_TIMER = 5000; // 5 seconds
const HISTORY_CHAR_LIMIT = 10000; // Max characters for history context
const CHAT_COMPLETION_MODEL = "gpt-4o"; // Or make configurable
const EMBEDDING_MODEL = "text-embedding-3-small"; // Or make configurable
const IMAGE_GENERATION_MODEL = "dall-e-3"; // Or make configurable

// --- Interfaces & Types ---

type ChatBotResponseV2 = {
    shouldRespond: boolean;
    response: string;
    shouldGenerateImage: boolean;
};

// Content of a single message, potentially batched
type MessageContent = {
    text: string;
    imageUrls?: string[];
};

// Define the schema for the OpenAI tool call
const RESPONSE_TOOL_SCHEMA: OpenAI.ChatCompletionTool = {
    type: "function",
    function: {
        name: "generate_response_and_image_decision",
        description: "Generates the chatbot response text and decides if an image should be generated based on the conversation.",
        parameters: {
            type: "object",
            properties: {
                shouldRespond: {
                    type: "boolean",
                    description: "Whether the chatbot should send a text response message."
                },
                response: {
                    type: "string",
                    description: "The text content of the chatbot's response. Empty if shouldRespond is false."
                },
                shouldGenerateImage: {
                    type: "boolean",
                    description: "Whether the chatbot should generate an image based on the response or conversation context."
                }
            },
            required: ["shouldRespond", "response", "shouldGenerateImage"]
        }
    }
};

// --- MessageHistoryV2 ---

/**
 * Manages the chronological list of messages for a single conversation thread.
 */
class MessageHistoryV2 {
    private systemPrompt: ChatCompletionMessageParam;
    private history: ChatCompletionMessageParam[] = [];
    private logger: PinoLogger;

    constructor(systemPromptText: string, private channelId: string, private capacity: number = 100) {
        this.systemPrompt = { role: "system", content: systemPromptText };
        // Create a child logger specific to this history instance
        this.logger = LoggerV2.getLogger().child({ component: 'MessageHistory', channelId: this.channelId });
        this.logger.info('MessageHistoryV2 created');
    }

    /**
     * Adds a message (user or assistant) to the history.
     * Ensures history does not exceed capacity.
     */
    addMessage(role: 'user' | 'assistant', content: string): void {
        if (role !== 'user' && role !== 'assistant') {
            this.logger.warn({ role }, 'Attempted to add message with invalid role to history');
            return;
        }
        const message: ChatCompletionMessageParam = { role, content };

        if (this.history.length >= this.capacity) {
            const removed = this.history.splice(0, 1); // Remove the oldest message
            this.logger.trace({ removedMessage: removed[0] }, 'History capacity reached, removed oldest message');
        }
        this.history.push(message);
        this.logger.trace({ role, contentLength: content.length }, 'Message added to history');
    }

    /**
     * Returns the system prompt message.
     */
    getSystemPrompt(): ChatCompletionMessageParam {
        return { ...this.systemPrompt }; // Return a copy
    }

    /**
     * Returns the current message history (user and assistant messages).
     */
    getHistory(): ChatCompletionMessageParam[] {
        return [...this.history]; // Return a copy
    }

    /**
     * Gets the recent message history concatenated into a single string,
     * truncated to a maximum character length.
     * Orders messages chronologically (oldest relevant first).
     */
    getHistoryAsString(maxLength: number): string {
        let combined = "";
        let currentLength = 0;

        // Iterate backwards through history to prioritize recent messages
        for (let i = this.history.length - 1; i >= 0; i--) {
            const message = this.history[i];
            // Simple string concatenation for now
            const messageString = `\n${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`;
            const messageLength = messageString.length;

            if (currentLength + messageLength <= maxLength) {
                combined = messageString + combined; // Prepend to maintain order
                currentLength += messageLength;
            } else {
                // Not enough space for the whole message, stop here
                this.logger.trace({ maxLength, currentLength, messagesIncluded: this.history.length - 1 - i }, 'History string truncated due to length limit');
                break;
            }
        }
        return combined.trim(); // Remove leading newline if present
    }

    /**
     * Clears all user/assistant messages from the history.
     */
    clear(): void {
        this.history = [];
        this.logger.info('Message history cleared');
    }
}

// --- MessageProcessorV2 ---

/**
 * Handles message batching for a specific channel.
 * Collects messages over a short period and triggers ChatbotV2 to process the batch.
 */
class MessageProcessorV2 {
    private requestBasket: MessageContent[] = [];
    private responseBasket: MessageContent[] = [];
    private isCollecting: boolean = false;
    private collectingTimer: NodeJS.Timeout | null = null;
    private mutex: Mutex;
    private logger: PinoLogger;

    constructor(private history: MessageHistoryV2,private channelId: string) {
        this.mutex = new Mutex();
        this.logger = LoggerV2.getLogger().child({ component: 'MessageProcessor', channelId: this.channelId });
        this.logger.info('MessageProcessorV2 created');
    }

    /**
     * Processes an incoming message by adding it to the batching queue.
     * Starts the collection timer if not already running.
     */
    async processIncomingMessage(msg: string, imageUrls?: string[]): Promise<void> {
        const messageContent: MessageContent = {
            text: msg,
            imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined
        };
        this.logger.debug({ messageContent }, 'Received message, adding to request basket');
        this.requestBasket.push(messageContent);

        // Move messages from request to response basket under mutex protection
        await this.transferRequestsToResponseBasket();

        // Start collecting if not already doing so
        if (!this.isCollecting) {
            this.startCollecting();
        } else {
            this.logger.debug('Collecting already in progress, refreshing timer');
            this.collectingTimer.refresh();
        }   
    }

    /**
     * Safely transfers messages from the request basket to the response basket.
     */
    private async transferRequestsToResponseBasket(): Promise<void> {
        const release = await this.mutex.acquire();
        try {
            if (this.requestBasket.length > 0) {
                this.logger.trace({ count: this.requestBasket.length }, 'Acquired lock, moving messages to response basket');
                this.responseBasket.push(...this.requestBasket);
                this.requestBasket = [];
            } else {
                this.logger.trace('Acquired lock, no messages in request basket to move');
            }
        } finally {
            release();
            this.logger.trace('Released lock after attempting basket transfer');
        }
    }

    /**
     * Initiates the message collection period.
     */
    private startCollecting(): void {
        if (this.isCollecting) {
            this.logger.warn('startCollecting called while already collecting. Should not happen.');
            return;
        }
        this.isCollecting = true;
        this.logger.debug({ timerDuration: COLLECT_TIMER }, 'Starting collection timer');

        // Clear any potentially existing timer (safety measure)
        if (this.collectingTimer) {
            clearTimeout(this.collectingTimer);
        }

        this.collectingTimer = setTimeout(async () => {
            this.logger.debug('Collection timer finished');
            await this.processResponseBasket();
        }, COLLECT_TIMER);
    }

    /**
     * Processes the collected messages in the response basket after the timer expires.
     */
    private async processResponseBasket(): Promise<void> {
        const release = await this.mutex.acquire();
        this.logger.trace('Acquired lock for processing response basket');
        try {
            // Ensure we are still marked as collecting; if not, another process might be starting
            if (!this.isCollecting) {
                 this.logger.warn('processResponseBasket executed but not in collecting state. Aborting.');
                 return;
            }

            if (this.responseBasket.length > 0) {
                this.logger.info({ count: this.responseBasket.length }, 'Processing batched messages');
                // Combine text and image URLs from the batch
                let combinedText = "";
                const combinedImageUrls: string[] = [];
                this.responseBasket.forEach(content => {
                    combinedText += content.text + "\n"; // Simple newline separation
                    if (content.imageUrls) {
                        combinedImageUrls.push(...content.imageUrls);
                    }
                });
                combinedText = combinedText.trim(); // Remove trailing newline

                const batchToProcess = [...this.responseBasket]; // Copy for logging/potential failure handling
                this.responseBasket = []; // Clear the basket *before* calling the chatbot

                // Trigger ChatbotV2 to handle the actual API call and response
                try {
                    await ChatbotV2.handleMessageBatch(this.channelId, combinedText, combinedImageUrls);
                } catch (error) {
                    this.logger.error({ err: error, batch: batchToProcess }, 'Error occurred during ChatbotV2.handleMessageBatch');
                    // Decide on error handling: retry? notify user? Add back to basket?
                    // For now, log the error and the batch is lost.
                }

            } else {
                this.logger.debug('Response basket empty, nothing to process');
            }

            // Mark collecting as finished
            this.isCollecting = false;
            this.collectingTimer = null;
            this.logger.debug('Finished processing response basket, set isCollecting=false');

        } finally {
            release();
             this.logger.trace('Released lock after processing response basket');
        }
    }

     /**
     * Stops the collection timer and clears baskets if the processor is being deactivated.
     */
    public stop(): void {
         this.logger.info('Stopping message processor and clearing state');
        if (this.collectingTimer) {
            clearTimeout(this.collectingTimer);
            this.collectingTimer = null;
        }
        this.isCollecting = false;
        // Consider acquiring mutex to clear baskets safely?
        this.requestBasket = [];
        this.responseBasket = [];
    }
}

// --- ChatbotV2 ---

/**
 * Static singleton class managing chatbot state, API interactions, and Discord integration.
 */
export class ChatbotV2 {
    // Singleton instance
    private static instance: ChatbotV2 | undefined;

    // State
    private openai: OpenAI | undefined;
    private systemPromptText: string = "You are a helpful assistant."; // Default prompt
    private username: string = "ChatBot";
    private messageHistories: Map<string, MessageHistoryV2> = new Map();
    private messageProcessors: Map<string, MessageProcessorV2> = new Map();
    private activeChats: Map<string, boolean> = new Map(); // Track active state per channel
    private activeChatTimers: Map<string, NodeJS.Timeout> = new Map(); // Inactivity timers
    private logger: PinoLogger;

    // Constants for chat state management (can be adjusted)
    private static readonly INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

    // Private constructor for singleton pattern
    private constructor() {
        // Base logger for the chatbot itself
        this.logger = LoggerV2.getLogger().child({ component: 'ChatbotV2' });
        this.logger.info('ChatbotV2 Singleton constructing...');
        // Initialization logic will be in a separate static method
    }

    // --- Singleton Access and Initialization ---

    /**
     * Initializes the Chatbot singleton with necessary configurations.
     * Must be called once before using other methods.
     * @param apiKey OpenAI API Key.
     * @param systemPrompt The base system prompt for the chatbot.
     * @param botUsername The name the bot should use.
     */
    public static initialize(apiKey: string, systemPrompt: string, botUsername: string): void {
        if (ChatbotV2.instance) {
            ChatbotV2.instance.logger.warn('ChatbotV2 already initialized. Ignoring subsequent call.');
            return;
        }
        // Ensure base logger is created first
        const baseLogger = LoggerV2.getLogger(); 

        ChatbotV2.instance = new ChatbotV2();
        ChatbotV2.instance.openai = new OpenAI({ apiKey });
        ChatbotV2.instance.systemPromptText = systemPrompt || ChatbotV2.instance.systemPromptText;
        ChatbotV2.instance.username = botUsername || ChatbotV2.instance.username;
        ChatbotV2.instance.logger.info({ username: ChatbotV2.instance.username }, 'ChatbotV2 Initialized');
    }

    /**
     * Gets the singleton instance. Throws error if not initialized.
     */
    private static getInstance(): ChatbotV2 {
        if (!ChatbotV2.instance) {
            throw new Error("ChatbotV2 has not been initialized. Call ChatbotV2.initialize() first.");
        }
        return ChatbotV2.instance;
    }

    // --- Internal Helper Methods ---

    /**
     * Gets or creates a MessageHistoryV2 instance for a channel.
     */
    private _getOrCreateHistory(channelId: string): MessageHistoryV2 {
        if (!this.messageHistories.has(channelId)) {
            this.logger.info({ channelId }, 'Creating new MessageHistoryV2 instance');
            this.messageHistories.set(channelId, new MessageHistoryV2(this.systemPromptText, channelId));
        }
        return this.messageHistories.get(channelId)!;
    }

    /**
     * Gets or creates a MessageProcessorV2 instance for a channel.
     */
    private _getOrCreateProcessor(channelId: string): MessageProcessorV2 {
        if (!this.messageProcessors.has(channelId)) {
            this.logger.info({ channelId }, 'Creating new MessageProcessorV2 instance');
            this.messageProcessors.set(channelId, new MessageProcessorV2(this._getOrCreateHistory(channelId), channelId));
        }
        return this.messageProcessors.get(channelId)!;
    }

    // --- Public Static Methods (API) ---

    /**
     * Entry point for handling an incoming message from Discord.
     * Manages chat active state and delegates processing.
     */
    public static async handleIncomingDiscordMessage(channelId: string, userId: string, messageText: string, imageUrls?: string[]): Promise<void> {
        const bot = ChatbotV2.getInstance();
        const logger = bot.logger.child({ channelId, userId });
        logger.info({ hasImages: !!imageUrls?.length }, 'Handling incoming Discord message');

        // Mark chat as active and refresh timer
        ChatbotV2.setChatActiveState(channelId, true);
        ChatbotV2.refreshChatTimer(channelId);

        const processor = bot._getOrCreateProcessor(channelId);
        try {
            await processor.processIncomingMessage(messageText, imageUrls);
        } catch (error) {
            logger.error({ err: error }, 'Error processing incoming message via MessageProcessorV2');
             try {
                 await DiscordClientV2.postMessage("Sorry, I encountered an error trying to process that.", channelId);
             } catch (discordError) {
                 logger.error({ err: discordError }, 'Failed to send error message to Discord');
             }
        }
    }

    /**
     * Handles a batch of messages collected by a MessageProcessor.
     * Constructs context, calls OpenAI, posts response.
     * INTERNAL: Called by MessageProcessorV2 instance.
     */
    public static async handleMessageBatch(channelId: string, combinedText: string, combinedImageUrls?: string[]): Promise<void> {
        const bot = ChatbotV2.getInstance();
        const logger = bot.logger.child({ channelId });
        logger.info({ textLength: combinedText.length, imageCount: combinedImageUrls?.length ?? 0 }, 'Handling message batch');

        try {
            await DiscordClientV2.startTyping(channelId);
        } catch (typingError) {
            logger.error({ err: typingError }, "Error starting typing indicator in handleMessageBatch");
            // Decide if we should continue or abort if typing fails?
            // For now, we log and continue.
        }

        try {
            const history = bot._getOrCreateHistory(channelId);

            // --- 1. Add User Message to History (as before) ---
            const userMessageContentParts: OpenAI.ChatCompletionContentPart[] = [{ type: "text", text: combinedText }];
            if (combinedImageUrls && combinedImageUrls.length > 0) {
                combinedImageUrls.forEach(url => {
                    if (url && typeof url === 'string' && url.startsWith('http')) {
                        userMessageContentParts.push({ type: "image_url", image_url: { url: url, detail: "auto" } });
                    } else {
                        logger.warn({ url }, 'Skipping invalid image URL in batch');
                    }
                });
            }
            const historyTextContent = userMessageContentParts.map(part => {
                 if (part.type === 'text') { return part.text; }
                 else if (part.type === 'image_url') { return `[Image: ${part.image_url?.url ?? 'invalid_url'}]`; }
                 return '[Unsupported Content Part]';
             }).join('\n');
            history.addMessage('user', historyTextContent);

            // --- 2. Prepare API Request --- 
            const systemPromptMsg = history.getSystemPrompt();
            const historyMessages = history.getHistory();
            const messages: ChatCompletionMessageParam[] = [
                systemPromptMsg,
                ...historyMessages.slice(-10), // TEMP limit
                { role: "user", content: userMessageContentParts }
            ];

            // --- 3. Call OpenAI API --- 
            let structuredResponse: ChatBotResponseV2 | null = null;
            let apiErrorOccurred = false;
            try {
                logger.debug({ messageCount: messages.length }, 'Sending request to OpenAI Chat Completion API (expecting tool call)');
                structuredResponse = await bot._chatCompletionApiCall(messages);
            } catch (error) {
                apiErrorOccurred = true;
                logger.error({ err: error }, 'Error calling OpenAI Chat Completion API or parsing response');
                try {
                    await DiscordClientV2.postMessage("I encountered an error while thinking. Please try again.", channelId);
                } catch (discordError) {
                    logger.error({ err: discordError }, 'Failed to post API error message to Discord');
                }
            } 
            
            // --- 4. Process Structured Response --- 
            if (structuredResponse && !apiErrorOccurred) { // Only process if API call succeeded
                logger.info({ responseData: structuredResponse }, 'Received structured response from API call helper');
                const assistantResponseText = structuredResponse.response;

                // Handle text response
                if (structuredResponse.shouldRespond && assistantResponseText) {
                    history.addMessage('assistant', assistantResponseText);
                    try {
                        logger.info({ responseLength: assistantResponseText.length }, 'Posting text response to Discord');
                        await DiscordClientV2.postMessage(assistantResponseText, channelId);
                        logger.debug('Text response posted.');
                    } catch (error) {
                        logger.error({ err: error }, 'Failed to post text response message to Discord');
                    }
                } else {
                    logger.info('Assistant decided not to send a text response (shouldRespond=false or empty response).');
                }

                // Handle image generation
                if (structuredResponse.shouldGenerateImage) {
                    logger.info('Assistant decided to generate an image.');
                    try {
                        const imagePrompt = assistantResponseText || combinedText;
                        const imageUrl = await ChatbotV2.generateImage(imagePrompt);
                        if (imageUrl) {
                            logger.info({ imageUrl }, 'Image generated, attempting to fetch and post');
                            const attachment = await bot._fetchImageAsAttachment(imageUrl);
                            if (attachment) {
                                await DiscordClientV2.postImage(attachment, channelId);
                                logger.info('Successfully posted generated image to Discord.');
                            } else {
                                logger.error('Failed to fetch image or create attachment from URL.');
                                await DiscordClientV2.postMessage("I generated an image, but couldn't post it. Sorry!", channelId);
                            }
                        } else {
                            logger.error('Image generation call returned no URL.');
                            await DiscordClientV2.postMessage("I tried to generate an image, but something went wrong.", channelId);
                        }
                    } catch (imgError) {
                        logger.error({ err: imgError }, 'Error during image generation or posting process');
                        await DiscordClientV2.postMessage("I had trouble generating or posting the image.", channelId);
                    } 
                }

            } else if (!apiErrorOccurred) {
                // Handle case where API call succeeded but returned null (e.g., bad tool parsing after retries)
                logger.error('No structured response received from API call helper, despite no thrown error during call.');
                history.addMessage('assistant', "[Bot encountered an internal error processing the response]");
                await DiscordClientV2.postMessage("Sorry, I had a problem understanding the response I got.", channelId);
            }
            // If apiErrorOccurred, error message already sent in the catch block

        } catch (error) { // Catch errors from steps *before* or *after* the API call try/catch
            logger.error({ err: error }, 'Unhandled error during handleMessageBatch main processing block');
            try {
                await DiscordClientV2.postMessage("An unexpected error occurred while handling your message batch.", channelId);
            } catch (discordError) {
                logger.error({ err: discordError }, 'Failed to post error message to Discord during outer batch catch.');
            }
        }
    }

    /**
     * Calls the OpenAI Chat Completion API, expecting a tool call for structured response.
     * Parses the tool call arguments.
     * Private helper method.
     */
    private async _chatCompletionApiCall(messages: ChatCompletionMessageParam[], attempts: number = 0): Promise<ChatBotResponseV2 | null> {
        if (!this.openai) throw new Error('OpenAI client not initialized in ChatbotV2');
        this.logger.trace({ attempt: attempts + 1, messageCount: messages.length }, 'Making OpenAI chat completion call (expecting tool)');
        try {
            const params: ChatCompletionCreateParams = {
                model: CHAT_COMPLETION_MODEL,
                messages: messages,
                tools: [RESPONSE_TOOL_SCHEMA], // Provide the tool schema
                tool_choice: { type: "function", function: { name: RESPONSE_TOOL_SCHEMA.function.name } }, // Force use of our tool
                temperature: 0.7,
            };
            const response = await this.openai.chat.completions.create(params);
            this.logger.trace({ choice: response.choices[0] }, 'Received OpenAI response');

            const toolCalls = response.choices[0]?.message?.tool_calls;
            if (toolCalls && toolCalls[0]?.function?.name === RESPONSE_TOOL_SCHEMA.function.name) {
                const argsString = toolCalls[0].function.arguments;
                this.logger.debug({ argsString }, 'Attempting to parse tool arguments');
                try {
                    const args = JSON.parse(argsString) as ChatBotResponseV2;
                    // Basic validation of the parsed structure
                    if (typeof args.shouldRespond === 'boolean' &&
                        typeof args.response === 'string' &&
                        typeof args.shouldGenerateImage === 'boolean') {
                        return args;
                    } else {
                        this.logger.error({ args }, 'Parsed tool arguments have incorrect structure/types');
                        throw new Error('Parsed tool arguments have incorrect structure/types');
                    }
                } catch (parseError) {
                     this.logger.error({ err: parseError, argsString }, 'Failed to parse tool arguments JSON');
                     throw new Error('Failed to parse tool arguments from OpenAI response.'); // Rethrow to trigger retry/error handling
                }
            } else {
                this.logger.error({ responseMessage: response.choices[0]?.message }, 'OpenAI response did not contain the expected tool call');
                throw new Error('OpenAI response did not use the expected tool.'); // Rethrow to trigger retry/error handling
            }
        } catch (error) {
            this.logger.error({ err: error, attempt: attempts + 1 }, 'Error during OpenAI API call or tool processing');
            if (attempts < 2) {
                await delay(200 * (attempts + 1));
                return await this._chatCompletionApiCall(messages, attempts + 1);
            } else {
                this.logger.error('Final attempt failed for OpenAI chat completion tool call');
                // Do not throw here, return null to indicate final failure to the caller
                return null;
            }
        }
    }

    /**
     * Helper to fetch an image from a URL and return it as an AttachmentBuilder.
     */
    private async _fetchImageAsAttachment(imageUrl: string): Promise<AttachmentBuilder | null> {
        this.logger.debug({ imageUrl }, 'Fetching image for attachment');
        try {
            const response = await fetch(imageUrl);
            if (!response.ok) {
                 throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            return new AttachmentBuilder(buffer, { name: 'generated_image.png' }); // Simple name
        } catch (error) {
             this.logger.error({ err: error, imageUrl }, 'Failed to fetch image URL or create buffer');
             return null;
        }
    }

    /**
     * Creates an embedding for the given text using OpenAI API.
     */
    public static async createEmbedding(text: string, attempts: number = 0): Promise<number[] | null> {
         const bot = ChatbotV2.getInstance();
         if (!bot.openai) throw new Error('OpenAI client not initialized');
         bot.logger.trace({ attempt: attempts + 1, textLength: text.length }, 'Requesting embedding from OpenAI');
         try {
             const response = await bot.openai.embeddings.create({
                 model: EMBEDDING_MODEL,
                 input: text,
             });
             bot.logger.trace('Received embedding response from OpenAI');
             return response.data[0]?.embedding || null;
         } catch (error) {
             bot.logger.error({ err: error, attempt: attempts + 1 }, 'Error during OpenAI embedding call');
             if (attempts < 2) {
                await delay(200 * (attempts + 1));
                return await ChatbotV2.createEmbedding(text, attempts + 1);
             } else {
                bot.logger.error('Final attempt failed for OpenAI embedding call');
                return null; // Return null on final failure
            }
         }
    }

    /**
     * Generates an image using OpenAI DALL-E API.
     * Returns the image URL or null on failure.
     */
    public static async generateImage(prompt: string, attempts: number = 0): Promise<string | null> {
        const bot = ChatbotV2.getInstance();
        if (!bot.openai) throw new Error('OpenAI client not initialized');
        bot.logger.info({ prompt, attempt: attempts + 1 }, 'Requesting image generation from OpenAI');
        try {
            const response = await bot.openai.images.generate({
                model: IMAGE_GENERATION_MODEL,
                prompt: prompt,
                n: 1, // Generate one image
                size: "1024x1024" // Example size
            });
            const imageUrl = response.data[0]?.url;
            bot.logger.info({ imageUrl }, 'Received image generation response from OpenAI');
            return imageUrl || null;
        } catch (error) {
            bot.logger.error({ err: error, prompt, attempt: attempts + 1 }, 'Error during OpenAI image generation call');
             if (attempts < 2) {
                await delay(500 * (attempts + 1)); // Longer delay for DALL-E?
                return await ChatbotV2.generateImage(prompt, attempts + 1);
             } else {
                bot.logger.error('Final attempt failed for OpenAI image generation call');
                return null; // Return null on final failure
            }
        }
    }

    // --- State Management Methods ---

    public static getHistory(channelId: string): MessageHistoryV2 {
        const bot = ChatbotV2.getInstance();
        return bot._getOrCreateHistory(channelId);
    }

    public static resetHistory(channelId: string): void {
        const bot = ChatbotV2.getInstance();
        bot._getOrCreateHistory(channelId).clear();
        bot.logger.info({ channelId }, 'Chat history reset');
        
        // Stop the processor and its potential timer
        bot.messageProcessors.get(channelId)?.stop(); 
        bot.messageProcessors.delete(channelId);
        
        // Also stop the main inactivity timer and typing loop for the channel
        ChatbotV2.clearChatTimer(channelId);
        ChatbotV2.setChatActiveState(channelId, false); // Ensure chat is marked inactive
    }

    public static setChatActiveState(channelId: string, state: boolean): void {
        // If the state is already set to the desired state, do nothing
        if (state === this.getChatActiveState(channelId)) {
            return;
        }

        const bot = ChatbotV2.getInstance();
        bot.activeChats.set(channelId, state);
        bot.logger.debug({ channelId, state }, 'Chat active state updated');
        if (!state) {
            // Use static access
            ChatbotV2.clearChatTimer(channelId);
            bot.messageProcessors.get(channelId)?.stop();
        }
    }

    public static getChatActiveState(channelId: string): boolean {
        const bot = ChatbotV2.getInstance();
        return bot.activeChats.get(channelId) ?? false; // Default to inactive
    }

    public static refreshChatTimer(channelId: string): void {
        const bot = ChatbotV2.getInstance();
        // Use static access
        ChatbotV2.clearChatTimer(channelId);

        const timer = setTimeout(() => {
            bot.logger.info({ channelId, timeout: ChatbotV2.INACTIVITY_TIMEOUT_MS }, 'Chat inactivity timeout reached');
            // Use static access
            ChatbotV2.setChatActiveState(channelId, false);
        }, ChatbotV2.INACTIVITY_TIMEOUT_MS);

        bot.activeChatTimers.set(channelId, timer);
        bot.logger.trace({ channelId }, 'Chat inactivity timer refreshed');
    }

    public static clearChatTimer(channelId: string): void {
        const bot = ChatbotV2.getInstance();
        if (bot.activeChatTimers.has(channelId)) {
            clearTimeout(bot.activeChatTimers.get(channelId)!);
            bot.activeChatTimers.delete(channelId);
            bot.logger.trace({ channelId }, 'Chat inactivity timer cleared');
        }
    }

     // --- Cleanup --- (Potentially called on bot shutdown)
    public static stopAllProcessors(): void {
         const bot = ChatbotV2.getInstance();
         bot.logger.info('Stopping all message processors...');
         bot.messageProcessors.forEach(processor => processor.stop());
         bot.messageProcessors.clear();
         bot.activeChatTimers.forEach(timer => clearTimeout(timer));
         bot.activeChatTimers.clear();
         bot.activeChats.clear();
         // Note: Doesn't clear histories
    }
} 