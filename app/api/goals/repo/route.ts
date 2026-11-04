/**
 * POST /api/goals/repo — the Goals picker's repository scan (M21). JSON body
 * {repoPath}: the full path to a folder on this machine. Answers {ok:true,
 * scan}, the technologies its dependency manifests and telling files show
 * (RepoScan), or {ok:false, error} with the status that says why: 400 not a
 * full path, 404 no folder there, 403 the folder can't be read. Nothing is
 * saved; the learner ticks technologies and his first message carries the
 * goal into the new chat (POST /api/chats).
 *
 * The body must be JSON from this origin (jsonRequestRefusal): the scan
 * reads the learner's files.
 */
import { GoalError, jsonRequestRefusal, scanRepository } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const refusal = jsonRequestRefusal(request);
	if (refusal) return refusal;
	const body: unknown = await request.json().catch(() => null);
	const repoPath = typeof body === "object" && body !== null ? (body as { repoPath?: unknown }).repoPath : undefined;
	if (typeof repoPath !== "string") {
		return Response.json({ ok: false, error: "Send the path to a folder." }, { status: 400 });
	}
	try {
		const scan = await scanRepository(repoPath, { signal: request.signal });
		return Response.json({ ok: true, scan });
	} catch (err) {
		if (err instanceof GoalError) return Response.json({ ok: false, error: err.message }, { status: err.status });
		throw err;
	}
}
