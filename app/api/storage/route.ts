/**
 * SETTINGS › STORAGE (OneDrive wave, 2026-10-27).
 *
 * GET /api/storage → StorageStatus: where the library lives, the work
 *                    OneDrive this computer syncs (if any), the last move.
 * PUT /api/storage   {location: "local" | "onedrive", existing?: "use" | "replace"}
 *                  → {ok: true, status, move} once the library has moved.
 *   400  a bad body (unknown fields included: the client never names a path)
 *   409  busy | no_onedrive | same | library_exists (+ target summary)
 *   500  failed — nothing changed (the move rolled back)
 */
import { parseStorageSwitch } from "@/src/core";
import { storageStatus, switchLibrary } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
	return Response.json(storageStatus(), { headers: NO_STORE });
}

export async function PUT(request: Request): Promise<Response> {
	const body = await request.json().catch(() => undefined);
	const parsed = parseStorageSwitch(body);
	if (!parsed.ok) return Response.json({ ok: false, error: parsed.error }, { status: 400, headers: NO_STORE });
	const outcome = switchLibrary(parsed.request);
	const status = outcome.ok ? 200 : outcome.code === "failed" ? 500 : 409;
	return Response.json(outcome, { status, headers: NO_STORE });
}
