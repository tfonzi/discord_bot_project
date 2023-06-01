import { ApplicationCommandOptionType, ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";

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
     
        // store in redis
        await interaction.followUp({
            ephemeral: false,
            content: `"${memory}"\n\nThank you. I will remember this.`
        });
    }
};