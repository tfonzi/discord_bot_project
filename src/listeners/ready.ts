import { Client } from "discord.js";

import { Commands } from "./../slash-commands/index";
// V2 Imports
import { ChatbotV2 } from "../chat-ai/chatbotV2"; 
import { LoggerV2 } from "../logger/loggerV2";

export default (client: Client): void => {
    client.on(`ready`, async () => {
        // Get logger using V2
        const logger = LoggerV2.getLogger();
        // Username is set during ChatbotV2.initialize in index.ts
        // ChatbotV2.setUserName(client.user.username) // Remove this
        
        logger.info("Registering application slash commands...");
        try {
            await client.application.commands.set(Commands);
             // Log command names for easier debugging
             const commandNames = Commands.map(cmd => cmd.name);
             logger.info({ commands: commandNames }, `Successfully registered ${commandNames.length} slash commands globally.`);
        } catch (error) {
            logger.error({ err: error }, "Failed to register application slash commands.");
            // Depending on the error, you might want to exit or retry
        }

        logger.info(`Logged in as ${client.user.tag}! Bot is ready.`);
    });
}