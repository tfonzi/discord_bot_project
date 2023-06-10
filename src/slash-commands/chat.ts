import { ApplicationCommandType, Client, CommandInteraction, Message, TextChannel } from "discord.js";

import { Command } from "./command";
import { Chatbot } from "../chat-ai/chat-bot";
import { DiscordClient } from "../discordClient";
import { Logger } from "../logger/logger";

const CHAT_TIMER = 900000; //end chat after 15 minutes, aka 900000

async function chatListener(msg: Message<boolean>) { 
    if(msg.author.username != Chatbot.getInstance().userName && Chatbot.getInstance().getChatActiveState(msg.guildId, msg.channelId)) {
        if (msg.content.at(0) == "/") {
            return; //ignore if it starts with a slash
        }
        const logger = Logger.getLogger();
        logger.debug(`Chat in ${msg.guildId}-${msg.channelId} is active. Sending message.`)
        await Chatbot.getInstance().sendMessage(msg.guildId, msg.channelId, `${msg.author.username}: ${msg.content}`);
    }
};

async function endChat(client: Client, interaction: CommandInteraction) {
    const logger = Logger.getLogger();

    if (!Chatbot.getInstance().getChatActiveState(interaction.guildId, interaction.channelId)) {
        logger.debug(`Chat in ${interaction.guildId}-${interaction.channelId} has already ended.`)
        return;
    }
    Chatbot.getInstance().clearChatTimer(interaction.guildId, interaction.channelId)
    logger.debug(JSON.stringify(Chatbot.getInstance().getHistory(interaction.guildId, interaction.channelId), null, 2));
    await interaction.followUp({ content: "*Rivanna readies herself*" });
    await Chatbot.getInstance().sendMessage(interaction.guildId, interaction.channelId, `Rivanna has to leave and says:`);
    (DiscordClient.getClient().channels.cache.get(interaction.channelId) as TextChannel).send("*Rivanna leaves chat*");
    Chatbot.getInstance().setChatActiveState(interaction.guildId, interaction.channelId, false);
    if (!Chatbot.getInstance().isActive()) {
        logger.debug("No more open chats-- shutting off listener");
        client.off(`messageCreate`, chatListener);
    }
}

export const ChatStart: Command = {
    name: "start_chat",
    description: 'Start Chatting with Rivanna! Lasts 15 minutes.',
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        const logger = Logger.getLogger();
        if (Chatbot.getInstance().getChatActiveState(interaction.guildId, interaction.channelId)) {
            await interaction.followUp({
                ephemeral: false,
                content: "There is already an active Rivanna chat in this channel."
            });
            return;
        }
        if (!Chatbot.getInstance().isActive()) {
            logger.debug("First open chat-- turning on listener");
            client.on(`messageCreate`, chatListener);
        }
        Chatbot.getInstance().setChatActiveState(interaction.guildId, interaction.channelId, true);
        Chatbot.getInstance().setChatTimer(interaction.guildId, interaction.channelId, setTimeout(async () => { endChat(client, interaction); }, CHAT_TIMER));
        await interaction.followUp({
            ephemeral: false,
            content: `*Rivanna enters chat*`
        });
        await Chatbot.getInstance().sendMessage(interaction.guildId, interaction.channelId, `Rivanna walks in and she says:`);
    }
}

export const ChatEnd: Command = {
    name: "stop_chat",
    description: "Stop chatting with Rivanna.",
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        if (!Chatbot.getInstance().getChatActiveState(interaction.guildId, interaction.channelId)) {
            await interaction.followUp({
                ephemeral: false,
                content: "There is no active Rivanna chat in this channel to end."
            });
            return;
        }
        endChat(client, interaction);
    }
}