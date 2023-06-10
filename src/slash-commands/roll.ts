
import { ApplicationCommandOptionType, ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";
import { Logger } from "../logger/logger";

export const Roll: Command = {
    name: "roll",
    description: "Roll a dnd dice!",
    type: ApplicationCommandType.ChatInput,
    options: [{
        name: "d20",
        description: `Roll 'x' many D20 dice!"`,
        type: ApplicationCommandOptionType.Number,
        min_value: 1,
        max_value: 99
    },
    {
        name: "d12",
        description: `Roll 'x' many D12 dice!"`,
        type: ApplicationCommandOptionType.Number,
        min_value: 1,
        max_value: 99
    },
    {
        name: "d10",
        description: `Roll 'x' many D10 dice!"`,
        type: ApplicationCommandOptionType.Number,
        min_value: 1,
        max_value: 99
    },
    {
        name: "d8",
        description: `Roll 'x' many D8 dice!"`,
        type: ApplicationCommandOptionType.Number,
        min_value: 1,
        max_value: 99
    },
    {
        name: "d6",
        description: `Roll 'x' many D6 dice!"`,
        type: ApplicationCommandOptionType.Number,
        min_value: 1,
        max_value: 99
    },
    {
        name: "d4",
        description: `Roll 'x' many D4 dice!"`,
        type: ApplicationCommandOptionType.Number,
        min_value: 1,
        max_value: 99
    },
    {
        name: "manual_input",
        description: `Input dice roll using format "1d3 2d4 3d20..."`,
        type: ApplicationCommandOptionType.String
    },
    {
        name: "add_to_roll",
        description: `Add (or subtract using negative) a value to the sum of your dice roll."`,
        type: ApplicationCommandOptionType.Integer
    }],
    run: async (_client: Client, interaction: CommandInteraction) => {
        const logger = Logger.getLogger();
        let diceCommand = "";
        if (interaction.options.get("d20")) {
            diceCommand += ` ${interaction.options.get("d20").value}d20`
        }
        if (interaction.options.get("d12")) {
            diceCommand += ` ${interaction.options.get("d12").value}d12`
        }
        if (interaction.options.get("d10")) {
            diceCommand += ` ${interaction.options.get("d10").value}d10`
        }
        if (interaction.options.get("d8")) {
            diceCommand += ` ${interaction.options.get("d8").value}d8`
        }
        if (interaction.options.get("d6")) {
            diceCommand += ` ${interaction.options.get("d6").value}d6`
        }
        if (interaction.options.get("manual_input")) {
            diceCommand += ` ${interaction.options.get("manual_input").value}`
        }
        diceCommand = diceCommand.substring(1); //removing leading whitespace

        let shift: number| undefined;
        if (interaction.options.get("add_to_roll")) {
           shift = (interaction.options.get("add_to_roll").value as number);
        }

        const commandResponse = processDiceCommand(diceCommand, shift);
        logger.log(`[channel-${interaction.channelId}] Answered command with: ${commandResponse}`);
        await interaction.followUp({
            ephemeral: true,
            content: commandResponse
        });
    }

}

function isCountingNumber(x: string) {
    const num = parseInt(x);
    return !isNaN(num) && num > 0;
}

function processDiceCommand(diceCommand: string, shift: number | undefined): string {
    try {
        const diceRolls: string[] = diceCommand.split(" ");
        if (diceRolls.length > 30) {
            throw Error(`Bad roll: ${diceCommand}. \n\nPlease keep dice roll complexity under 30.`)
        }
        let response: string = `You gave me ${diceCommand}!\n`;

        function rollDice(number: number, die: number): number {
            let sum = 0;
            let rollSummary = "";
            rollSummary = rollSummary.concat(`\nRolled ${number}d${die}!`);
            for (let i = 0; i < number; i++) {
                const result = Math.floor(Math.random() * die) + 1;
                sum += result;
                rollSummary = rollSummary.concat(`\nGot ${result}!`);
            }
            response = response.concat(`${rollSummary}\n`);
            return sum;
        }

        let rollTuples: [number, number][] = diceRolls.map(roll => {
            let params: string[] = [];
            params = roll.split("d");
            if (params.length != 2 || !isCountingNumber(params[0]) || !isCountingNumber(params[1])) {
                throw Error(`Bad roll: ${roll}. \n\nPlease enter in format as shown in examples: '2d6', '3d4', '1d20'`)
            }
            return [parseInt(params[0]), parseInt(params[1])];
        });

        const totalRolls = rollTuples.reduce((total: number, rollTuple: [number, number]) => { return total + rollTuple[0]; }, 0);
        if (totalRolls > 100) {
            throw Error(`Bad roll: ${diceCommand}. \n\nPlease keep total number of dice rolls under 100.`)
        }

        const sum = rollTuples.reduce((sum: number, rollTuple: [number, number]) => { return sum + rollDice(rollTuple[0], rollTuple[1]); }, 0);
        response = response.concat(`\nSum of Rolls: ${sum}`);
        if (shift) {
            response = response.concat(`\n\nAdding ${shift} to rolls.\nNew Sum of Rolls: ${sum + shift}`);
        }
        return response;
    }
    catch(err) {
        return (err as Error).message;
    }
}