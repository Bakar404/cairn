/**
 * Release notes for one version: its `## [x.y.z]` section of CHANGELOG.md.
 *
 * The tag gate in .github/workflows/release.yml runs this before anything is
 * packaged, so a version cannot ship without a changelog entry, and the draft
 * job uses the printed section as the GitHub Release body.
 *
 *   npx tsx scripts/release-notes.ts <version> [--changelog <file>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function releaseNotes(changelog: string, version: string): { ok: true; notes: string } | { ok: false; error: string } {
	const lines = changelog.split(/\r?\n/);
	const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s|$)`);
	const start = lines.findIndex((line) => heading.test(line));
	if (start < 0) return { ok: false, error: `CHANGELOG.md has no "## [${version}]" section; add one before tagging v${version}` };
	const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	const notes = lines
		.slice(start + 1, next < 0 ? undefined : next)
		// Link reference definitions ([0.4.0]: https://…) belong to the whole file.
		.filter((line) => !/^\[[^\]]+\]:\s+\S/.test(line))
		.join("\n")
		.trim();
	if (notes === "") return { ok: false, error: `CHANGELOG.md's "## [${version}]" section is empty` };
	return { ok: true, notes };
}

function main(argv: string[]): number {
	let file = "CHANGELOG.md";
	const positional: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--changelog" && argv[index + 1] != null) file = argv[++index]!;
		else positional.push(argv[index]!);
	}
	const version = positional[0]?.replace(/^v/, "");
	if (positional.length !== 1 || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		console.error("usage: npx tsx scripts/release-notes.ts <version> [--changelog <file>]");
		return 2;
	}
	let changelog: string;
	try {
		changelog = fs.readFileSync(path.resolve(file), "utf8");
	} catch (error) {
		console.error(`cannot read ${file}: ${(error as Error).message}`);
		return 1;
	}
	const result = releaseNotes(changelog, version);
	if (!result.ok) {
		console.error(result.error);
		return 1;
	}
	console.log(result.notes);
	return 0;
}

const invokedAsCli = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsCli) process.exitCode = main(process.argv.slice(2));
