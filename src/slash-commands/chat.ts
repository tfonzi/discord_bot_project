import { ApplicationCommandType, Client, CommandInteraction, Message, TextChannel } from "discord.js";

import { Command } from "./command";
// V2 Imports
import { ChatbotV2 } from "../chat-ai/chatbotV2";
import { DiscordClientV2 } from "../utils/discordClientV2";
import { LoggerV2 } from "../logger/loggerV2";

const CHAT_TIMER = 900000; // 15 minutes

// The message listener function
async function chatListenerV2(msg: Message<boolean>) {
    const logger = LoggerV2.getLogger().child({ channelId: msg.channelId, guildId: msg.guildId });
    // Check if the message is from the bot itself (using initialized username)
    // TODO: Consider checking against client.user.id for more robustness
    // const botUser = DiscordClientV2.getClient()?.user;
    // if (botUser && msg.author.id === botUser.id) return;
    
    // Check if chat is active for this channel and message is not from bot/command
    if (!msg.author.bot && ChatbotV2.getChatActiveState(msg.channelId) && !msg.content.startsWith("/")) {
        logger.debug({ author: msg.author.tag, content: msg.content.substring(0, 50) + '...' }, `Chat active, processing message.`);

        const imageUrls = msg.attachments
            .filter(att => att.contentType?.startsWith('image/'))
            .map(att => att.url);
        
        // Pass necessary info to the ChatbotV2 handler
        await ChatbotV2.handleIncomingDiscordMessage(msg.channelId, msg.author.id, msg.content, imageUrls);
    } else {
        // Optional: Log ignored messages
        // logger.trace({ author: msg.author.tag, isBot: msg.author.bot, isActive: ChatbotV2.getChatActiveState(msg.channelId), startsWithSlash: msg.content.startsWith("/") }, "Ignoring message.");
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
        // Edit reply to inform user, as interaction was likely deferred
        await interaction.editReply({ content: "The chat session in this channel has already ended." }).catch(e => logger.error({err: e}, "Failed to edit reply for already ended chat."));
        return;
    }

    try {
        logger.info('Ending chat session.');
        // Indicate bot is leaving (response might be slightly delayed)
        await interaction.editReply({ content: "*Rivanna prepares to leave...*" });
        
        // Send final message via ChatbotV2 (this might be simplified later)
        // Instead of sending a message *through* the bot, just post directly.
        // await ChatbotV2.handleIncomingDiscordMessage(interaction.channelId, client.user.id, "Rivanna has to leave and says goodbye!"); // This seems overly complex
        
        await DiscordClientV2.postMessage("*Rivanna leaves chat*", interaction.channelId);
        
    } catch (error) {
        logger.error({err: error}, "Error during chat ending sequence.");
        // Attempt to notify user even if cleanup fails partially
        await interaction.editReply({ content: "There was an issue ending the chat session cleanly." }).catch(e => logger.error({err: e}, "Failed to edit reply for chat end error."));
    } finally {
        // Always ensure state is cleaned up
        logger.debug('Clearing chat timer and setting state to inactive.');
        ChatbotV2.clearChatTimer(interaction.channelId)
        ChatbotV2.setChatActiveState(interaction.channelId, false);
        
        // Check if any chats remain active globally
        // TODO: ChatbotV2 needs an isActive() method or similar global check
        // const anyActive = ChatbotV2.isAnyChatActive(); // Hypothetical method
        // For now, assume we might need to turn off the listener if no other active chats
        // This logic remains fragile without a proper global check
        // if (!anyActive) {
        //     logger.info("No more active chats detected globally. Attempting to remove messageCreate listener.");
        //     client.off(`messageCreate`, chatListenerV2);
        // } 
    }
}

// --- Slash Commands ---

export const ChatStart: Command = {
    name: "start_chat",
    description: 'Start Chatting! Lasts 15 minutes of inactivity.',
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        const logger = LoggerV2.getLogger().child({ component: 'SlashCommand:ChatStart', channelId: interaction.channelId, interactionId: interaction.id });
        
        if (ChatbotV2.getChatActiveState(interaction.channelId)) {
            logger.warn('Attempted to start chat in an already active channel.');
            await interaction.editReply({ content: "There is already an active chat session in this channel." });
            return;
        }

        logger.info('Starting new chat session.');
        
        // Check if this is the first active chat - remains complex without global state check
        // const needsListener = !ChatbotV2.isAnyChatActive(); // Hypothetical
        // if (needsListener) {
        //     logger.info("Attaching messageCreate listener as this seems to be the first active chat.");
        //     client.on(`messageCreate`, chatListenerV2);
        // } 
        // WORKAROUND: Assume listener should always be on for now if not using global state properly
        // Ensure listener is attached (might attach multiple times if not careful)
        // A better approach is a persistent listener in index.ts
        client.removeListener('messageCreate', chatListenerV2); // Remove previous if any
        client.on(`messageCreate`, chatListenerV2); // Add listener

        ChatbotV2.setChatActiveState(interaction.channelId, true);
        ChatbotV2.refreshChatTimer(interaction.channelId); // Refresh starts the timer
        
        await interaction.editReply({ content: `*Rivanna enters chat*` });
        
        // Send initial greeting via Chatbot
        // TODO: Pass user ID who initiated?
        await ChatbotV2.handleIncomingDiscordMessage(interaction.channelId, client.user.id, "<@{interaction.user.id}> started the chat! Rivanna walks in and greets the room:");
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