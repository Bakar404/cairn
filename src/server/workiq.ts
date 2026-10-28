import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import packageMetadata from "../../package.json" with { type: "json" };
import {
	WORKIQ_ASK_TOOL,
	WORKIQ_PACKAGE,
	WORKIQ_TEST_QUESTION,
	type WorkIqAskRequest,
	type WorkIqClient,
	type WorkIqTestResult,
} from "../core/workiq.ts";

/**
 * THE WORK IQ ADAPTER (M10): core/workiq.ts's WorkIqClient over the Work IQ
 * CLI's MCP stdio server — `npx -y @microsoft/workiq@1.0.1 mcp`, which
 * relays to the hosted Work IQ service under the learner's own Microsoft
 * 365 sign-in. No SDK dependency: newline-delimited JSON-RPC by hand.
 *
 * ONE QUESTION PER PROCESS: initialize → notifications/initialized → one
 * tools/call of `ask` → the process ends. Cairn calls nothing else — no
 * write tool, never accept-eula, never a sign-in (the learner does those
 * once in a terminal; Settings › Providers › Work IQ lists the steps).
 *
 * The child gets this server's environment minus every GitHub token
 * (COPILOT_GITHUB_TOKEN too, which the Copilot runtime keeps for its own
 * sign-in) and *_API_KEY values: Work IQ needs none of them. Under
 * NODE_ENV=test the shared client and the Settings test never spawn.
 */

const PROTOCOL_VERSION = "2025-06-18";
const ASK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 120_000;
/** A stdout line this long without a newline is not an answer we can use. */
const MAX_LINE_CHARS = 5 * 1024 * 1024;
const STDERR_LINE_CHARS = 200;
const ERROR_CHARS = 400;
/** After the answer: how long the CLI may take to exit on its own. */
const EXIT_GRACE_MS = 2_000;
const WITHHELD_ENV = /^(COPILOT_GITHUB_TOKEN|GITHUB_TOKEN|GH_TOKEN|.+_API_KEY)$/i;
const INIT_ID = 1;
const ASK_ID = 2;

const REASON = {
	test: "Work IQ is off under tests.",
	noNpx: "Couldn't start Work IQ: npx wasn't found. Install Node.js, then try again.",
} as const;

export interface StdioWorkIqOptions {
	/** Default "npx". */
	command?: string;
	/** Default ["-y", WORKIQ_PACKAGE, "mcp"]. */
	args?: string[];
	/** Run through the shell — Windows needs it for npx.cmd. Default: on Windows only. */
	shell?: boolean;
	/** Default 300 s: an ask can take minutes. */
	timeoutMs?: number;
	/** Default: this process's environment, minus tokens and API keys. */
	env?: NodeJS.ProcessEnv;
}

interface SpawnPlan {
	command: string;
	args: string[];
	shell: boolean;
	timeoutMs: number;
	env: NodeJS.ProcessEnv;
}

interface JsonRpcMessage {
	id?: unknown;
	method?: unknown;
	result?: unknown;
	error?: unknown;
}

export function createStdioWorkIqClient(options: StdioWorkIqOptions = {}): WorkIqClient {
	const command = options.command ?? "npx";
	const args = options.args ?? ["-y", WORKIQ_PACKAGE, "mcp"];
	const shell = options.shell ?? process.platform === "win32";
	const timeoutMs = options.timeoutMs ?? ASK_TIMEOUT_MS;
	return {
		ask: (request) => askOnce({ command, args, shell, timeoutMs, env: options.env ?? childEnv() }, request),
	};
}

function askOnce(plan: SpawnPlan, { question, abortSignal }: WorkIqAskRequest): Promise<string> {
	return new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(abortError());
			return;
		}
		let child: ChildProcessWithoutNullStreams;
		try {
			child = startChild(plan);
		} catch (err) {
			reject(new Error(startFailure(err)));
			return;
		}
		let settled = false;
		let buffer = "";
		let stderrTail = "";
		let lastStderr = "";

		const send = (message: object) => {
			if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
		};
		const finish = (outcome: { answer: string } | { error: Error }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			abortSignal?.removeEventListener("abort", onAbort);
			try {
				child.stdin.end();
			} catch {
				// already closed
			}
			if ("answer" in outcome) {
				const grace = setTimeout(() => killTree(child), EXIT_GRACE_MS);
				grace.unref?.();
				child.once("exit", () => clearTimeout(grace));
				resolve(outcome.answer);
				return;
			}
			killTree(child);
			reject(outcome.error);
		};
		/** A failure the server worded itself. */
		const refuse = (message: string) => finish({ error: new Error(cap(message)) });
		/** A process-level failure: the last stderr line usually says why. */
		const fail = (message: string) =>
			finish({ error: new Error(cap(lastStderr ? `${message} Work IQ said: ${lastStderr}` : message)) });

		const timer = setTimeout(
			() => fail(`Work IQ didn't answer within ${Math.round(plan.timeoutMs / 1000)} s.`),
			plan.timeoutMs,
		);
		const onAbort = () => finish({ error: abortError() });
		abortSignal?.addEventListener("abort", onAbort, { once: true });

		const onMessage = (message: JsonRpcMessage) => {
			if (typeof message.method === "string") {
				// A request from the server: answer ping, refuse the rest.
				// Notifications (no id) need no answer.
				if (message.id === undefined || message.id === null) return;
				if (message.method === "ping") send({ jsonrpc: "2.0", id: message.id, result: {} });
				else
					send({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: `Method not found: ${message.method}` },
					});
				return;
			}
			if (message.id === INIT_ID) {
				if (message.error !== undefined) {
					refuse(`Work IQ refused to start: ${rpcErrorText(message.error)}`);
					return;
				}
				send({ jsonrpc: "2.0", method: "notifications/initialized" });
				send({
					jsonrpc: "2.0",
					id: ASK_ID,
					method: "tools/call",
					params: { name: WORKIQ_ASK_TOOL, arguments: { question } },
				});
				return;
			}
			if (message.id === ASK_ID) {
				if (message.error !== undefined) {
					refuse(`Work IQ couldn't answer: ${rpcErrorText(message.error)}`);
					return;
				}
				const result = (message.result ?? {}) as { content?: unknown; isError?: unknown };
				const text = contentText(result.content);
				if (result.isError === true) {
					refuse(`Work IQ couldn't answer: ${text || "it gave no reason"}`);
					return;
				}
				finish({ answer: text });
			}
		};

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1 && !settled) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				// The CLI may log plain text on stdout; only JSON lines are messages.
				if (line.startsWith("{")) {
					let message: unknown;
					try {
						message = JSON.parse(line);
					} catch {
						message = undefined;
					}
					if (message && typeof message === "object") onMessage(message as JsonRpcMessage);
				}
				newline = buffer.indexOf("\n");
			}
			if (buffer.length > MAX_LINE_CHARS) fail("Work IQ sent a message too large to read.");
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-4096);
			const last = stderrTail
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean)
				.at(-1);
			if (last) lastStderr = last.slice(0, STDERR_LINE_CHARS);
		});
		child.on("error", (err) => fail(startFailure(err)));
		// "close", not "exit": stdout may still hold the answer when the process exits.
		child.on("close", (code, signal) =>
			fail(`Work IQ stopped before answering (${code !== null ? `exit code ${code}` : `signal ${signal}`}).`),
		);
		child.stdin.on("error", () => {});

		send({
			jsonrpc: "2.0",
			id: INIT_ID,
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "cairn", version: packageMetadata.version },
			},
		});
	});
}

function startChild(plan: SpawnPlan): ChildProcessWithoutNullStreams {
	// POSIX: its own process group, so killTree can end npx and the CLI together.
	const options = { env: plan.env, windowsHide: true, detached: process.platform !== "win32" };
	// With the shell on, one command string (separate args there are deprecated).
	return plan.shell
		? spawn([plan.command, ...plan.args].map(shellArg).join(" "), { ...options, shell: true })
		: spawn(plan.command, plan.args, options);
}

/** The command and args are Cairn's own; quote any that need it. */
function shellArg(arg: string): string {
	return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, "")}"`;
}

/** End the child and anything it started (npx runs the CLI as a grandchild). */
function killTree(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	const pid = child.pid;
	const fallback = () => {
		try {
			child.kill();
		} catch {
			// already gone
		}
	};
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on(
				"error",
				fallback,
			);
		} catch {
			fallback();
		}
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		fallback();
	}
}

function childEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !WITHHELD_ENV.test(key)),
	) as NodeJS.ProcessEnv;
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const p = part as { type?: unknown; text?: unknown } | null;
			return p && p.type === "text" && typeof p.text === "string" ? p.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function rpcErrorText(error: unknown): string {
	const message = (error as { message?: unknown } | null)?.message;
	return typeof message === "string" && message.trim() ? message.trim() : JSON.stringify(error);
}

function startFailure(err: unknown): string {
	if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return REASON.noNpx;
	return `Couldn't start Work IQ: ${errorMessage(err)}`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function cap(text: string): string {
	return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS - 1)}…` : text;
}

function abortError(): Error {
	const err = new Error("Work IQ question aborted");
	err.name = "AbortError";
	return err;
}

// ─── The process's client and the Settings test ───────────────────────────

const liveClient = createStdioWorkIqClient();

/** The client the job runner asks through while Work IQ is switched on. */
export const workIqClient: WorkIqClient = {
	ask: (request) =>
		process.env.NODE_ENV === "test" ? Promise.reject(new Error(REASON.test)) : liveClient.ask(request),
};

interface WorkIqGlobal {
	testing: Promise<WorkIqTestResult> | null;
}

/** On globalThis: Next dev compiles each route as its own module instance. */
function state(): WorkIqGlobal {
	const g = globalThis as typeof globalThis & { __lhWorkIq?: WorkIqGlobal };
	return (g.__lhWorkIq ??= { testing: null });
}

/** Settings › Providers › Work IQ › Test connection: one short question.
 *  Clicks while a test runs share it. */
export function testWorkIqConnection(): Promise<WorkIqTestResult> {
	if (process.env.NODE_ENV === "test") return Promise.resolve({ ok: false, error: REASON.test });
	const s = state();
	if (s.testing) return s.testing;
	const run: Promise<WorkIqTestResult> = createStdioWorkIqClient({ timeoutMs: TEST_TIMEOUT_MS })
		.ask({ question: WORKIQ_TEST_QUESTION })
		.then(
			(): WorkIqTestResult => ({ ok: true }),
			(err: unknown): WorkIqTestResult => ({ ok: false, error: errorMessage(err) }),
		)
		.finally(() => {
			if (state().testing === run) state().testing = null;
		});
	s.testing = run;
	return run;
}
