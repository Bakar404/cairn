import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels, normalizeContext, type Api, type AssistantMessage, type AssistantMessageEvent, type Message, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { MessageOptions, ModelInfo, SessionEvent } from "@github/copilot-sdk";
import { Type } from "typebox";
import { copilotModel, copilotStream, installCopilotRuntime, releaseCopilotSessions, toPiModel, type CopilotRuntimePort, type CopilotSessionPort, type SessionSpec, type ToolAnswer } from "../src/agent/copilot/index.ts";
import { effortFor } from "../src/agent/copilot/catalog.ts";
import { fingerprint, planCall, replayPrompt } from "../src/agent/copilot/replay.ts";
import { piEngineForSpec } from "../src/agent/models.ts";

const ev = (type: string, data: Record<string, unknown>) => ({ id: randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data }) as unknown as SessionEvent;

function info(id: string, over: { vision?: boolean; efforts?: string[]; policy?: string; noLimits?: boolean } = {}): ModelInfo {
	return {
		id,
		name: id.toUpperCase(),
		capabilities: {
			supports: { vision: over.vision ?? true, reasoningEffort: (over.efforts ?? ["low", "medium", "high"]).length > 0 },
			limits: over.noLimits ? {} : { max_prompt_tokens: 100_000, max_output_tokens: 8_000, max_context_window_tokens: 128_000 },
		},
		policy: { state: over.policy ?? "enabled", terms: "" },
		billing: { multiplier: 1, tokenPrices: { inputPrice: 300, outputPrice: 1500, cacheReadPrice: 30, cacheWritePrice: 375, batchSize: 1_000_000 } },
		supportedReasoningEfforts: over.efforts ?? ["low", "medium", "high"],
	} as unknown as ModelInfo;
}

type Reply = (session: FakeSession) => void;

class FakeSession implements CopilotSessionPort {
	readonly sessionId = `fake-${randomUUID()}`;
	readonly handlers = new Set<(event: SessionEvent) => void>();
	readonly log: string[] = [];
	readonly sends: MessageOptions[] = [];
	readonly answers: { requestId: string; result: ToolAnswer }[] = [];
	readonly outstanding = new Set<string>();
	constructor(
		readonly spec: SessionSpec,
		private readonly world: FakeWorld,
	) {}
	on(handler: (event: SessionEvent) => void) {
		this.handlers.add(handler);
		return () => void this.handlers.delete(handler);
	}
	emit(...events: SessionEvent[]) {
		for (const event of events) for (const handler of [...this.handlers]) handler(event);
	}
	async send(options: MessageOptions) {
		this.sends.push(options);
		this.log.push(options.mode ? `send:${options.mode}` : "send");
		if (!this.outstanding.size) this.world.respond(this);
		return "message-id";
	}
	async answer(requestId: string, result: ToolAnswer) {
		this.answers.push({ requestId, result });
		this.log.push(`answer:${requestId}`);
		this.outstanding.delete(requestId);
		if (!this.outstanding.size) this.world.respond(this);
	}
	async abort() {
		this.log.push("abort");
	}
	async setModel(model: string, effort?: string) {
		this.log.push(`setModel:${model}:${effort ?? ""}`);
	}
	async disconnect() {
		this.log.push("disconnect");
	}
}

class FakeWorld implements CopilotRuntimePort {
	readonly sessions: FakeSession[] = [];
	readonly deleted: string[] = [];
	readonly replies: Reply[] = [];
	respond(session: FakeSession) {
		const reply = this.replies.shift();
		if (reply) setImmediate(() => reply(session));
	}
	async authStatus() {
		return { isAuthenticated: true, login: "octo", authType: "gh-cli" as const };
	}
	async listModels() {
		return [info("fake-model"), info("blind-model", { vision: false })];
	}
	async createSession(spec: SessionSpec) {
		const session = new FakeSession(spec, this);
		this.sessions.push(session);
		return session;
	}
	async deleteSession(sessionId: string) {
		this.deleted.push(sessionId);
	}
	async listSessions() {
		return [];
	}
	async stop() {}
}

const textReply =
	(body: string, extra: { nanoAiu?: number; finishReason?: string } = {}): Reply =>
	(s) =>
		s.emit(
			ev("assistant.turn_start", { turnId: "t" }),
			ev("assistant.message_delta", { messageId: "m-text", deltaContent: body.slice(0, 3) }),
			ev("assistant.message_delta", { messageId: "m-text", deltaContent: body.slice(3) }),
			ev("assistant.usage", { model: "fake-model", inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, finishReason: extra.finishReason ?? "stop", ...(extra.nanoAiu ? { copilotUsage: { totalNanoAiu: extra.nanoAiu, tokenDetails: [] } } : {}) }),
			ev("assistant.message", { messageId: "m-text", content: body, toolRequests: [] }),
			ev("session.idle", {}),
		);

const toolReply =
	(calls: { id: string; name: string; args: Record<string, unknown> }[]): Reply =>
	(s) => {
		for (const call of calls) s.outstanding.add(`req-${call.id}`);
		s.emit(
			ev("assistant.turn_start", { turnId: "t" }),
			...calls.map((c) => ev("assistant.tool_call_delta", { toolCallId: c.id, toolName: c.name, inputDelta: JSON.stringify(c.args) })),
			ev("assistant.usage", { model: "fake-model", inputTokens: 50, outputTokens: 10, finishReason: "tool_calls" }),
			ev("assistant.message", { messageId: "m-tools", content: "", toolRequests: calls.map((c) => ({ toolCallId: c.id, name: c.name, arguments: c.args, type: "function" })) }),
			...calls.map((c) => ev("tool.execution_start", { toolCallId: c.id, toolName: c.name })),
			...calls.map((c) => ev("external_tool.requested", { requestId: `req-${c.id}`, toolCallId: c.id, toolName: c.name, arguments: c.args, sessionId: s.sessionId })),
		);
	};

const tools = [{ name: "get_weather", description: "Weather for one city.", parameters: Type.Object({ city: Type.String() }) }];

let world: FakeWorld;
function setup(): FakeWorld {
	world = new FakeWorld();
	installCopilotRuntime(world, { status: { state: "signed-in", login: "octo" }, models: [info("fake-model"), info("blind-model", { vision: false })] });
	return world;
}
afterEach(() => installCopilotRuntime(undefined));

async function run(model: Model<Api>, messages: Message[], options: { sessionId?: string; signal?: AbortSignal; reasoning?: "low" | "high" } = {}) {
	const stream = copilotStream()(model, normalizeContext({ systemPrompt: "Be brief.", messages, tools }), options);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: Date.now() });
const result = (msg: AssistantMessage, text: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage[] =>
	msg.content.flatMap((c) => (c.type === "toolCall" ? [{ role: "toolResult" as const, toolCallId: c.id, toolName: c.name, content: [{ type: "text" as const, text }], isError: false, timestamp: Date.now(), ...extra }] : []));

test("catalog: runtime models project onto pi models", () => {
	const model = toPiModel(info("m"))!;
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.contextWindow, 100_000);
	assert.equal(model.maxTokens, 8_000);
	assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high"]);
	assert.equal(effortFor(model, "high"), "high");
	assert.equal(effortFor(model, undefined), undefined);
	const optional = toPiModel(info("o", { efforts: ["none", "low"] }))!;
	assert.equal(effortFor(optional, undefined), "none");
	assert.deepEqual(getSupportedThinkingLevels(optional), ["off", "low"]);
	const plain = toPiModel(info("p", { efforts: [], vision: false }))!;
	assert.equal(plain.reasoning, false);
	assert.deepEqual(plain.input, ["text"]);
	assert.equal(toPiModel(info("auto", { noLimits: true })), undefined);
	assert.equal(toPiModel(info("off", { policy: "disabled" })), undefined);
});

test("text reply streams, maps usage and bills AI credits", async () => {
	setup();
	world.replies.push(textReply("Hello there", { nanoAiu: 2_500_000_000 }));
	const { events, message } = await run(copilotModel("fake-model")!, [user("hi")], { sessionId: randomUUID() });
	assert.deepEqual(
		events.map((e) => e.type),
		["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
	);
	assert.equal(message.stopReason, "stop");
	assert.equal(message.provider, "copilot");
	assert.deepEqual(message.content, [{ type: "text", text: "Hello there" }]);
	assert.equal(message.usage.input, 60);
	assert.equal(message.usage.cacheRead, 40);
	assert.equal(message.usage.output, 20);
	assert.equal(message.usage.cost.total, 0.025);
	assert.equal(world.sessions.length, 1);
	assert.equal(world.sessions[0]!.spec.systemPrompt, "Be brief.");
	assert.deepEqual(world.sessions[0]!.spec.tools.map((t) => t.name), ["get_weather"]);
	assert.equal(world.sessions[0]!.sends[0]!.prompt, "hi");
});

test("finishReason length maps to a length stop", async () => {
	setup();
	world.replies.push(textReply("Cut", { finishReason: "length" }));
	const { message } = await run(copilotModel("fake-model")!, [user("hi")], { sessionId: randomUUID() });
	assert.equal(message.stopReason, "length");
});

test("tool rounds continue the same session: results answer pending calls, users are prompts", async () => {
	setup();
	const sessionId = randomUUID();
	const model = copilotModel("fake-model")!;
	const messages: Message[] = [user("Paris and Tokyo?")];
	world.replies.push(toolReply([{ id: "c1", name: "get_weather", args: { city: "Paris" } }, { id: "c2", name: "get_weather", args: { city: "Tokyo" } }]));
	const first = await run(model, messages, { sessionId });
	assert.equal(first.message.stopReason, "toolUse");
	assert.deepEqual(
		first.message.content.map((c) => (c.type === "toolCall" ? [c.id, c.arguments] : c.type)),
		[["c1", { city: "Paris" }], ["c2", { city: "Tokyo" }]],
	);
	messages.push(first.message, ...result(first.message, "18C"));

	world.replies.push(textReply("Both 18C."));
	const second = await run(model, messages, { sessionId });
	assert.equal(second.message.stopReason, "stop");
	const session = world.sessions[0]!;
	assert.equal(world.sessions.length, 1, "no rebuild");
	assert.deepEqual(session.log, ["send", "answer:req-c1", "answer:req-c2"]);
	assert.deepEqual(session.answers[0]!.result, { textResultForLlm: "18C", resultType: "success" });
	messages.push(second.message, user("And Berlin?"));

	world.replies.push(toolReply([{ id: "c3", name: "get_weather", args: { city: "Berlin" } }]));
	const third = await run(model, messages, { sessionId });
	assert.equal(third.message.stopReason, "toolUse");
	assert.equal(session.sends.at(-1)!.prompt, "And Berlin?");
	assert.equal(session.sends.at(-1)!.mode, undefined);

	// A learner message that lands with the tool result steers the call.
	messages.push(third.message, ...result(third.message, "11C"), user("In Fahrenheit too."));
	world.replies.push(textReply("51.8F"));
	const fourth = await run(model, messages, { sessionId });
	assert.equal(fourth.message.stopReason, "stop");
	assert.deepEqual(session.log.slice(-2), ["send:immediate", "answer:req-c3"]);
	assert.equal(world.sessions.length, 1, "still no rebuild");
	releaseCopilotSessions(sessionId);
});

test("an edited transcript rebuilds the session from a replay", async () => {
	setup();
	const sessionId = randomUUID();
	const model = copilotModel("fake-model")!;
	const messages: Message[] = [user("first question")];
	world.replies.push(textReply("first answer"));
	messages.push((await run(model, messages, { sessionId })).message);
	// Compaction-style rewrite: the history no longer matches the session.
	const rewritten: Message[] = [user("summary of earlier work"), user("next question")];
	world.replies.push(textReply("ok"));
	await run(model, rewritten, { sessionId });
	assert.equal(world.sessions.length, 2);
	assert.ok(world.deleted.includes(world.sessions[0]!.sessionId), "old session deleted");
	const prompt = world.sessions[1]!.sends[0]!.prompt;
	assert.match(prompt, /<conversation_history>\n<user>\nsummary of earlier work\n<\/user>\n<\/conversation_history>/);
	assert.ok(prompt.endsWith("next question"));
	releaseCopilotSessions(sessionId);
});

test("model and effort changes reuse the session through setModel", async () => {
	setup();
	world.replies.push(textReply("a"), textReply("b"));
	const sessionId = randomUUID();
	const messages: Message[] = [user("q1")];
	messages.push((await run(copilotModel("fake-model")!, messages, { sessionId })).message, user("q2"));
	await run(copilotModel("blind-model")!, messages, { sessionId, reasoning: "high" });
	assert.equal(world.sessions.length, 1);
	assert.ok(world.sessions[0]!.log.includes("setModel:blind-model:high"));
	releaseCopilotSessions(sessionId);
});

test("one-off calls (no sessionId) delete their session afterwards", async () => {
	setup();
	world.replies.push(textReply("summary"));
	const { message } = await run(copilotModel("fake-model")!, [user("summarize")]);
	assert.equal(message.stopReason, "stop");
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(world.deleted, [world.sessions[0]!.sessionId]);
});

test("abort ends the call as aborted and the next call rebuilds", async () => {
	setup();
	const sessionId = randomUUID();
	const controller = new AbortController();
	world.replies.push((s) => {
		s.emit(ev("assistant.message_delta", { messageId: "m", deltaContent: "Once upon" }));
		controller.abort();
	});
	const messages: Message[] = [user("long story")];
	const { events, message } = await run(copilotModel("fake-model")!, messages, { sessionId, signal: controller.signal });
	assert.equal(message.stopReason, "aborted");
	assert.equal(events.at(-1)!.type, "error");
	assert.ok(world.sessions[0]!.log.includes("abort"));
	messages.push(message, user("again"));
	world.replies.push(textReply("fine"));
	const next = await run(copilotModel("fake-model")!, messages, { sessionId });
	assert.equal(next.message.stopReason, "stop");
	assert.equal(world.sessions.length, 2);
	releaseCopilotSessions(sessionId);
});

test("session errors surface as friendly errors", async () => {
	setup();
	world.replies.push((s) => s.emit(ev("session.error", { errorType: "quota", message: "You have exceeded your premium request quota", statusCode: 429 })));
	const { message } = await run(copilotModel("fake-model")!, [user("hi")], { sessionId: randomUUID() });
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /usage limit/);
});

test("tool images reach vision models and are described to others", async () => {
	setup();
	const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
	for (const id of ["fake-model", "blind-model"]) {
		const sessionId = randomUUID();
		const model = copilotModel(id)!;
		const messages: Message[] = [user("draw")];
		world.replies.push(toolReply([{ id: `img-${id}`, name: "get_weather", args: { city: "x" } }]));
		const first = await run(model, messages, { sessionId });
		messages.push(first.message, ...result(first.message, "", { content: [image] }));
		world.replies.push(textReply("seen"));
		await run(model, messages, { sessionId });
		const answer = world.sessions.at(-1)!.answers[0]!.result;
		if (id === "fake-model") {
			assert.deepEqual(answer.binaryResultsForLlm, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		} else {
			assert.equal(answer.binaryResultsForLlm, undefined);
			assert.match(answer.textResultForLlm, /1 image\(s\) omitted/);
		}
		releaseCopilotSessions(sessionId);
	}
});

test("planCall only continues an exact prefix with answered calls", () => {
	const u1 = user("a") as Exclude<Message, { role: "system" }>;
	const consumed = [fingerprint(u1)];
	const foreign: AssistantMessage = { role: "assistant", api: "x", provider: "x", model: "x", content: [], stopReason: "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	assert.equal(planCall(consumed, [u1, foreign], new Set()).kind, "rebuild");
	const orphan: ToolResultMessage = { role: "toolResult", toolCallId: "nope", toolName: "t", content: [], isError: false, timestamp: 0 };
	assert.deepEqual(planCall(consumed, [u1, orphan], new Set()), { kind: "rebuild", reason: "tool result without a pending call" });
	assert.deepEqual(planCall(consumed, [u1, user("b") as Exclude<Message, { role: "system" }>], new Set(["c9"])), { kind: "rebuild", reason: "unanswered tool call" });
	assert.equal(planCall(consumed, [u1, user("b") as Exclude<Message, { role: "system" }>], new Set()).kind, "delta");
	assert.equal(replayPrompt([u1]).text, "a");
});

test("engines resolve Copilot specs; a provisional model stands in before the catalog loads", () => {
	installCopilotRuntime(undefined);
	const early = piEngineForSpec({ provider: "copilot", id: "some-model" });
	assert.equal(early.model.provider, "copilot");
	assert.equal(early.model.id, "some-model");
	setup();
	const engine = piEngineForSpec({ provider: "copilot", id: "fake-model", thinkingLevel: "xhigh" });
	assert.equal(engine.model.contextWindow, 100_000);
	assert.equal(engine.level, "high");
	assert.throws(() => piEngineForSpec({ provider: "copilot", id: "missing" }), /no model missing/);
});
