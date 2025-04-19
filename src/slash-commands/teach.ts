import { ApplicationCommandOptionType, ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";
// V2 Imports
import { RedisEmbeddingServiceV2 } from "../redis/RedisEmbeddingServiceV2";
import { ChatbotV2 } from "../chat-ai/chatbotV2";
import { LoggerV2 } from "../logger/loggerV2";

// Consider refining this list or the check logic
const subjectPronouns = ["I ", "We", "My", "we", "my", "i ", "You", "you"];

export const Teach: Command = {
    name: "teach",
    description: "Publicly teach the bot something to remember!",
    type: ApplicationCommandType.ChatInput,
    options: [{
            name: "memory",
            description: `Works best if it is about a single subject. Avoid pronouns like 'I' or 'You'.`,
            type: ApplicationCommandOptionType.String,
            required: true
        }],
    run: async (_client: Client, interaction: CommandInteraction) => {
        const logger = LoggerV2.getLogger().child({ 
            component: 'SlashCommand:Teach', 
            interactionId: interaction.id, 
            channelId: interaction.channelId, 
            guildId: interaction.guildId,
            user: interaction.user.tag
        });

        const memory: string = (interaction.options.get("memory")!.value! as string).trim();
        const indexName = interaction.guildId; // Using guildId as index name, as per original logic

        if (!indexName) {
            logger.error('Missing guildId, cannot determine memory index.');
            await interaction.editReply({ content: "Sorry, I can't store memories outside of a server channel." });
            return;
        }

        logger.info({ memory, indexName }, 'Processing teach command.');

        // Check for subjective pronouns (basic check)
        if (subjectPronouns.some(substring => memory.startsWith(substring))){
             logger.warn('Memory starts with a subjective pronoun, prompting user for clarification.');
             await interaction.editReply({
                 // ephemeral: false, // FollowUp is not ephemeral by default unless deferred ephemerally
                 content: `"${memory}"\n\n${interaction.user.username}, please try to use specific names instead of pronouns like "I" or "You" at the start of the memory. Adjust your phrasing and I'll have a better time remembering!`
             });
        } else {
            try {
                logger.debug('Ensuring Redis index exists...');
                await RedisEmbeddingServiceV2.CreateIndexForEmbedding(indexName); 
                
                logger.debug('Creating embedding for memory...');
                const embedding = await ChatbotV2.createEmbedding(memory);

                if (!embedding) {
                    logger.error('Failed to create embedding for the memory.');
                    await interaction.editReply({ content: "Sorry, I had trouble processing that memory. Please try again later." });
                    return;
                }
                
                logger.debug('Setting embedding data in Redis...');
                await RedisEmbeddingServiceV2.SetEmbeddingData(indexName, { text: memory, embedding });
                
                const commandResponse = `"${memory}"\n\nThank you, ${interaction.user.username}. I'll try to remember this.`;
                logger.info('Successfully taught memory.');
                await interaction.editReply({ content: commandResponse });

            } catch (error) {
                 logger.error({ err: error }, 'Error during teach command processing (Redis/Embedding).');
                 await interaction.editReply({ content: "Something went wrong while trying to learn that. Please try again." });
            }
        }
    }
};