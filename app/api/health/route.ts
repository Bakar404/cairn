/**
 * GET /api/health: liveness for a host that restarts the server when it
 * stops answering, such as Azure App Service's health check or a container
 * HEALTHCHECK. It touches no store and no model, so an answer means only
 * that the server is up.
 */
export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
