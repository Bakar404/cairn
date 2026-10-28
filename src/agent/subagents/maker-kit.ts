import type { AssistantMessage, Message, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { PiEngine, ThinkingLevel } from "../models.ts";
import type { ProviderEventObserver } from "../provider-events.ts";

/**
 * The plumbing shared by the image-in-the-loop makers (visual-maker.ts,
 * animation-maker.ts): one raw model call per iteration, tool results the
 * loop writes itself, exact-once edits, and the "look at this" image
 * message that follows a render.
 */

export function toolText(toolCallId: string, toolName: string, value: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: value }],
		isError: value.startsWith("ERROR:") || value.startsWith("RENDER ERROR"),
		timestamp: Date.now(),
	};
}

/** A user message carrying a render for the model to inspect. */
export function lookMessage(text: string, png: Buffer): Message {
	return {
		role: "user",
		content: [
			{ type: "text", text },
			{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
		],
		timestamp: Date.now(),
	};
}

/** A plain user message (a gate's instruction without an image). */
export function nudgeMessage(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}

export type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export function toolCallsOf(message: AssistantMessage): ToolCallBlock[] {
	return message.content.filter((c): c is ToolCallBlock => c.type === "toolCall");
}

export function textOf(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
}

/** One raw model call (no agent loop): drain the event stream to the final
 *  AssistantMessage; provider errors and aborts throw so the loop's catch
 *  path keeps its old generateText semantics. */
export async function streamOnce(
	engine: PiEngine,
	systemPrompt: string,
	messages: Message[],
	tools: Tool[],
	sessionId: string,
	reasoning: ThinkingLevel | undefined,
	abortSignal?: AbortSignal,
	onProviderStreamEvent?: ProviderEventObserver,
): Promise<AssistantMessage> {
	// 0.87.1: provider-facing contexts are TranscriptContexts — the prompt
	// and tool declarations fold into a leading system message.
	// normalizeContext is the library's only Context→TranscriptContext entry.
	const stream = engine.streamFn(engine.model, normalizeContext({ systemPrompt, messages, tools }), {
		sessionId,
		reasoning: reasoning && reasoning !== "off" ? reasoning : undefined,
		signal: abortSignal,
		onProviderStreamEvent: onProviderStreamEvent as never,
	} as never);
	for await (const event of stream) {
		if (event.type === "done") return event.message;
		if (event.type === "error") {
			if (event.reason === "aborted") {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			throw new Error(event.error.errorMessage ?? "the model call failed");
		}
	}
	throw new Error("the model stream ended without a result");
}

/** A 3-line numbered context window around the closest fuzzy match for a
 *  failed edit — enough for the model to see what went wrong and retry
 *  (the pi svg_tools snippetAround semantics). */
export function snippetAround(text: string, target: string): string {
	const words = target.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "(empty old_text)";
	const lines = text.split("\n");
	let bestAt = -1;
	let bestScore = -1;
	for (let i = 0; i < lines.length; i++) {
		const score = words.filter((w) => lines[i]!.includes(w)).length;
		if (score > bestScore) {
			bestScore = score;
			bestAt = i;
		}
	}
	if (bestAt < 0) return "(no similar line found)";
	const from = Math.max(0, bestAt - 1);
	const to = Math.min(lines.length, bestAt + 2);
	return lines
		.slice(from, to)
		.map((line, idx) => `${from + idx + 1} | ${line}`)
		.join("\n");
}

/** The tool names an edit's replies point the model at. */
export interface EditNames {
	/** The tool that writes the whole document, e.g. "write_svg". */
	write: string;
	/** The tool that renders it, e.g. "render_svg". */
	render: string;
	/** What the document is called, e.g. "SVG". */
	noun: string;
}

/** An exact-once replacement in the current document. `next` is the edited
 *  text, or null when the edit was refused (`reply` then says why). */
export function applyExactEdit(
	current: string | null,
	args: unknown,
	names: EditNames,
): { next: string | null; reply: string } {
	const edit = (args ?? {}) as { old_text?: unknown; new_text?: unknown };
	if (!current) return { next: null, reply: `ERROR: nothing to edit — call ${names.write} first.` };
	if (typeof edit.old_text !== "string" || typeof edit.new_text !== "string" || !edit.old_text) {
		return { next: null, reply: "ERROR: expected old_text (non-empty) and new_text strings." };
	}
	const parts = current.split(edit.old_text);
	const occurrences = parts.length - 1;
	if (occurrences === 0) {
		return {
			next: null,
			reply: `ERROR: old_text not found. Closest line for reference:\n${snippetAround(current, edit.old_text)}`,
		};
	}
	if (occurrences > 1) {
		return {
			next: null,
			reply: `ERROR: old_text appears ${occurrences} times — it must match EXACTLY ONCE. Include more surrounding context to make it unique.`,
		};
	}
	// join, not String.replace: a "$&" or "$$" in new_text (LaTeX in a
	// scene) stays literal.
	return {
		next: parts.join(edit.new_text),
		reply: `OK — replaced 1 occurrence. Call ${names.render} to look at the edited ${names.noun}.`,
	};
}
