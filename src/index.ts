import { GatewayIntentBits} from "discord.js";
import * as dotenv from "dotenv";

import ready from "./listeners/ready";
import interactionCreate from "./listeners/interactionCreate";
import { Chatbot } from "./chat-ai/chat-bot";
import { DiscordClient } from "./utils/discordClient";
import { RedisEmbeddingService } from "./redis/RedisEmbeddingService";
import { Logger, isLogLevel } from "./logger/logger";

dotenv.config();

//Setting up Logger
let logger: Logger | undefined = undefined;
if(process.env.LOG_LEVEL && isLogLevel(process.env.LOG_LEVEL)) {
    logger = Logger.createLogger(process.env.LOG_LEVEL);
    if (process.env.LOG_LEVEL === "DEBUG") {
        logger.debug("Logger initialized as DEBUG level")
    }
} else {
    logger = Logger.createLogger("INFO");
    logger.error(new Error('No log level specified in process env. Defaulting to LOG level'))
}
 
try {
    logger.log("Starting up Discord Bot!");
    if(process.env.DISCORD_TOKEN) {
        logger.debug(`Found env var for bot token ${process.env.DISCORD_TOKEN.substring(0,5)}...`);
    } else {
        throw Error("No discord token in env");
    }
    if(process.env.OPENAI_TOKEN) {
        logger.debug(`Found env var for openai token ${process.env.OPENAI_TOKEN.substring(0,5)}...`);
    } else {
        throw Error("No openai token in env");
    }

    if(!process.env.REDIS_PASSWORD) {
        throw Error("No redis password stored in env");
    }
    logger.debug(`Found env var for redisPassword ${process.env.REDIS_PASSWORD.substring(0,2)}...`);

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
    logger.debug(`Creating chatbot with ${process.env.OPENAI_TOKEN.substring(0,5)}...`);
    Chatbot.setKey(process.env.OPENAI_TOKEN);
    Chatbot.setContext(process.env.CONTEXT);

    // registering listeners
    ready(client);
    interactionCreate(client);

    logger.debug(`About to log in with ${process.env.DISCORD_TOKEN.substring(0,5)}...`);
    client.login(process.env.DISCORD_TOKEN);
}
catch(err) {
    //crash hangs-- allows me to enter docker container
    let ms = 2000;
    logger.error(err);
    while (true) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
}

 