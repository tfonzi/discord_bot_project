import { ActionRowBuilder, ApplicationCommandOptionType, ApplicationCommandType, ButtonBuilder, ButtonStyle, Client, CommandInteraction, ComponentType } from "discord.js";

import { Command } from "./command";
import { Logger } from "../logger/logger";
import { DiscordClient } from "../utils/discordClient";
import { Memory, RedisEmbeddingService } from "../redis/RedisEmbeddingService";

export const ManageMemories: Command = {
    name: "manage-memories",
    description: "Publicly view or delete memories taught to Rivanna!",
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        const logger = Logger.getLogger();

        const leftBtn = new ButtonBuilder()
			.setCustomId('left')
			.setStyle(ButtonStyle.Secondary)
            .setEmoji("⬅️");

        const rightBtn = new ButtonBuilder()
			.setCustomId('right')
			.setStyle(ButtonStyle.Secondary)
            .setEmoji("➡️");

        const deleteBtn = new ButtonBuilder()
			.setCustomId('delete')
			.setLabel('Delete')
			.setStyle(ButtonStyle.Danger);

		const cancelBtn = new ButtonBuilder()
			.setCustomId('cancel')
			.setLabel('Cancel')
			.setStyle(ButtonStyle.Secondary);

		const row = new ActionRowBuilder()
			.addComponents(leftBtn, cancelBtn, deleteBtn, rightBtn);

        logger.debug("entered memory management interaction");
        const memories = await RedisEmbeddingService.GetMemories(interaction.guildId);
        logger.debug(`memories:  ${JSON.stringify(memories)}`);
        let index = 0;

        function generateContentText(index: number, memories: Memory[]): string {
            logger.debug(`generating contentText for index ${index}`);
            return `Select memory (${index+1}/${memories.length})\n\n${memories[index].memory}\n\n`;
        }

        const response = await interaction.followUp({
            content: generateContentText(index, memories),
            components: [row as ActionRowBuilder<ButtonBuilder>]
        });

        const collector = response.createMessageComponentCollector({componentType: ComponentType.Button, time: 3_600_000});

        collector.on(`collect`, async i => {
            if (i.customId === 'left') {
                if (index > 0) {
                    logger.debug("decreasing index");
                    index = index - 1;
                }
                await interaction.editReply({ content: generateContentText(index, memories)});
            } else if (i.customId === 'right') {
                if (index < memories.length - 1) {
                    logger.debug("increasing index");
                    index = index + 1;
                }
                await interaction.editReply({ content: generateContentText(index, memories)});
            } else if (i.customId === 'delete') {
                await interaction.editReply({content: "Operation successful. Thank you!", components: []});
                await RedisEmbeddingService.DeleteKey(memories[index].redisKey);
                await DiscordClient.postMessage(`"${memories[index].memory}"\n\nRivanna has forgotten this memory (via ${interaction.user.username}).`, interaction.channelId);
                collector.stop();
            } else if (i.customId === 'cancel') {
                await interaction.editReply({content: "Operation cancelled. Thank you!", components: []});
                collector.stop();
            }
            await i.update({});
        });
    }
};