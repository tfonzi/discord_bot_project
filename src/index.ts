import { GatewayIntentBits} from "discord.js";
import * as dotenv from "dotenv";

import ready from "./listeners/ready";
import interactionCreate from "./listeners/interactionCreate";
import { Chatbot } from "./chat-ai/chat-bot";
import { DiscordClient } from "./discordClient";
import { RedisEmbeddingService } from "./redis/RedisEmbeddingService";

dotenv.config();

try {
    
    if(process.env.DISCORD_TOKEN) {
        console.log(`Found env var for bot token ${process.env.DISCORD_TOKEN.substring(0,5)}...`);
    } else {
        throw Error("No discord token in env");
    }
    if(process.env.OPENAI_TOKEN) {
        console.log(`Found env var for openai token ${process.env.OPENAI_TOKEN.substring(0,5)}...`);
    } else {
        throw Error("No openai token in env");
    }

    if(!process.env.REDIS_PASSWORD) {
        throw Error("No redis password stored in env");
    }
    console.log(`Found env var for redisPassword ${process.env.REDIS_PASSWORD.substring(0,2)}...`);

    RedisEmbeddingService.CreateClient(process.env.REDIS_PASSWORD).catch(
        (err) => {
            throw err;
        }
    );

    // Setting up DiscordClient
    const client = DiscordClient.createClient({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]
    });

    // Setting up Chatbot
    console.log(`Creating chatbot with ${process.env.OPENAI_TOKEN.substring(0,5)}...`);
    Chatbot.setKey(process.env.OPENAI_TOKEN);
    Chatbot.setContext(process.env.CONTEXT);

    // registering listeners
    ready(client);
    interactionCreate(client);

    console.log(`About to log in with ${process.env.DISCORD_TOKEN.substring(0,5)}...`);
    client.login(process.env.DISCORD_TOKEN);
}
catch(err) {
    //crash hangs-- allows me to enter docker container
    let ms = 2000;
    console.error(err);
    while (true) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
}

 