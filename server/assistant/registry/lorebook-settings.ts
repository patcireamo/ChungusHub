/**
 * How lore fires, from the defaults down to one entry: one read that maps it and two writes
 * that change it, `configure_lorebooks` for the defaults and whole books and
 * `configure_lorebook_entries` for any selection of one book's entries.
 *
 * Both writes take their settings as one `set` object, the `update_entities` shape: what each
 * setting means is said once, in that object's own description, rather than paid for as a schema
 * per setting on every request. Every value goes through the editor's own core
 * (lorebook-core.ts), so a setting changed here is the setting the control of that name changes,
 * and the approval card speaks the names those controls wear.
 */
import { serverDb } from '../../db';
import type { ApprovalNote } from '../types';
import type { Capability } from './types';
import type { RawCharacterVersion, RawChat, RawLibraryEntry, RawLorebookBook, RawLorebookEntry } from '../rows';
import { stampState } from '../freshness';
import {
	BEHAVIORS,
	BOOK_KNOBS,
	ENTRY_INHERITABLE,
	ENTRY_KNOB_NAMES,
	ENTRY_KNOBS,
	KEY_MODES,
	LOGICS,
	PLACEMENTS,
	ROLES,
	SCAN_FIELD_IDS,
	TRIGGER_IDS,
	WOKEN_BY,
	entryCensus,
	facetDefaults,
	ownSettings,
	planEntrySettings,
	selectEntries,
	type BookKnob,
	type KeyRulesPatch,
	type LogicName
} from '../lorebook-core';
import { LOREBOOK_KNOB_NAMES, type LorebookBulkEdit } from '../../../src/lib/lorebook/bulk';
import {
	LOREBOOK_KEY_MODES,
	LOREBOOK_LOGICS,
	LOREBOOK_PLACEMENTS,
	LOREBOOK_POSITION_AT_DEPTH,
	LOREBOOK_POSITION_BLOCK,
	LOREBOOK_ROLES,
	LOREBOOK_SCAN_FIELDS,
	LOREBOOK_SETTINGS_KEY,
	LOREBOOK_TRIGGERS,
	WOKEN_BY_LABELS,
	lorebookWokenBy,
	resolveEntryRecursion,
	type LorebookGlobalSettings
} from '../../../src/lib/lorebook/types';
import { claimedIds } from './chat-reads';
import { loadLorebookBook, loadLorebookDefaults, readEntrySelector } from './lorebook-entries';
import { estimateTextTokens } from './schema';
import { ToolError, str, requireStr, strList, intArg, oneOf, boolArg, ok } from './util';

const DEFAULTS_CLAIM: [string, string] = ['lorebook_defaults', 'global'];

function bookName(book: RawLorebookBook): string {
	return book.name.trim() || 'Untitled lorebook';
}

function namesList(names: string[], shown = 6): string {
	if (names.length <= shown) return names.join(', ');
	return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

/** The `set` object, checked against the settings this call takes: an unknown name fails loud
 *  with the list, since a typo that changed nothing would read as a change made. */
function readSet(args: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
	const set = args.set;
	if (!set || typeof set !== 'object' || Array.isArray(set)) throw new ToolError('`set` must be an object of the settings to change.');
	const names = Object.keys(set);
	if (!names.length) throw new ToolError('`set` is empty: pass at least one setting.');
	const unknown = names.filter((name) => !known.includes(name));
	if (unknown.length) throw new ToolError(`${unknown.map((n) => `"${n}"`).join(', ')} ${unknown.length === 1 ? 'is not a setting' : 'are not settings'} here. Settings: ${known.join(', ')}.`);
	return set as Record<string, unknown>;
}

// ===== the map =====

/** Past this many, the cards linking a book are counted rather than named. */
const LINKS_NAMED = 20;

/**
 * What brings a book into chats besides being in every one: the cards that link it, and the
 * chats that attached it or took it back out for themselves. A character's parked variants count
 * too, named by variant: a chat pinned to one plays with that variant's links, so leaving them
 * out would report a book in use as one nothing carries.
 */
function reachOf(bookId: string): { linked: number; attached: number; payload: Record<string, unknown> } {
	const library = serverDb.getAllLibraryEntries() as RawLibraryEntry[];
	const linked: { kind: string; id: string; name: string; variant?: string }[] = library
		.filter((e) => (e.data?.lorebookIds ?? []).includes(bookId))
		.map((e) => ({ kind: e.type, id: e.id, name: e.identity.name }));
	const counted = new Set(linked.map((l) => l.id));
	for (const version of serverDb.getAllCharacterVersions() as RawCharacterVersion[]) {
		const links = version.data?.lorebookIds;
		const owner = library.find((e) => e.id === version.entryId);
		if (!owner || counted.has(owner.id) || !Array.isArray(links) || !links.includes(bookId)) continue;
		counted.add(owner.id);
		linked.push({ kind: owner.type, id: owner.id, name: owner.identity.name, variant: version.name });
	}
	let attached = 0;
	let muted = 0;
	for (const chat of serverDb.getAllChats() as RawChat[]) {
		if (claimedIds(chat, 'lorebooks').includes(bookId)) attached += 1;
		if (claimedIds(chat, 'mutedLorebooks').includes(bookId)) muted += 1;
	}
	return {
		linked: linked.length,
		attached,
		payload: {
			...(linked.length ? { linkedBy: linked.slice(0, LINKS_NAMED) } : {}),
			...(linked.length > LINKS_NAMED ? { linkedByCount: linked.length } : {}),
			...(attached ? { chatsAttached: attached } : {}),
			...(muted ? { chatsMuted: muted } : {})
		}
	};
}

export const readLorebookSettings: Capability = {
	name: 'read_lorebook_settings',
	summary:
		"Map how lore fires: the settings a book sets itself (`own`; the rest follow the defaults, returned too), what brings it into chats, and a census of its entries' settings ({setting: {answer: count}}, leaving out what no entry departs from) with their estimated tokens. It stays small however big the book is, so read it before paging a big one.",
	risk: 'read',
	params: [{ name: 'lorebookId', type: 'string', describe: 'The book. Omit for the defaults alone.' }],
	run(args) {
		const defaults = loadLorebookDefaults();
		if (!str(args.lorebookId).trim()) {
			return ok({ type: 'read_lorebook_settings', label: 'Read the lorebook Global Settings' }, { defaults, ...stampState(DEFAULTS_CLAIM) });
		}
		const book = loadLorebookBook(args.lorebookId);
		const own = ownSettings(book);
		const reach = reachOf(book.id);
		const notes: string[] = [];
		if (!book.global && reach.linked === 0 && reach.attached === 0) {
			notes.push('Nothing brings this book into a chat, so it reaches no prompt: link it (manage_entry_lorebooks) or set everyChat.');
		}
		const recurses = own.recursiveScanning ?? defaults.recursiveScanning;
		if (defaults.crossBookRecursion && own.maxRecursionSteps !== undefined && recurses) {
			notes.push("Books recurse together, so the defaults' maxRecursionSteps caps the one shared loop and this book's own does nothing.");
		}
		// Only a recursing book takes part in recursion (engine.ts), so an entry waiting for it
		// in any other book waits for good, and reads like one that merely matched nothing.
		const waiting = book.entries.filter((e) => !e.disable && lorebookWokenBy(resolveEntryRecursion(e)) === 'entriesOnly').length;
		if (waiting && !recurses) {
			notes.push(`${waiting} entr${waiting === 1 ? 'y waits' : 'ies wait'} for other entries, but this book does not recurse, so ${waiting === 1 ? 'it never fires' : 'they never fire'}.`);
		}
		return ok(
			{ type: 'read_lorebook_settings', id: book.id, name: bookName(book), label: `Read the settings of ${bookName(book)}` },
			{
				lorebookId: book.id,
				name: book.name,
				everyChat: !!book.global,
				...reach.payload,
				own,
				defaults,
				entries: book.entries.length,
				entrySettings: entryCensus(book.entries, facetDefaults(book, defaults), estimateTextTokens),
				...(notes.length ? { note: notes.join(' ') } : {}),
				...stampState(['lorebook', book.id], DEFAULTS_CLAIM)
			}
		);
	}
};

// ===== the defaults and whole books =====

type DefaultsKnob = keyof LorebookGlobalSettings;
const DEFAULTS_ONLY = ['crossBookRecursion', 'budgetPercent'] as const;
const BOOK_SETTINGS = [...BOOK_KNOBS, 'everyChat', ...DEFAULTS_ONLY];

/** What the Activation panel calls each setting, so the card names the row the reader knows. */
const ACTIVATION_NAMES: Record<DefaultsKnob | 'everyChat', string> = {
	scanDepth: 'Scan depth',
	recursiveScanning: 'Recursive scan',
	maxRecursionSteps: 'Max recursion passes',
	crossBookRecursion: 'Books recurse together',
	caseSensitive: 'Case-sensitive',
	matchWholeWords: 'Match whole words',
	budgetPercent: 'Lore budget',
	everyChat: 'Use in every chat'
};

function activationWord(knob: DefaultsKnob, value: number | boolean): string {
	if (typeof value === 'boolean') return value ? 'on' : 'off';
	if (knob === 'scanDepth') return value === 0 ? 'the whole chat' : String(value);
	if (knob === 'maxRecursionSteps') return value === 0 ? 'no cap' : String(value);
	if (knob === 'budgetPercent') return value === 0 ? 'no limit' : `${value}%`;
	return String(value);
}

/** A book's own values for the settings it shares with the defaults; null follows them. */
type ActivationPatch = { [K in BookKnob]?: LorebookGlobalSettings[K] | null };

const PARSE_ACTIVATION: { [K in BookKnob]: (v: unknown) => LorebookGlobalSettings[K] } = {
	scanDepth: (v) => intArg(v, 'scanDepth', 0),
	recursiveScanning: (v) => boolArg(v, 'recursiveScanning'),
	maxRecursionSteps: (v) => intArg(v, 'maxRecursionSteps', 0),
	caseSensitive: (v) => boolArg(v, 'caseSensitive'),
	matchWholeWords: (v) => boolArg(v, 'matchWholeWords')
};

/** The five settings a book shares with the defaults. A null hands one back to the defaults,
 *  which only a book has to hand it back to. */
function readActivation(set: Record<string, unknown>, bookScope: boolean): ActivationPatch {
	const out: Record<string, unknown> = {};
	for (const knob of BOOK_KNOBS) {
		const value = set[knob];
		if (value === undefined) continue;
		if (value === null && !bookScope) throw new ToolError(`\`${knob}\` cannot be null for the defaults: nothing sits above them to hand it back to.`);
		out[knob] = value === null ? null : PARSE_ACTIVATION[knob](value);
	}
	return out as ActivationPatch;
}

/** A defaults write, worked out before anything lands. */
function planDefaults(args: Record<string, unknown>): { before: LorebookGlobalSettings; after: LorebookGlobalSettings; changed: DefaultsKnob[] } {
	if (args.lorebookIds !== undefined) throw new ToolError('`lorebookIds` belongs to scope books.');
	const set = readSet(args, BOOK_SETTINGS);
	if (set.everyChat !== undefined) throw new ToolError('`everyChat` is a decision about one book: use scope books.');
	const patch: Partial<LorebookGlobalSettings> = readActivation(set, false) as Partial<LorebookGlobalSettings>;
	if (set.crossBookRecursion !== undefined) patch.crossBookRecursion = boolArg(set.crossBookRecursion, 'crossBookRecursion');
	if (set.budgetPercent !== undefined) patch.budgetPercent = intArg(set.budgetPercent, 'budgetPercent', 0, 100);
	const before = loadLorebookDefaults();
	const after = { ...before, ...patch };
	return { before, after, changed: (Object.keys(patch) as DefaultsKnob[]).filter((knob) => before[knob] !== after[knob]) };
}

/** A books write, worked out before anything lands. */
function planBooks(args: Record<string, unknown>) {
	if (args.lorebookIds === undefined) throw new ToolError('`lorebookIds` is required with scope books.');
	const ids = [...new Set(strList(args.lorebookIds, 'lorebookIds'))];
	if (!ids.length) throw new ToolError('`lorebookIds` is required with scope books.');
	const set = readSet(args, BOOK_SETTINGS);
	const scanWide = DEFAULTS_ONLY.filter((knob) => set[knob] !== undefined);
	if (scanWide.length) throw new ToolError(`${scanWide.map((k) => `\`${k}\``).join(', ')} describe the whole scan, so no book sets them: use scope defaults.`);
	const knobs = readActivation(set, true);
	const everyChat = set.everyChat === undefined ? undefined : boolArg(set.everyChat, 'everyChat');
	const staged = BOOK_KNOBS.filter((knob) => knobs[knob] !== undefined);
	const changes = ids.map((id) => loadLorebookBook(id)).map((book) => ({
		book,
		moves: staged.some((knob) => (book[knob] ?? null) !== knobs[knob]) || (everyChat !== undefined && !!book.global !== everyChat)
	}));
	return { knobs, staged, everyChat, changes };
}

/** The defaults where only wording needs them, or null when the row cannot be read: a book write
 *  never reads them, so neither its card nor its result may fail over them. */
function defaultsIfReadable(): LorebookGlobalSettings | null {
	try {
		return loadLorebookDefaults();
	} catch {
		return null;
	}
}

/** A book's own value in the card's words: its own, or the default it follows. */
function layerWord(knob: BookKnob, own: number | boolean | null | undefined, defaults: LorebookGlobalSettings | null): string {
	if (own != null) return activationWord(knob, own);
	return defaults ? `follows the defaults (${activationWord(knob, defaults[knob])})` : 'follows the defaults';
}

/** A book pass cap set while books recurse together, which the one shared loop never reads. */
function capIsInert(knobs: ActivationPatch, defaults: LorebookGlobalSettings | null): boolean {
	return typeof knobs.maxRecursionSteps === 'number' && !!defaults?.crossBookRecursion;
}

const BOOK_SET_DESCRIBE =
	"The settings to change; pass only what changes. scanDepth: recent messages searched for keys, 0 = the whole chat. recursiveScanning: a fired entry's text is scanned too, so it can trigger others. maxRecursionSteps: recursion passes, 0 = until nothing new fires. caseSensitive. matchWholeWords: single-word keys match only as whole words. Books only: everyChat (in every chat with nothing linking it); null hands a setting back to the defaults. Defaults only: crossBookRecursion (recursion reaches every book in play, one loop capped by the defaults' maxRecursionSteps), budgetPercent (% of the context all lore may take, 0 = no limit).";

const CROSS_BOOK_WARNING =
	"Entries can then wake entries in any other book in play, which widens what every chat injects, and each book's own pass cap stops applying.";

export const configureLorebooks: Capability = {
	name: 'configure_lorebooks',
	summary: 'Change activation settings of the defaults or of books. An entry follows its book, and a book the defaults, wherever it sets nothing itself.',
	risk: 'write',
	params: [
		{ name: 'scope', type: 'string', describe: 'defaults: the layer every book falls back to. books: the ones in lorebookIds.', required: true, enum: ['defaults', 'books'] },
		{ name: 'lorebookIds', type: 'array', items: { type: 'string' }, describe: 'scope books: the books to change.' },
		{ name: 'set', type: 'object', freeform: true, required: true, describe: BOOK_SET_DESCRIBE }
	],
	run(args, ctx) {
		const scope = oneOf(args.scope, 'scope', ['defaults', 'books'] as const);
		if (scope === 'defaults') {
			const { after, changed } = planDefaults(args);
			if (!changed.length) {
				return ok({ type: 'configure_lorebooks', label: 'Lorebook Global Settings already held this' }, { defaults: after, changed: [], note: 'Already so: nothing was written.', ...stampState(DEFAULTS_CLAIM) });
			}
			serverDb.setSetting(LOREBOOK_SETTINGS_KEY, JSON.stringify(after));
			ctx.broadcast('settings');
			return ok(
				{ type: 'configure_lorebooks', label: `Changed lorebook Global Settings: ${changed.map((k) => ACTIVATION_NAMES[k]).join(', ')}` },
				{ defaults: after, changed, ...stampState(DEFAULTS_CLAIM) }
			);
		}

		const { knobs, everyChat, changes } = planBooks(args);
		const moving = changes.filter((c) => c.moves);
		if (moving.length) {
			serverDb.inTransaction(() => {
				for (const { book } of moving) {
					Object.assign(book, knobs);
					// Off stores as nothing, the editor's own rule for the switch.
					if (everyChat !== undefined) book.global = everyChat || undefined;
					serverDb.updateLorebook(book);
				}
			});
			ctx.broadcast('lorebooks');
		}
		const single = changes.length === 1 ? changes[0].book : null;
		return ok(
			{
				type: 'configure_lorebooks',
				...(single ? { id: single.id, name: bookName(single) } : {}),
				label: moving.length
					? `Changed the settings of ${single ? bookName(single) : `${moving.length} lorebooks`}`
					: `${single ? bookName(single) : 'Those lorebooks'} already held this`
			},
			{
				changed: moving.length,
				// One book reads back what it now sets itself; many only say how many moved, since the
				// call named them and set the same values on each.
				...(single ? { everyChat: !!single.global, own: ownSettings(single) } : {}),
				...(moving.length ? {} : { note: 'Already so: nothing was written.' }),
				...(capIsInert(knobs, defaultsIfReadable())
					? { warning: "Books recurse together, so the defaults' maxRecursionSteps caps the one shared loop and a book's own does nothing." }
					: {}),
				...stampState(...changes.map(({ book }): [string, string] => ['lorebook', book.id]))
			}
		);
	},
	preview(args) {
		const scope = oneOf(args.scope, 'scope', ['defaults', 'books'] as const);
		if (scope === 'defaults') {
			const { before, after, changed } = planDefaults(args);
			const books = serverDb.getAllLorebooks() as RawLorebookBook[];
			const notes: ApprovalNote[] = changed.map((knob) => {
				// Only a book that sets nothing of its own for this setting takes the new default.
				const cascades = (BOOK_KNOBS as readonly string[]).includes(knob);
				const followers = cascades ? books.filter((b) => b[knob as BookKnob] == null).length : 0;
				const reach = cascades ? `, followed by ${followers} of ${books.length} book${books.length === 1 ? '' : 's'}` : '';
				return { text: `${ACTIVATION_NAMES[knob]}: ${activationWord(knob, before[knob])} → ${activationWord(knob, after[knob])}${reach}` };
			});
			if (changed.includes('crossBookRecursion') && after.crossBookRecursion) notes.push({ text: CROSS_BOOK_WARNING, warn: true });
			if (!changed.length) notes.push({ text: 'Already set, so nothing would change.', warn: true });
			// Named as the shelf names the page, and the same act as a book change, so one step
			// touching both reads as one group.
			return { act: 'Change lorebook settings', label: 'Global Settings', notes };
		}

		const { knobs, staged, everyChat, changes } = planBooks(args);
		const defaults = defaultsIfReadable();
		const single = changes.length === 1 ? changes[0].book : null;
		const notes: ApprovalNote[] = staged.map((knob) => {
			const after = layerWord(knob, knobs[knob], defaults);
			return { text: single ? `${ACTIVATION_NAMES[knob]}: ${layerWord(knob, single[knob], defaults)} → ${after}` : `${ACTIVATION_NAMES[knob]} → ${after}` };
		});
		if (!defaults) notes.push({ text: 'Global Settings cannot be read, so the values books follow are not shown.', warn: true });
		if (capIsInert(knobs, defaults)) {
			notes.push({ text: `Books recurse together, so a book's own ${ACTIVATION_NAMES.maxRecursionSteps} does nothing until that is off.`, warn: true });
		}
		if (everyChat !== undefined) {
			notes.push(
				everyChat
					? { text: `${ACTIVATION_NAMES.everyChat}: on. Every chat scans it, even with no character or persona linking it.`, warn: true }
					: { text: `${ACTIVATION_NAMES.everyChat}: off. Only chats whose character or persona links it, or that attach it, scan it.` }
			);
		}
		const moving = changes.filter((c) => c.moves);
		if (!moving.length) notes.push({ text: 'Already set, so nothing would change.', warn: true });
		return {
			act: 'Change lorebook settings',
			label: single ? bookName(single) : namesList(changes.map((c) => bookName(c.book))),
			...(single ? { target: { kind: 'lorebook' as const, id: single.id } } : { rows: moving.length }),
			notes
		};
	}
};

// ===== entries =====

/** A membership change, one member at a time: `{member: true}` adds it, false takes it out. */
function readMembers<T extends string>(v: unknown, label: string, members: readonly T[]): Partial<Record<T, boolean>> {
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ToolError(`\`${label}\` must be an object like {"${members[0]}": true}.`);
	const out: Partial<Record<T, boolean>> = {};
	for (const [key, value] of Object.entries(v)) {
		out[oneOf(key, label, members)] = boolArg(value, `${label}.${key}`);
	}
	if (!Object.keys(out).length) throw new ToolError(`\`${label}\` names nothing to add or remove.`);
	return out;
}

/** Per-key rules as the call gives them: an object merges into the key's rule, null drops it. */
function readKeyRules(v: unknown): KeyRulesPatch {
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ToolError('`keyRules` must be an object like {"*": {"mode": "start"}}.');
	const out: KeyRulesPatch = {};
	for (const [key, rule] of Object.entries(v)) {
		if (!key.trim()) throw new ToolError('`keyRules` names an empty key.');
		if (rule === null) {
			out[key] = null;
			continue;
		}
		if (typeof rule !== 'object' || Array.isArray(rule)) throw new ToolError(`\`keyRules["${key}"]\` must be {mode, caseSensitive} or null.`);
		const r = rule as Record<string, unknown>;
		const extra = Object.keys(r).filter((f) => f !== 'mode' && f !== 'caseSensitive');
		if (extra.length) throw new ToolError(`\`keyRules["${key}"]\` takes mode and caseSensitive only, not ${extra.join(', ')}.`);
		if (r.mode === undefined && r.caseSensitive === undefined) throw new ToolError(`\`keyRules["${key}"]\` sets nothing: give mode or caseSensitive, or null to drop the rule.`);
		out[key] = {
			...(r.mode !== undefined ? { mode: r.mode === null ? null : oneOf(r.mode, `keyRules["${key}"].mode`, KEY_MODES) } : {}),
			...(r.caseSensitive !== undefined ? { caseSensitive: r.caseSensitive === null ? null : boolArg(r.caseSensitive, `keyRules["${key}"].caseSensitive`) } : {})
		};
	}
	if (!Object.keys(out).length) throw new ToolError('`keyRules` names no key.');
	return out;
}

type EditKey = keyof LorebookBulkEdit;
const EDIT_KEYS = Object.keys(ENTRY_KNOB_NAMES) as EditKey[];

/**
 * How each staged setting is read from `set`, one per key of the bulk editor's edit: typed over
 * every key, so a setting the editor gains cannot be named without being read, where it would
 * otherwise be accepted and silently dropped.
 */
const ENTRY_PARSERS: { [K in EditKey]-?: (value: unknown, name: string) => LorebookBulkEdit[K] } = {
	nature: (v, name) => oneOf(v, name, BEHAVIORS),
	selectiveLogic: (v, name) => LOGICS[oneOf(v, name, Object.keys(LOGICS) as LogicName[])],
	order: (v, name) => intArg(v, name, 0),
	probability: (v, name) => intArg(v, name, 0, 100),
	caseSensitive: (v, name) => (v === null ? null : boolArg(v, name)),
	matchWholeWords: (v, name) => (v === null ? null : boolArg(v, name)),
	scanDepth: (v, name) => (v === null ? null : intArg(v, name, 0)),
	scanFields: (v, name) => readMembers(v, name, SCAN_FIELD_IDS),
	wokenBy: (v, name) => oneOf(v, name, WOKEN_BY),
	delayLevel: (v, name) => intArg(v, name, 1),
	wakesOthers: (v, name) => boolArg(v, name),
	triggers: (v, name) => readMembers(v, name, TRIGGER_IDS),
	// Zero is off, which both editors store as nothing.
	sticky: (v, name) => intArg(v, name, 0) || null,
	cooldown: (v, name) => intArg(v, name, 0) || null,
	delay: (v, name) => intArg(v, name, 0) || null,
	group: (v, name) => requireStr(v, name).trim(),
	groupWeight: (v, name) => intArg(v, name, 0),
	groupOverride: (v, name) => boolArg(v, name),
	useGroupScoring: (v, name) => boolArg(v, name),
	position: (v, name) => (oneOf(v, name, PLACEMENTS) === 'depth' ? LOREBOOK_POSITION_AT_DEPTH : LOREBOOK_POSITION_BLOCK),
	depth: (v, name) => intArg(v, name, 0),
	role: (v, name) => {
		const role = oneOf(v, name, ROLES);
		return LOREBOOK_ROLES.find((r) => r.role === role)!.id;
	}
};

/** The staged settings as the bulk editor's own edit, plus the key rules it has no knob for. A
 *  null hands a setting back to the book, which only the three the book also holds can do. */
function readEntryEdit(args: Record<string, unknown>): { edit: LorebookBulkEdit; keyRules?: KeyRulesPatch } {
	const set = readSet(args, ENTRY_KNOBS);
	const nulls = Object.keys(set).filter((name) => set[name] === null && !(ENTRY_INHERITABLE as readonly string[]).includes(name));
	if (nulls.length) throw new ToolError(`Only ${ENTRY_INHERITABLE.join(', ')} take null (back to the book); ${nulls.join(', ')} ${nulls.length === 1 ? 'needs' : 'need'} a value.`);
	const edit: Record<string, unknown> = {};
	for (const key of EDIT_KEYS) {
		const name = ENTRY_KNOB_NAMES[key];
		if (set[name] !== undefined) edit[key] = ENTRY_PARSERS[key](set[name], name);
	}
	return { edit: edit as LorebookBulkEdit, ...(set.keyRules !== undefined ? { keyRules: readKeyRules(set.keyRules) } : {}) };
}

const W = ENTRY_KNOB_NAMES;

/** Why a staged setting would reach no picked entry, by the name the call gave it. */
const INERT: Partial<Record<EditKey, string>> = {
	selectiveLogic: `\`${W.selectiveLogic}\` narrows by secondaryKeys, and no picked keyword entry has any.`,
	delayLevel: `\`${W.delayLevel}\` is for entries that wait for others, and not all of these do: set ${W.wokenBy} entriesOnly with it.`,
	groupWeight: `\`${W.groupWeight}\` decides nothing outside a group: set ${W.group} with it.`,
	groupOverride: `\`${W.groupOverride}\` decides nothing outside a group: set ${W.group} with it.`,
	useGroupScoring: `\`${W.useGroupScoring}\` decides nothing outside a group: set ${W.group} with it.`,
	depth: `\`${W.depth}\` places nothing outside the chat: set ${W.position} depth with it.`,
	role: `\`${W.role}\` places nothing outside the chat: set ${W.position} depth with it.`
};

/** The entries a call names, refusing a pick that names nothing or names what is not there. */
function pickEntries(book: RawLorebookBook, args: Record<string, unknown>, defaults: LorebookGlobalSettings): RawLorebookEntry[] {
	const selector = readEntrySelector(args);
	const all = args.all === undefined ? false : boolArg(args.all, 'all');
	const picking = selector.ids !== undefined || selector.query !== undefined || selector.where !== undefined;
	if (all && picking) throw new ToolError('`all` takes every entry, so it goes alone: drop ids, query and where, or drop all.');
	if (!all && !picking) throw new ToolError('Name the entries: ids, query, where, or all:true for every entry in the book.');
	if (selector.ids) {
		if (!selector.ids.length) throw new ToolError('`ids` names no entry.');
		const missing = selector.ids.filter((id) => !book.entries.some((e) => e.id === id));
		if (missing.length) throw new ToolError(`No entry with id ${missing.join(', ')} in "${bookName(book)}". Use read_lorebook_entries for ids.`);
	}
	return all ? [...book.entries] : selectEntries(book.entries, selector, facetDefaults(book, defaults));
}

/**
 * What a write lands but will not do what it looks like it does, each said twice: to the model,
 * which has to explain it, and on the card, which the reader approves. Both are real states the
 * editor also allows, so they warn rather than refuse.
 */
function entryWarnings(book: RawLorebookBook, picked: RawLorebookEntry[], edit: LorebookBulkEdit, defaults: LorebookGlobalSettings): { model: string; card: string }[] {
	const out: { model: string; card: string }[] = [];
	// An empty trigger list means every kind, so a removal from it changes nothing (bulk.ts).
	const removals = edit.triggers ? Object.values(edit.triggers).every((on) => on === false) : false;
	if (removals && picked.some((e) => !e.triggers?.length)) {
		out.push({
			model: 'An empty trigger list already means every kind, so taking a kind out of it changes nothing: to leave one out, add the others.',
			card: 'Entries that fire on every kind are unchanged. To keep one kind out, pick the kinds they should fire on.'
		});
	}
	if (edit.wokenBy === 'entriesOnly' && !(book.recursiveScanning ?? defaults.recursiveScanning)) {
		out.push({
			model: 'This book does not recurse, so an entry that waits for other entries never fires in it until its recursiveScanning is on (configure_lorebooks).',
			card: 'This book does not recurse, so these entries will not fire until Recursive scan is on.'
		});
	}
	return out;
}

/** One settings write, worked out before anything lands: the preview and the run share it, so
 *  the card never promises a change the call would refuse. */
function planEntries(args: Record<string, unknown>) {
	const book = loadLorebookBook(args.lorebookId);
	const { edit, keyRules } = readEntryEdit(args);
	const defaults = loadLorebookDefaults();
	const picked = pickEntries(book, args, defaults);
	const plan = planEntrySettings(picked, edit, keyRules, facetDefaults(book, defaults));
	if (picked.length) {
		const inert = plan.inert.map((key) => INERT[key] ?? `\`${key}\` means nothing for these entries.`);
		if (plan.regexKeys.length) {
			inert.push(`${plan.regexKeys.map((k) => `"${k}"`).join(', ')} ${plan.regexKeys.length === 1 ? 'is a /regex/ key, which answers' : 'are /regex/ keys, which answer'} to its own flags and takes no rule.`);
		}
		if (plan.unknownKeys.length) inert.push(`No picked entry has the key ${plan.unknownKeys.map((k) => `"${k}"`).join(', ')} (keys match as written).`);
		if (inert.length) throw new ToolError(`Nothing was changed. ${inert.join(' ')}`);
	}
	return { book, picked, plan, edit, keyRules, warnings: entryWarnings(book, picked, edit, defaults) };
}

const NATURE_WORDS: Record<(typeof BEHAVIORS)[number], string> = { always: 'Always', keyword: 'Keyword', off: 'Off' };

function onOff(value: boolean): string {
	return value ? 'on' : 'off';
}

function memberWords<T extends string>(staged: Partial<Record<T, boolean>>, labels: readonly { id: T; label: string }[]): string {
	const named = (on: boolean) => labels.filter((l) => staged[l.id] === on).map((l) => l.label);
	const added = named(true);
	const removed = named(false);
	return [added.length ? `adds ${added.join(', ')}` : '', removed.length ? `removes ${removed.join(', ')}` : ''].filter(Boolean).join(', ');
}

/** Key rules as the chips mark them: the mode in lower case, then which keys it is for. */
function ruleWords(keyRules: KeyRulesPatch): string {
	return Object.entries(keyRules)
		.map(([key, rule]) => {
			const who = key === '*' ? 'every key' : `"${key}"`;
			if (rule === null) return `the entry's own matching for ${who}`;
			const parts: string[] = [];
			if (rule.mode === null) parts.push("the entry's mode");
			else if (rule.mode) parts.push(LOREBOOK_KEY_MODES.find((m) => m.id === rule.mode)!.label.toLowerCase());
			if (rule.caseSensitive === null) parts.push("the entry's case rule");
			else if (rule.caseSensitive !== undefined) parts.push(rule.caseSensitive ? 'case-sensitive' : 'not case-sensitive');
			return `${parts.join(', ')} for ${who}`;
		})
		.join('; ');
}

const N = LOREBOOK_KNOB_NAMES;
const followBook = (value: unknown, word: string) => (value === null ? 'follows the book' : word);
const offOr = (value: number | null) => (value === null ? 'off' : String(value));

/**
 * Each staged setting in the words its control wears, the bulk editor's names and labels, so the
 * card reads as the editor would. Typed over every key of the edit, like the parsers: a setting
 * the card could not describe is a setting the reader would approve blind.
 */
const EDIT_WORDS: { [K in EditKey]-?: (value: Exclude<LorebookBulkEdit[K], undefined>) => string } = {
	nature: (v) => `${N.nature}: ${NATURE_WORDS[v]}`,
	selectiveLogic: (v) => `${N.filter}: ${LOREBOOK_LOGICS.find((l) => l.id === v)?.glyph ?? v}`,
	order: (v) => `${N.order}: ${v}`,
	probability: (v) => `${N.probability}: ${v}`,
	caseSensitive: (v) => `${N.caseSensitive}: ${followBook(v, onOff(!!v))}`,
	matchWholeWords: (v) => `${N.matchWholeWords}: ${followBook(v, onOff(!!v))}`,
	scanDepth: (v) => `${N.scanDepth}: ${followBook(v, v === 0 ? 'the whole chat' : String(v))}`,
	scanFields: (v) => `${N.scanFields}: ${memberWords(v, LOREBOOK_SCAN_FIELDS)}`,
	wokenBy: (v) => `${N.wokenBy}: ${WOKEN_BY_LABELS[v]}`,
	delayLevel: (v) => `Level: ${v}`,
	wakesOthers: (v) => `${N.wakesOthers}: ${onOff(v)}`,
	triggers: (v) => `${N.triggers}: ${memberWords(v, LOREBOOK_TRIGGERS)}`,
	sticky: (v) => `Sticky: ${offOr(v)}`,
	cooldown: (v) => `Cooldown: ${offOr(v)}`,
	delay: (v) => `Delay: ${offOr(v)}`,
	group: (v) => `${N.group}: ${v || 'none'}`,
	groupWeight: (v) => `Weight: ${v}`,
	groupOverride: (v) => `Prioritize: ${onOff(v)}`,
	useGroupScoring: (v) => `Decide by matches: ${onOff(v)}`,
	position: (v) => `${N.placement}: ${LOREBOOK_PLACEMENTS.find((p) => p.id === v)?.label ?? v}`,
	depth: (v) => `Depth: ${v}`,
	role: (v) => `As: ${LOREBOOK_ROLES.find((r) => r.id === v)?.label ?? v}`
};

/** The staged edit in the editor's words, in the editor's order. */
function editWords(edit: LorebookBulkEdit, keyRules: KeyRulesPatch | undefined): string {
	const parts = EDIT_KEYS.filter((key) => edit[key] !== undefined).map((key) => (EDIT_WORDS[key] as (value: unknown) => string)(edit[key]));
	if (keyRules) parts.push(`Key matching: ${ruleWords(keyRules)}`);
	return parts.join(' · ');
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** An entry as a card names it: its title, else the start of its text in quotes, both clipped so
 *  a list of them stays a line or two on a phone. */
function entryTitle(entry: RawLorebookEntry): string {
	const title = entry.comment.trim();
	if (title) return clip(title, 48);
	const text = entry.content.replace(/\s+/g, ' ').trim();
	return text ? `"${clip(text, 40)}"` : '(untitled entry)';
}

const ENTRY_SET_DESCRIBE =
	'The settings to change; pass only what changes. behavior: always (fires without keys), keyword, off. logic: andAny, andAll, notAny, notAll (how secondaryKeys narrow a match). order: lower is injected first and kept first under the lore budget. probability: Trigger %, its chance to fire, 0-100. caseSensitive, matchWholeWords, scanDepth (recent messages searched, 0 = the whole chat): override the book, null hands one back. scanFields (searched besides the chat): characterDescription, characterPersonality, scenario, personaDescription, creatorNotes, steering. triggers (generations it may fire on; none = all, so to exclude one add the rest): normal, swipe (and regenerate), continue, impersonate. Both take {member: true adds, false removes}. wokenBy: both (the chat or a fired entry\'s text), chatOnly, entriesOnly (only a fired entry\'s text wakes it; needs recursiveScanning); recursionLevel: the wave an entriesOnly entry waits for (default 1; a wave opens once those below wake nothing new). wakesOthers: false keeps its text from triggering others. sticky: replies it stays in after firing; cooldown: replies it then sits out; delay: messages the chat needs first; 0 = off. group: comma-separated labels ("" = none); per label one firing entry reaches the prompt, narrowed to sticky ones, then groupPriority:true ones, then with groupScoring:true to the most keys matched, then drawn by groupWeight (default 100). placement: block ({{lorebook}}) or depth (its own turn in the chat), with depth (turns back, default 4) and role (system, user, assistant). keyRules: {key, or "*" for every key it holds now: {mode: substring, word or start (the word plus any ending), caseSensitive} or null; a /pattern/flags key is a regex and takes none}.';

export const configureLorebookEntries: Capability = {
	name: 'configure_lorebook_entries',
	summary: 'Change how entries of one book fire, one or thousands in a call: pick them with ids, query and where (each narrows) or all; every picked entry takes `set`.',
	risk: 'write',
	params: [
		{ name: 'lorebookId', type: 'string', describe: 'The book.', required: true },
		{ name: 'ids', type: 'array', items: { type: 'string' }, describe: 'Entry ids.' },
		{ name: 'query', type: 'string', describe: "As read_lorebook_entries' query." },
		{ name: 'where', type: 'object', freeform: true, describe: "As read_lorebook_entries' where." },
		{ name: 'all', type: 'boolean', describe: 'Every entry in the book; goes alone.' },
		{ name: 'set', type: 'object', freeform: true, required: true, describe: ENTRY_SET_DESCRIBE }
	],
	run(args, ctx) {
		const { book, picked, plan, warnings } = planEntries(args);
		const name = bookName(book);
		const warned = warnings.length ? { warning: warnings.map((w) => w.model).join(' ') } : {};
		if (!picked.length) {
			return ok({ type: 'configure_lorebook_entries', id: book.id, name, label: `No entry in ${name} matched, so nothing changed` }, { lorebookId: book.id, matched: 0, changed: 0 });
		}
		if (!plan.patches.size) {
			return ok(
				{ type: 'configure_lorebook_entries', id: book.id, name, label: `${picked.length} entr${picked.length === 1 ? 'y' : 'ies'} in ${name} already held this` },
				{ lorebookId: book.id, matched: picked.length, changed: 0, note: 'Every picked entry already holds this: nothing was written.', ...warned, ...stampState(['lorebook', book.id]) }
			);
		}
		// Picked entries are the book's own objects, so each patch lands on its own entry even
		// where two of them share an id.
		for (const [entry, patch] of plan.patches) Object.assign(entry, patch);
		serverDb.updateLorebook(book);
		ctx.broadcast('lorebooks');
		// Counts, not ids: the pick that named these entries names them again, and a list of ids
		// would sit in every later request of the conversation for nothing.
		const changed = plan.changed.length;
		const unchanged = picked.length - changed;
		return ok(
			{ type: 'configure_lorebook_entries', id: book.id, name, label: `Changed the settings of ${changed} entr${changed === 1 ? 'y' : 'ies'} in ${name}` },
			{ lorebookId: book.id, matched: picked.length, changed, ...(unchanged ? { unchanged } : {}), ...warned, ...stampState(['lorebook', book.id]) }
		);
	},
	preview(args) {
		const { book, picked, plan, edit, keyRules, warnings } = planEntries(args);
		const changing = plan.changed;
		const unchanged = picked.length - changing.length;
		const notes: ApprovalNote[] = [{ text: editWords(edit, keyRules) }];
		if (!picked.length) notes.push({ text: 'No entry matches, so nothing would change.', warn: true });
		else if (!changing.length) notes.push({ text: 'Every picked entry already holds this, so nothing would change.', warn: true });
		else {
			if (changing.length > 1) notes.push({ text: namesList(changing.map(entryTitle)) });
			if (unchanged) notes.push({ text: `${unchanged} already hold${unchanged === 1 ? 's' : ''} this and stay${unchanged === 1 ? 's' : ''} as ${unchanged === 1 ? 'it is' : 'they are'}.` });
		}
		for (const warning of warnings) notes.push({ text: warning.card, warn: true });
		return {
			act: 'Change entry settings',
			within: book.name,
			label: changing.length === 1 ? entryTitle(changing[0]) : `${changing.length} entries`,
			target: { kind: 'lorebook', id: book.id },
			notes,
			rows: changing.length
		};
	}
};
