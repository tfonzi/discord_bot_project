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
const COLLECT_TIMER = 7000; // 7 seconds
const COLLECT_TIMER_REFRESH_INTERVAL = 5000; // 5 second
const HISTORY_CHAR_LIMIT = 10000; // Max characters for history context
const DECISION_MODEL = "o4-mini"; // Model for decision logic
const DECISION_MODEL_2 = "o3"
const GENERATION_MODEL = "gpt-4o"; // More powerful model for text/prompt generation
const EMBEDDING_MODEL = "text-embedding-ada-002"; // Or make configurable
const IMAGE_GENERATION_MODEL = "gpt-image-1"; // Or make configurable
const MEMORY_SEARCH_COUNT = 10; // NEW: How many memories to retrieve

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

// NEW: Define the schema for memory extraction
const MEMORY_EXTRACTION_TOOL_SCHEMA: OpenAI.ChatCompletionTool = {
    type: "function",
    function: {
        name: "extract_conversation_memories",
        description: "Extracts key memories, personal details, relationship dynamics, and personality insights from the conversation history.",
        parameters: {
            type: "object",
            properties: {
                memories: {
                    type: "array",
                    description: "An array of strings, where each string is a concise (1-3 sentences) memory or insight extracted from the conversation. Focus on personal details, relationships, user personalities, or important facts mentioned.",
                    items: {
                        type: "string",
                        description: "A single, concise memory or insight (1-3 sentences)."
                    }
                }
            },
            required: ["memories"]
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
            // Clear any potentially existing timer (safety measure)
            if (this.collectingTimer) {
                clearTimeout(this.collectingTimer);
            }

            this.collectingTimer = setTimeout(async () => {
                this.logger.debug('Collection timer finished');
                await this.processResponseBasket();
            }, COLLECT_TIMER_REFRESH_INTERVAL);
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
    private systemPromptText: string = "You are Rivanna, a Dungeons and Dragons Bard."; // Default prompt for generating the main text response
    private additionalSystemPromptText: string = "All previous messages in the chat are provided with the following format: \"User: Message\", including your own. In your response, you must not include the user prefix. Also, please do not wrap your response in quotes. In addition, you will be talking with several participants at once. You will have context about each message and who said it. This should factor into what you say. If you are asked to generate an image or decide to generate one, act as if you are creating the image yourself. You should never refer to yourself as an AI, or an assistant, or a bot. You are a human bard in a Dungeons and Dragons world. You are also a participant in the conversation, and should take that into account when making decisions."; // UPDATED context for the chatbot
    private reasoningPromptText: string = "You are an AI assistant responsible for analyzing conversation context and deciding the next steps should be for assistant, also known as Rivanna. Your goal is to determine if a text response is needed, if an image should be generated, and what emoji reactions are appropriate based on the provided message history. The history includes messages with 'MessageID', 'User', 'Text', and potentially 'Images'. You MUST use the 'make_response_decision' tool to output your decisions in the specified JSON format. Focus solely on the decision logic; do not generate response text yourself. Consider the flow of conversation, user requests, and overall engagement when making decisions. Use an empty array [] for emojiReactions if none are suitable. You can react at your own discretion, but you should probably react only around 30% of the time, since reacting to every message would be overwhelming."; // Default prompt for o4-mini decision making
    private imageGenerationPromptText: string = "You are an expert AI assistant specializing in crafting concise, vivid, and effective prompts for the DALL-E 3 image generation model. Analyze the provided conversation history, paying close attention to the most recent messages and the assistant's (who's name is Rivanna) latest text response (if available). Generate a single, stand-alone image prompt that accurately reflects the user's request or the conversational context. You should take into account prior descriptions and all details. Output ONLY the prompt text itself, with no additional commentary, quotes, or explanations."; // Default prompt for generating DALL-E prompts
    private additionalImageGenerationPromptText: string = " All images must be either in the style of something hand-drawn or painted. All drawings should be amateur level and reflect a rough painting or sketch."; // Additional prompt for generating DALL-E prompts
    // UPDATED: Prompt for extracting memories using a tool
    private memoryExtractionPromptText: string = `Your name is Rivanna, and your job, as the assitant, is to analyze multi-participant conversations to extract meaningful memories and insights. Review the entire chat log provided, which includes messages formatted like 'User: Name Text...' and the assistant's own messages (which you should generally ignore unless they provide crucial context about the other participants or your general relationship with them). Your goal is to identify and summarize key takeaways about the participants, as well as your own lore that other participants tell you about yourself. Please refrain from making memories about yourself if you are the author of that message. However, if the other participants are talking about your lore, you can make memories about that.

Focus on:
- **Personal Details:** Facts revealed about individuals (e.g., hobbies, preferences, work, life events).
- **Relationships & Dynamics:** How participants interact with each other (e.g., agreements, disagreements, support, inside jokes).
- **Personality & Vibe:** Consistent traits, communication styles, or attitudes displayed by participants.
- **Important Facts/Topics:** Key information or recurring themes discussed in the conversation.
- **Lore:** Facts about yourself or events that other participants tell you about.

Formulate each distinct memory or insight as a concise string, ideally 1-3 sentences long.

**IMPORTANT CONTEXT:** You will be given a list of EXISTING memories previously stored for this conversation. You will ALSO be given the LATEST segment of the conversation transcript, as well as your incomplete starting backstory. 
Your task is to ANALYZE THE LATEST TRANSCRIPT segment and identify ONLY the NEW insights, facts, or significantly UPDATED details that are NOT already captured adequately in the EXISTING memories. 
- DO NOT simply repeat memories from the existing list.
- If the new transcript segment contains information that refines or significantly adds to an existing memory, formulate an UPDATED memory string. It is important that total information is not lost if an existing memory is updated.
- If the new transcript reveals entirely new facts or insights, formulate a NEW memory string.
- Keep all output memories concise (1-3 sentences).
- Please refrain from making memories too complex. If the memory is too complex, it is better to seperate it into multiple memories.

Output ONLY the NEW or UPDATED memory strings derived from the LATEST transcript segment.

You MUST use the 'extract_conversation_memories' tool to return these memories. The output should ONLY be the tool call containing an array of the NEW/UPDATED memory strings. Do not provide any other conversational text or explanation. If no new or updated memories are found based on the latest transcript, call the tool with an empty array [].`;
    private username: string = "ChatBot";
    private messageHistories: Map<string, MessageHistoryV2> = new Map();
    private messageProcessors: Map<string, MessageProcessorV2> = new Map();
    private activeChats: Map<string, boolean> = new Map(); // Track active state per channel
    private activeChatTimers: Map<string, NodeJS.Timeout> = new Map(); // Inactivity timers
    private activeSessionStartIndex: Map<string, number> = new Map();
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
     * Initializes the Chatbot singleton. Assumes Redis client is initialized elsewhere.
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
            let batchTextContent = ""; // NEW: Accumulate text for memory search query
            messageBatch.forEach(msg => {
                const part: OpenAI.ChatCompletionContentPart[] = [];
                // Add text part if present
                if (msg.text) {
                    // For simplicity now, just adding the text directly.
                    const formattedText = `MessageID: ${msg.messageId}, User: ${msg.user} Text: ${msg.text}`; // Keep original format for API
                    part.push({ type: "text", text: formattedText });
                    batchTextContent += `${msg.user}: ${msg.text}\n`; // Accumulate simpler format for query
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
            batchTextContent = batchTextContent.trim(); // Clean up accumulated text

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
                 // Add representation to history (text/image).
                 // Assistant responses added later.
                 history.addMessage(msg);
            });

            // --- 4. Start Typing Indicator ---
            try {
                await DiscordClientV2.startTyping(channelId);
            } catch (typingError) {
                logger.error({ err: typingError }, "Error starting typing indicator in handleMessageBatch");
            }

            // --- 5. Get Decision Logic from o4-mini ---
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

            // --- 6. Process Decision ---
            if (decision && !decisionErrorOccurred) {
                logger.info({ decision }, 'Received decision from API');

                // --- 6a. Handle Emoji Reactions (Immediately) ---
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

                // --- 6b. Generate Text Response (if needed) ---
                if (decision.shouldRespond) {
                    logger.info('Decision includes generating a text response.');
                    // >>> MEMORY RETRIEVAL START <<<
                    let relevantMemories: string[] = [];
                    if (batchTextContent) { // Only search if there's text context from the batch
                        try {
                             logger.debug({ channelId, queryTextLength: batchTextContent.length }, "Attempting to retrieve relevant memories");
                             const queryEmbedding = await ChatbotV2.createEmbedding(batchTextContent);
                             if (queryEmbedding) {
                                 // Directly use the static method
                                 const indexName = `channel:${channelId}`; // Define index name
                                 const searchResults = await RedisEmbeddingServiceV2.PerformVectorSimilarity(
                                     indexName,
                                     queryEmbedding,
                                     MEMORY_SEARCH_COUNT
                                 );
                                 // Use 'result' field from VectorSimilarityResult which holds the text
                                 relevantMemories = searchResults.map(result => result.result).filter((text): text is string => !!text).map(text => text.replaceAll(`noderedis:${indexName}:`, ""));
                                 if (relevantMemories.length > 0) {
                                      logger.info({ count: relevantMemories.length }, "Retrieved relevant memories");
                                 } else {
                                      logger.debug("No relevant memories found in Redis.");
                                 }
                             } else {
                                 logger.warn("Failed to create embedding for memory search query.");
                             }
                        } catch (redisError: any) {
                             // Check if the error indicates the index doesn't exist yet
                             const indexName = `channel:${channelId}`; // Define here too for logging
                             if (redisError.message && redisError.message.includes('no such index')) {
                                  logger.warn({ index: `idx:${indexName}` }, "Memory index does not exist yet for this channel. Skipping memory retrieval.");
                             } else {
                                  logger.error({ err: redisError, indexName }, "Error during memory retrieval from Redis.");
                                  // Don't block response generation due to memory error
                             }
                        }
                    } else {
                         logger.debug("No batch text content, skipping memory retrieval.");
                    }
                    // >>> MEMORY RETRIEVAL END <<<
                    try {
                        // Construct messages for text generation
                         const generationRequestMessages: ChatCompletionMessageParam[] = [
                             { role: "system", content: `${bot.systemPromptText} ${bot.additionalSystemPromptText}`}, // Use main system prompt
                         ];

                         // >>> MEMORY INJECTION START <<<
                         if (relevantMemories.length > 0) {
                              const memoryContext = "Relevant past memories for context: " + relevantMemories.join(" ");
                              generationRequestMessages.push({ role: "system", content: memoryContext });
                              logger.debug("Injecting retrieved memories into generation prompt.");
                         }
                         // >>> MEMORY INJECTION END <<<

                         // Add latest history AFTER system prompts/memories
                         generationRequestMessages.push(...history.getHistory());

                         if (decision.shouldGenerateImage) {
                            generationRequestMessages.push( 
                                // NEW: Re-add and refine the decision context message
                                { role: "system", content: `CONTEXT_INFO: You have decided to generate an image for the user (decision.shouldGenerateImage=${decision.shouldGenerateImage}). If true, weave this fact into your response naturally, pretending you are the one creating the image. Do not explicitly mention 'CONTEXT_INFO' or the decision process.` });
                         }
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

                // --- 6c. Generate Image (if needed) ---
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
                            // UPDATED: Call generateImage which now returns b64_json
                            const imageB64Json = await ChatbotV2.generateImage(imagePrompt); // Uses DALL-E 3 constant

                            if (imageB64Json) {
                                logger.info('Image generated (b64_json), attempting to create attachment and post');
                                // UPDATED: Create buffer directly from base64
                                try {
                                    const buffer = Buffer.from(imageB64Json, 'base64');
                                    const attachment = new AttachmentBuilder(buffer, { name: 'generated_image.png' });
                                    await DiscordClientV2.postImage(attachment, channelId);
                                    logger.info('Successfully posted generated image to Discord.');

                                    // Construct ProcessedMessage for assistant image post
                                    // Store prompt, not the large b64 data or a URL
                                    const assistantMessage: ProcessedMessage = {
                                        messageId: "",
                                        user: bot.username,
                                        text: `Assistant generated an image with prompt: ${imagePrompt || '(prompt unavailable)'}`,
                                        // No imageUrls needed here
                                    };
                                    history.addMessage(assistantMessage); // Add image post info to history
                                } catch (bufferError) {
                                    logger.error({ err: bufferError }, 'Failed to create buffer/attachment from b64_json.');
                                    await DiscordClientV2.postMessage("I generated an image, but couldn't process the data to post it. Sorry!", channelId);
                                }
                            } else {
                                logger.error('Image generation call returned no b64_json data.');
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
            this.logger.trace({ openAIParams: params }, `Making OpenAI API call to ${DECISION_MODEL} for decision logic`); // Add trace log
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
            this.logger.trace({ openAIParams: params }, `Making OpenAI API call to ${GENERATION_MODEL} for text generation`); // Add trace log
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
         // Add the style instruction as a system message at the beginning
         const promptGenMessages: ChatCompletionMessageParam[] = [
             { role: "system", content: this.imageGenerationPromptText },
             { role: "system", content: `STYLE_CONSTRAINT: ${this.additionalImageGenerationPromptText}` }, // Add style constraint here
              ...messages
         ];

         const params: ChatCompletionCreateParams = {
             model: GENERATION_MODEL,
             messages: promptGenMessages, // Use the array with the system prompts added
             temperature: 0.6, // Slightly lower temp for focused prompt?
             max_tokens: 300, // Prompts shouldn't be excessively long
         };
         this.logger.debug({ attempt: attempts + 1, model: params.model, messageCount: promptGenMessages.length, temperature: params.temperature, max_tokens: params.max_tokens }, `Requesting image prompt generation from ${GENERATION_MODEL}`);
         try {
            this.logger.trace({ openAIParams: params }, `Making OpenAI API call to ${GENERATION_MODEL} for image prompt generation`); // Add trace log
            const response = await this.openai.chat.completions.create(params);
            const prompt = response.choices[0]?.message?.content;
            if (prompt) {
                // Still concatenate at the end for DALL-E reinforcement
                const finalPrompt = prompt.concat(" " + this.additionalImageGenerationPromptText).trim().replace(/^["']|["']$/g, "");
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
             bot.logger.trace({ openAIParams: params }, `Making OpenAI API call to ${EMBEDDING_MODEL} for embedding`); // Add trace log
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
             size: "1024x1024", // Explicitly use allowed literal type
        };
        bot.logger.info({ model: params.model, prompt: params.prompt, n: params.n, size: params.size, attempt: attempts + 1 }, `Requesting image generation from ${IMAGE_GENERATION_MODEL}`); // Log response_format
        try {
            bot.logger.trace({ openAIParams: params }, `Making OpenAI API call to ${IMAGE_GENERATION_MODEL} for image generation`); // Add trace log
            const response = await bot.openai.images.generate(params);
            // UPDATED: Access b64_json field
            const imageB64Json = response.data[0]?.b64_json;
            if (imageB64Json) {
                bot.logger.info({ model: IMAGE_GENERATION_MODEL }, `Received image generation response (b64_json) from ${IMAGE_GENERATION_MODEL}`);
            } else {
                bot.logger.warn({ model: IMAGE_GENERATION_MODEL }, 'Image generation response did not contain b64_json data.');
            }
            return imageB64Json || null; // Return the base64 string or null
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
        const bot = ChatbotV2.getInstance(); // Get instance once
        const currentState = bot.activeChats.get(channelId) ?? false;

        // If the state is already set to the desired state, do nothing
        if (state === currentState) {
            return;
        }

        bot.activeChats.set(channelId, state);
        bot.logger.info({ channelId, state }, 'Chat active state updated');

        if (!state) {
            // --- Chat becoming INACTIVE ---
            ChatbotV2.clearChatTimer(channelId);

            // Stop and remove the processor
            bot.messageProcessors.get(channelId)?.stop();
            bot.messageProcessors.delete(channelId);
            bot.logger.debug({ channelId }, 'Stopped and removed message processor due to inactivity.');

            // Start typing
            await DiscordClientV2.startTyping(channelId);

            // --- Generate and Post Goodbye Message via ChatbotV2 --- 
            bot.logger.debug('Calling generateAndPostGoodbye...');
            await ChatbotV2.generateAndPostGoodbye(channelId);
            bot.logger.debug('generateAndPostGoodbye finished.');
            // -----------------------------------------------------

            await DiscordClientV2.postMessage(`*Rivanna leaves chat*`, channelId);

            // Extract memories using messages from the session that just ended
            try {
                const historyInstance = bot.messageHistories.get(channelId);
                if (historyInstance) {
                    const startIndex = bot.activeSessionStartIndex.get(channelId) ?? 0;
                    const conversationHistory = historyInstance.getHistory();
                    const sessionMessages = conversationHistory.slice(startIndex);

                    if (sessionMessages.length > 0) {
                         bot.logger.info({ channelId, startIndex, sessionMessageCount: sessionMessages.length }, 'Extracting memories from last active session.');
                         // Pass only the relevant session messages
                         await bot._extractEmbedAndStoreMemories(channelId, sessionMessages);
                    } else {
                         bot.logger.info({ channelId, startIndex }, 'No new messages in the last active session to extract memories from.');
                    }
                } else {
                    bot.logger.warn({ channelId }, 'Cannot extract memories for inactive chat, history instance not found.');
                }
            } catch (error) {
                 bot.logger.error({ err: error, channelId }, 'Error during memory extraction on chat inactivity.');
            } finally {
                 // Clean up the start index tracker for this channel
                 bot.activeSessionStartIndex.delete(channelId);
            }
        } else {
             // --- Chat becoming ACTIVE ---
             bot.logger.debug({ channelId }, 'Chat marked as active.');
             // Record the current history length as the start index for this new session
             const historyInstance = bot._getOrCreateHistory(channelId); // Ensure history exists
             const startIndex = historyInstance.getHistory().length;
             bot.activeSessionStartIndex.set(channelId, startIndex);
             bot.logger.info({ channelId, startIndex }, 'Recorded start index for new active session.');

             // NEW: Attempt to create/verify Redis index for memories on chat activation
             const indexName = `channel:${channelId}`;
             try {
                 await RedisEmbeddingServiceV2.CreateIndexForEmbedding(indexName);
                 // Log success only if it didn't already exist (handled inside CreateIndexForEmbedding)
             } catch (error) {
                 // Log warn, but don't prevent chat activation
                 bot.logger.warn({ err: error, indexName });
             }

             // Ensure processor exists (it's created on first message if needed)
             // Refresh timer happens on message receipt, not here.
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

    // UPDATED: Method for generating a memory summary using a tool, accepting the conversation script AND existing memories
    private async _generateMemorySummary(conversationScript: string, existingMemories: string[], attempts: number = 0): Promise<string[] | null> {
        if (!this.openai) throw new Error('OpenAI client not initialized in ChatbotV2');

        // Construct messages for the API call
        const summaryMessages: ChatCompletionMessageParam[] = [
            { role: "system", content: this.memoryExtractionPromptText },
            { role: "system", content: `Reminder: You are the assistant and your name is ${ChatbotV2.getUsername()}.` }, // Simplified name context
            { role: "system", content: this.systemPromptText },
        ];

        // Add existing memories if available
        if (existingMemories.length > 0) {
            const existingMemoryContext = "EXISTING MEMORIES (for context, do not repeat):\n" + existingMemories.map(m => `- ${m}`).join("\n");
            summaryMessages.push({ role: "system", content: existingMemoryContext });
        }

        // Add the new conversation script segment
        summaryMessages.push({
            role: "user",
            content: `LATEST CONVERSATION TRANSCRIPT (analyze for new/updated memories):\n${conversationScript}`
        });

        const params: ChatCompletionCreateParams = {
            model: DECISION_MODEL_2, // Use the decision model for analysis
            messages: summaryMessages,
            tools: [MEMORY_EXTRACTION_TOOL_SCHEMA], // Use the new tool schema
            tool_choice: { type: "function", function: { name: MEMORY_EXTRACTION_TOOL_SCHEMA.function.name } }, // Force the tool
        };
        this.logger.debug({ attempt: attempts + 1, model: params.model, messageCount: summaryMessages.length, scriptLength: conversationScript.length, toolChoice: params.tool_choice }, `Requesting memory extraction via tool from ${DECISION_MODEL_2}`);

        try {
            this.logger.trace({ openAIParams: params }, `Making OpenAI API call to ${DECISION_MODEL_2} for memory extraction`); // Add trace log
            const response = await this.openai.chat.completions.create(params);
            const toolCalls = response.choices[0]?.message?.tool_calls;

            if (toolCalls && toolCalls[0]?.function?.name === MEMORY_EXTRACTION_TOOL_SCHEMA.function.name) {
                const argsString = toolCalls[0].function.arguments;
                this.logger.debug({ argsString }, 'Attempting to parse memory extraction tool arguments');
                try {
                    const args = JSON.parse(argsString) as { memories?: string[] }; // Expect { memories: ["...", "..."] }

                    // Validate the response structure
                    if (args && Array.isArray(args.memories) && args.memories.every(item => typeof item === 'string')) {
                        this.logger.info({ memoryCount: args.memories.length, model: DECISION_MODEL_2 }, `Successfully extracted memories using ${DECISION_MODEL_2} tool.`);
                        return args.memories; // Return the array of memory strings
                    } else {
                        this.logger.error({ args }, 'Parsed memory extraction tool arguments are invalid or missing the "memories" array of strings.');
                        throw new Error('Parsed memory extraction tool arguments invalid or missing required "memories" array.');
                    }
                } catch (parseError) {
                    this.logger.error({ err: parseError, argsString }, 'Failed to parse memory extraction tool arguments JSON or validation failed');
                    throw new Error(`Failed to parse/validate memory tool arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
                }
            } else {
                this.logger.error({ responseMessage: response.choices[0]?.message }, `Response from ${DECISION_MODEL_2} did not contain the expected tool call '${MEMORY_EXTRACTION_TOOL_SCHEMA.function.name}' for memory extraction`);
                throw new Error(`Response from ${DECISION_MODEL_2} did not use the expected memory extraction tool.`);
            }
        } catch (error) {
            this.logger.error({ err: error, attempt: attempts + 1, model: DECISION_MODEL_2 }, `Error during ${DECISION_MODEL_2} memory extraction tool call`);
            if (attempts < 1) { // Retry only once for this non-critical task?
                await delay(300 * (attempts + 1));
                // Pass the script string AND existing memories in the retry call
                return await this._generateMemorySummary(conversationScript, existingMemories, attempts + 1);
            } else {
                this.logger.error(`Final attempt failed for ${DECISION_MODEL_2} memory extraction`);
                // Don't throw, just return null as it's not critical for chat operation
                return null;
            }
        }
    }

    // RENAMED & UPDATED: Was _extractAndLogConversationMemories
    // Now extracts, embeds, and stores NEW/UPDATED memories in Redis using static methods.
    private async _extractEmbedAndStoreMemories(channelId: string, messagesToAnalyze: ChatCompletionMessageParam[]): Promise<void> {
        const logger = this.logger.child({ channelId, action: 'extractEmbedStoreMemory' });
        logger.info('Attempting to extract, embed, and store conversation memories.');

        // Rely on RedisEmbeddingServiceV2 static methods to handle client availability.

        if (!messagesToAnalyze || messagesToAnalyze.length === 0) {
            logger.info('No messages provided to analyze for memories.');
            return;
        }

        // --- Transform messages into script string ---
        let conversationScript = "";
        const botUsername = ChatbotV2.getUsername(); // Get username once

        for (const message of messagesToAnalyze) {
            let line = "";
            // Extract text content, handling different formats
            let textContent = "";
            if (typeof message.content === 'string') {
                textContent = message.content;
            } else if (Array.isArray(message.content)) {
                // Find the first text part if content is an array
                const textPart = message.content.find(part => part.type === 'text');
                // Check the type before accessing .text
                if (textPart && textPart.type === 'text') {
                     textContent = textPart.text;
                } else {
                     textContent = ""; // Default if no text part found
                }
            }

            if (message.role === 'assistant') {
                // Prepend bot name to assistant messages
                if (textContent) { // Only add if there's text
                     line = `${botUsername}: ${textContent}`;
                }
            } else if (message.role === 'user') {
                // Use user message content directly (assuming it's already formatted)
                if (textContent) { // Only add if there's text
                    line = textContent; // Should already be "User: Name Text..."
                }
            }
            // Add other roles if necessary in the future

            if (line) { // Append the formatted line if it's not empty
                 conversationScript += line + "\n";
            }
        }
        conversationScript = conversationScript.trim(); // Remove trailing newline

        if (!conversationScript) {
             logger.warn("Failed to generate a non-empty conversation script from the messages.");
             return;
        }
        // -----------------------------------------

        try {
            // NEW: 1. Get Existing Memories from Redis
            const indexName = `channel:${channelId}`;
            let existingMemories: string[] = [];
            try {
                // Assuming GetMemories returns { memory: string, redisKey: string }[]
                // We only need the text content for the prompt
                const memoryObjects = await RedisEmbeddingServiceV2.GetMemories(indexName);
                existingMemories = memoryObjects.map(m => m.memory);
                if (existingMemories.length > 0) {
                     logger.info({ count: existingMemories.length }, "Retrieved existing memories for context.");
                } else {
                     logger.info("No existing memories found for this channel.");
                }
            } catch (redisError: any) {
                // Log warning if index doesn't exist, error otherwise, but continue
                if (redisError.message && redisError.message.includes('no such index')) {
                    logger.warn({ index: `idx:${indexName}` }, "Memory index does not exist yet (when fetching existing memories).");
                } else {
                    logger.error({ err: redisError }, "Failed to retrieve existing memories from Redis. Proceeding without them.");
                }
                // Continue even if fetching fails, just won't have context
            }

            // Pass the generated script string AND existing memories to the summary generator
            const newOrUpdatedMemoryArray = await this._generateMemorySummary(conversationScript, existingMemories);

            // Process the NEW/UPDATED memories returned by the LLM
            if (newOrUpdatedMemoryArray && newOrUpdatedMemoryArray.length > 0) {
                logger.info({ newMemoryCount: newOrUpdatedMemoryArray.length }, 'Successfully extracted new/updated memories. Now embedding and storing...');

                let storedCount = 0, embeddingErrors = 0, storageErrors = 0;


                // 2. Embed and Store each NEW/UPDATED memory
                for (const memoryText of newOrUpdatedMemoryArray) {
                    if (!memoryText || memoryText.trim().length === 0) continue;
                    try {
                        const embedding = await ChatbotV2.createEmbedding(memoryText);
                        if (embedding) {
                            try {
                                // Use the static method directly
                                await RedisEmbeddingServiceV2.SetEmbeddingData(indexName, {
                                    text: memoryText, // Use the actual memory text as key data
                                    embedding: embedding
                                });
                                storedCount++;
                                logger.trace({ memoryText: memoryText.substring(0, 50) + "..." }, "Stored memory in Redis.");
                            } catch (storeError) {
                                storageErrors++;
                                logger.error({ err: storeError, memoryText: memoryText.substring(0, 50) + "..." }, "Failed to store memory vector in Redis.");
                            }
                        } else {
                             embeddingErrors++;
                             logger.warn({ memoryText: memoryText.substring(0, 50) + "..." }, "Failed to create embedding for memory, cannot store.");
                        }
                    } catch (embedError) {
                         embeddingErrors++;
                         logger.error({ err: embedError, memoryText: memoryText.substring(0, 50) + "..." }, "Error creating embedding for memory.");
                    }
                }
                logger.info({ storedCount, embeddingErrors, storageErrors }, 'Finished processing extracted memories for storage.');
                await DiscordClientV2.postMessage(`*Rivanna will remember this.* 🦋`, channelId);
            } else if (newOrUpdatedMemoryArray) { // Empty array is valid
                 logger.info('No significant memories were extracted from the conversation script.');
            }

        } catch (error) {
            logger.error({ err: error }, 'Error occurred during memory extraction process.');
        }
    }

    // NEW: Method for generating a goodbye message
    private async _generateGoodbyeMessage(messages: ChatCompletionMessageParam[], attempts: number = 0): Promise<string | null> {
         if (!this.openai) throw new Error('OpenAI client not initialized in ChatbotV2');
         if (!messages || messages.length === 0) {
              this.logger.info("No messages provided to generate goodbye message, skipping.");
              return null; // Cannot generate goodbye without context
         }
         const goodbyeMessages: ChatCompletionMessageParam[] = [
            { role: "system", content: `${this.systemPromptText} ${this.additionalSystemPromptText}`},
             ...messages, // Include the session history passed in,
             { role: "system", content: `${this.username} will be leaving the chat. Please say goodbye to them.` }
         ];

         const params: ChatCompletionCreateParams = {
            model: GENERATION_MODEL,
            messages: goodbyeMessages,
            temperature: 0.7,
            max_tokens: 100, // Keep farewells short
         };
         this.logger.debug({ attempt: attempts + 1, model: params.model, messageCount: goodbyeMessages.length }, `Requesting goodbye message generation from ${GENERATION_MODEL}`);
         try {
            this.logger.trace({ openAIParams: params }, `Making OpenAI API call to ${GENERATION_MODEL} for goodbye message`);
            const response = await this.openai.chat.completions.create(params);
            const content = response.choices[0]?.message?.content;
            if (content) {
                this.logger.info({ responseLength: content.length, model: GENERATION_MODEL }, `Generated goodbye message using ${GENERATION_MODEL}`);
                // Normalize response to remove potential "Rivanna: " prefix if added by model
                return this._normalizeAssistantResponse(content.trim(), this.username);
            } else {
                 this.logger.warn({ model: GENERATION_MODEL },'Goodbye message generation response content was null or empty.');
                 return null;
            }
         } catch (error) {
            this.logger.error({ err: error, attempt: attempts + 1, model: GENERATION_MODEL }, `Error during ${GENERATION_MODEL} goodbye message generation call`);
            if (attempts < 1) { // Only retry once for farewell
                await delay(300 * (attempts + 1));
                return await this._generateGoodbyeMessage(messages, attempts + 1);
            } else {
                this.logger.error(`Final attempt failed for ${GENERATION_MODEL} goodbye message generation`);
                return null; // Don't block ending the chat if goodbye fails
            }
         }
    }

    // NEW: Method for generating an "amnesia" message
    private async _generateForgetMessage(attempts: number = 0): Promise<string | null> {
         if (!this.openai) throw new Error('OpenAI client not initialized in ChatbotV2');

         const forgetMessages: ChatCompletionMessageParam[] = [
             { role: "system", content: this.systemPromptText },
             { role: "system", content: `You MUST act as if you have forgotten everything before this moment. Express confusion.` }
         ];

         const params: ChatCompletionCreateParams = {
            model: GENERATION_MODEL, // Or potentially a faster model like o4-mini if cost/speed is a factor
            messages: forgetMessages,
            temperature: 0.8, // Higher temperature for more varied expressions of confusion?
            max_tokens: 75, // Keep amnesia messages short
         };
         this.logger.debug({ attempt: attempts + 1, model: params.model, messageCount: forgetMessages.length }, `Requesting forget message generation from ${GENERATION_MODEL}`);
         try {
            this.logger.trace({ openAIParams: params }, `Making OpenAI API call to ${GENERATION_MODEL} for forget message`);
            const response = await this.openai.chat.completions.create(params);
            const content = response.choices[0]?.message?.content;
            if (content) {
                this.logger.info({ responseLength: content.length, model: GENERATION_MODEL }, `Generated forget message using ${GENERATION_MODEL}`);
                // Normalize response just in case
                return this._normalizeAssistantResponse(content.trim(), this.username);
            } else {
                 this.logger.warn({ model: GENERATION_MODEL },'Forget message generation response content was null or empty.');
                 return null;
            }
         } catch (error) {
            this.logger.error({ err: error, attempt: attempts + 1, model: GENERATION_MODEL }, `Error during ${GENERATION_MODEL} forget message generation call`);
            if (attempts < 1) { // Retry once
                await delay(300 * (attempts + 1));
                return await this._generateForgetMessage(attempts + 1); // Pass original messages again
            } else {
                this.logger.error(`Final attempt failed for ${GENERATION_MODEL} forget message generation`);
                return null; // Don't block if forget message fails
            }
         }
    }

    // NEW: Public static method to handle goodbye message generation and posting
    public static async generateAndPostGoodbye(channelId: string): Promise<void> {
        const bot = ChatbotV2.getInstance();
        const logger = bot.logger.child({ channelId, action: 'generateAndPostGoodbye' });
        logger.info("Attempting to generate and post goodbye message.");

        try {
            const historyInstance = bot.messageHistories.get(channelId);
            let goodbyeText: string | null = null;

            if (historyInstance) {
                 const startIndex = bot.activeSessionStartIndex.get(channelId) ?? 0;
                 const conversationHistory = historyInstance.getHistory();
                 const sessionMessages = conversationHistory.slice(startIndex);
                 logger.debug({ startIndex, sessionMessageCount: sessionMessages.length }, "Attempting to generate goodbye message based on session.");
                 // Call the private method to generate the message
                 goodbyeText = await bot._generateGoodbyeMessage(sessionMessages);
            } else {
                 logger.warn("Could not find history instance to generate goodbye message.");
            }

            if (goodbyeText) {
                 try {
                      logger.info("Posting generated goodbye message.");
                      // Use the Discord client utility to post the message
                      await DiscordClientV2.postMessage(goodbyeText, channelId);
                 } catch (postError) {
                      logger.error({ err: postError }, "Failed to post goodbye message.");
                 }
            } else {
                 logger.info("No goodbye message was generated.");
            }
        } catch (error) {
             logger.error({ err: error }, "Error during goodbye message generation/posting process.");
        }
    }

    // NEW: Public static method to handle forget message generation and posting
    public static async generateAndPostForgetMessage(channelId: string): Promise<void> {
        const bot = ChatbotV2.getInstance();
        const logger = bot.logger.child({ channelId, action: 'generateAndPostForgetMessage' });
        logger.info("Attempting to generate and post forget message.");

        try {
            let forgetText: string | null = null;
            forgetText = await bot._generateForgetMessage();
            if (forgetText) {
                 try {
                      logger.info("Posting generated forget message.");
                      await DiscordClientV2.postMessage(forgetText, channelId);
                 } catch (postError) {
                      logger.error({ err: postError }, "Failed to post forget message.");
                 }
            } else {
                 logger.info("No forget message was generated.");
            }
        } catch (error) {
             logger.error({ err: error }, "Error during forget message generation/posting process.");
        }
    }
} 