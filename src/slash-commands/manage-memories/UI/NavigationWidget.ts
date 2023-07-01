import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { Memory } from "../../../redis/RedisEmbeddingService";

export enum ButtonId {
    Left = "left",
    Right = "right",
    Delete = "delete",
    ConfirmDelete = "confirmDelete",
    DenyDelete = "denyDelete",
    Cancel = "cancel", 
    List = "list",
    ListLeft = "listLeft",
    ListRight = "listRight",
    ListCancel = "listCancel"
}

const leftBtn = new ButtonBuilder()
			.setCustomId(ButtonId.Left)
			.setStyle(ButtonStyle.Secondary)
            .setEmoji("⬅️");

const rightBtn = new ButtonBuilder()
    .setCustomId(ButtonId.Right)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("➡️");

const deleteBtn = new ButtonBuilder()
    .setCustomId(ButtonId.Delete)
    .setLabel('Delete')
    .setStyle(ButtonStyle.Danger);

const cancelBtn = new ButtonBuilder()
    .setCustomId(ButtonId.Cancel)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

const listBtn = new ButtonBuilder()
    .setCustomId(ButtonId.List)
    .setLabel('List')
    .setStyle(ButtonStyle.Primary);

export const NavigationWidget = [new ActionRowBuilder<ButtonBuilder>()
    .addComponents(listBtn, cancelBtn, deleteBtn), new ActionRowBuilder<ButtonBuilder>()
    .addComponents(leftBtn, rightBtn)];

const confirmDeleteButton = new ButtonBuilder()
.setCustomId(ButtonId.ConfirmDelete)
.setLabel('Delete')
.setStyle(ButtonStyle.Danger);

const denyDeleteButton = new ButtonBuilder()
.setCustomId(ButtonId.DenyDelete)
.setLabel('Go Back')
.setStyle(ButtonStyle.Secondary);

export const ConfirmDeleteWidget = [new ActionRowBuilder<ButtonBuilder>()
    .addComponents(confirmDeleteButton, denyDeleteButton)];

const leftListBtn = new ButtonBuilder()
    .setCustomId(ButtonId.ListLeft)
    .setStyle(ButtonStyle.Primary)
    .setEmoji("⬅️");

const rightListBtn = new ButtonBuilder()
.setCustomId(ButtonId.ListRight)
.setStyle(ButtonStyle.Primary)
.setEmoji("➡️");

const cancelListBtn = new ButtonBuilder()
.setCustomId(ButtonId.ListCancel)
.setStyle(ButtonStyle.Secondary)
.setLabel("Go Back")

interface ListWidget {
    content: string,
    components: ActionRowBuilder<ButtonBuilder>[]
}

export function CreateListWidget(memories: Memory[], page: number, pagination: number): ListWidget
{
    const emojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]
    let choices = memories.length - (page * pagination)
    if (choices > 10) {
        choices = 10;
    }

    const numberButtons = Array.from({length: emojis.length}, (_, i) => i + 1).map(num => {
        return new ButtonBuilder()
        .setCustomId(num.toString())
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(emojis[num-1]);
    });

    let content = `Choose from list (Page ${page+1}):\n\n`;
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < choices; i = i + 1) {
        const memory = memories[(page * pagination) + i].memory;
        const memoryText = memory.length < 30 ? memory : `${memory.substring(0,50)}...`;
        content = content + `${emojis[i]} : "${memoryText}"\n`
        if (i == 0) {
            components.push(new ActionRowBuilder<ButtonBuilder>())
        }
        if (i == 5) {
            components.push(new ActionRowBuilder<ButtonBuilder>())
        }
        if (i < 5){
            components[0].addComponents(numberButtons[i])
        } else {
            components[1].addComponents(numberButtons[i])
        }
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(leftListBtn, rightListBtn, cancelListBtn));

    return {content, components};
}