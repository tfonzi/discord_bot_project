import { CreateChatCompletionRequest, ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum, Configuration, OpenAIApi } from "openai"
import { encode } from "gpt-3-encoder"

interface MessageHistory {
    guildId: string,
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

export interface Chatbot {
    sendMessage(guildId: string, msg: string): Promise<string>,
    username: string
}

export class Chatbot implements Chatbot {
    private static instance: Chatbot;
    private messageHistories: Map<string, MessageHistory>;
    private openai: OpenAIApi;
    private context: ChatCompletionRequestMessage;
    public userName: string;

    private constructor() {
        this.messageHistories = new Map<string, MessageHistory>();
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

    async sendMessage(guildId: string, msg: string): Promise<string> {
        try {
            if (!this.context || !this.openai) {
                throw new Error("Missing Context or OpenAI key!");
            }
            if (!this.messageHistories.has(guildId)){ // populate new MessageHistory for guild if it does not exist
                this.messageHistories.set(guildId, new MessageHistory(this.context))
            }
            this.messageHistories.get(guildId).addMessage({role: ChatCompletionRequestMessageRoleEnum.User, content: msg});
            //console.log(this.messageHistories.get(guildId).getTokens());
            const request: CreateChatCompletionRequest = {
                model: "gpt-3.5-turbo",
                messages: this.messageHistories.get(guildId)!.getHistory(), // MessageHistory will always exist due to previous if statement
                temperature: 1.2,
                //max_tokens: 200,
                presence_penalty: 0.1,
                frequency_penalty: -0.2
            }
            //console.log(JSON.stringify(request));
            const completion = await this.openai.createChatCompletion(request);

            this.messageHistories.get(guildId).addMessage({role: ChatCompletionRequestMessageRoleEnum.Assistant, content: completion.data.choices[0].message.content});
            return completion.data.choices[0].message.content.replace("Rivanna:", "");
        }
        catch(err) {
            console.error(err);
            return "Sorry! I'm having trouble thinking of a response right now. Please try later.";
        }
    }
}