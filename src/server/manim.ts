import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { PATHS } from "../../config.ts";
import type { MediaRef } from "../core/contracts.ts";
import {
	MANIM_DOWNLOAD_SIZE,
	MANIM_IMAGE,
	MEDIA_FILE_RE,
	type ManimRenderer,
	type ManimRenderRequest,
	type ManimRenderResult,
	type ManimState,
	type ManimStatus,
} from "../core/manim.ts";
import { FIGURE } from "../core/figure-theme.ts";

/**
 * THE MANIM ADAPTER (M13): core/manim.ts's ManimRenderer, driving the
 * docker CLI. Manim Community runs inside the pinned image, so a learner
 * needs Docker and nothing else.
 *
 * TRANSPORT — stdin/stdout, no mounts. `docker run -i` reads one JSON
 * bundle on stdin (the runner, the palette module, the scene) and the
 * runner writes framed files back on stdout. Nothing on the host is
 * mounted: a scene can read or write no host file, and there is no Docker
 * Desktop file sharing, uid mapping, or host temp folder to set up.
 *
 * SANDBOX — no network, a read-only root, a 1 GB tmpfs, every capability
 * dropped, no-new-privileges, 2 GB of memory and no swap, 256 pids, at most
 * 2 CPUs. A scene is model-written Python: the container is the boundary,
 * and the limits keep a runaway scene from taking the machine with it.
 *
 * STATE lives on globalThis (Next dev compiles each route as its own module
 * instance): the docker binary, a 30 s status cache, the background pull,
 * and a 2-slot render pool. Under NODE_ENV=test nothing spawns — status
 * says no-docker and render refuses.
 */

/** Chat and job ids as the stores mint them; checked before either one
 *  reaches a docker argument or a file path. */
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const STATUS_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 15_000;
const PULL_TIMEOUT_MS = 60 * 60_000;
const RENDER_SLOTS = 2;
const MAX_RENDER_OUTPUT = 96 * 1024 * 1024;
const RENDER_TIMEOUT_MS: Record<ManimRenderRequest["mode"], number> = {
	preview: 120_000,
	final: 300_000,
	still: 120_000,
};
const TAIL_CHARS = 64 * 1024;

const REASON = {
	test: "Animations are off under tests.",
	noDocker: "Docker isn't installed. Install Docker Desktop (or Docker Engine on Linux), start it, then check again.",
	stopped: "Docker is installed but not running. Start Docker Desktop, then check again.",
	windowsEngine: "Docker is running Windows containers. Switch Docker Desktop to Linux containers, then check again.",
	notInstalled: `Docker is running. Install the Manim renderer — a one-time download of ${MANIM_DOWNLOAD_SIZE}.`,
	installing: `Downloading the Manim renderer (${MANIM_DOWNLOAD_SIZE}). It takes a few minutes; you can keep learning meanwhile.`,
	ready: "Ready. Animations render on this computer, inside Docker.",
} as const;

// ─── Process-wide state ────────────────────────────────────────────────────

interface PullState {
	seen: Set<string>;
	done: Set<string>;
	/** The unfinished last line of pull output. */
	buffer: string;
}

interface RenderSlots {
	active: number;
	queue: { resolve: () => void; dead: boolean }[];
}

interface ManimGlobal {
	/** The docker binary that answered `--version` (re-resolved when it vanishes). */
	bin?: string;
	/** The engine's CPU count, for `--cpus`. */
	ncpu?: number;
	cache: { at: number; status: ManimStatus } | null;
	probing: Promise<ManimStatus> | null;
	/** Bumped by invalidate(): a probe from an older generation can't
	 *  overwrite the cache. */
	generation: number;
	pull: PullState | null;
	pullError: string | null;
	renders: RenderSlots;
}

function state(): ManimGlobal {
	const g = globalThis as typeof globalThis & { __lhManim?: ManimGlobal };
	return (g.__lhManim ??= {
		cache: null,
		probing: null,
		generation: 0,
		pull: null,
		pullError: null,
		renders: { active: 0, queue: [] },
	});
}

function invalidate(): void {
	const s = state();
	s.cache = null;
	s.probing = null;
	s.ncpu = undefined;
	s.generation++;
}

// ─── Running the docker CLI ────────────────────────────────────────────────

interface ExecOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	/** Written to stdin, which is then closed. */
	input?: string;
	/** Keep stdout as bytes up to this size; past it the process is killed
	 *  and `overflow` is set. Default 1 MB. */
	maxStdoutBytes?: number;
	/** Stream stdout as text instead of keeping it (only a tail is kept). */
	onStdout?: (text: string) => void;
}

interface ExecResult {
	code: number | null;
	stdout: Buffer;
	/** The last 64 K characters. */
	stderr: string;
	/** The binary isn't there (ENOENT). */
	missing: boolean;
	timedOut: boolean;
	aborted: boolean;
	overflow: boolean;
}

function exec(bin: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
	return new Promise((resolve) => {
		const max = opts.maxStdoutBytes ?? 1024 * 1024;
		const chunks: Buffer[] = [];
		let size = 0;
		let streamed = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let overflow = false;
		let settled = false;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(bin, args, { windowsHide: true });
		} catch (err) {
			resolve({
				code: null,
				stdout: Buffer.alloc(0),
				stderr: errorMessage(err),
				missing: isEnoent(err),
				timedOut,
				aborted,
				overflow,
			});
			return;
		}
		// SIGKILL, not SIGTERM: the docker CLI catches SIGTERM and passes it to
		// the container, where python runs as process 1 and ignores it, so the
		// client would never exit. Nothing catches SIGKILL; once the client is
		// gone, the caller removes the container by name.
		const kill = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, opts.timeoutMs);
		const onAbort = () => {
			aborted = true;
			kill();
		};
		if (opts.signal?.aborted) onAbort();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });
		const settle = (code: number | null, missing: boolean, extra = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({
				code,
				stdout: opts.onStdout ? Buffer.from(streamed) : Buffer.concat(chunks, size),
				stderr: tail(stderr + extra),
				missing,
				timedOut,
				aborted,
				overflow,
			});
		};
		child.stdout.on("data", (chunk: Buffer) => {
			if (opts.onStdout) {
				const text = chunk.toString("utf8");
				streamed = tail(streamed + text);
				opts.onStdout(text);
				return;
			}
			if (overflow) return;
			if (size + chunk.length > max) {
				overflow = true;
				kill();
				return;
			}
			size += chunk.length;
			chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = tail(stderr + chunk.toString("utf8"));
		});
		child.on("error", (err) => settle(null, isEnoent(err), errorMessage(err)));
		child.on("close", (code) => settle(code, false));
		// The process may exit before it reads everything (a docker error).
		child.stdin.on("error", () => {});
		child.stdin.end(opts.input ?? "");
	});
}

function tail(text: string): string {
	return text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isEnoent(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function lastLines(text: string, count: number): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(-count)
		.join("\n");
}

/** The last line of a command's output, as a sentence. */
function lastSentence(text: string): string {
	const line = lastLines(text, 1).trim().slice(0, 300);
	if (!line) return "";
	return /[.!?]$/.test(line) ? line : `${line}.`;
}

function abortError(message = "Manim render aborted"): Error {
	const err = new Error(message);
	err.name = "AbortError";
	return err;
}

// ─── Status: is Docker there, running, and holding the image? ─────────────

/** `docker` on PATH first, then the standard install locations — the
 *  desktop app may start with a short PATH (macOS apps launched from the
 *  Finder), or before a fresh Docker install reached this process's PATH. */
function binCandidates(): string[] {
	const list = ["docker"];
	if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		list.push(path.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe"));
	} else if (process.platform === "darwin") {
		list.push(
			"/usr/local/bin/docker",
			"/opt/homebrew/bin/docker",
			"/Applications/Docker.app/Contents/Resources/bin/docker",
		);
	} else {
		list.push("/usr/bin/docker", "/usr/local/bin/docker");
	}
	// turbopackIgnore: a probe of a computed path would make the standalone
	// tracer sweep the whole project into the build.
	return list.filter((bin) => !path.isAbsolute(bin) || fs.existsSync(/*turbopackIgnore: true*/ bin));
}

async function dockerBin(): Promise<string | undefined> {
	const s = state();
	if (s.bin) return s.bin;
	for (const bin of binCandidates()) {
		const run = await exec(bin, ["--version"], { timeoutMs: PROBE_TIMEOUT_MS });
		if (run.code === 0) return (s.bin = bin);
	}
	return undefined;
}

function makeStatus(st: ManimState, reason: string, progress?: string): ManimStatus {
	return progress ? { state: st, reason, image: MANIM_IMAGE, progress } : { state: st, reason, image: MANIM_IMAGE };
}

async function probe(): Promise<ManimStatus> {
	if (process.env.NODE_ENV === "test") return makeStatus("no-docker", REASON.test);
	const s = state();
	const bin = await dockerBin();
	if (!bin) return makeStatus("no-docker", REASON.noDocker);
	const engine = await exec(bin, ["version", "--format", "{{.Server.Os}}"], { timeoutMs: PROBE_TIMEOUT_MS });
	if (engine.missing) {
		s.bin = undefined;
		return makeStatus("no-docker", REASON.noDocker);
	}
	const os = engine.stdout.toString("utf8").trim().toLowerCase();
	if (engine.code !== 0 || !os) return makeStatus("docker-stopped", REASON.stopped);
	if (os === "windows") return makeStatus("docker-stopped", REASON.windowsEngine);
	const image = await exec(bin, ["image", "inspect", "--format", "{{.Id}}", MANIM_IMAGE], {
		timeoutMs: PROBE_TIMEOUT_MS,
	});
	if (image.code === 0 && image.stdout.toString("utf8").trim()) return makeStatus("ready", REASON.ready);
	if (s.pullError) {
		return makeStatus("install-failed", `The download failed: ${s.pullError} Check your connection, then try again.`);
	}
	return makeStatus("not-installed", REASON.notInstalled);
}

/** One probe at a time; its answer refreshes the cache unless something
 *  invalidated the cache while it ran. */
function refresh(): Promise<ManimStatus> {
	const s = state();
	if (s.probing) return s.probing;
	const generation = s.generation;
	const probing: Promise<ManimStatus> = probe()
		.catch((err: unknown) => makeStatus("docker-stopped", `Cairn couldn't check Docker: ${errorMessage(err)}`))
		.then((status) => {
			if (s.generation === generation) s.cache = { at: Date.now(), status };
			return status;
		})
		.finally(() => {
			if (s.probing === probing) s.probing = null;
		});
	s.probing = probing;
	return probing;
}

function installingStatus(pull: PullState): ManimStatus {
	const progress = pull.seen.size ? `${pull.done.size} of ${pull.seen.size} layers` : undefined;
	return makeStatus("installing", REASON.installing, progress);
}

/** `<layer id>: <status>` — docker pull's plain (non-TTY) progress lines. */
const LAYER_RE = /^([0-9a-f]{12}): (.+)$/;

function trackLayer(pull: PullState, line: string): void {
	const match = LAYER_RE.exec(line.trim());
	const id = match?.[1];
	const what = match?.[2];
	if (!id || !what) return;
	pull.seen.add(id);
	if (/^(?:pull complete|already exists)/i.test(what)) pull.done.add(id);
}

/** Pull the image in the background. The status reports progress until it
 *  ends; then the cache is dropped and re-probed. */
function startPull(bin: string): PullState {
	const s = state();
	const pull: PullState = { seen: new Set(), done: new Set(), buffer: "" };
	s.pull = pull;
	s.pullError = null;
	void (async () => {
		try {
			const run = await exec(bin, ["pull", MANIM_IMAGE], {
				timeoutMs: PULL_TIMEOUT_MS,
				onStdout: (text) => {
					const lines = (pull.buffer + text).split(/\r?\n/);
					pull.buffer = lines.pop() ?? "";
					for (const line of lines) trackLayer(pull, line);
				},
			});
			if (run.code !== 0) {
				s.pullError = run.timedOut
					? "it took longer than an hour."
					: lastSentence(run.stderr) ||
						lastSentence(run.stdout.toString("utf8")) ||
						`docker pull exited with code ${run.code}.`;
			}
		} catch (err) {
			s.pullError = lastSentence(errorMessage(err)) || "docker pull failed.";
		} finally {
			s.pull = null;
			invalidate();
			void refresh();
		}
	})();
	return pull;
}

// ─── Rendering ─────────────────────────────────────────────────────────────

/** At most RENDER_SLOTS containers at once, process-wide. FIFO and
 *  abort-aware, with bg-llm-semaphore.ts's discipline: a fresh take counts
 *  itself, a handed-off slot doesn't (the releaser left `active` as is). */
async function withRenderSlot<T>(signal: AbortSignal | undefined, critical: () => Promise<T>): Promise<T> {
	const slots = state().renders;
	let freshTake = true;
	if (slots.active >= RENDER_SLOTS) {
		freshTake = false;
		await new Promise<void>((resolve, reject) => {
			const die = () => {
				ticket.dead = true;
				reject(abortError("Manim render aborted while waiting for a render slot"));
			};
			const ticket = {
				resolve: () => {
					signal?.removeEventListener("abort", die);
					resolve();
				},
				dead: false,
			};
			slots.queue.push(ticket);
			if (signal?.aborted) die();
			else signal?.addEventListener("abort", die, { once: true });
		});
	}
	if (freshTake) slots.active++;
	try {
		return await critical();
	} finally {
		for (;;) {
			const next = slots.queue.shift();
			if (!next) {
				slots.active--;
				break;
			}
			if (next.dead) continue;
			next.resolve();
			break;
		}
	}
}

async function dockerCpus(bin: string): Promise<number | undefined> {
	const s = state();
	if (s.ncpu === undefined) {
		const info = await exec(bin, ["info", "--format", "{{.NCPU}}"], { timeoutMs: PROBE_TIMEOUT_MS });
		const n = Number.parseInt(info.stdout.toString("utf8").trim(), 10);
		if (info.code === 0 && n > 0) s.ncpu = n;
	}
	return s.ncpu ? Math.min(2, s.ncpu) : undefined;
}

function runArgs(name: string, cpus: number | undefined): string[] {
	return [
		"run",
		"--rm",
		"-i",
		"--name",
		name,
		"--pull",
		"never",
		"--network",
		"none",
		"--read-only",
		"--tmpfs",
		"/tmp:rw,nosuid,size=1g",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--memory",
		"2g",
		"--memory-swap",
		"2g",
		"--pids-limit",
		"256",
		...(cpus ? ["--cpus", String(cpus)] : []),
		"-e",
		"HOME=/tmp",
		"-e",
		"XDG_CACHE_HOME=/tmp/.cache",
		"-e",
		"MPLCONFIGDIR=/tmp/.mpl",
		"-e",
		"PYTHONDONTWRITEBYTECODE=1",
		"-e",
		"PYTHONUNBUFFERED=1",
		"--entrypoint",
		"python",
		MANIM_IMAGE,
		"-c",
		BOOTSTRAP,
	];
}

/** Killing the CLI doesn't stop its container: remove it by name. */
async function removeContainer(bin: string, name: string): Promise<void> {
	await exec(bin, ["rm", "-f", name], { timeoutMs: 30_000 });
}

/** JSON with every non-ASCII character escaped, so the container's stdin
 *  encoding can't garble a scene's Greek letters or dashes. */
function asciiJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-\uffff]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

const FILE_HEADER_RE = /^CAIRN-FILE ([a-z0-9_.-]{1,40}) (\d{1,10})$/;
const RESULT_PREFIX = "CAIRN-RESULT ";

/** The runner's stdout: `CAIRN-FILE <name> <size>\n<bytes>` per file, then
 *  one `CAIRN-RESULT <json>\n`. Anything else is skipped. */
function parseFrames(out: Buffer): { files: Map<string, Buffer>; result: Record<string, unknown> | null } {
	const files = new Map<string, Buffer>();
	let result: Record<string, unknown> | null = null;
	let at = 0;
	while (at < out.length) {
		const newline = out.indexOf(0x0a, at);
		if (newline < 0) break;
		const line = out.toString("utf8", at, newline).replace(/\r$/, "");
		at = newline + 1;
		const header = FILE_HEADER_RE.exec(line);
		const name = header?.[1];
		if (header && name) {
			const size = Number(header[2]);
			if (at + size > out.length) break;
			files.set(name, out.subarray(at, at + size));
			at += size;
			continue;
		}
		if (line.startsWith(RESULT_PREFIX)) {
			try {
				const parsed: unknown = JSON.parse(line.slice(RESULT_PREFIX.length));
				if (parsed && typeof parsed === "object") result = parsed as Record<string, unknown>;
			} catch {
				// not a result line after all
			}
		}
	}
	return { files, result };
}

const DAEMON_DOWN_RE =
	/cannot connect to the docker daemon|error during connect|docker daemon is not running|dockerDesktopLinuxEngine|docker_engine/i;
const NO_IMAGE_RE = /no such image|unable to find image/i;

/** The container ended without a result line: say what went wrong in
 *  words the maker (and the learner) can act on. */
function describeRunFailure(run: ExecResult): string {
	if (run.missing) {
		state().bin = undefined;
		invalidate();
		return "Docker isn't installed any more. Reinstall Docker Desktop, then check again in Settings → Providers → Animations.";
	}
	if (DAEMON_DOWN_RE.test(run.stderr)) {
		invalidate();
		return "Docker isn't running. Start Docker Desktop, then try again.";
	}
	if (NO_IMAGE_RE.test(run.stderr)) {
		invalidate();
		return "The Manim renderer isn't installed. Install it in Settings → Providers → Animations.";
	}
	if (run.code === 137) {
		return "The render ran out of memory (2 GB) and was stopped. Simplify the scene: fewer objects, less detail, a shorter run_time.";
	}
	const said = lastLines(run.stderr, 20);
	return said
		? `The renderer stopped unexpectedly (exit code ${run.code}):\n${said}`
		: `The renderer stopped unexpectedly (exit code ${run.code}).`;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(data: Buffer): boolean {
	return data.length > 24 && data.subarray(0, 8).equals(PNG_MAGIC);
}

function isMp4(data: Buffer): boolean {
	return data.length > 12 && data.toString("latin1", 4, 8) === "ftyp";
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function saveMedia(chatId: string, file: string, data: Buffer, mime: MediaRef["mime"], size?: { width?: number; height?: number }): MediaRef {
	const dir = chatMediaDir(chatId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, file), data);
	const dims = mime === "image/png" ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : size;
	const ref: MediaRef = { file, mime, bytes: data.length };
	if (dims?.width && dims.height) {
		ref.width = dims.width;
		ref.height = dims.height;
	}
	return ref;
}

/** The runner's layout findings: at most a dozen short strings. */
function issuesOf(result: Record<string, unknown>): string[] {
	if (!Array.isArray(result.issues)) return [];
	return result.issues
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim().slice(0, 400))
		.filter(Boolean)
		.slice(0, 12);
}

/** Turn the runner's files into the mode's result, saving what the chat
 *  keeps: a still, or the video and its poster. */
function collect(req: ManimRenderRequest, files: Map<string, Buffer>, result: Record<string, unknown>): ManimRenderResult {
	const durationSec = positive(result.durationSec);
	const issues = issuesOf(result);
	if (req.mode === "preview") {
		const sheet = files.get("sheet.png");
		if (!sheet || !isPng(sheet)) return { ok: false, error: "The renderer didn't return the preview frames." };
		const out: ManimRenderResult = { ok: true, pngBase64: sheet.toString("base64") };
		if (durationSec !== undefined) out.durationSec = durationSec;
		if (issues.length) out.issues = issues;
		return out;
	}
	if (req.mode === "still") {
		const still = files.get("still.png");
		if (!still || !isPng(still)) return { ok: false, error: "The renderer didn't return the picture." };
		const out: ManimRenderResult = { ok: true, still: saveMedia(req.chatId, `${req.jobId}.png`, still, "image/png"), pngBase64: still.toString("base64") };
		if (issues.length) out.issues = issues;
		return out;
	}
	const video = files.get("video.mp4");
	if (!video || !isMp4(video)) return { ok: false, error: "The renderer didn't return the video." };
	const out: ManimRenderResult = {
		ok: true,
		video: saveMedia(req.chatId, `${req.jobId}.mp4`, video, "video/mp4", {
			width: positive(result.width),
			height: positive(result.height),
		}),
	};
	const poster = files.get("poster.png");
	if (poster && isPng(poster)) out.poster = saveMedia(req.chatId, `${req.jobId}-poster.png`, poster, "image/png");
	if (durationSec !== undefined) out.durationSec = durationSec;
	return out;
}

async function renderInDocker(req: ManimRenderRequest): Promise<ManimRenderResult> {
	const bin = await dockerBin();
	if (!bin) {
		invalidate();
		return {
			ok: false,
			error: "Docker isn't installed. Install Docker Desktop, then install the renderer in Settings → Providers → Animations.",
		};
	}
	const name = `cairn-manim-${req.jobId.slice(0, 40)}-${randomUUID().slice(0, 8)}`;
	const timeoutMs = RENDER_TIMEOUT_MS[req.mode];
	const run = await exec(bin, runArgs(name, await dockerCpus(bin)), {
		timeoutMs,
		signal: req.abortSignal,
		input: asciiJson({
			mode: req.mode,
			files: { "cairn_run.py": RUN_PY, "cairn_style.py": STYLE_PY, "scene.py": req.code },
		}),
		maxStdoutBytes: MAX_RENDER_OUTPUT,
	});
	if (run.timedOut || run.aborted || run.overflow) await removeContainer(bin, name);
	if (run.aborted || req.abortSignal?.aborted) throw abortError();
	if (run.timedOut) {
		return {
			ok: false,
			error: `The render took longer than ${timeoutMs / 1000} s and was stopped. Simplify the scene: fewer objects, a shorter run_time, no per-frame updaters.`,
		};
	}
	if (run.overflow) {
		return {
			ok: false,
			error: `The render produced more than ${MAX_RENDER_OUTPUT / 1024 / 1024} MB and was stopped. Make the animation shorter or simpler.`,
		};
	}
	const { files, result } = parseFrames(run.stdout);
	if (!result) return { ok: false, error: describeRunFailure(run) };
	if (result.ok !== true) {
		const error = typeof result.error === "string" && result.error.trim() ? result.error : "The render failed without saying why.";
		return { ok: false, error };
	}
	try {
		return collect(req, files, result);
	} catch (err) {
		return { ok: false, error: `Cairn couldn't save the render: ${errorMessage(err)}` };
	}
}

// ─── Chat media ────────────────────────────────────────────────────────────

/** A chat's media folder: data/media/<chatId>/. Throws on a bad id. */
export function chatMediaDir(chatId: string): string {
	if (!ID_RE.test(chatId)) throw new Error(`invalid chat id: ${chatId}`);
	return path.join(PATHS.media, chatId);
}

export interface ChatMediaFile {
	path: string;
	size: number;
	mime: MediaRef["mime"];
}

/** A servable media file, or null: only `<id>.png|mp4` names inside the
 *  chat's own folder, and only regular files. */
export function openChatMedia(chatId: string, file: string): ChatMediaFile | null {
	if (!ID_RE.test(chatId) || !MEDIA_FILE_RE.test(file)) return null;
	const full = path.join(PATHS.media, chatId, file);
	try {
		const stat = fs.statSync(full);
		if (!stat.isFile()) return null;
		return { path: full, size: stat.size, mime: file.endsWith(".mp4") ? "video/mp4" : "image/png" };
	} catch {
		return null;
	}
}

/** The one byte range a `Range` header asks for (inclusive ends),
 *  "unsatisfiable" when it starts past the end, or null to send the whole
 *  file: no header, several ranges, or a malformed one (RFC 9110 lets a
 *  server ignore those). Pure. */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m || (m[1] === "" && m[2] === "")) return null;
	if (m[1] === "") {
		const suffix = Number(m[2]);
		if (suffix === 0 || size === 0) return "unsatisfiable";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(m[1]);
	if (m[2] !== "" && Number(m[2]) < start) return null;
	if (start >= size) return "unsatisfiable";
	return { start, end: m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

/** The media route's answer: the whole file (200) or one byte range (206,
 *  so a <video> can seek), 416 past the end, null when there's no such
 *  file. A name is a job id and is never reused, so it caches for good. */
export function chatMediaResponse(chatId: string, file: string, rangeHeader: string | null): Response | null {
	const media = openChatMedia(chatId, file);
	if (!media) return null;
	const headers: Record<string, string> = {
		"Content-Type": media.mime,
		"Accept-Ranges": "bytes",
		"Cache-Control": "private, max-age=31536000, immutable",
		"X-Content-Type-Options": "nosniff",
	};
	const range = parseByteRange(rangeHeader, media.size);
	if (range === "unsatisfiable") {
		return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${media.size}` } });
	}
	const start = range?.start ?? 0;
	const end = range?.end ?? media.size - 1;
	const length = media.size === 0 ? 0 : end - start + 1;
	headers["Content-Length"] = String(length);
	if (range) headers["Content-Range"] = `bytes ${start}-${end}/${media.size}`;
	const body =
		length === 0 ? null : (Readable.toWeb(fs.createReadStream(media.path, { start, end })) as unknown as ReadableStream<Uint8Array>);
	return new Response(body, { status: range ? 206 : 200, headers });
}

/** Delete a chat's media folder (with the chat). Never throws. */
export function deleteChatMedia(chatId: string): void {
	if (!ID_RE.test(chatId)) return;
	try {
		fs.rmSync(path.join(PATHS.media, chatId), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
	} catch (err) {
		console.error(`[manim] couldn't delete the media for ${chatId}:`, err);
	}
}

// ─── The renderer ──────────────────────────────────────────────────────────

export function createDockerManimRenderer(): ManimRenderer {
	return {
		ready() {
			const s = state();
			if (s.pull) return false;
			const cache = s.cache;
			if (!cache || Date.now() - cache.at > STATUS_TTL_MS) void refresh();
			return cache?.status.state === "ready";
		},
		async status(fresh = false) {
			const s = state();
			if (s.pull) return installingStatus(s.pull);
			if (fresh) invalidate();
			else if (s.cache && Date.now() - s.cache.at <= STATUS_TTL_MS) return s.cache.status;
			return refresh();
		},
		async install() {
			const s = state();
			if (s.pull) return installingStatus(s.pull);
			invalidate();
			const now = await refresh();
			if (now.state !== "not-installed" && now.state !== "install-failed") return now;
			if (s.pull) return installingStatus(s.pull);
			if (!s.bin) return now;
			return installingStatus(startPull(s.bin));
		},
		async render(req) {
			if (process.env.NODE_ENV === "test") return { ok: false, error: REASON.test };
			if (!ID_RE.test(req.chatId) || !ID_RE.test(req.jobId)) {
				return { ok: false, error: "Cairn refused the render: the chat or job id is invalid." };
			}
			if (req.abortSignal?.aborted) throw abortError();
			return withRenderSlot(req.abortSignal, () => renderInDocker(req));
		},
	};
}

/** The process's renderer (its state is process-wide, on globalThis). */
export const manimRenderer: ManimRenderer = createDockerManimRenderer();

// ─── The container side ────────────────────────────────────────────────────
// Python, embedded verbatim (String.raw: no backticks, no dollar-brace).
// The bootstrap writes the stdin bundle to /tmp/w and runs cairn_run.py.

const BOOTSTRAP = [
	"import json,os,runpy,sys",
	"b=json.load(sys.stdin)",
	"os.makedirs('/tmp/w',exist_ok=True)",
	"[open('/tmp/w/'+os.path.basename(k),'w',encoding='utf-8').write(v) for k,v in b['files'].items()]",
	"os.chdir('/tmp/w')",
	"sys.path.insert(0,'/tmp/w')",
	"sys.argv=['cairn_run.py',b['mode']]",
	"runpy.run_path('/tmp/w/cairn_run.py',run_name='__main__')",
].join(";");

const RUN_PY = String.raw`"""Cairn's Manim runner. It runs inside the container (src/server/manim.ts
starts it), renders class Lesson from scene.py, and writes framed files to
stdout: CAIRN-FILE <name> <size> and the bytes, then one CAIRN-RESULT line."""
import ast
import glob
import io
import json
import os
import sys
import traceback

WORK = os.getcwd()
MEDIA = os.path.join(WORK, "media")
SCENE = os.path.join(WORK, "scene.py")
MODE = sys.argv[1] if len(sys.argv) > 1 else "preview"
QUALITY = {"preview": "low_quality", "final": "medium_quality", "still": "high_quality"}
# A contact sheet shows up to eight settled moments plus the final frame;
# the layout check reports at most a dozen problems.
SHEET_FRAMES = 9
MAX_ISSUES = 12

# Frames go to the real stdout. Everything else (Manim's console, LaTeX,
# ffmpeg) is pointed at stderr, so nothing can corrupt a frame.
sys.stdout.flush()
_OUT = os.fdopen(os.dup(1), "wb")
os.dup2(2, 1)


def emit_file(name, data):
    _OUT.write(("CAIRN-FILE %s %d\n" % (name, len(data))).encode("ascii"))
    _OUT.write(data)


def finish(**result):
    _OUT.write(("CAIRN-RESULT %s\n" % json.dumps(result)).encode("utf-8"))
    _OUT.flush()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
    os._exit(0)


def fail(message):
    finish(ok=False, error=str(message)[-3000:])


def short_path(filename):
    if filename == SCENE:
        return "scene.py"
    return filename.split("site-packages" + os.sep)[-1]


def latex_log():
    try:
        logs = glob.glob(os.path.join(MEDIA, "Tex", "*.log"))
        if not logs:
            return ""
        with open(max(logs, key=os.path.getmtime), encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
        said = []
        for i, line in enumerate(lines):
            if line.startswith("!"):
                said.extend(lines[i:i + 3])
        return ("\nLaTeX said:\n" + "\n".join(said[:12])) if said else ""
    except Exception:
        return ""


def error_text(exc):
    frames = traceback.extract_tb(exc.__traceback__)
    parts = []
    for frame in [f for f in frames if f.filename == SCENE][-3:]:
        parts.append("scene.py line %s, in %s\n    %s" % (frame.lineno, frame.name, (frame.line or "").strip()))
    if frames and frames[-1].filename != SCENE:
        last = frames[-1]
        parts.append("(raised inside %s line %s, in %s)" % (short_path(last.filename), last.lineno, last.name))
    parts.append("".join(traceback.format_exception_only(type(exc), exc)).strip())
    text = "\n".join(parts)
    if "latex" in text.lower() or "dvi" in text.lower():
        text += latex_log()
    return text


def check_scene():
    with open(SCENE, encoding="utf-8") as fh:
        source = fh.read()
    try:
        tree = ast.parse(source, filename="scene.py")
    except SyntaxError as err:
        text = (err.text or "").strip()
        fail("SyntaxError in scene.py line %s: %s%s" % (err.lineno, err.msg, ("\n    " + text) if text else ""))
    classes = [node.name for node in tree.body if isinstance(node, ast.ClassDef)]
    if "Lesson" not in classes:
        fail("scene.py must define class Lesson(Scene) at the top level. Classes found: %s." % (", ".join(classes) or "none"))


def newest_video():
    found = [p for p in glob.glob(os.path.join(MEDIA, "**", "*.mp4"), recursive=True)
             if "partial_movie_files" not in p]
    return max(found, key=os.path.getmtime) if found else ""


# ─── The layout check ──────────────────────────────────────────────────────
# A contact sheet is small, so the flaws that make a lesson look careless
# are measured instead: text spilling out of its box, texts drawn over each
# other, text hidden under a filled shape or crossed by a line, text too
# small to read, anything cut off by the frame edge, labeled boxes cutting
# into each other, and (in the final frame) boxes in a row left without
# their label. A preview checks the frame each play() and wait() settles
# into, and keeps their times to pick the contact sheet's frames; it also
# names text made or added after the last of them, which never reaches the
# video. Every check ends with the final frame, the only one a still has.
# Best effort: nothing here can fail a render.

SEGMENTS = []  # (start, end, is_wait) of each play() and wait(), in seconds
ISSUES = []
_SEEN = set()
_MADE = []  # texts made since the last play() or wait() ended
_SHOWN = set()  # ids of what was on screen when it ended


def watch_plays():
    """Wrap Scene.play (wait() goes through it) to record each segment and
    check the frame it settles into, and Text and MarkupText to keep the
    texts made after it."""
    from manim import MarkupText, Scene, Text, Wait

    original = Scene.play

    def play(self, *args, **kwargs):
        try:
            start = float(self.renderer.time)
        except Exception:
            start = None
        result = original(self, *args, **kwargs)
        del _MADE[:]
        try:
            _SHOWN.clear()
            _SHOWN.update(id(m) for m in self.get_mobject_family_members())
        except Exception:
            pass
        if start is not None:
            try:
                end = float(self.renderer.time)
                SEGMENTS.append((start, end, len(args) == 1 and isinstance(args[0], Wait)))
                check_frame(self, end)
            except Exception:
                pass
        return result

    Scene.play = play
    for cls in (Text, MarkupText):
        _keep_made(cls)


def _keep_made(cls):
    made = cls.__init__  # already carries cairn_style's defaults

    def __init__(self, *args, **kwargs):
        made(self, *args, **kwargs)
        _MADE.append(self)

    cls.__init__ = __init__


def check_frame(scene, when, final=False):
    try:
        _check_frame(scene, when, final)
    except Exception:
        pass


def check_unshown(scene):
    """Manim writes frames only while play() or wait() runs, so text made or
    added after the last one is missing from the video, often the summary
    the scene was building to."""
    try:
        from manim import DecimalNumber, MarkupText, Paragraph, SingleStringMathTex, Text
        kinds = (Text, MarkupText, Paragraph, SingleStringMathTex, DecimalNumber)
        late, visited = list(_MADE), set()

        def walk(mob):
            if id(mob) in visited:
                return
            visited.add(id(mob))
            if isinstance(mob, kinds):
                if id(mob) not in _SHOWN:
                    late.append(getattr(mob, "lines_text", mob))  # a Paragraph's words
                return
            for sub in mob.submobjects:
                walk(sub)

        for mob in list(scene.mobjects) + list(getattr(scene, "foreground_mobjects", [])):
            walk(mob)
        names = []
        for mob in late:
            name = _named(mob)
            if name not in names:
                names.append(name)
        if names:
            if len(names) > 3:
                listed = ", ".join(names[:3]) + " and %d more" % (len(names) - 3)
            else:
                listed = " and ".join([", ".join(names[:-1]), names[-1]]) if len(names) > 1 else names[0]
            _note(None, ("unshown",),
                  "%s never appear%s: the video ends with the last play() or wait(), so text made or "
                  "added after it is missing. Show it with self.play(FadeIn(...)), then end with "
                  "self.wait(1)." % (listed, "s" if len(names) == 1 else ""))
    except Exception:
        pass


def _note(when, key, message):
    if key in _SEEN or len(ISSUES) >= MAX_ISSUES:
        return
    _SEEN.add(key)
    ISSUES.append(("At %.1f s: " % when if when is not None else "") + message)


def _drawn(mob):
    """Whether mob's own fill or outline shows."""
    try:
        if mob.get_fill_opacity() > 0.05:
            return True
        return mob.get_stroke_opacity() > 0.05 and mob.get_stroke_width() > 0.01
    except Exception:
        return False


def _filled(mob):
    try:
        return mob.get_fill_opacity() >= 0.5
    except Exception:
        return False


def _extent(points):
    lo, hi = points.min(axis=0), points.max(axis=0)
    return (float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1]))


def _area(box):
    return max(box[2] - box[0], 0.0) * max(box[3] - box[1], 0.0)


def _middle(box):
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


def _contains(box, point):
    return box[0] < point[0] < box[2] and box[1] < point[1] < box[3]


def _inside(inner, outer):
    return (inner[0] >= outer[0] - 0.02 and inner[2] <= outer[2] + 0.02
            and inner[1] >= outer[1] - 0.02 and inner[3] <= outer[3] + 0.02)


def _overlaps(a, b):
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def _shrink(box, factor):
    x, y = _middle(box)
    w, h = (box[2] - box[0]) * factor / 2.0, (box[3] - box[1]) * factor / 2.0
    return (x - w, y - h, x + w, y + h)


def _cut_off(box, frame):
    """Partly in the frame and partly out of it (wholly outside is unseen)."""
    seen = box[0] < frame[2] and box[2] > frame[0] and box[1] < frame[3] and box[3] > frame[1]
    return seen and (box[0] < frame[0] - 0.02 or box[2] > frame[2] + 0.02
                     or box[1] < frame[1] - 0.02 or box[3] > frame[3] + 0.02)


def _crosses(line, box):
    """Whether the line's path runs through the box (Liang-Barsky on the
    segments between its anchors)."""
    points = line.points
    for i in range(0, len(points) - 3, 4):
        x0, y0 = float(points[i][0]), float(points[i][1])
        dx, dy = float(points[i + 3][0]) - x0, float(points[i + 3][1]) - y0
        lo, hi = 0.0, 1.0
        for p, q in ((-dx, x0 - box[0]), (dx, box[2] - x0), (-dy, y0 - box[1]), (dy, box[3] - y0)):
            if abs(p) < 1e-12:
                if q < 0:
                    lo, hi = 1.0, 0.0
            elif p < 0:
                lo = max(lo, q / p)
            else:
                hi = min(hi, q / p)
        if lo <= hi:
            return True
    return False


def _a(kind):
    return ("an " if kind[:1] in "AEIOU" else "a ") + kind


def _named(mob):
    """How a message names a text: its words, or its number."""
    for attr in ("original_text", "tex_string", "text"):
        value = getattr(mob, attr, None)
        if isinstance(value, str) and value.strip():
            value = " ".join(value.split())
            return '"%s"' % (value if len(value) <= 28 else value[:25] + "...")
    number = getattr(mob, "number", None)
    if isinstance(number, (int, float)):
        return "the number %g" % number
    return _a(type(mob).__name__)


def _at(box):
    return "at (%.1f, %.1f)" % _middle(box)


def _check_frame(scene, when, final):
    import numpy as np
    from manim import (Circle, DecimalNumber, Line, MarkupText, NumberPlane, Paragraph, Rectangle,
                       SingleStringMathTex, Text, VMobject)

    camera = scene.renderer.camera
    if any(cls.__name__ == "ThreeDCamera" for cls in type(camera).__mro__):
        return  # points are projected; their x and y are not the picture's
    x, y = float(camera.frame_center[0]), float(camera.frame_center[1])
    w, h = camera.frame_width / 2.0, camera.frame_height / 2.0
    frame = (x - w, y - h, x + w, y + h)
    edge = "keep everything within x %.1f..%.1f, y %.1f..%.1f" % (
        frame[0] + 0.6, frame[2] - 0.6, frame[1] + 0.4, frame[3] - 0.4)

    texts = []   # (draw order of its last part, mob, extent, has a filled backdrop)
    shapes = []  # (draw order, mob, extent of its own outline)
    skip, grid = set(), set()
    for order, mob in enumerate(scene.get_mobject_family_members()):
        if id(mob) in skip:
            continue
        if isinstance(mob, NumberPlane):
            grid.update(id(part) for part in mob.get_family())
        if isinstance(mob, (Text, MarkupText, Paragraph, SingleStringMathTex, DecimalNumber)):
            family = mob.get_family()
            skip.update(id(part) for part in family[1:])
            drawn = [part.points for part in family if len(part.points) and _drawn(part)]
            if drawn:
                box = _extent(np.vstack(drawn))
                if _area(box) > 1e-6:
                    backdrop = any(isinstance(part, Rectangle) and _filled(part) for part in family[1:])
                    texts.append((order + len(family) - 1, mob, box, backdrop))
        elif isinstance(mob, VMobject) and len(mob.points) and _drawn(mob):
            shapes.append((order, mob, _extent(mob.points)))
    texts = texts[:60]

    held = {}  # id of the box a text sits in -> (extent, the texts it holds)
    for order, mob, box, backdrop in texts:
        name = _named(mob)
        where = "%s %s" % (name, _at(box))
        middle = _middle(box)
        area = _area(box)
        try:
            size = float(mob.font_size)
        except Exception:
            size = 0.0
        if 1.0 < size < 23.5:
            _note(when, ("small", name), "%s is too small to read (font_size %d): use 24 or more." % (where, round(size)))
        if _cut_off(box, frame):
            _note(when, ("frame", name), "%s is cut off by the edge of the frame: %s." % (where, edge))
        holder = None
        for _order, shape, s_box in shapes:
            if isinstance(shape, (Rectangle, Circle)) and _contains(s_box, middle) and _area(s_box) >= 0.5 * area:
                if holder is None or _area(s_box) < _area(holder[1]):
                    holder = (shape, s_box)
        if holder is not None:
            s_box = holder[1]
            if isinstance(holder[0], Rectangle):
                held.setdefault(id(holder[0]), (s_box, []))[1].append(name)
            spill = max(s_box[0] - box[0], box[2] - s_box[2], s_box[1] - box[1], box[3] - s_box[3])
            if spill > 0.03:
                _note(when, ("spill", name),
                      "%s spills %.2f past the edge of its %s: size the box from the text, e.g. "
                      "SurroundingRectangle(label, buff=0.2) or width=label.width + 0.5."
                      % (where, spill, "circle" if isinstance(holder[0], Circle) else "box"))
        if backdrop:
            continue
        for s_order, shape, s_box in shapes:
            if s_order > order and _filled(shape) and _contains(s_box, middle) and _area(s_box) >= 0.25 * area:
                _note(when, ("hidden", name),
                      "%s is hidden under %s drawn after it: add the text after the shape, e.g. "
                      "VGroup(box, label) with the box first." % (where, _a(type(shape).__name__)))
                break
        inner = _shrink(box, 0.7)
        for _order, shape, s_box in shapes:
            if isinstance(shape, Line) and shape.get_stroke_width() >= 3 and _overlaps(s_box, inner) and _crosses(shape, inner):
                _note(when, ("crossed", name),
                      "%s is crossed by %s: move the label clear of it, e.g. next_to(line, UP, buff=0.15), "
                      "or end the line before the text (buff)." % (where, _a(type(shape).__name__)))
                break

    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            a, b = texts[i][2], texts[j][2]
            shared = max(min(a[2], b[2]) - max(a[0], b[0]), 0.0) * max(min(a[3], b[3]) - max(a[1], b[1]), 0.0)
            if min(a[2], b[2]) - max(a[0], b[0]) <= 0.05 or min(a[3], b[3]) - max(a[1], b[1]) <= 0.05:
                continue
            if shared < 0.15 * min(_area(a), _area(b)):
                continue
            first, second = _named(texts[i][1]), _named(texts[j][1])
            key = ("overlap",) + tuple(sorted((first, second)))
            if first == second and shared > 0.8 * (_area(a) + _area(b) - shared):
                _note(when, key,
                      "%s %s is drawn twice in the same place, a leftover copy: after Transform(a, b) keep "
                      "using a (b is never added), or use ReplacementTransform; FadeOut copies you no longer "
                      "need." % (first, _at(a)))
            else:
                _note(when, key,
                      "%s %s and %s %s overlap: move them apart, e.g. arrange(..., buff=0.3) or "
                      "next_to(..., buff=0.25), or FadeOut the old one first." % (first, _at(a), second, _at(b)))

    # Boxes that hold labels must not cut into each other (one inside another is fine).
    held = list(held.values())
    for i in range(len(held)):
        for j in range(i + 1, len(held)):
            (a, a_names), (b, b_names) = held[i], held[j]
            across = min(a[2], b[2]) - max(a[0], b[0])
            down = min(a[3], b[3]) - max(a[1], b[1])
            if across <= 0.05 or down <= 0.05 or _inside(a, b) or _inside(b, a):
                continue
            first, second = a_names[0], b_names[0]
            _note(when, ("boxes",) + tuple(sorted((first, second))),
                  "The boxes around %s %s and %s %s overlap by %.2f: place a box beside another with "
                  "next_to(other, RIGHT, buff=0.2), or arrange the row; move_to(point) puts the box's "
                  "centre on the point." % (first, _at(a), second, _at(b), min(across, down)))

    for _order, shape, s_box in shapes:
        if id(shape) not in grid and _cut_off(s_box, frame):
            kind = type(shape).__name__
            _note(when, ("frame", kind), "%s %s is cut off by the edge of the frame: %s." % (_a(kind), _at(s_box), edge))

    if final:
        boxes = [s_box for _order, shape, s_box in shapes if isinstance(shape, Rectangle) and 0.05 <= _area(s_box) <= 6.0]
        holding = [any(_contains(s_box, _middle(t[2])) for t in texts) for s_box in boxes]
        done = set()
        for i, s_box in enumerate(boxes):
            if i in done:
                continue
            tall = s_box[3] - s_box[1]
            row = [j for j, other in enumerate(boxes)
                   if abs(_middle(other)[1] - _middle(s_box)[1]) < 0.15 and abs((other[3] - other[1]) - tall) <= 0.25 * tall + 0.05]
            done.update(row)
            empty = [j for j in row if not holding[j]]
            if empty and len(row) - len(empty) >= 2:
                spots = ", ".join("(%.1f, %.1f)" % _middle(boxes[j]) for j in empty[:4])
                _note(when, ("empty", round(_middle(s_box)[1], 1)),
                      "%d of the %d boxes in the row at y = %.1f are empty at the end, at %s: the label meant "
                      "for each never arrived. Keep each box and its label in one VGroup and move, copy or "
                      "transform the group (ignore this if they are meant to be empty)."
                      % (len(empty), len(row), _middle(s_box)[1], spots))


def render():
    """Render the scene: a PIL image (still) or the video's path."""
    check_scene()
    out = ""
    try:
        import importlib.util
        import cairn_style
        from manim import tempconfig
        options = {
            "quality": QUALITY[MODE],
            "media_dir": MEDIA,
            "disable_caching": True,
            "progress_bar": "none",
            "verbosity": "WARNING",
            "background_color": cairn_style.PAPER,
            "output_file": "lesson",
            "save_last_frame": MODE == "still",
            "write_to_movie": MODE != "still",
        }
        with tempconfig(options):
            if MODE == "preview":
                watch_plays()
            spec = importlib.util.spec_from_file_location("scene", SCENE)
            module = importlib.util.module_from_spec(spec)
            sys.modules["scene"] = module
            spec.loader.exec_module(module)
            scene = module.Lesson()
            scene.render()
            if MODE == "still":
                # The camera's final frame, whether or not the scene played
                # anything (Manim saves no image for a scene without plays).
                scene.renderer.update_frame(scene)
                check_frame(scene, None, final=True)
                return scene.renderer.camera.get_image()
            if MODE == "preview":
                check_unshown(scene)
                check_frame(scene, float(scene.renderer.time), final=True)
            writer = getattr(scene.renderer, "file_writer", None)
            out = str(getattr(writer, "movie_file_path", "") or "")
    except SystemExit:
        fail("scene.py stopped the program (exit() or sys.exit()). Remove that call.")
    except BaseException as exc:
        fail(error_text(exc))
    if not out or not os.path.isfile(out):
        out = newest_video()
    if not out:
        fail("Manim finished without a video: construct() must animate with self.play(...) or hold with self.wait(...).")
    return out


def video_duration(path):
    import av
    with av.open(path) as container:
        stream = container.streams.video[0]
        if stream.duration is not None and stream.time_base is not None:
            return float(stream.duration * stream.time_base)
        if container.duration is not None:
            return container.duration / 1000000.0
        end = 0.0
        for packet in container.demux(stream):
            if packet.pts is not None and packet.time_base is not None:
                end = max(end, float((packet.pts + (packet.duration or 0)) * packet.time_base))
        return end


def spread(items, k):
    """k of items, evenly spread and keeping the first and the last."""
    if k <= 0:
        return []
    if len(items) <= k:
        return list(items)
    if k == 1:
        return [items[-1]]
    return [items[int(round(i * (len(items) - 1) / (k - 1.0)))] for i in range(k)]


def settled_moments(duration):
    """When the preview stands still, for the contact sheet: the start of
    each wait() after an animation, then the instants one animation hands
    over to the next. The sheet adds the final frame itself."""
    holds, handovers = [], []
    for k, (start, _end, is_wait) in enumerate(SEGMENTS):
        if start >= duration - 0.05:
            continue
        if is_wait:
            # A wait after a wait shows nothing new; trailing waits show
            # the final frame.
            if (k > 0 and SEGMENTS[k - 1][2]) or all(s[2] for s in SEGMENTS[k:]):
                continue
            holds.append(start)
        elif k > 0 and not SEGMENTS[k - 1][2]:
            handovers.append(start)
    picks = spread(holds, SHEET_FRAMES - 1)
    picks = sorted(picks + spread(handovers, SHEET_FRAMES - 1 - len(picks)))
    if len(picks) < 3:
        # Too few beats to go by (or none recorded): add evenly spaced times
        # that show something the sheet doesn't yet.
        for k in range(1, 6):
            t = duration * k / 6.0
            if not _shown(t, picks):
                picks.append(t)
        picks = sorted(picks)[:SHEET_FRAMES - 1]
    return picks


def _shown(t, picks):
    """Whether the frame at t looks like one the sheet already has: within
    0.4 s of a picked moment, or of a run of waits that is picked (or ends
    the video, which the final frame shows)."""
    if any(abs(t - p) < 0.4 for p in picks):
        return True
    k = 0
    while k < len(SEGMENTS):
        if SEGMENTS[k][2]:
            first = k
            while k + 1 < len(SEGMENTS) and SEGMENTS[k + 1][2]:
                k += 1
            start, end = SEGMENTS[first][0], SEGMENTS[k][1]
            if start - 0.4 < t < end + 0.4 and (
                    k == len(SEGMENTS) - 1 or any(abs(start - p) < 1e-3 for p in picks)):
                return True
        k += 1
    return False


def sample_frames(path, settled=False):
    """The frames at the settled moments (if asked), and the final frame."""
    import av
    duration = video_duration(path)
    targets = settled_moments(duration) if settled else []
    picks = []
    last = None
    last_t = 0.0
    with av.open(path) as container:
        stream = container.streams.video[0]
        width = stream.codec_context.width
        height = stream.codec_context.height
        rate = float(stream.average_rate or stream.guessed_rate or 15)
        for frame in container.decode(stream):
            t = float(frame.time) if frame.time is not None else last_t
            if targets and t + 0.5 / rate >= targets[0]:
                picks.append((t, frame.to_image()))
                while targets and t + 0.5 / rate >= targets[0]:
                    targets.pop(0)
            last, last_t = frame, t
    if last is None:
        fail("The rendered video has no frames.")
    picks = [(t, image) for t, image in picks if t < last_t - 1e-6]
    return (duration or last_t), width, height, picks, (last_t, last.to_image())


def contact_sheet(shots):
    """The shots in rows of three, each captioned with its time; the last
    one is the final frame."""
    from PIL import Image, ImageDraw, ImageFont
    count = len(shots)
    cols = min(3, count)
    rows = (count + cols - 1) // cols
    thumb_w, pad, label = 480, 8, 24
    first = shots[0][1]
    thumb_h = max(1, round(first.height * thumb_w / first.width))
    sheet = Image.new("RGB", (cols * thumb_w + (cols + 1) * pad, rows * (label + thumb_h) + (rows + 1) * pad), "#EEEEEE")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=18)
    except Exception:
        font = ImageFont.load_default()
    for i, (t, image) in enumerate(shots):
        x = pad + (i % cols) * (thumb_w + pad)
        y = pad + (i // cols) * (label + thumb_h + pad)
        sheet.paste(image.convert("RGB").resize((thumb_w, thumb_h)), (x, y + label))
        draw.rectangle([x - 1, y + label - 1, x + thumb_w, y + label + thumb_h], outline="#BBBBBB")
        caption = ("end, t = %.1f s" if i == count - 1 else "t = %.1f s") % t
        draw.text((x, y + 3), caption, fill="#1F1F1F", font=font)
    return sheet


def png_bytes(image):
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def main():
    if MODE not in QUALITY:
        fail("Unknown render mode: %s" % MODE)
    rendered = render()
    try:
        if MODE == "still":
            emit_file("still.png", png_bytes(rendered))
            finish(ok=True, width=rendered.width, height=rendered.height, issues=ISSUES)
        if MODE == "preview":
            duration, width, height, picks, last = sample_frames(rendered, settled=True)
            emit_file("sheet.png", png_bytes(contact_sheet(picks + [last])))
            finish(ok=True, durationSec=round(duration, 2), width=width, height=height, issues=ISSUES)
        duration, width, height, _picks, last = sample_frames(rendered)
        with open(rendered, "rb") as fh:
            emit_file("video.mp4", fh.read())
        emit_file("poster.png", png_bytes(last[1]))
        finish(ok=True, durationSec=round(duration, 2), width=width, height=height)
    except BaseException as exc:
        fail("Cairn couldn't read the render: " + error_text(exc))


if __name__ == "__main__":
    main()
`;

const STYLE_PY = String.raw`"""Cairn's paper palette for Manim: the app's own figure colors
(src/core/figure-theme.ts). Imported before scene.py runs, so a scene that
names no colour still draws dark ink on warm paper. Scenes may use these
names: from cairn_style import *"""
import manim
from manim import config

PAPER = "${FIGURE.light.paper}"
INK = "${FIGURE.light.ink}"
MUTED = "${FIGURE.light.muted}"
FAINT = "${FIGURE.light.faint}"
ACCENT = "${FIGURE.light.accent}"
ACCENT2 = "${FIGURE.light.accent2}"

__all__ = ["PAPER", "INK", "MUTED", "FAINT", "ACCENT", "ACCENT2"]

config.background_color = PAPER

# Manim's defaults are white (or yellow) for a black background; on paper
# they would vanish.
_DEFAULTS = [(name, INK) for name in (
    "VMobject", "Text", "MarkupText", "Paragraph", "Tex", "MathTex", "SingleStringMathTex",
    "DecimalNumber", "Integer", "Line", "DashedLine", "Arrow", "DoubleArrow", "Vector",
    "CurvedArrow", "CurvedDoubleArrow", "Arc", "ArcBetweenPoints", "NumberLine", "Circle",
    "Ellipse", "Square", "Rectangle", "RoundedRectangle", "Polygon", "RegularPolygon",
    "Triangle", "Dot", "Brace", "Annulus", "AnnularSector", "Sector",
)] + [("SurroundingRectangle", ACCENT2), ("LabeledDot", FAINT)]

for _name, _color in _DEFAULTS:
    try:
        getattr(manim, _name).set_default(color=_color)
    except Exception:
        pass

# Text with no font falls back to Pango's default family, a serif. The
# house font is a clean sans; a scene can still pass font=... itself.
FONT = "Noto Sans"
for _name in ("Text", "MarkupText"):
    try:
        getattr(manim, _name).set_default(font=FONT)
    except Exception:
        pass

# Emphasis in the accent: Manim's yellow is unreadable on paper.
for _name in ("Indicate", "Circumscribe", "Flash"):
    try:
        getattr(manim, _name).set_default(color=ACCENT)
    except Exception:
        pass
`;
