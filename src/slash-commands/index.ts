import { Command } from "./command";
import { Roll } from "./roll";
import { ChatEnd, ChatStart } from "./chat";
import { Teach } from "./teach";
import { ManageMemories } from "./manage-memories/manageMemories";
import { ResetConversation } from "./resetConversation";

export const Commands: Command[] = [Roll, ChatStart, ChatEnd, Teach, ManageMemories, ResetConversation];