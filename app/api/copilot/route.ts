import { refreshCopilot } from "@/src/server";

/** GitHub Copilot sign-in status (cached briefly). */
export async function GET() {
	return Response.json(await refreshCopilot(), { headers: { "Cache-Control": "no-store" } });
}

/** "Check again": re-ask the runtime for status and the model list. */
export async function POST() {
	return Response.json(await refreshCopilot({ force: true }), { headers: { "Cache-Control": "no-store" } });
}
