/**
 * Copilot session events → pi assistant-message events (pure).
 *
 * One pi stream call is one model call of the Copilot session. The call is
 * complete when the session either requests every tool the model called
 * (external tools wait for Cairn's pi loop to run them → `toolUse`) or goes
 * idle (→ `stop` / `length`). Sub-agent traffic (parentToolCallId) and the
 * runtime's own bookkeeping events are ignored.
 */
import { calculateCost, type Api, type AssistantMessage, type AssistantMessageEvent, type JsonObject, type Model, type ToolCall } from "@earendil-works/pi-ai";
import type { SessionEvent } from "@github/copilot-sdk";
import { COPILOT_PROVIDER, USD_PER_CREDIT } from "./catalog.ts";

export type CallOutcome =
	| { kind: "toolUse"; requests: Map<string, string> }
	| { kind: "stop"; reason: "stop" | "length" }
	| { kind: "error"; message: string; code?: string; status?: number };

type Of<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>["data"];

export function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: COPILOT_PROVIDER,
		model: model.id,
		content: [],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function parseArguments(raw: unknown): JsonObject {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as JsonObject;
	if (typeof raw === "string" && raw.trim()) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
		} catch {
			/* malformed streamed JSON: fall through to empty arguments */
		}
	}
	return {};
}

export class CallTranslator {
	readonly message: AssistantMessage;
	private started = false;
	private openText: number | undefined;
	private readonly texts = new Map<string, number>();
	private readonly openThinking = new Set<number>();
	private readonly thinking = new Map<string, number>();
	private readonly tools = new Map<string, { index: number; json: string; ended: boolean }>();
	private readonly wanted = new Set<string>();
	private readonly requested = new Map<string, string>();
	private finalChunkSeen = false;
	private finishReason: string | undefined;
	private credits = 0;

	constructor(
		private readonly model: Model<Api>,
		private readonly emit: (event: AssistantMessageEvent) => void,
	) {
		this.message = emptyMessage(model);
	}

	/** Emit `start` once (pi requires it before any other event). */
	begin(): void {
		if (this.started) return;
		this.started = true;
		this.emit({ type: "start", partial: this.message });
	}

	/** Feed one session event; returns the outcome once the call is complete. */
	handle(event: SessionEvent): CallOutcome | undefined {
		const data = event.data as { parentToolCallId?: string } | undefined;
		if (data?.parentToolCallId) return undefined;
		switch (event.type) {
			case "assistant.reasoning_delta":
				this.reasoningDelta(event.data);
				return undefined;
			case "assistant.reasoning":
				this.reasoning(event.data);
				return undefined;
			case "assistant.message_delta":
				this.textDelta(event.data.messageId, event.data.deltaContent);
				return undefined;
			case "assistant.tool_call_delta":
				this.toolDelta(event.data);
				return undefined;
			case "assistant.usage":
				this.usage(event.data);
				return undefined;
			case "assistant.message":
				this.finalMessage(event.data);
				return this.toolOutcome();
			case "external_tool.requested":
				this.requested.set(event.data.toolCallId, event.data.requestId);
				return this.toolOutcome();
			case "session.idle":
				if (this.wanted.size) return this.toolOutcome() ?? { kind: "error", message: "Copilot session went idle with unanswered tool calls" };
				this.closeOpenBlocks();
				return { kind: "stop", reason: this.finishReason === "length" ? "length" : "stop" };
			case "session.error":
				return { kind: "error", message: event.data.message || event.data.errorType, code: event.data.errorCode ?? event.data.errorType, status: event.data.statusCode };
			default:
				return undefined;
		}
	}

	/** Seal the message for a terminal event. */
	finish(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
		this.closeOpenBlocks();
		this.message.stopReason = stopReason;
		if (errorMessage) this.message.errorMessage = errorMessage;
		return this.message;
	}

	private push(block: AssistantMessage["content"][number]): number {
		this.begin();
		this.message.content.push(block);
		return this.message.content.length - 1;
	}

	private closeThinking(): void {
		for (const index of this.openThinking) {
			const block = this.message.content[index];
			if (block?.type === "thinking") this.emit({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.message });
		}
		this.openThinking.clear();
	}

	private closeText(): void {
		if (this.openText === undefined) return;
		const block = this.message.content[this.openText];
		if (block?.type === "text") this.emit({ type: "text_end", contentIndex: this.openText, content: block.text, partial: this.message });
		this.openText = undefined;
	}

	private closeOpenBlocks(): void {
		this.closeThinking();
		this.closeText();
	}

	private reasoningDelta(data: Of<"assistant.reasoning_delta">): void {
		if (!data.deltaContent) return;
		let index = this.thinking.get(data.reasoningId);
		if (index === undefined || !this.openThinking.has(index)) {
			this.closeText();
			index = this.push({ type: "thinking", thinking: "" });
			this.thinking.set(data.reasoningId, index);
			this.openThinking.add(index);
			this.emit({ type: "thinking_start", contentIndex: index, partial: this.message });
		}
		const block = this.message.content[index];
		if (block?.type !== "thinking") return;
		block.thinking += data.deltaContent;
		this.emit({ type: "thinking_delta", contentIndex: index, delta: data.deltaContent, partial: this.message });
	}

	private reasoning(data: Of<"assistant.reasoning">): void {
		const index = this.thinking.get(data.reasoningId);
		if (index === undefined) {
			// Not streamed: add it only while it can still lead the message.
			if (this.message.content.length || !data.content) return;
			this.reasoningDelta({ reasoningId: data.reasoningId, deltaContent: data.content });
			return;
		}
		const block = this.message.content[index];
		if (block?.type === "thinking" && data.content) block.thinking = data.content;
	}

	private textDelta(messageId: string, delta: string): void {
		if (!delta) return;
		this.closeThinking();
		let index = this.texts.get(messageId);
		if (index === undefined || index !== this.openText) {
			this.closeText();
			index = this.push({ type: "text", text: "" });
			this.texts.set(messageId, index);
			this.openText = index;
			this.emit({ type: "text_start", contentIndex: index, partial: this.message });
		}
		const block = this.message.content[index];
		if (block?.type !== "text") return;
		block.text += delta;
		this.emit({ type: "text_delta", contentIndex: index, delta, partial: this.message });
	}

	private toolDelta(data: Of<"assistant.tool_call_delta">): void {
		this.closeOpenBlocks();
		let tool = this.tools.get(data.toolCallId);
		if (!tool) {
			const index = this.push({ type: "toolCall", id: data.toolCallId, name: data.toolName ?? "", arguments: {} });
			tool = { index, json: "", ended: false };
			this.tools.set(data.toolCallId, tool);
			this.emit({ type: "toolcall_start", contentIndex: index, partial: this.message });
		}
		const block = this.message.content[tool.index];
		if (block?.type === "toolCall" && data.toolName && !block.name) block.name = data.toolName;
		if (!data.inputDelta) return;
		tool.json += data.inputDelta;
		this.emit({ type: "toolcall_delta", contentIndex: tool.index, delta: data.inputDelta, partial: this.message });
	}

	private usage(data: Of<"assistant.usage">): void {
		const usage = this.message.usage;
		const cacheRead = data.cacheReadTokens ?? 0;
		const cacheWrite = data.cacheWriteTokens ?? 0;
		usage.input += Math.max(0, (data.inputTokens ?? 0) - cacheRead - cacheWrite);
		usage.output += data.outputTokens ?? 0;
		usage.cacheRead += cacheRead;
		usage.cacheWrite += cacheWrite;
		if (data.reasoningTokens) usage.reasoning = (usage.reasoning ?? 0) + data.reasoningTokens;
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		calculateCost(this.model, usage);
		if (data.copilotUsage?.totalNanoAiu) this.credits += data.copilotUsage.totalNanoAiu / 1e9;
		if (this.credits) usage.cost.total = this.credits * USD_PER_CREDIT;
		if (data.finishReason) this.finishReason = data.finishReason;
		if (data.model) this.message.responseModel = data.model;
	}

	private finalMessage(data: Of<"assistant.message">): void {
		this.begin();
		const content = data.content ?? "";
		const index = this.texts.get(data.messageId);
		const block = index === undefined ? undefined : this.message.content[index];
		// The final content is authoritative over the streamed deltas.
		if (block?.type === "text") {
			if (content) block.text = content;
		} else if (content.trim()) this.textDelta(data.messageId, content);
		this.closeOpenBlocks();
		for (const request of data.toolRequests ?? []) {
			this.wanted.add(request.toolCallId);
			let tool = this.tools.get(request.toolCallId);
			if (!tool) {
				const toolIndex = this.push({ type: "toolCall", id: request.toolCallId, name: request.name, arguments: {} });
				tool = { index: toolIndex, json: "", ended: false };
				this.tools.set(request.toolCallId, tool);
				this.emit({ type: "toolcall_start", contentIndex: toolIndex, partial: this.message });
			}
			const call = this.message.content[tool.index] as ToolCall;
			call.name = request.name;
			call.arguments = request.arguments === undefined ? parseArguments(tool.json) : parseArguments(request.arguments);
			if (!tool.ended) {
				tool.ended = true;
				this.emit({ type: "toolcall_end", contentIndex: tool.index, toolCall: call, partial: this.message });
			}
		}
		this.message.responseId = data.messageId;
		const last = data.chunkCount === undefined || data.chunkIndex === undefined || data.chunkIndex >= data.chunkCount - 1;
		if (last) this.finalChunkSeen = true;
	}

	private toolOutcome(): CallOutcome | undefined {
		if (!this.finalChunkSeen || !this.wanted.size) return undefined;
		for (const id of this.wanted) if (!this.requested.has(id)) return undefined;
		this.closeOpenBlocks();
		const requests = new Map<string, string>();
		for (const id of this.wanted) requests.set(id, this.requested.get(id)!);
		return { kind: "toolUse", requests };
	}
}
