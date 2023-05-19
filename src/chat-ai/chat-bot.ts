import { CreateChatCompletionRequest, ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum, Configuration, OpenAIApi } from "openai"

interface MessageHistory {
    guildId: string,
    addMessage(message: ChatCompletionRequestMessage),
    getHistory(): ChatCompletionRequestMessage[]
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

}

export interface Chatbot {
    sendMessage(guildId: string, msg: string): Promise<string>
}

export class Chatbot implements Chatbot {
    private messageHistories: Map<string, MessageHistory>;
    private openai: OpenAIApi;
    private context: ChatCompletionRequestMessage;


    constructor(private key: string, private contextString: string) {
        this.messageHistories = new Map<string, MessageHistory>();
        this.openai = new OpenAIApi(new Configuration({
            apiKey: key
        }));
        this.context = { role: ChatCompletionRequestMessageRoleEnum.System, content: contextString }
    }

    async sendMessage(guildId: string, msg: string): Promise<string> {
        try {
            if (!this.messageHistories.has(guildId)){ // populate new MessageHistory for guild if it does not exist
                this.messageHistories.set(guildId, new MessageHistory(this.context))
            }
            this.messageHistories.get(guildId).addMessage({role: ChatCompletionRequestMessageRoleEnum.User, content: msg});
            const request: CreateChatCompletionRequest = {
                model: "gpt-3.5-turbo",
                messages: this.messageHistories.get(guildId)!.getHistory(), // MessageHistory will always exist due to previous if statement
                temperature: 0.4, //less random, range is 0-1
                max_tokens: 500,
                presence_penalty: 0.3,
                frequency_penalty: -0.3
            }
            console.log(JSON.stringify(request));
            const completion = await this.openai.createChatCompletion(request);
            this.messageHistories.get(guildId).addMessage({role: ChatCompletionRequestMessageRoleEnum.Assistant, content: completion.data.choices[0].message.content});
            return completion.data.choices[0].message.content;
        }
        catch(err) {
            console.error(err);
            return "Sorry! Ran into a processing error.";
        }
    }
}