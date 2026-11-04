/**
 * LEARNING GOALS (M21): a teach session started from a certification's
 * study guide or a repository's stack. Deterministic: no network, and the
 * only folders read are temp folders this file writes.
 *
 *   1. the goal-context marker: its text for the model, its card's part,
 *      and goalOpening, the first message when the goal alone starts
 *   2. POST /api/chats: the goal rides the creation as message[0], ahead
 *      of the map context; a malformed goal, or one on a practice session,
 *      is dropped
 *   3. the certification read: readCertificationGoal against a fake Learn
 *      client, and POST /api/goals/certification's guards
 *   4. the repository: the pure detector on manifest fixtures, the
 *      proposal and the goal, the bounded walk, and POST /api/goals/repo
 *   5. the picker: the draft's create-on-send with a goal, the client's
 *      transport, and the panel, pill and card rendered on the server
 */

import "./isolated-data-dir.ts";
import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { POST as createChat } from "../app/api/chats/route.ts";
import { POST as postCertification } from "../app/api/goals/certification/route.ts";
import { POST as postRepo } from "../app/api/goals/repo/route.ts";
import { GoalContextCard, goalSummary } from "../components/goal-context-card.tsx";
import { GoalsPanel, postCertificationGoal, postRepoScan, type GoalRead } from "../components/goals-control.tsx";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { studyGuideUrl, type LearnDocsClient } from "../src/core/learn-docs.ts";
import { GOAL_LIMITS, goalOpening, goalOutline, type LearningGoal } from "../src/core/learning-goals.ts";
import { nativeInputCause, newGoalContextMessage, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import {
	detectRepoTechnologies,
	proposedTechnologies,
	repoFileRole,
	repoGoal,
	type RepoScan,
	type RepoTechnology,
} from "../src/core/repo-goals.ts";
import { projectView } from "../src/core/view.ts";
import { GoalError, readCertificationGoal, REPO_SCAN_LIMITS, scanRepository } from "../src/server/learning-goals.ts";
import { chatStore } from "../src/store/chats.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-goals-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const CERT_GOAL: LearningGoal = {
	kind: "certification",
	title: "Exam AZ-104: Microsoft Azure Administrator",
	source: studyGuideUrl("az-104"),
	note: "This exam will retire on June 30, 2027.",
	areas: [
		{
			name: "Manage Azure identities and governance",
			weight: "20–25%",
			groups: [{ name: "Manage Microsoft Entra users and groups", items: ["Create users and groups", "Manage licenses"] }],
		},
		{ name: "Implement and manage storage", weight: "15–20%", groups: [{ name: "", items: ["Configure access to storage"] }] },
	],
};

const REPO_GOAL: LearningGoal = {
	kind: "repo",
	title: "The stack of cairn",
	source: "C:\\src\\cairn",
	areas: [
		{ name: "Next.js", groups: [{ name: "Where this repository uses it", items: ["package.json: next 16.0.1"] }] },
		{ name: "TypeScript", groups: [{ name: "Where this repository uses it", items: ["package.json: typescript ^5", "tsconfig.json"] }] },
	],
};

/** The opening tag that carries an attribute, e.g. 'data-testid="goal-chip"'. */
function tagWith(html: string, attribute: string): string {
	const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`<[^<>]*${escaped}[^<>]*>`).exec(html);
	assert.ok(match, `${attribute} is rendered`);
	return match[0];
}

const testId = (html: string, id: string) => tagWith(html, `data-testid="${id}"`);

/** Run with some environment values set, then put them back. */
async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
	const env = process.env as Record<string, string | undefined>;
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, env[key]]));
	Object.assign(env, values);
	try {
		return await run();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
	}
}

// ─── 1. the marker ───────────────────────────────────────────────────────────

describe("the goal-context marker", () => {
	it("frames the goal for the model and carries the goal itself for the card", () => {
		const m = newGoalContextMessage(CERT_GOAL);
		assert.equal(m.customType, "goal-context");
		assert.equal(
			m.content,
			`[Session context] — the learner's learning goal, chosen when starting this session:\n\n${goalOutline(CERT_GOAL)}`,
		);
		assert.ok(m.content.includes("1. Manage Azure identities and governance (20–25%)"));
		assert.deepEqual(m.details, CERT_GOAL);
		assert.equal(nativeInputCause(m as never, []), "neutral", "context, not the learner's input");
	});

	it("toLlmMessages flattens it to a user message; projectView makes it a card's part, never a bubble", () => {
		const m = newGoalContextMessage(REPO_GOAL);
		const wire = toLlmMessages([m as unknown as LhMessage] as never);
		assert.equal(wire.length, 1);
		assert.equal(wire[0]!.role, "user");
		assert.ok(String((wire[0]!.content as { text?: string }[])[0]!.text).includes("Goal: The stack of cairn"));
		const view = projectView([m as unknown as LhMessage] as never);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.role, "user");
		assert.deepEqual(view[0]!.parts, [{ type: "data-goal-context", id: `gl_${m.id}`, data: REPO_GOAL }]);
	});

	it("goalOpening is the first message when the goal alone starts the session", () => {
		assert.equal(goalOpening(CERT_GOAL), "Help me prepare for Exam AZ-104: Microsoft Azure Administrator.");
		assert.equal(goalOpening(REPO_GOAL), "Help me learn the stack of cairn.");
	});
});

// ─── 2. the creation ─────────────────────────────────────────────────────────

describe("POST /api/chats with a goal", () => {
	const create = async (body: unknown) => {
		const res = await createChat(
			new Request("http://test/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		const { id } = (await res.json()) as { id: string };
		return chatStore.getChat(id)!;
	};

	it("the goal rides the creation as message[0]", async () => {
		const record = await create({ title: CERT_GOAL.title, goal: CERT_GOAL });
		assert.equal(record.messages.length, 1);
		const m = record.messages[0] as { role: string; customType: string; content: string; details: unknown };
		assert.equal(m.role, "custom");
		assert.equal(m.customType, "goal-context");
		assert.ok(m.content.includes(`Source: ${CERT_GOAL.source}`));
		assert.deepEqual(m.details, CERT_GOAL);
	});

	it("with map picks too, the goal comes first and the map context second", async () => {
		const record = await create({
			title: "storage",
			goal: REPO_GOAL,
			graphContext: { propositions: [{ id: "n_a", name: "Blob tiers", statement: "Cool storage costs less to keep." }] },
		});
		assert.deepEqual(
			record.messages.map((m) => (m as { customType?: string }).customType),
			["goal-context", "graph-context"],
		);
	});

	it("the server keeps the goal it parses, not the text it was sent", async () => {
		const record = await create({
			title: "t",
			goal: { ...REPO_GOAL, title: "  The   stack of cairn ", areas: [...REPO_GOAL.areas, { name: "" }], extra: "dropped" },
		});
		assert.deepEqual((record.messages[0] as { details: unknown }).details, REPO_GOAL);
	});

	it("a malformed goal, or a goal on a practice session, is dropped", async () => {
		for (const body of [
			{ title: "t", goal: { kind: "exam", title: "x", source: "y", areas: [{ name: "z" }] } },
			{ title: "t", goal: { ...CERT_GOAL, areas: [] } },
			{ title: "t", goal: "AZ-104" },
			{ title: "t", kind: "practice", goal: CERT_GOAL },
		]) {
			assert.equal((await create(body)).messages.length, 0, JSON.stringify(body).slice(0, 80));
		}
	});
});

// ─── 3. the certification read ───────────────────────────────────────────────

/** A study guide trimmed to one domain (the full shape is pinned in learn-docs.test.tsx). */
const GUIDE = `# Study guide for Exam AZ-104: Microsoft Azure Administrator

## Skills measured as of April 18, 2025

### Manage Azure identities and governance (20–25%)

#### Manage Microsoft Entra users and groups

- Create users and groups
`;

/** A Learn client that serves one page, or fails; it records the pages asked for. */
function fakeLearn(page: string | Error) {
	const urls: string[] = [];
	const client: LearnDocsClient = {
		search: async () => assert.fail("no search"),
		codeSamples: async () => assert.fail("no code samples"),
		fetch: async (url) => {
			urls.push(url);
			if (page instanceof Error) throw page;
			return page;
		},
	};
	return { client, urls };
}

async function goalStatus(read: Promise<unknown>): Promise<{ status: number; message: string }> {
	try {
		await read;
	} catch (err) {
		assert.ok(err instanceof GoalError, `a GoalError, not ${String(err)}`);
		return { status: err.status, message: err.message };
	}
	return assert.fail("the read should have failed");
}

describe("the certification read", () => {
	it("an exam code, however it's written, → the goal its study guide on Microsoft Learn lists", async () => {
		const { client, urls } = fakeLearn(GUIDE);
		const goal = await readCertificationGoal("Exam AZ 104", { client, enabled: () => true });
		assert.deepEqual(urls, [studyGuideUrl("az-104")]);
		assert.deepEqual(goal, {
			kind: "certification",
			title: "Exam AZ-104: Microsoft Azure Administrator",
			source: studyGuideUrl("az-104"),
			areas: [
				{
					name: "Manage Azure identities and governance",
					weight: "20–25%",
					groups: [{ name: "Manage Microsoft Entra users and groups", items: ["Create users and groups"] }],
				},
			],
		});
	});

	it("each way it fails is a GoalError carrying the route's status; a bad code or Learn switched off never reaches Learn", async () => {
		const unused = fakeLearn(GUIDE);
		assert.deepEqual(await goalStatus(readCertificationGoal("hello", { client: unused.client, enabled: () => true })), {
			status: 400,
			message: "That isn't an exam code. Try one like AZ-104.",
		});
		assert.deepEqual(await goalStatus(readCertificationGoal("AZ-104", { client: unused.client, enabled: () => false })), {
			status: 409,
			message: "Microsoft Learn is off. Turn it on in Settings › Agent to read study guides.",
		});
		assert.deepEqual(unused.urls, []);
		const down = fakeLearn(new Error("Microsoft Learn answered 503."));
		assert.deepEqual(await goalStatus(readCertificationGoal("AZ-104", { client: down.client, enabled: () => true })), {
			status: 502,
			message: "Couldn't read the study guide: Microsoft Learn answered 503.",
		});
		const other = fakeLearn("# Azure overview\n\nNothing measured here.");
		assert.deepEqual(await goalStatus(readCertificationGoal("xx000", { client: other.client, enabled: () => true })), {
			status: 404,
			message: "Microsoft Learn has no study guide for XX-000.",
		});
	});
});

describe("POST /api/goals/certification", () => {
	const post = (body: unknown, headers: Record<string, string> = {}) =>
		postCertification(
			new Request("http://localhost/api/goals/certification", {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: typeof body === "string" ? body : JSON.stringify(body),
			}),
		);

	it("refuses cross-site requests and bodies that aren't JSON", async () => {
		assert.equal((await post({ code: "AZ-104" }, { "sec-fetch-site": "cross-site" })).status, 403);
		assert.equal((await post({ code: "AZ-104" }, { "sec-fetch-site": "same-site" })).status, 403);
		assert.equal((await post("code=AZ-104", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
	});

	it("answers each failure with ok:false, the reason and its status", async () => {
		const missing = await post({ code: 104 });
		assert.equal(missing.status, 400);
		assert.deepEqual(await missing.json(), { ok: false, error: "Send an exam code." });
		const bad = await post({ code: "hello" }, { "sec-fetch-site": "same-origin" });
		assert.equal(bad.status, 400);
		assert.deepEqual(await bad.json(), { ok: false, error: "That isn't an exam code. Try one like AZ-104." });
		// Under tests the shared Learn client never reaches the network, so
		// the read fails the way an unreachable Learn does.
		const offline = await withEnv({ NODE_ENV: "test" }, () => post({ code: "AZ-104" }));
		assert.equal(offline.status, 502);
		const body = (await offline.json()) as { ok: boolean; error: string };
		assert.equal(body.ok, false);
		assert.match(body.error, /^Couldn't read the study guide: /);
	});
});

// ─── 4. the repository ───────────────────────────────────────────────────────

const names = (technologies: readonly RepoTechnology[]) => technologies.map((t) => t.name);

function technology(technologies: readonly RepoTechnology[], name: string): RepoTechnology {
	const found = technologies.find((t) => t.name === name);
	assert.ok(found, `${name} is detected`);
	return found;
}

describe("the repository detector", () => {
	it("which files the walk keeps: manifests are read, telling files are listed, the rest is ignored", () => {
		assert.equal(repoFileRole("package.json"), "manifest");
		assert.equal(repoFileRole("src/Api/Api.csproj"), "manifest");
		assert.equal(repoFileRole("requirements-dev.txt"), "manifest");
		assert.equal(repoFileRole("Dockerfile"), "signal");
		assert.equal(repoFileRole(".github/workflows/ci.yml"), "signal");
		assert.equal(repoFileRole("src/index.ts"), null);
		assert.equal(repoFileRole("docs/workflows/ci.yml"), null, "only GitHub's workflow folder");
	});

	it("package.json: what its dependencies name, ranked; packages Cairn doesn't know stay out", () => {
		const found = detectRepoTechnologies([
			{
				path: "package.json",
				content: JSON.stringify({
					dependencies: {
						next: "16.0.1",
						react: "^19.0.0",
						"react-dom": "^19.0.0",
						"@azure/msal-browser": "^3",
						"@azure/storage-blob": "^12",
						"left-pad": "1.3.0",
					},
					devDependencies: { typescript: "^5", eslint: "^9", "@playwright/test": "^1.50" },
				}),
			},
		]);
		assert.deepEqual(found, [
			{ name: "Next.js", category: "framework", evidence: ["package.json: next 16.0.1"], count: 1 },
			{ name: "React", category: "framework", evidence: ["package.json: react ^19.0.0", "package.json: react-dom ^19.0.0"], count: 2 },
			{ name: "Node.js", category: "language", evidence: ["package.json"], count: 1 },
			{ name: "TypeScript", category: "language", evidence: ["package.json: typescript ^5"], count: 1 },
			{ name: "Azure SDK", category: "library", evidence: ["package.json: @azure/storage-blob ^12"], count: 1 },
			{ name: "Microsoft identity platform (MSAL)", category: "library", evidence: ["package.json: @azure/msal-browser ^3"], count: 1 },
			{ name: "ESLint", category: "tool", evidence: ["package.json: eslint ^9"], count: 1 },
			{ name: "Playwright", category: "tool", evidence: ["package.json: @playwright/test ^1.50"], count: 1 },
		]);
	});

	it("Python: requirements files, PEP 621 and Poetry tables; names normalized, markers, options and comments skipped", () => {
		const found = detectRepoTechnologies([
			{
				path: "api/requirements-dev.txt",
				content: "# tools\n-r requirements.txt\nfastapi[all]>=0.110 ; python_version > '3.8'\nscikit_learn==1.4  # pinned\npytest\n",
			},
			{
				path: "pyproject.toml",
				content:
					'[project]\nname = "svc"\ndependencies = [\n  "Flask>=3",\n  "pydantic",\n]\n\n[project.optional-dependencies]\nml = ["torch"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nstreamlit = "^1.30"\n',
			},
		]);
		assert.deepEqual(names(found), ["FastAPI", "Flask", "Streamlit", "Python", "Pydantic", "PyTorch", "scikit-learn", "pytest"]);
		assert.deepEqual(technology(found, "Python").evidence, ["api/requirements-dev.txt", "pyproject.toml"]);
		assert.deepEqual(technology(found, "FastAPI").evidence, ["api/requirements-dev.txt: fastapi >=0.110"]);
		assert.deepEqual(technology(found, "scikit-learn").evidence, ["api/requirements-dev.txt: scikit_learn ==1.4"]);
		assert.deepEqual(technology(found, "Streamlit").evidence, ["pyproject.toml: streamlit ^1.30"]);
	});

	it(".NET: the SDK, the target frameworks and package references, through a byte-order mark and CRLF lines", () => {
		const csproj =
			'\uFEFF<Project Sdk="Microsoft.NET.Sdk.Web">\r\n  <PropertyGroup>\r\n    <TargetFrameworks>net8.0;net9.0</TargetFrameworks>\r\n  </PropertyGroup>\r\n  <ItemGroup>\r\n    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.1" />\r\n    <PackageReference Version="1.11.0" Include="Azure.Identity" />\r\n    <PackageReference Include="xunit" Version="2.6.0" />\r\n  </ItemGroup>\r\n</Project>\r\n';
		const found = detectRepoTechnologies([{ path: "src\\Api\\Api.csproj", content: csproj }]);
		assert.deepEqual([...names(found)].sort(), ["ASP.NET Core", ".NET", "C#", "Azure SDK", "Entity Framework Core", "xUnit"].sort());
		assert.deepEqual(technology(found, ".NET").evidence, ["src/Api/Api.csproj: net8.0, net9.0"]);
		assert.deepEqual(technology(found, "ASP.NET Core").evidence, ["src/Api/Api.csproj: Microsoft.NET.Sdk.Web"]);
		assert.deepEqual(technology(found, "Azure SDK").evidence, ["src/Api/Api.csproj: Azure.Identity 1.11.0"]);
		assert.equal(found[0]!.name, "ASP.NET Core", "frameworks first");
	});

	it("Go, Rust, Java, Kotlin, Ruby and PHP manifests", () => {
		const found = detectRepoTechnologies([
			{
				path: "go.mod",
				content:
					"module example.com/svc\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/spf13/cobra v1.8.0 // indirect\n)\n\nrequire google.golang.org/grpc v1.60.0\n",
			},
			{
				path: "Cargo.toml",
				content:
					'[package]\nname = "svc"\n\n[dependencies]\ntokio = { version = "1.35", features = ["full"] }\nserde = "1.0"\n\n[dependencies.axum]\nversion = "0.7"\n\n[dev-dependencies]\nclap = "4"\n',
			},
			{
				path: "pom.xml",
				content:
					"<project>\n  <parent>\n    <groupId>org.springframework.boot</groupId>\n    <artifactId>spring-boot-starter-parent</artifactId>\n    <version>3.2.0</version>\n  </parent>\n  <dependencies>\n    <dependency>\n      <groupId>com.azure</groupId>\n      <artifactId>azure-identity</artifactId>\n      <version>1.11.0</version>\n    </dependency>\n  </dependencies>\n</project>\n",
			},
			{
				path: "app/build.gradle.kts",
				content:
					'plugins {\n    kotlin("jvm") version "1.9.22"\n    id("io.quarkus")\n}\ndependencies {\n    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")\n}\n',
			},
			{ path: "Gemfile", content: "source \"https://rubygems.org\"\ngem \"rails\", \"~> 7.1\"\ngem 'rspec-rails', group: :test\n" },
			{
				path: "composer.json",
				content: JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^11.0" }, "require-dev": { "phpunit/phpunit": "^10.5" } }),
			},
		]);
		const evidence = (name: string) => technology(found, name).evidence;
		assert.deepEqual(evidence("Go"), ["go.mod: go 1.22"]);
		assert.deepEqual(evidence("Gin"), ["go.mod: github.com/gin-gonic/gin v1.9.1"]);
		assert.deepEqual(evidence("gRPC"), ["go.mod: google.golang.org/grpc v1.60.0"]);
		assert.ok(!names(found).includes("Cobra"), "an indirect requirement isn't the project's own");
		assert.deepEqual(evidence("Tokio"), ["Cargo.toml: tokio 1.35"]);
		assert.deepEqual(evidence("Axum"), ["Cargo.toml: axum"]);
		assert.deepEqual(evidence("clap"), ["Cargo.toml: clap 4"]);
		assert.deepEqual(evidence("Spring Boot"), ["pom.xml: org.springframework.boot:spring-boot-starter-parent 3.2.0"]);
		assert.deepEqual(evidence("Java"), ["pom.xml", "app/build.gradle.kts"]);
		assert.deepEqual(evidence("Kotlin"), ["app/build.gradle.kts"]);
		assert.deepEqual(evidence("Quarkus"), ["app/build.gradle.kts: io.quarkus"]);
		assert.deepEqual(evidence("JUnit"), ["app/build.gradle.kts: org.junit.jupiter:junit-jupiter 5.10.0"]);
		assert.deepEqual(evidence("Ruby on Rails"), ["Gemfile: rails ~> 7.1"]);
		assert.deepEqual(evidence("RSpec"), ["Gemfile: rspec-rails"]);
		assert.deepEqual(evidence("PHP"), ["composer.json: php ^8.2"]);
		assert.deepEqual(evidence("Laravel"), ["composer.json: laravel/framework ^11.0"]);
		assert.deepEqual(evidence("PHPUnit"), ["composer.json: phpunit/phpunit ^10.5"]);
	});

	it("telling files name their technology by path alone", () => {
		const found = detectRepoTechnologies(
			[
				"Dockerfile",
				"deploy/compose.prod.yaml",
				".github/workflows/ci.yml",
				"infra/main.bicep",
				"infra/net.tf",
				"azure.yaml",
				"charts/web/Chart.yaml",
				".devcontainer/devcontainer.json",
				"tsconfig.json",
				"notebooks/explore.ipynb",
				"README.md",
			].map((p) => ({ path: p })),
		);
		assert.deepEqual(names(found), [
			"TypeScript",
			"Docker",
			"Azure Developer CLI",
			"Bicep",
			"GitHub Actions",
			"Helm",
			"Terraform",
			"Dev Containers",
			"Jupyter",
		]);
		assert.deepEqual(technology(found, "Docker").evidence, ["Dockerfile", "deploy/compose.prod.yaml"]);
	});

	it("ranks by kind, then by how many files use it, then by name; the evidence is capped, the count isn't", () => {
		const found = detectRepoTechnologies([
			{ path: "Dockerfile" },
			{ path: "a/package.json", content: JSON.stringify({ dependencies: { "@angular/core": "^17", vue: "^3" } }) },
			{ path: "b/package.json", content: JSON.stringify({ dependencies: { vue: "^3.4" } }) },
			{ path: "./c/requirements.txt", content: "numpy\n" },
		]);
		assert.deepEqual(names(found), ["Vue", "Angular", "Node.js", "Python", "Docker", "NumPy"]);
		assert.deepEqual(technology(found, "NumPy").evidence, ["c/requirements.txt: numpy"]);

		const many = detectRepoTechnologies(
			Array.from({ length: 20 }, (_, i) => ({ path: `p${i}/package.json`, content: '{"dependencies":{"next":"16"}}' })),
		);
		const next = technology(many, "Next.js");
		assert.equal(next.evidence.length, GOAL_LIMITS.items);
		assert.equal(next.count, 20);
		assert.equal(next.evidence[0], "p0/package.json: next 16");
	});

	it("a manifest it can't parse still names its language", () => {
		assert.deepEqual(
			detectRepoTechnologies([
				{ path: "package.json", content: "{ not json" },
				{ path: "composer.json", content: "" },
			]),
			[
				{ name: "Node.js", category: "language", evidence: ["package.json"], count: 1 },
				{ name: "PHP", category: "language", evidence: ["composer.json"], count: 1 },
			],
		);
	});

	it("proposedTechnologies ticks the first frameworks, languages and infrastructure, never libraries or tools", () => {
		const t = (name: string, category: RepoTechnology["category"]): RepoTechnology => ({ name, category, evidence: [], count: 1 });
		const list = [
			t("Next.js", "framework"),
			t("React", "framework"),
			t("Node.js", "language"),
			t("TypeScript", "language"),
			t("Docker", "infrastructure"),
			t("Bicep", "infrastructure"),
			t("Zod", "library"),
			t("ESLint", "tool"),
		];
		assert.deepEqual(proposedTechnologies(list), ["Next.js", "React", "Node.js", "TypeScript", "Docker"]);
		assert.deepEqual(proposedTechnologies([t("Zod", "library"), t("Vite", "tool")]), []);
	});

	it("repoGoal: one area per chosen technology, listing where the repository uses it; 12 at most; null for none", () => {
		const scan = { path: "C:\\src\\cairn", name: "cairn" };
		const chosen = detectRepoTechnologies([{ path: "package.json", content: '{"dependencies":{"next":"16.0.1"}}' }]);
		assert.deepEqual(repoGoal(scan, chosen), {
			kind: "repo",
			title: "The stack of cairn",
			source: "C:\\src\\cairn",
			areas: [
				{ name: "Next.js", groups: [{ name: "Where this repository uses it", items: ["package.json: next 16.0.1"] }] },
				{ name: "Node.js", groups: [{ name: "Where this repository uses it", items: ["package.json"] }] },
			],
		});
		const fourteen = Array.from(
			{ length: 14 },
			(_, i): RepoTechnology => ({ name: `Tech ${i}`, category: "library", evidence: [`f${i}`], count: 1 }),
		);
		assert.equal(repoGoal(scan, fourteen)?.areas.length, GOAL_LIMITS.areas);
		assert.equal(repoGoal(scan, []), null);
	});
});

/** Write files into a fresh folder under TMP; returns the folder. */
function repository(name: string, files: Record<string, string>): string {
	const root = path.join(TMP, name);
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(root, ...rel.split("/"));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	return root;
}

describe("scanRepository", () => {
	const root = repository("shop", {
		"package.json": '{"dependencies":{"next":"16.0.1"}}',
		"README.md": "# shop",
		Dockerfile: "FROM node:22",
		".github/workflows/ci.yml": "on: push",
		"api/requirements.txt": "fastapi\n",
		"lib/deep/Cargo.toml": '[dependencies]\ntokio = "1"\n',
		"node_modules/vue/package.json": '{"dependencies":{"vue":"3"}}',
		"dist/package.json": '{"dependencies":{"express":"4"}}',
		".venv/requirements.txt": "django\n",
		".git/config": "[core]",
	});

	it("reads manifests and telling files breadth-first, skipping dependency, build and hidden folders but .github", async () => {
		const scan = await scanRepository(root);
		assert.equal(scan.path, root);
		assert.equal(scan.name, "shop");
		assert.equal(scan.partial, false);
		assert.deepEqual(scan.manifests, ["package.json", "api/requirements.txt", "lib/deep/Cargo.toml"]);
		assert.deepEqual(names(scan.technologies), [
			"FastAPI",
			"Next.js",
			"Node.js",
			"Python",
			"Rust",
			"Docker",
			"GitHub Actions",
			"Tokio",
		]);
	});

	it("folders past the depth bound are skipped like dependency folders, which alone isn't partial", async () => {
		const scan = await scanRepository(root, { limits: { depth: 1 } });
		assert.deepEqual(scan.manifests, ["package.json", "api/requirements.txt"]);
		assert.ok(!names(scan.technologies).includes("GitHub Actions"), "the workflow sits two folders down");
		assert.equal(scan.partial, false);
	});

	it("a bound that cuts the read short says so: entries, manifests, a manifest's size, the clock, an abort", async () => {
		const entries = await scanRepository(root, { limits: { entries: 4 } });
		assert.equal(entries.partial, true);
		assert.deepEqual(entries.manifests, []);
		assert.deepEqual(names(entries.technologies), ["Docker"]);

		const manifests = await scanRepository(root, { limits: { manifests: 1 } });
		assert.equal(manifests.partial, true);
		assert.deepEqual(manifests.manifests, ["package.json"]);

		const size = await scanRepository(root, { limits: { manifestBytes: 10 } });
		assert.equal(size.partial, true);
		assert.ok(size.manifests.includes("package.json"), "too large to read, still listed");
		assert.ok(names(size.technologies).includes("Node.js") && !names(size.technologies).includes("Next.js"));
		assert.ok(names(size.technologies).includes("FastAPI"), "a small manifest is still read");

		let tick = 0;
		const late = await scanRepository(root, { limits: { ms: 0 }, now: () => tick++ });
		assert.equal(late.partial, true);
		assert.deepEqual(late.technologies, []);

		const aborted = await scanRepository(root, { signal: AbortSignal.abort() });
		assert.equal(aborted.partial, true);
		assert.deepEqual(aborted.technologies, []);
	});

	it("a path that isn't a full one is a 400, no folder there a 404; quotes and ~ are understood", async () => {
		const status = async (input: string) => {
			try {
				await scanRepository(input);
				return 200;
			} catch (err) {
				assert.ok(err instanceof GoalError, String(err));
				return err.status;
			}
		};
		for (const input of ["", "   ", "shop", "./shop", `${root}\0x`, path.join(TMP, "x".repeat(REPO_SCAN_LIMITS.pathLength))]) {
			assert.equal(await status(input), 400, JSON.stringify(input).slice(0, 60));
		}
		assert.equal(await status(path.join(TMP, "missing")), 404);
		assert.equal(await status(path.join(root, "package.json")), 404, "a file isn't a folder");
		assert.equal(await status(`"${root}"`), 200, "a copied path keeps its quotes");
		// "~" is the learner's home folder: the path is a full one, just not there.
		assert.equal(await status("~/cairn-goals-no-such-folder-7f3a"), 404);
	});
});

describe("POST /api/goals/repo", () => {
	const post = (body: unknown, headers: Record<string, string> = {}) =>
		postRepo(
			new Request("http://localhost/api/goals/repo", {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: typeof body === "string" ? body : JSON.stringify(body),
			}),
		);

	it("refuses cross-site requests and bodies that aren't JSON", async () => {
		assert.equal((await post({ repoPath: TMP }, { "sec-fetch-site": "cross-site" })).status, 403);
		assert.equal((await post(`repoPath=${TMP}`, { "content-type": "text/plain" })).status, 415);
	});

	it("answers the scan, or ok:false with the reason and its status", async () => {
		const root = repository("route", { "go.mod": "module x\n\ngo 1.22\n" });
		const ok = await post({ repoPath: root }, { "sec-fetch-site": "same-origin" });
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), {
			ok: true,
			scan: {
				path: root,
				name: "route",
				technologies: [{ name: "Go", category: "language", evidence: ["go.mod: go 1.22"], count: 1 }],
				manifests: ["go.mod"],
				partial: false,
			},
		});
		for (const [body, status, error] of [
			[{}, 400, "Send the path to a folder."],
			[{ repoPath: "route" }, 400, "Enter the full path to a folder."],
			[{ repoPath: path.join(TMP, "gone") }, 404, "There's no folder at that path."],
		] as const) {
			const response = await post(body);
			assert.equal(response.status, status);
			assert.deepEqual(await response.json(), { ok: false, error });
		}
	});
});

// ─── 5. the picker ───────────────────────────────────────────────────────────

/** A fetch double: one canned answer for every call; it records the calls. */
function answering(status: number, body: unknown) {
	const calls: { url: string; body: unknown }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	return { f, calls };
}

describe("the draft's create-on-send with a goal", () => {
	it("the goal alone starts a teach session: titled after it, opening with goalOpening's line", async () => {
		const { f, calls } = answering(200, { id: "c_goal" });
		assert.equal(
			await startDraftSession("  ", f, undefined, undefined, CERT_GOAL),
			`/chat/c_goal?prompt=${encodeURIComponent(goalOpening(CERT_GOAL))}`,
		);
		assert.deepEqual(calls, [{ url: "/api/chats", body: { title: CERT_GOAL.title, goal: CERT_GOAL } }]);
	});

	it("with text, the text is the title and the first message, and the goal rides along", async () => {
		const { f, calls } = answering(200, { id: "c_goal" });
		assert.equal(await startDraftSession("focus on storage", f, undefined, undefined, REPO_GOAL), "/chat/c_goal?prompt=focus%20on%20storage");
		assert.deepEqual(calls.map((c) => c.body), [{ title: "focus on storage", goal: REPO_GOAL }]);
	});

	it("a practice draft ignores a goal: nothing is sent without text, and no goal key with it", async () => {
		const { f, calls } = answering(200, { id: "c_practice" });
		assert.equal(await startDraftSession("", f, "practice", [], CERT_GOAL), null);
		await startDraftSession("drill me", f, "practice", [], CERT_GOAL);
		assert.deepEqual(calls.map((c) => c.body), [{ title: "drill me", kind: "practice" }]);
	});
});

describe("the picker's transport", () => {
	it("postCertificationGoal posts the code and returns the goal, cleaned", async () => {
		const { f, calls } = answering(200, { ok: true, goal: { ...CERT_GOAL, title: ` ${CERT_GOAL.title} ` } });
		assert.deepEqual(await postCertificationGoal("AZ-104", f), CERT_GOAL);
		assert.deepEqual(calls, [{ url: "/api/goals/certification", body: { code: "AZ-104" } }]);
	});

	it("postCertificationGoal fails with the server's reason, the status, a shape it can't read, or an unreachable server", async () => {
		const reason = answering(404, { ok: false, error: "Microsoft Learn has no study guide for XX-000." }).f;
		await assert.rejects(postCertificationGoal("XX-000", reason), { message: "Microsoft Learn has no study guide for XX-000." });
		await assert.rejects(postCertificationGoal("AZ-104", answering(500, "<html>").f), { message: "The request failed (HTTP 500)." });
		await assert.rejects(postCertificationGoal("AZ-104", answering(200, { ok: true, goal: REPO_GOAL }).f), {
			message: "The study guide came back in a shape Cairn can't read.",
		});
		const down = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		await assert.rejects(postCertificationGoal("AZ-104", down), { message: "Couldn't reach Cairn's server." });
	});

	it("postRepoScan posts the path and reads the scan; a category it doesn't know is a shape it can't read", async () => {
		const scan: RepoScan = {
			path: "C:\\src\\shop",
			name: "shop",
			technologies: [{ name: "Go", category: "language", evidence: ["go.mod: go 1.22"], count: 1 }],
			manifests: ["go.mod"],
			partial: false,
		};
		const { f, calls } = answering(200, { ok: true, scan: { ...scan, partial: "yes" } });
		assert.deepEqual(await postRepoScan("C:\\src\\shop", f), scan, "partial only when it says true");
		assert.deepEqual(calls, [{ url: "/api/goals/repo", body: { repoPath: "C:\\src\\shop" } }]);
		const odd = { ...scan, technologies: [{ name: "Go", category: "constructor", evidence: [], count: 1 }] };
		await assert.rejects(postRepoScan("C:\\src\\shop", answering(200, { ok: true, scan: odd }).f), {
			message: "The scan came back in a shape Cairn can't read.",
		});
		const relative = answering(400, { ok: false, error: "Enter the full path to a folder." }).f;
		await assert.rejects(postRepoScan("shop", relative), { message: "Enter the full path to a folder." });
	});
});

const read = <T,>(value: T | null = null, extra: Partial<GoalRead<T>> = {}): GoalRead<T> => ({
	pending: false,
	error: null,
	value,
	...extra,
});

function panel(props: Partial<ComponentProps<typeof GoalsPanel>> = {}): string {
	return renderToStaticMarkup(
		<GoalsPanel
			tab="certification"
			onTab={() => {}}
			code=""
			onCode={() => {}}
			certification={read<LearningGoal>()}
			onRead={() => {}}
			repoPath=""
			onRepoPath={() => {}}
			repo={read<RepoScan>()}
			onScan={() => {}}
			chosen={[]}
			onChosen={() => {}}
			onUse={() => {}}
			{...props}
		/>,
	);
}

const SCAN: RepoScan = {
	path: "C:\\src\\shop",
	name: "shop",
	technologies: [
		{ name: "Next.js", category: "framework", evidence: ["package.json: next 16.0.1"], count: 1 },
		{ name: "Node.js", category: "language", evidence: ["package.json", "web/package.json"], count: 2 },
		{ name: "Zod", category: "library", evidence: ["package.json: zod ^3"], count: 1 },
	],
	manifests: ["package.json", "web/package.json"],
	partial: false,
};

describe("the Goals panel", () => {
	it("the certification tab: the exam code, the suggestions, nothing read yet", () => {
		const html = panel();
		assert.ok(html.includes('role="dialog" aria-label="Set a learning goal"'));
		assert.match(testId(html, "goal-tab-certification"), /aria-pressed="true"/);
		assert.match(testId(html, "goal-tab-repo"), /aria-pressed="false"/);
		assert.ok(html.includes('placeholder="AZ-104"'));
		assert.ok(html.includes('aria-label="AZ-900: Azure Fundamentals"'));
		assert.match(testId(html, "goal-read"), / disabled=""/, "nothing to read yet");
		assert.ok(!html.includes('data-testid="goal-preview"'));
	});

	it("while it reads: the button and a status line say so", () => {
		const html = panel({ code: "AZ-104", certification: read<LearningGoal>(null, { pending: true }) });
		assert.match(testId(html, "goal-read"), / disabled=""/);
		assert.ok(html.includes(">Reading…</button>"));
		assert.match(html, /role="status"[^>]*>Reading the study guide on Microsoft Learn…</);
	});

	it("a read guide previews its size, note, outline and source, with Use this goal", () => {
		const html = panel({ code: "AZ-104", certification: read(CERT_GOAL) });
		assert.ok(html.includes('data-testid="goal-preview"'));
		assert.ok(html.includes(">Exam AZ-104: Microsoft Azure Administrator<"));
		assert.ok(html.includes(">2 areas · 3 skills<"));
		assert.ok(html.includes(">This exam will retire on June 30, 2027.<"));
		assert.ok(html.includes('role="region" aria-label="Skills measured" tabindex="0"'));
		assert.ok(html.includes("Configure access to storage"));
		assert.ok(html.includes(`<a href="${CERT_GOAL.source}" target="_blank" rel="noopener noreferrer"`));
		assert.doesNotMatch(testId(html, "goal-use"), / disabled=""/);
		const elsewhere = panel({ certification: read({ ...CERT_GOAL, source: "https://example.com/guide" }) });
		assert.ok(elsewhere.includes("https://example.com/guide"));
		assert.ok(!elsewhere.includes("<a "), "only Learn pages are links");
	});

	it("a failed read is an alert with the reason", () => {
		const error = "Microsoft Learn is off. Turn it on in Settings › Agent to read study guides.";
		const html = panel({ certification: read<LearningGoal>(null, { error }) });
		assert.ok(html.includes(`role="alert" data-testid="goal-error"`));
		assert.ok(html.includes(`>${error}</p>`));
	});

	it("the repo tab lists what the scan found, the chosen ones ticked, each with where it's used", () => {
		const html = panel({ tab: "repo", repoPath: SCAN.path, repo: read(SCAN), chosen: ["Next.js", "Node.js"] });
		assert.match(testId(html, "goal-tab-repo"), /aria-pressed="true"/);
		assert.ok(html.includes('placeholder="Full path to a folder on this computer"'));
		assert.ok(html.includes("Only the technologies you choose go to the tutor."));
		assert.ok(html.includes(">Technologies in shop</legend>"));
		assert.match(testId(html, "goal-tech-Next.js"), /checked=""/);
		assert.match(testId(html, "goal-tech-Node.js"), /checked=""/);
		assert.doesNotMatch(testId(html, "goal-tech-Zod"), /checked=""/);
		assert.ok(html.includes(">package.json +1<"), "the first place, and how many more");
		assert.ok(html.includes(">2 of 3 chosen<"));
		assert.doesNotMatch(testId(html, "goal-use"), / disabled=""/);
		assert.ok(!html.includes("read only part of it"));
	});

	it("a partial scan says so; with 12 chosen the rest are disabled; with none chosen there's no goal to use", () => {
		const technologies = Array.from(
			{ length: 13 },
			(_, i): RepoTechnology => ({ name: `Tech${i}`, category: "library", evidence: [`f${i}`], count: 1 }),
		);
		const full = panel({
			tab: "repo",
			repo: read({ ...SCAN, technologies, partial: true }),
			chosen: technologies.slice(0, GOAL_LIMITS.areas).map((t) => t.name),
		});
		assert.ok(full.includes("The folder is large, so Cairn read only part of it."));
		assert.match(testId(full, "goal-tech-Tech12"), / disabled=""/);
		assert.doesNotMatch(testId(full, "goal-tech-Tech0"), / disabled=""/);
		assert.ok(full.includes(">12 of 13 chosen, 12 at most<"));
		const none = panel({ tab: "repo", repo: read(SCAN), chosen: [] });
		assert.match(testId(none, "goal-use"), / disabled=""/);
	});

	it("a scan that found nothing names what Cairn reads", () => {
		const html = panel({ tab: "repo", repo: read({ ...SCAN, technologies: [] }) });
		assert.match(
			html,
			/data-testid="goal-repo-empty"[^>]*>Cairn found nothing it knows in shop\. It reads dependency manifests \(package\.json, requirements\.txt, /,
		);
		assert.ok(!html.includes('data-testid="goal-use"'));
	});
});

describe("the goal pill and card", () => {
	const shell = (props: Partial<ComponentProps<typeof DraftShell>>) =>
		renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} {...props} />);

	it("a teach draft shows Set a goal when NewSession wires it; never in practice or without onGoal", () => {
		const html = shell({ mode: "teach", onGoal: () => {} });
		assert.match(testId(html, "goal-chip"), /aria-haspopup="dialog"/);
		assert.match(testId(html, "goal-chip"), /aria-expanded="false"/);
		assert.ok(html.includes(">Set a goal</span>"));
		assert.ok(!html.includes('data-testid="goal-clear"'));
		assert.match(tagWith(html, 'aria-label="Send"'), / disabled=""/, "nothing to send yet");
		assert.ok(!shell({ mode: "teach" }).includes('data-testid="goal-chip"'));
		assert.ok(!shell({ mode: "practice", onGoal: () => {} }).includes('data-testid="goal-chip"'));
	});

	it("with a goal: the pill names it, Clear sits beside it, and the empty composer can send", () => {
		const html = shell({ mode: "teach", goal: CERT_GOAL, onGoal: () => {} });
		assert.match(testId(html, "goal-chip"), /aria-label="Learning goal: Exam AZ-104: Microsoft Azure Administrator"/);
		assert.match(testId(html, "goal-clear"), /aria-label="Clear the goal"/);
		assert.ok(html.includes('placeholder="Anything to focus on? Or press Enter to start."'));
		assert.doesNotMatch(tagWith(html, 'aria-label="Send"'), / disabled=""/);
	});

	it("the card starts collapsed: the goal's title and size, the outline hidden", () => {
		const html = renderToStaticMarkup(<GoalContextCard data={CERT_GOAL} />);
		assert.match(testId(html, "goal-context-toggle"), /aria-expanded="false"/);
		assert.ok(html.includes(">Learning goal<"));
		assert.ok(html.includes(">Exam AZ-104: Microsoft Azure Administrator · 2 areas · 3 skills<"));
		assert.ok(!html.includes('data-testid="goal-context-body"'));
		assert.equal(goalSummary(REPO_GOAL), "2 technologies");
		assert.equal(goalSummary({ ...REPO_GOAL, areas: REPO_GOAL.areas.slice(0, 1) }), "1 technology");
	});
});
