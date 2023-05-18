
import { ApplicationCommandOptionType, ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";

export const Roll: Command = {
    name: "roll",
    description: "Roll a dnd dice!",
    type: ApplicationCommandType.ChatInput,
    options: [{
                name: "rolls",
                description: `Input dice roll using format "1d3 2d4 3d20..."`,
                type: ApplicationCommandOptionType.String
            }],
    run: async (_client: Client, interaction: CommandInteraction) => {
        await interaction.followUp({
            ephemeral: true,
            content: rollDice(interaction.options.get("rolls").value as string)
        });
    }

}

function isCountingNumber(x: string) {
    const num = parseInt(x);
    return !isNaN(num) && num > 0;
}

function rollDice(diceCommand: string): string {
    try {
        const diceRolls: string[] = diceCommand.split(" ");
        let response: string = `You gave me ${diceCommand}!\n`;
        const sum = diceRolls.reduce((sum: number, currentRoll: string) => {
            let params: string[] = [];
            params = currentRoll.split("d");
            if (params.length != 2 || !isCountingNumber(params[0]) || !isCountingNumber(params[1])) {
                throw Error(`Invalid roll: ${currentRoll}. Please enter in format as shown in examples: '2d6', '3d4', '1d20'`)
            }
            let add = 0;
            response = response.concat(`\nRolled ${currentRoll}!`);
            for (let i = 0; i < parseInt(params[0]); i++) {
                const result = Math.floor(Math.random() * parseInt(params[1])) + 1;
                add += result;
                response = response.concat(`\nGot ${result}!`);
            }
            response = response.concat("\n");
            return sum + add;
        }, 0);
        response = response.concat(`\nSum of Rolls: ${sum}`);
        return response;
    }
    catch(err) {
        return (err as Error).message;
    }
}