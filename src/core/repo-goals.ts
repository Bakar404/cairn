import { GOAL_LIMITS, parseLearningGoal, type LearningGoal } from "./learning-goals.ts";

/**
 * REPO GOALS (M21): the technologies a local repository is built with, read
 * from its dependency manifests (package.json, requirements.txt,
 * pyproject.toml, .csproj, go.mod, Cargo.toml, pom.xml, build.gradle,
 * Gemfile, composer.json) and a few telling files (a Dockerfile, GitHub
 * Actions workflows, Bicep and Terraform files). The Goals picker lists them
 * for the learner to tick; the ticked ones become a repo goal, one area per
 * technology, whose items say where the repository uses it.
 *
 * Pure and browser-safe: the server walks the folder
 * (src/server/learning-goals.ts) and hands the files here. Dependencies
 * Cairn doesn't know are left out; the language a manifest implies is
 * always listed.
 */

/** A file the scan kept: a manifest with its text, or a signal file by path alone. */
export interface RepoFile {
	/** Relative to the repository, "/"-separated. */
	path: string;
	/** A manifest's text; absent for signal files. */
	content?: string;
}

/** What kind of technology it is; the list sorts by this first. */
export type RepoTechnologyCategory = "framework" | "language" | "infrastructure" | "library" | "tool";

const CATEGORY_ORDER: readonly RepoTechnologyCategory[] = ["framework", "language", "infrastructure", "library", "tool"];

export const REPO_CATEGORY_LABELS: Record<RepoTechnologyCategory, string> = {
	framework: "Framework",
	language: "Language",
	infrastructure: "Infrastructure",
	library: "Library",
	tool: "Tool",
};

export interface RepoTechnology {
	name: string;
	category: RepoTechnologyCategory;
	/** Where the repository uses it, at most GOAL_LIMITS.items:
	 *  "package.json: next 16.0.1", ".github/workflows/ci.yml". */
	evidence: string[];
	/** How many places in all, before the cap. */
	count: number;
}

/** The repository scan's answer (POST /api/goals/repo). */
export interface RepoScan {
	/** The repository folder, absolute. */
	path: string;
	/** The folder's name. */
	name: string;
	technologies: RepoTechnology[];
	/** The manifests read, relative. */
	manifests: string[];
	/** True when a bound cut the read short: time, the entry or file counts,
	 *  or a manifest too large to read. */
	partial: boolean;
}

/** How many technologies the picker ticks for the learner to start from. */
export const REPO_PROPOSAL_SIZE = 5;

/** The manifests the scan reads, as the picker names them. */
export const REPO_MANIFESTS: readonly string[] = [
	"package.json",
	"requirements.txt",
	"pyproject.toml",
	"Pipfile",
	".csproj",
	"go.mod",
	"Cargo.toml",
	"pom.xml",
	"build.gradle",
	"Gemfile",
	"composer.json",
];

// ─── Which files matter ──────────────────────────────────────────────────

type ManifestKind = "npm" | "requirements" | "pyproject" | "pipfile" | "dotnet" | "go" | "cargo" | "maven" | "gradle" | "gemfile" | "composer";

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function manifestKind(path: string): ManifestKind | null {
	const base = basename(path).toLowerCase();
	if (base === "package.json") return "npm";
	if (/^requirements(?:[-_.][\w.-]+)?\.txt$/.test(base)) return "requirements";
	if (base === "pyproject.toml") return "pyproject";
	if (base === "pipfile") return "pipfile";
	if (/\.(?:cs|fs|vb)proj$/.test(base)) return "dotnet";
	if (base === "go.mod") return "go";
	if (base === "cargo.toml") return "cargo";
	if (base === "pom.xml") return "maven";
	if (base === "build.gradle" || base === "build.gradle.kts") return "gradle";
	if (base === "gemfile") return "gemfile";
	if (base === "composer.json") return "composer";
	return null;
}

interface Signal {
	name: string;
	category: RepoTechnologyCategory;
	test: (path: string, base: string) => boolean;
}

/** Files whose presence says enough; their contents are never read. */
const SIGNALS: readonly Signal[] = [
	{ name: "Docker", category: "infrastructure", test: (_, b) => b === "dockerfile" || b.startsWith("dockerfile.") || b.endsWith(".dockerfile") },
	{ name: "Docker", category: "infrastructure", test: (_, b) => /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(b) },
	{ name: "GitHub Actions", category: "infrastructure", test: (p) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(p) },
	{ name: "Bicep", category: "infrastructure", test: (_, b) => b.endsWith(".bicep") },
	{ name: "Terraform", category: "infrastructure", test: (_, b) => b.endsWith(".tf") },
	{ name: "Azure Developer CLI", category: "infrastructure", test: (_, b) => b === "azure.yaml" || b === "azure.yml" },
	{ name: "Helm", category: "infrastructure", test: (_, b) => b === "chart.yaml" },
	{ name: "Dev Containers", category: "tool", test: (p, b) => b === ".devcontainer.json" || /(?:^|\/)\.devcontainer\/(?:[^/]+\/)?devcontainer\.json$/i.test(p) },
	{ name: "TypeScript", category: "language", test: (_, b) => b === "tsconfig.json" },
	{ name: "Jupyter", category: "tool", test: (_, b) => b.endsWith(".ipynb") },
];

/** What the server keeps while it walks: manifests are read, signals are listed. */
export function repoFileRole(path: string): "manifest" | "signal" | null {
	if (manifestKind(path)) return "manifest";
	const base = basename(path).toLowerCase();
	return SIGNALS.some((signal) => signal.test(path, base)) ? "signal" : null;
}

// ─── Dependency names → technologies ─────────────────────────────────────

/** [dependency name (exact, lowercase) or pattern, technology, category]. First match wins. */
type Rule = readonly [string | RegExp, string, RepoTechnologyCategory];

const NPM: readonly Rule[] = [
	["next", "Next.js", "framework"],
	[/^react(?:-dom)?$/, "React", "framework"],
	["react-native", "React Native", "framework"],
	["vue", "Vue", "framework"],
	["nuxt", "Nuxt", "framework"],
	["@angular/core", "Angular", "framework"],
	[/^(?:svelte|@sveltejs\/kit)$/, "Svelte", "framework"],
	["express", "Express", "framework"],
	["fastify", "Fastify", "framework"],
	["@nestjs/core", "NestJS", "framework"],
	["electron", "Electron", "framework"],
	["@azure/functions", "Azure Functions", "framework"],
	["botbuilder", "Bot Framework", "framework"],
	["@microsoft/teams-js", "Microsoft Teams apps", "framework"],
	["typescript", "TypeScript", "language"],
	[/^@azure\/msal-/, "Microsoft identity platform (MSAL)", "library"],
	[/^@azure\//, "Azure SDK", "library"],
	[/^@microsoft\/(?:microsoft-graph-client|msgraph-sdk)/, "Microsoft Graph", "library"],
	[/^@fluentui\//, "Fluent UI", "library"],
	["@github/copilot-sdk", "GitHub Copilot SDK", "library"],
	["@modelcontextprotocol/sdk", "Model Context Protocol", "library"],
	["openai", "OpenAI API", "library"],
	[/^(?:langchain|@langchain\/)/, "LangChain", "library"],
	[/^(?:prisma|@prisma\/client)$/, "Prisma", "library"],
	["drizzle-orm", "Drizzle ORM", "library"],
	[/^(?:mongoose|mongodb)$/, "MongoDB", "library"],
	[/^(?:pg|postgres)$/, "PostgreSQL", "library"],
	[/^mysql2?$/, "MySQL", "library"],
	[/^(?:redis|ioredis)$/, "Redis", "library"],
	[/^(?:graphql|@apollo\/(?:server|client))$/, "GraphQL", "library"],
	["socket.io", "Socket.IO", "library"],
	["three", "three.js", "library"],
	["d3", "D3", "library"],
	["zod", "Zod", "library"],
	["@tanstack/react-query", "TanStack Query", "library"],
	[/^(?:redux|@reduxjs\/toolkit)$/, "Redux", "library"],
	[/^@radix-ui\//, "Radix UI", "library"],
	["tailwindcss", "Tailwind CSS", "library"],
	["vite", "Vite", "tool"],
	["webpack", "webpack", "tool"],
	["jest", "Jest", "tool"],
	["vitest", "Vitest", "tool"],
	["mocha", "Mocha", "tool"],
	[/^(?:@playwright\/test|playwright)$/, "Playwright", "tool"],
	["cypress", "Cypress", "tool"],
	["eslint", "ESLint", "tool"],
	[/^(?:storybook|@storybook\/)/, "Storybook", "tool"],
];

/** Matched against the normalized name (PEP 503: lowercase, runs of "-_." → "-"). */
const PYTHON: readonly Rule[] = [
	["django", "Django", "framework"],
	["flask", "Flask", "framework"],
	["fastapi", "FastAPI", "framework"],
	["streamlit", "Streamlit", "framework"],
	["azure-functions", "Azure Functions", "framework"],
	[/^azure-/, "Azure SDK", "library"],
	["semantic-kernel", "Semantic Kernel", "library"],
	["numpy", "NumPy", "library"],
	["pandas", "pandas", "library"],
	[/^(?:scikit-learn|sklearn)$/, "scikit-learn", "library"],
	["torch", "PyTorch", "library"],
	[/^tensorflow(?:-cpu|-gpu)?$/, "TensorFlow", "library"],
	["matplotlib", "Matplotlib", "library"],
	["transformers", "Hugging Face Transformers", "library"],
	["openai", "OpenAI API", "library"],
	[/^langchain/, "LangChain", "library"],
	["sqlalchemy", "SQLAlchemy", "library"],
	["pydantic", "Pydantic", "library"],
	["celery", "Celery", "library"],
	["boto3", "AWS SDK for Python (Boto3)", "library"],
	["manim", "Manim", "library"],
	[/^(?:jupyter|jupyterlab|notebook|ipykernel)$/, "Jupyter", "tool"],
	["pytest", "pytest", "tool"],
];

/** Matched against the lowercase NuGet package id. */
const DOTNET: readonly Rule[] = [
	[/^microsoft\.aspnetcore\.components\.webassembly/, "Blazor", "framework"],
	[/^microsoft\.aspnetcore\./, "ASP.NET Core", "framework"],
	[/^microsoft\.maui\./, ".NET MAUI", "framework"],
	[/^(?:microsoft\.azure\.functions\.worker|microsoft\.net\.sdk\.functions$)/, "Azure Functions", "framework"],
	[/^microsoft\.entityframeworkcore/, "Entity Framework Core", "library"],
	[/^microsoft\.semantickernel/, "Semantic Kernel", "library"],
	[/^microsoft\.graph(?:\.|$)/, "Microsoft Graph", "library"],
	[/^microsoft\.identity\./, "Microsoft identity platform (MSAL)", "library"],
	[/^azure\./, "Azure SDK", "library"],
	[/^xunit/, "xUnit", "tool"],
	[/^nunit/, "NUnit", "tool"],
	[/^mstest\./, "MSTest", "tool"],
];

/** Matched against the lowercase module path. */
const GO: readonly Rule[] = [
	["github.com/gin-gonic/gin", "Gin", "framework"],
	[/^github\.com\/labstack\/echo/, "Echo", "framework"],
	[/^github\.com\/gofiber\/fiber/, "Fiber", "framework"],
	["github.com/spf13/cobra", "Cobra", "library"],
	["google.golang.org/grpc", "gRPC", "library"],
	[/^github\.com\/azure\/azure-sdk-for-go/, "Azure SDK", "library"],
	["gorm.io/gorm", "GORM", "library"],
	["k8s.io/client-go", "Kubernetes", "infrastructure"],
];

const RUST: readonly Rule[] = [
	["actix-web", "Actix Web", "framework"],
	["axum", "Axum", "framework"],
	["rocket", "Rocket", "framework"],
	["tauri", "Tauri", "framework"],
	["bevy", "Bevy", "framework"],
	["tokio", "Tokio", "library"],
	["serde", "Serde", "library"],
	["clap", "clap", "library"],
	["wasm-bindgen", "WebAssembly", "library"],
	[/^azure_/, "Azure SDK", "library"],
];

/** Matched against "group:artifact", lowercase. */
const JVM: readonly Rule[] = [
	[/^org\.springframework\.boot(?::|$)/, "Spring Boot", "framework"],
	[/^io\.quarkus(?::|$)/, "Quarkus", "framework"],
	[/^com\.microsoft\.azure\.functions:/, "Azure Functions", "framework"],
	[/^org\.hibernate/, "Hibernate", "library"],
	[/^com\.azure:/, "Azure SDK", "library"],
	[/^(?:junit:junit|org\.junit)/, "JUnit", "tool"],
];

const RUBY: readonly Rule[] = [
	["rails", "Ruby on Rails", "framework"],
	["sinatra", "Sinatra", "framework"],
	[/^rspec/, "RSpec", "tool"],
];

const PHP: readonly Rule[] = [
	["laravel/framework", "Laravel", "framework"],
	[/^symfony\//, "Symfony", "framework"],
	["phpunit/phpunit", "PHPUnit", "tool"],
];

function matchRule(rules: readonly Rule[], name: string): Rule | null {
	for (const rule of rules) {
		const [pattern] = rule;
		if (typeof pattern === "string" ? pattern === name : pattern.test(name)) return rule;
	}
	return null;
}

// ─── Manifest readers ────────────────────────────────────────────────────

type Add = (name: string, category: RepoTechnologyCategory, file: string, evidence: string) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const evidenceLine = (path: string, name: string, version?: string): string =>
	`${path}: ${name}${version?.trim() ? ` ${version.trim()}` : ""}`;

function addDependency(rules: readonly Rule[], add: Add, path: string, key: string, shown: string, version?: string) {
	const rule = matchRule(rules, key);
	if (rule) add(rule[1], rule[2], path, evidenceLine(path, shown, version));
}

function parseJson(content: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(content);
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function readNpm(path: string, content: string, add: Add) {
	add("Node.js", "language", path, path);
	const manifest = parseJson(content);
	if (!manifest) return;
	for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		const deps = manifest[field];
		if (!isRecord(deps)) continue;
		for (const [name, version] of Object.entries(deps)) {
			addDependency(NPM, add, path, name.toLowerCase(), name, typeof version === "string" ? version : undefined);
		}
	}
}

const normalizePython = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

/** One requirement ("fastapi[all]>=0.110 ; python_version>'3.8'") → its name and version spec. */
function pythonRequirement(line: string): { name: string; spec: string } | null {
	const text = line.replace(/\s+#.*$/, "").split(";")[0]!.trim();
	if (!text || text.startsWith("#") || text.startsWith("-")) return null;
	const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(text);
	if (!match) return null;
	return { name: match[1]!, spec: match[2]!.trim() };
}

function addPython(path: string, requirement: string, add: Add) {
	const parsed = pythonRequirement(requirement);
	if (parsed) addDependency(PYTHON, add, path, normalizePython(parsed.name), parsed.name, parsed.spec);
}

function readRequirements(path: string, content: string, add: Add) {
	add("Python", "language", path, path);
	for (const line of content.split("\n")) addPython(path, line, add);
}

/** The quoted strings of a TOML array that may span lines, starting at lines[from]. */
function tomlArray(lines: readonly string[], from: number): { values: string[]; end: number } {
	const values: string[] = [];
	let index = from;
	let text = lines[from]!.slice(lines[from]!.indexOf("[") + 1);
	for (;;) {
		const close = text.indexOf("]");
		const part = close >= 0 ? text.slice(0, close) : text;
		for (const match of part.matchAll(/"([^"]*)"|'([^']*)'/g)) values.push(match[1] ?? match[2] ?? "");
		if (close >= 0 || index + 1 >= lines.length) return { values, end: index };
		index += 1;
		text = lines[index]!;
	}
}

/** pyproject.toml (PEP 621 and Poetry) and Pipfile: the dependency names only. */
function readPythonToml(path: string, content: string, add: Add) {
	add("Python", "language", path, path);
	const lines = content.split("\n");
	let table = "";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.trim();
		const header = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
		if (header) {
			table = header[1]!.trim().toLowerCase();
			continue;
		}
		const key = /^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.*)$/.exec(line);
		if (!key) continue;
		const name = key[1]!.replace(/^"|"$/g, "");
		const value = key[2]!;
		const isArray = value.startsWith("[");
		if (
			isArray &&
			((table === "project" && name === "dependencies") || table === "project.optional-dependencies" || table === "dependency-groups")
		) {
			const array = tomlArray(lines, index);
			for (const requirement of array.values) addPython(path, requirement, add);
			index = array.end;
			continue;
		}
		const poetry = /^tool\.poetry\.(?:group\.[^.]+\.)?(?:dev-)?dependencies$/.test(table);
		const pipfile = table === "packages" || table === "dev-packages";
		if ((poetry || pipfile) && name.toLowerCase() !== "python") {
			const version = /^"([^"]*)"/.exec(value)?.[1] ?? /version\s*=\s*"([^"]*)"/.exec(value)?.[1];
			addDependency(PYTHON, add, path, normalizePython(name), name, version === "*" ? undefined : version);
		}
	}
}

const xmlText = (block: string, tag: string): string => new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, "i").exec(block)?.[1] ?? "";

function readDotnet(path: string, content: string, add: Add) {
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	add(extension === "fsproj" ? "F#" : extension === "vbproj" ? "Visual Basic" : "C#", "language", path, path);
	const frameworks = (xmlText(content, "TargetFrameworks") || xmlText(content, "TargetFramework")).split(";").map((t) => t.trim()).filter(Boolean);
	add(".NET", "language", path, frameworks.length > 0 ? evidenceLine(path, frameworks.join(", ")) : path);
	const sdk = /<Project\b[^>]*\bSdk\s*=\s*"([^"]+)"/i.exec(content)?.[1] ?? "";
	if (/^microsoft\.net\.sdk\.web$/i.test(sdk)) add("ASP.NET Core", "framework", path, evidenceLine(path, sdk));
	if (/^microsoft\.net\.sdk\.blazorwebassembly$/i.test(sdk)) add("Blazor", "framework", path, evidenceLine(path, sdk));
	if (/^true$/i.test(xmlText(content, "UseMaui"))) add(".NET MAUI", "framework", path, evidenceLine(path, "UseMaui"));
	if (/^true$/i.test(xmlText(content, "UseWPF"))) add("WPF", "framework", path, evidenceLine(path, "UseWPF"));
	if (/^true$/i.test(xmlText(content, "UseWindowsForms"))) add("Windows Forms", "framework", path, evidenceLine(path, "UseWindowsForms"));
	for (const tag of content.matchAll(/<PackageReference\b([^>]*)>/gi)) {
		const attributes = new Map<string, string>();
		for (const attribute of tag[1]!.matchAll(/\b(Include|Update|Version)\s*=\s*"([^"]*)"/gi)) {
			attributes.set(attribute[1]!.toLowerCase(), attribute[2]!);
		}
		const id = attributes.get("include") ?? attributes.get("update");
		if (id) addDependency(DOTNET, add, path, id.toLowerCase(), id, attributes.get("version"));
	}
}

function readGoMod(path: string, content: string, add: Add) {
	const version = /^go\s+(\d[\w.]*)\s*$/m.exec(content)?.[1];
	add("Go", "language", path, version ? evidenceLine(path, "go", version) : path);
	let inBlock = false;
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (inBlock && line.startsWith(")")) {
			inBlock = false;
			continue;
		}
		if (/^require\s*\($/.test(line)) {
			inBlock = true;
			continue;
		}
		const requirement = inBlock ? line : /^require\s+(.+)$/.exec(line)?.[1];
		if (!requirement || requirement.includes("// indirect")) continue;
		const [module, moduleVersion] = requirement.split(/\s+/);
		if (module) addDependency(GO, add, path, module.toLowerCase(), module, moduleVersion);
	}
}

function readCargo(path: string, content: string, add: Add) {
	add("Rust", "language", path, path);
	let table = "";
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		const header = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
		if (header) {
			table = header[1]!.trim().toLowerCase();
			// [dependencies.serde]: the crate is the header's last part.
			const crate = /^(?:.*\.)?(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(table)?.[1];
			if (crate) addDependency(RUST, add, path, crate, crate);
			continue;
		}
		if (!/(?:^|\.)(?:dev-|build-)?dependencies$/.test(table)) continue;
		const key = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
		if (!key) continue;
		const value = key[2]!;
		const version = /^"([^"]*)"/.exec(value)?.[1] ?? /version\s*=\s*"([^"]*)"/.exec(value)?.[1];
		addDependency(RUST, add, path, key[1]!.toLowerCase(), key[1]!, version);
	}
}

function readMaven(path: string, content: string, add: Add) {
	add("Java", "language", path, path);
	for (const block of content.matchAll(/<(dependency|parent|plugin)>([\s\S]*?)<\/\1>/gi)) {
		const group = xmlText(block[2]!, "groupId");
		const artifact = xmlText(block[2]!, "artifactId");
		if (!artifact) continue;
		const id = group ? `${group}:${artifact}` : artifact;
		addDependency(JVM, add, path, id.toLowerCase(), id, xmlText(block[2]!, "version"));
	}
}

function readGradle(path: string, content: string, add: Add) {
	add("Java", "language", path, path);
	if (/\bkotlin\s*\(\s*["']jvm["']\s*\)|org\.jetbrains\.kotlin/.test(content)) add("Kotlin", "language", path, path);
	const configurations = "implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt";
	const dependency = new RegExp(`\\b(?:${configurations})\\s*\\(?\\s*["']([\\w.-]+):([\\w.-]+)(?::([^"']+))?["']`, "g");
	for (const match of content.matchAll(dependency)) {
		const id = `${match[1]}:${match[2]}`;
		addDependency(JVM, add, path, id.toLowerCase(), id, match[3]);
	}
	for (const match of content.matchAll(/\bid\s*\(?\s*["']([\w.-]+)["']/g)) {
		addDependency(JVM, add, path, match[1]!.toLowerCase(), match[1]!);
	}
}

function readGemfile(path: string, content: string, add: Add) {
	add("Ruby", "language", path, path);
	for (const match of content.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) {
		addDependency(RUBY, add, path, match[1]!.toLowerCase(), match[1]!, match[2]);
	}
}

function readComposer(path: string, content: string, add: Add) {
	const manifest = parseJson(content);
	const php = isRecord(manifest?.require) ? manifest.require.php : undefined;
	add("PHP", "language", path, typeof php === "string" ? evidenceLine(path, "php", php) : path);
	if (!manifest) return;
	for (const field of ["require", "require-dev"]) {
		const deps = manifest[field];
		if (!isRecord(deps)) continue;
		for (const [name, version] of Object.entries(deps)) {
			addDependency(PHP, add, path, name.toLowerCase(), name, typeof version === "string" ? version : undefined);
		}
	}
}

const READERS: Record<ManifestKind, (path: string, content: string, add: Add) => void> = {
	npm: readNpm,
	requirements: readRequirements,
	pyproject: readPythonToml,
	pipfile: readPythonToml,
	dotnet: readDotnet,
	go: readGoMod,
	cargo: readCargo,
	maven: readMaven,
	gradle: readGradle,
	gemfile: readGemfile,
	composer: readComposer,
};

// ─── The scan's result ───────────────────────────────────────────────────

/**
 * The technologies a repository's files show, sorted: frameworks, then
 * languages, infrastructure, libraries and tools; within each, the ones
 * used in more files first, then by name. Each lists where the repository
 * uses it, at most GOAL_LIMITS.items places.
 */
export function detectRepoTechnologies(files: readonly RepoFile[]): RepoTechnology[] {
	const found = new Map<string, { category: RepoTechnologyCategory; evidence: string[]; files: Set<string> }>();
	const add: Add = (name, category, file, evidence) => {
		const entry = found.get(name) ?? { category, evidence: [], files: new Set<string>() };
		found.set(name, entry);
		entry.files.add(file);
		if (!entry.evidence.includes(evidence)) entry.evidence.push(evidence);
	};
	for (const file of files) {
		const path = file.path.replace(/\\/g, "/").replace(/^\.?\//, "");
		const kind = manifestKind(path);
		if (kind) {
			READERS[kind](path, (file.content ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"), add);
			continue;
		}
		const base = basename(path).toLowerCase();
		for (const signal of SIGNALS) {
			if (signal.test(path, base)) add(signal.name, signal.category, path, path);
		}
	}
	return [...found.entries()]
		.sort(
			([nameA, a], [nameB, b]) =>
				CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
				b.files.size - a.files.size ||
				nameA.localeCompare(nameB),
		)
		.map(([name, entry]) => ({
			name,
			category: entry.category,
			evidence: entry.evidence.slice(0, GOAL_LIMITS.items),
			count: entry.evidence.length,
		}));
}

/** The names the picker ticks to start from: the first few frameworks, languages and infrastructure. */
export function proposedTechnologies(technologies: readonly RepoTechnology[]): string[] {
	return technologies
		.filter((t) => t.category === "framework" || t.category === "language" || t.category === "infrastructure")
		.slice(0, REPO_PROPOSAL_SIZE)
		.map((t) => t.name);
}

/** The repo goal for the chosen technologies (at most GOAL_LIMITS.areas), or null when none is chosen. */
export function repoGoal(scan: Pick<RepoScan, "path" | "name">, chosen: readonly RepoTechnology[]): LearningGoal | null {
	return parseLearningGoal({
		kind: "repo",
		title: `The stack of ${scan.name}`,
		source: scan.path,
		areas: chosen.map((technology) => ({
			name: technology.name,
			groups: [{ name: "Where this repository uses it", items: technology.evidence }],
		})),
	});
}
