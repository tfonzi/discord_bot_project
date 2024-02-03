import { ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";
import { Logger } from "../logger/logger";

export const ServerStart: Command = {
    name: "server-start",
    description: "Start server.",
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        const logger = Logger.getLogger();

        logger.debug("starting server");
        const resp = await fetch('https://ri2pgnvtdk.execute-api.us-east-1.amazonaws.com/start')    

        await interaction.followUp({
            ephemeral: false,
            content: (await resp.text())
        });
    }
};