import { CopilotAccountError, copilotAccounts, signOutCopilotAccount, switchCopilotAccount } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function failure(err: unknown): Response {
	const message = err instanceof Error ? err.message : String(err);
	return Response.json({ error: message }, { status: err instanceof CopilotAccountError ? 400 : 503, headers: NO_STORE });
}

/** The GitHub accounts Copilot can use (never a credential) and the
 *  active one's Copilot plan. */
export async function GET() {
	try {
		return Response.json(await copilotAccounts(), { headers: NO_STORE });
	} catch (err) {
		return failure(err);
	}
}

/** {action: "switch" | "sign-out", id}: use another account, or remove a
 *  sign-in the runtime saved. Answers with the updated accounts. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { action?: unknown; id?: unknown } | null;
	if (!body || typeof body.id !== "string" || !body.id || (body.action !== "switch" && body.action !== "sign-out")) {
		return Response.json({ error: 'body must be {action: "switch" | "sign-out", id: string}' }, { status: 400, headers: NO_STORE });
	}
	try {
		return Response.json(body.action === "switch" ? await switchCopilotAccount(body.id) : await signOutCopilotAccount(body.id), { headers: NO_STORE });
	} catch (err) {
		return failure(err);
	}
}
