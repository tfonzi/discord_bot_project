import { Command } from "./command";
import { Roll } from "./roll";
import { ChatEnd, ChatStart } from "./chat";

export const Commands: Command[] = [Roll, ChatStart, ChatEnd];