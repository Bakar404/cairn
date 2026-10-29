/**
 * The changelog gate (scripts/release-notes.ts): a tag ships only with its
 * own CHANGELOG.md section, and that section alone becomes the release body.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { releaseNotes } from "../scripts/release-notes.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed
- Not released yet.

## [1.2.0] - 2026-11-02

### Added
- A feature.

### Removed
- An old feature.

## [1.1.0] - 2026-10-01

- Older notes.

[Unreleased]: https://github.com/example/app/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/example/app/releases/tag/v1.2.0
`;

describe("releaseNotes", () => {
	it("returns only the version's section, without the file's link references", () => {
		assert.deepEqual(releaseNotes(CHANGELOG, "1.2.0"), {
			ok: true,
			notes: "### Added\n- A feature.\n\n### Removed\n- An old feature.",
		});
		assert.deepEqual(releaseNotes(CHANGELOG, "1.1.0"), { ok: true, notes: "- Older notes." });
	});

	it("refuses a version without a section, or with an empty one", () => {
		const missing = releaseNotes(CHANGELOG, "1.2");
		assert.equal(missing.ok, false);
		assert.match(!missing.ok ? missing.error : "", /no "## \[1\.2\]" section/);
		const empty = releaseNotes("## [2.0.0] - 2026-12-01\n\n[2.0.0]: https://example.com\n", "2.0.0");
		assert.equal(empty.ok, false);
		assert.match(!empty.ok ? empty.error : "", /section is empty/);
	});
});
