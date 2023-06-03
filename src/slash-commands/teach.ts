import { ApplicationCommandOptionType, ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";
import { RedisEmbeddingService } from "../redis/RedisEmbeddingService";
import { Chatbot } from "../chat-ai/chat-bot";

const subjectPronouns = ["I ", "We", "My", "we", "my", "i "];

export const Teach: Command = {
    name: "teach",
    description: "Publicly teach Rivanna something to remember!",
    type: ApplicationCommandType.ChatInput,
    options: [{
            name: "memory",
            description: `Works best if it is about a single subject.`,
            type: ApplicationCommandOptionType.String,
            required: true
        }],
    run: async (client: Client, interaction: CommandInteraction) => {
        let memory: string = (interaction.options.get("memory").value! as string);
        // if start of memory includes specific pronouns, prompt user to be more specific
        if (subjectPronouns.some(substring=>memory.substring(0,3).includes(substring))){
            await interaction.followUp({
                ephemeral: false,
                content: `"${memory}"\n\n${interaction.user.username}, Please try to use names instead of pronouns like "I" or "My". Adjust your phrasing and I'll have a better time remembering!`
            });
        } else {
            RedisEmbeddingService.CreateIndexForEmbedding(`${interaction.guildId}`); // no-op if index has already been created
            RedisEmbeddingService.SetEmbeddingData(`${interaction.guildId}`, { text: memory, embedding: (await Chatbot.getInstance().createEmbedding(memory))});
            await interaction.followUp({
                ephemeral: false,
                content: `"${memory}"\n\nThank you, ${interaction.user.username}. I will remember this.`
            });
        }
        
    }
};