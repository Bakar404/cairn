/**
 * The guard for JSON routes that act on the learner's behalf — reading a
 * local repository, reaching Microsoft Learn. The body must be JSON from
 * this origin: a page elsewhere can't post JSON without a preflight these
 * routes never answer, and a browser that says the request is cross-site is
 * refused outright. Null when the request may proceed; otherwise the answer
 * to send (403 cross-site, 415 not JSON).
 */
export function jsonRequestRefusal(request: Request): Response | null {
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") {
		return Response.json({ ok: false, error: "Cross-site requests are refused." }, { status: 403 });
	}
	if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
		return Response.json({ ok: false, error: "Send the request as JSON." }, { status: 415 });
	}
	return null;
}
