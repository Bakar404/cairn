/**
 * The GitHub Copilot runtime: one process-wide Copilot SDK client, the
 * signed-in status and model catalog it reports, and the Copilot sessions
 * Cairn's pi loops are bound to.
 *
 * Auth is the SDK's own: COPILOT_GITHUB_TOKEN when set, else the signed-in
 * GitHub CLI / Copilot CLI user. GITHUB_TOKEN, GH_TOKEN and every
 * *_API_KEY are withheld from the runtime so an unrelated token in the
 * shell (CI tokens, PATs without Copilot access) never shadows the user's
 * own sign-in. Sessions run in "empty" mode with only Cairn's tools
 * available, inside an empty workspace under the data folder; they never
 * touch the user's own Copilot CLI history.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { GetAuthStatusResponse, MessageOptions, ModelInfo, SessionConfig, SessionEvent } from "@github/copilot-sdk";
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

/** The slice of the Copilot client Cairn uses (a test fake replaces it). */
export interface CopilotRuntimePort {
	authStatus(): Promise<GetAuthStatusResponse>;
	listModels(): Promise<ModelInfo[]>;
	createSession(spec: SessionSpec): Promise<CopilotSessionPort>;
	deleteSession(sessionId: string): Promise<void>;
	listSessions(): Promise<{ sessionId: string; modifiedTime: Date }[]>;
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
	return {
		authStatus: () => client.getAuthStatus(),
		listModels: () => client.listModels(),
		async createSession(spec) {
			const session = await client.createSession({
				model: spec.model,
				...(spec.effort ? { reasoningEffort: spec.effort as ReasoningEffort } : {}),
				streaming: true,
				systemMessage: { mode: "replace", content: spec.systemPrompt },
				availableTools: new ToolSet().addCustom("*"),
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
		stop: async () => {
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
