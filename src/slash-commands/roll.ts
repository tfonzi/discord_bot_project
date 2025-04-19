import { ApplicationCommandOptionType, ApplicationCommandType, Client, CommandInteraction } from "discord.js";

import { Command } from "./command";
// V2 Imports
import { LoggerV2 } from "../logger/loggerV2";

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
        // Create child logger for this specific interaction
        const logger = LoggerV2.getLogger().child({
            component: 'SlashCommand:Roll',
            interactionId: interaction.id,
            channelId: interaction.channelId,
            guildId: interaction.guildId,
            user: interaction.user.tag
        });
        logger.debug('Roll command invoked');

        let diceCommand = "";
        const options = interaction.options;

        // Build dice string from options
        if (options.get("d20")) diceCommand += ` ${options.get("d20")!.value}d20`;
        if (options.get("d12")) diceCommand += ` ${options.get("d12")!.value}d12`;
        if (options.get("d10")) diceCommand += ` ${options.get("d10")!.value}d10`;
        if (options.get("d8")) diceCommand += ` ${options.get("d8")!.value}d8`;
        if (options.get("d6")) diceCommand += ` ${options.get("d6")!.value}d6`;
        if (options.get("manual_input")) diceCommand += ` ${options.get("manual_input")!.value}`; // Add manual input

        diceCommand = diceCommand.trim(); // Trim leading/trailing whitespace

        if (!diceCommand) {
            logger.warn('Roll command used with no dice specified.');
            await interaction.editReply({ content: "Please specify which dice to roll! Use the options or `manual_input`." });
            return;
        }

        let shift: number | undefined;
        if (options.get("add_to_roll")) {
           shift = options.get("add_to_roll")!.value as number;
        }
        logger.debug({ diceCommand, shift }, 'Processing dice command');

        const commandResponse = processDiceCommand(diceCommand, shift);
        logger.info({ response: commandResponse }, 'Sending dice roll result');
        
        // Use editReply since we deferred in interactionCreate
        await interaction.editReply({ content: commandResponse });
    }
};

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