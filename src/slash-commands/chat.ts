import { ApplicationCommandType, Client, CommandInteraction, Message } from "discord.js";

import { Command } from "./command";
import { Chatbot } from "../chat-ai/chat-bot";

async function chatListener(msg: Message<boolean>) {
    if(msg.author.username != Chatbot.getInstance().userName) {
        msg.reply(await Chatbot.getInstance().sendMessage(msg.guildId, `${msg.author.username}: ${msg.content}`));
    }
};

let endChatTimeout: NodeJS.Timeout | undefined = undefined;

async function endChat(client: Client, interaction: CommandInteraction) {
    if (endChatTimeout) {
        clearTimeout(endChatTimeout);
    }
    client.off(`messageCreate`, chatListener);
    await interaction.followUp({
        ephemeral: false,
        content: `${await Chatbot.getInstance().sendMessage(interaction.guildId, `Rivanna has to leave and says:`)}\n*Rivanna leaves chat*`
    });
}

export const ChatStart: Command = {
    name: "start_chat",
    description: 'Start Chatting with Rivanna! Lasts 15 minutes.',
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        client.on(`messageCreate`, chatListener);
        endChatTimeout = setTimeout(async () => { endChat(client, interaction); }, 900000); //end chat after 15 minutes, aka 900000
        await interaction.followUp({
            ephemeral: false,
            content: `*Rivanna enters chat*\n${await Chatbot.getInstance().sendMessage(interaction.guildId, `Rivanna walks in and she says:`)}`
        });
    }
}

export const ChatEnd: Command = {
    name: "stop_chat",
    description: "Stop chatting with Rivanna.",
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        endChat(client, interaction);
    }
}