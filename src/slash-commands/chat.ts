import { ApplicationCommandType, Client, CommandInteraction, Message, TextChannel, ApplicationCommandOptionType } from "discord.js";

import { Command } from "./command";
// V2 Imports
import { ChatbotV2 } from "../chat-ai/chatbotV2";
import { DiscordClientV2 } from "../utils/discordClientV2";
import { LoggerV2 } from "../logger/loggerV2";

const CHAT_TIMER = 900000; // 15 minutes

// The message listener function
async function chatListenerV2(msg: Message<boolean>) {
    const logger = LoggerV2.getLogger().child({ channelId: msg.channelId, guildId: msg.guildId });
    
    // Check if chat is active for this channel and message is not from bot/command
    if (!msg.author.bot && ChatbotV2.getChatActiveState(msg.channelId) && !msg.content.startsWith("/")) {
        logger.debug({ author: msg.author.tag, content: msg.content.substring(0, 50) + '...' }, `Chat active, processing message.`);

        const imageUrls = msg.attachments
            .filter(att => att.contentType?.startsWith('image/'))
            .map(att => att.url);
        
        // Pass necessary info to the ChatbotV2 handler
        await ChatbotV2.handleIncomingDiscordMessage(msg.channelId, msg.id, msg.author.username, msg.content, imageUrls);
    } else {
        logger.trace({ author: msg.author.tag, isBot: msg.author.bot, isActive: ChatbotV2.getChatActiveState(msg.channelId), startsWithSlash: msg.content.startsWith("/") }, "Ignoring message.");
    }
};

// Helper function to end a chat session
async function endChatV2(client: Client, interaction: CommandInteraction) {
    const logger = LoggerV2.getLogger().child({
        component: 'ChatEndHelper',
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        interactionId: interaction.id
    });

    if (!ChatbotV2.getChatActiveState(interaction.channelId)) {
        logger.info(`Chat has already ended.`);
        await interaction.editReply({ content: "The chat session in this channel has already ended." }).catch(e => logger.error({err: e}, "Failed to edit reply for already ended chat."));
        return;
    }

    logger.info('Ending chat session.');

    try {
        // Indicate bot is leaving *after* attempting to send goodbye
        await interaction.editReply({ content: "*Rivanna prepares to leave*" });

    } catch (error) {
        logger.error({err: error}, "Error during chat ending sequence (goodbye call or reply edit).");
        // Attempt to notify user, ensure reply is edited
        try {
             await interaction.editReply({ content: "There was an issue ending the chat session cleanly." });
        } catch (replyError) {
             logger.error({err: replyError}, "Failed to edit reply for chat end error.");
        }
    } finally {
        // Always ensure state is cleaned up
        logger.debug('Clearing chat timer and setting state to inactive.');
        ChatbotV2.clearChatTimer(interaction.channelId);
        // Let setChatActiveState handle its own state map cleanup
        await ChatbotV2.setChatActiveState(interaction.channelId, false); 
    }
}

// --- Slash Commands ---

export const ChatStart: Command = {
    name: "start_chat",
    description: 'Start Chatting! Lasts 15 minutes of inactivity.',
    type: ApplicationCommandType.ChatInput,
    options: [
        {
            name: "message",
            description: "Optional first message to start the chat with.",
            type: ApplicationCommandOptionType.String,
            required: false
        }
    ],
    run: async (client: Client, interaction: CommandInteraction) => {
        const logger = LoggerV2.getLogger().child({ component: 'SlashCommand:ChatStart', channelId: interaction.channelId, interactionId: interaction.id });

        if (ChatbotV2.getChatActiveState(interaction.channelId)) {
            logger.warn('Attempted to start chat in an already active channel.');
            await interaction.editReply({ content: "There is already an active chat session in this channel." });
            return;
        }

        logger.info('Starting new chat session.');

        // WORKAROUND: Listener management (Consider moving to index.ts for persistent listener)
        client.removeListener('messageCreate', chatListenerV2); // Remove previous if any
        client.on(`messageCreate`, chatListenerV2); // Add listener

        ChatbotV2.setChatActiveState(interaction.channelId, true);
        ChatbotV2.refreshChatTimer(interaction.channelId); // Refresh starts the timer

        // Determine the initial message content
        let initialMessageText: string;
        let userMessage: string | null = null;
        // Type guard to safely access options
        if (interaction.isChatInputCommand()) {
             userMessage = interaction.options.getString("message"); // Get the optional message
             if (userMessage) {
                  initialMessageText = userMessage; // Use user's message if provided
                  logger.info({ userMessage }, 'User provided initial message with /start_chat command.');
             } else {
                  // Use default message if option not provided
                  initialMessageText = `${interaction.user.username} started the chat! Rivanna walks in and greets the room:`;
                  logger.info('No initial message provided, using default start message.');
             }
        } else {
             // Fallback for safety, though should not happen for ChatInput type
             initialMessageText = `${interaction.user.username} started the chat! Rivanna walks in and greets the room:`;
             logger.warn('Interaction was not ChatInputCommandInteraction, using default start message.');
        }

        // Send the determined initial message via Chatbot
        // Using interaction.id as a placeholder message ID, replace if a better ID source exists
        await ChatbotV2.handleIncomingDiscordMessage(
             interaction.channelId,
             interaction.id, // Placeholder Message ID
             interaction.user.username,
             initialMessageText // Use the determined text
        );

        // Update the deferred reply to confirm chat start
        if (userMessage) {
            await interaction.editReply({ content: `*Rivanna enters chat* (${interaction.user.username}: "${userMessage}")` });
        } else {
            await interaction.editReply({ content: `*Rivanna enters chat*` });
        }
    }
}

export const ChatEnd: Command = {
    name: "stop_chat",
    description: "Stop chatting with Rivanna.",
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
         const logger = LoggerV2.getLogger().child({ component: 'SlashCommand:ChatEnd', channelId: interaction.channelId, interactionId: interaction.id });
        if (!ChatbotV2.getChatActiveState(interaction.channelId)) {
             logger.warn('Attempted to stop chat in an inactive channel.');
            await interaction.editReply({ content: "There is no active chat session in this channel to end." });
            return;
        }
        logger.info('User requested to end chat.');
        await endChatV2(client, interaction); // Call the helper
    }
}