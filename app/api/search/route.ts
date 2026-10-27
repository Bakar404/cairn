/**
 * GET /api/search — the search engines' status (search wave, 2026-09-20):
 * the honest availability signal the settings UI explains from (the
 * gray-out affordance) and any client surface can read.
 *
 * { available, engine, reason } — never a key, never a secret: `engine` is
 * the ACTIVE engine when live (GitHub Copilot or a keyed engine, automatic
 * or the explicit pin), and `reason` is the one-line state explanation
 * ("sign in to GitHub Copilot or set a Tavily or Brave search API key",
 * or the pinned-engine-key-missing case).
 */

import { refreshCopilot, searchStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	// Copilot search is live only while Copilot is signed in: check first.
	await refreshCopilot().catch(() => undefined);
	return Response.json(searchStatus());
}
