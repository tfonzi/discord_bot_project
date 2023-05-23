import { Client } from "discord.js";

import { Commands } from "./../slash-commands";
import { Chatbot } from "../chat-ai/chat-bot";

export default (client: Client): void => {
    client.on(`ready`, async () => {
        Chatbot.setUserName(client.user.username)
        await client.application.commands.set(Commands);
        console.log(JSON.stringify(Commands));
        console.log(`Logged in as ${client.user.tag}!`);
    });
}