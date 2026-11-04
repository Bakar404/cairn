/**
 * e2e-server.mjs — the server for the Playwright checks (playwright.config.ts).
 *
 * Copies tests/fixtures/golden-data (never edited) into a fresh temp dir and
 * boots .next/standalone/server.js on it the way smoke-server.mjs does: host
 * Node, NODE_ENV=production, 127.0.0.1, an empty auth file and the probeEnv
 * isolation (temp HOME, no provider keys from the environment). The port is
 * E2E_PORT (default 3210), so the dev server on :3000 is never touched.
 * The temp dir goes away when the server stops.
 *
 * Needs the standalone build: npm run build && node scripts/build-server.mjs
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const SERVER = path.join(STANDALONE, "server.js");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "golden-data");
const PORT = process.env.E2E_PORT ?? "3210";
const TEMP_PREFIX = "cairn-e2e-";
const STALE_MS = 6 * 60 * 60 * 1000;

if (!fs.existsSync(SERVER) || !fs.existsSync(path.join(STANDALONE, ".next", "static"))) {
	console.error("[e2e-server] no standalone build — run `npm run build && node scripts/build-server.mjs` first.");
	process.exit(1);
}

// Playwright force-kills the server on Windows, so a run can't always
// clean up after itself. Sweep what earlier runs left behind.
for (const name of fs.readdirSync(os.tmpdir())) {
	if (!name.startsWith(TEMP_PREFIX)) continue;
	const dir = path.join(os.tmpdir(), name);
	try {
		if (Date.now() - fs.statSync(dir).mtimeMs > STALE_MS) fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* in use or already gone */
	}
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
// probeEnv points LH_DATA_DIR at <home>/data and LH_AUTH_FILE at <home>/auth.json.
fs.cpSync(FIXTURES, path.join(home, "data"), { recursive: true });
fs.writeFileSync(path.join(home, "auth.json"), "{}\n", "utf-8");

const child = spawn(process.execPath, [SERVER], {
	cwd: STANDALONE,
	env: { ...probeEnv(process.env, home), PORT, HOSTNAME: "127.0.0.1" },
	stdio: "inherit",
});

let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	child.kill("SIGTERM");
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);

child.on("exit", (code) => {
	try {
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {
		/* best effort — it's under os.tmpdir(), and the next run sweeps it */
	}
	process.exit(stopping ? 0 : (code ?? 1));
});
