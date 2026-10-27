/**
 * Import this FIRST in a test that writes chats or jobs through the real
 * stores: it points LH_DATA_DIR at a fresh temp folder before config.ts
 * reads it, so a test run never writes into the developer's data/ folder
 * (where the app's job recovery would pick the fixtures up). Each test
 * file runs in its own process, so the folder is per-file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-test-data-"));
process.env.LH_DATA_DIR = dir;
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
