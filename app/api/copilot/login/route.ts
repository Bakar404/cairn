/**
 * In-app GitHub Copilot sign-in through the Copilot runtime:
 *
 *   POST   {provider: "github" | "ghe"}           start (cancels one in progress)
 *   GET    ?id=                                    poll (no id: the one in progress, or null)
 *   PATCH  {id, host} | {id, account} | {id, consent: true}   answer the waiting step
 *   DELETE ?id=                                    cancel
 *
 * Every answer is a CopilotLogin; the browser opens step.url itself.
 */
import { cancelCopilotLogin, continueCopilotLogin, CopilotAccountError, copilotLogin, startCopilotLogin, type CopilotLoginInput } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function failure(err: unknown): Response {
	const message = err instanceof Error ? err.message : String(err);
	return Response.json({ error: message }, { status: err instanceof CopilotAccountError ? 400 : 503, headers: NO_STORE });
}

function bad(error: string): Response {
	return Response.json({ error }, { status: 400, headers: NO_STORE });
}

export async function GET(request: Request) {
	const id = new URL(request.url).searchParams.get("id") ?? undefined;
	const login = copilotLogin(id);
	if (!login && id !== undefined) return Response.json({ error: "This sign-in is no longer active." }, { status: 404, headers: NO_STORE });
	return Response.json(login ?? null, { headers: NO_STORE });
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { provider?: unknown } | null;
	if (body?.provider !== "github" && body?.provider !== "ghe") return bad('body must be {provider: "github" | "ghe"}');
	try {
		return Response.json(await startCopilotLogin(body.provider), { headers: NO_STORE });
	} catch (err) {
		return failure(err);
	}
}

function loginInput(body: Record<string, unknown>): CopilotLoginInput | undefined {
	if (typeof body.host === "string") return { host: body.host };
	if (typeof body.account === "string" && body.account) return { account: body.account };
	if (body.consent === true) return { consent: true };
	return undefined;
}

export async function PATCH(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const input = body && typeof body.id === "string" ? loginInput(body) : undefined;
	if (!body || typeof body.id !== "string" || !input) return bad("body must be {id, host} | {id, account} | {id, consent: true}");
	try {
		return Response.json(await continueCopilotLogin(body.id, input), { headers: NO_STORE });
	} catch (err) {
		return failure(err);
	}
}

export async function DELETE(request: Request) {
	const id = new URL(request.url).searchParams.get("id");
	if (!id) return bad("id is required");
	try {
		return Response.json(await cancelCopilotLogin(id), { headers: NO_STORE });
	} catch (err) {
		return failure(err);
	}
}
