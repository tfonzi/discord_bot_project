import { CreateChatCompletionRequest, ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum, Configuration, OpenAIApi } from "openai"
import { TextChannel } from "discord.js";
import { encode } from "gpt-3-encoder"
import { Mutex } from 'async-mutex';

import { DiscordClient } from "../discordClient";

const COLLECT_TIMER = 3000; //collect after 3 second

interface MessageHistory {
    addMessage(message: ChatCompletionRequestMessage),
    getHistory(): ChatCompletionRequestMessage[],
    getTokens(): number
}

class MessageHistory implements MessageHistory { // MessageHistory class -- modified queue for storing message history for Chatbot
    private storage: ChatCompletionRequestMessage[] = [];

    constructor(private context: ChatCompletionRequestMessage, private capacity: number = 20) {}

    addMessage(msg: ChatCompletionRequestMessage): void {

        if(this.storage.length == this.capacity) {
            this.storage.splice(0,1); //oldest message gets removed from history
        }
        this.storage.push(msg);
    }

    getHistory(): ChatCompletionRequestMessage[] {
        return [this.context, ...this.storage]; // context needs to be first in chat completion
    }

    getTokens(): number {
        console.log(this.getHistory().reduce((totalString: string, request) => { return totalString.concat(JSON.stringify(request)); }, ""));
        return encode(this.getHistory().reduce((totalString: string, request) => { return totalString.concat(JSON.stringify(request)); }, "")).length;
    }

}

interface MessageProcessor {
    processMessage(msg: string, channelId: string): Promise<void>
}

class MessageProcessor implements MessageProcessor { // MessageProcessor class -- Processes messages for chatbot
    private basket: string[] = [];
    private isCollecting: boolean;
    private mutex: Mutex;

    constructor(private history: MessageHistory, private openAi: OpenAIApi) {
        this.mutex = new Mutex();
        this.isCollecting = false;
    }

    async processMessage(msg: string, channelId: string): Promise<void> {
        console.log("about to store message into basket");
        let release = await this.mutex.acquire();
        try {
            console.log("storing message into basket - entered mutex");
            this.basket.push(msg);
        } finally {
            release();
        }
        console.log("stored message into basket - left mutex");
        let result = undefined;
        if (!this.isCollecting) { // if we are not collecting responses when we process a message, then it is the first message. Start collecting for any more messages that appear in timer span
            (DiscordClient.getClient().channels.cache.get(channelId) as TextChannel).sendTyping();
            this.isCollecting = true;
            console.log("starting timer for processing messages");
            await new Promise(resolve => setTimeout(resolve, COLLECT_TIMER)); // waiting for timer to end
            console.log("done waiting for timer");
            release = await this.mutex.acquire();
            try {
                console.log("generating response - entered mutex");
                if (this.basket.length > 0) {
                    this.basket.forEach(message => {
                        this.history.addMessage({role: ChatCompletionRequestMessageRoleEnum.User, content: message});
                    });
                    const request: CreateChatCompletionRequest = {
                        model: "gpt-3.5-turbo",
                        messages: this.history.getHistory(),
                        temperature: 1.2,
                        max_tokens: 300,
                        presence_penalty: 0,
                        frequency_penalty: -0.2
                    }
                    const completion = await this.openAi.createChatCompletion(request);
                    this.history.addMessage({role: ChatCompletionRequestMessageRoleEnum.Assistant, content: completion.data.choices[0].message.content});
                    (DiscordClient.getClient().channels.cache.get(channelId) as TextChannel).send(completion.data.choices[0].message.content.replace("Rivanna:", ""));
                    this.basket = []; // refresh basket
                }
                
            } finally {
                this.isCollecting = false; // refresh collecting state
                console.log("done generating response - left mutex");
                release();
            }
        } else {
            console.log("timer has already been started, returning undefined");
        }
    }
}

export interface Chatbot {
    sendMessage(guildId: string, thread: string, msg: string): Promise<void>,
    username: string,
    setChatActiveState(guildId: string, channelId: string, state: boolean): void,
    getChatActiveState(guildId: string, channelId: string): boolean,
    isActive(): boolean,
    setChatTimer(guildId: string, channelId: string, timer: NodeJS.Timeout): void,
    clearChatTimer(guildId: string, channelId: string): void,
    getHistory(guildId: string, channelId: string): MessageHistory
}

export class Chatbot implements Chatbot {
    private static instance: Chatbot;
    private messageHistories: Map<string, MessageHistory>;
    private activeChats: string[];
    private activeChatTimers: Map<string, NodeJS.Timeout>;
    private openai: OpenAIApi;
    private context: ChatCompletionRequestMessage;
    private processers: Map<string, MessageProcessor>
    public userName: string;

    private constructor() {
        this.messageHistories = new Map<string, MessageHistory>();
        this.activeChats = [];
        this.activeChatTimers = new Map<string, NodeJS.Timeout>();
        this.processers = new Map<string, MessageProcessor>();
    }

    private static EnsureExistance(){
        if (!Chatbot.instance) {
            Chatbot.instance = new Chatbot();
        }
    }

    public static getInstance() {
        Chatbot.EnsureExistance();
        return Chatbot.instance;
    }

    public static setKey(key: string) {
        Chatbot.EnsureExistance();
        Chatbot.instance.openai = new OpenAIApi(new Configuration({
            apiKey: key
        })); 
    }

    public static setContext(contextString: string) {
        Chatbot.EnsureExistance();
        Chatbot.instance.context = { role: ChatCompletionRequestMessageRoleEnum.System, content: contextString }
    }

    public static setUserName(userName: string) {
        Chatbot.EnsureExistance();
        Chatbot.instance.userName = userName;
    }

    getHistory(guildId: string, channelId: string): MessageHistory {
        if (this.messageHistories.has(`${guildId}-${channelId}`)) {
            return this.messageHistories.get(`${guildId}-${channelId}`)
        } else {
            throw new Error("There is no history for this chat!")
        }
    }

    setChatActiveState(guildId: string, channelId: string, state: boolean) {
        console.log(`Set ${guildId}-${channelId} to ${state}`);
        if (state && !this.activeChats.includes(`${guildId}-${channelId}`)) {
            this.activeChats.push(`${guildId}-${channelId}`);
        } else if (!state && this.activeChats.includes(`${guildId}-${channelId}`)) {
            this.activeChats= this.activeChats.filter(x => x !== `${guildId}-${channelId}`);
            console.log(`new activeChats is: ${this.activeChats}`);
        }
    }

    getChatActiveState(guildId: string, channelId: string): boolean { // not great with scale
        return this.activeChats.includes(`${guildId}-${channelId}`);
    }

    isActive(): boolean {
        return this.activeChats.length > 0;
    }

    setChatTimer(guildId: string, channelId: string, timer: NodeJS.Timeout): void {
        if (this.activeChatTimers.has(`${guildId}-${channelId}`)) {
            throw new Error("A timer is already set!")
        }
        this.activeChatTimers.set(`${guildId}-${channelId}`, timer );
    }

    clearChatTimer(guildId: string, channelId: string): void {
        if (!this.activeChatTimers.has(`${guildId}-${channelId}`)) {
            throw new Error("There is no timer to clear!")
        }
        clearTimeout(this.activeChatTimers.get(`${guildId}-${channelId}`));
        this.activeChatTimers.delete(`${guildId}-${channelId}`);
    }

    async sendMessage(guildId: string, channelId: string, msg: string): Promise<void> {
        try {
            if (!this.context || !this.openai) {
                throw new Error("Missing Context or OpenAI key!");
            }
            if (!this.activeChats.includes(`${guildId}-${channelId}`)) {
                throw new Error("Cannot send message. Chat in this id is not active.");
            }
            if (!this.messageHistories.has(`${guildId}-${channelId}`)){ // populate new MessageHistory for channel if it does not exist
                this.messageHistories.set(`${guildId}-${channelId}`, new MessageHistory(this.context))
            }
            if (!this.processers.has(`${guildId}-${channelId}`)){ // populate new MessageProcessor for channel if it does not exist
                this.processers.set(`${guildId}-${channelId}`, new MessageProcessor(this.messageHistories.get(`${guildId}-${channelId}`), this.openai));
            }
            await this.processers.get(`${guildId}-${channelId}`).processMessage(msg, channelId);
        }
        catch(err) {
            console.error(err);
            (DiscordClient.getClient().channels.cache.get(channelId) as TextChannel).send("Sorry! I'm having trouble thinking of a response right now. Please try later.");
        }
    }
}