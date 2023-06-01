import { RedisEncodingsService } from "./redis/RedisEncodingsService";
import * as dotenv from "dotenv";
import * as fs from 'fs';
import { Configuration, OpenAIApi } from "openai";
import { discordBotEnv } from ".";


async function redisTest(memory: string) {
        dotenv.config();

        function float32Buffer(arr: number[]) {
            return Buffer.from(new Float32Array(arr).buffer);
        }

        try {
            if(!process.env.REDIS_PASSWORD) {
                throw Error("No redis password stored in env");
            }
            console.log(`Found env var for redisPassword ${process.env.REDIS_PASSWORD.substring(0,2)}...`);

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

            console.log("about to connect to redis");
            await RedisEncodingsService.CreateClient(process.env.REDIS_PASSWORD);
            console.log("connected to redis");

            await RedisEncodingsService.CreateIndexForEncoding("testGuildId");

            interface embeddingData {
                sentences: string[],
                embeddings: number[][]
            }

            const uploadFileToRedis = true;

            if (uploadFileToRedis) {
                const embeddingData: embeddingData = JSON.parse(fs.readFileSync("../local_dir/embedding.txt", "utf-8"));
                embeddingData.sentences.forEach(async (sentence, index) => {
                    console.log(embeddingData.embeddings[index].length)
                    await RedisEncodingsService.SetEncodingData("testGuildId", { text: sentence, encoding: float32Buffer(embeddingData.embeddings[index])});
                });
            }

            const api = new OpenAIApi(new Configuration({
                apiKey: tokens.openAiToken
            })); 
        
            const query = "Considering we are fighting a dragon, I think that Freyla might be the best bet.";
        
            const queryEmbedding = (await api.createEmbedding({
                model: "text-embedding-ada-002",
                input: query
            })).data.data[0].embedding;

            const result = await (await RedisEncodingsService.GetClient()).ft.search('idx:testGuildId', '*=>[KNN 10 @encoding $BLOB AS dist]', {
                PARAMS: {
                    BLOB: float32Buffer(queryEmbedding)
                },
                SORTBY: 'dist',
                DIALECT: 2,
                RETURN: ['dist']
            });

            console.log(`test: ${JSON.stringify(result)}`);

        } catch(err) {
            console.error(err);
            console.log("Could not store to redis");
        }
}

console.log("waiting 1 seconds");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
redisTest("test").catch(console.error);
// let ms = 2000;
// while (true) {
//     console.log("hi");
//     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// }