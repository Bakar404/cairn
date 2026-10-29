"use client";
/**
 * Settings › Storage (OneDrive wave, 2026-10-27): where the library lives.
 *
 * The library — chats, the knowledge map, animations, background-job
 * records — stays on this computer unless the learner keeps it in their
 * work OneDrive, where the OneDrive client syncs it to their other
 * computers. Sign-in, settings, and Copilot state never move.
 *
 * API: GET /api/storage → StorageStatus; PUT {location, existing?} moves
 * it. A 409 library_exists asks what to do with the library already there
 * (use it, or replace it; nothing is deleted either way). After a move the
 * app reloads so every surface reads the new location, and Settings opens
 * here again.
 */
import { useCallback, useEffect, useState } from "react";
import type { LibraryLocation, LibrarySummary, StorageStatus, StorageSwitchRequest } from "@/src/core";
import { Button } from "@/components/ui/button";
import { SettingsRow, Toggle } from "./controls.tsx";

/** sessionStorage key: the section to reopen after the post-move reload. */
export const REOPEN_SETTINGS_KEY = "cairn:open-settings";

type Target = LibrarySummary & { root: string };
type Conflict = { location: LibraryLocation; target: Target };
type MoveReply =
	| { ok: true; status: StorageStatus }
	| { ok: false; code?: string; message?: string; error?: string; target?: Target };

function isStatus(value: unknown): value is StorageStatus {
	if (!value || typeof value !== "object") return false;
	const v = value as { local?: unknown; library?: { root?: unknown; kind?: unknown; chats?: unknown } };
	return typeof v.local === "string" && typeof v.library?.root === "string" && typeof v.library.kind === "string" && typeof v.library.chats === "number";
}

function reloadIntoStorage(): void {
	try {
		sessionStorage.setItem(REOPEN_SETTINGS_KEY, "storage");
	} catch {
		/* storage blocked: the reload still lands on the new library */
	}
	location.reload();
}

/** "No chats yet" / "1 chat" / "12 chats". Pure — exported for tests. */
export function chatCount(n: number): string {
	if (n === 0) return "No chats yet";
	return n === 1 ? "1 chat" : `${n} chats`;
}

function placeOf(location: LibraryLocation, status: StorageStatus): string {
	return location === "onedrive" ? (status.onedrive?.label ?? "OneDrive") : "This computer";
}

function libraryPlace(status: StorageStatus): string {
	if (status.library.kind === "onedrive") return status.onedrive?.label ?? "OneDrive";
	return status.library.kind === "local" ? "This computer" : "A custom folder";
}

function when(iso: string | null): string {
	return iso ? `, last changed ${new Date(iso).toLocaleString()}` : "";
}

export function StorageSection({ onMoved = reloadIntoStorage }: { onMoved?: () => void }) {
	const [status, setStatus] = useState<StorageStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState<Conflict | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/storage", { cache: "no-store" });
			const body: unknown = await res.json().catch(() => null);
			if (res.ok && isStatus(body)) {
				setStatus(body);
				setError(null);
			} else {
				setError("Cairn couldn't tell where your library is.");
			}
		} catch {
			setError("Cairn could not reach its server.");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const move = async (request: StorageSwitchRequest) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/storage", {
				method: "PUT",
				cache: "no-store",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
			});
			const reply = (await res.json().catch(() => null)) as MoveReply | null;
			if (res.ok && reply?.ok) {
				setConflict(null);
				setStatus(reply.status);
				onMoved();
				return;
			}
			if (reply && !reply.ok && reply.code === "library_exists" && reply.target) {
				setConflict({ location: request.location, target: reply.target });
				return;
			}
			setConflict(null);
			setError((reply && !reply.ok && (reply.message ?? reply.error)) || "Cairn couldn't move your library.");
		} catch {
			setError("Cairn could not reach its server.");
		} finally {
			setBusy(false);
		}
	};

	const drive = status?.onedrive ?? null;
	const inOneDrive = status?.library.kind === "onedrive";
	const canToggle = !!status && !busy && !conflict && (inOneDrive || !!drive);
	const backups = status?.last?.backups ?? [];
	return (
		<div className="flex flex-col gap-3" data-testid="storage-section" data-kind={status?.library.kind ?? "loading"}>
			<SettingsRow
				label="Keep my library in OneDrive"
				hint={drive ? `Syncs through ${drive.label}` : status ? "Sign in to OneDrive with your work account to use this." : undefined}
				testid="storage-onedrive-row"
				dimmed={!!status && !drive && !inOneDrive}
			>
				<Toggle
					checked={inOneDrive}
					disabled={!canToggle}
					label="Keep my library in OneDrive"
					onChange={(on) => void move({ location: on ? "onedrive" : "local" })}
				/>
			</SettingsRow>

			{status && (
				<div className="rounded-sm border border-border/60 px-3 py-2" data-testid="storage-library">
					<p className="font-ui text-xs text-foreground" data-testid="storage-place">
						{libraryPlace(status)} · {chatCount(status.library.chats)}
					</p>
					<p className="mt-0.5 select-text break-all font-mono text-[11px] text-muted-foreground" data-testid="storage-path">
						{status.library.root}
					</p>
				</div>
			)}

			{status && status.library.kind !== "local" && !status.library.available && (
				<p role="alert" className="font-ui text-[11px] text-destructive" data-testid="storage-unavailable">
					Cairn can't find your library folder. If it's in OneDrive, check that OneDrive is running and signed in.
				</p>
			)}

			{conflict && status && (
				<div role="group" aria-label="A library is already there" className="flex flex-col gap-2 rounded-sm border border-border px-3 py-2.5" data-testid="storage-conflict">
					<p className="font-ui text-xs text-foreground">
						{placeOf(conflict.location, status)} already has a Cairn library ({chatCount(conflict.target.chats).toLowerCase()}
						{when(conflict.target.updatedAt)}).
					</p>
					<div className="flex flex-wrap gap-2">
						<Button type="button" size="xs" variant="outline" className="cursor-pointer" disabled={busy} onClick={() => void move({ location: conflict.location, existing: "use" })} data-testid="storage-use-existing">
							Use that library
						</Button>
						<Button type="button" size="xs" variant="outline" className="cursor-pointer" disabled={busy} onClick={() => void move({ location: conflict.location, existing: "replace" })} data-testid="storage-replace">
							Replace it with this one
						</Button>
						<Button type="button" size="xs" variant="ghost" className="cursor-pointer" disabled={busy} onClick={() => setConflict(null)} data-testid="storage-cancel">
							Cancel
						</Button>
					</div>
					<p className="font-ui text-[11px] text-muted-foreground">Nothing is deleted either way: the copy Cairn stops using is kept.</p>
				</div>
			)}

			{busy && (
				<p aria-live="polite" className="font-ui text-[11px] text-muted-foreground" data-testid="storage-busy">
					Moving your library…
				</p>
			)}
			{error && (
				<p role="alert" className="font-ui text-[11px] text-destructive" data-testid="storage-error">
					{error}
				</p>
			)}

			<p className="font-ui text-[11px] leading-relaxed text-muted-foreground" data-testid="storage-note">
				Your chats, knowledge map, and animations move together. Sign-in, settings, and Copilot stay on this computer. Use Cairn on one computer
				at a time: two at once can overwrite each other's changes.
				{inOneDrive &&
					" Chats from your other computers download when you open them. To keep them offline, right-click the Cairn folder in OneDrive and choose Always keep on this device."}
			</p>
			{status?.last?.warning && (
				<p role="alert" className="font-ui text-[11px] text-destructive" data-testid="storage-warning">
					{status.last.warning}
				</p>
			)}
			{backups.length > 0 && (
				<p className="select-text break-all font-ui text-[11px] text-muted-foreground" data-testid="storage-backups">
					The copy from the last move is kept in {backups.join(" and ")}.
				</p>
			)}
		</div>
	);
}
