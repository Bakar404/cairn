/**
 * SETTINGS › STORAGE (OneDrive wave, 2026-10-27): where the library lives,
 * and moving it — GET/PUT /api/storage.
 *
 * The library (chats, graph, media, jobs) lives in the data folder, or in
 * the work OneDrive the OneDrive client syncs (<OneDrive>/Apps/Cairn). The
 * switch is live: config.ts PATHS read the location on every call. It
 * refuses while anything could write in the middle — a reply, a background
 * job, a knowledge-map update — and the move itself is synchronous, so
 * nothing else in the process runs until it has committed or rolled back.
 *
 * The client names a location, never a path: every path is resolved here.
 */

import * as fs from "node:fs";
import { DATA_ROOT, FOLLOW_POINTER, PATHS } from "../../config.ts";
import type { LibraryKind, LibraryMove, LibraryMoveMode, LibrarySummary, StorageStatus, StorageSwitchRequest } from "../core/storage.ts";
import { liveJobCount } from "../agent/subagents/aborts.ts";
import { extractionBusy } from "../agent/subagents/extraction.ts";
import { hasLibrary, LibraryError, libraryStats, moveLibrary, readPointer, samePath } from "../store/library.ts";
import { detectWorkOneDrive, oneDriveLibraryPath } from "../store/onedrive.ts";
import { anyCompactionRunning } from "./compaction.ts";
import { anyTurnRunning } from "./turn-liveness.ts";

export type StorageSwitchFailure = {
	ok: false;
	code: "busy" | "no_onedrive" | "same" | "library_exists" | "failed";
	message: string;
	/** library_exists: the library already at the target. */
	target?: LibrarySummary & { root: string };
};

export type StorageSwitchOutcome = { ok: true; status: StorageStatus; move: LibraryMove } | StorageSwitchFailure;

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function workOneDrive(): StorageStatus["onedrive"] {
	const drive = detectWorkOneDrive();
	return drive ? { ...drive, library: oneDriveLibraryPath(drive.root) } : null;
}

export function storageStatus(): StorageStatus {
	const root = PATHS.library;
	const pointer = readPointer(DATA_ROOT);
	const onedrive = workOneDrive();
	let kind: LibraryKind = "folder";
	if (samePath(root, DATA_ROOT)) kind = "local";
	else if (pointer.provider === "onedrive" || (onedrive && samePath(root, onedrive.library))) kind = "onedrive";
	return {
		library: { root, kind, available: isDir(root), ...libraryStats(root) },
		local: DATA_ROOT,
		onedrive,
		last: pointer.last ?? null,
	};
}

function exists(root: string): StorageSwitchFailure {
	return {
		ok: false,
		code: "library_exists",
		message: "There's already a Cairn library there.",
		target: { root, ...libraryStats(root) },
	};
}

/** Move the library to the data folder or the work OneDrive. */
export function switchLibrary(req: StorageSwitchRequest): StorageSwitchOutcome {
	if (!FOLLOW_POINTER) {
		return { ok: false, code: "failed", message: "The library can't move in a test run without its own LH_DATA_DIR." };
	}
	if (anyTurnRunning() || anyCompactionRunning() || liveJobCount() > 0 || extractionBusy()) {
		return {
			ok: false,
			code: "busy",
			message: "Cairn is still working. Wait for replies, background jobs, and map updates to finish, then try again.",
		};
	}
	let to: string;
	let provider: "onedrive" | undefined;
	if (req.location === "onedrive") {
		const drive = workOneDrive();
		if (!drive) {
			return {
				ok: false,
				code: "no_onedrive",
				message: "This computer has no work OneDrive set up. Sign in to OneDrive with your work account, then try again.",
			};
		}
		to = drive.library;
		provider = "onedrive";
	} else {
		to = DATA_ROOT;
	}
	const from = PATHS.library;
	if (samePath(from, to)) return { ok: false, code: "same", message: "The library is already there." };

	const occupied = hasLibrary(to);
	if (occupied && !req.existing) return exists(to);
	const mode: LibraryMoveMode = !occupied ? "copy" : req.existing === "use" ? "use-existing" : "replace";
	try {
		const move = moveLibrary({ dataRoot: DATA_ROOT, from, to, mode, ...(provider ? { provider } : {}) });
		console.log(`[storage] moved the library (${mode}): ${from} → ${to}`);
		if (move.warning) console.warn(`[storage] ${move.warning}`);
		return { ok: true, status: storageStatus(), move };
	} catch (err) {
		if (err instanceof LibraryError && err.code === "not_empty") return exists(to);
		if (err instanceof LibraryError && err.code === "same") return { ok: false, code: "same", message: err.message };
		console.error("[storage] the library move failed:", err);
		return { ok: false, code: "failed", message: err instanceof Error ? err.message : String(err) };
	}
}
