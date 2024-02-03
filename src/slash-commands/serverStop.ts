import { ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";
import { Logger } from "../logger/logger";

export const ServerStop: Command = {
    name: "server-stop",
    description: "Stop server.",
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        const logger = Logger.getLogger();

        logger.debug("stopping server");
        const resp = await fetch('https://ri2pgnvtdk.execute-api.us-east-1.amazonaws.com/stop')    

        await interaction.followUp({
            ephemeral: false,
            content: (await resp.text())
        });
    }
};