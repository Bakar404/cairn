import type { MediaRef } from "./contracts.ts";

/**
 * The Manim renderer PORT (M13). Manim Community Edition runs inside a
 * pinned Docker image, so a learner's machine needs Docker and nothing
 * else — no Python, LaTeX, or ffmpeg. The adapter (src/server/manim.ts)
 * drives the docker CLI; tests inject a fake. Browser-safe: types and
 * pure helpers only (the Settings panel reads ManimStatus).
 */

/** The compressed image download, for the Settings panel's wording. */
export const MANIM_DOWNLOAD_SIZE = "about 500 MB";

/** The pinned image (published for amd64 and arm64). Scenes are written
 *  against this version's API — bump it deliberately, never float. */
export const MANIM_IMAGE = "manimcommunity/manim:v0.22.0";

/** The longest animation the maker may deliver, in seconds. */
export const MANIM_MAX_SECONDS = 60;

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
	/** preview: low quality plus a six-frame contact sheet, nothing saved;
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
}

export interface ManimRenderer {
	/** Synchronous and cached: true when the last status check said ready. */
	ready(): boolean;
	/** Probe Docker and the image (cached for about 30 s; `fresh` skips
	 *  the cache — the Settings panel's "Check again"). */
	status(fresh?: boolean): Promise<ManimStatus>;
	/** Start pulling the image in the background. Idempotent. */
	install(): Promise<ManimStatus>;
	/** Render one scene. Scene errors and timeouts resolve with ok: false;
	 *  it throws only when abortSignal fires. */
	render(req: ManimRenderRequest): Promise<ManimRenderResult>;
}

/** The media names a job may write: `<jobId>.mp4`, `<jobId>-poster.png`,
 *  `<jobId>.png`. The media route serves nothing else. */
export const MEDIA_FILE_RE = /^[A-Za-z0-9_-]{1,120}\.(?:png|mp4)$/;

/** Where the browser fetches a chat's media file. */
export function mediaUrl(chatId: string, file: string): string {
	return `/api/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(file)}`;
}
