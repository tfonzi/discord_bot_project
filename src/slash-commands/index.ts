import { Command } from "./command";
import { Roll } from "./roll";
import { ChatEnd, ChatStart } from "./chat";
import { Teach } from "./teach";
import { ManageMemories } from "./manage-memories/manageMemories";
import { ResetConversation } from "./resetConversation";
import { ServerStart } from "./serverStart";
import { ServerStop } from "./serverStop";
import { ServerStatus } from "./serverStatus";

export const Commands: Command[] = [Roll, ChatStart, ChatEnd, Teach, ManageMemories, ResetConversation, ServerStart, ServerStop, ServerStatus];