import { ClientOptions, Client, GatewayIntentBits, Interaction, CommandInteraction} from "discord.js";
import * as dotenv from "dotenv";

import { Commands } from "./commands";

interface botToken {
    discordBotToken: string;
}

const clientOptions: ClientOptions = {intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]};
const client = new Client(clientOptions);
dotenv.config();

client.on(`ready`, async () => {
    await client.application.commands.set(Commands);
    console.log(`Logged in as ${client.user.tag}!`);
});

client.on(`messageCreate`, async (msg) => {
    if(msg.author.username != client.user.username) {
        //console.log(`Saw message (${JSON.stringify(msg)})`);
        if (msg.mentions.has(client.user) && (msg.content.toLowerCase().includes("hi") || msg.content.toLowerCase().includes("hello")))
        msg.reply(`Hi ${msg.author.username}!`);
    }
});

const handleSlashCommand = async (client: Client, interaction: CommandInteraction): Promise<void> => {
    const slashCommand = Commands.find(c => c.name === interaction.commandName);
    if (!slashCommand) {
        interaction.followUp({ content: "An error has occurred" });
        return;
    }
    await interaction.deferReply();
    slashCommand.run(client, interaction);
};

client.on("interactionCreate", async (interaction: Interaction) => {
    if (interaction.isCommand() || interaction.isContextMenuCommand()) {
        await handleSlashCommand(client, interaction);
    }
})

try {
    const token: botToken = JSON.parse(process.env.BOT_TOKEN);
    console.log(`About to log in with ${token.discordBotToken.substring(0,5)}...`);
    client.login(token.discordBotToken);
}
catch(err) {
    console.error(err);
}

 