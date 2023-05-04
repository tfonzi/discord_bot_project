import { ClientOptions, Client, GatewayIntentBits} from "discord.js";
import * as dotenv from "dotenv";

const clientOptions: ClientOptions = {intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]};
const client = new Client(clientOptions);
dotenv.config();

client.on(`ready`, () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.on(`messageCreate`, async (msg) => {
    if(msg.author.username != client.user.username) {
        console.log(`Saw message (${JSON.stringify(msg)})`);
        if (msg.mentions.has(client.user) && (msg.content.toLowerCase().includes("hi") || msg.content.toLowerCase().includes("hello")))
        msg.reply(`Hi ${msg.author.username}!`);
    }
});

client.login(process.env.BOT_TOKEN);
 