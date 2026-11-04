"use client";

/**
 * Import a code change (M22): a GitHub pull request or a range of local
 * commits becomes a source in the graph, its propositions carrying the
 * diff hunks they came from — a teach session shows the code beside the
 * idea, and practice asks why the change was made. A popover off the
 * graph chrome (and the minimal home): pick the kind, fill one or two
 * fields, Import. The POST awaits the whole extraction, like the notes
 * import; the activity dock shows the run meanwhile.
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { GitPullRequestIcon } from "lucide-react";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type CodeChangeKind = "pr" | "git";

export interface CodeChangeFields {
	url: string;
	repoPath: string;
	range: string;
}

export type CodeChangeRequestBody = { kind: "pr"; url: string } | { kind: "git"; repoPath: string; range: string };

/** POST /api/graph/import/change's answer. Transport-only: never import
 *  the server's reader here. */
export interface CodeChangeImportResult {
	ok: boolean;
	outcome?: string;
	filePath?: string;
	files?: string[];
	skipped?: string[];
	omitted?: string[];
	stats?: { nodes: number; chains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
}

/** The request for the chosen kind, or null while its field is empty. */
export function codeChangeRequestBody(kind: CodeChangeKind, fields: CodeChangeFields): CodeChangeRequestBody | null {
	if (kind === "pr") return fields.url.trim() ? { kind, url: fields.url.trim() } : null;
	return fields.repoPath.trim() ? { kind, repoPath: fields.repoPath.trim(), range: fields.range.trim() } : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one line the panel shows for a finished import. */
export function codeChangeSummary(result: CodeChangeImportResult): string {
	if (!result.ok) {
		const detail = [result.code, result.provider, result.missing?.join(", "), result.slots?.join(", ")]
			.filter((part) => part)
			.join(" — ");
		return `${result.error ?? "The import failed."}${detail ? `\n${detail}` : ""}`;
	}
	const left = (result.skipped?.length ?? 0) + (result.omitted?.length ?? 0);
	return (
		`Imported ${result.filePath ?? "the change"}: ` +
		`${plural(result.stats?.nodes ?? 0, "new proposition", "new propositions")} from ` +
		`${plural(result.files?.length ?? 0, "file", "files")}` +
		(left > 0 ? `, ${plural(left, "file", "files")} left out.` : ".")
	);
}

export async function postCodeChangeImport(body: CodeChangeRequestBody): Promise<CodeChangeImportResult> {
	const response = await fetch("/api/graph/import/change", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch {
		throw new Error(`Import request failed (HTTP ${response.status}).`);
	}
	const result = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Partial<CodeChangeImportResult>;
	if (typeof result.ok !== "boolean" || (!result.ok && typeof result.error !== "string")) {
		throw new Error(`Import request failed (HTTP ${response.status}).`);
	}
	return result as CodeChangeImportResult;
}

/** One import at a time; the result stays until the next one starts. */
export function useCodeChangeImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const [importing, setImporting] = useState(false);
	const [result, setResult] = useState<CodeChangeImportResult | null>(null);
	const pending = useRef(false);
	const submit = async (body: CodeChangeRequestBody) => {
		if (pending.current) return;
		pending.current = true;
		setImporting(true);
		setResult(null);
		try {
			callbacks.onStart?.();
			setResult(await postCodeChangeImport(body));
		} catch (error) {
			setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			pending.current = false;
			setImporting(false);
			callbacks.onFinish?.();
		}
	};
	return { importing, result, submit };
}

/** The panel's body — pure props in, markup out (the SSR pins render it). */
export function CodeChangePanel({
	kind,
	onKind,
	fields,
	onFields,
	importing,
	result,
	onSubmit,
	firstFieldRef,
}: {
	kind: CodeChangeKind;
	onKind: (kind: CodeChangeKind) => void;
	fields: CodeChangeFields;
	onFields: (fields: CodeChangeFields) => void;
	importing: boolean;
	result: CodeChangeImportResult | null;
	onSubmit: (body: CodeChangeRequestBody) => void;
	firstFieldRef?: RefObject<HTMLInputElement | null>;
}) {
	const id = useId();
	const body = codeChangeRequestBody(kind, fields);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (body && !importing) onSubmit(body);
	};
	const tab = (value: CodeChangeKind, label: string) => (
		<button
			type="button"
			aria-pressed={kind === value}
			onClick={() => onKind(value)}
			className={cn(
				"h-7 flex-1 rounded-md px-2 text-xs transition-colors",
				kind === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
		</button>
	);
	return (
		<form
			role="dialog"
			aria-label="Import a code change"
			data-testid="import-change-panel"
			onSubmit={submit}
			className="flex flex-col gap-2.5"
		>
			<div className="flex gap-1 rounded-lg border p-0.5">
				{tab("pr", "Pull request")}
				{tab("git", "Local commits")}
			</div>
			{kind === "pr" ? (
				<div className="flex flex-col gap-1">
					<label htmlFor={`${id}-url`} className="text-xs font-medium">
						Pull request link
					</label>
					<Input
						id={`${id}-url`}
						ref={firstFieldRef}
						value={fields.url}
						onChange={(e) => onFields({ ...fields, url: e.target.value })}
						placeholder="https://github.com/owner/repo/pull/123"
						spellCheck={false}
						autoComplete="off"
						className="h-8 text-xs md:text-xs"
					/>
					<p className="text-[11px] leading-snug text-muted-foreground">
						Public pull requests work as is. For a private one, sign in with the GitHub CLI (gh auth login).
					</p>
				</div>
			) : (
				<>
					<div className="flex flex-col gap-1">
						<label htmlFor={`${id}-repo`} className="text-xs font-medium">
							Repository folder
						</label>
						<Input
							id={`${id}-repo`}
							ref={firstFieldRef}
							value={fields.repoPath}
							onChange={(e) => onFields({ ...fields, repoPath: e.target.value })}
							placeholder="Full path to a local git repository"
							spellCheck={false}
							autoComplete="off"
							className="h-8 text-xs md:text-xs"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<label htmlFor={`${id}-range`} className="text-xs font-medium">
							Commits
						</label>
						<Input
							id={`${id}-range`}
							value={fields.range}
							onChange={(e) => onFields({ ...fields, range: e.target.value })}
							placeholder="HEAD~3..HEAD"
							aria-describedby={`${id}-range-hint`}
							spellCheck={false}
							autoComplete="off"
							className="h-8 font-mono text-xs md:text-xs"
						/>
						<p id={`${id}-range-hint`} className="text-[11px] leading-snug text-muted-foreground">
							A range, a branch comparison (main...my-branch), or one commit. Leave it empty for the latest commit.
						</p>
					</div>
				</>
			)}
			<Button type="submit" size="sm" disabled={!body || importing} data-testid="import-change-submit">
				{importing ? "Importing…" : "Import"}
			</Button>
			{importing && (
				<p role="status" className="text-[11px] leading-snug text-muted-foreground">
					Reading the change and extracting its ideas. This can take a few minutes.
				</p>
			)}
			{result && (
				<p
					role={result.ok ? "status" : "alert"}
					data-testid="import-change-result"
					className={cn(
						"whitespace-pre-wrap break-words text-xs leading-snug",
						result.ok ? "text-muted-foreground" : "text-danger",
					)}
				>
					{codeChangeSummary(result)}
				</p>
			)}
		</form>
	);
}

/** The chrome pill and its popover. */
export function CodeChangeImportControl({
	importing,
	result,
	onSubmit,
}: {
	importing: boolean;
	result: CodeChangeImportResult | null;
	onSubmit: (body: CodeChangeRequestBody) => void;
}) {
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<CodeChangeKind>("pr");
	const [fields, setFields] = useState<CodeChangeFields>({ url: "", repoPath: "", range: "" });
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const firstFieldRef = useRef<HTMLInputElement>(null);
	const close = useCallback(() => {
		// Focus returns to the pill only when it was inside the panel; a
		// click elsewhere keeps its own focus.
		if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
		setOpen(false);
	}, []);
	usePopoverDismiss(rootRef, open, close);
	useEffect(() => {
		if (open) firstFieldRef.current?.focus();
	}, [open, kind]);
	return (
		<div ref={rootRef} className="relative shrink-0">
			<div className="rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
				<Hint label="Import a pull request or commits into the graph" side="bottom">
					<button
						ref={triggerRef}
						type="button"
						aria-expanded={open}
						aria-haspopup="dialog"
						onClick={() => setOpen((o) => !o)}
						data-testid="import-change"
						className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
					>
						<GitPullRequestIcon className="size-3" />
						{importing ? "Importing…" : "Code change…"}
					</button>
				</Hint>
			</div>
			{open && (
				<div className="absolute right-0 top-full z-20 mt-2 w-80 max-w-[calc(100vw-1rem)] rounded-xl border bg-card/95 p-2.5 shadow-lg backdrop-blur">
					<CodeChangePanel
						kind={kind}
						onKind={setKind}
						fields={fields}
						onFields={setFields}
						importing={importing}
						result={result}
						onSubmit={onSubmit}
						firstFieldRef={firstFieldRef}
					/>
				</div>
			)}
		</div>
	);
}
