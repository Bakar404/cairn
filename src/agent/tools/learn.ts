import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { isLearnUrl, type LearnDocsClient } from "../../core/learn-docs.ts";

/**
 * The researcher's Microsoft Learn tools (M21) — official Microsoft
 * documentation through the injected LearnDocsClient port (the live adapter
 * is src/server/learn-docs.ts; import law: tools see the core port only):
 *
 *   learn_search(query, count?)          → [{title, url, excerpt}]
 *   learn_fetch(url)                     → the page as markdown
 *   learn_code_samples(query, language?) → [{description, language, url, code}]
 *
 * Same contract as web.ts: never throw into the agent loop — a missing
 * client and every failure return a clear error STRING the researcher can
 * adapt to.
 */

/** Same budget as web_fetch: long pages truncate with a marker. */
const MAX_CONTENT_CHARS = 40_000;
const EXCERPT_CHARS = 1_500;
const SAMPLE_CHARS = 3_000;
const MAX_SAMPLES = 6;

const UNAVAILABLE =
	"Microsoft Learn is not available: it's switched off in Settings › Agent. Use web_search and web_fetch instead.";

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function truncate(text: string): string {
	if (text.length <= MAX_CONTENT_CHARS) return text;
	return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[Truncated at ${MAX_CONTENT_CHARS} characters]`;
}

function failure(tool: string, err: unknown): string {
	return `${tool} failed: ${err instanceof Error ? err.message : String(err)}`;
}

const learnSearchInput = Type.Object({
	query: Type.String({ description: "What to look up in Microsoft's documentation" }),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Number of results (default 5, max 10)" }),
	),
});

const learnFetchInput = Type.Object({
	url: Type.String({ description: "A learn.microsoft.com page URL, e.g. one learn_search returned" }),
});

const learnCodeSamplesInput = Type.Object({
	query: Type.String({ description: "What the code should do, e.g. \"upload a blob to Azure Storage\"" }),
	language: Type.Optional(
		Type.String({ description: "Optional language filter, e.g. csharp, python, javascript, typescript, powershell, bicep" }),
	),
});

export function createLearnTools(learn: () => LearnDocsClient | null): Record<string, AgentTool<any>> {
	return {
		learn_search: {
			name: "learn_search",
			label: "learn_search",
			description:
				"Search Microsoft Learn, Microsoft's official documentation. Returns excerpts with their " +
				"page title and url; read a whole page with learn_fetch.",
			parameters: learnSearchInput,
			execute: serverExecute("learn_search", learnSearchInput, async ({ query, count }, { signal }) => {
				const client = learn();
				if (!client) return UNAVAILABLE;
				try {
					const hits = await client.search(query, signal);
					if (hits.length === 0) return `learn_search found nothing for "${query}". Try other words, or web_search.`;
					return hits
						.slice(0, count ?? 5)
						.map((hit) => ({ title: hit.title, url: hit.url, excerpt: clip(hit.content, EXCERPT_CHARS) }));
				} catch (err) {
					return failure("learn_search", err);
				}
			}),
		},

		learn_fetch: {
			name: "learn_fetch",
			label: "learn_fetch",
			description:
				"Read a whole Microsoft Learn page (learn.microsoft.com) as markdown. Other sites: use web_fetch.",
			parameters: learnFetchInput,
			execute: serverExecute("learn_fetch", learnFetchInput, async ({ url }, { signal }) => {
				if (!isLearnUrl(url)) return `learn_fetch reads learn.microsoft.com pages only. Use web_fetch for ${url}`;
				const client = learn();
				if (!client) return UNAVAILABLE;
				try {
					const page = await client.fetch(url, signal);
					if (!page.trim()) return `learn_fetch found no content at ${url}`;
					return `Source: ${url}\n\n---\n\n${truncate(page)}`;
				} catch (err) {
					return failure("learn_fetch", err);
				}
			}),
		},

		learn_code_samples: {
			name: "learn_code_samples",
			label: "learn_code_samples",
			description:
				"Find official code samples in Microsoft Learn for a task, optionally in one language. " +
				"Returns each sample with its description, language and source url.",
			parameters: learnCodeSamplesInput,
			execute: serverExecute("learn_code_samples", learnCodeSamplesInput, async ({ query, language }, { signal }) => {
				const client = learn();
				if (!client) return UNAVAILABLE;
				try {
					const samples = await client.codeSamples(query, language?.trim() || undefined, signal);
					if (samples.length === 0) return `learn_code_samples found nothing for "${query}".`;
					return samples.slice(0, MAX_SAMPLES).map((sample) => ({
						description: clip(sample.description, EXCERPT_CHARS),
						...(sample.language ? { language: sample.language } : {}),
						url: sample.url,
						code: clip(sample.code, SAMPLE_CHARS),
					}));
				} catch (err) {
					return failure("learn_code_samples", err);
				}
			}),
		},
	};
}
