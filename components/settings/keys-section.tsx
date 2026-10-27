"use client";
/**
 * The Providers section (wave-5 polish, 2026-09-21 — owner design): the
 * GitHub Copilot connection first (every model call runs on it), then a
 * MINIMAL key-value table for the tool keys. Label left, masked key
 * right, the "Get a key ↗" link a tiny muted guest. Clicking a writable
 * row unfolds a paste field + Save (+ Delete for a file-sourced value)
 * beneath it; Esc or a second click folds it away.
 *
 * Owner rulings carried in:
 *  - Env-owned rows (a real environment variable owns the name — dev
 *    .env.local or launch env) render READ-ONLY + dimmed, no paste field:
 *    a paste box on a key the UI cannot make live would mislead.
 *  - Groups: Models (the GitHub Copilot connection), Dictation, Search.
 *    Unknown variables found in the key file stay masked/read-only in a
 *    last "Other saved keys" group.
 *
 * API: GET /api/keys (masked statuses), PUT /api/keys/:id (shape-gated
 * 400s land inline), DELETE. Saves take effect immediately. Plaintext
 * never returns from the store.
 */

import { useEffect, useState } from "react";
import { AUTH_KEYS, type AuthKeyStatus } from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { CopilotConnection } from "./copilot-connection.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

interface KeysResponse {
	keys: AuthKeyStatus[];
}

/** The curated tools group, pinned by id (the catalog owns the copy;
 *  these ids are the contract). Derived from the catalog (search wave,
 *  2026-09-20: the Google CSE pair retired, Tavily + Brave joined) — the
 *  section can never drift from core/auth-keys.ts again. */
const TOOL_IDS = AUTH_KEYS.map((k) => k.id) as readonly string[];

/** The classification driving the table groups. Pure — exported for
 *  tests. */
export function classifyKeys(statuses: readonly AuthKeyStatus[]): {
	/** The curated tools rows (synthesized when absent — always shown,
	 *  they carry the docs links a first boot needs). */
	toolRows: AuthKeyStatus[];
	/** Every other saved var (older provider keys included) — preserved,
	 *  read-only. */
	unknownRows: AuthKeyStatus[];
} {
	const byId = new Map(statuses.map((s) => [s.id, s]));
	const isTool = (id: string) => (TOOL_IDS as readonly string[]).includes(id);
	const synth = (id: string): AuthKeyStatus => ({
		id,
		info: null,
		present: false,
		masked: null,
		source: "none",
		shadowedByEnv: false,
	});
	return {
		toolRows: TOOL_IDS.map((id) => byId.get(id) ?? synth(id)),
		unknownRows: statuses.filter((s) => !isTool(s.id) && s.present),
	};
}

/** The minimal status line, e.g. "…ab12 · 64 chars" (" · env" marks an
 *  environment-owned value — the row itself is read-only then). Pure. */
export function keyStatusLine(status: AuthKeyStatus): string {
	if (!status.present || !status.masked) return "not set";
	const tail = status.masked.replace(/ \((\d+) chars\)$/, "");
	const chars = status.masked.match(/\((\d+) chars\)$/)?.[1] ?? "?";
	return `${tail} · ${chars}${status.source === "env" ? " · env" : ""}`;
}

/** One table row: label left, tiny docs link + status right. Writable
 *  rows click-unfold an editor beneath (owner interaction); env-owned
 *  rows are dimmed and read-only (a paste box there would mislead). */
function KeyTableRow({
	label,
	docsUrl,
	status,
	expanded,
	onToggle,
	onSave,
	onDelete,
	onCancel,
	testid,
}: {
	label: string;
	/** The "Get a key ↗" target — curated keys carry one. */
	docsUrl?: string;
	status: AuthKeyStatus;
	expanded: boolean;
	onToggle: () => void;
	onSave: (value: string) => Promise<string | null>;
	onDelete?: () => Promise<void>;
	/** Folds the editor (owner, fix wave: the way OUT of a paste prompt
	 *  must be visible — Cancel beside Save/Delete, not only Esc). */
	onCancel: () => void;
	testid: string;
}) {
	const envOwned = status.source === "env";
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function save() {
		if (!value.trim() || busy) return;
		setBusy(true);
		setError(null);
		const err = await onSave(value);
		if (err) setError(err);
		else setValue("");
		setBusy(false);
	}

	// INLINE editing (owner, fix wave: "type the keys in line — more
	// table-like"): the expanded row becomes the editor itself — label
	// left, the paste field filling the middle, Save | Cancel (| Delete)
	// right — instead of a second line beneath the row.
	if (expanded && !envOwned) {
		return (
			<div data-testid={testid}>
				<div className="flex items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`${testid}-editor`}>
					<span className="shrink-0 font-ui text-xs text-foreground">{label}</span>
					<input
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void save();
						}}
						placeholder="Paste key…"
						aria-label={`${label} key`}
						data-testid={`${testid}-input`}
						disabled={busy}
						autoFocus
						className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
					/>
					<button
						type="button"
						onClick={() => void save()}
						disabled={busy || !value.trim()}
						data-testid={`${testid}-save`}
						className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
					>
						Save
					</button>
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						data-testid={`${testid}-cancel`}
						className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
					>
						Cancel
					</button>
					{status.present && status.source === "file" && onDelete && (
						<button
							type="button"
							onClick={() => void onDelete()}
							disabled={busy}
							data-testid={`${testid}-delete`}
							className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
						>
							Delete
						</button>
					)}
				</div>
				{error && (
					<p role="alert" data-testid={`${testid}-error`} className="px-1 text-xs text-red-500">
						{error}
					</p>
				)}
			</div>
		);
	}

	return (
		<div data-testid={testid} className={envOwned ? "opacity-40" : undefined}>
			<button
				type="button"
				aria-expanded={expanded}
				data-testid={`${testid}-row`}
				onClick={() => !envOwned && onToggle()}
				className={`flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left ${
					envOwned ? "cursor-default" : "cursor-pointer transition-colors hover:bg-accent/50"
				}`}
			>
				<span className="font-ui text-xs text-foreground">{label}</span>
				<span className="flex items-center gap-2">
					{docsUrl && (
						<a
							href={docsUrl}
							target="_blank"
							rel="noreferrer"
							onClick={(e) => e.stopPropagation()}
							className="text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline"
						>
							key ↗
						</a>
					)}
					<span data-testid={`${testid}-status`} className="font-mono text-[11px] text-muted-foreground">
						{keyStatusLine(status)}
					</span>
				</span>
			</button>
			{error && (
				<p role="alert" data-testid={`${testid}-error`} className="pl-6 text-xs text-red-500">
					{error}
				</p>
			)}
		</div>
	);
}

export function KeysSection({
	/** A deep-linked row to unfold on arrival (zero-keys wave): the
	 *  dictation error's click lands here on DEEPGRAM_API_KEY. Followed
	 *  while mounted too — the settings dialog's while-open retarget
	 *  pattern. undefined = nothing seeded. */
	initialRow,
}: {
	initialRow?: string;
}) {
	const [statuses, setStatuses] = useState<AuthKeyStatus[] | null>(null);
	const [loading, setLoading] = useState(true);
	/** The unfolded row (its id), null = all folded. Seeded by the
	 *  deep-link (initialRow) and re-followed when it retargets. */
	const [openRow, setOpenRow] = useState<string | null>(initialRow ?? null);

	// Escape folds an open editor WITHOUT closing the dialog. Claimed at
	// document CAPTURE phase — the only stopPropagation that outruns both
	// the input's React handler and the dialog's window-level listener.
	useEffect(() => {
		if (openRow === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpenRow(null);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [openRow]);

	const reload = () =>
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: KeysResponse) => {
				setStatuses(body.keys ?? []);
			})
			.catch(() => setStatuses([]))
			.finally(() => setLoading(false));

	useEffect(() => {
		void reload();
	}, []);

	// The deep-link follow: a retarget while the section is open (the
	// same while-open pattern the dialog's section nav uses) unfolds the
	// named row; a fresh mount seeds it via the useState initializer.
	useEffect(() => {
		if (initialRow !== undefined) setOpenRow(initialRow);
	}, [initialRow]);

	async function saveKey(id: string, value: string): Promise<string | null> {
		const res = await fetch(`/api/keys/${id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			return body.error ?? `Save failed (${res.status})`;
		}
		await reload();
		// The cross-surface keys signal (zero-keys wave): the zero-keys pill,
		// the setup dialog's stage advance, and any other keys reader hear
		// that a key landed — deletions included (see deleteKey below).
		notifySettingsSaved("keys");
		return null;
	}

	async function deleteKey(id: string): Promise<void> {
		await fetch(`/api/keys/${id}`, { method: "DELETE" }).catch(() => undefined);
		await reload();
		notifySettingsSaved("keys");
	}

	if (loading || statuses === null) {
		return <p className="px-6 py-5 text-xs text-muted-foreground/70">Loading keys…</p>;
	}

	const { toolRows, unknownRows } = classifyKeys(statuses);

	return (
		<>
			<SettingsGroup label="Models" testid="group-copilot">
				<CopilotConnection />
			</SettingsGroup>

			{(["Dictation", "Search"] as const).map((label) => <SettingsGroup key={label} label={label} testid={label === "Dictation" ? "group-dictation" : "group-search"}>
				{toolRows.filter((status) => label === "Dictation" ? status.id === "DEEPGRAM_API_KEY" : status.id !== "DEEPGRAM_API_KEY").map((status) => (
					<KeyTableRow
						key={status.id}
						label={status.info?.label ?? status.id}
						docsUrl={status.info?.docsUrl}
						status={status}
						expanded={openRow === status.id}
						onToggle={() => setOpenRow(openRow === status.id ? null : status.id)}
						onSave={async (v) => {
							const err = await saveKey(status.id, v);
							if (!err) setOpenRow(null);
							return err;
						}}
						onCancel={() => setOpenRow(null)}
						onDelete={() => deleteKey(status.id)}
						testid={`key-${status.id.toLowerCase()}`}
					/>
				))}
			</SettingsGroup>)}

			{unknownRows.length > 0 && (
				<SettingsGroup label="Other saved keys" testid="group-unknown-keys">
					{unknownRows.map((status) => (
						<div key={status.id} data-testid={`unknown-${status.id}`} className="flex items-center justify-between gap-3 px-1 py-1.5 opacity-40">
							<span className="font-mono text-xs text-foreground">{status.id}</span>
							<span className="font-mono text-[11px] text-muted-foreground">{status.masked}</span>
						</div>
					))}
				</SettingsGroup>
			)}
		</>
	);
}
