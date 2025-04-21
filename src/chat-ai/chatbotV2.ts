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

// --- Constants --- (Can be moved or made configurable)
const COLLECT_TIMER = 5000; // 5 seconds
const HISTORY_CHAR_LIMIT = 10000; // Max characters for history context
const DECISION_MODEL = "o4-mini"; // Model for decision logic
const GENERATION_MODEL = "gpt-4o"; // More powerful model for text/prompt generation
const EMBEDDING_MODEL = "text-embedding-3-small"; // Or make configurable
const IMAGE_GENERATION_MODEL = "dall-e-3"; // Or make configurable

// --- Interfaces & Types ---


// Type for the decision logic response
type DecisionResponse = {
    shouldRespond: boolean;
    shouldGenerateImage: boolean;
    emojiReactions: Array<{ messageId: string; emoji: string }>;
};

// Structure for individual messages passed to the batch handler
type ProcessedMessage = {
    messageId: string; // Discord message ID
    user: string;    // Discord username
    text?: string;
    imageUrls?: string[];
};

// NEW: Define the schema for the decision-making tool call
const DECISION_TOOL_SCHEMA: OpenAI.ChatCompletionTool = {
    type: "function",
    function: {
        name: "make_response_decision",
        description: "Based on the conversation history, decide whether to respond with text, generate an image, and which messages (if any) to react to.",
        parameters: {
            type: "object",
            properties: {
                shouldRespond: {
                    type: "boolean",
                    description: "Whether the chatbot should send a text response message."
                },
                shouldGenerateImage: {
                    type: "boolean",
                    description: "Whether the chatbot should generate an image based on the conversation context."
                },
                emojiReactions: {
                    type: "array",
                    description: "An array of objects, each containing a 'messageId' and 'emoji'. Use an empty array [] if no reactions are desired. Example: [ {\"messageId\": \"123...\", \"emoji\": \"👍\"} ]",
                    items: {
                        type: "object",
                        properties: {
                            messageId: {
                                type: "string",
                                description: "The message ID to react to."
                            },
                            emoji: {
                                type: "string",
                                description: "The emoji (Unicode) to react with."
                            }
                        },
                        required: ["messageId", "emoji"] // Correct casing
                    }
                }
            },
            required: ["shouldRespond", "shouldGenerateImage", "emojiReactions"]
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
        this.logger = LoggerV2.getLogger().child({ component: 'MessageHistory', channelId: this.channelId });
        this.logger.debug('MessageHistoryV2 created');
    }

    /**
     * Transforms a ProcessedMessage into a complete ChatCompletionMessageParam object suitable for history.
     * Returns null if the message should not be added (e.g., assistant message with no text content).
     */
    private _transformProcessedMessageToUserContent(processedMessage: ProcessedMessage): OpenAI.ChatCompletionMessageParam | null {
        const contentParts: OpenAI.ChatCompletionContentPart[] = [];
        const botUsername = ChatbotV2.getUsername();
        const role = processedMessage.user === botUsername ? 'assistant' : 'user'; // Determine role first

        // --- Build Content Parts --- 
        if (processedMessage.text) {
            // Always add text part if present
            let textContent = "";
            if (role === 'user') {
                textContent = `${processedMessage.user}: ${processedMessage.text}`;
            } else { // role === 'assistant'
                textContent = processedMessage.text; // Assistant messages don't need the user prefix
            }
            contentParts.push({ type: "text", text: textContent });
        }

        if (processedMessage.imageUrls) {
            processedMessage.imageUrls.forEach(url => {
                if (url && typeof url === 'string' && url.startsWith('http')) {
                     // ONLY add the image_url part if the role is USER
                     if (role === 'user') { 
                        contentParts.push({ type: "image_url", image_url: { url: url, detail: "auto" } });
                     }
                } else {
                    this.logger.warn({ url, messageId: processedMessage.messageId }, 'Skipping invalid image URL during history transformation');
                }
            });
        }

        if (contentParts.length === 0) {
             // Handle cases where maybe only an invalid image URL was provided, or no text/images at all.
             this.logger.warn({ processedMessage }, 'ProcessedMessage resulted in no valid content parts after filtering.');
             return null;
        }

        // --- Construct Final Message Object (Role determined above) ---
        // Use type assertion as the role is still dynamic in this path
        return { role, content: contentParts } as ChatCompletionMessageParam;
    }

    /**
     * Adds a user or assistant message from a ProcessedMessage object to the history.
     * Ensures history does not exceed capacity.
     */
    addMessage(processedMessage: ProcessedMessage): void {
        const messageToAdd = this._transformProcessedMessageToUserContent(processedMessage);

        if (messageToAdd) {
             if (this.history.length >= this.capacity) {
                 const removed = this.history.splice(0, 1);
                 this.logger.trace({ removedMessage: removed[0] }, 'History capacity reached, removed oldest message');
             }
             this.history.push(messageToAdd);
             // Logging is now done within the transformer method
        } else {
             // Log here if the transformer returned null, indicating it shouldn't be added
             this.logger.warn({ processedMessage }, 'ProcessedMessage did not result in a message being added to history (likely assistant message with no text).');
        }
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
    private requestBasket: ProcessedMessage[] = [];
    private responseBasket: ProcessedMessage[] = [];
    private isCollecting: boolean = false;
    private collectingTimer: NodeJS.Timeout | null = null;
    private mutex: Mutex;
    private logger: PinoLogger;

    constructor(private history: MessageHistoryV2, private channelId: string) {
        this.mutex = new Mutex();
        this.logger = LoggerV2.getLogger().child({ component: 'MessageProcessor', channelId: this.channelId });
        this.logger.debug('MessageProcessorV2 created');
    }

    /**
     * Processes an incoming message by adding it to the batching queue.
     * Starts the collection timer if not already running.
     * UPDATED: Accepts messageId and userId.
     */
    async processIncomingMessage(messageId: string, user: string, text?: string, imageUrls?: string[]): Promise<void> {
        // UPDATED: Create ProcessedMessage object
        const message: ProcessedMessage = {
            messageId,
            user,
            text: text && text.trim() ? text.trim() : undefined,
            imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined
        };
        this.logger.debug({ message }, 'Received message, adding ProcessedMessage to request basket');
        this.requestBasket.push(message);

        await this.transferRequestsToResponseBasket();

        if (!this.isCollecting) {
            this.startCollecting();
        } else {
            this.logger.debug('Collecting already in progress, refreshing timer');
            if (this.collectingTimer) { // Ensure timer exists before refreshing
               this.collectingTimer.refresh();
            }
        }
    }

    /**
     * Safely transfers messages from the request basket to the response basket.
     */
    private async transferRequestsToResponseBasket(): Promise<void> {
        const release = await this.mutex.acquire();
        try {
            if (this.requestBasket.length > 0) {
                this.logger.trace({ count: this.requestBasket.length }, 'Acquired lock, moving ProcessedMessages to response basket');
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
                this.logger.info({ count: this.responseBasket.length }, 'Processing batched ProcessedMessages');
                
                const batchToProcess: ProcessedMessage[] = [...this.responseBasket]; // Copy the batch
                this.responseBasket = []; // Clear the basket *before* calling the chatbot

                try {
                    await ChatbotV2.handleMessageBatch(this.channelId, batchToProcess);
                } catch (error) {
                    this.logger.error({ err: error, batch: batchToProcess }, 'Error occurred during ChatbotV2.handleMessageBatch');
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
    private systemPromptText: string = "You are a helpful assistant."; // Default prompt for generating the main text response
    private additionalSystemPromptText: string = "All previous messages in the chat are provided with the following format: \"User: Message\", including your own. In your response, you must not include the user prefix. In addition, you will be talking with several participants at once. You will have context about each message and who said it. This should factor into what you say. While the output of this chat cannot directly produce images, there is a seperate process for creating images. You will be provided the output of this process, labeled as DECISION_OUTPUT, so you will know if image generation is planned with your response. This DECISION_OUTPUT should not be directly used in your response, but it should be used to inform your response. You also know if you had reacted to specific messages with emojis. Specific messages are dictated by their MessageID."; // Additional context for the chatbot
    private reasoningPromptText: string = "You are an AI assistant responsible for analyzing conversation context and deciding the next steps. Your goal is to determine if a text response is needed, if an image should be generated, and what emoji reactions are appropriate based on the provided message history. The history includes messages with 'MessageID', 'User', 'Text', and potentially 'Images'. You MUST use the 'make_response_decision' tool to output your decisions in the specified JSON format. Focus solely on the decision logic; do not generate response text yourself. Consider the flow of conversation, user requests, and overall engagement when making decisions. Use an empty array [] for emojiReactions if none are suitable. You can react at your own discretion, but you should probably react only around 30% of the time, since reacting to every message would be overwhelming."; // Default prompt for o4-mini decision making
    private imageGenerationPromptText: string = "You are an expert AI assistant specializing in crafting concise, vivid, and effective prompts for the DALL-E 3 image generation model. Analyze the provided conversation history, paying close attention to the most recent messages and the assistant's latest text response (if available). Generate a single, stand-alone image prompt that accurately reflects the user's request or the conversational context. You should take into account prior descriptions and all details. Output ONLY the prompt text itself, with no additional commentary, quotes, or explanations."; // Default prompt for generating DALL-E prompts
    private additionalImageGenerationPromptText: string = " All images must be either in the style of something hand-drawn or painted. All drawings should be amateur level and reflect a rough painting or sketch."; // Additional prompt for generating DALL-E prompts
    // NEW: Prompt for extracting memories upon chat inactivity
    private memoryExtractionPromptText: string = "You are an AI assistant tasked with analyzing a completed conversation history and summarizing the key takeaways for each participant. Review the entire chat log provided, which includes messages from multiple participants ('User: Name Text...') and the assistant's own messages. Please ignore assistant messages when summarizing. The format of the output should be as follows: 'Participant Name, Key Takeaway 1, Key Takeaway 2, Key Takeaway 3, etc., Personality Traits, Impression'. Do not output conversational text, just the summary.";
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

    /**
     * Gets the configured username of the chatbot.
     */
    public static getUsername(): string {
        return ChatbotV2.getInstance().username;
    }

    // --- Internal Helper Methods ---

    /**
     * Gets or creates a MessageHistoryV2 instance for a channel.
     */
    private _getOrCreateHistory(channelId: string): MessageHistoryV2 {
        if (!this.messageHistories.has(channelId)) {
            this.logger.info({ channelId }, 'Creating new MessageHistoryV2 instance');
            this.messageHistories.set(channelId, new MessageHistoryV2(this.systemPromptText, channelId, 100));
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
    public static async handleIncomingDiscordMessage(channelId: string, messageId: string, user: string, messageText?: string, imageUrls?: string[]): Promise<void> {
        const bot = ChatbotV2.getInstance();
        const logger = bot.logger.child({ channelId, messageId, user });
        logger.info({ hasText: !!messageText, imageCount: imageUrls?.length ?? 0 }, 'Handling incoming Discord message');

        // Mark chat as active and refresh timer
        await ChatbotV2.setChatActiveState(channelId, true);
        ChatbotV2.refreshChatTimer(channelId);

        const processor = bot._getOrCreateProcessor(channelId);
        try {
            // UPDATED: Pass messageId and userId to processor
            await processor.processIncomingMessage(messageId, user, messageText, imageUrls);
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
     * UPDATED: Accepts an array of ProcessedMessage objects.
     * INTERNAL: Called by MessageProcessorV2 instance.
     */
    public static async handleMessageBatch(channelId: string, messageBatch: ProcessedMessage[]): Promise<void> {
        const bot = ChatbotV2.getInstance();
        const logger = bot.logger.child({ channelId });
        // UPDATED: Logging the batch details
        logger.info({ batchSize: messageBatch.length, messageIds: messageBatch.map(m => m.messageId) }, 'Handling message batch');

        if (messageBatch.length === 0) {
            logger.warn("handleMessageBatch called with an empty batch. Skipping processing.");
            return;
        }


        try {
            const history = bot._getOrCreateHistory(channelId);

            
            // --- 1. Prepare Base Message Data --- 
            const historyMessages = history.getHistory(); // Get current history (user/assistant turns ONLY)
            
            // Construct the user message content for the API call from the batch
            const userMessages: ChatCompletionMessageParam[] = [];
            messageBatch.forEach(msg => {
                const part: OpenAI.ChatCompletionContentPart[] = [];
                // Add text part if present
                if (msg.text) {
                    // For simplicity now, just adding the text directly.
                    part.push({ type: "text", text: `MessageID: ${msg.messageId}, User: ${msg.user} Text: ${msg.text}` });
                }
                // Add image parts if present
                if (msg.imageUrls) {
                    msg.imageUrls.forEach(url => {
                        if (url && typeof url === 'string' && url.startsWith('http')) {
                            part.push({ type: "image_url", image_url: { url: url, detail: "auto" } });
                        } else {
                            logger.warn({ url, messageId: msg.messageId }, 'Skipping invalid image URL in batch');
                        }
                    });
                }

                if (part.length > 0) {
                    userMessages.push({ role: "user", content: part });
                }
            });

            // Ensure there's at least one part to send, otherwise, OpenAI might error
            if (userMessages.length === 0) {
                logger.warn("Message batch resulted in no content parts for OpenAI. Skipping API call.");
                // Optionally send a message like "I received your message(s) but couldn't process empty content."
                return;
            }

            // Base message history (excluding system prompt for now)
            const baseMessages: ChatCompletionMessageParam[] = [
                 ...historyMessages.slice(-10), // Use recent history
                 ...userMessages // Add the current batch content
            ];

            // --- 3. Add User Message(s) Representation to History --- 
            messageBatch.forEach(msg => {
                if (msg.text) {
                     history.addMessage(msg);
                }
            });

            // --- 4. Get Decision Logic from o4-mini ---
            let decision: DecisionResponse | null = null;
            let decisionErrorOccurred = false;
            try {
                // Construct messages for decision logic
                const decisionRequestMessages: ChatCompletionMessageParam[] = [
                    { role: "system", content: bot.reasoningPromptText },
                    ...baseMessages
                ];
                decision = await bot._getDecisionLogic(decisionRequestMessages); // Pass full messages including system prompt
                if (decision) {
                     logger.debug({ decision }, `Received and parsed decision from ${DECISION_MODEL}`);
                }
            } catch (error) {
                decisionErrorOccurred = true;
                if (!String(error).includes(`during ${DECISION_MODEL} API call`)) {
                    logger.error({ err: error }, `Error processing decision logic after API call`);
                }
                try {
                    await DiscordClientV2.postMessage("I encountered an error while deciding what to do. Please try again.", channelId);
                } catch { /* Ignore */ }
            }

            // --- 5. Process Decision ---
            if (decision && !decisionErrorOccurred) {
                logger.info({ decision }, 'Received decision from API');

                // --- 5a. Handle Emoji Reactions (Immediately) ---
                if (decision.emojiReactions && decision.emojiReactions.length > 0) {
                    logger.info({ reactions: decision.emojiReactions }, 'Attempting emoji reactions.');
                    for (const reactionItem of decision.emojiReactions) {
                        const { messageId: msgId, emoji } = reactionItem;
                        if (!msgId || !emoji) {
                             logger.warn({ reactionItem }, 'Skipping reaction due to invalid item (missing ID or emoji).');
                             continue;
                        }
                        // Check if the message ID exists in the current batch or recent history for context
                        // (Simple check against batch for now)
                        if (messageBatch.some(m => m.messageId === msgId)) {
                           try {
                               logger.debug({ msgId, emoji }, 'Attempting to add reaction');
                               await DiscordClientV2.addReaction(emoji, msgId, channelId);
                           } catch (reactError) {
                               // Log non-critically, don't stop processing for reaction failure
                               logger.warn({ err: reactError, msgId, emoji }, 'Failed to add suggested emoji reaction');
                           }
                        } else {
                             logger.warn({ msgId, emoji }, 'AI suggested reaction for message ID not in the current batch, skipping.');
                        }
                    }
                }

                let assistantResponseText: string | null = null;
                let imagePrompt: string | null = null;
                let imageUrl: string | null = null;

                // --- 5b. Generate Text Response (if needed) ---
                if (decision.shouldRespond) {
                    logger.info('Decision includes generating a text response.');
                    try {
                        await DiscordClientV2.startTyping(channelId);
                    } catch (typingError) {
                        logger.error({ err: typingError }, "Error starting typing indicator in handleMessageBatch");
                    }
                    try {
                        // Construct messages for text generation
                         const generationRequestMessages: ChatCompletionMessageParam[] = [
                             { role: "system", content: `${bot.systemPromptText} ${bot.additionalSystemPromptText}`}, // Use main system prompt
                             ...history.getHistory(), // Get LATEST history, potentially including user messages just added
                             { role: "assistant", content: `DECISION_OUTPUT: ${JSON.stringify(decision)}`}
                         ];
                        assistantResponseText = await bot._generateResponseText(generationRequestMessages); // Pass full messages including system prompt

                        if (assistantResponseText) {
                            logger.info({ responseLength: assistantResponseText.length }, `Generated text response using ${GENERATION_MODEL}`);
                            // Construct ProcessedMessage for assistant text response
                            const assistantMessage: ProcessedMessage = {
                                messageId: "", // Or a unique identifier for the assistant response
                                user: bot.username,
                                text: assistantResponseText
                                // No imageUrls
                            };
                            history.addMessage(assistantMessage); // Add assistant text response to history

                            // Post the text response to Discord
                            try {
                                const normalizedResponse = bot._normalizeAssistantResponse(assistantResponseText, bot.username);
                                await DiscordClientV2.postMessage(normalizedResponse, channelId);
                                logger.debug('Text response posted.');
                            } catch (error) {
                                logger.error({ err: error }, 'Failed to post text response message to Discord');
                                // Continue processing image generation even if text posting fails
                            }
                        } else {
                            logger.warn('generateResponseText returned null or empty string.');
                            // Don't add empty assistant message to history
                        }
                    } catch (genError) {
                         logger.error({ err: genError }, `Error during text generation with ${GENERATION_MODEL}`);
                         // Attempt to post error, but continue if image generation is requested
                         try {
                             await DiscordClientV2.postMessage("I had trouble generating my response text.", channelId);
                         } catch { /* Ignore nested error */ }
                    }
                } else {
                    logger.info('Decision: No text response needed.');
                }

                // --- 5c. Generate Image (if needed) ---
                if (decision.shouldGenerateImage) {
                    logger.info('Decision includes generating an image.');
                    try {
                        // Construct messages for image prompt generation
                        const imagePromptRequestMessages: ChatCompletionMessageParam[] = [
                             ...history.getHistory(),
                        ];
                        imagePrompt = await bot._generateImagePrompt(imagePromptRequestMessages); // Pass context messages

                        if (imagePrompt) {
                            logger.info({ imagePrompt }, `Generated image prompt using ${GENERATION_MODEL}`);
                            imageUrl = await ChatbotV2.generateImage(imagePrompt); // Uses DALL-E 3 constant

                            if (imageUrl) {
                                logger.info({ imageUrl }, 'Image generated, attempting to fetch and post');
                                const attachment = await bot._fetchImageAsAttachment(imageUrl);
                                if (attachment) {
                                    await DiscordClientV2.postImage(attachment, channelId);
                                    logger.info('Successfully posted generated image to Discord.');

                                    // Construct ProcessedMessage for assistant image post
                                    const assistantMessage: ProcessedMessage = {
                                        messageId: "",
                                        user: bot.username,
                                        text: `Assistant generated an image with prompt: ${imagePrompt || '(prompt unavailable)'}`,
                                        imageUrls: [imageUrl]
                                    };
                                    history.addMessage(assistantMessage); // Add image post info to history

                                } else {
                                    logger.error('Failed to fetch image or create attachment from URL.');
                                    await DiscordClientV2.postMessage("I generated an image, but couldn't post it. Sorry!", channelId);
                                }
                            } else {
                                logger.error('Image generation call returned no URL.');
                                await DiscordClientV2.postMessage("I tried to generate an image, but something went wrong with the generation step.", channelId);
                            }
                        } else {
                             logger.error(`Failed to generate an image prompt using ${GENERATION_MODEL}.`);
                             await DiscordClientV2.postMessage("I wanted to generate an image, but couldn't think of a good prompt.", channelId);
                        }
                    } catch (imgError) {
                        logger.error({ err: imgError }, 'Error during image generation or posting process');
                        // Attempt to post a user-friendly error message
                        try {
                             await DiscordClientV2.postMessage("I encountered an error while trying to generate or post the image.", channelId);
                        } catch { /* Ignore nested error */ }
                    }
                } else {
                    logger.info('Decision: No image generation needed.');
                }


            } else if (!decisionErrorOccurred) {
                logger.error(`No decision response received from ${DECISION_MODEL}, despite no thrown error during call.`);
                try {
                     await DiscordClientV2.postMessage("Sorry, I had a problem understanding the decision I received.", channelId);
                } catch { /* Ignore */ }
            }

        } catch (error) {
            logger.error({ err: error }, 'Unhandled error during handleMessageBatch main processing block');
            try {
                await DiscordClientV2.postMessage("An unexpected error occurred while handling your message batch.", channelId);
            } catch (discordError) {
                logger.error({ err: discordError }, 'Failed to post error message/stop typing during outer batch catch.');
            }
        }
    }

    // NEW: Method for getting decision logic from o4-mini
    private async _getDecisionLogic(messages: ChatCompletionMessageParam[], attempts: number = 0): Promise<DecisionResponse | null> {
        if (!this.openai) throw new Error('OpenAI client not initialized in ChatbotV2');
        const params: ChatCompletionCreateParams = {
            model: DECISION_MODEL,
            messages: messages,
            tools: [DECISION_TOOL_SCHEMA],
            tool_choice: { type: "function", function: { name: DECISION_TOOL_SCHEMA.function.name } },
        };
        this.logger.debug({ attempt: attempts + 1, model: params.model, messageCount: messages.length, toolChoice: params.tool_choice }, `Requesting decision logic from ${DECISION_MODEL}`);
        try {
            const response = await this.openai.chat.completions.create(params);
            const toolCalls = response.choices[0]?.message?.tool_calls;
            if (toolCalls && toolCalls[0]?.function?.name === DECISION_TOOL_SCHEMA.function.name) {
                const argsString = toolCalls[0].function.arguments;
                this.logger.debug({ argsString }, 'Attempting to parse decision tool arguments');
                try {
                    const args = JSON.parse(argsString) as Partial<DecisionResponse>;

                    // Validate required fields
                    if (typeof args.shouldRespond !== 'boolean' ||
                        typeof args.shouldGenerateImage !== 'boolean' ||
                        !Array.isArray(args.emojiReactions)) { // Check if array, even if empty
                         this.logger.error({ args }, 'Parsed decision tool arguments missing required fields or have incorrect types');
                         throw new Error('Parsed decision tool arguments missing required fields or have incorrect types');
                    }

                    // Validate emojiReactions items
                    let validatedEmojiReactions: Array<{ messageId: string; emoji: string }> = [];
                    if (Array.isArray(args.emojiReactions)) {
                        for (const item of args.emojiReactions) {
                            // Ensure correct property names (messageId vs MessageID)
                            if (item && typeof item === 'object' &&
                                typeof item.messageId === 'string' && typeof item.emoji === 'string') {
                                validatedEmojiReactions.push({ messageId: item.messageId, emoji: item.emoji });
                            } else {
                                this.logger.warn({ item }, 'Invalid item found in emojiReactions array, skipping.');
                            }
                        }
                    }

                    const finalDecision: DecisionResponse = {
                        shouldRespond: args.shouldRespond,
                        shouldGenerateImage: args.shouldGenerateImage,
                        emojiReactions: validatedEmojiReactions
                    };
                    return finalDecision;

                } catch (parseError) {
                     this.logger.error({ err: parseError, argsString }, 'Failed to parse decision tool arguments JSON or validation failed');
                     const errorMessage = parseError instanceof Error ? parseError.message : 'Failed to parse/validate decision tool arguments.';
                     throw new Error(errorMessage);
                }
            } else {
                this.logger.error({ responseMessage: response.choices[0]?.message }, `Response from ${DECISION_MODEL} did not contain the expected tool call '${DECISION_TOOL_SCHEMA.function.name}'`);
                throw new Error(`Response from ${DECISION_MODEL} did not use the expected tool.`);
            }
        } catch (error) {
            this.logger.error({ err: error, attempt: attempts + 1, model: DECISION_MODEL }, `Error during ${DECISION_MODEL} API call`);
            if (attempts < 2) {
                await delay(200 * (attempts + 1));
                return await this._getDecisionLogic(messages, attempts + 1);
            } else {
                this.logger.error(`Final attempt failed for ${DECISION_MODEL} decision tool call`);
                throw new Error(`Failed to get decision from ${DECISION_MODEL} after multiple attempts: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    // NEW: Method for generating text response using 4o
    private async _generateResponseText(messages: ChatCompletionMessageParam[], attempts: number = 0): Promise<string | null> {
         if (!this.openai) throw new Error('OpenAI client not initialized in ChatbotV2');
         const params: ChatCompletionCreateParams = {
            model: GENERATION_MODEL,
            messages: messages,
            temperature: 0.7, // Adjust as needed
            max_tokens: 500, // Set a reasonable limit for response text
         };
         this.logger.debug({ attempt: attempts + 1, model: params.model, messageCount: messages.length, temperature: params.temperature, max_tokens: params.max_tokens }, `Requesting text generation from ${GENERATION_MODEL}`);
         try {
            const response = await this.openai.chat.completions.create(params);
            const content = response.choices[0]?.message?.content;
            if (content) {
                this.logger.info({ responseLength: content.length, model: GENERATION_MODEL }, `Generated text response using ${GENERATION_MODEL}`);
                return content.trim();
            } else {
                 this.logger.warn({ model: GENERATION_MODEL },'Text generation response content was null or empty.');
                 return null; // Indicate no text generated
            }
         } catch (error) {
            this.logger.error({ err: error, attempt: attempts + 1, model: GENERATION_MODEL }, `Error during ${GENERATION_MODEL} text generation call`);
            if (attempts < 2) {
                await delay(300 * (attempts + 1)); // Slightly longer delay?
                return await this._generateResponseText(messages, attempts + 1);
            } else {
                this.logger.error(`Final attempt failed for ${GENERATION_MODEL} text generation`);
                throw new Error(`Failed to generate text response from ${GENERATION_MODEL} after multiple attempts: ${error instanceof Error ? error.message : String(error)}`);
            }
         }
    }

    // NEW: Method for generating an image prompt using 4o
    private async _generateImagePrompt(messages: ChatCompletionMessageParam[], attempts: number = 0): Promise<string | null> {
         if (!this.openai) throw new Error('OpenAI client not initialized in ChatbotV2');
         const promptGenMessages: ChatCompletionMessageParam[] = [
             { role: "system", content: this.imageGenerationPromptText }, 
              ...messages
         ];

         const params: ChatCompletionCreateParams = {
             model: GENERATION_MODEL,
             messages: promptGenMessages, // Use the array with the system prompt added
             temperature: 0.6, // Slightly lower temp for focused prompt?
             max_tokens: 300, // Prompts shouldn't be excessively long
         };
         this.logger.debug({ attempt: attempts + 1, model: params.model, messageCount: promptGenMessages.length, temperature: params.temperature, max_tokens: params.max_tokens }, `Requesting image prompt generation from ${GENERATION_MODEL}`);
         try {
            const response = await this.openai.chat.completions.create(params);
            const prompt = response.choices[0]?.message?.content;
            if (prompt) {
                const finalPrompt = prompt.concat(this.additionalImageGenerationPromptText).trim().replace(/^["']|["']$/g, "");
                this.logger.info({ promptLength: finalPrompt.length, model: GENERATION_MODEL }, `Generated image prompt using ${GENERATION_MODEL}`);
                // Clean up prompt (remove quotes, etc.) if necessary
                return finalPrompt; // Remove leading/trailing quotes
            } else {
                 this.logger.warn({ model: GENERATION_MODEL }, 'Image prompt generation response content was null or empty.');
                 return null;
            }
         } catch (error) {
            this.logger.error({ err: error, attempt: attempts + 1, model: GENERATION_MODEL }, `Error during ${GENERATION_MODEL} image prompt generation call`);
            if (attempts < 2) {
                await delay(300 * (attempts + 1));
                return await this._generateImagePrompt(messages, attempts + 1);
            } else {
                this.logger.error(`Final attempt failed for ${GENERATION_MODEL} image prompt generation`);
                throw new Error(`Failed to generate image prompt from ${GENERATION_MODEL} after multiple attempts: ${error instanceof Error ? error.message : String(error)}`);
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
         const params = { model: EMBEDDING_MODEL, input: text };
         bot.logger.debug({ attempt: attempts + 1, model: params.model, textLength: text.length }, `Requesting embedding from ${EMBEDDING_MODEL}`);
         try {
             const response = await bot.openai.embeddings.create(params);
             const embedding = response.data[0]?.embedding;
             if (embedding) {
                 bot.logger.debug({ model: EMBEDDING_MODEL, embeddingLength: embedding.length }, `Received embedding response from ${EMBEDDING_MODEL}`);
                 return embedding;
             } else {
                 bot.logger.warn({ model: EMBEDDING_MODEL }, 'Embedding response did not contain embedding data.');
                 return null;
             }
         } catch (error) {
             bot.logger.error({ err: error, attempt: attempts + 1, model: EMBEDDING_MODEL }, `Error during ${EMBEDDING_MODEL} embedding call`);
             if (attempts < 2) {
                await delay(200 * (attempts + 1));
                return await ChatbotV2.createEmbedding(text, attempts + 1);
             } else {
                bot.logger.error(`Final attempt failed for ${EMBEDDING_MODEL} embedding call`);
                throw new Error(`Failed to create embedding from ${EMBEDDING_MODEL} after multiple attempts: ${error instanceof Error ? error.message : String(error)}`);
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
        const params: OpenAI.ImageGenerateParams = {
             model: IMAGE_GENERATION_MODEL,
             prompt: prompt,
             n: 1, // Generate one image
             size: "1024x1024" // Explicitly use allowed literal type
        };
        bot.logger.info({ model: params.model, prompt: params.prompt, n: params.n, size: params.size, attempt: attempts + 1 }, `Requesting image generation from ${IMAGE_GENERATION_MODEL}`);
        try {
            const response = await bot.openai.images.generate(params);
            const imageUrl = response.data[0]?.url;
            if (imageUrl) {
                bot.logger.info({ imageUrl, model: IMAGE_GENERATION_MODEL }, `Received image generation response from ${IMAGE_GENERATION_MODEL}`);
            } else {
                bot.logger.warn({ model: IMAGE_GENERATION_MODEL }, 'Image generation response did not contain a URL.');
            }
            return imageUrl || null;
        } catch (error) {
            bot.logger.error({ err: error, prompt: params.prompt, model: IMAGE_GENERATION_MODEL, attempt: attempts + 1 }, `Error during ${IMAGE_GENERATION_MODEL} image generation call`);
             if (attempts < 2) {
                await delay(500 * (attempts + 1)); // Longer delay for DALL-E?
                return await ChatbotV2.generateImage(prompt, attempts + 1);
             } else {
                bot.logger.error(`Final attempt failed for ${IMAGE_GENERATION_MODEL} image generation call`);
                throw new Error(`Failed to generate image from ${IMAGE_GENERATION_MODEL} after multiple attempts: ${error instanceof Error ? error.message : String(error)}`);
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
        const historyInstance = bot._getOrCreateHistory(channelId); // Get the history instance

        // Log the history before clearing
        const fullHistory = historyInstance.getHistory();
        bot.logger.info({ channelId, history: fullHistory }, 'Chat history before reset');

        historyInstance.clear(); // Clear the history
        bot.logger.info({ channelId }, 'Chat history reset');
    }

    public static async setChatActiveState(channelId: string, state: boolean): Promise<void> {
        // If the state is already set to the desired state, do nothing
        if (state === ChatbotV2.getChatActiveState(channelId)) {
            return;
        }

        const bot = ChatbotV2.getInstance();
        bot.activeChats.set(channelId, state);
        bot.logger.info({ channelId, state }, 'Chat active state updated');
        if (!state) {
            // Use static access
            ChatbotV2.clearChatTimer(channelId);
            bot.messageProcessors.get(channelId)?.stop();
            // Remove the processor instance when chat goes inactive
            bot.messageProcessors.delete(channelId);
            bot.logger.debug({ channelId }, 'Stopped and removed message processor due to inactivity.');
            // Extract memories before setting inactive
            await bot._extractAndLogConversationMemories(channelId)
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

        const timer = setTimeout(async () => { // Make the callback async
            bot.logger.info({ channelId, timeout: ChatbotV2.INACTIVITY_TIMEOUT_MS }, 'Chat inactivity timeout reached');

            // Use static access
            await ChatbotV2.setChatActiveState(channelId, false);
        }, ChatbotV2.INACTIVITY_TIMEOUT_MS);

        bot.activeChatTimers.set(channelId, timer);
        bot.logger.debug({ channelId }, 'Chat inactivity timer refreshed');
    }

    public static clearChatTimer(channelId: string): void {
        const bot = ChatbotV2.getInstance();
        if (bot.activeChatTimers.has(channelId)) {
            clearTimeout(bot.activeChatTimers.get(channelId)!);
            bot.activeChatTimers.delete(channelId);
            bot.logger.debug({ channelId }, 'Chat inactivity timer cleared');
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

    /**
     * Helper to normalize the assistant's response text by removing an unwanted prefix.
     */
    private _normalizeAssistantResponse(responseText: string, botUsername: string): string {
        const prefix = `${botUsername}: `;
        if (responseText.startsWith(prefix)) {
            this.logger.debug({ originalLength: responseText.length, prefixLength: prefix.length }, 'Normalizing assistant response: Removed prefix');
            return responseText.substring(prefix.length);
        }
        return responseText; // Return original if prefix not found
    }

    // NEW: Method for generating a memory summary using the decision model
    private async _generateMemorySummary(messages: ChatCompletionMessageParam[], attempts: number = 0): Promise<string | null> {
        if (!this.openai) throw new Error('OpenAI client not initialized in ChatbotV2');
        const summaryMessages: ChatCompletionMessageParam[] = [
            { role: "system", content: this.memoryExtractionPromptText },
            ...messages // Include the full history passed in
        ];

        const params: ChatCompletionCreateParams = {
            model: DECISION_MODEL, // Use the decision model for analysis as requested
            messages: summaryMessages,
            max_completion_tokens: 25000,
            reasoning_effort: "high"
        };
        this.logger.debug({ attempt: attempts + 1, model: params.model, messageCount: summaryMessages.length }, `Requesting memory summary from ${DECISION_MODEL}`);
        try {
            const response = await this.openai.chat.completions.create(params);
            const content = response.choices[0]?.message?.content;
            if (content) {
                this.logger.info({ summaryLength: content.length, model: DECISION_MODEL }, `Generated memory summary using ${DECISION_MODEL}`);
                return content.trim();
            } else {
                this.logger.warn({ model: DECISION_MODEL }, 'Memory summary generation response content was null or empty.');
                return null;
            }
        } catch (error) {
            this.logger.error({ err: error, attempt: attempts + 1, model: DECISION_MODEL }, `Error during ${DECISION_MODEL} memory summary generation call`);
            if (attempts < 1) { // Retry only once for this non-critical task?
                await delay(300 * (attempts + 1));
                return await this._generateMemorySummary(messages, attempts + 1);
            } else {
                this.logger.error(`Final attempt failed for ${DECISION_MODEL} memory summary generation`);
                // Don't throw, just return null as it's not critical for chat operation
                return null;
            }
        }
    }


    // NEW: Method to extract and log conversation memories
    private async _extractAndLogConversationMemories(channelId: string): Promise<void> {
        const logger = this.logger.child({ channelId, action: 'extractMemory' });
        logger.info('Attempting to extract conversation memories upon inactivity.');

        try {
            const history = this._getOrCreateHistory(channelId); // Should exist if chat was active
            const conversationHistory = history.getHistory();

            if (conversationHistory.length === 0) {
                logger.info('No conversation history found to analyze for memories.');
                return;
            }

            const memorySummary = await this._generateMemorySummary(conversationHistory);

            if (memorySummary) {
                // For now, just log the summary. Could be stored elsewhere later.
                logger.info({ memorySummary }, 'Successfully generated conversation memory summary.');
                // TODO: Potentially store this summary associated with the channel or user IDs.
            } else {
                logger.warn('Failed to generate a memory summary for the conversation.');
            }

        } catch (error) {
            logger.error({ err: error }, 'Error occurred during memory extraction process.');
        }
    }
} 