import { defineConfig, devices } from "@playwright/test";

/**
 * Accessibility and keyboard checks (e2e/) against the production build —
 * see docs/development.md#accessibility-checks. The server is
 * scripts/e2e-server.mjs: the standalone build on a throwaway copy of the
 * golden fixtures, on E2E_PORT (default 3210) so it never meets the dev
 * server on :3000. Build first: npm run build && node scripts/build-server.mjs
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: "e2e",
	// One server, one data dir: a test that changes a setting puts it back,
	// which only holds while tests run one at a time.
	workers: 1,
	fullyParallel: false,
	forbidOnly: Boolean(process.env.CI),
	reporter: process.env.CI ? [["list"], ["github"]] : "list",
	timeout: 90_000,
	// The lesson fixture (95 messages) takes ~3 s to hydrate on a fast machine.
	expect: { timeout: 15_000 },
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		trace: "retain-on-failure",
	},
	// Keyboard behavior doesn't depend on colors or motion, so the keyboard
	// spec runs once, in the default project; it emulates forced colors
	// itself where the outline needs it. The motion spec runs with and
	// without the OS asking for reduced motion, and colors don't touch it.
	// The follow-OS spec emulates each OS preference itself, so it runs once,
	// and so does the contrast spec: forced colors replace the palette it
	// checks, and motion doesn't touch it. The reading spec measures layout,
	// and the presets spec checks what the switches write, which neither
	// touches, so they run once too.
	projects: [
		{ name: "default" },
		{
			name: "forced-colors",
			use: { contextOptions: { forcedColors: "active" } },
			testIgnore: /(keyboard|motion|follow-os|contrast|reading|presets)\.spec\.ts$/,
		},
		{
			name: "reduced-motion",
			use: { contextOptions: { reducedMotion: "reduce" } },
			testIgnore: /(keyboard|follow-os|contrast|reading|presets)\.spec\.ts$/,
		},
	],
	webServer: {
		command: "node scripts/e2e-server.mjs",
		url: baseURL,
		env: { E2E_PORT: String(PORT) },
		reuseExistingServer: false,
		timeout: 60_000,
		gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
	},
});
