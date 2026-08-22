/**
 * SillyTavern chat (.jsonl) → ChungusHub message tree converter.
 *
 * A SillyTavern chat file is JSON Lines: the first line is a `chat_metadata` header,
 * every following line is one message. Each message carries the ACTIVE swipe in `mes`
 * and every alternative in `swipes` (with `swipe_id` marking which one is live and
 * `swipe_info` holding per-swipe metadata).
 *
 * Three timings come across with each generated turn: the wall-clock span between the file's
 * `gen_started` and `gen_finished` stamps, and the exporter's own `time_to_first_token` and
 * `reasoning_duration`. They are the source's measurements, not ours, and the second of those
 * is the one to watch: SillyTavern's reasoning figure has been observed equal to the whole
 * generation on a turn where the reasoning stream cannot have run that long, so it is a
 * looser reading of "time spent reasoning" than a turn generated here records.
 *
 * ChungusHub's conversation model is a tree (parent_id + sibling_index), where swipes /
 * regenerations are sibling branches and the active leaf picks the visible timeline. That
 * maps onto SillyTavern's shape exactly: at each message point we emit one node per swipe
 * as siblings, and the ACTIVE swipe is the node the next message parents onto, so the
 * chosen timeline is the active path and the other swipes hang off as dead-end branches,
 * just as they were when the story was played.
 *
 * This module is pure (no db, no stores) so it stays testable. See the sibling test file.
 * `chatStore.importSillyTavernChat` turns its output into rows.
 */
import type { Message } from '$lib/types/chat';

/** One line of a SillyTavern chat file (post-metadata). Only the fields we read are typed. */
interface STChatMessage {
	name?: string;
	is_user?: boolean;
	send_date?: string;
	mes?: string;
	swipes?: string[];
	swipe_id?: number;
	swipe_info?: STSwipeInfo[];
	extra?: STMessageExtra;
	/** Generation start/finish stamps. Siblings of `extra`, never inside it. */
	gen_started?: string;
	gen_finished?: string;
}

interface STMessageExtra {
	reasoning?: string;
	model?: string;
	api?: string;
	token_count?: number;
	/** Milliseconds the exporter waited for the first token. */
	time_to_first_token?: number;
	/** Milliseconds the exporter attributed to reasoning. */
	reasoning_duration?: number;
}

interface STSwipeInfo {
	send_date?: string;
	extra?: STMessageExtra;
	gen_started?: string;
	gen_finished?: string;
}

export interface ConvertedChat {
	/** Every message row, parent-first, ready to insert once chatId is stamped on. */
	messages: Message[];
	/** The active-swipe node of the first message (a root). */
	rootMessageId: string | null;
	/** The active-swipe node of the last message: where the visible timeline ends. */
	activeLeafId: string | null;
}

/** Parse a SillyTavern timestamp best-effort; falls back to the sequential clock when the
 *  format is one JS can't read (SillyTavern mixes ISO and "October 24, 2025 6:15pm"). */
function parseDate(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const parsed = Date.parse(raw);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
	for (const v of values) {
		if (v && v.trim().length > 0) return v;
	}
	return null;
}

/** A duration the file states directly, kept only when it is a usable one. A negative or
 *  absurd figure is a clock the exporter could not read, and a stat built on it would be
 *  worse than the gap it fills. */
function usableDuration(value: number | undefined): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
	return Math.round(value);
}

/** How long a generation ran, from the pair of stamps SillyTavern writes around it. Null
 *  whenever the pair is incomplete or does not parse, and whenever it runs backwards: two
 *  stamps in the wrong order describe nothing, and a negative duration would poison every
 *  average built on the column. */
function spanBetween(started: string | undefined, finished: string | undefined): number | null {
	if (!started || !finished) return null;
	const from = Date.parse(started);
	const to = Date.parse(finished);
	if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
	return to - from;
}

/**
 * The character a chat file names, off its `chat_metadata` header line.
 *
 * Only that line is read: a message's own `name` is whoever spoke the turn, which on a user
 * turn is the persona. Null when the first line is not the header or names nobody, so a
 * caller offering this as a target has an empty answer to show rather than a guessed one.
 */
export function readChatCharacterName(lines: string[]): string | null {
	const header = lines.find((line) => line.trim() !== '');
	if (!header) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(header);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || !('chat_metadata' in parsed)) return null;

	const name = (parsed as { character_name?: unknown }).character_name;
	return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

/**
 * Convert the raw lines of a SillyTavern chat file into a message tree.
 *
 * @param lines   The file split on newlines (blank lines tolerated).
 * @param ctx     Row context: the target chat id.
 * @param newId   Id factory (injected so tests stay deterministic).
 */
export function convertSillyTavernChat(
	lines: string[],
	ctx: { chatId: string; baseTime?: number },
	newId: () => string = () => crypto.randomUUID()
): ConvertedChat {
	const baseTime = ctx.baseTime ?? Date.now();
	const messages: Message[] = [];

	let parentActiveId: string | null = null;
	let rootMessageId: string | null = null;
	let activeLeafId: string | null = null;
	let seq = 0; // monotonic tiebreaker for createdAt / ordering

	let seenFirstMessage = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// A corrupt line shouldn't sink the whole chat; skip it. (The file-level parse
			// still fails loud upstream if the whole thing is unreadable.)
			continue;
		}

		// The header line carries chat_metadata and no message body, so skip it.
		if (!parsed || typeof parsed !== 'object' || 'chat_metadata' in (parsed as object)) continue;
		const st = parsed as STChatMessage;
		if (typeof st.mes !== 'string' && !Array.isArray(st.swipes)) continue;

		// NOTE: `is_system` is NOT skipped. SillyTavern flips it to true when a message is
		// hidden/ghosted from the prompt: those are still real conversation turns, so
		// dropping them silently deletes history. ChungusHub has no per-message "hide from
		// prompt" flag, so they import as normal (visible) turns; the role still comes from
		// `is_user`, which stays correct for hidden user vs. character messages.
		const role: Message['role'] = st.is_user ? 'user' : 'assistant';
		const swipeTexts = st.swipes && st.swipes.length > 0 ? st.swipes : [st.mes ?? ''];
		const activeSwipe = Math.min(Math.max(st.swipe_id ?? 0, 0), swipeTexts.length - 1);

		const pointParent = parentActiveId; // all swipes at this point share the prior active node
		let activeNodeId: string | null = null;

		for (let j = 0; j < swipeTexts.length; j++) {
			const info = st.swipe_info?.[j];
			// The active swipe's metadata lives on the message's own `extra`; other swipes
			// carry theirs in swipe_info. Prefer the swipe-specific block, fall back to extra.
			const extra = info?.extra ?? (j === activeSwipe ? st.extra : undefined);
			// The generation stamps sit BESIDE `extra`, not inside it, at both levels. Same
			// swipe-specific-first rule: every swipe was its own generation, with its own clock.
			const genStarted = info?.gen_started ?? (j === activeSwipe ? st.gen_started : undefined);
			const genFinished = info?.gen_finished ?? (j === activeSwipe ? st.gen_finished : undefined);
			const id = newId();
			const createdAt = parseDate(info?.send_date ?? st.send_date, baseTime + seq);

			messages.push({
				id,
				chatId: ctx.chatId,
				parentId: pointParent,
				role,
				content: swipeTexts[j] ?? '',
				personaId: null,
				branchLabel: null,
				thinking: role === 'assistant' ? firstNonEmpty(extra?.reasoning) : null,
				attachments: null,
				createdAt,
				editedAt: null,
				minorEditedAt: null,
				spriteLabel: null,
				model: firstNonEmpty(extra?.model),
				provider: firstNonEmpty(extra?.api),
				tokensPrompt: null,
				tokensCompletion: typeof extra?.token_count === 'number' ? extra.token_count : null,
				finishReason: null,
				// All three describe a generation, so a user turn never carries one.
				generationMs: role === 'assistant' ? spanBetween(genStarted, genFinished) : null,
				firstTokenMs: role === 'assistant' ? usableDuration(extra?.time_to_first_token) : null,
				reasoningMs: role === 'assistant' ? usableDuration(extra?.reasoning_duration) : null,
				// The format records nothing about which world info fired, and this app's scan
				// never ran for these turns, so there is nothing honest to put here.
				lorebook: null,
				siblingIndex: j
			});
			seq++;

			if (j === activeSwipe) activeNodeId = id;
			if (!seenFirstMessage && j === activeSwipe) rootMessageId = id;
		}

		seenFirstMessage = true;
		parentActiveId = activeNodeId;
		activeLeafId = activeNodeId;
	}

	return { messages, rootMessageId, activeLeafId };
}
