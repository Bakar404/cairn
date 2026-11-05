/**
 * THE AZURE MANIM ADAPTER (hosted animations): a render as one Container
 * Apps job execution, driven against a fake Azure: the bundle upload, the
 * signed blob URLs, the start body, polling, the output blob through the
 * shared runner frames, and every way a render ends (abort, deadline,
 * timeout, out of memory, a lost execution). Also the user delegation SAS
 * layout, the managed identity call, and backend selection.
 *
 * Runs under an isolated LH_DATA_DIR: the seam is set before any
 * config-loading import, so every app-module import is dynamic.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { MANIM_IMAGE, type ManimRenderMode } from "../src/core/manim.ts";
import {
	AZURE_BOOTSTRAP,
	azureManimConfigFromEnv,
	blobSas,
	parseRunOutput,
	type AccessToken,
	type RunHeader,
	type UserDelegationKey,
} from "../src/server/manim-azure.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-manim-azure-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { PATHS } = await import("../config.ts");
if (!PATHS.media.startsWith(TMP)) throw new Error(`not hermetic: ${PATHS.media}`);
const { chatMediaDir, selectManimRenderer } = await import("../src/server/manim.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ARM = "https://management.azure.com";
const JOB = "/subscriptions/00000000-0000-0000-0000-0000000000a1/resourceGroups/rg-cairn/providers/Microsoft.App/jobs/cairn-manim";
const ACCOUNT = "stcairntest";
const BLOB = `https://${ACCOUNT}.blob.core.windows.net`;
const JOB_IMAGE = `crcairn.azurecr.io/${MANIM_IMAGE}`;
const ENV = { CAIRN_MANIM_BACKEND: "azure-job", CAIRN_MANIM_JOB_ID: JOB, CAIRN_MANIM_STORAGE_ACCOUNT: ACCOUNT };
const T0 = Date.parse("2026-11-05T10:00:00Z");
const KEY_VALUE = Buffer.alloc(32, 7).toString("base64");
const KEY_XML =
	`\uFEFF<?xml version="1.0" encoding="utf-8"?><UserDelegationKey><SignedOid>11111111-1111-1111-1111-111111111111</SignedOid>` +
	`<SignedTid>22222222-2222-2222-2222-222222222222</SignedTid><SignedStart>2026-11-05T09:55:00Z</SignedStart>` +
	`<SignedExpiry>2026-11-05T12:00:00Z</SignedExpiry><SignedService>b</SignedService><SignedVersion>2024-11-04</SignedVersion>` +
	`<Value>${KEY_VALUE}</Value></UserDelegationKey>`;
const SCENE = "from manim import *\nclass Lesson(Scene):\n    def construct(self):\n        self.play(Create(Circle()))\n";

// ─── A fake Azure ──────────────────────────────────────────────────────────

interface Call {
	method: string;
	url: URL;
	headers: Headers;
	body: string;
}

interface Routes {
	job: () => Response;
	key: () => Response;
	start: (body: unknown) => Response;
	operation: (n: number) => Response;
	/** The execution's status on the nth poll (from 0). */
	execution: (n: number) => Response;
	/** The output blob; null for a 404. */
	output: () => Buffer | null;
	identity: (url: URL) => Response;
}

function jobBody(state = "Succeeded"): unknown {
	return {
		properties: {
			provisioningState: state,
			template: {
				containers: [{ name: "manim", image: JOB_IMAGE, resources: { cpu: 2, memory: "4Gi", ephemeralStorage: "8Gi" } }],
			},
		},
	};
}

function fakeAzure(routes: Partial<Routes> = {}) {
	const calls: Call[] = [];
	const blobs = new Map<string, string>();
	let clock = T0;
	let polls = 0;
	let operations = 0;
	const r: Routes = {
		job: () => Response.json(jobBody()),
		key: () => new Response(KEY_XML, { headers: { "Content-Type": "application/xml" } }),
		start: () => Response.json({ name: "cairn-manim-x1", id: `${JOB}/executions/cairn-manim-x1` }),
		operation: () => Response.json({ name: "cairn-manim-x1" }),
		execution: (n) => Response.json({ properties: { status: n < 2 ? "Running" : "Succeeded" } }),
		output: () => runOutput({}, file("sheet.png", png(1280, 720)), result({ ok: true, durationSec: 4.5 })),
		identity: () => new Response("no identity endpoint here", { status: 500 }),
		...routes,
	};

	const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : "";
		calls.push({ method, url, headers: new Headers(init?.headers), body });
		if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
		if (url.origin === ARM) {
			const p = url.pathname;
			if (method === "GET" && p === JOB) return r.job();
			if (method === "POST" && p === `${JOB}/start`) return r.start(JSON.parse(body));
			if (method === "GET" && p.includes("/containerappOperationResults/")) return r.operation(operations++);
			if (method === "GET" && p.startsWith(`${JOB}/executions/`)) return r.execution(polls++);
			if (method === "POST" && p.startsWith(`${JOB}/executions/`) && p.endsWith("/stop")) return new Response(null, { status: 200 });
		}
		if (url.origin === BLOB) {
			if (method === "POST" && url.search === "?restype=service&comp=userdelegationkey") return r.key();
			const name = decodeURIComponent(url.pathname.replace(/^\/renders\//, ""));
			if (method === "PUT") {
				blobs.set(name, body);
				return new Response(null, { status: 201 });
			}
			if (method === "GET" && name.startsWith("out/")) {
				const out = r.output();
				return out ? new Response(new Uint8Array(out)) : new Response("<Error><Code>BlobNotFound</Code></Error>", { status: 404 });
			}
			if (method === "DELETE") {
				blobs.delete(name);
				return new Response(null, { status: 202 });
			}
		}
		if (url.origin === "http://127.0.0.1:41000") return r.identity(url);
		return new Response(`unexpected ${method} ${url}`, { status: 599 });
	};

	const deps = {
		fetch: fetchImpl as typeof fetch,
		getToken: async (resource: string): Promise<AccessToken> => ({
			token: resource.includes("storage") ? "storage-token" : "arm-token",
			expiresAt: clock + 60 * 60_000,
		}),
		now: () => clock,
		sleep: async (ms: number, signal?: AbortSignal) => {
			if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			clock += ms;
		},
		randomId: () => "r4nd0m",
	};
	const find = (method: string, test: (url: URL) => boolean) => calls.filter((c) => c.method === method && test(c.url));
	return { calls, blobs, deps, find, advance: (ms: number) => (clock += ms) };
}

function png(width: number, height: number): Buffer {
	const data = Buffer.alloc(40);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
	data.writeUInt32BE(13, 8);
	data.write("IHDR", 12, "ascii");
	data.writeUInt32BE(width, 16);
	data.writeUInt32BE(height, 20);
	return data;
}

function runOutput(header: Partial<RunHeader>, ...frames: Buffer[]): Buffer {
	const head = { code: 0, timedOut: false, overflow: false, stderr: "", error: "", ...header };
	return Buffer.concat([Buffer.from(`CAIRN-RUN ${JSON.stringify(head)}\n`), ...frames]);
}

function file(name: string, data: Buffer): Buffer {
	return Buffer.concat([Buffer.from(`CAIRN-FILE ${name} ${data.length}\n`), data]);
}

function result(value: object): Buffer {
	return Buffer.from(`CAIRN-RESULT ${JSON.stringify(value)}\n`);
}

function renderer(azure: ReturnType<typeof fakeAzure>, env: Readonly<Record<string, string | undefined>> = ENV) {
	return selectManimRenderer(env, azure.deps);
}

function request(mode: ManimRenderMode = "preview", abortSignal?: AbortSignal) {
	return { chatId: "chat_a", jobId: "job_1", code: SCENE, mode, abortSignal };
}

const startBodies = (azure: ReturnType<typeof fakeAzure>) =>
	azure.find("POST", (u) => u.pathname === `${JOB}/start`).map((c) => JSON.parse(c.body) as {
		containers: { name: string; image: string; command: string[]; env: { name: string; value: string }[]; resources: unknown }[];
	});
const stops = (azure: ReturnType<typeof fakeAzure>) => azure.find("POST", (u) => u.pathname.endsWith("/stop"));

// ─── Pure parts ────────────────────────────────────────────────────────────

describe("azureManimConfigFromEnv", () => {
	it("reads the job, the account and the container, defaulting the container", () => {
		assert.deepEqual(azureManimConfigFromEnv(ENV), { jobId: JOB, storageAccount: ACCOUNT, container: "renders" });
		const clientId = "33333333-3333-3333-3333-333333333333";
		assert.deepEqual(azureManimConfigFromEnv({ ...ENV, CAIRN_MANIM_CONTAINER: "cairn-renders", CAIRN_MANIM_CLIENT_ID: clientId }), {
			jobId: JOB,
			storageAccount: ACCOUNT,
			container: "cairn-renders",
			clientId,
		});
	});

	it("names every problem in one sentence", () => {
		assert.throws(() => azureManimConfigFromEnv({}), {
			message: "CAIRN_MANIM_JOB_ID is not set; CAIRN_MANIM_STORAGE_ACCOUNT is not set.",
		});
		assert.throws(
			() =>
				azureManimConfigFromEnv({
					CAIRN_MANIM_JOB_ID: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Web/sites/cairn",
					CAIRN_MANIM_STORAGE_ACCOUNT: "Not_An_Account",
					CAIRN_MANIM_CONTAINER: "Renders",
					CAIRN_MANIM_CLIENT_ID: "me",
				}),
			{
				message:
					"CAIRN_MANIM_JOB_ID isn't a Container Apps job's resource id; CAIRN_MANIM_STORAGE_ACCOUNT isn't a storage account name; " +
					"CAIRN_MANIM_CONTAINER isn't a blob container name; CAIRN_MANIM_CLIENT_ID isn't a client id.",
			},
		);
	});
});

describe("blobSas", () => {
	const key: UserDelegationKey = {
		signedOid: "11111111-1111-1111-1111-111111111111",
		signedTid: "22222222-2222-2222-2222-222222222222",
		signedStart: "2026-11-05T09:55:00Z",
		signedExpiry: "2026-11-05T12:00:00Z",
		signedService: "b",
		signedVersion: "2024-11-04",
		value: KEY_VALUE,
	};

	it("signs the documented 24-line user delegation layout for one blob", () => {
		const sas = new URLSearchParams(
			blobSas({
				account: ACCOUNT,
				container: "renders",
				blob: "in/job_1-r4nd0m.json",
				permissions: "r",
				start: Date.parse("2026-11-05T09:55:00.250Z"),
				expiry: Date.parse("2026-11-05T10:13:00Z"),
				key,
			}),
		);
		// sp st se resource skoid sktid skt ske sks skv saoid suoid scid sip spr sv sr snapshot ses rscc rscd rsce rscl rsct
		const stringToSign = [
			"r",
			"2026-11-05T09:55:00Z",
			"2026-11-05T10:13:00Z",
			`/blob/${ACCOUNT}/renders/in/job_1-r4nd0m.json`,
			key.signedOid,
			key.signedTid,
			key.signedStart,
			key.signedExpiry,
			"b",
			"2024-11-04",
			"",
			"",
			"",
			"",
			"https",
			"2024-11-04",
			"b",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
		].join("\n");
		const sig = createHmac("sha256", Buffer.from(KEY_VALUE, "base64")).update(stringToSign).digest("base64");
		assert.deepEqual(Object.fromEntries(sas), {
			sp: "r",
			st: "2026-11-05T09:55:00Z",
			se: "2026-11-05T10:13:00Z",
			skoid: key.signedOid,
			sktid: key.signedTid,
			skt: key.signedStart,
			ske: key.signedExpiry,
			sks: "b",
			skv: "2024-11-04",
			spr: "https",
			sv: "2024-11-04",
			sr: "b",
			sig,
		});
	});
});

describe("parseRunOutput", () => {
	it("splits the supervisor's line from the runner's output", () => {
		const parsed = parseRunOutput(Buffer.concat([runOutput({ code: 1, stderr: "boom" }), Buffer.from("rest\n")]));
		assert.deepEqual(parsed?.header, { code: 1, timedOut: false, overflow: false, stderr: "boom", error: "" });
		assert.equal(parsed?.stdout.toString(), "rest\n");
	});

	it("refuses output that doesn't start with one", () => {
		assert.equal(parseRunOutput(Buffer.from("CAIRN-RESULT {}\n")), null);
		assert.equal(parseRunOutput(Buffer.from("CAIRN-RUN {not json}\n")), null);
		assert.equal(parseRunOutput(Buffer.from('CAIRN-RUN {"code":0}')), null);
	});
});

// ─── Status ────────────────────────────────────────────────────────────────

describe("the Azure renderer's status", () => {
	it("reads ready once the job and its storage answer, and caches it", async () => {
		const azure = fakeAzure();
		const manim = renderer(azure);
		assert.equal(manim.ready(), false);
		const ready = { state: "ready", reason: "Ready. Animations render in Azure, in a sandboxed Container Apps job.", image: MANIM_IMAGE };
		assert.deepEqual(await manim.status(), ready);
		assert.equal(manim.ready(), true);
		assert.deepEqual(await manim.install(), ready);
		assert.equal(azure.find("GET", (u) => u.pathname === JOB).length, 2);
		assert.equal(azure.find("POST", (u) => u.search.includes("userdelegationkey")).length, 1, "the delegation key is reused");
		for (const call of azure.calls) {
			assert.equal(call.headers.get("authorization"), `Bearer ${call.url.origin === ARM ? "arm-token" : "storage-token"}`);
			if (call.url.origin === BLOB) assert.equal(call.headers.get("x-ms-version"), "2024-11-04");
		}
		azure.advance(31_000);
		assert.equal(manim.ready(), true, "a stale answer stands while it refreshes");
	});

	it("says what's wrong with the job, its storage, or the identity", async () => {
		const forbidden = fakeAzure({
			job: () => Response.json({ error: { code: "AuthorizationFailed", message: "The client does not have authorization." } }, { status: 403 }),
		});
		assert.deepEqual(await renderer(forbidden).status(), {
			state: "unavailable",
			reason:
				"Cairn couldn't reach the Azure renderer: Azure Resource Manager answered HTTP 403 (AuthorizationFailed: The client does not have authorization.).",
			image: MANIM_IMAGE,
		});

		const updating = fakeAzure({ job: () => Response.json(jobBody("InProgress")) });
		assert.equal(
			(await renderer(updating).status()).reason,
			"The Azure renderer's job isn't ready yet (its state is InProgress). Check again in a minute.",
		);

		const oldImage = fakeAzure({
			job: () =>
				Response.json({
					properties: {
						provisioningState: "Succeeded",
						template: { containers: [{ name: "manim", image: "crcairn.azurecr.io/manimcommunity/manim:v0.19.0", resources: { cpu: 2, memory: "4Gi" } }] },
					},
				}),
		});
		const oldImageReason = `The Azure renderer's job runs crcairn.azurecr.io/manimcommunity/manim:v0.19.0, but this version of Cairn renders with ${MANIM_IMAGE}. Point the job at that image, then check again.`;
		assert.equal((await renderer(oldImage).status()).reason, oldImageReason);
		assert.deepEqual(await renderer(oldImage).render({ chatId: "chat-1", jobId: "job-1", mode: "preview", code: SCENE }), {
			ok: false,
			error: oldImageReason,
		});
		assert.equal(oldImage.find("PUT", () => true).length + oldImage.find("POST", (u) => u.pathname.endsWith("/start")).length, 0);

		const noStorage = fakeAzure({
			key: () =>
				new Response("<?xml version=\"1.0\"?><Error><Code>AuthorizationPermissionMismatch</Code><Message>This request is not authorized.\nRequestId:1</Message></Error>", {
					status: 403,
				}),
		});
		assert.equal(
			(await renderer(noStorage).status()).reason,
			"Cairn couldn't reach the Azure renderer's storage: Blob Storage answered HTTP 403 (AuthorizationPermissionMismatch: This request is not authorized.).",
		);

		const noIdentity = fakeAzure();
		const manim = selectManimRenderer(ENV, { ...noIdentity.deps, getToken: undefined });
		assert.equal(
			(await manim.status()).reason,
			"Cairn couldn't reach the Azure renderer: this server has no managed identity (IDENTITY_ENDPOINT isn't set).",
		);
	});

	it("gets its tokens from App Service's managed identity endpoint", async () => {
		const clientId = "33333333-3333-3333-3333-333333333333";
		const azure = fakeAzure({
			identity: (url) =>
				Response.json({
					access_token: url.searchParams.get("resource")?.includes("storage") ? "storage-token" : "arm-token",
					expires_on: String(Math.floor(T0 / 1000) + 3600),
				}),
		});
		const env = { ...ENV, CAIRN_MANIM_CLIENT_ID: clientId, IDENTITY_ENDPOINT: "http://127.0.0.1:41000/msi/token", IDENTITY_HEADER: "s3cret" };
		const manim = selectManimRenderer(env, { ...azure.deps, getToken: undefined });
		assert.equal((await manim.status()).state, "ready");
		assert.equal((await manim.status(true)).state, "ready");
		const identity = azure.find("GET", (u) => u.origin === "http://127.0.0.1:41000");
		assert.deepEqual(
			identity.map((c) => Object.fromEntries(c.url.searchParams)),
			[
				{ resource: "https://management.azure.com/", "api-version": "2019-08-01", client_id: clientId },
				{ resource: "https://storage.azure.com/", "api-version": "2019-08-01", client_id: clientId },
			],
			"one token per resource, reused until it nears expiry",
		);
		for (const call of identity) assert.equal(call.headers.get("x-identity-header"), "s3cret");
	});
});

// ─── Rendering ─────────────────────────────────────────────────────────────

describe("rendering in Azure", () => {
	it("uploads the bundle, starts one sandboxed execution, and returns the preview", async () => {
		const azure = fakeAzure();
		const out = await renderer(azure).render(request("preview"));
		assert.deepEqual(out, { ok: true, pngBase64: png(1280, 720).toString("base64"), durationSec: 4.5 });

		const [upload] = azure.find("PUT", (u) => u.origin === BLOB);
		assert.equal(upload?.url.pathname, "/renders/in/job_1-r4nd0m.json");
		assert.equal(upload?.headers.get("x-ms-blob-type"), "BlockBlob");
		assert.ok(upload?.headers.get("x-ms-date"));
		const bundle = JSON.parse(upload?.body ?? "{}") as { mode: string; files: Record<string, string> };
		assert.equal(bundle.mode, "preview");
		assert.deepEqual(Object.keys(bundle.files), ["cairn_run.py", "cairn_style.py", "scene.py"]);
		assert.equal(bundle.files["scene.py"], SCENE);

		const [start] = startBodies(azure);
		const container = start?.containers[0];
		assert.equal(start?.containers.length, 1);
		assert.equal(container?.name, "manim");
		assert.equal(container?.image, JOB_IMAGE);
		assert.deepEqual(container?.command, ["python", "-c", AZURE_BOOTSTRAP]);
		assert.deepEqual(container?.resources, { cpu: 2, memory: "4Gi" });
		const env = Object.fromEntries((container?.env ?? []).map((e) => [e.name, e.value]));
		assert.deepEqual(Object.keys(env), [
			"CAIRN_IN",
			"CAIRN_OUT",
			"CAIRN_BUDGET",
			"CAIRN_MAX",
			"HOME",
			"XDG_CACHE_HOME",
			"MPLCONFIGDIR",
			"PYTHONDONTWRITEBYTECODE",
			"PYTHONUNBUFFERED",
		]);
		assert.equal(env.CAIRN_BUDGET, "120");
		assert.equal(env.CAIRN_MAX, String(96 * 1024 * 1024));
		const input = new URL(env.CAIRN_IN ?? "");
		const output = new URL(env.CAIRN_OUT ?? "");
		assert.equal(`${input.origin}${input.pathname}`, `${BLOB}/renders/in/job_1-r4nd0m.json`);
		assert.equal(`${output.origin}${output.pathname}`, `${BLOB}/renders/out/job_1-r4nd0m.bin`);
		assert.equal(input.searchParams.get("sp"), "r", "the scene's URL can only read the bundle");
		assert.equal(output.searchParams.get("sp"), "cw", "the output URL can only write its own blob");
		for (const sas of [input, output]) {
			assert.equal(sas.searchParams.get("sr"), "b");
			assert.equal(sas.searchParams.get("spr"), "https");
			assert.equal(sas.searchParams.get("st"), "2026-11-05T09:55:00Z");
			assert.equal(sas.searchParams.get("se"), "2026-11-05T10:13:00Z", "the deadline (2 + 6 minutes) plus skew");
		}

		assert.equal(stops(azure).length, 0, "a finished execution isn't stopped");
		assert.deepEqual([...azure.blobs.keys()], [], "both blobs are deleted");
		assert.deepEqual(
			azure.find("DELETE", () => true).map((c) => c.url.pathname),
			["/renders/in/job_1-r4nd0m.json", "/renders/out/job_1-r4nd0m.bin"],
		);
	});

	it("saves a still into the chat's media, through the shared runner frames", async () => {
		const still = png(1920, 1080);
		const azure = fakeAzure({ output: () => runOutput({}, file("still.png", still), result({ ok: true })) });
		const out = await renderer(azure).render(request("still"));
		assert.deepEqual(out, {
			ok: true,
			still: { file: "job_1.png", mime: "image/png", bytes: still.length, width: 1920, height: 1080 },
			pngBase64: still.toString("base64"),
		});
		assert.deepEqual(fs.readFileSync(path.join(chatMediaDir("chat_a"), "job_1.png")), still);
	});

	it("follows a start that answers 202 with a Location", async () => {
		const location = `${ARM}/subscriptions/00000000-0000-0000-0000-0000000000a1/providers/Microsoft.App/locations/westus2/containerappOperationResults/op-1?api-version=2025-07-01`;
		const azure = fakeAzure({
			start: () => new Response(null, { status: 202, headers: { Location: location } }),
			operation: (n) => (n === 0 ? new Response(null, { status: 202 }) : Response.json({ name: "cairn-manim-later" })),
		});
		assert.equal((await renderer(azure).render(request())).ok, true);
		assert.equal(azure.find("GET", (u) => u.pathname.includes("containerappOperationResults")).length, 2);
		assert.ok(azure.find("GET", (u) => u.pathname === `${JOB}/executions/cairn-manim-later`).length > 0);
	});

	it("never follows a Location off Azure Resource Manager", async () => {
		const azure = fakeAzure({
			start: () => new Response(null, { status: 202, headers: { Location: "https://example.com/steal" } }),
		});
		assert.deepEqual(await renderer(azure).render(request()), {
			ok: false,
			error: "The Azure renderer failed: Azure answered the job's start with an unexpected Location.",
		});
		assert.equal(azure.find("GET", (u) => u.hostname === "example.com").length, 0);
		assert.deepEqual([...azure.blobs.keys()], [], "the bundle is deleted");
	});

	it("stops the execution and cleans up when the learner cancels", async () => {
		const controller = new AbortController();
		const azure = fakeAzure({
			execution: () => {
				controller.abort();
				return Response.json({ properties: { status: "Running" } });
			},
		});
		await assert.rejects(renderer(azure).render(request("final", controller.signal)), { name: "AbortError" });
		assert.deepEqual(
			stops(azure).map((c) => c.url.pathname),
			[`${JOB}/executions/cairn-manim-x1/stop`],
		);
		assert.deepEqual([...azure.blobs.keys()], []);
		assert.equal(azure.find("DELETE", () => true).length, 2);
	});

	it("stops an execution that outlives its deadline", async () => {
		const azure = fakeAzure({ execution: () => Response.json({ properties: { status: "Running" } }) });
		assert.deepEqual(await renderer(azure).render(request()), {
			ok: false,
			error: "The Azure renderer didn't finish within 8 minutes, so Cairn stopped it. Try again; if it keeps happening, simplify the scene.",
		});
		assert.equal(stops(azure).length, 1);
	});

	it("explains every way the container can end without a picture", async () => {
		const cases: [Buffer | null, string][] = [
			[
				runOutput({ code: null, error: "couldn't fetch the scene: HTTP Error 403: Server failed to authenticate the request" }),
				"The Azure renderer couldn't fetch the scene: HTTP Error 403: Server failed to authenticate the request.",
			],
			[
				runOutput({ code: -9, timedOut: true }),
				"The render took longer than 120 s and was stopped. Simplify the scene: fewer objects, a shorter run_time, no per-frame updaters.",
			],
			[runOutput({ code: -9, overflow: true }), "The render produced more than 96 MB and was stopped. Make the animation shorter or simpler."],
			[
				runOutput({ code: -9 }),
				"The render ran out of memory (4 GB) and was stopped. Simplify the scene: fewer objects, less detail, a shorter run_time.",
			],
			[
				runOutput({ code: 1, stderr: "Traceback (most recent call last):\n  File \"cairn_run.py\"\nImportError: boom\n" }),
				"The renderer stopped unexpectedly (exit code 1):\nTraceback (most recent call last):\n  File \"cairn_run.py\"\nImportError: boom",
			],
			[runOutput({}, result({ ok: false, error: "NameError: name 'Sqaure' is not defined" })), "NameError: name 'Sqaure' is not defined"],
			[Buffer.from("garbage"), "The Azure renderer returned something Cairn couldn't read."],
			[
				null,
				"The Azure renderer's job ended (Succeeded) without returning a render. That isn't a problem with the scene; try again in a minute.",
			],
		];
		for (const [output, error] of cases) {
			const azure = fakeAzure({ output: () => output });
			assert.deepEqual(await renderer(azure).render(request()), { ok: false, error });
			assert.deepEqual([...azure.blobs.keys()], []);
		}
	});

	it("refuses a bad id before touching Azure, and says why a broken setup can't render", async () => {
		const azure = fakeAzure();
		assert.deepEqual(await renderer(azure).render({ ...request(), chatId: "../x" }), {
			ok: false,
			error: "Cairn refused the render: the chat or job id is invalid.",
		});
		assert.equal(azure.calls.length, 0);

		const forbidden = fakeAzure({ job: () => new Response("", { status: 403 }) });
		assert.deepEqual(await renderer(forbidden).render(request()), {
			ok: false,
			error: "Cairn couldn't reach the Azure renderer: Azure Resource Manager answered HTTP 403.",
		});
		assert.equal(startBodies(forbidden).length, 0);
	});
});

describe("selectManimRenderer", () => {
	it("keeps Docker by default and explains a setting that can't work", async () => {
		const docker = await selectManimRenderer({}).status();
		assert.equal(docker.state, "no-docker", "Docker's adapter, off under tests");

		const typo = selectManimRenderer({ CAIRN_MANIM_BACKEND: "azure" });
		assert.deepEqual(await typo.status(), {
			state: "unavailable",
			reason: "CAIRN_MANIM_BACKEND must be docker or azure-job. Fix the setting, then restart Cairn.",
			image: MANIM_IMAGE,
		});
		assert.equal(typo.ready(), false);

		const unset = selectManimRenderer({ CAIRN_MANIM_BACKEND: "azure-job" });
		const reason = "Animations are set to render in Azure, but CAIRN_MANIM_JOB_ID is not set; CAIRN_MANIM_STORAGE_ACCOUNT is not set.";
		assert.equal((await unset.install()).reason, reason);
		assert.deepEqual(await unset.render(request()), { ok: false, error: reason });
	});
});
