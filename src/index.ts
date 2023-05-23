import { ClientOptions, Client, GatewayIntentBits} from "discord.js";
import * as dotenv from "dotenv";

import ready from "./listeners/ready";
import interactionCreate from "./listeners/interactionCreate";
import { Chatbot } from "./chat-ai/chat-bot";

interface discordBotEnv {
    discordBotToken: string;
    openAiToken: string;
}

const clientOptions: ClientOptions = {intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]};
const client = new Client(clientOptions);
dotenv.config();

try {
    if(!process.env.BOT_ENV) {
        throw Error("No bot env");
    }
    const tokens: discordBotEnv = JSON.parse(process.env.BOT_ENV);
    if(tokens.discordBotToken) {
        console.log(`Found env var for bot token ${tokens.discordBotToken.substring(0,5)}...`);
    } else {
        throw Error("No discord token in env");
    }
    if(tokens.openAiToken) {
        console.log(`Found env var for openai token ${tokens.openAiToken.substring(0,5)}...`);
    } else {
        throw Error("No openai token in env");
    }

    console.log(`Creating chatbot with ${tokens.openAiToken.substring(0,5)}...`);
    Chatbot.setKey(tokens.openAiToken);
    Chatbot.setContext(process.env.CONTEXT);

    // registering listeners
    ready(client);
    interactionCreate(client);

    console.log(`About to log in with ${tokens.discordBotToken.substring(0,5)}...`);
    client.login(tokens.discordBotToken);
}
catch(err) {
    //crash hangs-- allows me to enter docker container
    let ms = 2000;
    console.error(err);
    while (true) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
}

 