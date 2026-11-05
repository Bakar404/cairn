const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The guard on every API write (proxy.ts). A page on another site, or a
 * sandboxed demo with its opaque origin, must not make the learner's
 * browser act through the API: a form or a text/plain fetch needs no
 * preflight and would otherwise reach the route. Browsers name a request's
 * source in Sec-Fetch-Site, and only same-origin (the app itself) and none
 * (typed by the learner) may write. A browser without it still sends Origin
 * on a write, and that host must be this server's. A request with neither
 * header (the server's own calls, curl) carries no browser credentials and
 * passes. Reads pass: another site can't read the answers. Null when the
 * request may proceed; otherwise the 403 to send.
 */
export function crossSiteRefusal(request: Request): Response | null {
	if (!WRITE_METHODS.has(request.method.toUpperCase())) return null;
	const site = request.headers.get("sec-fetch-site");
	if (site !== null) return site === "same-origin" || site === "none" ? null : crossSite();
	const origin = request.headers.get("origin");
	if (origin === null) return null;
	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		return crossSite(); // "null": a sandboxed frame, a file or a data: URL
	}
	// A chain of proxies lists hosts in order; the first is the one the browser used.
	const hosts = [request.headers.get("x-forwarded-host")?.split(",")[0], request.headers.get("host")];
	return hosts.some((host) => host?.trim().toLowerCase() === originHost) ? null : crossSite();
}

function crossSite(): Response {
	return Response.json(
		{ ok: false, error: "Cross-site requests are refused." },
		{ status: 403, headers: { "Cache-Control": "no-store" } },
	);
}

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
