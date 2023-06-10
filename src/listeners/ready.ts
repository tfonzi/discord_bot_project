import { Client } from "discord.js";

import { Commands } from "./../slash-commands";
import { Chatbot } from "../chat-ai/chat-bot";
import { Logger } from "../logger/logger";

export default (client: Client): void => {
    client.on(`ready`, async () => {
        const logger = Logger.getLogger();
        Chatbot.setUserName(client.user.username)
        await client.application.commands.set(Commands);
        logger.debug(`Starting the client with these slash commands: ${JSON.stringify(Commands, null, 2)}`);
        logger.log(`Logged in as ${client.user.tag}!`);
    });
}