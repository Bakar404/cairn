import type { AnimationBeat, MediaRef } from "./contracts.ts";

/**
 * The Manim renderer PORT (M13). Manim Community Edition runs inside a
 * pinned Docker image, so a learner's machine needs Docker and nothing
 * else — no Python, LaTeX, or ffmpeg. The adapter (src/server/manim.ts)
 * drives the docker CLI; a hosted copy runs the same image as an Azure
 * Container Apps job instead (src/server/manim-azure.ts); tests inject a
 * fake. Browser-safe: types and pure helpers only (the Settings panel
 * reads ManimStatus).
 */

/** The compressed image download, for the Settings panel's wording. */
export const MANIM_DOWNLOAD_SIZE = "about 500 MB";

/** The pinned image (published for amd64 and arm64). Scenes are written
 *  against this version's API — bump it deliberately, never float. */
export const MANIM_IMAGE = "manimcommunity/manim:v0.22.0";

/** The longest animation the maker may deliver, in seconds. */
export const MANIM_MAX_SECONDS = 60;

/** How long one render may run before it is stopped, by mode. */
export const MANIM_RENDER_TIMEOUT_MS: Readonly<Record<ManimRenderMode, number>> = {
	preview: 120_000,
	final: 300_000,
	still: 120_000,
};

/** The most a render may return (the runner's framed output), in bytes. */
export const MANIM_MAX_OUTPUT_BYTES = 96 * 1024 * 1024;

export type ManimState =
	/** The docker CLI is not installed. */
	| "no-docker"
	/** The CLI is there but the Docker engine is not running. */
	| "docker-stopped"
	/** Docker runs; the Manim image has not been pulled yet. */
	| "not-installed"
	/** `docker pull` is in progress. */
	| "installing"
	/** The last pull failed — `reason` says why. */
	| "install-failed"
	/** A hosted renderer (an Azure Container Apps job) can't be reached or
	 *  isn't set up; `reason` says why. There is nothing to install. */
	| "unavailable"
	| "ready";

export interface ManimStatus {
	state: ManimState;
	/** One plain sentence for the Settings panel. */
	reason: string;
	image: string;
	/** Pull progress while installing, e.g. "4 of 11 layers". */
	progress?: string;
}

export type ManimRenderMode = "preview" | "final" | "still";

export interface ManimRenderRequest {
	chatId: string;
	jobId: string;
	/** The complete scene file (Python). It must define `class Lesson`. */
	code: string;
	/** preview: low quality plus a contact sheet of the moments the scene
	 *  settles into, nothing saved;
	 *  final: medium-quality MP4 plus its poster, saved to the chat's media;
	 *  still: one high-quality PNG of the last frame, saved to the media. */
	mode: ManimRenderMode;
	abortSignal?: AbortSignal;
}

export interface ManimRenderResult {
	ok: boolean;
	/** The scene error or timeout, worded so the maker can fix it. */
	error?: string;
	/** preview: the contact sheet; still: the still itself (to look at). */
	pngBase64?: string;
	video?: MediaRef;
	poster?: MediaRef;
	still?: MediaRef;
	durationSec?: number;
	/** preview and still: layout problems the renderer measured (text
	 *  spilling out of its box, overlapping, cut off, too small…), worded
	 *  so the maker can fix them. Absent when there are none. */
	issues?: string[];
}

export interface ManimRenderer {
	/** Synchronous and cached: true when the last status check said ready. */
	ready(): boolean;
	/** Probe the renderer: Docker and the image, or the Azure job. Cached
	 *  for about 30 s; `fresh` skips the cache (the Settings panel's
	 *  "Check again"). */
	status(fresh?: boolean): Promise<ManimStatus>;
	/** Start pulling the image in the background. Idempotent. A hosted
	 *  renderer has nothing to pull and just checks again. */
	install(): Promise<ManimStatus>;
	/** Render one scene. Scene errors and timeouts resolve with ok: false;
	 *  it throws only when abortSignal fires. */
	render(req: ManimRenderRequest): Promise<ManimRenderResult>;
	/** Save an animation's descriptions track (WebVTT, from
	 *  descriptionsVtt) as `<jobId>.vtt` in the chat's media. Throws on a
	 *  bad id or a failed write. */
	saveDescriptions(chatId: string, jobId: string, vtt: string): MediaRef;
}

/** The media names a job may write: `<jobId>.mp4`, `<jobId>-poster.png`,
 *  `<jobId>.png`, `<jobId>.vtt`. The media route serves nothing else. */
export const MEDIA_FILE_RE = /^[A-Za-z0-9_-]{1,120}\.(?:png|mp4|vtt)$/;

/** Where the browser fetches a chat's media file. */
export function mediaUrl(chatId: string, file: string): string {
	return `/api/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(file)}`;
}

// ─── Animation descriptions (M27) ──────────────────────────────────────────

/** An animation's beats made safe to show: text with its whitespace
 *  collapsed (empty ones dropped), times rounded to the millisecond and
 *  clamped to [0, durationSec], in time order (ties keep their order). */
export function cleanBeats(beats: readonly AnimationBeat[], durationSec?: number): AnimationBeat[] {
	const end = typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
	const out: AnimationBeat[] = [];
	for (const beat of beats) {
		if (!beat || typeof beat.atSec !== "number" || !Number.isFinite(beat.atSec) || typeof beat.text !== "string") continue;
		const text = beat.text.replace(/\s+/g, " ").trim();
		if (!text) continue;
		out.push({ atSec: Math.round(Math.min(Math.max(beat.atSec, 0), end) * 1000) / 1000, text });
	}
	return out.sort((a, b) => a.atSec - b.atSec);
}

function vttTime(sec: number): string {
	const ms = Math.round(sec * 1000);
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

function vttText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The beats as a WebVTT descriptions track, or null when there is
 *  nothing to write (no beats, or no positive duration). Cue i runs from
 *  beat i to beat i+1 and the last to the end. Beats at the same moment
 *  share a cue; a beat at the very end joins the cue before it (or, alone,
 *  gets the last second). Pure. */
export function descriptionsVtt(beats: readonly AnimationBeat[], durationSec: number): string | null {
	if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
	const end = Math.round(durationSec * 1000) / 1000;
	const cues: Array<{ start: number; texts: string[] }> = [];
	for (const beat of cleanBeats(beats, end)) {
		const last = cues[cues.length - 1];
		if (last && (beat.atSec === last.start || beat.atSec >= end)) last.texts.push(beat.text);
		else cues.push({ start: beat.atSec >= end ? Math.max(0, end - 1) : beat.atSec, texts: [beat.text] });
	}
	if (cues.length === 0) return null;
	const blocks = cues.map((cue, i) => {
		const stop = cues[i + 1]?.start ?? end;
		return `${vttTime(cue.start)} --> ${vttTime(stop)}\n${vttText(cue.texts.join(" "))}`;
	});
	return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

/** A beat's time as the transcript shows it: m:ss, to the nearest second. */
export function beatTime(atSec: number): string {
	const total = Math.max(0, Math.round(atSec));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
