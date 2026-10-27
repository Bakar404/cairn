/**
 * The pi StreamFunction for GitHub Copilot models.
 *
 * Each (pi sessionId, system prompt + tool declarations) pair is bound to
 * one Copilot session. A call sends only what the session has not seen:
 * tool results answer its pending external tool calls (Cairn's pi loop
 * runs every tool) and new user messages become prompts — sent ahead of
 * the tool results ("immediate") when a learner's message steers into a
 * tool round, which delivers them after the results in the same model
 * call. Any other transcript change rebuilds the session from a replay of
 * the transcript (see replay.ts). Model calls without a sessionId run on a
 * session of their own that is deleted afterwards.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { MessageOptions } from "@github/copilot-sdk";
import { effortFor } from "./catalog.ts";
import { CallTranslator, type CallOutcome } from "./events.ts";
import { conversationOf, fingerprint, planCall, promptFromUsers, replayPrompt, toolResultImages, toolResultText, type CallPlan, type Prompt } from "./replay.ts";
import { copilotDebug, copilotRuntime, type CopilotRuntimePort, type CopilotSessionPort, type SessionSpec, type ToolAnswer, type ToolDeclaration } from "./runtime.ts";

const MAX_BINDINGS = 24;
const IDLE_BINDING_MS = 45 * 60_000;
const SILENCE_LIMIT_MS = 10 * 60_000;

interface Binding {
	key: string;
	port: CopilotRuntimePort;
	session: CopilotSessionPort;
	consumed: string[];
	pending: Map<string, string>;
	model: string;
	effort: string | undefined;
	dirty: boolean;
	active: boolean;
	lastUsed: number;
	unwatch: () => void;
}

interface Registry {
	bindings: Map<string, Binding>;
	locks: Map<string, Promise<void>>;
}

const REGISTRY_KEY = Symbol.for("cairn.copilot.bindings");
function registry(): Registry {
	const holder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
	holder[REGISTRY_KEY] ??= { bindings: new Map(), locks: new Map() };
	return holder[REGISTRY_KEY];
}

const digest = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 16);

function declaration(tool: { name: string; description: string; parameters: unknown }): ToolDeclaration {
	// TypeBox schemas carry symbol keys; the wire wants plain JSON Schema.
	return { name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters ?? { type: "object" })) as Record<string, unknown> };
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const { locks } = registry();
	const previous = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
	locks.set(key, current);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (locks.get(key) === current) locks.delete(key);
	}
}

function dispose(binding: Binding): void {
	const { bindings } = registry();
	if (bindings.get(binding.key) === binding) bindings.delete(binding.key);
	binding.unwatch();
	const { session, port } = binding;
	void session
		.disconnect()
		.catch(() => undefined)
		.then(() => port.deleteSession(session.sessionId))
		.catch(() => undefined);
}

function evictIdle(): void {
	const { bindings } = registry();
	const now = Date.now();
	const idle = [...bindings.values()].filter((b) => !b.active).sort((a, b) => a.lastUsed - b.lastUsed);
	let excess = bindings.size - MAX_BINDINGS;
	for (const binding of idle) {
		if (excess > 0 || now - binding.lastUsed > IDLE_BINDING_MS) {
			copilotDebug(`evict ${binding.key}`);
			dispose(binding);
			excess--;
		}
	}
}

/** Close the sessions bound to one pi sessionId (a finished sub-agent run). */
export function releaseCopilotSessions(sessionId: string): void {
	for (const binding of [...registry().bindings.values()]) {
		if (binding.key.startsWith(`${sessionId}:`) && !binding.active) dispose(binding);
	}
}

function bind(key: string, port: CopilotRuntimePort, session: CopilotSessionPort, spec: SessionSpec): Binding {
	const binding: Binding = {
		key,
		port,
		session,
		consumed: [],
		pending: new Map(),
		model: spec.model,
		effort: spec.effort,
		dirty: false,
		active: false,
		lastUsed: Date.now(),
		unwatch: () => undefined,
	};
	// Activity outside a call (e.g. the runtime giving up on a pending tool
	// call and answering on its own) means the session no longer mirrors
	// the transcript.
	binding.unwatch = session.on((event) => {
		if (!binding.active && (event.type === "assistant.turn_start" || event.type === "assistant.message" || event.type === "session.error")) {
			copilotDebug(`out-of-band ${event.type} on ${key}`);
			binding.dirty = true;
		}
	});
	registry().bindings.set(key, binding);
	return binding;
}

function messageOptions(prompt: Prompt, vision: boolean): MessageOptions {
	const images = vision ? prompt.images : [];
	const omitted = vision ? 0 : prompt.images.length;
	const text = `${prompt.text}${omitted ? `\n\n[${omitted} image(s) omitted: this model cannot read images]` : ""}`;
	return {
		prompt: text.trim() ? text : "(no text)",
		...(images.length ? { attachments: images.map((image: ImageContent, i) => ({ type: "blob" as const, data: image.data, mimeType: image.mimeType, displayName: `image-${i + 1}` })) } : {}),
	};
}

function toolAnswer(result: Parameters<typeof toolResultText>[0], vision: boolean): ToolAnswer {
	const text = toolResultText(result);
	const images = toolResultImages(result);
	const body = text || (images.length ? "See the attached image(s)." : "(no output)");
	return {
		textResultForLlm: images.length && !vision ? `${body}\n[${images.length} image(s) omitted: this model cannot read images]` : body,
		resultType: result.isError ? "failure" : "success",
		...(result.isError ? { error: body } : {}),
		...(images.length && vision ? { binaryResultsForLlm: images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })) } : {}),
	};
}

/** Friendly text for a failed Copilot call. */
export function copilotErrorText(message: string, status?: number): string {
	const m = message.toLowerCase();
	if (status === 401 || /not authenticated|unauthori[sz]ed|authentication|sign in|log ?in|not logged|no github token/.test(m))
		return "GitHub Copilot is not signed in. Choose Sign in with GitHub in Settings → Providers (or run `gh auth login`, then Check again there).";
	if (status === 429 || /quota|rate.?limit|too many requests|premium request|usage limit/.test(m))
		return "GitHub Copilot usage limit reached for now. Try again later or pick a model with a lower multiplier.";
	if (status === 403 || /policy|not enabled|forbidden|not allowed|disabled/.test(m))
		return "This GitHub Copilot model is not enabled for your account. Pick another model in Settings → Models.";
	if (status === 404 || /model .*not (found|available|supported)|unknown model|unsupported model/.test(m))
		return "This GitHub Copilot model is unavailable. Pick another model in Settings → Models.";
	return `GitHub Copilot request failed: ${message}`;
}

type Driven = CallOutcome | { kind: "aborted" };

/** Send the plan to the session and translate events until the call ends. */
function drive(binding: Binding, plan: Exclude<CallPlan, { kind: "rebuild" }> | { kind: "replay"; prompt: Prompt }, translator: CallTranslator, model: Model<Api>, options: SimpleStreamOptions | undefined): Promise<Driven> {
	const vision = model.input.includes("image");
	return new Promise<Driven>((resolve) => {
		let settled = false;
		let silence: ReturnType<typeof setTimeout> | undefined;
		const finish = (outcome: Driven) => {
			if (settled) return;
			settled = true;
			clearTimeout(silence);
			unsubscribe();
			options?.signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const arm = () => {
			clearTimeout(silence);
			silence = setTimeout(() => finish({ kind: "error", message: "GitHub Copilot stopped responding" }), SILENCE_LIMIT_MS);
		};
		const onAbort = () => {
			void binding.session.abort().catch(() => undefined);
			finish({ kind: "aborted" });
		};
		const unsubscribe = binding.session.on((event) => {
			arm();
			if (options?.onProviderStreamEvent) void Promise.resolve(options.onProviderStreamEvent(event, model)).catch(() => undefined);
			try {
				const outcome = translator.handle(event);
				if (outcome) finish(outcome);
			} catch (err) {
				finish({ kind: "error", message: err instanceof Error ? err.message : String(err) });
			}
		});
		if (options?.signal?.aborted) return onAbort();
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		arm();
		translator.begin();
		void (async () => {
			try {
				if (plan.kind === "replay") {
					await binding.session.send(messageOptions(plan.prompt, vision));
				} else {
					if (plan.users.length) {
						await binding.session.send({ ...messageOptions(promptFromUsers(plan.users), vision), ...(binding.pending.size ? { mode: "immediate" as const } : {}) });
					}
					for (const result of plan.toolResults) {
						await binding.session.answer(binding.pending.get(result.toolCallId)!, toolAnswer(result, vision));
					}
				}
				binding.pending.clear();
			} catch (err) {
				finish({ kind: "error", message: err instanceof Error ? err.message : String(err) });
			}
		})();
	});
}

/** The pi stream function for every GitHub Copilot model. */
export function copilotStream(): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		void runCall(model, context, options, output);
		return output;
	};
}

async function runCall(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, output: AssistantMessageEventStream): Promise<void> {
	const translator = new CallTranslator(model, (event) => output.push(event));
	const conversation = conversationOf(context.messages);
	const spec: SessionSpec = {
		model: model.id,
		effort: effortFor(model, options?.reasoning),
		systemPrompt: getCurrentSystemPrompt(context.messages),
		tools: getCurrentTools(context.messages).map(declaration),
	};
	const scope = options?.sessionId;
	const key = `${scope ?? `once-${randomUUID()}`}:${digest(JSON.stringify([spec.systemPrompt, spec.tools]))}`;
	let outcome: Driven;
	try {
		outcome = await withLock(key, async () => {
			evictIdle();
			const port = await copilotRuntime();
			const { bindings } = registry();
			let binding = bindings.get(key);
			let plan: CallPlan = planCall(binding && !binding.dirty ? binding.consumed : undefined, conversation, new Set(binding?.pending.keys()));
			if (binding && plan.kind === "delta" && (binding.model !== spec.model || binding.effort !== spec.effort)) {
				try {
					await binding.session.setModel(spec.model, spec.effort);
					binding.model = spec.model;
					binding.effort = spec.effort;
				} catch (err) {
					plan = { kind: "rebuild", reason: `model switch failed: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
			let driven: Driven;
			if (plan.kind === "rebuild") {
				copilotDebug(`rebuild ${key} (${plan.reason}; ${conversation.length} messages)`);
				if (binding) dispose(binding);
				binding = bind(key, port, await port.createSession(spec), spec);
				binding.active = true;
				driven = await drive(binding, { kind: "replay", prompt: replayPrompt(conversation) }, translator, model, options);
			} else {
				binding!.active = true;
				copilotDebug(`delta ${key} (+${plan.toolResults.length} results, +${plan.users.length} user)`);
				driven = await drive(binding!, plan, translator, model, options);
			}
			const bound = binding!;
			bound.active = false;
			bound.lastUsed = Date.now();
			if ((driven.kind === "toolUse" || driven.kind === "stop") && scope) {
				bound.consumed = [...conversation.map(fingerprint), fingerprint(translator.message)];
				bound.pending = driven.kind === "toolUse" ? driven.requests : new Map();
			} else {
				// Failed, aborted or one-off: the session cannot be continued.
				if (driven.kind === "error") void bound.session.abort().catch(() => undefined);
				dispose(bound);
			}
			return driven;
		});
	} catch (err) {
		outcome = { kind: "error", message: err instanceof Error ? err.message : String(err) };
	}
	try {
		if (outcome.kind === "toolUse") {
			output.push({ type: "done", reason: "toolUse", message: translator.finish("toolUse") });
		} else if (outcome.kind === "stop") {
			output.push({ type: "done", reason: outcome.reason, message: translator.finish(outcome.reason) });
		} else if (outcome.kind === "aborted") {
			translator.begin();
			output.push({ type: "error", reason: "aborted", error: translator.finish("aborted", "Request was aborted") });
		} else {
			copilotDebug(`error: ${outcome.message}`);
			translator.begin();
			output.push({ type: "error", reason: "error", error: translator.finish("error", copilotErrorText(outcome.message, outcome.status)) });
		}
	} finally {
		output.end();
	}
}
