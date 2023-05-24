import { ApplicationCommandType, Client, CommandInteraction, Message, TextChannel } from "discord.js";

import { Command } from "./command";
import { Chatbot } from "../chat-ai/chat-bot";

const CHAT_TIMER = 900000; //end chat after 15 minutes, aka 900000

async function chatListener(msg: Message<boolean>) {
    if(msg.author.username != Chatbot.getInstance().userName && Chatbot.getInstance().getChatActiveState(msg.guildId, msg.channelId)) {
        console.log(`Chat in ${msg.guildId}-${msg.channelId} is active. Sending message.`)
        const chatResult = await Chatbot.getInstance().sendMessage(msg.guildId, msg.channelId, `${msg.author.username}: ${msg.content}`)
        if (chatResult) {
            (await msg.client.channels.cache.get(msg.channelId) as TextChannel).send(chatResult)
        }
    }
};

async function endChat(client: Client, interaction: CommandInteraction) {
    if (!Chatbot.getInstance().getChatActiveState(interaction.guildId, interaction.channelId)) {
        console.log(`Chat in ${interaction.guildId}-${interaction.channelId} has already ended.`)
        return;
    }
    Chatbot.getInstance().clearChatTimer(interaction.guildId, interaction.channelId)
    console.log(JSON.stringify(Chatbot.getInstance().getHistory(interaction.guildId, interaction.channelId)));
    const chatResult = await Chatbot.getInstance().sendMessage(interaction.guildId, interaction.channelId, `Rivanna has to leave and says:`);
    if (chatResult) {
        await interaction.followUp({
            ephemeral: false,
            content: `${chatResult}\n*Rivanna leaves chat*`
        });
    }
    Chatbot.getInstance().setChatActiveState(interaction.guildId, interaction.channelId, false);
    if (!Chatbot.getInstance().isActive()) {
        console.log("No more open chats-- shutting off listener");
        client.off(`messageCreate`, chatListener);
    }
}

export const ChatStart: Command = {
    name: "start_chat",
    description: 'Start Chatting with Rivanna! Lasts 15 minutes.',
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        if (Chatbot.getInstance().getChatActiveState(interaction.guildId, interaction.channelId)) {
            await interaction.followUp({
                ephemeral: false,
                content: "There is already an active Rivanna chat in this channel."
            });
            return;
        }
        if (!Chatbot.getInstance().isActive()) {
            console.log("First open chat-- turning on listener");
            client.on(`messageCreate`, chatListener);
        }
        Chatbot.getInstance().setChatActiveState(interaction.guildId, interaction.channelId, true);
        Chatbot.getInstance().setChatTimer(interaction.guildId, interaction.channelId, setTimeout(async () => { endChat(client, interaction); }, CHAT_TIMER));
        const chatResult = await Chatbot.getInstance().sendMessage(interaction.guildId, interaction.channelId, `Rivanna walks in and she says:`);
        if (chatResult) {
            await interaction.followUp({
                ephemeral: false,
                content: `*Rivanna enters chat*\n${chatResult}`
            });
        }
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