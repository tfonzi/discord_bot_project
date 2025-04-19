import { ActionRowBuilder, ApplicationCommandType, ButtonBuilder, ButtonStyle, Client, CommandInteraction, ComponentType } from "discord.js";

import { Command } from "../command";
// V2 Imports
import { LoggerV2 } from "../../logger/loggerV2";
import { DiscordClientV2 } from "../../utils/discordClientV2";
import { Memory, RedisEmbeddingServiceV2 } from "../../redis/RedisEmbeddingServiceV2";
import { ButtonId, ConfirmDeleteWidget, CreateListWidget, NavigationWidget } from "./UI/NavigationWidget";

export const ManageMemories: Command = {
    name: "manage-memories",
    description: "View or publicly delete memories taught to the bot!",
    type: ApplicationCommandType.ChatInput,
    run: async (_client: Client, interaction: CommandInteraction) => {
        const logger = LoggerV2.getLogger().child({ 
            component: 'SlashCommand:ManageMemories', 
            interactionId: interaction.id, 
            channelId: interaction.channelId, 
            guildId: interaction.guildId, 
            user: interaction.user.tag
        });

        logger.info("Memory management command started.");
        const indexName = interaction.guildId;

        if (!indexName) {
            logger.error('Missing guildId, cannot manage memories.');
            await interaction.editReply({ content: "Sorry, memories can only be managed within a server channel." });
            return;
        }

        let memories = await RedisEmbeddingServiceV2.GetMemories(indexName);
        logger.debug({ memoryCount: memories.length }, `Initial memories fetched.`);
        
        if (memories.length === 0) {
            logger.info('No memories found for this guild.');
            await interaction.editReply({
                content: "There are no memories currently! Please create one with the /teach command."
            });
            return;
        }
        
        let index = 0; // Current memory index being viewed

        // Helper to generate the message content for the current memory
        function generateContentText(currentIndex: number, memoryList: Memory[]): string {
            if (currentIndex < 0 || currentIndex >= memoryList.length) {
                 logger.warn({ currentIndex, memoryCount: memoryList.length }, "generateContentText called with invalid index, defaulting to 0.");
                 currentIndex = 0; // Default to first item if index is invalid
            }
            logger.trace({ currentIndex, total: memoryList.length }, "Generating content text for memory view.");
            return `Select memory (${currentIndex + 1}/${memoryList.length}):\n\n"${memoryList[currentIndex]?.memory ?? '(Error: Memory not found)'}"\n\n`;
        }

        // Initial reply with the first memory and navigation buttons
        const response = await interaction.editReply({
            content: generateContentText(index, memories),
            components: NavigationWidget
        });

        // Button collector setup
        const collector = response.createMessageComponentCollector({ componentType: ComponentType.Button, time: 3_600_000 }); // 1 hour timeout

        let page = 0; // For list view pagination
        const pagination = 10;

        collector.on(`collect`, async i => {
             // Create a logger for this specific button interaction
             const buttonLogger = logger.child({ buttonInteractionId: i.id, customId: i.customId });
             buttonLogger.debug("Button interaction collected.");

            try {
                let iNumber = -1;
                try { iNumber = parseInt(i.customId); } catch { /* Ignore parsing errors */ }

                let needsUpdate = true; // Flag to check if interaction.editReply is needed
                let replyOptions: { content: string, components?: any[] } = { content: '', components: NavigationWidget };

                switch (i.customId) {
                    case ButtonId.Left:
                        index = (index > 0) ? index - 1 : memories.length - 1;
                        replyOptions.content = generateContentText(index, memories);
                        break;
                    case ButtonId.Right:
                        index = (index < memories.length - 1) ? index + 1 : 0;
                        replyOptions.content = generateContentText(index, memories);
                        break;
                    case ButtonId.Delete:
                        replyOptions.content = `Are you sure you want to erase this memory?\n\n "${memories[index]?.memory ?? '(Error: Memory Missing)'}"`;
                        replyOptions.components = ConfirmDeleteWidget;
                        break;
                    case ButtonId.ConfirmDelete:
                        const memoryToDelete = memories[index];
                        if (!memoryToDelete) {
                             buttonLogger.error({ currentIndex: index }, "Attempted to confirm delete on invalid index.");
                             replyOptions.content = "Error: Could not find the memory to delete.";
                             replyOptions.components = NavigationWidget; // Go back to nav
                             break;
                        }
                        buttonLogger.info({ key: memoryToDelete.redisKey }, "Confirming memory deletion.");
                        await RedisEmbeddingServiceV2.DeleteKey(memoryToDelete.redisKey);
                        await DiscordClientV2.postMessage(`I have forgotten this memory (requested by ${i.user.username}):\n"${memoryToDelete.memory}"`, interaction.channelId);
                        
                        // Refresh memories and reset view
                        memories = await RedisEmbeddingServiceV2.GetMemories(indexName);
                        buttonLogger.info({ newCount: memories.length }, "Memories refreshed after deletion.");
                        index = 0;
                        page = 0;
                        if (memories.length === 0) {
                            replyOptions.content = "All memories have been deleted!";
                            replyOptions.components = [];
                            collector.stop(); // Stop collector if no memories left
                        } else {
                            replyOptions.content = generateContentText(index, memories);
                            replyOptions.components = NavigationWidget;
                        }
                        break;
                    case ButtonId.DenyDelete:
                        replyOptions.content = generateContentText(index, memories);
                        replyOptions.components = NavigationWidget;
                        break;
                    case ButtonId.Cancel:
                        buttonLogger.info('User cancelled memory management.');
                        replyOptions.content = "Operation cancelled.";
                        replyOptions.components = [];
                        needsUpdate = false; // Stop collector immediately after edit
                        await i.update(replyOptions); // Update immediately before stopping
                        collector.stop();
                        return; // Exit collector handler
                    case ButtonId.List:
                        replyOptions = CreateListWidget(memories, page, pagination);
                        break;
                    case ButtonId.ListCancel:
                        replyOptions.content = generateContentText(index, memories);
                        replyOptions.components = NavigationWidget;
                        break;
                    case ButtonId.ListLeft:
                        page = (page > 0) ? page - 1 : Math.max(0, Math.floor((memories.length - 1) / pagination));
                        replyOptions = CreateListWidget(memories, page, pagination);
                        break;
                    case ButtonId.ListRight:
                         page = (page < Math.floor((memories.length - 1) / pagination)) ? page + 1 : 0;
                         replyOptions = CreateListWidget(memories, page, pagination);
                         break;
                    default:
                        // Handle number buttons for list selection
                        if (iNumber >= 1 && iNumber <= pagination) { 
                            const selectedIndex = (pagination * page) + iNumber - 1;
                            if (selectedIndex < memories.length) {
                                index = selectedIndex;
                                replyOptions.content = generateContentText(index, memories);
                                replyOptions.components = NavigationWidget;
                            } else {
                                 buttonLogger.warn({ selectedIndex, page, iNumber }, 'List selection index out of bounds');
                                 needsUpdate = false; // Don't update if selection was invalid
                            }
                        } else {
                             buttonLogger.warn('Unhandled button customId');
                             needsUpdate = false; // Don't update for unknown buttons
                        }
                        break;
                }

                if (needsUpdate) {
                    await i.update(replyOptions);
                }

            } catch (error) {
                 buttonLogger.error({ err: error }, "Error processing button interaction.");
                 // Attempt to update interaction to inform user of error
                 try {
                     await i.update({ content: "An error occurred while processing that action.", components: [] });
                 } catch (updateError) {
                      buttonLogger.error({ err: updateError }, "Failed to update interaction after button processing error.");
                 }
            }
        });

        collector.on('end', collected => {
            logger.info({ collectedCount: collected.size }, 'Memory management interaction collector ended.');
            // Optionally disable components on timeout
            interaction.editReply({ components: [] }).catch(e => logger.warn({ err: e }, "Failed to clear components on collector end."));
        });
    }
};