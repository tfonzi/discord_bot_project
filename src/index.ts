import { ClientOptions, Client, GatewayIntentBits, Interaction, CommandInteraction} from "discord.js";
import * as dotenv from "dotenv";

import { Commands } from "./commands";
import { Chatbot } from "./chat-ai/chat-bot";

interface botToken {
    discordBotToken: string;
}

interface openAIToken {
    openAiToken: string;
}

const clientOptions: ClientOptions = {intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]};
const client = new Client(clientOptions);
let chatBot: Chatbot;
dotenv.config();

client.on(`ready`, async () => {
    await client.application.commands.set(Commands);
    console.log(`Logged in as ${client.user.tag}!`);
});

client.on(`messageCreate`, async (msg) => {
    if(msg.author.username != client.user.username) {
        if (msg.mentions.has(client.user))
        msg.reply(await chatBot.sendMessage(msg.guildId, (msg.content as string)));
    }
});

const handleSlashCommand = async (client: Client, interaction: CommandInteraction): Promise<void> => {
    const slashCommand = Commands.find(c => c.name === interaction.commandName);
    if (!slashCommand) {
        interaction.followUp({ content: "An error has occurred" });
        return;
    }
    await interaction.deferReply();
    try {
        slashCommand.run(client, interaction);
    } catch(err) {
        console.error(err);
        interaction.followUp({ content: "An error has occurred" });
    }
    
};

client.on("interactionCreate", async (interaction: Interaction) => {
    if (interaction.isCommand() || interaction.isContextMenuCommand()) {
        await handleSlashCommand(client, interaction);
    }
})

try {
    const discordToken: botToken = JSON.parse(process.env.BOT_TOKEN);
    const openAIToken: openAIToken = JSON.parse(process.env.OPEN_AI_TOKEN);

    console.log(`Creating chatbot with ${openAIToken.openAiToken.substring(0,5)}...`);
    chatBot = new Chatbot(openAIToken.openAiToken, "You're name is @DemoBot, and you are a sassy human friend who likes to have conversation and has feelings.")

    console.log(`About to log in with ${discordToken.discordBotToken.substring(0,5)}...`);
    client.login(discordToken.discordBotToken);
}
catch(err) {
    console.error(err);
}

 