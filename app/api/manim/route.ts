/**
 * THE MANIM RENDERER (M13), for Settings › Providers › Animations.
 *
 * GET  /api/manim[?fresh=1] → ManimStatus (fresh=1 skips the 30 s cache).
 * POST /api/manim           → start the one-time image download and return
 *                             the status at once (installing); poll GET.
 */
import { manimRenderer } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request): Promise<Response> {
	const fresh = new URL(req.url).searchParams.get("fresh") === "1";
	return Response.json(await manimRenderer.status(fresh), { headers: NO_STORE });
}

export async function POST(): Promise<Response> {
	return Response.json(await manimRenderer.install(), { headers: NO_STORE });
}
