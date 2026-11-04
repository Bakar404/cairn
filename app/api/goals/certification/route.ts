/**
 * POST /api/goals/certification — the Goals picker's certification read
 * (M21). JSON body {code}: an exam code such as "AZ-104". Answers {ok:true,
 * goal}, the certification's skills outline from its Microsoft Learn study
 * guide, or {ok:false, error} with the status that says why: 400 not an
 * exam code, 409 Microsoft Learn switched off, 404 no study guide, 502
 * Microsoft Learn unreachable. Nothing is saved; the learner's first
 * message carries the goal into the new chat (POST /api/chats).
 *
 * The body must be JSON from this origin (jsonRequestRefusal): the read
 * reaches Microsoft Learn on the learner's behalf.
 */
import { GoalError, jsonRequestRefusal, readCertificationGoal } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const refusal = jsonRequestRefusal(request);
	if (refusal) return refusal;
	const body: unknown = await request.json().catch(() => null);
	const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
	if (typeof code !== "string") return Response.json({ ok: false, error: "Send an exam code." }, { status: 400 });
	try {
		const goal = await readCertificationGoal(code, { signal: request.signal });
		return Response.json({ ok: true, goal });
	} catch (err) {
		if (err instanceof GoalError) return Response.json({ ok: false, error: err.message }, { status: err.status });
		throw err;
	}
}
