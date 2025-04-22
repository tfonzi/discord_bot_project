import { Client as DiscordJsClient, GatewayIntentBits } from "discord.js";
import * as dotenv from "dotenv";
import { Logger as PinoLogger } from 'pino';

import ready from "./listeners/ready";
import interactionCreate from "./listeners/interactionCreate";
import { ChatbotV2 } from "./chat-ai/chatbotV2";
import { DiscordClientV2 } from "./utils/discordClientV2";
import { RedisEmbeddingServiceV2 } from "./redis/RedisEmbeddingServiceV2";
import { LoggerV2, isLogLevel } from "./logger/loggerV2";

dotenv.config();

let logger: PinoLogger | undefined = undefined;

(async () => {
    try {
        let logLevel: "DEBUG" | "INFO" | "VERBOSE" | "TRACE" = "INFO";
        if (process.env.LOG_LEVEL && isLogLevel(process.env.LOG_LEVEL)) {
            logLevel = process.env.LOG_LEVEL;
        } else {
             console.warn('No valid LOG_LEVEL specified in process env. Defaulting to INFO level');
        }
        LoggerV2.createLogger(logLevel); 
        logger = LoggerV2.getLogger();
        logger.info(`Logger initialized with level: ${logLevel}`);

        logger.info("Validating environment variables...");
        if (!process.env.DISCORD_TOKEN) throw new Error("No DISCORD_TOKEN in env");
        if (!process.env.OPENAI_TOKEN) throw new Error("No OPENAI_TOKEN in env");
        if (!process.env.REDIS_PASSWORD) throw new Error("No REDIS_PASSWORD in env");
        if (!process.env.CONTEXT) logger.warn("No CONTEXT string found in env for chatbot system prompt.");

        logger.debug(`Found DISCORD_TOKEN: ${process.env.DISCORD_TOKEN.substring(0, 5)}...`);
        logger.debug(`Found OPENAI_TOKEN: ${process.env.OPENAI_TOKEN.substring(0, 5)}...`);
        logger.debug(`Found REDIS_PASSWORD: ${process.env.REDIS_PASSWORD.substring(0, 2)}...`);
        logger.debug(`Found CONTEXT: ${process.env.CONTEXT?.substring(0, 30)}...`);

        logger.info("Initializing services...");

        logger.info("Connecting to Redis...");
        await RedisEmbeddingServiceV2.CreateClient(process.env.REDIS_PASSWORD);
        logger.info("Redis client connected.");

        logger.info("Creating Discord client...");
        const clientOptions = {
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageTyping,
            ]
        };
        const discordClient: DiscordJsClient = DiscordClientV2.createClient(clientOptions);
        logger.info("Discord client created.");

        logger.info("Initializing ChatbotV2...");
        const botUsername = "Rivanna";
        ChatbotV2.initialize(
            process.env.OPENAI_TOKEN,
            process.env.CONTEXT || "You are a helpful AI assistant.",
            botUsername
        );
        logger.info(`ChatbotV2 initialized with username: ${botUsername}`);

        logger.info("Registering Discord event listeners...");
        ready(discordClient);
        interactionCreate(discordClient);
        logger.info("Listeners registered.");

        logger.info("Logging into Discord...");
        await DiscordClientV2.login(process.env.DISCORD_TOKEN);
        logger.info("Discord login successful!");

    } catch (err) {
        const errorLogger = logger || console;
        errorLogger.error({ err }, "Fatal error during bot startup:");
        process.exit(1);
    }
})();

 