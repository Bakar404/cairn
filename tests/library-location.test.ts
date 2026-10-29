/**
 * THE LIBRARY LOCATION (OneDrive wave): finding the work OneDrive, moving
 * the library (Settings › Storage), and what never moves with it.
 *
 * Hermetic: a temp data folder, auth file, and home folder — the
 * developer's real OneDrive is never looked at — all set before any
 * config-loading import, so every app-module import is dynamic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { OneDriveProbe } from "../src/store/onedrive.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-"));
const HOME = path.join(TMP, "home");
const DATA = path.join(TMP, "data");
// os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.LH_DATA_DIR = DATA;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

/** The work OneDrive as the client lays it out here. Linux has no client. */
const ONEDRIVE =
	process.platform === "darwin" ? path.join(HOME, "Library", "CloudStorage", "OneDrive-Test") : path.join(HOME, "OneDrive - Test");
const CLOUD_LIBRARY = path.join(ONEDRIVE, "Apps", "Cairn");
if (process.platform === "win32") process.env.OneDriveCommercial = ONEDRIVE;
else delete process.env.OneDriveCommercial;
fs.mkdirSync(ONEDRIVE, { recursive: true });

const { PATHS, LEDGER_FILES, GRAPH_FILES, deviceId } = await import("../config.ts");
if (!PATHS.library.startsWith(TMP)) throw new Error(`not hermetic: ${PATHS.library}`);
const { detectWorkOneDrive, oneDriveLibraryPath } = await import("../src/store/onedrive.ts");
const { BACKUPS_DIR, LIBRARY_DIRS, LibraryError, POINTER_FILE, moveLibrary, readPointer } = await import("../src/store/library.ts");
const { storageStatus, switchLibrary } = await import("../src/server/storage.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { chatStore } = await import("../src/store/chats.ts");
const storageRoute = await import("../app/api/storage/route.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function write(file: string, text = "x"): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}
const read = (file: string) => fs.readFileSync(file, "utf-8");
const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));
const failsWith = (code: string) => (err: unknown) => err instanceof LibraryError && err.code === code;

/** The learner's work, and the device state that never leaves the data folder. */
const LIBRARY_FILES = ["chats/a.json", "graph/nodes.jsonl", "media/a/x.mp4", "jobs/j.json"];
const DEVICE_FILES = ["settings.json", "copilot/token", "prompts/x.md"];

/** A fake machine: `dirs` are the folders that exist on it. */
function machine(platform: NodeJS.Platform, home: string, dirs: string[], env: Record<string, string> = {}): OneDriveProbe {
	const p = platform === "win32" ? path.win32 : path.posix;
	return {
		platform,
		env,
		home,
		listDir: (dir) => dirs.filter((d) => p.dirname(d) === dir).map((d) => p.basename(d)),
		isDir: (dir) => dirs.includes(dir.replace(/[\\/]+$/, "")),
	};
}

describe("finding the work OneDrive", () => {
	it("Windows: the client's OneDriveCommercial, else the first 'OneDrive - <org>' at home — never Personal", () => {
		const home = "C:\\Users\\ada";
		const at = (name: string) => `${home}\\${name}`;
		const work = (name: string) => ({ root: at(name), label: name });
		assert.deepEqual(
			detectWorkOneDrive(machine("win32", home, [at("OneDrive - Contoso"), at("OneDrive - Fabrikam")], { OneDriveCommercial: `${at("OneDrive - Fabrikam")}\\` })),
			work("OneDrive - Fabrikam"),
		);
		assert.deepEqual(detectWorkOneDrive(machine("win32", home, [at("OneDrive - Personal"), at("OneDrive - Woodgrove"), at("OneDrive")])), work("OneDrive - Woodgrove"));
		assert.deepEqual(
			detectWorkOneDrive(machine("win32", home, [at("OneDrive - Contoso")], { OneDriveCommercial: at("OneDrive - Gone") })),
			work("OneDrive - Contoso"),
			"a stale variable falls back to the folder scan",
		);
		assert.equal(detectWorkOneDrive(machine("win32", home, [at("OneDrive - Personal"), at("OneDrive")])), null);
		assert.equal(oneDriveLibraryPath(at("OneDrive - Contoso"), "win32"), at("OneDrive - Contoso\\Apps\\Cairn"));
	});

	it("macOS: ~/Library/CloudStorage/OneDrive-<org>, else a legacy home folder — never Personal or a SharePoint library", () => {
		const cloud = "/Users/ada/Library/CloudStorage";
		const personalOnly = [`${cloud}/OneDrive-Personal`, `${cloud}/OneDrive-SharedLibraries-Contoso`, `${cloud}/GoogleDrive-ada`];
		assert.deepEqual(detectWorkOneDrive(machine("darwin", "/Users/ada", [...personalOnly, `${cloud}/OneDrive-Contoso`])), {
			root: `${cloud}/OneDrive-Contoso`,
			label: "OneDrive - Contoso",
		});
		assert.deepEqual(detectWorkOneDrive(machine("darwin", "/Users/ada", [...personalOnly, "/Users/ada/OneDrive - Contoso"])), {
			root: "/Users/ada/OneDrive - Contoso",
			label: "OneDrive - Contoso",
		});
		assert.equal(detectWorkOneDrive(machine("darwin", "/Users/ada", personalOnly)), null);
		assert.equal(oneDriveLibraryPath(`${cloud}/OneDrive-Contoso`, "darwin"), `${cloud}/OneDrive-Contoso/Apps/Cairn`);
	});

	it("Linux: none (there is no OneDrive client)", () => {
		assert.equal(detectWorkOneDrive(machine("linux", "/home/ada", ["/home/ada/OneDrive - Contoso"])), null);
	});
});

describe("the storage pointer", () => {
	it("a missing, broken, or relative pointer means the local library, so Cairn still starts", () => {
		const root = fs.mkdtempSync(path.join(TMP, "pointer-"));
		const pointer = (value: unknown) => fs.writeFileSync(path.join(root, POINTER_FILE), typeof value === "string" ? value : JSON.stringify(value));
		assert.deepEqual(readPointer(root), { version: 1 });
		pointer("{not json");
		assert.deepEqual(readPointer(root), { version: 1 });
		pointer({ version: 2, library: CLOUD_LIBRARY });
		assert.deepEqual(readPointer(root), { version: 1 });
		pointer({ version: 1, library: "relative/Cairn", provider: "onedrive" });
		assert.deepEqual(readPointer(root), { version: 1 });
		pointer({ version: 1, library: CLOUD_LIBRARY, provider: "onedrive", last: { at: 5 } });
		assert.deepEqual(readPointer(root), { version: 1, library: CLOUD_LIBRARY, provider: "onedrive" }, "a malformed note is dropped, the location kept");
	});
});

describe("moving the library", () => {
	const ELSEWHERE = path.join(TMP, "elsewhere", "Cairn");

	it("copies it, follows it at once, leaves device state behind, and sets the old copy aside", () => {
		for (const f of LIBRARY_FILES) write(path.join(DATA, f), `library:${f}`);
		for (const f of DEVICE_FILES) write(path.join(DATA, f), `device:${f}`);
		const id = deviceId();

		const move = moveLibrary({ dataRoot: DATA, from: PATHS.library, to: ELSEWHERE, mode: "copy" });

		assert.equal(PATHS.library, ELSEWHERE, "no restart");
		assert.equal(PATHS.chats, path.join(ELSEWHERE, "chats"));
		assert.equal(PATHS.jobs, path.join(ELSEWHERE, "jobs"));
		assert.equal(LEDGER_FILES.nodes, path.join(ELSEWHERE, "graph", "nodes.jsonl"));
		assert.equal(GRAPH_FILES.sources, path.join(ELSEWHERE, "graph", "sources.json"));
		for (const f of LIBRARY_FILES) assert.equal(read(path.join(ELSEWHERE, f)), `library:${f}`);
		for (const f of [...DEVICE_FILES, "device.json", POINTER_FILE]) assert.ok(!exists(ELSEWHERE, f), `${f} stays on this device`);
		for (const f of DEVICE_FILES) assert.equal(read(path.join(DATA, f)), `device:${f}`);
		assert.equal(deviceId(), id);

		for (const dir of LIBRARY_DIRS) assert.ok(!exists(DATA, dir), `data/${dir} is set aside`);
		assert.equal(move.backups?.length, 1);
		const backup = move.backups?.[0] ?? assert.fail("the old copy is set aside");
		assert.equal(path.dirname(backup), path.join(DATA, BACKUPS_DIR));
		for (const f of LIBRARY_FILES) assert.equal(read(path.join(backup, f)), `library:${f}`, "nothing is deleted");
		assert.deepEqual(readPointer(DATA), { version: 1, library: ELSEWHERE, last: move });

		const chat = chatStore.createChat("Written after the move");
		assert.ok(exists(ELSEWHERE, "chats", `${chat.id}.json`), "new work lands in the moved library");
	});

	it("moving back copies it home, and the other copy stays (a synced folder is never emptied)", () => {
		const move = moveLibrary({ dataRoot: DATA, from: PATHS.library, to: DATA, mode: "copy" });
		assert.equal(PATHS.library, DATA);
		for (const f of LIBRARY_FILES) {
			assert.equal(read(path.join(DATA, f)), `library:${f}`);
			assert.ok(exists(ELSEWHERE, f), "other devices may still use it");
		}
		assert.equal(move.backups, undefined);
		assert.deepEqual(readPointer(DATA), { version: 1, last: move });
	});

	it("a move that fails to commit undoes every step", () => {
		const pointer = path.join(DATA, POINTER_FILE);
		const saved = fs.readFileSync(pointer);
		fs.rmSync(pointer);
		write(path.join(pointer, "blocker")); // a folder in the pointer's place: the commit can't write it
		const fresh = path.join(TMP, "fresh");
		try {
			assert.throws(() => moveLibrary({ dataRoot: DATA, from: DATA, to: path.join(fresh, "Apps", "Cairn"), mode: "copy" }), failsWith("failed"));
		} finally {
			fs.rmSync(pointer, { recursive: true, force: true });
			fs.writeFileSync(pointer, saved);
		}
		assert.equal(PATHS.library, DATA);
		assert.ok(!fs.existsSync(fresh), "every folder the move made is gone");
		for (const f of LIBRARY_FILES) assert.equal(read(path.join(DATA, f)), `library:${f}`);
		assert.deepEqual(fs.readdirSync(DATA).filter((name) => name.startsWith(`${POINTER_FILE}.tmp`)), []);
	});

	it("a library already at the target: copy refuses, replace sets it aside first, use-existing adopts it as is", () => {
		write(path.join(ELSEWHERE, "chats", "theirs.json"));
		assert.throws(() => moveLibrary({ dataRoot: DATA, from: DATA, to: ELSEWHERE, mode: "copy" }), failsWith("not_empty"));
		assert.equal(PATHS.library, DATA, "a refused move changes nothing");

		const replaced = moveLibrary({ dataRoot: DATA, from: DATA, to: ELSEWHERE, mode: "replace" });
		assert.equal(PATHS.library, ELSEWHERE);
		assert.ok(!exists(ELSEWHERE, "chats", "theirs.json"));
		const aside = replaced.backups?.find((dir) => dir.startsWith(ELSEWHERE));
		assert.ok(aside && exists(aside, "chats", "theirs.json"), "the replaced library is kept");

		assert.throws(() => moveLibrary({ dataRoot: DATA, from: ELSEWHERE, to: DATA, mode: "use-existing" }), failsWith("no_library"));
		write(path.join(DATA, "chats", "mine.json"));
		const adopted = moveLibrary({ dataRoot: DATA, from: ELSEWHERE, to: DATA, mode: "use-existing" });
		assert.equal(PATHS.library, DATA);
		assert.deepEqual(fs.readdirSync(path.join(DATA, "chats")), ["mine.json"], "nothing copied in");
		assert.ok(exists(ELSEWHERE, "chats", "a.json"), "nothing taken away");
		assert.equal(adopted.backups, undefined);
	});
});

describe("/api/storage", () => {
	const put = (body: string) => storageRoute.PUT(new Request("http://x/api/storage", { method: "PUT", body, headers: { "content-type": "application/json" } }));

	it("GET says where the library is; PUT takes a location, never a path", async () => {
		const res = await storageRoute.GET();
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("cache-control"), "no-store");
		assert.equal((await res.json()).library.root, DATA);

		const refused: Array<[string, RegExp]> = [
			["{not json", /expected/],
			["[]", /expected/],
			[JSON.stringify({ location: "local", path: "C:\\elsewhere" }), /unknown field\(s\): path/],
			[JSON.stringify({ location: "dropbox" }), /location must be/],
			[JSON.stringify({ location: "onedrive", existing: "merge" }), /existing must be/],
		];
		for (const [body, error] of refused) {
			const bad = await put(body);
			assert.equal(bad.status, 400, body);
			assert.match((await bad.json()).error, error);
		}
		const same = await put(JSON.stringify({ location: "local" }));
		assert.equal(same.status, 409);
		assert.equal((await same.json()).code, "same");
	});
});

describe("Settings › Storage: the work OneDrive", { skip: process.platform === "linux" && "no OneDrive client on Linux" }, () => {
	it("shows the library on this computer and offers the work OneDrive", () => {
		const status = storageStatus();
		assert.deepEqual(status.library, { root: DATA, kind: "local", available: true, chats: 1, files: 1, updatedAt: status.library.updatedAt });
		assert.equal(status.local, DATA);
		assert.deepEqual(status.onedrive, { root: ONEDRIVE, label: "OneDrive - Test", library: CLOUD_LIBRARY });
	});

	it("moves into OneDrive's Apps folder, live, and asks before using or replacing a library already there", () => {
		const there = switchLibrary({ location: "onedrive" });
		if (!there.ok) assert.fail(there.message);
		assert.equal(there.move.mode, "copy");
		assert.equal(there.status.library.kind, "onedrive");
		assert.equal(PATHS.chats, path.join(CLOUD_LIBRARY, "chats"));
		assert.ok(exists(CLOUD_LIBRARY, "chats", "mine.json"));
		assert.equal(readPointer(DATA).provider, "onedrive");
		assert.deepEqual(switchLibrary({ location: "onedrive" }), { ok: false, code: "same", message: "The library is already there." });

		const home = switchLibrary({ location: "local" });
		if (!home.ok) assert.fail(home.message);
		assert.equal(home.status.library.kind, "local");
		assert.ok(exists(CLOUD_LIBRARY, "chats", "mine.json"), "OneDrive keeps its copy");

		const conflict = switchLibrary({ location: "onedrive" });
		assert.ok(!conflict.ok && conflict.code === "library_exists", JSON.stringify(conflict));
		assert.equal(conflict.target?.root, CLOUD_LIBRARY);
		assert.equal(conflict.target?.chats, 1);
		assert.equal(PATHS.library, DATA, "nothing moves until the learner chooses");

		const used = switchLibrary({ location: "onedrive", existing: "use" });
		if (!used.ok) assert.fail(used.message);
		assert.equal(used.move.mode, "use-existing");
		assert.equal(PATHS.library, CLOUD_LIBRARY);
	});

	it("refuses while Cairn is working, and says so when OneDrive is gone", () => {
		assert.ok(beginTurn("storage-test-chat"));
		try {
			const busy = switchLibrary({ location: "local" });
			assert.equal(busy.ok ? "moved" : busy.code, "busy");
		} finally {
			endTurn("storage-test-chat");
		}

		const parked = path.join(TMP, "parked");
		fs.renameSync(ONEDRIVE, parked); // signed out, or the folder unmounted
		try {
			const status = storageStatus();
			assert.equal(status.onedrive, null);
			assert.equal(status.library.kind, "onedrive");
			assert.equal(status.library.available, false);
			const none = switchLibrary({ location: "onedrive" });
			assert.equal(none.ok ? "moved" : none.code, "no_onedrive");
		} finally {
			fs.renameSync(parked, ONEDRIVE);
		}
		assert.equal(storageStatus().library.available, true);
	});
});
