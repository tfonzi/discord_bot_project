import { ActionRowBuilder, ApplicationCommandOptionType, ApplicationCommandType, ButtonBuilder, ButtonStyle, Client, CommandInteraction, ComponentType } from "discord.js";

import { Command } from "../command";
import { Logger } from "../../logger/logger";
import { DiscordClient } from "../../utils/discordClient";
import { Memory, RedisEmbeddingService } from "../../redis/RedisEmbeddingService";
import { ButtonId, ConfirmDeleteWidget, CreateListWidget, NavigationWidget } from "./UI/NavigationWidget";

export const ManageMemories: Command = {
    name: "manage-memories",
    description: "View or publicly delete memories taught to Rivanna!",
    type: ApplicationCommandType.ChatInput,
    run: async (client: Client, interaction: CommandInteraction) => {
        const logger = Logger.getLogger();

        logger.debug("entered memory management interaction");
        let memories = await RedisEmbeddingService.GetMemories(interaction.guildId);
        logger.debug(`memories:  ${JSON.stringify(memories)}`);
        let index = 0;

        function generateContentText(index: number, memories: Memory[]): string {
            logger.debug(`generating contentText for index ${index}`);
            return `Select memory (${index+1}/${memories.length}):\n\n"${memories[index].memory}"\n\n`;
        }

        const response = await interaction.followUp({
            content: generateContentText(index, memories),
            components: NavigationWidget
        });

        const collector = response.createMessageComponentCollector({componentType: ComponentType.Button, time: 3_600_000});

        const pagination = 10;
        let page = 0;

        collector.on(`collect`, async i => {
            let iNumber = -1;
            try {
                iNumber = parseInt(i.customId);
            } catch {}
            if (i.customId === ButtonId.Left) {
                if (index > 0) {
                    index = index - 1;
                } else {
                    index = memories.length - 1
                }
                await interaction.editReply({ content: generateContentText(index, memories)});
            } else if (i.customId === ButtonId.Right) {
                if (index < memories.length - 1) {
                    index = index + 1;
                } else {
                    index = 0;
                }
                await interaction.editReply({ content: generateContentText(index, memories)});
            } else if (i.customId === ButtonId.Delete) {
                await interaction.editReply({content: `Are you sure you want to erase this memory?\n\n "${memories[index].memory}"`, components: ConfirmDeleteWidget});
            } else if (i.customId === ButtonId.ConfirmDelete) {
                await RedisEmbeddingService.DeleteKey(memories[index].redisKey);
                // refresh memories
                await DiscordClient.postMessage(`Rivanna has forgotten this memory (via ${interaction.user.username}):\n"${memories[index].memory}"`, interaction.channelId);
                memories = await RedisEmbeddingService.GetMemories(interaction.guildId);
                await interaction.editReply({ content: generateContentText(0, memories), components: NavigationWidget});
            } else if (i.customId === ButtonId.DenyDelete) {
                await interaction.editReply({ content: generateContentText(index, memories), components: NavigationWidget});
            } else if (i.customId === ButtonId.Cancel) {
                await interaction.editReply({content: "Operation cancelled. Thank you!", components: []});
                collector.stop();
            } else if (i.customId === ButtonId.List) {
                await interaction.editReply(CreateListWidget(memories, page, pagination));
            } else if (i.customId === ButtonId.ListCancel) {
                await interaction.editReply({ content: generateContentText(index, memories), components: NavigationWidget});
            } else if (i.customId === ButtonId.ListLeft) {
                if (page > 0) { 
                    page = page - 1;
                } else {
                    page = Math.floor(memories.length/pagination)
                }
                let endBound = (page*pagination) + pagination;
                if (endBound > memories.length) {
                    endBound = memories.length;
                }
                await interaction.editReply(CreateListWidget(memories, page, pagination));
            } else if (i.customId === ButtonId.ListRight) {
                if (page < Math.floor(memories.length/pagination)) { 
                    page = page + 1;
                } else {
                    page = 0
                }
                let endBound = (page*pagination) + pagination;
                if (endBound > memories.length) {
                    endBound = memories.length;
                }
                await interaction.editReply(CreateListWidget(memories, page, pagination));
            } else if (iNumber >= 0 || iNumber <= 10) {
                index = (pagination * page) + iNumber - 1;
                await interaction.editReply({ content: generateContentText(index, memories), components: NavigationWidget});
            }
            await i.update({});
        });
    }
};