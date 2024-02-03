import { ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";
import { Logger } from "../logger/logger";

export const ServerStatus: Command = {
    name: "server-status",
    description: "Get status of the server.",
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        const logger = Logger.getLogger();

        logger.debug("getting server status");
        const resp = await fetch('https://ri2pgnvtdk.execute-api.us-east-1.amazonaws.com/status')    

        await interaction.followUp({
            ephemeral: false,
            content: (await resp.text())
        });
    }
};