import { ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";
import { Chatbot } from "../chat-ai/chat-bot";
import { Logger } from "../logger/logger";
import { DiscordClient } from "../utils/discordClient";


export const ResetConversation: Command = {
    name: "reset-conversation",
    description: "Reset conversation with Rivanna.",
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        const logger = Logger.getLogger();

        logger.debug("clearing conversation");
        Chatbot.getInstance().resetHistory(interaction.guildId, interaction.channelId)

        await interaction.followUp({
            ephemeral: false,
            content: "Rivanna's recent conversation has been cleared!"
        });
        if (Chatbot.getInstance().getChatActiveState(interaction.guildId, interaction.channelId)) {
            DiscordClient.sendTyping(interaction.channelId);
            Chatbot.getInstance().sendMessage(interaction.guildId, interaction.channelId, "Rivanna's recent memory has been wiped! Dazed and confused, Rivanna says:")
        }
    }
};