/**
 * WORK IQ (M10), for Settings › Providers › Work IQ.
 *
 * POST /api/workiq → WorkIqTestResult: asks Work IQ one short question
 * (up to 2 minutes). Clicks while a test runs share it.
 */
import { testWorkIqConnection } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(): Promise<Response> {
	return Response.json(await testWorkIqConnection(), { headers: NO_STORE });
}
