import type { ChatKind, ChatRecord } from "../core/contracts/chat.ts";
import type { ReviewQueue } from "../core/review-queue.ts";
import { buildReviewQueue } from "../core/review-schedule.ts";
import { stores } from "./stores.ts";

/**
 * THE DUE-FOR-PRACTICE QUEUE'S READ (M20): every practice session replayed
 * through FSRS (core/review-schedule.ts) against the live graph. Worked out
 * on each read; nothing is cached or written.
 */
export function reviewQueue(now: Date = new Date()): ReviewQueue {
	const { chatStore, graphStore } = stores;
	const summaries = chatStore.listChats();
	// `after` bounds by last activity: a teach session that picked a
	// proposition after a miss was necessarily active after it too.
	const read = (kind: ChatKind, after?: number): ChatRecord[] =>
		summaries
			.filter((s) => s.kind === kind && (after === undefined || !(Date.parse(s.updatedAt) < after)))
			.map((s) => chatStore.getChat(s.id))
			.filter((chat): chat is ChatRecord => chat !== null);
	return buildReviewQueue({
		practice: read("practice"),
		nodes: graphStore.readNodes(),
		teachSince: (since) => read("teach", since.getTime()),
		now,
	});
}
