/**
 * CHAT MEDIA (M13): the files a chat's Manim renders saved.
 *
 * GET /api/chats/:id/media/:file → the PNG still or MP4 animation, with
 * single byte ranges (206) so a <video> can seek; 416 past the end. Only
 * `<id>.png|mp4` names inside the chat's own media folder are served, so
 * an unknown chat or file is a 404. The folder is deleted with the chat.
 */
import { chatMediaResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; file: string }> }): Promise<Response> {
	const { id, file } = await ctx.params;
	return (
		chatMediaResponse(id, file, req.headers.get("range")) ??
		Response.json({ error: "Unknown media" }, { status: 404, headers: { "Cache-Control": "no-store" } })
	);
}
