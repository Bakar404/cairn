/**
 * POST /api/graph/import/change — a code change as a source (M22). JSON
 * body: {kind:"pr", url} for a GitHub pull request, or {kind:"git",
 * repoPath, range} for local commits (an empty range is the latest
 * commit). The change is read (src/server/code-change.ts) into one text
 * and imported through the same extraction pipeline as a notes file, with
 * kind "change": checked quotes carry the diff hunk they sit in.
 *
 * The body must be JSON from this origin (jsonRequestRefusal): this route
 * reads local repositories.
 *
 * An import that can't run answers 200 with ok:false and a message, the
 * notes import route's envelope (models or keys missing, a busy source,
 * a partial run).
 */
import { CodeChangeError, extraction, jsonRequestRefusal, NotesImportError, readCodeChange } from "@/src/server";
import {
	ModelsNotConfiguredError,
	parseCodeChangeRequest,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
} from "@/src/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const refusal = jsonRequestRefusal(request);
	if (refusal) return refusal;
	const body: unknown = await request.json().catch(() => null);
	const parsed = parseCodeChangeRequest(body);
	if ("error" in parsed) return Response.json({ ok: false, error: parsed.error }, { status: 400 });

	let change;
	try {
		change = await readCodeChange(parsed.request);
	} catch (err) {
		if (err instanceof CodeChangeError) return Response.json({ ok: false, outcome: "failed", error: err.message });
		throw err;
	}
	const read = { filePath: change.label, files: change.files, skipped: change.skipped, omitted: change.omitted };
	try {
		const stats = await extraction.importNotes({ filePath: change.label, text: change.text, kind: "change" });
		return Response.json({ ok: true, outcome: "completed", ...read, stats });
	} catch (err) {
		if (err instanceof ModelsNotConfiguredError) {
			return Response.json({
				ok: false,
				outcome: "failed",
				...read,
				error: err.envelope.error,
				code: "models_not_configured",
				missing: err.envelope.missing,
			});
		}
		if (err instanceof ProviderKeyMissingError) {
			return Response.json({
				ok: false,
				outcome: "failed",
				...read,
				error: err.envelope.error,
				code: PROVIDER_KEY_MISSING_CODE,
				provider: err.envelope.provider,
				slots: err.envelope.slots,
			});
		}
		return Response.json({
			ok: false,
			...read,
			outcome: err instanceof NotesImportError ? err.outcome : "failed",
			...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
