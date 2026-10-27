/**
 * The GitHub Copilot runtime: one process-wide Copilot SDK client, the
 * signed-in status and model catalog it reports, and the Copilot sessions
 * Cairn's pi loops are bound to.
 *
 * Auth is the SDK's own: COPILOT_GITHUB_TOKEN when set, else the accounts
 * the runtime knows — signed in through Cairn's "Sign in with GitHub"
 * (the runtime's browser sign-in, credentials kept by the runtime in the
 * system keychain, see accounts.ts) or the signed-in GitHub CLI / Copilot
 * CLI user. GITHUB_TOKEN, GH_TOKEN and every
 * *_API_KEY are withheld from the runtime so an unrelated token in the
 * shell (CI tokens, PATs without Copilot access) never shadows the user's
 * own sign-in. Sessions run in "empty" mode with only Cairn's tools
 * available (a web search session also gets Copilot's hosted web_search),
 * inside an empty workspace under the data folder; they never
 * touch the user's own Copilot CLI history.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CopilotSession, GetAuthStatusResponse, MessageOptions, ModelInfo, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { PATHS } from "../../../config.ts";
import type { CopilotStatus } from "../../core/contracts/copilot.ts";
import packageMetadata from "../../../package.json" with { type: "json" };
import { COPILOT_API, COPILOT_PROVIDER, toPiModels } from "./catalog.ts";

export interface ToolDeclaration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface SessionSpec {
	model: string;
	effort?: string;
	systemPrompt: string;
	tools: ToolDeclaration[];
	/** Copilot-hosted MCP tools to enable, by bare name (e.g. "web_search").
	 *  Copilot runs these itself; they never reach Cairn as tool requests. */
	mcpTools?: string[];
}

export interface ToolAnswer {
	textResultForLlm: string;
	resultType: "success" | "failure";
	error?: string;
	binaryResultsForLlm?: { type: "image"; data: string; mimeType: string }[];
}

/** The slice of a Copilot session the stream drives (a test fake replaces it). */
export interface CopilotSessionPort {
	readonly sessionId: string;
	on(handler: (event: SessionEvent) => void): () => void;
	send(options: MessageOptions): Promise<unknown>;
	abort(): Promise<void>;
	setModel(model: string, effort?: string): Promise<void>;
	answer(requestId: string, result: ToolAnswer): Promise<void>;
	disconnect(): Promise<void>;
}

/** A runtime account, credential-free. */
export interface RuntimeAccount {
	selectionId: string;
	login: string;
	host: string;
	/** The runtime's AccountKind ("githubDotCom", "proxima", …). */
	kind: string;
	active: boolean;
	/** Set for credentials the runtime found elsewhere ("gh", "GITHUB_TOKEN"). */
	authSource?: string;
}

/** One step of a runtime sign-in flow (the SDK's AuthLoginStep, narrowed). */
export type RuntimeLoginStep =
	| { kind: "open-url"; url: string }
	| { kind: "input-required"; prompt: string }
	| { kind: "awaiting" }
	| { kind: "needs-interaction" }
	| {
		kind: "completed";
		result: { status: string; host?: string; login?: string; accounts?: { selectionId: string; host: string; login: string; kind: string }[] };
	}
	| { kind: "error"; message: string };

/** The runtime's account manager: the Copilot CLI's own sign-in, with
 *  credentials kept by the runtime (a test fake replaces it). */
export interface CopilotAccountsPort {
	list(): Promise<RuntimeAccount[]>;
	/** The active account's Copilot plan, when GitHub reports one. */
	plan(): Promise<string | undefined>;
	begin(kind: "githubDotCom" | "proxima"): Promise<{ flowId: string; step: RuntimeLoginStep }>;
	/** Blocks until the flow moves on (e.g. the browser callback lands). */
	advance(flowId: string, input?: string): Promise<RuntimeLoginStep>;
	cancel(flowId: string): Promise<void>;
	switchTo(selectionId: string): Promise<void>;
	logout(selectionId: string): Promise<void>;
}

/** The slice of the Copilot client Cairn uses (a test fake replaces it). */
export interface CopilotRuntimePort {
	authStatus(): Promise<GetAuthStatusResponse>;
	listModels(): Promise<ModelInfo[]>;
	createSession(spec: SessionSpec): Promise<CopilotSessionPort>;
	deleteSession(sessionId: string): Promise<void>;
	listSessions(): Promise<{ sessionId: string; modifiedTime: Date }[]>;
	/** Sign-in and account switching; absent on runtimes that cannot. */
	accounts?: CopilotAccountsPort;
	stop(): Promise<void>;
}

export type { CopilotStatus };

type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;

const STATUS_TTL_MS = 60_000;
const MODELS_TTL_MS = 10 * 60_000;
const STALE_SESSION_MS = 6 * 60 * 60_000;
const WITHHELD_ENV = /^(GITHUB_TOKEN|GH_TOKEN|.+_API_KEY)$/;

interface RuntimeState {
	port?: CopilotRuntimePort;
	starting?: Promise<CopilotRuntimePort>;
	fake: boolean;
	status: CopilotStatus;
	statusAt: number;
	models: Model<Api>[];
	modelsAt: number;
	modelsLoaded: boolean;
	refreshing?: Promise<CopilotStatus>;
}

const STATE_KEY = Symbol.for("cairn.copilot.runtime");
type Holder = typeof globalThis & { [STATE_KEY]?: RuntimeState };

/** Survives dev hot reloads: one runtime process per server process. */
function state(): RuntimeState {
	const holder = globalThis as Holder;
	holder[STATE_KEY] ??= { fake: false, status: { state: "unknown" }, statusAt: 0, models: [], modelsAt: 0, modelsLoaded: false };
	return holder[STATE_KEY];
}

export function copilotDebug(message: string): void {
	if (process.env.LH_COPILOT_DEBUG === "1") console.info(`[copilot] ${message}`);
}

function runtimeEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(process.env)) if (!WITHHELD_ENV.test(key)) env[key] = value;
	return env;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

type SdkLoginStep = Awaited<ReturnType<CopilotSession["rpc"]["accounts"]["login"]["advance"]>>;

/** Copies only the fields Cairn uses, so nothing else the runtime adds can
 *  travel further. */
function toLoginStep(step: SdkLoginStep): RuntimeLoginStep {
	switch (step.kind) {
		case "open-url":
			return { kind: "open-url", url: step.url };
		case "input-required":
			return { kind: "input-required", prompt: step.prompt };
		case "completed": {
			const { status, host, login, accounts } = step.result;
			return {
				kind: "completed",
				result: {
					status,
					...(host ? { host } : {}),
					...(login ? { login } : {}),
					...(accounts ? { accounts: accounts.map((a) => ({ selectionId: a.selectionId, host: a.host, login: a.login, kind: a.kind })) } : {}),
				},
			};
		}
		case "error":
			return { kind: "error", message: step.message };
		default:
			return { kind: step.kind };
	}
}

const COPILOT_PLAN = /^[a-z0-9_-]{1,40}$/i;

/** The runtime's answer once it no longer has a session (it restarted, or
 *  the session was deleted). Matched against the reason only: the runtime
 *  words errors "Request <method> failed with message: <reason>", and every
 *  account method's name starts with "session.". */
const SESSION_GONE = /^(?:GenericFailure,\s*)?(?:Session not found\b|request for unregistered session)/i;

function rpcReason(err: unknown): string {
	return errorText(err).replace(/^Request \S+ failed with message:\s*/, "");
}

/** The account manager over session-scoped RPCs: they all reach the
 *  runtime's one account manager, so a tool-less session carries them.
 *  Exported for tests. */
export function sdkAccounts(open: () => Promise<CopilotSession>): CopilotAccountsPort & { close(): Promise<string | undefined> } {
	let session: Promise<CopilotSession> | undefined;
	function opened(): Promise<CopilotSession> {
		if (!session) {
			const opening: Promise<CopilotSession> = open().catch((err: unknown) => {
				if (session === opening) session = undefined;
				throw err;
			});
			session = opening;
		}
		return session;
	}
	/** A session the runtime lost is let go, and the call tried once on a new
	 *  one. Sign-in steps are not retried: a sign-in belongs to the session
	 *  that began it, so it ended with that session. */
	async function call<T>(run: (rpc: CopilotSession["rpc"]["accounts"]) => Promise<T>, retry = true): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const pending = opened();
			const current = await pending;
			try {
				return await run(current.rpc.accounts);
			} catch (err) {
				if (!SESSION_GONE.test(rpcReason(err))) throw err;
				// Another call may have replaced it already.
				if (session === pending) {
					session = undefined;
					void current.disconnect().catch(() => undefined);
				}
				if (!retry || attempt > 0) throw err;
			}
		}
	}
	async function write(command: Parameters<CopilotSession["rpc"]["accounts"]["set"]>[0]["command"], failure: string): Promise<void> {
		const result = await call((rpc) => rpc.set({ command }));
		if (!result.ok) throw new Error(failure);
	}
	return {
		list: () =>
			call(async (rpc) => {
				const value = await rpc.enumerate({ query: { kind: "accounts" } });
				if (value.kind !== "accounts") return [];
				return value.items.map((a) => ({ selectionId: a.selectionId, login: a.login, host: a.host, kind: a.kind, active: a.active, ...(a.authSource ? { authSource: a.authSource } : {}) }));
			}),
		plan: () =>
			call(async (rpc) => {
				const value = await rpc.get({ query: { kind: "activeAccount" } });
				// Only the plan name leaves here: authInfo can carry credentials.
				const plan: unknown = value.kind === "activeAccount" ? (value.authInfo as { copilotUser?: { copilot_plan?: unknown } } | undefined)?.copilotUser?.copilot_plan : undefined;
				return typeof plan === "string" && COPILOT_PLAN.test(plan) ? plan : undefined;
			}),
		begin: (kind) =>
			call(async (rpc) => {
				const begun = await rpc.login.begin({ kind });
				return { flowId: begun.flowId, step: toLoginStep(begun.step) };
			}),
		advance: (flowId, input) => call(async (rpc) => toLoginStep(await rpc.login.advance({ flowId, ...(input !== undefined ? { input } : {}) })), false),
		cancel: (flowId) => call((rpc) => rpc.login.cancel({ flowId }), false),
		switchTo: (selectionId) => write({ kind: "switchActive", selectionId }, "GitHub Copilot could not switch to that account."),
		logout: (selectionId) => write({ kind: "logout", selectionId }, "GitHub Copilot could not sign that account out."),
		async close() {
			const current = await session?.catch(() => undefined);
			session = undefined;
			if (!current) return undefined;
			await current.disconnect().catch(() => undefined);
			return current.sessionId;
		},
	};
}

async function startSdkRuntime(): Promise<CopilotRuntimePort> {
	const { CopilotClient, ToolSet, approveAll } = await import("@github/copilot-sdk");
	const home = path.join(PATHS.data, "copilot");
	const workspace = path.join(home, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const client = new CopilotClient({
		mode: "empty",
		baseDirectory: home,
		workingDirectory: workspace,
		logLevel: "error",
		env: runtimeEnv(),
		clientInfo: { applicationName: "cairn", applicationVersion: packageMetadata.version },
	});
	await client.start();
	const accounts = sdkAccounts(() =>
		client.createSession({
			onPermissionRequest: approveAll,
			availableTools: new ToolSet(),
			workingDirectory: workspace,
			infiniteSessions: { enabled: false },
			clientName: "cairn",
		}),
	);
	const { close: closeAccounts, ...accountsPort } = accounts;
	return {
		authStatus: () => client.getAuthStatus(),
		listModels: () => client.listModels(),
		async createSession(spec) {
			let availableTools = new ToolSet().addCustom("*");
			for (const name of spec.mcpTools ?? []) availableTools = availableTools.addMcp(name);
			const session = await client.createSession({
				model: spec.model,
				...(spec.effort ? { reasoningEffort: spec.effort as ReasoningEffort } : {}),
				streaming: true,
				systemMessage: { mode: "replace", content: spec.systemPrompt },
				availableTools,
				// Cairn's tools are the only tools; some share a built-in's name (grep).
				tools: spec.tools.map((tool) => ({ ...tool, overridesBuiltInTool: true, skipPermission: true, defer: "never" as const })),
				onPermissionRequest: approveAll,
				workingDirectory: workspace,
				infiniteSessions: { enabled: false },
				clientName: "cairn",
			});
			return {
				sessionId: session.sessionId,
				on: (handler) => session.on(handler),
				send: (options) => session.send(options),
				abort: () => session.abort(),
				setModel: (model, effort) => session.setModel(model, effort ? { reasoningEffort: effort as ReasoningEffort } : undefined),
				answer: async (requestId, result) => {
					await session.rpc.tools.handlePendingToolCall({ requestId, result });
				},
				disconnect: () => session.disconnect(),
			};
		},
		deleteSession: (sessionId) => client.deleteSession(sessionId),
		listSessions: async () => (await client.listSessions()).map((s) => ({ sessionId: s.sessionId, modifiedTime: new Date(s.modifiedTime) })),
		accounts: accountsPort,
		stop: async () => {
			const accountsSession = await closeAccounts();
			if (accountsSession) await client.deleteSession(accountsSession).catch(() => undefined);
			await client.stop();
		},
	};
}

/** Delete sessions an earlier server process left behind. */
async function sweepStaleSessions(port: CopilotRuntimePort): Promise<void> {
	try {
		const cutoff = Date.now() - STALE_SESSION_MS;
		for (const session of await port.listSessions()) {
			if (session.modifiedTime.getTime() < cutoff) await port.deleteSession(session.sessionId).catch(() => undefined);
		}
	} catch (err) {
		copilotDebug(`stale-session sweep failed: ${errorText(err)}`);
	}
}

/** The started runtime (lazy). Throws when it cannot start; under tests
 *  only an installed fake ever answers. */
export async function copilotRuntime(): Promise<CopilotRuntimePort> {
	const s = state();
	if (s.port) return s.port;
	if (process.env.NODE_ENV === "test") throw new Error("GitHub Copilot runtime is not available under tests");
	s.starting ??= startSdkRuntime().then(
		(port) => {
			s.port = port;
			s.starting = undefined;
			void sweepStaleSessions(port);
			return port;
		},
		(err: unknown) => {
			s.starting = undefined;
			throw err;
		},
	);
	return s.starting;
}

function toStatus(auth: GetAuthStatusResponse): CopilotStatus {
	return auth.isAuthenticated
		? { state: "signed-in", ...(auth.login ? { login: auth.login } : {}), ...(auth.authType ? { authType: auth.authType } : {}), ...(auth.host ? { host: auth.host } : {}) }
		: { state: "signed-out", ...(auth.statusMessage ? { message: auth.statusMessage } : {}) };
}

/** Refresh the cached status (and, when signed in, the model catalog).
 *  Cheap when fresh; `force` re-asks the runtime (the "Check again" path).
 *  Never throws: failures land in the status. Under tests without a fake
 *  runtime this is a no-op. */
export async function refreshCopilot(options: { force?: boolean } = {}): Promise<CopilotStatus> {
	const s = state();
	if (process.env.NODE_ENV === "test" && !s.fake) return s.status;
	// A forced refresh must read the runtime after the call (a sign-in that
	// just landed), not join a refresh that started before it.
	if (options.force && s.refreshing) await s.refreshing;
	const now = Date.now();
	const statusFresh = s.status.state !== "unknown" && now - s.statusAt < STATUS_TTL_MS;
	const modelsFresh = s.status.state !== "signed-in" || now - s.modelsAt < MODELS_TTL_MS;
	if (!options.force && statusFresh && modelsFresh) return s.status;
	s.refreshing ??= (async () => {
		try {
			const port = await copilotRuntime();
			s.status = toStatus(await port.authStatus());
			s.statusAt = Date.now();
			if (s.status.state === "signed-in" && (options.force || !s.modelsLoaded || Date.now() - s.modelsAt >= MODELS_TTL_MS)) {
				s.models = toPiModels(await port.listModels());
				s.modelsAt = Date.now();
				s.modelsLoaded = true;
			}
		} catch (err) {
			copilotDebug(`refresh failed: ${errorText(err)}`);
			s.status = { state: "unavailable", message: errorText(err) };
			s.statusAt = Date.now();
		} finally {
			s.refreshing = undefined;
		}
		return s.status;
	})();
	return s.refreshing;
}

/** The last known status (sync; refreshCopilot updates it). */
export function copilotStatus(): CopilotStatus {
	return state().status;
}

export function copilotSignedIn(): boolean {
	return state().status.state === "signed-in";
}

/** The signed-in user's models (sync; empty until a refresh lands). */
export function copilotModels(): Model<Api>[] {
	const s = state();
	return s.status.state === "signed-in" ? s.models : [];
}

/** One model by id. Before the first catalog load (a fresh server process
 *  resuming background work) a provisional entry stands in; the runtime
 *  itself rejects an id the account cannot use. */
export function copilotModel(id: string): Model<Api> | undefined {
	const s = state();
	const known = s.models.find((m) => m.id === id);
	if (known || s.modelsLoaded) return known;
	return {
		id,
		name: id,
		api: COPILOT_API,
		provider: COPILOT_PROVIDER,
		baseUrl: "",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

/** Test seam: install a fake runtime (or remove it with undefined). */
export function installCopilotRuntime(port: CopilotRuntimePort | undefined, seed?: { status?: CopilotStatus; models?: ModelInfo[] }): void {
	const s = state();
	s.port = port;
	s.fake = port !== undefined;
	s.starting = undefined;
	s.refreshing = undefined;
	s.status = seed?.status ?? { state: "unknown" };
	s.statusAt = seed?.status ? Date.now() : 0;
	s.models = seed?.models ? toPiModels(seed.models) : [];
	s.modelsAt = seed?.models ? Date.now() : 0;
	s.modelsLoaded = seed?.models !== undefined;
}
