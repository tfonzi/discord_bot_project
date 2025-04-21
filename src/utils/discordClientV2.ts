import { Client, ClientOptions, TextChannel, Message, AttachmentBuilder, GuildEmoji } from "discord.js";
import { LoggerV2 } from "../logger/loggerV2";
import { Logger as PinoLogger, Bindings } from 'pino';
import { delay } from "./utils";

export class DiscordClientV2 {
    private static instance: Client<boolean>;

    // Map to store child loggers per channel
    private static channelLoggers: Map<string, PinoLogger> = new Map();

    // Private constructor to prevent external instantiation
    private constructor() { }

    // Unified helper to get/create Discord-specific child logger
    private static _getDiscordLogger(channelId?: string): PinoLogger {
        const baseBindings = { component: 'Discord' };
        let finalBindings: Bindings;
        let loggerKey: string;

        if (channelId) {
            // Channel-specific logger
            finalBindings = { ...baseBindings, channelId };
            loggerKey = `discord-${channelId}`;
        } else {
            // Base Discord logger
            finalBindings = { ...baseBindings };
            loggerKey = 'discord-base';
        }

        if (DiscordClientV2.channelLoggers.has(loggerKey)) {
            return DiscordClientV2.channelLoggers.get(loggerKey)!;
        }

        const baseLogger = LoggerV2.getLogger();
        const childLogger = baseLogger.child(finalBindings);
        DiscordClientV2.channelLoggers.set(loggerKey, childLogger);
        childLogger.trace({ bindings: finalBindings }, 'Created Discord child logger');
        return childLogger;
    }

    /**
     * Creates and initializes the singleton Discord client instance.
     * @param options The client options.
     * @returns The created Client instance.
     */
    public static createClient(options: ClientOptions): Client<boolean> {
        const logger = DiscordClientV2._getDiscordLogger(); // Use base Discord logger (no channelId)
        if (DiscordClientV2.instance) {
            throw new Error("DiscordClientV2 instance already created. Use getClient() instead.");
        }
        DiscordClientV2.instance = new Client(options);
        logger.info("DiscordClientV2 singleton instance created.");
        return DiscordClientV2.instance;
    }

    /**
     * Gets the singleton Discord client instance.
     * Throws error if the client hasn't been created yet.
     * @returns The Client instance.
     */
    public static getClient(): Client<boolean> {
        if (!DiscordClientV2.instance) {
            throw new Error("DiscordClientV2 instance not created. Call createClient() first.");
        }
        return DiscordClientV2.instance;
    }

     /**
     * Logs in the client using the provided token.
     * Requires createClient to have been called.
     * @param token The Discord bot token.
     * @returns A promise that resolves when login is successful.
     */
    public static login(token: string): Promise<string> {
         const logger = DiscordClientV2._getDiscordLogger(); // Use base Discord logger (no channelId)
         if (!DiscordClientV2.instance) {
             throw new Error("Client must be created before logging in.");
         }
         logger.info(`DiscordClientV2 logging in with token ${token.substring(0,5)}...`);
         return DiscordClientV2.instance.login(token);
    }

    /**
     * Destroys the Discord client connection and cleans up resources.
     */
    public static destroyClient(): void {
        const logger = DiscordClientV2._getDiscordLogger(); // Use base Discord logger (no channelId)
        if (!DiscordClientV2.instance) {
            logger.info("No DiscordClientV2 instance to destroy.");
            return;
        }
        logger.info("Destroying DiscordClientV2 singleton instance.");
        DiscordClientV2.instance.destroy();
        DiscordClientV2.instance = undefined;
        // Clear channel loggers
        DiscordClientV2.channelLoggers.clear();
    }


    /**
     * Retrieves the Guild ID for a given Channel ID.
     * Includes retry logic.
     * @param channelId The ID of the channel.
     * @param attempts The current attempt number (internal use for recursion).
     * @returns The Guild ID string.
     * @throws Error if the client is not ready or after multiple failed attempts.
     */
    public static getGuildId(channelId: string, attempts: number = 0): string {
        const logger = DiscordClientV2._getDiscordLogger(channelId); // Pass channelId
        const client = DiscordClientV2.getClient(); // Throws if not created
        if (!client.isReady()) {
            throw new Error("Client is not ready yet for getGuildId.");
        }
        try {
            const channel = client.channels.cache.get(channelId);
            if (channel instanceof TextChannel) {
                return channel.guildId;
            } else {
                throw new Error(`Channel ${channelId} is not a TextChannel or not found.`);
            }
        } catch (err) {
            logger.error({ attempt: attempts + 1, err }, `Failed attempt for getGuildId`);
            if (attempts < 2) { // Retry up to 3 times total
                // No delay needed for synchronous retry
                return DiscordClientV2.getGuildId(channelId, attempts + 1);
            } else {
                logger.error(`Final attempt failed for getGuildId`);
                throw err;
            }
        }
    }

    /**
     * Posts a text message to a specific channel.
     * Includes retry logic with delay.
     * @param message The text message content.
     * @param channelId The ID of the target channel.
     * @param attempts The current attempt number (internal use for recursion).
     * @returns A promise that resolves when the message is sent.
     * @throws Error if the client is not ready or after multiple failed attempts.
     */
    public static async postMessage(message: string, channelId: string, attempts: number = 0): Promise<void> {
        const logger = DiscordClientV2._getDiscordLogger(channelId); // Pass channelId
        const client = DiscordClientV2.getClient(); // Throws if not created
        if (!client.isReady()) {
            throw new Error("Client is not ready yet for postMessage.");
        }
        try {
            const channel = client.channels.cache.get(channelId);
            if (channel instanceof TextChannel) {
                await channel.send(message);
                logger.debug(`Message posted`);
                return;
            } else {
                throw new Error(`Channel ${channelId} is not a TextChannel or not found for postMessage.`);
            }
        } catch (err) {
            logger.error({ attempt: attempts + 1, err }, `Failed attempt for postMessage`);
            if (attempts < 2) { // Retry up to 3 times total
                await delay(100 * (attempts + 1)); // Exponential backoff delay
                await DiscordClientV2.postMessage(message, channelId, attempts + 1);
                return;
            } else {
                 logger.error(`Final attempt failed for postMessage`);
                throw err;
            }
        }
    }

     /**
     * Posts an image using an AttachmentBuilder to a specific channel.
     * Includes retry logic with delay.
     * @param attachment The AttachmentBuilder instance containing the image data.
     * @param channelId The ID of the target channel.
     * @param attempts The current attempt number (internal use for recursion).
     * @returns A promise that resolves when the image is sent.
     * @throws Error if the client is not ready or after multiple failed attempts.
     */
    public static async postImage(attachment: AttachmentBuilder, channelId: string, attempts: number = 0): Promise<void> {
        const logger = DiscordClientV2._getDiscordLogger(channelId); // Pass channelId
        const client = DiscordClientV2.getClient(); // Throws if not created
        if (!client.isReady()) {
            throw new Error("Client is not ready yet for postImage.");
        }

        try {
            const channel = client.channels.cache.get(channelId);
            if (channel instanceof TextChannel) {
                await channel.send({ files: [attachment] });
                 logger.debug(`Attachment posted`);
                return;
            } else {
                throw new Error(`Channel ${channelId} is not a TextChannel or not found for postImage.`);
            }
        } catch (err) {
            logger.error({ attempt: attempts + 1, err }, `Failed attempt for postImage`);
            if (attempts < 2) { // Retry up to 3 times total
                await delay(100 * (attempts + 1)); // Exponential backoff delay
                await DiscordClientV2.postImage(attachment, channelId, attempts + 1);
                return;
            } else {
                 logger.error(`Final attempt failed for postImage`);
                throw err;
            }
        }
    }

    /**
     * Adds a reaction to a specific message in a channel.
     * Includes retry logic with delay.
     * @param emoji The emoji to react with (can be unicode or custom emoji ID).
     * @param messageId The ID of the message to react to.
     * @param channelId The ID of the channel containing the message.
     * @param attempts The current attempt number (internal use for recursion).
     * @returns A promise that resolves when the reaction is added.
     * @throws Error if the client is not ready or after multiple failed attempts.
     */
    public static async addReaction(emoji: string, messageId: string, channelId: string, attempts: number = 0): Promise<void> {
        const logger = DiscordClientV2._getDiscordLogger(channelId); // Pass channelId
        const client = DiscordClientV2.getClient(); // Throws if not created
         if (!client.isReady()) {
            throw new Error("Client is not ready yet for addReaction.");
        }
        try {
            const channel = client.channels.cache.get(channelId);
            if (channel instanceof TextChannel) {
                const message = await channel.messages.fetch(messageId);
                await message.react(emoji);
                logger.debug({ emoji, messageId }, `Reaction added`);
                return;
            } else {
                 throw new Error(`Channel ${channelId} is not a TextChannel or not found for addReaction.`);
            }
        } catch (err) {
            logger.error({ attempt: attempts + 1, emoji, messageId, err }, `Failed attempt for addReaction`);
             if (attempts < 2) { // Retry up to 3 times total
                await delay(100 * (attempts + 1)); // Exponential backoff delay
                await DiscordClientV2.addReaction(emoji, messageId, channelId, attempts + 1);
                return;
            } else {
                logger.error({ emoji, messageId }, `Final attempt failed for addReaction`);
                throw err;
            }
        }
    }

    /**
     * Sends a single typing indicator to the specified channel.
     * Does not loop or manage state.
     * @param channelId The ID of the channel to send the typing indicator to.
     */
    public static async startTyping(channelId: string): Promise<void> {
        const logger = DiscordClientV2._getDiscordLogger(channelId);
        try {
            const client = DiscordClientV2.getClient();
            if (!client.isReady()) {
                logger.warn('Client not ready, cannot send typing indicator.');
                return;
            }
            const channel = client.channels.cache.get(channelId);
            if (channel instanceof TextChannel) {
                await channel.sendTyping();
                logger.trace('Sent single typing indicator.');
            } else {
                logger.warn(`Channel ${channelId} not found or not a TextChannel for sending typing.`);
            }
        } catch (error) {
            logger.error({ err: error }, 'Error sending single typing indicator.');
        }
    }


} 