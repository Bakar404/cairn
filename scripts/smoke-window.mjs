/**
 * Launch the PACKAGED desktop app the way a user does (its own server, its
 * own window) with a throwaway profile, then check the first window renders
 * the app: a 2xx document from the app's loopback server and a non-empty
 * page with no error screen. Saves dark and light screenshots for review.
 *
 * Release workflow only, on every OS (Linux needs a display: xvfb-run):
 *   node scripts/smoke-window.mjs --app <packaged binary> --out <dir>
 *
 * Page and console errors are reported as warnings: without a Copilot
 * sign-in some requests are expected to fail. A blank page, an error page,
 * a non-2xx document or a non-loopback origin fail the run.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer from "puppeteer-core";

import { formatProbeError, probeEnv } from "./smoke-demo-runtime.mjs";

const ERROR_SCREENS = ["Application error", "Internal Server Error", "This page could not be found"];
const MODE_STORAGE_KEY = "cairn-mode"; // src/core/theme-mode.ts
const say = (line) => console.log(`[smoke-window] ${line}`);

function argValue(args, name) {
	const index = args.indexOf(name);
	if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} <path> is required`);
	return path.resolve(args[index + 1]);
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function devtoolsEndpoint(port, app, deadline) {
	while (Date.now() < deadline) {
		if (app.exitCode !== null || app.signalCode !== null) throw new Error(`app exited before DevTools came up (code=${app.exitCode}, signal=${app.signalCode})`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
			if (response.ok) return (await response.json()).webSocketDebuggerUrl;
		} catch {
			/* not listening yet */
		}
		await sleep(500);
	}
	throw new Error("DevTools endpoint did not come up within 60s");
}

/** Reload the app window in one color mode and check what it rendered. */
async function renderIn(page, mode, out) {
	await page.evaluate((key, value) => localStorage.setItem(key, value), MODE_STORAGE_KEY, mode);
	const response = await page.reload({ waitUntil: "load", timeout: 60_000 });
	if (!response) throw new Error(`${mode}: reload produced no document response`);
	if (response.status() < 200 || response.status() > 299) throw new Error(`${mode}: document answered HTTP ${response.status()}`);
	const url = new URL(page.url());
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error(`${mode}: window left the loopback app server (${url.origin})`);
	await page.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 0, { timeout: 30_000 });
	const text = await page.evaluate(() => document.body.innerText);
	const screen = ERROR_SCREENS.find((marker) => text.includes(marker));
	if (screen) throw new Error(`${mode}: the window shows an error screen ("${screen}")`);
	await page.waitForFunction(
		(dark) => document.documentElement.classList.contains("dark") === dark,
		{ timeout: 10_000 },
		mode === "dark",
	).catch(() => { throw new Error(`${mode}: the page did not switch to the ${mode} scheme`); });
	await sleep(1500); // fonts and entrance transitions
	const file = path.join(out, `window-${mode}.png`);
	await page.screenshot({ path: file });
	say(`${mode}: HTTP ${response.status()} at ${url.origin}, ${text.trim().length} chars of text, title "${await page.title()}" → ${file}`);
}

async function stopApp(app) {
	if (app.exitCode !== null || app.signalCode !== null) return;
	const exited = new Promise((resolve) => app.once("exit", resolve));
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
	} else {
		try { process.kill(-app.pid, "SIGTERM"); } catch { /* already gone */ }
		if (await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)])) return;
		try { process.kill(-app.pid, "SIGKILL"); } catch { /* already gone */ }
	}
	await Promise.race([exited, sleep(10_000)]);
}

async function main() {
	if (!process.env.CI) {
		console.error("[smoke-window] refusing to run outside CI: it launches the packaged app (single-instance lock, real windows).");
		return 2;
	}
	const args = process.argv.slice(2);
	const binary = argValue(args, "--app");
	const out = argValue(args, "--out");
	if (!fs.existsSync(binary)) throw new Error(`no packaged app at ${binary}`);
	fs.mkdirSync(out, { recursive: true });

	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-window-"));
	const userData = path.join(home, "userData");
	const port = await freePort();
	const app = spawn(binary, [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${userData}`,
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		// Hosted Linux runners disallow Chromium's unprivileged sandbox.
		...(process.platform === "linux" ? ["--no-sandbox"] : []),
	], {
		cwd: home,
		env: probeEnv(process.env, home),
		stdio: ["ignore", "pipe", "pipe"],
		// Own process group on POSIX, so shutdown also reaches the app's server.
		detached: process.platform !== "win32",
	});
	let output = "";
	const keep = (chunk) => { output = (output + chunk).slice(-32_000); };
	app.stdout.on("data", keep);
	app.stderr.on("data", keep);

	const warnings = [];
	let browser;
	let failure = null;
	try {
		const endpoint = await devtoolsEndpoint(port, app, Date.now() + 60_000);
		browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null, protocolTimeout: 60_000 });
		// The shell starts its server first, then opens the window on it.
		const target = await browser.waitForTarget(
			(candidate) => candidate.type() === "page" && /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url()),
			{ timeout: 120_000 },
		);
		const page = await target.page();
		if (!page) throw new Error("the app window has no page");
		page.on("pageerror", (error) => warnings.push(`page error: ${error?.message ?? error}`));
		page.on("console", (message) => { if (message.type() === "error") warnings.push(`console error: ${message.text()}`); });
		await renderIn(page, "dark", out);
		await renderIn(page, "light", out);
	} catch (error) {
		failure = error;
	} finally {
		try { browser?.disconnect(); } catch { /* already closed */ }
		await stopApp(app);
	}

	for (const warning of warnings.slice(0, 15)) console.log(`::warning::[smoke-window] ${warning.slice(0, 300).replace(/\r?\n/g, " ")}`);
	if (warnings.length > 15) say(`${warnings.length - 15} more page/console errors not shown`);
	const mainLog = path.join(userData, "logs", "main.log");
	if (fs.existsSync(mainLog)) {
		say(`profile isolated: ${mainLog}`);
		for (const line of fs.readFileSync(mainLog, "utf8").split(/\r?\n/).filter((entry) => /auto-update|updater/.test(entry)).slice(-8)) say(`main.log: ${line}`);
	} else {
		say(`warning: no ${mainLog}; the app may not have honored --user-data-dir`);
	}
	try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows may still hold profile files */ }

	if (failure) {
		console.error(`[smoke-window] FAIL: ${formatProbeError(failure)}\n--- app output (tail) ---\n${output}`);
		return 1;
	}
	say("PASS: packaged window rendered the app in dark and light");
	return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
	console.error(`[smoke-window] FAIL: ${formatProbeError(error)}`);
	process.exitCode = 1;
});
