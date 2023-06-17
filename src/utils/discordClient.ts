import { Client, ClientOptions, TextChannel } from "discord.js";
import { Logger } from "../logger/logger";
import { delay } from "./utils";

export interface DiscordClient {
    createClient(options: ClientOptions): Client<boolean>,
    deleteClient(): void,
    getClient(): Client<boolean>,
    sendTyping(channelId: string, attempts?: number): Promise<void>,
    getGuildId(channelId: string, attempts?: number): string,
    postMessage(message: string, channelId: string, attempts?: number): Promise<void>
}

export class DiscordClient implements DiscordClient {
    private static instance: Client

    public static createClient(options: ClientOptions, attempts: number = 0): Client<boolean> {
        DiscordClient.instance = new Client(options);
        return DiscordClient.instance;
    }

    public static deleteClient(): void {
        if (!DiscordClient.instance) {
            throw new Error("There is no client defined to erase");
        }
        DiscordClient.instance.destroy();
        DiscordClient.instance = undefined;
    }

    public static getClient(): Client<boolean> {
        if (!DiscordClient.instance) {
            throw new Error("Must create client prior to get");
        }
        return DiscordClient.instance
    }

    public static async sendTyping(channelId: string, attempts: number = 0): Promise<void> {
        if (!DiscordClient.instance) {
            throw new Error("Must create client prior to send typing");
        }
        const logger = Logger.getLogger();
        try {
            await (DiscordClient.getClient().channels.cache.get(channelId) as TextChannel).sendTyping();
            return;
        } catch (err) {
            logger.error(err);
            if (attempts < 3) { // 3 attempts
                await delay(100);
                await DiscordClient.sendTyping(channelId, attempts + 1);
                return;
            } else {
                throw err;
            }
        }
    }

    public static getGuildId(channelId: string, attempts: number = 0): string {
        if (!DiscordClient.instance) {
            throw new Error("Must create client prior to fetching guildID");
        }
        const logger = Logger.getLogger();
        try {
            return (DiscordClient.getClient().channels.cache.get(channelId) as TextChannel).guildId;
        } catch (err) {
            logger.error(err);
            if (attempts < 3) { // 3 attempts
                return DiscordClient.getGuildId(channelId, attempts + 1);
            } else {
                throw err;
            }
        }
    }

    public static async postMessage(message: string, channelId: string, attempts: number = 0): Promise<void> {
        if (!DiscordClient.instance) {
            throw new Error("Must create client prior to posting message");
        }
        const logger = Logger.getLogger();
        try {
            await (DiscordClient.getClient().channels.cache.get(channelId) as TextChannel).send(message);
            return;
        } catch (err) {
            logger.error(err);
            if (attempts < 3) { // 3 attempts
                await delay(100);
                await DiscordClient.postMessage(message, channelId, attempts + 1);
                return;
            } else {
                throw err;
            }
        }
    }
}