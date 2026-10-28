/**
 * CHAT MEDIA (M13): the files a chat's Manim renders save under
 * data/media/<chatId>/ — the route that serves them (the whole file, one
 * byte range so a <video> can seek, 416 past the end), the names it
 * refuses, their deletion with the chat, and the renderer staying off
 * (no Docker, no pull) under tests.
 *
 * Runs under an isolated LH_DATA_DIR: the seam is set before any
 * config-loading import, so every app-module import is dynamic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { MANIM_IMAGE } from "../src/core/manim.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-media-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { PATHS } = await import("../config.ts");
if (!PATHS.media.startsWith(TMP)) throw new Error(`not hermetic: ${PATHS.media}`);
const { chatMediaDir, deleteChatMedia, manimRenderer, parseByteRange } = await import("../src/server/manim.ts");
const mediaRoute = await import("../app/api/chats/[id]/media/[file]/route.ts");
const manimRoute = await import("../app/api/manim/route.ts");
const { createChat, deleteChatSession } = await import("../src/server/chats.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TEN = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function writeMedia(chatId: string, file: string, bytes: Uint8Array | string): void {
	fs.mkdirSync(chatMediaDir(chatId), { recursive: true });
	fs.writeFileSync(path.join(chatMediaDir(chatId), file), bytes);
}

const getMedia = (id: string, file: string, range?: string) =>
	mediaRoute.GET(new Request("http://x/media", range ? { headers: { range } } : undefined), {
		params: Promise.resolve({ id, file }),
	});

const bytesOf = async (res: Response) => [...new Uint8Array(await res.arrayBuffer())];

describe("parseByteRange", () => {
	it("reads one range, clamps its end, and ignores what it can't serve", () => {
		const cases: Array<[string | null, number, ReturnType<typeof parseByteRange>]> = [
			["bytes=0-99", 1000, { start: 0, end: 99 }],
			["bytes=900-", 1000, { start: 900, end: 999 }],
			["bytes=-100", 1000, { start: 900, end: 999 }],
			["bytes=-5000", 1000, { start: 0, end: 999 }],
			["bytes=500-5000", 1000, { start: 500, end: 999 }],
			[" bytes=0-9 ", 1000, { start: 0, end: 9 }],
			["bytes=1000-", 1000, "unsatisfiable"],
			["bytes=-0", 1000, "unsatisfiable"],
			["bytes=0-", 0, "unsatisfiable"],
			["bytes=-5", 0, "unsatisfiable"],
			["bytes=0-1,5-9", 1000, null],
			["bytes=5-2", 1000, null],
			["bytes=-", 1000, null],
			["items=0-9", 1000, null],
			["", 1000, null],
			[null, 1000, null],
		];
		for (const [header, size, expected] of cases) {
			assert.deepEqual(parseByteRange(header, size), expected, `${JSON.stringify(header)} of ${size} bytes`);
		}
	});
});

describe("GET /api/chats/:id/media/:file", () => {
	it("serves the whole file, cached for good and never sniffed", async () => {
		writeMedia("chat_a", "job_1.mp4", TEN);
		const res = await getMedia("chat_a", "job_1.mp4");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "video/mp4");
		assert.equal(res.headers.get("accept-ranges"), "bytes");
		assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
		assert.equal(res.headers.get("x-content-type-options"), "nosniff");
		assert.equal(res.headers.get("content-length"), "10");
		assert.equal(res.headers.get("content-range"), null);
		assert.deepEqual(await bytesOf(res), [...TEN]);

		writeMedia("chat_a", "job_2.png", TEN);
		const still = await getMedia("chat_a", "job_2.png");
		assert.equal(still.headers.get("content-type"), "image/png");
		assert.deepEqual(await bytesOf(still), [...TEN]);
	});

	it("answers one byte range with 206 and 416s a range past the end", async () => {
		writeMedia("chat_a", "job_1.mp4", TEN);
		const part = await getMedia("chat_a", "job_1.mp4", "bytes=2-5");
		assert.equal(part.status, 206);
		assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
		assert.equal(part.headers.get("content-length"), "4");
		assert.deepEqual(await bytesOf(part), [2, 3, 4, 5]);

		const tail = await getMedia("chat_a", "job_1.mp4", "bytes=-3");
		assert.equal(tail.status, 206);
		assert.deepEqual(await bytesOf(tail), [7, 8, 9]);

		const past = await getMedia("chat_a", "job_1.mp4", "bytes=10-");
		assert.equal(past.status, 416);
		assert.equal(past.headers.get("content-range"), "bytes */10");
		assert.deepEqual(await bytesOf(past), []);

		const several = await getMedia("chat_a", "job_1.mp4", "bytes=0-1,5-9");
		assert.equal(several.status, 200);
		assert.deepEqual(await bytesOf(several), [...TEN]);
	});

	it("sends an empty file whole", async () => {
		writeMedia("chat_a", "job_0.mp4", new Uint8Array(0));
		const res = await getMedia("chat_a", "job_0.mp4");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-length"), "0");
		assert.deepEqual(await bytesOf(res), []);
	});

	it("404s anything but a <name>.png|mp4 file in the chat's own folder", async () => {
		// Each refused path would otherwise reach a real file.
		writeMedia("chat_a", "job_1.svg", "<svg/>");
		fs.mkdirSync(path.join(chatMediaDir("chat_a"), "dir.mp4"), { recursive: true });
		fs.writeFileSync(path.join(PATHS.media, "x.mp4"), "outside the chat");
		fs.writeFileSync(path.join(PATHS.media, "..", "x.mp4"), "outside the media");
		const refused: Array<[string, string]> = [
			["chat_a", "missing.mp4"],
			["chat_a", "job_1.svg"],
			["chat_a", "dir.mp4"],
			["chat_a", "../x.mp4"],
			["chat_a", "..\\x.mp4"],
			["..", "x.mp4"],
			["chat_b", "job_1.mp4"],
		];
		for (const [id, file] of refused) {
			const res = await getMedia(id, file);
			assert.equal(res.status, 404, `${id}/${file}`);
			assert.equal(res.headers.get("cache-control"), "no-store");
			assert.deepEqual(await res.json(), { error: "Unknown media" });
		}
	});
});

describe("a chat's media lifetime", () => {
	it("is deleted with its chat, and only its chat", async () => {
		const chat = createChat("Media fixture");
		const other = createChat("Other media fixture");
		writeMedia(chat.id, "job_9.mp4", TEN);
		writeMedia(other.id, "job_9.mp4", TEN);
		const outcome = await deleteChatSession(chat.id, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(fs.existsSync(chatMediaDir(chat.id)), false);
		assert.equal(fs.existsSync(path.join(chatMediaDir(other.id), "job_9.mp4")), true);
	});

	it("never resolves a chat id outside the media folder", () => {
		assert.throws(() => chatMediaDir(".."), /invalid chat id/);
		const sentinel = path.join(PATHS.media, "..", "keep.txt");
		fs.writeFileSync(sentinel, "keep");
		deleteChatMedia("..");
		assert.equal(fs.existsSync(sentinel), true);
	});
});

describe("the Manim renderer under tests", () => {
	it("reports animations off and never reaches Docker", async () => {
		const off = { state: "no-docker", reason: "Animations are off under tests.", image: MANIM_IMAGE };
		for (const res of [await manimRoute.GET(new Request("http://x/api/manim?fresh=1")), await manimRoute.POST()]) {
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("cache-control"), "no-store");
			assert.deepEqual(await res.json(), off);
		}
		assert.equal(manimRenderer.ready(), false);
		assert.deepEqual(
			await manimRenderer.render({ chatId: "chat_a", jobId: "job_1", code: "class Lesson(Scene): pass", mode: "final" }),
			{ ok: false, error: "Animations are off under tests." },
		);
	});
});
