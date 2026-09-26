/**
 * Lorebook-entry capabilities: read any book's entries, or search every book at once, and
 * add/edit/remove entries by id. The book itself (name, create/delete) is managed through the
 * generic entity tools, and every setting (the defaults', a book's, an entry's) through
 * lorebook-settings.ts; these operate on what an entry SAYS, inside one book by lorebookId.
 *
 * The plumbing both modules share lives here: loading a book and the defaults, and reading
 * which entries a call names.
 */
import { serverDb } from '../../db';
import type { ApprovalPreview, AssistantContext, AssistantToolResult } from '../types';
import type { Capability } from './types';
import type { RawLibraryEntry, RawLorebookBook, RawLorebookEntry } from '../rows';
import { stampState } from '../freshness';
import { BEHAVIORS, entryRow, facetDefaults, parseLorebookDefaults, parseWhere, selectEntries, type EntrySelector } from '../lorebook-core';
import { DEFAULT_LOREBOOK_GLOBAL_SETTINGS, LOREBOOK_SETTINGS_KEY, pruneKeyRules, type LorebookGlobalSettings } from '../../../src/lib/lorebook/types';
import { estimateTextTokens, INLINE_CONTENT_TOKEN_LIMIT } from './schema';
import { ToolError, str, requireStr, strList, intArg, oneOf, boolArg, ok } from './util';

/** Load a book (entries normalized to an array), or a loud error. */
export function loadLorebookBook(lorebookId: unknown): RawLorebookBook {
	const id = str(lorebookId).trim();
	if (!id) throw new ToolError('A lorebookId is required. Use find_entities kind:lorebook to list books, or read_chat_context for the ones in the scene.');
	const raw = serverDb.getLorebook(id) as RawLorebookBook | null;
	if (!raw) throw new ToolError(`No lorebook with id "${id}".`);
	if (!Array.isArray(raw.entries)) raw.entries = [];
	return raw;
}

/** The defaults every book falls back to. A row that will not parse is refused, never
 *  overwritten: the next write would otherwise make the loss permanent. */
export function loadLorebookDefaults(): LorebookGlobalSettings {
	try {
		return parseLorebookDefaults(serverDb.getSetting(LOREBOOK_SETTINGS_KEY));
	} catch (e) {
		throw new ToolError(`The lorebook defaults are stored in a form that cannot be read (${e instanceof Error ? e.message : String(e)}), so they were left alone. Tell the user.`);
	}
}

/** Which entries a call names. Every picker given narrows; an empty `where` names nothing. */
export function readEntrySelector(args: Record<string, unknown>): EntrySelector {
	const selector: EntrySelector = {};
	if (args.ids !== undefined) selector.ids = strList(args.ids, 'ids');
	if (args.query !== undefined) {
		const query = requireStr(args.query, 'query').trim();
		if (query) selector.query = query;
	}
	if (args.where !== undefined) {
		if (!args.where || typeof args.where !== 'object' || Array.isArray(args.where)) throw new ToolError('`where` must be an object.');
		const where = args.where as Record<string, unknown>;
		const parsed = parseWhere(where);
		if ('problems' in parsed) throw new ToolError(parsed.problems.join(' '));
		if (Object.keys(where).length > 0) selector.where = parsed;
	}
	return selector;
}

/** What a write to an entry's text re-claims: the book as its rows show it, and its text. */
function movedBook(bookId: string): [string, string][] {
	return [
		['lorebook', bookId],
		['lorebook_text', bookId]
	];
}

/** The character or persona whose links are being changed, or a loud error. */
function loadLinkTarget(entryId: unknown): RawLibraryEntry {
	const entry = serverDb.getLibraryEntry(str(entryId).trim()) as RawLibraryEntry | null;
	if (!entry || (entry.type !== 'character' && entry.type !== 'persona')) {
		throw new ToolError(`No character or persona with id "${str(entryId)}". Use find_entities to locate the right id.`);
	}
	return entry;
}

/** Locate one entry inside a loaded book, or a loud error (the same lookup every write and
 *  every preview of a write makes). */
function findEntry(book: RawLorebookBook, entryId: unknown): RawLorebookEntry {
	const entry = book.entries.find((e) => e.id === str(entryId).trim());
	if (!entry) throw new ToolError(`No lorebook entry with id "${str(entryId)}" in book "${book.name}". Use read_lorebook_entries for ids.`);
	return entry;
}

function tokensPhrase(tokens: number): string {
	return tokens >= 1000 ? `~${Math.round(tokens / 1000)}k tokens` : `~${tokens} tokens`;
}

/**
 * The most one page may take. A page is persisted verbatim and a turn cannot be trimmed apart,
 * so it answers to the room the conversation has left, the rule the file reads live by: a
 * named `limit` is a deliberate size and may spend that room, while no limit is not a request
 * for any particular amount and only takes what may land unasked.
 */
function pageCeiling(ctx: AssistantContext, explicit: boolean): { ceiling: number; byRoom: boolean } {
	const room = ctx.roomTokens ? ctx.roomTokens() : null;
	if (explicit) return { ceiling: room ?? INLINE_CONTENT_TOKEN_LIMIT, byRoom: true };
	const ceiling = Math.min(INLINE_CONTENT_TOKEN_LIMIT, room ?? INLINE_CONTENT_TOKEN_LIMIT);
	return { ceiling, byRoom: room !== null && room < INLINE_CONTENT_TOKEN_LIMIT };
}

/**
 * Whole rows from `offset` on, until `limit` rows or the ceiling: an entry is never cut, so a
 * page ends early instead. A first row that alone outgrows the ceiling is refused with its size.
 */
function fillPage<T>(items: readonly T[], offset: number, limit: number, ceiling: number, explicit: boolean, row: (item: T) => Record<string, unknown>): { rows: { item: T; row: Record<string, unknown> }[]; early: boolean } {
	const rows: { item: T; row: Record<string, unknown> }[] = [];
	let spent = 0;
	for (const item of items.slice(offset, offset + limit)) {
		const r = row(item);
		const cost = estimateTextTokens(JSON.stringify(r));
		if (spent + cost > ceiling) {
			if (rows.length > 0) return { rows, early: true };
			throw new ToolError(
				explicit
					? `The entry at offset ${offset} is ${tokensPhrase(cost)} and this conversation has ${tokensPhrase(ceiling)} of room left. Ask the user whether to start a new tab.`
					: `The entry at offset ${offset} is ${tokensPhrase(cost)}, more than a read may take unasked. Read it alone with offset:${offset}, limit:1.`
			);
		}
		spent += cost;
		rows.push({ item, row: r });
	}
	return { rows, early: false };
}

/** Where a page ends and how to go on, or nothing when it is the last. An early end names what
 *  ended it, since only one of the two can be raised by asking for more. */
function pageNote(matched: number, offset: number, returned: number, early: boolean, byRoom: boolean, filtered: boolean): Record<string, unknown> {
	if (matched === 0) return { note: filtered ? 'No entry matches.' : 'The book has no entries.' };
	if (returned === 0) return { note: `Only ${matched} match, so offset ${offset} is past the last one.` };
	const shownTo = offset + returned;
	const remaining = matched - shownTo;
	if (remaining <= 0) return {};
	const why = !early
		? ''
		: byRoom
			? ' The page ended early to stay inside the room this conversation has left.'
			: ' The page ended early at what a read may take unasked; a limit takes more of the room.';
	return { note: `${remaining} more match${remaining === 1 ? '' : 'es'}: offset:${shownTo} continues.${why}` };
}

const WHERE_DESCRIBE =
	"Filter by settings: {setting: answer or [answers]}, named and valued as configure_lorebook_entries' set, reading the value in force (an entry following its book answers with the book's). Unset answers \"none\" (triggers: \"all\"); timing answers which of sticky, cooldown, delay are set; foreign: a SillyTavern-only placement (lands in the block) or trigger list (never fires); wokenBy never: an import that never fires; order takes {from, to}.";

export const readLorebookEntries: Capability = {
	name: 'read_lorebook_entries',
	summary:
		"Page through one book's entries, or search every book at once: a row per entry with its id, title, keys, behavior, order, and `sets` (the settings it changes; absent = default or its book's).",
	risk: 'read',
	params: [
		{ name: 'lorebookId', type: 'string', describe: 'The book. Omit to search every book, which needs a query or where.' },
		{ name: 'query', type: 'string', describe: 'Case-insensitive substring of the title, keys or text.' },
		{ name: 'where', type: 'object', freeform: true, describe: WHERE_DESCRIBE },
		{ name: 'content', type: 'boolean', describe: "Include each entry's full text (read it before editing one). Default false." },
		{ name: 'limit', type: 'integer', describe: 'Entries per page, default 30.', minimum: 1 },
		{ name: 'offset', type: 'integer', describe: 'Skip this many matches.', minimum: 0 }
	],
	run(args, ctx) {
		const selector = readEntrySelector(args);
		const withContent = args.content === undefined ? false : boolArg(args.content, 'content');
		const explicit = args.limit !== undefined;
		const limit = explicit ? intArg(args.limit, 'limit', 1) : 30;
		const offset = args.offset === undefined ? 0 : intArg(args.offset, 'offset', 0);
		const { ceiling, byRoom } = pageCeiling(ctx, explicit);
		// Only `where` reads the defaults (a switch following its book answers with the book's),
		// so a defaults row that will not parse refuses a filtered read and no other.
		const defaults = selector.where ? loadLorebookDefaults() : DEFAULT_LOREBOOK_GLOBAL_SETTINGS;
		const filtered = !!(selector.ids || selector.query || selector.where);

		if (str(args.lorebookId).trim()) {
			const book = loadLorebookBook(args.lorebookId);
			const matched = selectEntries(book.entries, selector, facetDefaults(book, defaults));
			const { rows, early } = fillPage(matched, offset, limit, ceiling, explicit, (e) => entryRow(e, withContent));
			const name = book.name.trim() || 'Untitled lorebook';
			return ok(
				{
					type: 'read_lorebook_entries',
					id: book.id,
					name,
					label: rows.length === matched.length ? `Read ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} from ${name}` : `Read ${rows.length} of ${matched.length} entries from ${name}`
				},
				{
					lorebookId: book.id,
					name: book.name,
					total: book.entries.length,
					matched: matched.length,
					offset,
					returned: rows.length,
					entries: rows.map((r) => r.row),
					...pageNote(matched.length, offset, rows.length, early, byRoom, filtered),
					// The text is vouched for only by a read that hands it over.
					...stampState(['lorebook', book.id], ...(withContent ? [['lorebook_text', book.id] as [string, string]] : []))
				}
			);
		}

		if (!selector.query && !selector.where) {
			throw new ToolError('Searching every book needs a query or where. To page through one book, pass its lorebookId.');
		}
		// Oldest first, as the chat resolver orders books: a page boundary must not move when a
		// book is edited between two pages, which the store's last-written order would do.
		const books = (serverDb.getAllLorebooks() as RawLorebookBook[])
			.map((b) => ({ ...b, entries: Array.isArray(b.entries) ? b.entries : [] }))
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
		const hits = books.flatMap((book) => selectEntries(book.entries, selector, facetDefaults(book, defaults)).map((entry) => ({ book, entry })));
		const { rows, early } = fillPage(hits, offset, limit, ceiling, explicit, ({ entry }) => entryRow(entry, withContent));
		const results: { lorebookId: string; name: string; entries: Record<string, unknown>[] }[] = [];
		for (const { item, row } of rows) {
			const last = results[results.length - 1];
			if (last?.lorebookId === item.book.id) last.entries.push(row);
			else results.push({ lorebookId: item.book.id, name: item.book.name, entries: [row] });
		}
		// A search is an index, not knowledge: it claims nothing, and acting on a row still
		// takes the book's own read.
		return ok(
			{ type: 'read_lorebook_entries', label: `Searched ${books.length} lorebook${books.length === 1 ? '' : 's'}: ${hits.length} match${hits.length === 1 ? '' : 'es'}` },
			{ books: books.length, matched: hits.length, offset, returned: rows.length, results, ...pageNote(hits.length, offset, rows.length, early, byRoom, true) }
		);
	}
};

/** What a behavior asks of the two stored flags. */
function natureFlags(behavior: (typeof BEHAVIORS)[number]): { constant: boolean; disable: boolean } {
	return { constant: behavior === 'always', disable: behavior === 'off' };
}

/** A model can still send `constant` or `enabled` copied from an older call in its context.
 *  Dropped in silence, an always-on entry would land as a keyword one, so naming them fails. */
function refuseRetiredFlags(args: Record<string, unknown>, instead: string): void {
	const named = ['constant', 'enabled'].filter((key) => args[key] !== undefined);
	if (named.length) throw new ToolError(`${named.map((k) => `\`${k}\``).join(' and ')} ${named.length === 1 ? 'is' : 'are'} not taken here: ${instead}.`);
}

export const createLorebookEntry: Capability = {
	name: 'create_lorebook_entry',
	summary: 'Add an entry to a lorebook: a world fact injected into context when its keywords appear. Create the book first with create_entity kind:lorebook, or reuse one from read_chat_context / find_entities kind:lorebook. Its other settings: configure_lorebook_entries.',
	risk: 'write',
	params: [
		{ name: 'lorebookId', type: 'string', describe: 'The book to add the entry to.', required: true },
		{ name: 'content', type: 'string', describe: 'The lore text injected into context.', required: true },
		{ name: 'comment', type: 'string', describe: 'Short title for the entry (organizational; never injected).' },
		{ name: 'keys', type: 'string', describe: 'Comma-separated trigger keywords.' },
		{ name: 'secondaryKeys', type: 'string', describe: 'Comma-separated keywords narrowing a primary match: by default one of them must also appear.' },
		{ name: 'behavior', type: 'string', describe: 'keyword (default), always or off.', enum: BEHAVIORS }
	],
	run(args, ctx) {
		refuseRetiredFlags(args, 'pass behavior (always, keyword or off)');
		const book = loadLorebookBook(args.lorebookId);
		const content = str(args.content).trim();
		if (!content) throw new ToolError('create_lorebook_entry requires content.');
		const behavior = args.behavior === undefined ? 'keyword' : oneOf(args.behavior, 'behavior', BEHAVIORS);
		const entry: RawLorebookEntry = {
			id: crypto.randomUUID(),
			comment: args.comment === undefined ? '' : requireStr(args.comment, 'comment'),
			// Reads return keys as arrays, so models echo both shapes; anything else fails loud.
			key: args.keys === undefined ? [] : strList(args.keys, 'keys'),
			keysecondary: args.secondaryKeys === undefined ? [] : strList(args.secondaryKeys, 'secondaryKeys'),
			selectiveLogic: 0,
			content,
			...natureFlags(behavior),
			order: book.entries.length * 100,
			probability: 100,
			useProbability: true,
			caseSensitive: null,
			matchWholeWords: null,
			rest: {}
		};
		book.entries.push(entry);
		serverDb.updateLorebook(book);
		ctx.broadcast('lorebooks');
		const label = entry.comment || content.slice(0, 40);
		return ok({ type: 'create_lorebook_entry', id: entry.id, name: label, label: `Created lorebook entry in ${book.name}` }, { id: entry.id, lorebookId: book.id, ...stampState(...movedBook(book.id)) });
	},
	preview(args) {
		refuseRetiredFlags(args, 'pass behavior (always, keyword or off)');
		const book = loadLorebookBook(args.lorebookId);
		const content = str(args.content).trim();
		// The refusal `run` makes, made here too, so the card never offers an entry the call refuses.
		if (!content) throw new ToolError('create_lorebook_entry requires content.');
		const keys = args.keys === undefined ? [] : strList(args.keys, 'keys');
		const behavior = args.behavior === undefined ? 'keyword' : oneOf(args.behavior, 'behavior', BEHAVIORS);
		return {
			act: 'Add lorebook entry',
			within: book.name,
			label: str(args.comment).trim() || content.slice(0, 60),
			target: { kind: 'lorebook', id: book.id },
			// Whether it can ever fire is the one thing a reader cannot see in the text itself.
			notes: [
				behavior === 'always'
					? { text: 'Always in context, no keywords needed.' }
					: behavior === 'off'
						? { text: 'Switched off: it sits in the book and never injects until turned on.' }
						: keys.length
							? { text: `Injects when the story mentions: ${keys.join(', ')}.` }
							: { text: 'No keywords and not always active, so it would sit in the book and never inject.', warn: true }
			],
			diff: { before: '', after: content, title: str(args.comment).trim() || 'New lorebook entry' }
		};
	}
};

export const editLorebookEntry: Capability = {
	name: 'edit_lorebook_entry',
	summary: "Change what an entry says (its title, text or keys) by id; only what you pass changes. How it fires is configure_lorebook_entries'.",
	risk: 'write',
	params: [
		{ name: 'lorebookId', type: 'string', describe: 'The book the entry belongs to.', required: true },
		{ name: 'id', type: 'string', describe: 'Lorebook entry id (from read_lorebook_entries or read_chat_context).', required: true },
		{ name: 'comment', type: 'string', describe: 'New title.' },
		{ name: 'content', type: 'string', describe: 'New lore text.' },
		{ name: 'keys', type: 'string', describe: 'New comma-separated keywords.' },
		{ name: 'secondaryKeys', type: 'string', describe: 'New comma-separated secondary keywords.' }
	],
	run(args, ctx) {
		refuseRetiredFlags(args, "an entry's behavior is configure_lorebook_entries' set.behavior");
		const book = loadLorebookBook(args.lorebookId);
		const entry = findEntry(book, args.id);
		// Which fields the call actually provided: a call that provides none is a no-op
		// and must fail loudly rather than report an edit that never happened.
		const touched: string[] = [];
		const touch = (key: keyof RawLorebookEntry) => touched.push(key);
		// Every PROVIDED field is applied or fails loud. A typeof gate instead silently
		// skips wrong-typed values (keys as the array a read returns!) and still reports
		// "Edited", telling the user a change happened when nothing did.
		const beforeContent = entry.content;
		if (args.comment !== undefined) { const v = requireStr(args.comment, 'comment'); touch('comment'); entry.comment = v; }
		if (args.content !== undefined) { const v = requireStr(args.content, 'content'); touch('content'); entry.content = v; }
		if (args.keys !== undefined) { const v = strList(args.keys, 'keys'); touch('key'); entry.key = v; }
		if (args.secondaryKeys !== undefined) { const v = strList(args.secondaryKeys, 'secondaryKeys'); touch('keysecondary'); entry.keysecondary = v; }
		if (!touched.length) {
			throw new ToolError('edit_lorebook_entry received nothing to change. Pass at least one of comment, content, keys, secondaryKeys; settings are configure_lorebook_entries\'.');
		}
		// A key that went takes its matching rule with it, as the editor's chips do: a rule left
		// behind would come back to life if the same word were added again.
		if (args.keys !== undefined || args.secondaryKeys !== undefined) {
			entry.keyRules = pruneKeyRules(entry.keyRules, [...entry.key, ...entry.keysecondary]);
		}
		serverDb.updateLorebook(book);
		ctx.broadcast('lorebooks');
		const name = entry.comment || entry.content.slice(0, 40);
		const result: AssistantToolResult = { type: 'edit_lorebook_entry', id: entry.id, name, label: `Edited lorebook entry in ${book.name}` };
		if (typeof args.content === 'string' && args.content !== beforeContent) {
			result.diff = { before: beforeContent, after: entry.content, title: `Lorebook · ${name}` };
		}
		return ok(result, { id: entry.id, lorebookId: book.id, ...stampState(...movedBook(book.id)) });
	},
	preview(args) {
		refuseRetiredFlags(args, "an entry's behavior is configure_lorebook_entries' set.behavior");
		const book = loadLorebookBook(args.lorebookId);
		const entry = findEntry(book, args.id);
		const name = entry.comment || entry.content.slice(0, 40);
		// Which fields the call actually provides, named the way the editor names them.
		const CHANGES: [string, string][] = [
			['comment', 'title'],
			['content', 'text'],
			['keys', 'keywords'],
			['secondaryKeys', 'secondary keywords']
		];
		const touched = CHANGES.filter(([key]) => args[key] !== undefined).map(([, label]) => label);
		const preview: ApprovalPreview = {
			act: 'Edit lorebook entry',
			within: book.name,
			label: name,
			target: { kind: 'lorebook', id: book.id },
			notes: touched.length ? [{ text: `Changes its ${touched.join(', ')}.` }] : [{ text: 'Nothing to change, so the call would be refused.', warn: true }]
		};
		if (args.content !== undefined) {
			preview.diff = { before: entry.content, after: requireStr(args.content, 'content'), title: `Lorebook · ${name}` };
		}
		return preview;
	}
};

/**
 * The activation half of the lorebook family: a book only ever INJECTS once something brings it
 * into a chat, and a link from its character or persona is the commonest way. Without this, the
 * assistant could author a whole book and then had to end with "now link it yourself"; the one
 * workflow it does best died on its last step.
 */
export const manageEntryLorebooks: Capability = {
	name: 'manage_entry_lorebooks',
	summary: 'Link or unlink a lorebook to a character or persona. A freshly created book usually wants a link right after. Book ids: find_entities kind:lorebook or read_chat_context; entry ids: find_entities kind:character/persona.',
	risk: 'write',
	params: [
		{ name: 'entryId', type: 'string', describe: 'The character or persona whose links to change.', required: true },
		{ name: 'lorebookId', type: 'string', describe: 'The book to link or unlink.', required: true },
		{ name: 'action', type: 'string', describe: 'What to do.', required: true, enum: ['link', 'unlink'] }
	],
	run(args, ctx) {
		const action = str(args.action).trim();
		if (action !== 'link' && action !== 'unlink') throw new ToolError(`\`action\` must be "link" or "unlink"; got "${action}".`);
		const entry = loadLinkTarget(args.entryId);
		const book = loadLorebookBook(args.lorebookId);
		const before = [...(entry.data.lorebookIds ?? [])];
		const linked = before.includes(book.id);
		if (action === 'link' && linked) throw new ToolError(`"${book.name}" is already linked to ${entry.identity.name}.`);
		if (action === 'unlink' && !linked) throw new ToolError(`"${book.name}" is not linked to ${entry.identity.name}, so there is nothing to unlink.`);
		const after = action === 'link' ? [...before, book.id] : before.filter((id) => id !== book.id);
		// An empty set means "no such key" in a stored entry, not an empty array.
		if (after.length) entry.data.lorebookIds = after;
		else delete entry.data.lorebookIds;
		entry.updatedAt = Date.now();
		serverDb.updateLibraryEntry(entry);
		ctx.broadcast('library');
		return ok(
			{
				type: 'manage_entry_lorebooks',
				kind: entry.type,
				id: entry.id,
				name: entry.identity.name,
				label: action === 'link' ? `Linked "${book.name}" to ${entry.identity.name}` : `Unlinked "${book.name}" from ${entry.identity.name}`
			},
			// Links live on the entry, so the entry is what this re-claims.
			{ entryId: entry.id, lorebookId: book.id, action, lorebookIds: after, ...stampState([entry.type, entry.id]) }
		);
	},
	preview(args) {
		const entry = loadLinkTarget(args.entryId);
		const book = loadLorebookBook(args.lorebookId);
		const unlink = str(args.action).trim() === 'unlink';
		return {
			act: unlink ? 'Unlink lorebook' : 'Link lorebook',
			label: `${book.name} ${unlink ? 'from' : 'to'} ${entry.identity.name}`,
			target: { kind: entry.type, id: entry.id },
			// Linking is the step that makes a book do anything at all, so the card says what
			// changes in the story rather than what changes on the entry.
			notes: [
				{
					text: unlink
						? `Chats with ${entry.identity.name} stop pulling anything from this book.`
						: `Chats with ${entry.identity.name} start pulling its entries in when their keywords come up.`
				}
			]
		};
	}
};

export const deleteLorebookEntry: Capability = {
	name: 'delete_lorebook_entry',
	summary: 'Remove an entry from a lorebook by id.',
	risk: 'delete',
	params: [
		{ name: 'lorebookId', type: 'string', describe: 'The book the entry belongs to.', required: true },
		{ name: 'id', type: 'string', describe: 'Lorebook entry id.', required: true }
	],
	run(args, ctx) {
		const book = loadLorebookBook(args.lorebookId);
		const removed = findEntry(book, args.id);
		book.entries.splice(book.entries.indexOf(removed), 1);
		serverDb.updateLorebook(book);
		ctx.broadcast('lorebooks');
		const name = removed.comment || removed.content.slice(0, 40);
		// The BOOK is re-claimed, not gone-stamped: the entry died, the book lives on.
		return ok({ type: 'delete_lorebook_entry', id: removed.id, name, label: `Deleted lorebook entry from ${book.name}` }, { id: removed.id, lorebookId: book.id, ...stampState(...movedBook(book.id)) });
	},
	preview(args) {
		const book = loadLorebookBook(args.lorebookId);
		const entry = findEntry(book, args.id);
		const name = entry.comment || entry.content.slice(0, 40);
		return {
			act: 'Delete lorebook entry',
			within: book.name,
			label: name,
			target: { kind: 'lorebook', id: book.id },
			diff: { before: entry.content, after: '', title: `Lorebook · ${name}` }
		};
	}
};
