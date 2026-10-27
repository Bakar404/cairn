/**
 * Transcript ↔ Copilot session bookkeeping (pure).
 *
 * A Copilot session keeps its own conversation history, while pi hands
 * every model call the full transcript. Each session binding remembers a
 * fingerprint of every transcript message the session already holds, so a
 * call can send only the new tail: tool results answer the session's
 * pending tool calls, and user messages are sent as new prompts. Anything
 * the session cannot express as such a tail (an edited, compacted or
 * foreign transcript) is a rebuild: a fresh session that receives the
 * transcript replayed as text.
 */
import { createHash } from "node:crypto";
import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

type Turn = Exclude<Message, { role: "system" }>;

const digest = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 16);

function textOf(content: string | readonly (TextContent | ImageContent | { type: string })[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((c) => (c.type === "text" ? [(c as TextContent).text] : [])).join("\n");
}

function imagesOf(content: string | readonly (TextContent | ImageContent | { type: string })[]): ImageContent[] {
	return typeof content === "string" ? [] : content.filter((c): c is ImageContent => c.type === "image");
}

/** A stable identity for one transcript message: tool calls and results by
 *  their call ids, user messages by content. Assistant text is ignored on
 *  purpose; the record may re-render it, but its tool-call ids never change. */
export function fingerprint(message: Turn): string {
	switch (message.role) {
		case "user":
			return `u:${digest(`${textOf(message.content)}\u0000${imagesOf(message.content).length}`)}`;
		case "assistant":
			return `a:${message.content.flatMap((c) => (c.type === "toolCall" ? [c.id] : [])).join(",")}`;
		case "toolResult":
			return `t:${message.toolCallId}`;
	}
}

export function conversationOf(messages: readonly Message[]): Turn[] {
	return messages.filter((m): m is Turn => m.role !== "system");
}

export type CallPlan =
	| { kind: "delta"; toolResults: ToolResultMessage[]; users: UserMessage[] }
	| { kind: "rebuild"; reason: string };

/** Decide how one call reaches the session: the new tail, or a rebuild. */
export function planCall(consumed: readonly string[] | undefined, conversation: readonly Turn[], pending: ReadonlySet<string>): CallPlan {
	if (!consumed) return { kind: "rebuild", reason: "no session" };
	if (conversation.length <= consumed.length) return { kind: "rebuild", reason: "transcript shrank" };
	for (let i = 0; i < consumed.length; i++) {
		if (fingerprint(conversation[i]!) !== consumed[i]) return { kind: "rebuild", reason: `transcript diverged at ${i}` };
	}
	const tail = conversation.slice(consumed.length);
	const toolResults: ToolResultMessage[] = [];
	const users: UserMessage[] = [];
	for (const message of tail) {
		if (message.role === "assistant") return { kind: "rebuild", reason: "foreign assistant message" };
		if (message.role === "toolResult") {
			if (users.length) return { kind: "rebuild", reason: "tool result after user message" };
			if (!pending.has(message.toolCallId)) return { kind: "rebuild", reason: "tool result without a pending call" };
			toolResults.push(message);
		} else users.push(message);
	}
	const answered = new Set(toolResults.map((r) => r.toolCallId));
	if ([...pending].some((id) => !answered.has(id))) return { kind: "rebuild", reason: "unanswered tool call" };
	return { kind: "delta", toolResults, users };
}

export interface Prompt {
	text: string;
	images: ImageContent[];
}

/** User messages sent as one prompt (the session sees one user turn). */
export function promptFromUsers(users: readonly UserMessage[]): Prompt {
	return {
		text: users.map((u) => textOf(u.content)).filter(Boolean).join("\n\n"),
		images: users.flatMap((u) => imagesOf(u.content)),
	};
}

export function toolResultText(result: ToolResultMessage): string {
	return textOf(result.content);
}

export function toolResultImages(result: ToolResultMessage): ImageContent[] {
	return imagesOf(result.content);
}

const MAX_REPLAY_IMAGES = 8;

function renderTurn(message: Turn): string {
	switch (message.role) {
		case "user": {
			const images = imagesOf(message.content).length;
			return `<user>\n${textOf(message.content)}${images ? `\n[${images} image(s)]` : ""}\n</user>`;
		}
		case "assistant":
			return message.content
				.flatMap((c) =>
					c.type === "text" && c.text.trim()
						? [`<assistant>\n${c.text}\n</assistant>`]
						: c.type === "toolCall"
							? [`<tool_call id="${c.id}" name="${c.name}">\n${JSON.stringify(c.arguments)}\n</tool_call>`]
							: [],
				)
				.join("\n");
		case "toolResult": {
			const images = imagesOf(message.content).length;
			const status = message.isError ? ` status="error"` : "";
			return `<tool_result id="${message.toolCallId}" name="${message.toolName}"${status}>\n${textOf(message.content)}${images ? `\n[${images} image(s)]` : ""}\n</tool_result>`;
		}
	}
}

/** The rebuild prompt: the transcript replayed as text. A trailing user
 *  message stays a real prompt; images from the unanswered tail ride along
 *  as attachments. */
export function replayPrompt(conversation: readonly Turn[]): Prompt {
	const last = conversation.at(-1);
	const history = last?.role === "user" ? conversation.slice(0, -1) : conversation;
	let tailStart = history.length;
	while (tailStart > 0 && history[tailStart - 1]?.role !== "assistant") tailStart--;
	const images = [
		...history.slice(tailStart).flatMap((m) => (m.role === "toolResult" ? imagesOf(m.content) : m.role === "user" ? imagesOf(m.content) : [])),
		...(last?.role === "user" ? imagesOf(last.content) : []),
	].slice(-MAX_REPLAY_IMAGES);
	const parts: string[] = [];
	if (history.length) {
		parts.push(
			"The conversation so far is replayed below. You are the assistant in it. " +
				"Continue it naturally, calling tools as needed; never mention this replay.",
			`<conversation_history>\n${history.map(renderTurn).filter(Boolean).join("\n")}\n</conversation_history>`,
		);
	}
	parts.push(last?.role === "user" ? textOf(last.content) : "Continue the conversation from where it left off.");
	return { text: parts.join("\n\n"), images };
}

export type { AssistantMessage, Turn };
