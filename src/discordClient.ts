import { Client, ClientOptions } from "discord.js";

export interface DiscordClient {
    createClient(options: ClientOptions): Client<boolean>,
    deleteClient(): void,
    getClient(): Client<boolean>
}

export class DiscordClient implements DiscordClient {
    private static instance: Client

    public static createClient(options: ClientOptions): Client<boolean> {
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
}