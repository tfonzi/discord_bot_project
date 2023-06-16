import { Client, Interaction, CommandInteraction} from "discord.js";

import { Commands } from "./../slash-commands";
import { Logger } from "../logger/logger";

const handleSlashCommand = async (client: Client, interaction: CommandInteraction): Promise<void> => {
    const logger = Logger.getLogger();
    try {
        const slashCommand = Commands.find(c => c.name === interaction.commandName);
        if (!slashCommand) {
            interaction.followUp({ content: "An error has occurred" });
            return;
        }
        await interaction.deferReply();
        
        logger.log(`[channel-${interaction.channelId}] Received a command: ${interaction.commandName}`);
        if (interaction.command.options){
            logger.debug(`[channel-${interaction.channelId}] Command options were: ${JSON.stringify(interaction.options, null, 2)}`)
        }
        slashCommand.run(client, interaction);
    } catch(err) {
        logger.error(err);
        interaction.followUp({ content: "An error has occurred" });
    }
};

export default (client: Client): void => {
    client.on("interactionCreate", async (interaction: Interaction) => {
        const logger = Logger.getLogger();
        try {
            if (interaction.isCommand() || interaction.isContextMenuCommand()) {
                await handleSlashCommand(client, interaction);
            }
        } catch (err) {
            logger.debug(`A major error occured: ${err}`);
        }
    })
}