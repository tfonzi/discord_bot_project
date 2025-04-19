import { Client, Interaction, CommandInteraction } from "discord.js";

import { Commands } from "./../slash-commands/index";
// V2 Imports
import { LoggerV2 } from "../logger/loggerV2";

const handleSlashCommand = async (client: Client, interaction: CommandInteraction): Promise<void> => {
    // Create a child logger with interaction context
    const baseLogger = LoggerV2.getLogger();
    const logger = baseLogger.child({
        component: 'InteractionHandler', 
        interactionId: interaction.id, 
        channelId: interaction.channelId, 
        guildId: interaction.guildId, 
        commandName: interaction.commandName,
        user: interaction.user.tag
    });

    try {
        const slashCommand = Commands.find(c => c.name === interaction.commandName);
        if (!slashCommand) {
            logger.error("Slash command definition not found.");
            // Use editReply as we deferred
            await interaction.editReply({ content: "Command not found or error occurred." });
            return;
        }
        
        // Defer reply - moved up before finding command to ensure timely response to Discord
        const isEphemeral = interaction.commandName === "manage-memories"; // Example check
        logger.debug({ ephemeral: isEphemeral }, "Deferring reply.");
        await interaction.deferReply({ ephemeral: isEphemeral });

        logger.info("Executing slash command.");
        if (interaction.options.data.length > 0) {
            // Convert options data to a more readable format if possible
            const optionsSummary = interaction.options.data.map(opt => `${opt.name}: ${opt.value ?? '[Subcommand/Group]'}`).join(', ');
            logger.debug({ options: interaction.options.data, summary: optionsSummary }, "Command options provided.");
        }

        // Run the command
        await slashCommand.run(client, interaction); // Assuming run is async
        // No need to followUp here if the command itself uses interaction.editReply

    } catch (err) {
        logger.error({ err }, "Error executing slash command.");
        try {
            // Attempt to inform the user via editReply if possible
            if (!interaction.replied && !interaction.deferred) {
                 // If not deferred or replied, try replying directly (less likely)
                 await interaction.reply({ content: "An error occurred while executing the command.", ephemeral: true });
            } else {
                 // If deferred or already replied, edit the reply
                await interaction.editReply({ content: "An error occurred while executing the command." });
            }
        } catch (replyError) {
            logger.error({ err: replyError }, "Failed to send error message to user after command execution failed.");
        }
    }
};

export default (client: Client): void => {
    client.on("interactionCreate", async (interaction: Interaction) => {
        // Get base logger for initial check
        const logger = LoggerV2.getLogger();
        try {
            if (interaction.isCommand() || interaction.isContextMenuCommand()) {
                logger.trace({ interactionId: interaction.id, type: interaction.type }, "Handling command interaction.");
                await handleSlashCommand(client, interaction as CommandInteraction);
            } else {
                // Handle other interaction types if necessary (buttons, modals, etc.)
                logger.trace({ interactionId: interaction.id, type: interaction.type }, "Ignoring non-command interaction in this handler.");
            }
        } catch (err) {
            logger.error({ err, interactionId: interaction.id }, "Unhandled error during interactionCreate event.");
        }
    });
}