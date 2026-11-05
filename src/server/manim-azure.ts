import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { MediaRef } from "../core/contracts.ts";
import {
	MANIM_IMAGE,
	MANIM_MAX_OUTPUT_BYTES,
	MANIM_RENDER_TIMEOUT_MS,
	type ManimRenderer,
	type ManimRenderMode,
	type ManimRenderRequest,
	type ManimRenderResult,
	type ManimState,
	type ManimStatus,
} from "../core/manim.ts";

/**
 * THE AZURE MANIM ADAPTER: core/manim.ts's ManimRenderer for a hosted copy
 * of Cairn, where there is no Docker engine to drive. Each render is one
 * execution of an Azure Container Apps job that runs the same pinned image
 * and the same runner as the Docker adapter. src/server/manim.ts picks it
 * when CAIRN_MANIM_BACKEND=azure-job and hands it the shared parts (the
 * kit): the bundle, the frame parser and media saving, and the render slots.
 *
 * TRANSPORT: Blob Storage instead of stdin/stdout. Cairn uploads the JSON
 * bundle the Docker adapter writes to stdin, then starts an execution whose
 * environment holds two single-blob SAS URLs: read that bundle, write one
 * output blob. In the container a small supervisor (AZURE_BOOTSTRAP) runs
 * the runner under the render's time and size limits and uploads one
 * `CAIRN-RUN <json>` line (exit code, timeout, overflow, stderr tail)
 * followed by the runner's framed stdout. Cairn polls the execution,
 * downloads that blob, and deletes both blobs; the container's lifecycle
 * rule deletes anything a failure leaves behind.
 *
 * SANDBOX: set by the deployment, not here. The job's subnet denies the
 * internet, so a scene reaches only Azure platform endpoints. The job's
 * identity can pull the image and nothing else, and no token for it is
 * available inside the container. The SAS URLs are the only credentials a
 * scene can find; each covers one blob for a few minutes.
 *
 * AUTH: Cairn's own managed identity, no keys. An ARM token to read,
 * start and stop the job, and a Storage token for the blobs and for the
 * user delegation key that signs the SAS URLs.
 *
 * STATE: the token, delegation-key and status caches live in the
 * factory's closure; the render slots are the Docker adapter's.
 */

const ARM = "https://management.azure.com";
const ARM_API_VERSION = "2025-07-01";
/** Pinned: blobSas signs this version's string-to-sign layout. */
const BLOB_API_VERSION = "2024-11-04";
const ARM_RESOURCE = "https://management.azure.com/";
const STORAGE_RESOURCE = "https://storage.azure.com/";
const IDENTITY_API_VERSION = "2019-08-01";

/** Chat and job ids, checked as the Docker adapter checks them. */
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const JOB_ID_RE =
	/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[\w.()-]{1,90}\/providers\/Microsoft\.App\/jobs\/[a-z][a-z0-9-]{0,30}[a-z0-9]$/i;
const ACCOUNT_RE = /^[a-z0-9]{3,24}$/;
const CONTAINER_RE = /^(?=.{3,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const EXECUTION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

const STATUS_TTL_MS = 30_000;
const POLL_MS = 3_000;
/** On top of the render's own limit: scheduling a replica, pulling the
 *  image on a cold start, and the transfers either side. */
const STARTUP_MS = 6 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;
const START_TIMEOUT_MS = 2 * 60_000;
/** Tokens are renewed this long before they expire. */
const TOKEN_EARLY_MS = 5 * 60_000;
const KEY_LIFETIME_MS = 2 * 60 * 60_000;
/** A delegation key is reused while it has at least this long left. */
const KEY_MIN_LEFT_MS = 30 * 60_000;
/** SAS start times are back-dated this much for clock skew. */
const CLOCK_SKEW_MS = 5 * 60_000;
const MAX_POLL_FAILURES = 5;
/** Room for the CAIRN-RUN line ahead of the runner's output. */
const HEADER_MAX = 256 * 1024;
const HEADER_PREFIX = "CAIRN-RUN ";
const TERMINAL = new Set(["Succeeded", "Failed", "Stopped"]);
const READY = "Ready. Animations render in Azure, in a sandboxed Container Apps job.";

// ─── Configuration ─────────────────────────────────────────────────────────

export interface AzureManimConfig {
	/** The Container Apps job's ARM resource id. */
	jobId: string;
	/** The storage account that carries bundles and renders. */
	storageAccount: string;
	/** Its blob container. */
	container: string;
	/** The client id of the user-assigned identity Cairn runs as; absent
	 *  for a system-assigned one. */
	clientId?: string;
}

/** The Azure renderer's settings: CAIRN_MANIM_JOB_ID,
 *  CAIRN_MANIM_STORAGE_ACCOUNT, CAIRN_MANIM_CONTAINER (default renders)
 *  and CAIRN_MANIM_CLIENT_ID. Throws one sentence naming every problem. */
export function azureManimConfigFromEnv(env: Readonly<Record<string, string | undefined>>): AzureManimConfig {
	const jobId = env.CAIRN_MANIM_JOB_ID?.trim() ?? "";
	const storageAccount = env.CAIRN_MANIM_STORAGE_ACCOUNT?.trim() ?? "";
	const container = env.CAIRN_MANIM_CONTAINER?.trim() || "renders";
	const clientId = env.CAIRN_MANIM_CLIENT_ID?.trim() ?? "";
	const problems: string[] = [];
	if (!jobId) problems.push("CAIRN_MANIM_JOB_ID is not set");
	else if (!JOB_ID_RE.test(jobId)) problems.push("CAIRN_MANIM_JOB_ID isn't a Container Apps job's resource id");
	if (!storageAccount) problems.push("CAIRN_MANIM_STORAGE_ACCOUNT is not set");
	else if (!ACCOUNT_RE.test(storageAccount)) problems.push("CAIRN_MANIM_STORAGE_ACCOUNT isn't a storage account name");
	if (!CONTAINER_RE.test(container)) problems.push("CAIRN_MANIM_CONTAINER isn't a blob container name");
	if (clientId && !GUID_RE.test(clientId)) problems.push("CAIRN_MANIM_CLIENT_ID isn't a client id");
	if (problems.length) throw new Error(`${problems.join("; ")}.`);
	const config: AzureManimConfig = { jobId, storageAccount, container };
	if (clientId) config.clientId = clientId;
	return config;
}

/** What the Docker adapter shares with this one (src/server/manim.ts). */
export interface AzureManimKit {
	/** The JSON bundle the runner reads: { mode, files }. */
	bundle(mode: ManimRenderMode, code: string): string;
	/** The runner's framed stdout as the mode's result, saving what the
	 *  chat keeps; null when it holds no result line. */
	finish(req: ManimRenderRequest, stdout: Buffer): ManimRenderResult | null;
	/** Run one render in one of the process-wide render slots. */
	withSlot<T>(signal: AbortSignal | undefined, render: () => Promise<T>): Promise<T>;
	saveDescriptions(chatId: string, jobId: string, vtt: string): MediaRef;
}

export interface AccessToken {
	token: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

export interface AzureManimDeps {
	fetch: typeof fetch;
	/** An Entra token for a resource. Default: App Service's managed
	 *  identity endpoint (IDENTITY_ENDPOINT and IDENTITY_HEADER in env). */
	getToken: (resource: string) => Promise<AccessToken>;
	env: Readonly<Record<string, string | undefined>>;
	now: () => number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** A short random suffix for blob names. */
	randomId: () => string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function abortError(message = "Manim render aborted"): Error {
	const err = new Error(message);
	err.name = "AbortError";
	return err;
}

/** Text on one line, ending as a sentence. */
function sentence(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return "";
	return /[.!?]$/.test(line) ? line : `${line}.`;
}

function lastLines(text: string, count: number): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(-count)
		.join("\n");
}

function makeStatus(state: ManimState, reason: string): ManimStatus {
	return { state, reason, image: MANIM_IMAGE };
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function drain(res: Response): Promise<void> {
	try {
		await res.body?.cancel();
	} catch {
		// already read or closed
	}
}

/** An Azure error answer as one line: ARM's JSON or Storage's XML. */
async function httpError(who: string, res: Response): Promise<Error> {
	const text = await res.text().catch(() => "");
	let parts: unknown[];
	try {
		const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
		parts = [body.error?.code, body.error?.message];
	} catch {
		parts = [/<Code>([^<]*)<\/Code>/.exec(text)?.[1], /<Message>([^<\n]*)/.exec(text)?.[1]];
	}
	const detail = parts
		.filter((part): part is string => typeof part === "string" && part.trim() !== "")
		.join(": ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
	return new Error(`${who} answered HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
}

/** A token from App Service's managed identity endpoint. */
function managedIdentityToken(
	env: Readonly<Record<string, string | undefined>>,
	clientId: string | undefined,
	fetchImpl: typeof fetch,
	now: () => number,
): (resource: string) => Promise<AccessToken> {
	return async (resource) => {
		const endpoint = env.IDENTITY_ENDPOINT;
		const secret = env.IDENTITY_HEADER;
		if (!endpoint || !secret) throw new Error("this server has no managed identity (IDENTITY_ENDPOINT isn't set)");
		const url = new URL(endpoint);
		url.searchParams.set("resource", resource);
		url.searchParams.set("api-version", IDENTITY_API_VERSION);
		if (clientId) url.searchParams.set("client_id", clientId);
		const res = await fetchImpl(url, {
			headers: { "X-IDENTITY-HEADER": secret },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) throw await httpError("The managed identity endpoint", res);
		const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_on?: unknown } | null;
		if (typeof body?.access_token !== "string" || !body.access_token) {
			throw new Error("the managed identity endpoint returned no token");
		}
		const seconds = Number(body.expires_on);
		return {
			token: body.access_token,
			expiresAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : now() + 10 * 60_000,
		};
	};
}

// ─── User delegation SAS ───────────────────────────────────────────────────

/** A user delegation key, as Get User Delegation Key returns it. */
export interface UserDelegationKey {
	signedOid: string;
	signedTid: string;
	signedStart: string;
	signedExpiry: string;
	signedService: string;
	signedVersion: string;
	/** Base64. */
	value: string;
}

/** ISO 8601 to the second, as SAS fields and key requests want it. */
function sasTime(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface BlobSasOptions {
	account: string;
	container: string;
	blob: string;
	/** In the documented order (r, a, c, w, d, …): "r" or "cw". */
	permissions: string;
	start: number;
	expiry: number;
	key: UserDelegationKey;
}

/** A user delegation SAS for one blob, HTTPS only: the query string,
 *  signed with the string-to-sign of versions 2020-12-06 up to (not
 *  including) 2025-07-05. Unused fields are empty lines. Pure. */
export function blobSas(opts: BlobSasOptions): string {
	const { key } = opts;
	const st = sasTime(opts.start);
	const se = sasTime(opts.expiry);
	const stringToSign = [
		opts.permissions,
		st,
		se,
		`/blob/${opts.account}/${opts.container}/${opts.blob}`,
		key.signedOid,
		key.signedTid,
		key.signedStart,
		key.signedExpiry,
		key.signedService,
		key.signedVersion,
		"", // signedAuthorizedUserObjectId
		"", // signedUnauthorizedUserObjectId
		"", // signedCorrelationId
		"", // signedIP
		"https",
		BLOB_API_VERSION,
		"b",
		"", // signedSnapshotTime
		"", // signedEncryptionScope
		"", // rscc
		"", // rscd
		"", // rsce
		"", // rscl
		"", // rsct
	].join("\n");
	const sig = createHmac("sha256", Buffer.from(key.value, "base64")).update(stringToSign, "utf8").digest("base64");
	return new URLSearchParams({
		sp: opts.permissions,
		st,
		se,
		skoid: key.signedOid,
		sktid: key.signedTid,
		skt: key.signedStart,
		ske: key.signedExpiry,
		sks: key.signedService,
		skv: key.signedVersion,
		spr: "https",
		sv: BLOB_API_VERSION,
		sr: "b",
		sig,
	}).toString();
}

// ─── The output blob ───────────────────────────────────────────────────────

export interface RunHeader {
	/** The runner's exit code; negative when a signal killed it. */
	code: number | null;
	timedOut: boolean;
	overflow: boolean;
	/** The tail of the runner's stderr. */
	stderr: string;
	/** Why the supervisor couldn't run the runner at all. */
	error: string;
}

/** The output blob: one `CAIRN-RUN <json>` line, then the runner's
 *  stdout. Null when it doesn't start with such a line. Pure. */
export function parseRunOutput(out: Buffer): { header: RunHeader; stdout: Buffer } | null {
	const newline = out.indexOf(0x0a);
	if (newline < 0 || newline > HEADER_MAX) return null;
	const line = out.toString("utf8", 0, newline);
	if (!line.startsWith(HEADER_PREFIX)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.slice(HEADER_PREFIX.length));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const p = parsed as Record<string, unknown>;
	return {
		header: {
			code: typeof p.code === "number" && Number.isInteger(p.code) ? p.code : null,
			timedOut: p.timedOut === true,
			overflow: p.overflow === true,
			stderr: typeof p.stderr === "string" ? p.stderr : "",
			error: typeof p.error === "string" ? p.error : "",
		},
		stdout: out.subarray(newline + 1),
	};
}

async function readCapped(res: Response, max: number): Promise<Buffer | "too-big"> {
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) {
		await drain(res);
		return "too-big";
	}
	if (!res.body) return Buffer.alloc(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return "too-big";
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks, size);
}

function timeoutError(budgetMs: number): string {
	return `The render took longer than ${budgetMs / 1000} s and was stopped. Simplify the scene: fewer objects, a shorter run_time, no per-frame updaters.`;
}

function overflowError(): string {
	return `The render produced more than ${MANIM_MAX_OUTPUT_BYTES / 1024 / 1024} MB and was stopped. Make the animation shorter or simpler.`;
}

/** "4Gi" as "4 GB", for the out-of-memory message. */
function memoryLabel(memory: string): string {
	const gi = /^(\d+(?:\.\d+)?)Gi$/.exec(memory)?.[1];
	return gi ? `${gi} GB` : memory;
}

// ─── The renderer ──────────────────────────────────────────────────────────

/** The job template's container, which every execution re-uses. */
interface JobContainer {
	name: string;
	image: string;
	resources: { cpu: number; memory: string };
}

interface Probe {
	status: ManimStatus;
	container: JobContainer | null;
}

function jobContainer(value: unknown): JobContainer | null {
	if (!value || typeof value !== "object") return null;
	const c = value as { name?: unknown; image?: unknown; resources?: { cpu?: unknown; memory?: unknown } };
	const cpu = c.resources?.cpu;
	const memory = c.resources?.memory;
	if (typeof c.name !== "string" || !c.name || typeof c.image !== "string" || !c.image) return null;
	if (typeof cpu !== "number" || typeof memory !== "string") return null;
	return { name: c.name, image: c.image, resources: { cpu, memory } };
}

/** The runner and palette are written for one Manim release: the job must
 *  run MANIM_IMAGE, from any registry (a mirror keeps the repository path). */
function runsPinnedImage(image: string): boolean {
	return image === MANIM_IMAGE || image.endsWith(`/${MANIM_IMAGE}`);
}

function executionName(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const b = body as { name?: unknown; id?: unknown };
	const name = typeof b.name === "string" ? b.name : typeof b.id === "string" ? b.id.split("/").pop() : undefined;
	return name && EXECUTION_RE.test(name) ? name : null;
}

/** A renderer that is switched on but can't run: every answer says why. */
export function unavailableManimRenderer(reason: string, kit: Pick<AzureManimKit, "saveDescriptions">): ManimRenderer {
	const status = makeStatus("unavailable", reason);
	return {
		ready: () => false,
		status: async () => status,
		install: async () => status,
		render: async () => ({ ok: false, error: reason }),
		saveDescriptions: (chatId, jobId, vtt) => kit.saveDescriptions(chatId, jobId, vtt),
	};
}

export function createAzureJobManimRenderer(
	config: AzureManimConfig,
	kit: AzureManimKit,
	deps: Partial<AzureManimDeps> = {},
): ManimRenderer {
	const fetchImpl = deps.fetch ?? fetch;
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ?? ((ms: number, signal?: AbortSignal) => (signal ? delay(ms, undefined, { signal }) : delay(ms)));
	const randomId = deps.randomId ?? (() => randomUUID().slice(0, 8));
	const getToken = deps.getToken ?? managedIdentityToken(deps.env ?? process.env, config.clientId, fetchImpl, now);
	const blobOrigin = `https://${config.storageAccount}.blob.core.windows.net`;

	const tokens = new Map<string, AccessToken>();
	let delegation: { key: UserDelegationKey; expiresAt: number } | null = null;
	let cache: (Probe & { at: number }) | null = null;
	let probing: Promise<Probe> | null = null;
	let generation = 0;

	async function token(resource: string): Promise<string> {
		const held = tokens.get(resource);
		if (held && held.expiresAt - now() > TOKEN_EARLY_MS) return held.token;
		const fresh = await getToken(resource);
		tokens.set(resource, fresh);
		return fresh.token;
	}

	function armUrl(path: string): string {
		return `${ARM}${path}?api-version=${ARM_API_VERSION}`;
	}

	async function arm(method: "GET" | "POST", url: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
		const headers: Record<string, string> = { Authorization: `Bearer ${await token(ARM_RESOURCE)}` };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		return fetchImpl(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
		});
	}

	async function storage(
		method: "GET" | "PUT" | "POST" | "DELETE",
		pathAndQuery: string,
		init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<Response> {
		const bearer = await token(STORAGE_RESOURCE);
		return fetchImpl(`${blobOrigin}${pathAndQuery}`, {
			method,
			headers: {
				Authorization: `Bearer ${bearer}`,
				"x-ms-version": BLOB_API_VERSION,
				"x-ms-date": new Date(now()).toUTCString(),
				...init.headers,
			},
			body: init.body,
			signal: withTimeout(init.signal, init.timeoutMs ?? REQUEST_TIMEOUT_MS),
		});
	}

	function blobPath(blob: string): string {
		return `/${config.container}/${blob}`;
	}

	async function userDelegationKey(signal?: AbortSignal): Promise<UserDelegationKey> {
		if (delegation && delegation.expiresAt - now() > KEY_MIN_LEFT_MS) return delegation.key;
		const at = now();
		const res = await storage("POST", "/?restype=service&comp=userdelegationkey", {
			body: `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${sasTime(at - CLOCK_SKEW_MS)}</Start><Expiry>${sasTime(at + KEY_LIFETIME_MS)}</Expiry></KeyInfo>`,
			headers: { "Content-Type": "application/xml" },
			signal,
		});
		if (!res.ok) throw await httpError("Blob Storage", res);
		const xml = await res.text();
		const field = (tag: string) => new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml)?.[1]?.trim() ?? "";
		const key: UserDelegationKey = {
			signedOid: field("SignedOid"),
			signedTid: field("SignedTid"),
			signedStart: field("SignedStart"),
			signedExpiry: field("SignedExpiry"),
			signedService: field("SignedService"),
			signedVersion: field("SignedVersion"),
			value: field("Value"),
		};
		if (Object.values(key).some((part) => !part)) throw new Error("Blob Storage returned a delegation key Cairn couldn't read");
		const expiry = Date.parse(key.signedExpiry);
		delegation = { key, expiresAt: Number.isFinite(expiry) ? expiry : at + KEY_LIFETIME_MS };
		return key;
	}

	// ── Status ──

	function unavailable(reason: string): Probe {
		return { status: makeStatus("unavailable", reason), container: null };
	}

	async function probe(): Promise<Probe> {
		const res = await arm("GET", armUrl(config.jobId));
		if (!res.ok) throw await httpError("Azure Resource Manager", res);
		const job = (await res.json().catch(() => null)) as {
			properties?: { provisioningState?: unknown; template?: { containers?: unknown[] } };
		} | null;
		const provisioning = job?.properties?.provisioningState;
		if (provisioning !== "Succeeded") {
			const said = typeof provisioning === "string" ? provisioning : "unknown";
			return unavailable(`The Azure renderer's job isn't ready yet (its state is ${said}). Check again in a minute.`);
		}
		const container = jobContainer(job?.properties?.template?.containers?.[0]);
		if (!container) return unavailable("The Azure renderer's job has no container to run. Deploy it again, then check again.");
		if (!runsPinnedImage(container.image)) {
			return unavailable(
				`The Azure renderer's job runs ${container.image}, but this version of Cairn renders with ${MANIM_IMAGE}. Point the job at that image, then check again.`,
			);
		}
		try {
			await userDelegationKey();
		} catch (err) {
			return unavailable(`Cairn couldn't reach the Azure renderer's storage: ${sentence(errorMessage(err))}`);
		}
		return { status: makeStatus("ready", READY), container };
	}

	/** One probe at a time; its answer refreshes the cache unless the
	 *  cache was invalidated while it ran. */
	function refresh(): Promise<Probe> {
		if (probing) return probing;
		const started = generation;
		const run: Promise<Probe> = probe()
			.catch((err: unknown) => unavailable(`Cairn couldn't reach the Azure renderer: ${sentence(errorMessage(err))}`))
			.then((result) => {
				if (generation === started) cache = { ...result, at: now() };
				return result;
			})
			.finally(() => {
				if (probing === run) probing = null;
			});
		probing = run;
		return run;
	}

	function freshCache(): (Probe & { at: number }) | null {
		return cache && now() - cache.at <= STATUS_TTL_MS ? cache : null;
	}

	function invalidate(): void {
		cache = null;
		probing = null;
		generation++;
	}

	// ── Rendering ──

	async function putBlob(blob: string, body: string, signal?: AbortSignal): Promise<void> {
		const res = await storage("PUT", blobPath(blob), {
			body,
			headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/json" },
			signal,
			timeoutMs: TRANSFER_TIMEOUT_MS,
		});
		if (!res.ok) throw await httpError("Blob Storage", res);
		await drain(res);
	}

	/** The output blob, null when there is none. */
	async function getBlob(blob: string, signal?: AbortSignal): Promise<Buffer | "too-big" | null> {
		const res = await storage("GET", blobPath(blob), { signal, timeoutMs: TRANSFER_TIMEOUT_MS });
		if (res.status === 404) {
			await drain(res);
			return null;
		}
		if (!res.ok) throw await httpError("Blob Storage", res);
		return readCapped(res, MANIM_MAX_OUTPUT_BYTES + HEADER_MAX);
	}

	async function deleteBlob(blob: string): Promise<void> {
		try {
			await drain(await storage("DELETE", blobPath(blob)));
		} catch {
			// best effort: the container's lifecycle rule deletes leftovers
		}
	}

	/** Start one execution; its name. A 202 without one names the
	 *  operation to follow instead. */
	async function start(body: unknown, signal?: AbortSignal): Promise<string> {
		const res = await arm("POST", armUrl(`${config.jobId}/start`), body, signal);
		if (!res.ok) throw await httpError("Azure Resource Manager", res);
		const location = res.headers.get("location");
		const name = executionName(await res.json().catch(() => null));
		if (name) return name;
		if (res.status !== 202 || !location) throw new Error("Azure started the job but didn't say which execution it is");
		const operation = new URL(location);
		if (operation.protocol !== "https:" || operation.hostname !== "management.azure.com") {
			throw new Error("Azure answered the job's start with an unexpected Location");
		}
		const until = now() + START_TIMEOUT_MS;
		while (now() < until) {
			await sleep(2_000, signal);
			const poll = await arm("GET", operation.toString(), undefined, signal);
			if (poll.status === 202) {
				await drain(poll);
				continue;
			}
			if (!poll.ok) throw await httpError("Azure Resource Manager", poll);
			const named = executionName(await poll.json().catch(() => null));
			if (named) return named;
			throw new Error("Azure started the job but didn't say which execution it is");
		}
		throw new Error("the job didn't start within two minutes");
	}

	/** Poll until the execution ends: its final status, or null at the
	 *  deadline. A few failed polls in a row end it with the last error. */
	async function waitFor(execution: string, deadline: number, signal?: AbortSignal): Promise<string | null> {
		let failures = 0;
		while (now() < deadline) {
			await sleep(POLL_MS, signal);
			try {
				const res = await arm("GET", armUrl(`${config.jobId}/executions/${execution}`), undefined, signal);
				if (res.status === 404) {
					await drain(res);
					continue;
				}
				if (!res.ok) throw await httpError("Azure Resource Manager", res);
				const body = (await res.json()) as { properties?: { status?: unknown } };
				failures = 0;
				const status = body.properties?.status;
				if (typeof status === "string" && TERMINAL.has(status)) return status;
			} catch (err) {
				if (signal?.aborted || ++failures >= MAX_POLL_FAILURES) throw err;
			}
		}
		return null;
	}

	async function stop(execution: string): Promise<void> {
		try {
			await drain(await arm("POST", armUrl(`${config.jobId}/executions/${execution}/stop`)));
		} catch {
			// best effort: the job's replica timeout ends it anyway
		}
	}

	function startBody(container: JobContainer, input: string, output: string, budgetMs: number): unknown {
		const env: Record<string, string> = {
			CAIRN_IN: input,
			CAIRN_OUT: output,
			CAIRN_BUDGET: String(budgetMs / 1000),
			CAIRN_MAX: String(MANIM_MAX_OUTPUT_BYTES),
			HOME: "/tmp",
			XDG_CACHE_HOME: "/tmp/.cache",
			MPLCONFIGDIR: "/tmp/.mpl",
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONUNBUFFERED: "1",
		};
		return {
			containers: [
				{
					name: container.name,
					image: container.image,
					command: ["python", "-c", AZURE_BOOTSTRAP],
					env: Object.entries(env).map(([name, value]) => ({ name, value })),
					resources: container.resources,
				},
			],
		};
	}

	function interpret(req: ManimRenderRequest, out: Buffer, budgetMs: number, container: JobContainer): ManimRenderResult {
		const run = parseRunOutput(out);
		if (!run) return { ok: false, error: "The Azure renderer returned something Cairn couldn't read." };
		const { header, stdout } = run;
		if (header.error) return { ok: false, error: `The Azure renderer ${sentence(header.error)}` };
		if (header.timedOut) return { ok: false, error: timeoutError(budgetMs) };
		if (header.overflow) return { ok: false, error: overflowError() };
		const finished = kit.finish(req, stdout);
		if (finished) return finished;
		if (header.code === -9 || header.code === 137) {
			return {
				ok: false,
				error: `The render ran out of memory (${memoryLabel(container.resources.memory)}) and was stopped. Simplify the scene: fewer objects, less detail, a shorter run_time.`,
			};
		}
		const said = lastLines(header.stderr, 20);
		return {
			ok: false,
			error: said
				? `The renderer stopped unexpectedly (exit code ${header.code}):\n${said}`
				: `The renderer stopped unexpectedly (exit code ${header.code}).`,
		};
	}

	async function renderInAzure(req: ManimRenderRequest): Promise<ManimRenderResult> {
		const signal = req.abortSignal;
		const ready = freshCache() ?? (await refresh());
		const container = ready.container;
		if (!container) return { ok: false, error: ready.status.reason };
		const budgetMs = MANIM_RENDER_TIMEOUT_MS[req.mode];
		const id = `${req.jobId.slice(0, 40)}-${randomId()}`;
		const input = `in/${id}.json`;
		const output = `out/${id}.bin`;
		let uploaded = false;
		let execution: string | null = null;
		let ended = false;
		try {
			await putBlob(input, kit.bundle(req.mode, req.code), signal);
			uploaded = true;
			const key = await userDelegationKey(signal);
			const at = now();
			const deadline = at + budgetMs + STARTUP_MS;
			const sas = (blob: string, permissions: string) =>
				`${blobOrigin}${blobPath(blob)}?${blobSas({
					account: config.storageAccount,
					container: config.container,
					blob,
					permissions,
					start: at - CLOCK_SKEW_MS,
					expiry: deadline + CLOCK_SKEW_MS,
					key,
				})}`;
			execution = await start(startBody(container, sas(input, "r"), sas(output, "cw"), budgetMs), signal);
			const status = await waitFor(execution, deadline, signal);
			if (!status) {
				return {
					ok: false,
					error: `The Azure renderer didn't finish within ${Math.round((budgetMs + STARTUP_MS) / 60_000)} minutes, so Cairn stopped it. Try again; if it keeps happening, simplify the scene.`,
				};
			}
			ended = true;
			const out = await getBlob(output, signal);
			if (out === "too-big") return { ok: false, error: overflowError() };
			if (!out) {
				return {
					ok: false,
					error: `The Azure renderer's job ended (${status}) without returning a render. That isn't a problem with the scene; try again in a minute.`,
				};
			}
			return interpret(req, out, budgetMs, container);
		} catch (err) {
			if (signal?.aborted) throw abortError();
			invalidate();
			return { ok: false, error: `The Azure renderer failed: ${sentence(errorMessage(err))}` };
		} finally {
			if (execution && !ended) await stop(execution);
			await Promise.all([uploaded ? deleteBlob(input) : undefined, execution ? deleteBlob(output) : undefined]);
		}
	}

	return {
		ready() {
			if (!freshCache()) void refresh();
			return cache?.status.state === "ready";
		},
		async status(fresh = false) {
			if (fresh) invalidate();
			else {
				const cached = freshCache();
				if (cached) return cached.status;
			}
			return (await refresh()).status;
		},
		async install() {
			invalidate();
			return (await refresh()).status;
		},
		async render(req) {
			if (!ID_RE.test(req.chatId) || !ID_RE.test(req.jobId)) {
				return { ok: false, error: "Cairn refused the render: the chat or job id is invalid." };
			}
			if (req.abortSignal?.aborted) throw abortError();
			return kit.withSlot(req.abortSignal, () => renderInAzure(req));
		},
		saveDescriptions(chatId, jobId, vtt) {
			return kit.saveDescriptions(chatId, jobId, vtt);
		},
	};
}

// ─── The container side ────────────────────────────────────────────────────
// Python, embedded verbatim (String.raw: no backticks, no dollar-brace).
// The supervisor runs as the job's command (python -c). The runner it
// starts is the Docker adapter's cairn_run.py, unchanged; the supervisor
// stands in for docker run's time limit, output cap and stdout pipe.

export const AZURE_BOOTSTRAP = String.raw`"""Cairn's render supervisor (src/server/manim-azure.ts): fetch the bundle,
run cairn_run.py under the render's limits, upload one CAIRN-RUN line and
the runner's stdout."""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

VERSION = "2024-11-04"
SOURCE = os.environ.pop("CAIRN_IN", "")
TARGET = os.environ.pop("CAIRN_OUT", "")
BUDGET = float(os.environ.pop("CAIRN_BUDGET", "120"))
LIMIT = int(os.environ.pop("CAIRN_MAX", "100663296"))
WORK = "/tmp/w"
OUT = "/tmp/cairn-stdout.bin"
ERR = "/tmp/cairn-stderr.txt"


def tail(path, size=16384):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - size))
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


def fetch_bundle():
    request = urllib.request.Request(SOURCE, headers={"x-ms-version": VERSION})
    with urllib.request.urlopen(request, timeout=120) as response:
        bundle = json.loads(response.read().decode("utf-8"))
    os.makedirs(WORK, exist_ok=True)
    for name, text in bundle["files"].items():
        with open(os.path.join(WORK, os.path.basename(name)), "w", encoding="utf-8") as fh:
            fh.write(text)
    return str(bundle["mode"])


def run(mode):
    head = {"code": None, "timedOut": False, "overflow": False, "stderr": "", "error": ""}
    with open(OUT, "wb") as out, open(ERR, "wb") as err:
        proc = subprocess.Popen(
            [sys.executable, os.path.join(WORK, "cairn_run.py"), mode],
            cwd=WORK, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
        deadline = time.monotonic() + BUDGET
        while proc.poll() is None:
            if os.path.getsize(OUT) > LIMIT:
                head["overflow"] = True
            elif time.monotonic() > deadline:
                head["timedOut"] = True
            else:
                time.sleep(0.2)
                continue
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            proc.wait()
    head["code"] = proc.returncode
    head["stderr"] = tail(ERR)
    if head["overflow"] or os.path.getsize(OUT) > LIMIT:
        head["overflow"] = True
        return head, b""
    with open(OUT, "rb") as fh:
        return head, fh.read()


def upload(data):
    for attempt in range(4):
        request = urllib.request.Request(TARGET, data=data, method="PUT", headers={
            "x-ms-blob-type": "BlockBlob",
            "x-ms-version": VERSION,
            "Content-Type": "application/octet-stream",
        })
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                response.read()
            return
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 + 3 * attempt)


def main():
    try:
        mode = fetch_bundle()
    except Exception as exc:
        head = {"code": None, "timedOut": False, "overflow": False, "stderr": "",
                "error": "couldn't fetch the scene: %s" % exc}
        body = b""
    else:
        head, body = run(mode)
    line = "CAIRN-RUN %s\n" % json.dumps(head, ensure_ascii=True)
    upload(line.encode("ascii") + body)


main()
`;
