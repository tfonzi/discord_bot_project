import { Command } from "./command";
import { Roll } from "./roll";
import { ChatEnd, ChatStart } from "./chat";
import { Teach } from "./teach";
import { ManageMemories } from "./manageMemories";

export const Commands: Command[] = [Roll, ChatStart, ChatEnd, Teach, ManageMemories];