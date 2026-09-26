/**
 * Freshness: how the assistant knows an earlier read is still true.
 *
 * Every read or write of tracked story state stamps its model-facing result with
 * `stateRevs` (stampState / stampGone): one content-revision claim per thing it handed
 * over. The stamps persist inside the tab's context like the rest of the result, so the
 * conversation itself is the ledger of what the model has seen and at which revision:
 * no parallel store, nothing to migrate, and the context trim prunes claims and
 * knowledge together. Before each turn the loop asks `stalenessNote`: every claim is
 * re-checked against the workspace, and anything that moved (the user editing in the
 * app, another device or tab, a version switch, the roleplay carrying on) is named in
 * one system note pinned after the user turn. Nothing moved, no note, zero tokens.
 *
 * A revision hashes state AS THE ASSISTANT CAN SEE IT through its tools, never
 * timestamps (a persona rebind bumps none) and never invisible metadata (isFavorite,
 * story-map labels), so a note fires exactly when the model's knowledge went stale.
 * The claim and the check are the same function: a stamp IS the current revision at
 * result time, so a stamped kind without a resolver cannot exist.
 */
import { serverDb } from '../db';
import type { Episode } from '../../src/lib/memory/types';
import type { RawChat, RawCharacterVersion, RawLibraryEntry, RawLorebookBook, RawMessage } from './rows';
import { lorebookRevisionView, lorebookTextView, parseLorebookDefaults } from './lorebook-core';
import { LOREBOOK_SETTINGS_KEY } from '../../src/lib/lorebook/types';
import {
	claimKey,
	collectStateClaims,
	formatStateNote,
	REV_GONE,
	revHash,
	type ClaimSource,
	type StaleEntry
} from './freshness-core';

interface CurrentState {
	rev: string;
	label: string;
}

function libraryState(kind: 'character' | 'persona', id: string): CurrentState | null {
	const raw = serverDb.getLibraryEntry(id) as RawLibraryEntry | null;
	if (!raw || raw.type !== kind) return null;
	// identity + data cover everything the tools expose: fields, tags, alternate
	// greetings, portrait/gallery paths, lorebook links. Version rows join in so a
	// roster change (create/rename/delete) and a version switch both move the revision.
	const versions = (serverDb.getCharacterVersionsByEntry(id) as RawCharacterVersion[]).map((v) => [v.id, v.name, v.data]);
	return {
		rev: revHash({ identity: raw.identity, data: raw.data, activeVersionId: raw.activeVersionId ?? null, versions }),
		label: `${kind} "${raw.identity.name}"`
	};
}

function messageState(id: string): CurrentState | null {
	const raw = serverDb.getMessage(id) as RawMessage | null;
	if (!raw) return null;
	const chat = serverDb.getChat(raw.chatId) as RawChat | null;
	return {
		// The same five fields the message entity exposes. edited_at stays out: a quiet
		// save moves minor_edited_at only, and neither timestamp changes what was read.
		rev: revHash({
			content: raw.content,
			personaId: raw.personaId ?? null,
			role: raw.role,
			chatId: raw.chatId,
			parentId: raw.parentId ?? null
		}),
		label: `a ${raw.role} message${chat ? ` in "${chat.title}"` : ''}`
	};
}

function loadBook(id: string): RawLorebookBook | null {
	const raw = serverDb.getLorebook(id) as RawLorebookBook | null;
	return raw ? { ...raw, entries: Array.isArray(raw.entries) ? raw.entries : [] } : null;
}

/** A book as its light reads and its map show it (lorebook-core.ts). SillyTavern baggage in
 *  `rest`, the cover and the extensions stay out: no tool surfaces them. */
function lorebookState(id: string): CurrentState | null {
	const book = loadBook(id);
	return book ? { rev: revHash(lorebookRevisionView(book)), label: `lorebook "${book.name}"` } : null;
}

/** Its entries' text, claimed apart: only a read or a write that hands text over vouches for it. */
function lorebookTextState(id: string): CurrentState | null {
	const book = loadBook(id);
	return book ? { rev: revHash(lorebookTextView(book)), label: `the entry text in lorebook "${book.name}"` } : null;
}

/** The one row every book falls back to. A row that will not parse hashes as it stands, so
 *  repairing it still reads as a change. */
function lorebookDefaultsState(): CurrentState {
	const raw = serverDb.getSetting(LOREBOOK_SETTINGS_KEY);
	let rev: string;
	try {
		rev = revHash(parseLorebookDefaults(raw));
	} catch {
		rev = revHash({ unreadable: raw });
	}
	return { rev, label: 'the lorebook defaults' };
}

function chatState(id: string): CurrentState | null {
	const chat = serverDb.getChat(id) as RawChat | null;
	if (!chat) return null;
	// EVERY branch, deliberately: the model can read and write off-path rows, so a
	// foreign edit there stales its knowledge like an on-path one. Sorted by id so the
	// physical row order can never fake a change. The active leaf joins in: a swipe
	// (same rows, different thread) moves every seq the model holds, so a chat claim
	// covers which thread is being read as well as what the rows hold. This is the
	// signal for a branch move on a chat the workspace note is NOT stamping.
	const rows = (serverDb.getMessagesByChat(id) as RawMessage[])
		.map((m) => [m.id, m.parentId ?? null, m.role, m.content, m.personaId ?? null] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return {
		rev: revHash({
			title: chat.title,
			characterId: chat.characterId ?? null,
			characterVersionId: chat.characterVersionId ?? null,
			activeLeafId: chat.activeLeafId ?? null,
			rows
		}),
		label: `chat "${chat.title}"`
	};
}

function memoryStateOf(chatId: string): CurrentState | null {
	const chat = serverDb.getChat(chatId) as RawChat | null;
	if (!chat) return null;
	const state = serverDb.memGetState(chatId) as { enabled: boolean; autoExtract: boolean; config: unknown } | null;
	const label = `the memory state of "${chat.title}"`;
	// Disabled memory has exactly one fact to it. Hashing more would announce changes
	// to an answer ("memory is off") that is still true.
	if (!state?.enabled) return { rev: revHash({ enabled: false }), label };
	const episodes = (serverDb.memListEpisodes(chatId) as Episode[]).map((e) => [
		e.id,
		e.layer,
		e.content,
		e.sourceMessageIds,
		e.anchorMessageId
	]);
	// The memory ANSWER derives from the episodes AND the tree they tile (boundary,
	// live ranges, dead summaries keyed on edited_at), so the structural inputs join
	// the hash: a chat that moved on stales a memory read even before any fold runs.
	const msgs = (serverDb.getMessagesByChat(chatId) as RawMessage[])
		.map((m) => [m.id, m.parentId ?? null, m.editedAt ?? null] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return {
		rev: revHash({
			enabled: true,
			autoExtract: state.autoExtract,
			config: state.config ?? null,
			episodes,
			msgs,
			activeLeafId: chat.activeLeafId ?? null
		}),
		label
	};
}

/**
 * Everything a claim can be made about. Kinds outside this table are deliberately
 * untracked, each for a stated reason: skill bodies are read live at need, the settings
 * catalog is static per build, connection state and the prompt log are point-in-time
 * diagnostics, and list/find results are indexes rather than knowledge.
 */
const RESOLVERS: Record<string, (id: string) => CurrentState | null> = {
	character: (id) => libraryState('character', id),
	persona: (id) => libraryState('persona', id),
	message: messageState,
	lorebook: lorebookState,
	lorebook_text: lorebookTextState,
	// One row, so one id: `lorebook_defaults:global`.
	lorebook_defaults: () => lorebookDefaultsState(),
	chat: chatState,
	memory: memoryStateOf
};

/** Whether results about this kind carry freshness claims. */
export function isTracked(kind: string): boolean {
	return kind in RESOLVERS;
}

function currentState(kind: string, id: string): CurrentState | null {
	const resolve = RESOLVERS[kind];
	// A claim that cannot be re-checked must not exist, and a resolver removed from
	// under persisted claims is a refactor bug this throw is meant to surface.
	if (!resolve) throw new Error(`No freshness resolver for kind "${kind}" (freshness.ts).`);
	return resolve(id);
}

/**
 * The `stateRevs` fragment a result spreads into its model-facing payload: one claim
 * per (kind, id), computed NOW, right after the read or write it rides. Throws on an
 * untracked kind and on a row that does not resolve (deletes stamp stampGone instead):
 * both are registration bugs, never data states.
 */
export function stampState(...refs: [kind: string, id: string][]): { stateRevs: Record<string, string> } {
	const stateRevs: Record<string, string> = {};
	for (const [kind, id] of refs) {
		const state = currentState(kind, id);
		if (!state) throw new Error(`Cannot stamp ${kind} "${id}": the row does not resolve. A delete stamps stampGone().`);
		stateRevs[claimKey(kind, id)] = state.rev;
	}
	return { stateRevs };
}

/**
 * The delete-side stamp: the model made it gone, so `gone` is the fresh claim and the
 * next turn stays silent instead of announcing the assistant's own delete as foreign.
 */
export function stampGone(kind: string, id: string): { stateRevs: Record<string, string> } {
	if (!isTracked(kind)) throw new Error(`No freshness resolver for kind "${kind}" (freshness.ts).`);
	return { stateRevs: { [claimKey(kind, id)]: REV_GONE } };
}

/**
 * The per-turn check: every claim in the conversation against the workspace as it
 * stands. Returns the state note to pin after the user turn, or '' when nothing moved
 * (the common case, which costs nothing).
 */
export function stalenessNote(conversation: ClaimSource[]): string {
	const claims = collectStateClaims(conversation);
	if (!claims.size) return '';
	const stale: { kind: string; id: string; key: string; rev: string; label: string }[] = [];
	for (const [key, rev] of claims) {
		const sep = key.indexOf(':');
		const kind = key.slice(0, sep);
		const id = key.slice(sep + 1);
		const state = currentState(kind, id);
		const current = state?.rev ?? REV_GONE;
		if (current === rev) continue;
		stale.push({ kind, id, key, rev: current, label: state?.label ?? `the ${kind} with id ${id}` });
	}
	if (!stale.length) return '';

	// A chat and its memory going stale together is one event to the reader (the
	// roleplay moved on): one clause, both tokens, so both claims still update. The
	// pairing is computed up front, so the claims' iteration order cannot double-emit.
	const staleChatIds = new Set(stale.filter((s) => s.kind === 'chat').map((s) => s.id));
	const memoryByChat = new Map(stale.filter((s) => s.kind === 'memory' && staleChatIds.has(s.id)).map((s) => [s.id, s]));
	const entries: StaleEntry[] = [];
	for (const s of stale) {
		if (s.kind === 'memory' && memoryByChat.has(s.id)) continue; // folded into its chat's clause
		if (s.kind === 'chat' && memoryByChat.has(s.id)) {
			const memory = memoryByChat.get(s.id)!;
			entries.push({
				label: `${s.label} (its messages or branch, and its memory state)`,
				gone: s.rev === REV_GONE,
				refs: [
					{ key: s.key, rev: s.rev },
					{ key: memory.key, rev: memory.rev }
				]
			});
			continue;
		}
		entries.push({ label: s.label, gone: s.rev === REV_GONE, refs: [{ key: s.key, rev: s.rev }] });
	}
	return formatStateNote(entries);
}
