/**
 * Chat + recall capabilities: list/search chats, windowed full-fidelity message
 * reads, the chat-context read (cast + lorebook index), and chat memory (state read
 * + summary rewrite). Their windowing/snippet logic earns dedicated tools instead of
 * entity ops.
 */
import { serverDb } from '../../db';
// The memory core is pure by design (no Svelte, no $lib, no I/O; see architecture/memory.md),
// which is exactly what lets the server drive it too. Importing it is deliberate: the
// archive boundary is DERIVED from episode coverage, and a hand-written second derivation
// here would be a coupling that rots the first time the rules change.
import { changeImpact, episodeSeqRanges, resolveCoverage } from '../../../src/lib/memory/branching';
import { resolveConfig } from '../../../src/lib/memory/config';
import { describeMemoryImpact } from '../../../src/lib/memory/impact-copy';
import type { Episode, MemoryMessage } from '../../../src/lib/memory/types';
import type { AssistantContext } from '../types';
import type { Capability } from './types';
import type { RawChat, RawLibraryEntry, RawLorebookBook, RawLorebookEntry, RawMessage } from '../rows';
import { getEntity } from './entities';
import { stampState } from '../freshness';
import { portraitAttachment } from './images';
import { ToolError, str, requireStr, clampInt, ok, NO_CAP } from './util';

/**
 * The chat a tool acts on, always explicit. There is no implicit "current chat": a tool
 * that silently fell back to whatever the user happened to have open could land an edit on
 * the wrong chat without a trace, and the user's screen moves independently of the work the
 * assistant is doing. The turn's context note carries the open chat's id for the common case.
 */
export function requireChatId(explicit: unknown): string {
	if (typeof explicit !== 'string' || !explicit.trim()) {
		throw new ToolError('`chatId` is required: take it from this turn\'s context note (the chat the user has open) or from list_chats/search_chats.');
	}
	return explicit.trim();
}

function personaEntry(id: string | null | undefined): RawLibraryEntry | null {
	if (!id) return null;
	const entry = serverDb.getLibraryEntry(id) as RawLibraryEntry | null;
	return entry?.type === 'persona' ? entry : null;
}

/**
 * One claim off a chat's own setup (`chat.featureState`, whose normalizer lives in
 * src/lib/types/chat.ts and cannot be imported here). Undefined for a chat that claims
 * nothing and for a blob that will not parse, which is what "follows the app" reads as.
 */
function chatClaim(chat: RawChat, key: 'persona' | 'lorebooks' | 'mutedLorebooks'): unknown {
	if (!chat.featureState) return undefined;
	try {
		return (JSON.parse(chat.featureState) as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

/**
 * The persona a chat plays as: its own claim while that persona still exists, else the one
 * the app starts new chats as. The client resolves this in `src/lib/utils/chat-setup.ts`,
 * which the server cannot import, so the rule is spelled again here rather than reported
 * wrong: a read that named the app's persona would tell the model that a story playing as
 * somebody else attributes its new turns to them.
 */
function chatPersona(chat: RawChat): RawLibraryEntry | null {
	const claimed = chatClaim(chat, 'persona');
	const own = typeof claimed === 'string' && claimed ? claimed : null;
	return personaEntry(own) ?? personaEntry(serverDb.getSetting('activePersonaId'));
}

/** A claimed id list off the chat's own setup blob, skipping anything that is not one. */
function claimedIds(chat: RawChat, key: 'lorebooks' | 'mutedLorebooks'): string[] {
	const raw = chatClaim(chat, key);
	return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Books active for a chat: every book switched into every chat, then those linked by its
 * character and the persona it plays as, then the ones the chat itself attached, minus the
 * ones it muted.
 *
 * The second spelling of `resolveLorebookLinks` (src/lib/lorebook/types.ts), which this side
 * cannot import, and the ONE the server has: `read_chat_context` and the turn's workspace note
 * both read it. Every layer no card names has to be here: leave the globals out and the
 * assistant reports a scene missing the books that are in ALL of them, leave the chat's own out
 * and it misses the lore this one story was given, leave the mutes out and it describes books
 * this story took back off, and none of those absences shows anywhere else.
 *
 * The globals lead in creation order, as the client resolves them: `getAllLorebooks` answers
 * most-recently-written first, so taking that order would name the scene's books in a sequence
 * that flips whenever one is edited and never matches the one lore is laid down in.
 */
export function chatLorebooks(chat: RawChat): RawLorebookBook[] {
	const all = serverDb.getAllLorebooks() as RawLorebookBook[];
	const out = all
		.filter((b) => b.global)
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	const seen = new Set(out.map((b) => b.id));
	const ids = new Set<string>();
	if (chat.characterId) {
		const c = serverDb.getLibraryEntry(chat.characterId) as RawLibraryEntry | null;
		for (const id of c?.data?.lorebookIds ?? []) ids.add(id);
	}
	for (const id of chatPersona(chat)?.data?.lorebookIds ?? []) ids.add(id);
	for (const id of claimedIds(chat, 'lorebooks')) ids.add(id);
	for (const id of ids) {
		if (seen.has(id)) continue;
		const book = all.find((b) => b.id === id);
		if (book) out.push(book);
	}
	// Subtracted last, as the client resolves it: a mute outranks every layer above it.
	const muted = new Set(claimedIds(chat, 'mutedLorebooks'));
	return muted.size ? out.filter((b) => !muted.has(b.id)) : out;
}

/**
 * The branch stamp every chat-scoped read and write is measured against: which leaf the
 * chat currently ends on, and how long that branch is. A chat is a TREE: every read here
 * walks root→`activeLeafId`, and a `seq` is a position on THAT walk, so both move the
 * moment the user swipes or jumps branches. Reporting the stamp is what lets the model
 * notice it moved instead of reusing a seq that now points somewhere else.
 */
export function branchStamp(chatId: string): { activeLeafId: string | null; branchMessages: number } {
	const path = activePathMessages(chatId);
	return { activeLeafId: path.length ? path[path.length - 1].id : null, branchMessages: path.length };
}

/**
 * The branch check every message WRITE owes the user. Chat reads follow the active path, so
 * a write aimed off it changes nothing on their screen: the thread they are reading does not
 * move, and a memory summary covering that branch dies with no visible cause. Returns the
 * sentence to shout, or undefined when the target sits on the path (the ordinary case).
 *
 * Editing an abandoned branch on purpose is legitimate, so this warns and never refuses.
 */
export function offPathWarning(messageId: string): string | undefined {
	const raw = serverDb.getMessage(messageId) as RawMessage | null;
	if (!raw) return undefined;
	if (activePathMessages(raw.chatId).some((m) => m.id === messageId)) return undefined;
	const chat = serverDb.getChat(raw.chatId) as RawChat | null;
	return `This message is NOT on the active branch of "${chat?.title ?? raw.chatId}": it sits on another branch of the chat tree. The thread the user is reading will not change, so tell them which branch you touched instead of reporting an edit they cannot see.`;
}

/** The same fact as `offPathWarning`, said to the PERSON reading the approval card rather
 *  than to the model. The two live together so neither can be updated without the other. */
export const OFF_PATH_NOTE = 'On a branch you are not reading, so the thread on screen will not change.';

/** A message as a reader knows it: where it sits, who said it, and what it says. */
export interface MessageDescriptor {
	/** "Turn #42 · Aria", or "Off-branch · Aria" for a message the reader is not on. */
	line: string;
	/** What the message says, whole: the card clips it, and the expanded view does not. */
	text: string;
	chatId: string;
	chatTitle: string;
	/** Position on the active branch, 1-based; 0 when the message sits off it. */
	seq: number;
	offPath: boolean;
}

/**
 * Everything the approval card and the panel row need to name ONE message. A message has no
 * name of its own ("user message" identifies nothing on a card holding twenty of them), so
 * its identity is its position, its speaker, and its opening words.
 *
 * One path walk answers both the position and the branch check, which is what `offPathWarning`
 * costs on its own; a preview asks this INSTEAD of that, never as well.
 */
export function describeMessage(id: string): MessageDescriptor | null {
	const raw = serverDb.getMessage(id) as RawMessage | null;
	if (!raw) return null;
	const chat = serverDb.getChat(raw.chatId) as RawChat | null;
	const seq = activePathMessages(raw.chatId).findIndex((m) => m.id === id) + 1;
	let speaker: string;
	if (raw.role === 'system') speaker = 'System';
	else if (raw.role === 'assistant') {
		const character = chat?.characterId ? (serverDb.getLibraryEntry(chat.characterId) as RawLibraryEntry | null) : null;
		speaker = character?.identity.name || 'Assistant';
	} else {
		// Attribution is locked at send time, so an unattributed turn is "You" and never the
		// persona that happens to be active now.
		const persona = raw.personaId ? (serverDb.getLibraryEntry(raw.personaId) as RawLibraryEntry | null) : null;
		speaker = persona?.identity.name || 'You';
	}
	return {
		line: `${seq ? `Turn #${seq}` : 'Off-branch'} · ${speaker}`,
		text: raw.content,
		chatId: raw.chatId,
		chatTitle: chat?.title ?? raw.chatId,
		seq,
		offPath: seq === 0
	};
}

/** How many of these messages sit off their chat's active path: one path walk per chat,
 *  so a bulk sweep over hundreds of rows costs the same as one read. */
export function offPathMessageCount(rows: { id: string; chatId: string }[]): number {
	const paths = new Map<string, Set<string>>();
	let off = 0;
	for (const row of rows) {
		let path = paths.get(row.chatId);
		if (!path) {
			path = new Set(activePathMessages(row.chatId).map((m) => m.id));
			paths.set(row.chatId, path);
		}
		if (!path.has(row.id)) off += 1;
	}
	return off;
}

/** Root→active-leaf path of a chat, oldest first. */
export function activePathMessages(chatId: string): RawMessage[] {
	const all = serverDb.getMessagesByChat(chatId) as RawMessage[];
	if (!all.length) return [];
	const chat = serverDb.getChat(chatId) as RawChat | null;
	const byId = new Map<string, RawMessage>(all.map((m) => [m.id, m]));
	const leafId = chat?.activeLeafId && byId.has(chat.activeLeafId) ? chat.activeLeafId : all.slice().sort((a, b) => b.createdAt - a.createdAt)[0].id;
	const path: RawMessage[] = [];
	let cursor: string | null = leafId;
	const guard = new Set<string>();
	while (cursor && byId.has(cursor) && !guard.has(cursor)) {
		guard.add(cursor);
		const node: RawMessage = byId.get(cursor)!;
		path.push(node);
		cursor = node.parentId;
	}
	return path.reverse();
}

/** How many chats one call returns when the model doesn't ask for a size. Enough to answer
 *  "what have I been playing" outright; a long list pages from here. */
const DEFAULT_CHAT_PAGE = 30;

export const listChats: Capability = {
	name: 'list_chats',
	summary:
		'List chats with id, title, last-updated time and message count, newest first. ALWAYS reports the total, so you can see what you did not get.',
	risk: 'read',
	params: [
		{
			name: 'limit',
			type: 'integer',
			describe: 'How many to return (default 30, newest first). No maximum: pass the reported total to list every chat at once.',
			minimum: 1
		},
		{ name: 'offset', type: 'integer', describe: 'Skip this many from the newest end, to page through a long list.', minimum: 0 }
	],
	run(args) {
		const chats = serverDb.getAllChats() as RawChat[];
		const counts = serverDb.getMessageCounts();
		const total = chats.length;
		// The only bound is the data itself, deliberately: a constant ceiling would leave the
		// assistant unable to list everything no matter how plainly the user asked for it.
		// The default keeps the ordinary "which chats do I have" answer from writing a
		// thousand rows into the tab's context, which every later turn would then resend.
		const offset = clampInt(args.offset, 0, total, 0);
		const limit = clampInt(args.limit, 1, Math.max(total, 1), DEFAULT_CHAT_PAGE);
		const rows = chats
			.slice(offset, offset + limit)
			.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: counts[c.id] ?? 0 }));
		const shownTo = offset + rows.length;
		const remaining = total - shownTo;
		return ok(
			{
				type: 'list_chats',
				label:
					rows.length === total
						? `Listed ${total} chat${total === 1 ? '' : 's'}`
						: `Listed ${offset + 1}-${shownTo} of ${total} chats`
			},
			{
				total,
				offset,
				count: rows.length,
				chats: rows,
				...(remaining > 0
					? {
							note: `${remaining} older chat${remaining === 1 ? '' : 's'} not shown. Pass offset:${shownTo} for the next page, or limit:${total} to get every chat in one call.`
						}
					: {})
			}
		);
	}
};

export const searchChats: Capability = {
	name: 'search_chats',
	summary: 'Search the text of messages across ALL chats. Multiple words are ANDed: every term must appear in the message (case-insensitive, any order). Use to recall past roleplay ("find the chat where we fought the dragon"). Returns matches (most recent chats first) with chat id/title and a snippet.',
	risk: 'read',
	params: [
		{ name: 'query', type: 'string', describe: 'One or more words to find inside message content; all must be present.', required: true },
		{
			name: 'limit',
			type: 'integer',
			describe: 'How many matches to return (default 20). No maximum: raise it when the user wants the full sweep rather than the first hits.',
			minimum: 1
		},
		{ name: 'offset', type: 'integer', describe: 'Skip this many matches, to page through a long result set.', minimum: 0 }
	],
	run(args) {
		const terms = str(args.query).trim().toLowerCase().split(/\s+/).filter(Boolean);
		if (!terms.length) throw new ToolError('search_chats requires a non-empty query.');
		// No constant ceiling: a search the user asked to exhaust must be exhaustible. The
		// total is unknowable without scanning everything, so instead of promising one we
		// collect a single match past the page and report honestly whether more exist.
		const limit = clampInt(args.limit, 1, NO_CAP, 20);
		const offset = clampInt(args.offset, 0, NO_CAP, 0);
		const wanted = offset + limit;
		// Most recently active chats first: recall usually targets recent play.
		const chats = (serverDb.getAllChats() as RawChat[]).slice().sort((a, b) => b.updatedAt - a.updatedAt);
		const matches: { chatId: string; chatTitle: string; messageId: string; role: string; snippet: string }[] = [];
		for (const chat of chats) {
			const messages = (serverDb.getMessagesByChat(chat.id) as RawMessage[]).slice().sort((a, b) => b.createdAt - a.createdAt);
			for (const m of messages) {
				const haystack = m.content.toLowerCase();
				if (!terms.every((t) => haystack.includes(t))) continue;
				// Map the match position back to the ORIGINAL string: lowercasing can change
				// length ('İ' → 'i̇' is two code units), so a lowercase index drifts.
				const at = originalIndexFor(m.content, haystack.indexOf(terms[0]));
				const start = Math.max(0, at - 80);
				const end = Math.min(m.content.length, at + terms[0].length + 80);
				const snippet = (start > 0 ? '…' : '') + m.content.slice(start, end).trim() + (end < m.content.length ? '…' : '');
				matches.push({ chatId: chat.id, chatTitle: chat.title, messageId: m.id, role: m.role, snippet });
				if (matches.length > wanted) break;
			}
			if (matches.length > wanted) break;
		}
		const hasMore = matches.length > wanted;
		const page = matches.slice(offset, wanted);
		return ok(
			{
				type: 'search_chats',
				label: `Searched chats for "${args.query}": ${page.length} hit${page.length === 1 ? '' : 's'}${hasMore ? ', more exist' : ''}`
			},
			{
				query: args.query,
				offset,
				count: page.length,
				matches: page,
				...(hasMore
					? {
							note: `More matches exist past this page. Pass offset:${wanted} for the next one, or raise limit. Narrowing the query is usually the better answer.`
						}
					: {})
			}
		);
	}
};

/** The character position in `content` that position `lowerIdx` of `content.toLowerCase()`
 *  corresponds to. Lowercasing is not length-preserving ('İ' expands), so indexes
 *  found in the lowered haystack must be mapped back before slicing the original. */
function originalIndexFor(content: string, lowerIdx: number): number {
	let lowered = 0;
	for (let i = 0; i < content.length; i += 1) {
		if (lowered >= lowerIdx) return i;
		lowered += content[i].toLowerCase().length;
	}
	return content.length;
}

/** Hard cap on how many messages one read returns: page with fromSeq/toSeq instead.
 *  This is PAGING, not truncation: within a slice, content is always complete. */
const READ_MESSAGES_SPAN_CAP = 100;

export const readChatMessages: Capability = {
	name: 'read_chat_messages',
	summary:
		"Read a chat's ACTIVE BRANCH in order, with ids and seq numbers, always in full, never shortened. The result reports the `activeLeafId` it walked; a `seq` is a position on that branch. User rows carry the personaId they were sent with (null = unattributed, renders as \"You\"); the result's `personas` map resolves those ids to names. Target with `limit` (the tail), `aroundMessageId` (a window) or `fromSeq`/`toSeq` (an exact range). A read costs context in proportion to what it returns: ask for the window the task needs, not the thread.",
	risk: 'read',
	params: [
		{ name: 'chatId', type: 'string', describe: 'The chat to read.', required: true },
		{ name: 'aroundMessageId', type: 'string', describe: 'Anchor id; returns a window centered on it.' },
		{ name: 'before', type: 'integer', describe: 'With aroundMessageId: messages before the anchor (default 8).', minimum: 0, maximum: 100 },
		{ name: 'after', type: 'integer', describe: 'With aroundMessageId: messages after the anchor (default 8).', minimum: 0, maximum: 100 },
		{ name: 'limit', type: 'integer', describe: `With no anchor/range: return the last N (default 30, max ${READ_MESSAGES_SPAN_CAP}).`, minimum: 1, maximum: READ_MESSAGES_SPAN_CAP },
		{ name: 'fromSeq', type: 'integer', describe: 'Start of an explicit seq range (1-based, inclusive).', minimum: 1 },
		{ name: 'toSeq', type: 'integer', describe: 'End of an explicit seq range (inclusive). Defaults to fromSeq + 29.', minimum: 1 }
	],
	run(args, ctx) {
		const chatId = requireChatId(args.chatId);
		// A nonexistent chat must not read as an empty one: the model would tell the
		// user their chat is empty when the id was simply stale or mistyped.
		const chat = serverDb.getChat(chatId) as RawChat | null;
		if (!chat) throw new ToolError(`No chat with id "${chatId}". Use list_chats or search_chats to find the right id.`);
		const path = activePathMessages(chatId);
		const total = path.length;
		const title = chat.title ?? '';
		// User rows carry their per-message attribution: hiding personaId made the model
		// re-label history with the currently-active persona (null = unattributed "You").
		const withSeq = path.map((m, i) => ({
			seq: i + 1,
			id: m.id,
			role: m.role,
			...(m.role === 'user' ? { personaId: m.personaId ?? null } : {}),
			content: m.content
		}));

		const anchorId = str(args.aroundMessageId).trim();
		const hasRange = args.fromSeq != null || args.toSeq != null;
		let slice = withSeq;
		const notes: string[] = [];

		if (hasRange) {
			if (!total) throw new ToolError('This chat has no messages.');
			const from = clampInt(args.fromSeq, 1, total, 1);
			if (args.fromSeq != null && Math.floor(Number(args.fromSeq)) > total) {
				throw new ToolError(`fromSeq ${args.fromSeq} is beyond this thread: it has ${total} messages (seq 1 to ${total}).`);
			}
			let to = clampInt(args.toSeq, from, total, Math.min(total, from + 29));
			if (to - from + 1 > READ_MESSAGES_SPAN_CAP) {
				to = from + READ_MESSAGES_SPAN_CAP - 1;
				notes.push(`Range capped at ${READ_MESSAGES_SPAN_CAP} messages: showing seq ${from}–${to}. Page the rest with another fromSeq/toSeq call.`);
			}
			slice = withSeq.slice(from - 1, to);
			if (from > 1 || to < total) notes.push(`Showing seq ${from}–${to} of ${total}.`);
		} else if (anchorId) {
			const idx = withSeq.findIndex((m) => m.id === anchorId);
			if (idx === -1) throw new ToolError(`No message with id "${anchorId}" on this chat's active thread.`);
			const before = clampInt(args.before, 0, READ_MESSAGES_SPAN_CAP - 1, 8);
			let after = clampInt(args.after, 0, READ_MESSAGES_SPAN_CAP - 1, 8);
			// One combined span cap, like the range path: before:100 + after:100 must not
			// return a 201-message window through the side door.
			if (before + after + 1 > READ_MESSAGES_SPAN_CAP) {
				after = READ_MESSAGES_SPAN_CAP - 1 - before;
				notes.push(`Window capped at ${READ_MESSAGES_SPAN_CAP} messages (before kept, after clamped to ${after}). Page further with another call.`);
			}
			const start = Math.max(0, idx - before);
			const end = Math.min(total, idx + after + 1);
			slice = withSeq.slice(start, end);
			if (start || total - end) notes.push(`Window around seq ${idx + 1}: showing ${start + 1}–${end} of ${total}. ${start} earlier / ${total - end} later not shown.`);
		} else {
			const take = clampInt(args.limit, 1, READ_MESSAGES_SPAN_CAP, 30);
			if (total > take) {
				slice = withSeq.slice(-take);
				notes.push(`Showing the last ${take} of ${total} messages (seq ${total - take + 1}–${total}). Earlier turns: fromSeq/toSeq or aroundMessageId.`);
			}
		}

		// One id→name legend for the slice instead of a name per row; a dangling id
		// (deleted persona) must still read as a distinct speaker, not vanish.
		const personaNames: Record<string, string> = {};
		let unattributed = 0;
		for (const m of slice) {
			if (m.role !== 'user') continue;
			if (!m.personaId) {
				unattributed += 1;
			} else if (!personaNames[m.personaId]) {
				const p = serverDb.getLibraryEntry(m.personaId) as RawLibraryEntry | null;
				personaNames[m.personaId] = p?.type === 'persona' ? p.identity.name : '(deleted persona)';
			}
		}
		if (unattributed) {
			notes.push(`${unattributed} user message${unattributed === 1 ? ' is' : 's are'} unattributed (personaId null, renders as "You").`);
		}

		const firstSeq = slice[0]?.seq;
		const lastSeq = slice[slice.length - 1]?.seq;
		const where = title || 'chat';
		// The label states exactly what the model received. Content is never shortened:
		// the context cost is the user's to watch (panel meter), not ours to hide.
		const label = !slice.length
			? `Read 0 messages from ${where}`
			: `Read ${slice.length === 1 ? `message ${firstSeq}` : `messages ${firstSeq} to ${lastSeq}`} of ${total} from ${where}`;
		return ok(
			{ type: 'read_chat_messages', label },
			{
				chatId,
				chatTitle: title,
				// Which branch these seq numbers belong to. A different leaf next turn means the
				// user moved and every seq above it is stale.
				activeLeafId: path.length ? path[path.length - 1].id : null,
				total,
				count: slice.length,
				...(notes.length ? { note: notes.join(' ') } : {}),
				...(Object.keys(personaNames).length ? { personas: personaNames } : {}),
				messages: slice,
				...stampState(['chat', chatId])
			}
		);
	}
};

/** Compact index line for one lorebook entry: full content stays behind read_lorebook_entries. */
function entryIndex(e: RawLorebookEntry): Record<string, unknown> {
	const preview = e.content.length > 120 ? e.content.slice(0, 120) + '…' : e.content;
	return { id: e.id, comment: e.comment, keys: e.key, constant: e.constant, enabled: !e.disable, preview };
}

export const readChatContext: Capability = {
	name: 'read_chat_context',
	summary: "Read a chat's cast: its bound character IN FULL and the personas that actually speak in its thread IN FULL (each user message is stamped with the persona it was sent with; null = unattributed, renders as \"You\"), plus an INDEX of the scene's lorebooks (book + entry ids, keys, content previews). `activePersona` is a name pointer only: who NEW messages in THIS chat will be attributed to (its own persona if it plays as one, else the app's), not necessarily who spoke earlier; read_entity it when needed. Read this before editing roleplay so you write them in character. For an entry's full text, use read_lorebook_entries.",
	risk: 'read',
	params: [{ name: 'chatId', type: 'string', describe: 'The chat to read.', required: true }],
	run(args, ctx) {
		const chatId = requireChatId(args.chatId);
		const chat = serverDb.getChat(chatId) as RawChat | null;
		if (!chat) throw new ToolError(`No chat with id "${chatId}".`);
		const charDef = getEntity('character');
		const personaDef = getEntity('persona');
		const charFlat = chat.characterId ? charDef.read?.(chat.characterId, ctx) : null;
		// The chat's ACTUAL speakers: the distinct personas stamped on the thread's user
		// messages, in first-appearance order. The globally-active persona is deliberately
		// NOT expanded here: presenting it as part of the scene made the model attribute
		// past "You" messages to it (imported chats carry personaId null throughout).
		const path = activePathMessages(chatId);
		const usedIds: string[] = [];
		let unattributed = 0;
		for (const m of path) {
			if (m.role !== 'user') continue;
			if (!m.personaId) unattributed += 1;
			else if (!usedIds.includes(m.personaId)) usedIds.push(m.personaId);
		}
		const personas = usedIds.map((id) => {
			const flat = personaDef.read?.(id, ctx);
			// A deleted persona stays visible as a distinct (dead) speaker, not dropped.
			return flat ? { id: flat.id, ...flat.fields } : { id, deleted: true };
		});
		const activeRaw = chatPersona(chat);
		const books = chatLorebooks(chat);
		// Portraits for who is actually in the scene: the character + the speakers.
		const attach = portraitAttachment([charFlat?.id, ...usedIds], ctx);
		const noteParts = ['Lorebook entries are previews: read full text with read_lorebook_entries(lorebookId).'];
		if (unattributed) {
			noteParts.push(
				`${unattributed} user message${unattributed === 1 ? '' : 's'} on this thread ${unattributed === 1 ? 'is' : 'are'} unattributed (personaId null, renders as "You"); do not assume the active persona wrote ${unattributed === 1 ? 'it' : 'them'}.`
			);
		}
		return {
			...ok({ type: 'read_chat_context', label: 'Read chat context' }, {
				chatId,
				chatTitle: chat.title,
				// The branch this cast was read from, the same stamp read_chat_messages reports.
				activeLeafId: path.length ? path[path.length - 1].id : null,
				branchMessages: path.length,
				character: charFlat ? { id: charFlat.id, ...charFlat.fields } : null,
				personas,
				...(unattributed ? { unattributedUserMessages: unattributed } : {}),
				activePersona: activeRaw ? { id: activeRaw.id, name: activeRaw.identity.name } : null,
				note: noteParts.join(' '),
				...(attach.note ? { portraits: attach.note } : {}),
				lorebooks: books.map((b) => ({
					id: b.id,
					name: b.name,
					entries: b.entries.map(entryIndex)
				})),
				// Claims for what arrived IN FULL: the chat, its character, the speaking
				// personas. The lorebooks are an index with previews, not knowledge: their
				// claims belong to read_lorebook_entries, which is what hands them over whole.
				...stampState(
					['chat', chatId],
					...(charFlat ? [['character', charFlat.id] as [string, string]] : []),
					...personas.filter((p): p is { id: string } & Record<string, unknown> => !('deleted' in p)).map((p): [string, string] => ['persona', p.id])
				)
			}),
			...(attach.paths.length ? { injectImages: attach.paths } : {})
		};
	}
};

// ===== chat memory =====

interface RawMemoryState {
	enabled: boolean;
	autoExtract: boolean;
	config: Record<string, number> | null;
}

/** Resolve a chat's episodes against its active path. Shared by the state read and the
 *  summary rewrite, so both answer from the same derivation the prompt uses. */
function memoryCoverage(chatId: string, state: RawMemoryState, path: RawMessage[]) {
	const all = serverDb.getMessagesByChat(chatId) as RawMessage[];
	const episodes = (serverDb.memListEpisodes(chatId) as Episode[]) ?? [];
	const coverage = resolveCoverage(
		all.map((m): MemoryMessage => ({ id: m.id, parentId: m.parentId, role: m.role, content: m.content, speaker: '', editedAt: m.editedAt })),
		path.length ? path[path.length - 1].id : null,
		episodes,
		resolveConfig(state.config).verbatimTail
	);
	const memPath = path.map((m): MemoryMessage => ({ id: m.id, parentId: m.parentId, role: m.role, content: m.content, speaker: '' }));
	return { episodes, coverage, memPath, ranges: episodeSeqRanges(memPath, episodes) };
}

/** What touching a turn costs the chat's memory, in numbers and in the transcript's own words. */
export interface MemoryCost {
	/** Summaries in play on this branch that the change destroys. */
	summariesDropped: number;
	/** Stored summaries of these turns that go too: other branches, or past the tail. */
	summariesDroppedElsewhere: number;
	/** Summaries behind the resulting hole that pause until it closes; their rows stand. */
	summariesPaused: number;
	/** Turns a fold still has to re-read, and the model calls that costs. */
	turnsReread: number;
	passes: number;
	/** 1-based seq span of the dropped coverage on this branch. */
	span: { from: number; to: number } | null;
	/** The same sentences the transcript's own confirmation puts in front of the user. */
	says: string[];
}

/** A message and everything under it, exactly what a `with_descendants` delete removes. */
function subtreeIds(chatId: string, rootId: string): string[] {
	const children = new Map<string, string[]>();
	for (const m of serverDb.getMessagesByChat(chatId) as RawMessage[]) {
		if (!m.parentId) continue;
		children.set(m.parentId, [...(children.get(m.parentId) ?? []), m.id]);
	}
	const out: string[] = [];
	const stack = [rootId];
	while (stack.length) {
		const id = stack.pop()!;
		out.push(id);
		for (const child of children.get(id) ?? []) stack.push(child);
	}
	return out;
}

/**
 * The memory price of rewriting or deleting a turn, asked BEFORE it happens.
 *
 * architecture/chat-sessions.md coupling 3: the transcript is not the only delete/edit
 * surface any more, and a second door that skipped these numbers would let a summarised
 * turn go with nothing said about what it cost. This is that door paying the same debt,
 * through the same pure functions (`changeImpact`, `describeMemoryImpact`), so the wording
 * cannot drift from the confirmation the chat shows for the identical act.
 *
 * Returns null when the chat has no memory in play or the change touches none of it, which
 * is the common case and must stay free of noise.
 */
export function memoryCostOfMessageChange(messageId: string, mode: 'edit' | 'delete' | 'delete_subtree'): MemoryCost | null {
	const raw = serverDb.getMessage(messageId) as RawMessage | null;
	if (!raw) return null;
	const state = serverDb.memGetState(raw.chatId) as RawMemoryState | null;
	if (!state?.enabled) return null;
	const removed = mode !== 'edit';
	const changedIds = mode === 'delete_subtree' ? subtreeIds(raw.chatId, messageId) : [messageId];
	const { coverage, memPath } = memoryCoverage(raw.chatId, state, activePathMessages(raw.chatId));
	const config = resolveConfig(state.config);
	const impact = changeImpact(memPath, coverage, changedIds, { removed, batchSize: config.batchSize, verbatimTail: config.verbatimTail });
	if (!impact.dropped && !impact.droppedStored) return null;
	return {
		summariesDropped: impact.dropped,
		summariesDroppedElsewhere: impact.droppedStored,
		summariesPaused: impact.paused,
		turnsReread: impact.reread,
		passes: impact.passes,
		span: impact.span,
		says: describeMemoryImpact(impact, { mode: removed ? 'delete' : 'edit', auto: state.autoExtract })
	};
}

/** One line for the panel row: the numbers a reader scans, not the full sentences. */
export function memoryCostLabel(cost: MemoryCost): string {
	const parts = [`${cost.summariesDropped} ${cost.summariesDropped === 1 ? 'summary' : 'summaries'} dropped`];
	if (cost.summariesPaused) parts.push(`${cost.summariesPaused} paused`);
	if (cost.turnsReread) parts.push(`${cost.turnsReread} ${cost.turnsReread === 1 ? 'turn' : 'turns'} re-read`);
	return `memory: ${parts.join(', ')}`;
}

export const readMemoryState: Capability = {
	name: 'read_memory_state',
	summary:
		"Read a chat's long-term memory state: whether memory is enabled, where the archive cursor sits on the active thread (messages up to it are folded into memory; after it they are live/verbatim), and the memory itself (the layered episode summaries, oldest first, which are the only record of the folded turns). Each summary carries its id and the exact seq range it was written from, so read_chat_messages (fromSeq/toSeq) can fetch the turns behind any one of them and edit_memory_episode can correct it. THE tool for \"which messages aren't in memory yet\" (answer: the live seq range) and for fact-checking what the story's memory says against what actually happened.",
	risk: 'read',
	params: [{ name: 'chatId', type: 'string', describe: 'The chat to read.', required: true }],
	run(args, ctx) {
		const chatId = requireChatId(args.chatId);
		const chat = serverDb.getChat(chatId) as RawChat | null;
		if (!chat) throw new ToolError(`No chat with id "${chatId}".`);
		// One path walk serves both the total and the cursor resolution below.
		const path = activePathMessages(chatId);
		const total = path.length;
		const state = serverDb.memGetState(chatId) as RawMemoryState | null;
		if (!state?.enabled) {
			return ok(
				{ type: 'read_memory_state', label: `Memory is off for ${chat.title}` },
				{
					chatId,
					chatTitle: chat.title,
					enabled: false,
					totalMessages: total,
					note: 'Chat memory is not enabled for this chat: nothing is folded into memory, all messages are live. The user can enable it from the Memory panel.',
					// Claimed even while off: enabling memory later is exactly the change the
					// next turn's state note should announce.
					...stampState(['memory', chatId])
				}
			);
		}

		// The boundary is not stored: it is derived by tiling THIS path with the episodes'
		// own coverage, which is what makes the same episodes answer differently on a branch.
		// Same call the app makes, same module, so this report can't drift from the prompt.
		const { coverage, ranges } = memoryCoverage(chatId, state, path);
		const archived = coverage.archivedIds.size;
		const live = total - archived;

		const byLayer: Record<string, number> = {};
		for (const e of coverage.active) byLayer[String(e.layer)] = (byLayer[String(e.layer)] ?? 0) + 1;

		return ok(
			{ type: 'read_memory_state', label: `Read memory state of ${chat.title}` },
			{
				chatId,
				chatTitle: chat.title,
				// Coverage is resolved against THIS branch; on another one the same episodes
				// answer differently, so the stamp travels with the answer.
				activeLeafId: path.length ? path[path.length - 1].id : null,
				enabled: true,
				autoExtract: state.autoExtract,
				totalMessages: total,
				archivedMessages: archived,
				liveMessages: live,
				...(archived ? { archivedRange: `seq 1–${archived}` } : {}),
				liveRange: live > 0 ? `seq ${archived + 1}–${total}` : null,
				boundaryMessageId: coverage.cursorMessageId,
				...(coverage.dormant.length
					? {
							note: `${coverage.dormant.length} further ${coverage.dormant.length === 1 ? 'summary belongs' : 'summaries belong'} to other branches of this chat (or sit inside the verbatim tail) and are not in play on this thread. They are intact and apply again if the reader returns to them.`
						}
					: {}),
				episodes: {
					count: coverage.active.length,
					countsByLayer: byLayer,
					// The seq range is what makes a summary checkable: it names the exact turns
					// it was written from, so a doubted claim is one read_chat_messages away
					// rather than a guess at which part of the thread it came from. A layer > 0
					// summary is a merge of several batches, so its range is correspondingly
					// wider and its detail correspondingly thinner.
					items: coverage.active.map((e) => ({
						id: e.id,
						layer: e.layer,
						fromSeq: ranges.get(e.id)?.from ?? null,
						toSeq: ranges.get(e.id)?.to ?? null,
						content: e.content
					}))
				},
				...stampState(['memory', chatId])
			}
		);
	}
};

export const editMemoryEpisode: Capability = {
	name: 'edit_memory_episode',
	summary:
		"Rewrite one memory summary's TEXT, for when it records something the turns it covers do not actually say. Take its id and seq range from read_memory_state, read those turns with read_chat_messages to check the claim, then pass the corrected summary whole. Prose only: coverage, count and re-folding all belong to the engine. It combines with fixing the messages only if you fixed them with a quiet save (`minor: true` on edit_entity/set_entity), which leaves the summary standing; after an ordinary edit the engine rewrites the summary from the corrected text and yours is thrown away.",
	risk: 'write',
	params: [
		{ name: 'chatId', type: 'string', describe: 'The chat the summary belongs to.', required: true },
		{ name: 'episodeId', type: 'string', describe: 'The summary to rewrite, from read_memory_state.', required: true },
		{
			name: 'content',
			type: 'string',
			describe: 'The full replacement text. Keep the voice and density of the surrounding summaries: past tense, named specifics, no framing sentences about memory itself.',
			required: true
		}
	],
	run(args, ctx) {
		const chatId = requireChatId(args.chatId);
		const chat = serverDb.getChat(chatId) as RawChat | null;
		if (!chat) throw new ToolError(`No chat with id "${chatId}".`);
		const episodeId = requireStr(args.episodeId, 'episodeId').trim();
		if (!episodeId) throw new ToolError('`episodeId` is required: take it from read_memory_state.');
		// An empty summary is not an erasure the engine can recover from: coverage stays, so
		// those turns would be recalled as a blank and nothing would ever re-read them.
		const content = requireStr(args.content, 'content').trim();
		if (!content) throw new ToolError('`content` cannot be empty: a summary with no text leaves its turns recalled as nothing. Rewrite it, or leave it alone.');
		const state = serverDb.memGetState(chatId) as RawMemoryState | null;
		if (!state?.enabled) {
			throw new ToolError(`Memory is off for "${chat.title}", so there are no summaries in play to correct.`);
		}

		const { episodes, coverage, ranges } = memoryCoverage(chatId, state, activePathMessages(chatId));
		const episode = episodes.find((e) => e.id === episodeId);
		if (!episode) throw new ToolError(`No summary with id "${episodeId}" in this chat. Re-read read_memory_state for the current ids.`);
		// A dead summary is one the engine is about to reap: a turn it covers was deleted or
		// rewritten under it, so the row survives only until the next reconcile pass and a
		// rewrite here would be thrown away with it. Refusing names the real fix.
		if (coverage.dead.some((e) => e.id === episodeId)) {
			throw new ToolError(
				'That summary is already out of date: a turn it covers was edited or deleted since it was written, so the engine will discard it and re-read those turns. Nothing to correct here; the fresh summary will come from the messages as they now stand.'
			);
		}

		const before = episode.content;
		if (before.trim() === content) throw new ToolError('That is the summary\'s current text, so there is nothing to change.');
		serverDb.memUpdateEpisodeContent(chatId, episodeId, content);
		ctx.broadcast('memory');

		const range = ranges.get(episodeId);
		const where = range ? `turns ${range.from} to ${range.to}` : 'turns on another branch';
		return ok(
			{
				type: 'edit_memory_episode',
				id: episodeId,
				label: `Rewrote the memory summary of ${where} in ${chat.title}`,
				diff: { before, after: content, title: `Memory · ${where}` }
			},
			{
				chatId,
				episodeId,
				...(range ? { fromSeq: range.from, toSeq: range.to } : {}),
				// A summary off this thread is stored and correct, it just isn't what the reader
				// is being served: saying so beats letting the user wonder why nothing changed.
				...(coverage.dormant.some((e) => e.id === episodeId)
					? { note: 'This summary belongs to another branch of the chat (or sits inside the verbatim tail), so it is not in play on the current thread. The change is stored and applies when the reader returns to those turns.' }
					: {}),
				...stampState(['memory', chatId])
			}
		);
	},
	preview(args) {
		const chatId = requireChatId(args.chatId);
		const chat = serverDb.getChat(chatId) as RawChat | null;
		if (!chat) throw new ToolError(`No chat with id "${chatId}".`);
		const state = serverDb.memGetState(chatId) as RawMemoryState | null;
		if (!state?.enabled) throw new ToolError(`Memory is off for "${chat.title}", so there are no summaries in play to correct.`);
		const episodeId = requireStr(args.episodeId, 'episodeId').trim();
		const { episodes, ranges } = memoryCoverage(chatId, state, activePathMessages(chatId));
		const episode = episodes.find((e) => e.id === episodeId);
		if (!episode) throw new ToolError(`No summary with id "${episodeId}" in this chat.`);
		const range = ranges.get(episodeId);
		const where = range ? `turns ${range.from} to ${range.to}` : 'turns on another branch';
		return {
			act: 'Rewrite memory summary',
			within: chat.title,
			label: `The summary of ${where}`,
			actNotes: [{ text: 'Only the wording changes: which turns it covers, and when it is re-read, stay the engine\'s.' }],
			diff: { before: episode.content, after: str(args.content).trim(), title: `Memory · ${where}` }
		};
	}
};
