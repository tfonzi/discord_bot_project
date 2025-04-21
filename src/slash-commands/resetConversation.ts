import { ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";
// V2 Imports
import { ChatbotV2 } from "../chat-ai/chatbotV2";
import { LoggerV2 } from "../logger/loggerV2";
import { DiscordClientV2 } from "../utils/discordClientV2";


export const ResetConversation: Command = {
    name: "reset-conversation",
    description: "Reset conversation with the bot.",
    type: ApplicationCommandType.ChatInput,
    run: async (_client: Client, interaction: CommandInteraction) => {
        const logger = LoggerV2.getLogger().child({ 
            component: 'SlashCommand:ResetConversation', 
            interactionId: interaction.id, 
            channelId: interaction.channelId, 
            guildId: interaction.guildId,
            user: interaction.user.tag
        });
        const channelId = interaction.channelId;

        logger.info("Resetting conversation history for channel.");
        // Use channelId for ChatbotV2 methods
        ChatbotV2.resetHistory(channelId);

        // Edit the deferred reply
        await interaction.editReply({
            content: "The bot's recent conversation history in this channel has been cleared!"
        });
        
        // Check if chat was active before reset and send a message if so
        if (ChatbotV2.getChatActiveState(channelId)) {
            logger.info('Chat was active, sending reset message.');
            // Use DiscordClientV2.startTyping/stopTyping and ChatbotV2 handler
            try {
                // Send message through the chatbot handler to ensure it's added to the (now empty) history
                await ChatbotV2.handleIncomingDiscordMessage(channelId, _client.user.id, "My recent memory has just been wiped! Dazed and confused, I say:");
            } catch (error) {
                logger.error({ err: error }, "Failed to send reset confirmation message via Chatbot.");
            }
        } else {
             logger.info('Chat was not active, no reset message sent.');
        }
    }
};