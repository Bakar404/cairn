/**
 * THE LIBRARY LOCATION (OneDrive wave, 2026-10-27) — where the learner's
 * library lives and how it moves.
 *
 * The LIBRARY is the four folders that are the learner's work: chats/,
 * graph/, media/, jobs/. It lives in the data folder unless the device-local
 * POINTER (data/storage.json, never synced) names another folder — the work
 * OneDrive, chosen in Settings › Storage. Everything else in the data folder
 * is device state and never moves: settings.json, prompts/, debug/,
 * copilot/ (the SDK's sign-in state), and the pointer itself.
 *
 * The current root is memoized on globalThis (Next dev gives each route
 * entry its own module instances; the turn-liveness lesson), so a move made
 * by one route is seen by every other at once — config.ts PATHS reads it
 * at call time, no restart.
 *
 * Moves are SYNCHRONOUS on purpose: every library write in Cairn is sync
 * too, so nothing in this process can write in the middle of one. A move
 * stages a full copy beside the target, swaps it in, then commits by
 * writing the pointer; any failure before the commit undoes every step.
 * Nothing is ever deleted: the copy a move leaves behind is set aside in
 * library-backups/<stamp>/.
 *
 * Deliberately free of config.ts (config.ts imports this module).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LibraryMove, LibraryMoveMode, LibrarySummary } from "../core/storage.ts";

/** The folders that make up the library — everything that follows it. */
export const LIBRARY_DIRS = ["chats", "graph", "media", "jobs"] as const;

/** The pointer, in the data folder. Absent = the library is local. */
export const POINTER_FILE = "storage.json";
/** This install's id, in the data folder (see deviceId). */
export const DEVICE_FILE = "device.json";
/** Where a move sets aside the copy it replaces or leaves behind. */
export const BACKUPS_DIR = "library-backups";

export interface StoragePointer {
	version: 1;
	/** Absolute library root. Absent = the data folder itself. */
	library?: string;
	provider?: "onedrive";
	last?: LibraryMove;
}

export type LibraryErrorCode = "same" | "nested" | "not_empty" | "no_library" | "failed";

export class LibraryError extends Error {
	readonly code: LibraryErrorCode;
	constructor(code: LibraryErrorCode, message: string) {
		super(message);
		this.name = "LibraryError";
		this.code = code;
	}
}

// ─── The pointer ───────────────────────────────────────────────────────────

const MOVE_MODES: readonly LibraryMoveMode[] = ["copy", "use-existing", "replace"];

function isMove(value: unknown): value is LibraryMove {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.at === "string" &&
		typeof v.from === "string" &&
		typeof v.to === "string" &&
		MOVE_MODES.includes(v.mode as LibraryMoveMode) &&
		(v.backups === undefined || (Array.isArray(v.backups) && v.backups.every((b) => typeof b === "string"))) &&
		(v.warning === undefined || typeof v.warning === "string")
	);
}

/** The pointer, sanitized. Missing → local. Unreadable or malformed → local,
 *  with a warning: a broken pointer must never stop Cairn from starting. */
export function readPointer(dataRoot: string): StoragePointer {
	const file = path.join(dataRoot, POINTER_FILE);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[storage] couldn't read ${file}; using the local library:`, err);
		return { version: 1 };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.warn(`[storage] ${file} isn't valid JSON; using the local library.`);
		return { version: 1 };
	}
	const v = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
	if (v.version !== 1) {
		console.warn(`[storage] ${file} has an unknown version; using the local library.`);
		return { version: 1 };
	}
	const pointer: StoragePointer = { version: 1 };
	if (typeof v.library === "string") {
		if (path.isAbsolute(v.library)) pointer.library = path.resolve(v.library);
		else console.warn(`[storage] ${file} names a relative library path; using the local library.`);
	}
	if (pointer.library && v.provider === "onedrive") pointer.provider = "onedrive";
	if (isMove(v.last)) pointer.last = v.last;
	return pointer;
}

/** Atomic: a crash mid-write leaves the old pointer, never half of one. */
export function writePointer(dataRoot: string, pointer: StoragePointer): void {
	fs.mkdirSync(dataRoot, { recursive: true });
	const file = path.join(dataRoot, POINTER_FILE);
	const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(pointer, null, "\t")}\n`, "utf-8");
		renameRetry(tmp, file);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}

// ─── The current root (process-wide) ───────────────────────────────────────

type Memo = Map<string, string>;
const g = globalThis as typeof globalThis & { __cairnLibrary?: Memo; __cairnDevice?: Memo };

function roots(): Memo {
	g.__cairnLibrary ??= new Map();
	return g.__cairnLibrary;
}

/** The library root for a data folder: the pointer's, else the folder itself.
 *  Read once per process, then kept current by moveLibrary. */
export function currentLibraryRoot(dataRoot: string): string {
	const key = path.resolve(dataRoot);
	const hit = roots().get(key);
	if (hit) return hit;
	const root = readPointer(key).library ?? key;
	roots().set(key, root);
	return root;
}

// ─── This device ───────────────────────────────────────────────────────────

/**
 * This install's id: a random UUID kept in the data folder (device.json),
 * created on first use. A synced library carries every device's job records;
 * the id is how a device tells its own from another's. Random rather than
 * derived from the hostname, so it survives a rename and identifies nothing.
 */
export function deviceId(dataRoot: string): string {
	const key = path.resolve(dataRoot);
	g.__cairnDevice ??= new Map();
	const memo = g.__cairnDevice;
	const hit = memo.get(key);
	if (hit) return hit;
	const file = path.join(key, DEVICE_FILE);
	let id = readDeviceFile(file);
	if (!id) {
		id = crypto.randomUUID();
		try {
			fs.mkdirSync(key, { recursive: true });
			fs.writeFileSync(file, `${JSON.stringify({ id }, null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
		} catch (err) {
			// Another process won the race: adopt its id. Anything else keeps
			// this run's id in memory only.
			const winner = readDeviceFile(file);
			if (winner) id = winner;
			else console.warn(`[storage] couldn't save this device's id to ${file}:`, err);
		}
	}
	memo.set(key, id);
	return id;
}

function readDeviceFile(file: string): string | undefined {
	try {
		const id = (JSON.parse(fs.readFileSync(file, "utf-8")) as { id?: unknown }).id;
		return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

// ─── Looking at a library (never downloads a OneDrive file) ───────────────

const MAX_DEPTH = 32;

function list(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** File / directory / neither. A OneDrive placeholder can list as a link
 *  (it's a reparse point): stat it — stat reads metadata, never content. */
function kindOf(dir: string, entry: fs.Dirent): "file" | "dir" | null {
	if (entry.isFile()) return "file";
	if (entry.isDirectory()) return "dir";
	if (!entry.isSymbolicLink()) return null;
	try {
		const stat = fs.statSync(path.join(dir, entry.name));
		return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : null;
	} catch {
		return null;
	}
}

/** Files under a folder, stopping at `limit` (a missing folder has none). */
function countFiles(dir: string, limit = Number.POSITIVE_INFINITY, depth = 0): number {
	if (depth > MAX_DEPTH) return 0;
	let n = 0;
	for (const entry of list(dir)) {
		const kind = kindOf(dir, entry);
		if (kind === "file") n++;
		else if (kind === "dir") n += countFiles(path.join(dir, entry.name), limit - n, depth + 1);
		if (n >= limit) break;
	}
	return n;
}

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Chats, files, and the newest chat change in a library folder. */
export function libraryStats(root: string): LibrarySummary {
	const chatsDir = path.join(root, "chats");
	let chats = 0;
	let newest = 0;
	for (const entry of list(chatsDir)) {
		if (!entry.name.endsWith(".json") || kindOf(chatsDir, entry) !== "file") continue;
		chats++;
		try {
			newest = Math.max(newest, fs.statSync(path.join(chatsDir, entry.name)).mtimeMs);
		} catch {
			/* vanished mid-count */
		}
	}
	let files = 0;
	for (const dir of LIBRARY_DIRS) files += countFiles(path.join(root, dir));
	return { chats, files, updatedAt: newest > 0 ? new Date(newest).toISOString() : null };
}

/** Whether a folder already holds a library (any file in a library folder). */
export function hasLibrary(root: string): boolean {
	return LIBRARY_DIRS.some((dir) => countFiles(path.join(root, dir), 1) > 0);
}

// ─── Paths ─────────────────────────────────────────────────────────────────

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function norm(p: string): string {
	const resolved = path.resolve(p);
	return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string): boolean {
	return norm(a) === norm(b);
}

/** Whether `child` is `parent` or inside it. */
function inside(child: string, parent: string): boolean {
	const rel = path.relative(norm(parent), norm(child));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** One library inside a library folder of the other would copy into itself. */
function overlaps(a: string, b: string): boolean {
	return LIBRARY_DIRS.some((dir) => inside(b, path.join(a, dir)) || inside(a, path.join(b, dir)));
}

// ─── Moving ────────────────────────────────────────────────────────────────

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rename, riding out the brief locks Windows Defender, the search indexer,
 *  and the OneDrive client take on fresh files (~1.5 s at most). */
export function renameRetry(from: string, to: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
			sleep(50 * 2 ** attempt);
		}
	}
}

export interface MoveLibraryRequest {
	/** The data folder: holds the pointer, never moves. */
	dataRoot: string;
	from: string;
	to: string;
	mode: LibraryMoveMode;
	provider?: "onedrive";
	now?: Date;
}

/**
 * Move the library from `from` to `to` and point this device at it.
 *
 *   copy          `to` holds no library: copy ours in.
 *   use-existing  `to` holds one: adopt it as is.
 *   replace       `to` holds one: set it aside, copy ours in.
 *
 * Leaving the data folder sets its copy aside under
 * data/library-backups/<stamp>/ (nothing is deleted), so a later move back
 * finds it empty. A synced folder is never emptied: other devices may use
 * it. Throws LibraryError; on any failure before the commit the target, the
 * pointer, and this process are as they were.
 */
export function moveLibrary(req: MoveLibraryRequest): LibraryMove {
	const dataRoot = path.resolve(req.dataRoot);
	const from = path.resolve(req.from);
	const to = path.resolve(req.to);
	if (samePath(from, to)) throw new LibraryError("same", "The library is already there.");
	if (overlaps(from, to)) throw new LibraryError("nested", "One library folder can't sit inside the other.");
	const occupied = hasLibrary(to);
	if (req.mode === "copy" && occupied) throw new LibraryError("not_empty", `${to} already holds a library.`);
	if (req.mode === "use-existing" && !occupied) throw new LibraryError("no_library", `${to} holds no library to use.`);

	const at = (req.now ?? new Date()).toISOString();
	const stamp = at.replace(/[:.]/g, "-");
	const move: LibraryMove = { at, from, to, mode: req.mode };
	const toLocal = samePath(to, dataRoot);
	const pointer: StoragePointer = {
		version: 1,
		...(toLocal ? {} : { library: to, ...(req.provider ? { provider: req.provider } : {}) }),
		last: move,
	};

	const undo: Array<() => void> = [];
	try {
		const made = fs.mkdirSync(to, { recursive: true });
		if (made) undo.push(() => removeEmptyUpTo(to, made));
		if (req.mode !== "use-existing") stageInto(from, to, stamp, req.mode === "replace", move, undo);
		writePointer(dataRoot, pointer);
	} catch (err) {
		for (const step of undo.reverse()) {
			try {
				step();
			} catch (undoErr) {
				console.error("[storage] couldn't undo a step of the failed move:", undoErr);
			}
		}
		if (err instanceof LibraryError) throw err;
		throw new LibraryError("failed", `Cairn couldn't move the library: ${(err as Error).message}`);
	}
	roots().set(dataRoot, toLocal ? dataRoot : to);

	if (samePath(from, dataRoot)) {
		setAside(dataRoot, path.join(dataRoot, BACKUPS_DIR, stamp), move);
		try {
			writePointer(dataRoot, { ...pointer, last: move });
		} catch (err) {
			console.warn("[storage] the move succeeded but its note in the pointer didn't update:", err);
		}
	}
	return move;
}

/** Copy `from` into a stage inside `to`, then swap each folder in. Every
 *  step pushes its own undo. */
function stageInto(from: string, to: string, stamp: string, replace: boolean, move: LibraryMove, undo: Array<() => void>): void {
	const stage = path.join(to, `.incoming-${stamp}`);
	fs.mkdirSync(stage, { recursive: true });
	undo.push(() => fs.rmSync(stage, { recursive: true, force: true }));
	for (const dir of LIBRARY_DIRS) {
		const src = path.join(from, dir);
		if (!isDir(src)) continue;
		fs.cpSync(src, path.join(stage, dir), {
			recursive: true,
			errorOnExist: true,
			force: false,
			preserveTimestamps: true,
			dereference: true,
		});
	}
	if (replace) {
		const backup = path.join(to, BACKUPS_DIR, stamp);
		let backupMade = false;
		for (const dir of LIBRARY_DIRS) {
			const dest = path.join(to, dir);
			if (countFiles(dest, 1) === 0) continue;
			if (!backupMade) {
				const first = fs.mkdirSync(backup, { recursive: true });
				if (first) undo.push(() => removeEmptyUpTo(backup, first));
				backupMade = true;
			}
			const aside = path.join(backup, dir);
			renameRetry(dest, aside);
			undo.push(() => renameRetry(aside, dest));
			if (!move.backups?.includes(backup)) (move.backups ??= []).push(backup);
		}
	}
	for (const dir of LIBRARY_DIRS) {
		const staged = path.join(stage, dir);
		if (!isDir(staged)) continue;
		const dest = path.join(to, dir);
		if (fs.existsSync(dest)) {
			if (countFiles(dest, 1) > 0) throw new LibraryError("not_empty", `${dest} already holds files.`);
			fs.rmSync(dest, { recursive: true, force: true });
		}
		renameRetry(staged, dest);
		undo.push(() => {
			fs.mkdirSync(stage, { recursive: true });
			renameRetry(dest, staged);
		});
	}
	fs.rmSync(stage, { recursive: true, force: true });
}

/** After a move, set the data folder's old copy aside. Non-fatal: the move
 *  already committed, so a failure here is a warning on the move. */
function setAside(dataRoot: string, backup: string, move: LibraryMove): void {
	try {
		for (const dir of LIBRARY_DIRS) {
			const src = path.join(dataRoot, dir);
			if (!fs.existsSync(src)) continue;
			if (countFiles(src, 1) === 0) {
				fs.rmSync(src, { recursive: true, force: true });
				continue;
			}
			fs.mkdirSync(backup, { recursive: true });
			renameRetry(src, path.join(backup, dir));
			if (!move.backups?.includes(backup)) (move.backups ??= []).push(backup);
		}
	} catch (err) {
		move.warning = `The library moved, but Cairn couldn't set the old copy in ${dataRoot} aside (${(err as Error).message}). Nothing was lost; you can tidy that folder by hand.`;
		console.warn(`[storage] ${move.warning}`);
	}
}

/** Remove `dir` and its parents up to `top` while they're empty. */
function removeEmptyUpTo(dir: string, top: string): void {
	let current = dir;
	for (;;) {
		try {
			fs.rmdirSync(current);
		} catch {
			return;
		}
		if (samePath(current, top)) return;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
