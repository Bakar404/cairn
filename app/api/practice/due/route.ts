/**
 * GET /api/practice/due — the due-for-practice queue (M20): Home's review
 * pill reads it. Every practice session is replayed through FSRS against
 * the live graph on each read (src/server/review-queue.ts); nothing is
 * cached or written, and no model is called.
 */
import { reviewQueue } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(reviewQueue());
}
