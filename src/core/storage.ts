/**
 * THE LIBRARY LOCATION, as the shell sees it (OneDrive wave, 2026-10-27).
 *
 * The LIBRARY is the learner's work: chats, the knowledge map, rendered
 * media, and background-job records. By default it lives in the data
 * folder; Settings › Storage can keep it in the work OneDrive instead
 * (<OneDrive>/Apps/Cairn), where the OneDrive client syncs it. Sign-in,
 * settings, and Copilot state never move — they stay on the device.
 *
 * Pure types + the request parser for PUT /api/storage. The fs side lives
 * in src/store/library.ts (moves) and src/server/storage.ts (status).
 */

/** Where the library can be asked to live. */
export type LibraryLocation = "local" | "onedrive";

/** Where it lives now: the data folder, the work OneDrive, or a folder a
 *  hand-edited pointer names. */
export type LibraryKind = "local" | "onedrive" | "folder";

/** What a move does with the target: copy into an empty one, adopt the
 *  library already there, or set that one aside and copy ours in. */
export type LibraryMoveMode = "copy" | "use-existing" | "replace";

/** A library at a glance — counted from directory listings only, so a
 *  OneDrive folder is never downloaded just to describe it. */
export interface LibrarySummary {
	chats: number;
	files: number;
	/** Newest chat change (ISO), or null when there are no chats. */
	updatedAt: string | null;
}

/** The last completed move, kept in the device-local pointer. */
export interface LibraryMove {
	at: string;
	from: string;
	to: string;
	mode: LibraryMoveMode;
	/** Folders holding what the move set aside. Nothing is deleted. */
	backups?: string[];
	/** A non-fatal problem the learner should see. */
	warning?: string;
}

export interface StorageStatus {
	library: LibrarySummary & {
		root: string;
		kind: LibraryKind;
		/** False when the folder is missing (OneDrive signed out, unmounted). */
		available: boolean;
	};
	/** The data folder: device state, and the library when kept locally. */
	local: string;
	/** The work OneDrive this computer syncs, or null when none is set up. */
	onedrive: {
		root: string;
		/** As File Explorer / Finder names it, e.g. "OneDrive - Contoso". */
		label: string;
		/** Where the library goes in it. */
		library: string;
	} | null;
	last: LibraryMove | null;
}

export interface StorageSwitchRequest {
	location: LibraryLocation;
	/** How to treat a library already at the target. Omitted: refuse (409
	 *  library_exists) so the learner can choose. */
	existing?: "use" | "replace";
}

/** Strict parse of the PUT body: exactly these keys — the client never
 *  names a path, the server resolves every location itself. */
export function parseStorageSwitch(
	body: unknown,
): { ok: true; request: StorageSwitchRequest } | { ok: false; error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "expected {location, existing?}" };
	}
	const { location, existing, ...rest } = body as Record<string, unknown>;
	const extra = Object.keys(rest);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(", ")}` };
	if (location !== "local" && location !== "onedrive") {
		return { ok: false, error: 'location must be "local" or "onedrive"' };
	}
	if (existing !== undefined && existing !== "use" && existing !== "replace") {
		return { ok: false, error: 'existing must be "use" or "replace"' };
	}
	return { ok: true, request: existing ? { location, existing } : { location } };
}
