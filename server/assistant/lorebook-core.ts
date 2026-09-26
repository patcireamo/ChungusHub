/**
 * The assistant's reading of lorebook settings: what one entry sets, what a book's entries hold
 * between them, which entries a filter picks, and what a settings edit writes.
 *
 * Pure, and built on the editor's own core (src/lib/lorebook) rather than beside it: the census
 * and the filter are Select by's `answersOf`, a write is the bulk editor's `bulkEntryPatch`, so a
 * setting the assistant names, counts or writes means exactly what the control of that name
 * means, and an entry it edits cannot be told from one edited by hand. Tested in
 * lorebook-core.test.ts without a database.
 */
import { bulkEntryPatch, offeredEdit, type LorebookBulkEdit } from '../../src/lib/lorebook/bulk';
import { answersOf, LOREBOOK_FACETS, type LorebookFacet, type LorebookFacetDefaults } from '../../src/lib/lorebook/select';
import {
	DEFAULT_GROUP_WEIGHT,
	DEFAULT_LOREBOOK_DEPTH,
	DEFAULT_LOREBOOK_GLOBAL_SETTINGS,
	LOREBOOK_KEY_MODES,
	LOREBOOK_POSITION_AT_DEPTH,
	LOREBOOK_POSITION_BLOCK,
	LOREBOOK_ROLES,
	LOREBOOK_SCAN_FIELDS,
	LOREBOOK_TIMED_FIELDS,
	LOREBOOK_TRIGGERS,
	ST_POSITION_NAMES,
	TRIGGER_ALIASES,
	lorebookRoleOf,
	lorebookWokenBy,
	natureOf,
	parseRegexKey,
	resolveBookActivation,
	resolveEntryRecursion,
	resolveKeyMatch,
	type Lorebook,
	type LorebookEntry,
	type LorebookGlobalSettings,
	type LorebookKeyRule,
	type LorebookKeyRules,
	type ResolvedActivation,
	type ResolvedKeyMatch
} from '../../src/lib/lorebook/types';

// ===== the vocabulary the tools speak =====

/** `selectiveLogic` by name: SillyTavern's numbers carry no meaning a model can read. */
export const LOGICS = { andAny: 0, andAll: 3, notAny: 2, notAll: 1 } as const;
export type LogicName = keyof typeof LOGICS;
const LOGIC_NAME: Record<number, LogicName> = { 0: 'andAny', 3: 'andAll', 2: 'notAny', 1: 'notAll' };

export const BEHAVIORS = ['always', 'keyword', 'off'] as const;
export const WOKEN_BY = ['both', 'chatOnly', 'entriesOnly'] as const;
export const PLACEMENTS = ['block', 'depth'] as const;
export const ROLES = LOREBOOK_ROLES.map((r) => r.role);
export const SCAN_FIELD_IDS = LOREBOOK_SCAN_FIELDS.map((f) => f.id);
export const TRIGGER_IDS = LOREBOOK_TRIGGERS.map((t) => t.id);
export const KEY_MODES = LOREBOOK_KEY_MODES.map((m) => m.id);

/**
 * Each setting the bulk editor stages, by the name the tools take it under, in the editor's own
 * order. Typed over every key of the edit, so a setting the editor gains is a compile error here
 * until the assistant has a word for it.
 */
export const ENTRY_KNOB_NAMES: Record<keyof LorebookBulkEdit, string> = {
	nature: 'behavior',
	selectiveLogic: 'logic',
	order: 'order',
	probability: 'probability',
	caseSensitive: 'caseSensitive',
	matchWholeWords: 'matchWholeWords',
	scanDepth: 'scanDepth',
	scanFields: 'scanFields',
	wokenBy: 'wokenBy',
	delayLevel: 'recursionLevel',
	wakesOthers: 'wakesOthers',
	triggers: 'triggers',
	sticky: 'sticky',
	cooldown: 'cooldown',
	delay: 'delay',
	group: 'group',
	groupWeight: 'groupWeight',
	groupOverride: 'groupPriority',
	useGroupScoring: 'groupScoring',
	position: 'placement',
	depth: 'depth',
	role: 'role'
};

/** Every entry setting a write takes: the editor's, plus the per-key rules it has no knob for. */
export const ENTRY_KNOBS = [...Object.values(ENTRY_KNOB_NAMES), 'keyRules'];

/** The entry settings a null hands back to the book. */
export const ENTRY_INHERITABLE = ['caseSensitive', 'matchWholeWords', 'scanDepth'] as const;

/** The book settings that fall back to the defaults, where a null hands one back to them. */
export const BOOK_KNOBS = ['scanDepth', 'recursiveScanning', 'maxRecursionSteps', 'caseSensitive', 'matchWholeWords'] as const;
export type BookKnob = (typeof BOOK_KNOBS)[number];

// ===== one entry =====

function preview(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The generation kinds a trigger list names, aliases read as their kind, and any token this app
 *  never generates kept verbatim: an entry limited to those alone never fires here. */
function triggerNames(tokens: string[]): string[] {
	const kinds = TRIGGER_IDS.filter((id) => TRIGGER_ALIASES[id].some((t) => tokens.includes(t)));
	const known = new Set(TRIGGER_IDS.flatMap((id) => TRIGGER_ALIASES[id]));
	return [...kinds, ...tokens.filter((t) => !known.has(t))];
}

/** Rules in key order, so the same rules always read, and hash, the same way. */
function sortedRules(rules: LorebookKeyRules): LorebookKeyRules {
	const out: LorebookKeyRules = {};
	for (const key of Object.keys(rules).sort()) {
		const { mode, caseSensitive } = rules[key];
		out[key] = { ...(mode ? { mode } : {}), ...(caseSensitive !== undefined ? { caseSensitive } : {}) };
	}
	return out;
}

/**
 * What an entry sets for itself, in the tools' words, each only where it differs from what a
 * fresh entry does: a setting that follows its book reads as absent, as its row draws no star.
 */
export function entrySettings(entry: LorebookEntry): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!entry.constant && entry.keysecondary.length > 0 && entry.selectiveLogic !== 0) {
		out.logic = LOGIC_NAME[entry.selectiveLogic] ?? entry.selectiveLogic;
	}
	const probability = entry.useProbability ? entry.probability : 100;
	if (probability < 100) out.probability = probability;
	if (entry.caseSensitive != null) out.caseSensitive = entry.caseSensitive;
	if (entry.matchWholeWords != null) out.matchWholeWords = entry.matchWholeWords;
	if (entry.scanDepth != null) out.scanDepth = entry.scanDepth;
	const scanFields = SCAN_FIELD_IDS.filter((id) => entry.scanFields?.includes(id));
	if (scanFields.length > 0) out.scanFields = scanFields;
	const recursion = resolveEntryRecursion(entry);
	const wokenBy = lorebookWokenBy(recursion);
	if (wokenBy !== 'both') out.wokenBy = wokenBy;
	if (recursion.delayLevel > 1) out.recursionLevel = recursion.delayLevel;
	if (recursion.preventRecursion) out.wakesOthers = false;
	if (entry.triggers?.length) out.triggers = triggerNames(entry.triggers);
	for (const { field } of LOREBOOK_TIMED_FIELDS) {
		const value = entry[field];
		if (value && value > 0) out[field] = value;
	}
	if (entry.group?.trim()) {
		out.group = entry.group;
		if (entry.groupWeight != null && entry.groupWeight !== DEFAULT_GROUP_WEIGHT) out.groupWeight = entry.groupWeight;
		if (entry.groupOverride) out.groupPriority = true;
		if (entry.useGroupScoring) out.groupScoring = true;
	}
	const position = entry.position ?? LOREBOOK_POSITION_BLOCK;
	if (position === LOREBOOK_POSITION_AT_DEPTH) {
		out.placement = 'depth';
		out.depth = entry.depth ?? DEFAULT_LOREBOOK_DEPTH;
		out.role = lorebookRoleOf(entry);
	} else if (position !== LOREBOOK_POSITION_BLOCK) {
		out.placement = ST_POSITION_NAMES[position] ?? `SillyTavern position ${position}`;
	}
	if (entry.keyRules && Object.keys(entry.keyRules).length > 0) out.keyRules = sortedRules(entry.keyRules);
	return out;
}

/**
 * One entry as the reads hand it out. Content only when asked for: it is nearly all of an
 * entry's weight, and settings work never needs it. An untitled entry, which is how most
 * SillyTavern imports arrive, gets the start of its text instead, or it could not be told apart.
 */
export function entryRow(entry: LorebookEntry, withContent: boolean): Record<string, unknown> {
	const row: Record<string, unknown> = { id: entry.id, ...(entry.comment.trim() ? { comment: entry.comment } : {}), keys: entry.key };
	if (entry.keysecondary.length > 0) row.secondaryKeys = entry.keysecondary;
	row.behavior = natureOf(entry);
	row.order = entry.order;
	const sets = entrySettings(entry);
	if (Object.keys(sets).length > 0) row.sets = sets;
	if (withContent) row.content = entry.content;
	else if (!entry.comment.trim()) row.preview = preview(entry.content, 80);
	return row;
}

/**
 * A book as its light reads and its map show it, in a fixed shape: what the `lorebook` claim
 * hashes (server/assistant/freshness.ts). Entry text is left out on purpose and claimed apart
 * (`lorebookTextView`): a read that hands no text over must not vouch for it, or a later light
 * read would silence the note that the text the assistant holds has moved.
 */
export function lorebookRevisionView(book: Lorebook): unknown {
	return {
		name: book.name,
		everyChat: !!book.global,
		own: BOOK_KNOBS.map((knob) => book[knob] ?? null),
		entries: book.entries.map((entry) => entryRow(entry, false))
	};
}

/** A book's entry text, what the `lorebook_text` claim hashes: only a read or a write that
 *  hands text over may claim it. */
export function lorebookTextView(book: Lorebook): unknown {
	return book.entries.map((entry) => [entry.id, entry.content]);
}

// ===== the defaults =====

/**
 * The defaults as stored, merged over the stock values the way the editor's store reads them,
 * so a row written by an older version still answers for every setting. Throws on a row that
 * will not parse: it is reported and left alone, never overwritten with a guess.
 */
export function parseLorebookDefaults(raw: string | null): LorebookGlobalSettings {
	if (!raw) return { ...DEFAULT_LOREBOOK_GLOBAL_SETTINGS };
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the stored lorebook defaults are not an object');
	return { ...DEFAULT_LOREBOOK_GLOBAL_SETTINGS, ...(parsed as Partial<LorebookGlobalSettings>) };
}

// ===== one book =====

/** The activation settings a book sets itself. Whatever it leaves out follows the defaults, which
 *  every read hands over beside it, so a resolved copy would only say the defaults twice. */
export function ownSettings(book: Lorebook): Partial<ResolvedActivation> {
	const out: Partial<Record<BookKnob, unknown>> = {};
	for (const knob of BOOK_KNOBS) if (book[knob] != null) out[knob] = book[knob];
	return out as Partial<ResolvedActivation>;
}

/** What a switch following the book reads as, the value Select by reads for it. */
export function facetDefaults(book: Lorebook, defaults: LorebookGlobalSettings): LorebookFacetDefaults {
	const { caseSensitive, matchWholeWords, scanDepth } = resolveBookActivation(book, defaults);
	return { caseSensitive, matchWholeWords, scanDepth };
}

// ===== the census: what a book's entries hold between them =====

/** Each facet by the name the tools give it. */
const FACET_NAME: Record<LorebookFacet, string> = {
	nature: 'behavior',
	filter: 'logic',
	probability: 'probability',
	caseSensitive: 'caseSensitive',
	matchWholeWords: 'matchWholeWords',
	scanDepth: 'scanDepth',
	scanFields: 'scanFields',
	wokenBy: 'wokenBy',
	wakesOthers: 'wakesOthers',
	triggers: 'triggers',
	timing: 'timing',
	group: 'group',
	placement: 'placement'
};

const FACET_BY_NAME = new Map(LOREBOOK_FACETS.map((facet) => [FACET_NAME[facet], facet]));

/** What an empty list answers, per facet: nothing extra scanned, every kind, no window, no group. */
const EMPTY_ANSWER: Partial<Record<LorebookFacet, string>> = {
	filter: 'none',
	scanFields: 'none',
	triggers: 'all',
	timing: 'none',
	group: 'none'
};

/**
 * The answers one entry gives a facet, in the tools' words: Select by's own answers, renamed. The
 * census counts these and `where` matches them, so a filter can pick whatever the map shows. A
 * trigger list naming only kinds this app never generates answers `foreign` where Select by
 * answers nothing: such an entry never fires here, and a count leaving it out would not add up.
 */
export function entryAnswers(entry: LorebookEntry, facet: LorebookFacet, defaults: LorebookFacetDefaults): string[] {
	const answers = answersOf(entry, facet, defaults).map((answer) => wireAnswer(facet, answer));
	return answers.length === 0 && facet === 'triggers' ? ['foreign'] : answers;
}

/** One of Select by's answers in the tools' words. */
function wireAnswer(facet: LorebookFacet, answer: string): string {
	if (answer === '') return EMPTY_ANSWER[facet] ?? answer;
	switch (facet) {
		case 'filter':
			return LOGIC_NAME[Number(answer)] ?? answer;
		case 'caseSensitive':
		case 'matchWholeWords':
		case 'wakesOthers':
			return answer === 'on' ? 'true' : 'false';
		case 'placement':
			return answer === String(LOREBOOK_POSITION_BLOCK) ? 'block' : answer === String(LOREBOOK_POSITION_AT_DEPTH) ? 'depth' : 'foreign';
		default:
			return answer;
	}
}

/** The answers that say nothing: a facet no entry answers otherwise is left off the map. */
function isBaseline(facet: LorebookFacet, answer: string, defaults: LorebookFacetDefaults): boolean {
	switch (facet) {
		case 'nature':
			return false;
		case 'filter':
			return answer === 'none' || answer === 'andAny';
		case 'probability':
			return answer === '100';
		case 'caseSensitive':
			return answer === String(defaults.caseSensitive);
		case 'matchWholeWords':
			return answer === String(defaults.matchWholeWords);
		case 'scanDepth':
			return answer === String(defaults.scanDepth);
		case 'wokenBy':
			return answer === 'both';
		case 'wakesOthers':
			return answer === 'true';
		case 'placement':
			return answer === 'block';
		default:
			return answer === EMPTY_ANSWER[facet];
	}
}

/** Past this many distinct answers a facet lists its commonest and sums the rest, so a book of
 *  thousands of entries still reads as one short map. */
export const CENSUS_ANSWERS = 12;
const OTHER = '(other)';

function capped(counts: Map<string, number>): Record<string, number> {
	const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const out: Record<string, number> = {};
	for (const [answer, n] of ranked.slice(0, CENSUS_ANSWERS)) out[answer] = n;
	const rest = ranked.slice(CENSUS_ANSWERS).reduce((sum, [, n]) => sum + n, 0);
	if (rest > 0) out[OTHER] = rest;
	return out;
}

/**
 * The settings a book's entries hold, as counts per answer, read the way Select by reads them:
 * the value in force, so an entry following the book answers with the book's value. Its size is
 * bounded by how many settings there are, never by how many entries: this is the map the
 * assistant reads a book of five thousand entries by.
 */
export function entryCensus(
	entries: readonly LorebookEntry[],
	defaults: LorebookFacetDefaults,
	estimate: (text: string) => number
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const facet of LOREBOOK_FACETS) {
		const counts = new Map<string, number>();
		for (const entry of entries) {
			for (const answer of entryAnswers(entry, facet, defaults)) counts.set(answer, (counts.get(answer) ?? 0) + 1);
		}
		if (counts.size === 0 || [...counts.keys()].every((answer) => isBaseline(facet, answer, defaults))) continue;
		out[FACET_NAME[facet]] = capped(counts);
	}
	if (entries.length > 0) {
		const orders = entries.map((e) => e.order);
		out.order = { min: Math.min(...orders), max: Math.max(...orders) };
	}
	const ruled = entries.filter((e) => e.keyRules && Object.keys(e.keyRules).length > 0).length;
	if (ruled > 0) out.keyRules = ruled;
	let enabled = 0;
	let always = 0;
	for (const entry of entries) {
		if (entry.disable) continue;
		const tokens = estimate(entry.content);
		enabled += tokens;
		if (entry.constant) always += tokens;
	}
	out.estimatedTokens = { enabled, alwaysOn: always };
	return out;
}

// ===== picking entries =====

/** A `where` in the census's own words: per facet the answers any one of which an entry must
 *  give (answers widen within a facet, facets narrow), and a span of orders. */
export interface EntryWhere {
	answers: Partial<Record<LorebookFacet, string[]>>;
	order: { from?: number; to?: number };
}

export type ParsedWhere = EntryWhere | { problems: string[] };

/** Whether a facet can give this answer at all: a filter naming one no entry could give would
 *  quietly match nothing and read as a book holding no such entry. */
function isAnswer(facet: LorebookFacet, wire: string): boolean {
	if (wire === EMPTY_ANSWER[facet]) return true;
	switch (facet) {
		case 'nature':
			return (BEHAVIORS as readonly string[]).includes(wire);
		case 'filter':
			return wire in LOGICS;
		case 'caseSensitive':
		case 'matchWholeWords':
		case 'wakesOthers':
			return wire === 'true' || wire === 'false';
		case 'probability':
		case 'scanDepth':
			return /^\d+$/.test(wire);
		case 'scanFields':
			return (SCAN_FIELD_IDS as readonly string[]).includes(wire);
		case 'wokenBy':
			return (WOKEN_BY as readonly string[]).includes(wire) || wire === 'never';
		case 'triggers':
			return (TRIGGER_IDS as readonly string[]).includes(wire) || wire === 'foreign';
		case 'timing':
			return LOREBOOK_TIMED_FIELDS.some((t) => t.field === wire);
		case 'group':
			return wire.trim() !== '';
		case 'placement':
			return wire === 'block' || wire === 'depth' || wire === 'foreign';
	}
}

/**
 * Read a `where` filter: census names to one answer or a list of them, plus an `order` span.
 * Every name and answer is checked, for the reason `isAnswer` gives.
 */
export function parseWhere(raw: Record<string, unknown>): ParsedWhere {
	const where: EntryWhere = { answers: {}, order: {} };
	const problems: string[] = [];
	for (const [name, value] of Object.entries(raw)) {
		if (name === 'order') {
			const span = value && typeof value === 'object' && !Array.isArray(value) ? (value as { from?: unknown; to?: unknown }) : null;
			const bound = (v: unknown) => (v === undefined ? undefined : typeof v === 'number' && Number.isFinite(v) ? v : NaN);
			const from = span ? bound(span.from) : NaN;
			const to = span ? bound(span.to) : NaN;
			if (Number.isNaN(from) || Number.isNaN(to) || (from === undefined && to === undefined)) {
				problems.push('`order` takes {from, to} with at least one number.');
			} else where.order = { from, to };
			continue;
		}
		const facet = FACET_BY_NAME.get(name);
		if (!facet) {
			problems.push(`"${name}" is not a setting to filter by. Use: ${[...FACET_BY_NAME.keys(), 'order'].join(', ')}.`);
			continue;
		}
		const list = Array.isArray(value) ? value : [value];
		if (!list.length || !list.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
			problems.push(`\`${name}\` takes one answer or a list of them.`);
			continue;
		}
		const answers: string[] = [];
		for (const v of list) {
			const wire = typeof v === 'number' ? String(v) : String(v).trim();
			if (!isAnswer(facet, wire)) problems.push(`"${wire}" is not an answer \`${name}\` can give.`);
			else answers.push(facet === 'probability' || facet === 'scanDepth' ? String(Number(wire)) : wire);
		}
		where.answers[facet] = answers;
	}
	return problems.length > 0 ? { problems } : where;
}

/** Which entries to act on or read, before the book is known. */
export interface EntrySelector {
	ids?: readonly string[];
	query?: string;
	where?: EntryWhere;
}

/** Case-insensitive, over the title, both key lists and the text. */
export function matchesQuery(entry: LorebookEntry, query: string): boolean {
	const q = query.toLowerCase();
	return [entry.comment, entry.key.join(' '), entry.keysecondary.join(' '), entry.content].join('\n').toLowerCase().includes(q);
}

/** The entries a selector picks, in the book's own order. Every criterion given narrows. */
export function selectEntries(entries: readonly LorebookEntry[], selector: EntrySelector, defaults: LorebookFacetDefaults): LorebookEntry[] {
	let out = [...entries];
	if (selector.ids) {
		const wanted = new Set(selector.ids);
		out = out.filter((e) => wanted.has(e.id));
	}
	if (selector.query) {
		const query = selector.query;
		out = out.filter((e) => matchesQuery(e, query));
	}
	const where = selector.where;
	if (!where) return out;
	const { from, to } = where.order;
	const facets = Object.entries(where.answers) as [LorebookFacet, string[]][];
	return out.filter((entry) => {
		if ((from !== undefined && entry.order < from) || (to !== undefined && entry.order > to)) return false;
		return facets.every(([facet, wanted]) => entryAnswers(entry, facet, defaults).some((answer) => wanted.includes(answer)));
	});
}

// ===== writing settings =====

/** A per-key rule change: an object merges into the key's rule (a null field drops that field),
 *  null drops the whole rule so the key follows its entry again. */
export type KeyRulePatch = { mode?: LorebookKeyRule['mode'] | null; caseSensitive?: boolean | null } | null;

/** Rules to write, by key text, with "*" for every key an entry holds. */
export type KeyRulesPatch = Record<string, KeyRulePatch>;

/** The keys a rule can speak for: a `/regex/` key answers to its own flags and takes none. */
function ruleableKeys(entry: LorebookEntry): string[] {
	return [...new Set([...entry.key, ...entry.keysecondary])].filter((key) => !parseRegexKey(key));
}

/**
 * One key's rule after a change, kept to what differs from the match the key would inherit from
 * its entry: the chip stores only that (KeyChipInput `setRule`), so a rule naming the inherited
 * mode would pin a key the editor leaves following the entry and its book.
 */
function mergeRule(current: LorebookKeyRule | undefined, patch: Exclude<KeyRulePatch, null>, inherited: ResolvedKeyMatch): LorebookKeyRule | undefined {
	const next: LorebookKeyRule = { ...current };
	if (patch.mode === null) delete next.mode;
	else if (patch.mode !== undefined) next.mode = patch.mode;
	if (patch.caseSensitive === null) delete next.caseSensitive;
	else if (patch.caseSensitive !== undefined) next.caseSensitive = patch.caseSensitive;
	if (next.mode === inherited.mode) delete next.mode;
	if (next.caseSensitive === inherited.caseSensitive) delete next.caseSensitive;
	return next.mode !== undefined || next.caseSensitive !== undefined ? next : undefined;
}

/** One entry's rules after a patch, "*" first so a named key can still differ from the rest.
 *  `defaults` is what the entry's keys inherit once its own patch has landed. */
function withKeyRules(entry: LorebookEntry, patch: KeyRulesPatch, defaults: { caseSensitive: boolean; matchWholeWords: boolean }): LorebookKeyRules | undefined {
	const keys = ruleableKeys(entry);
	const rules: LorebookKeyRules = { ...entry.keyRules };
	const named = Object.keys(patch).sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : 0));
	for (const name of named) {
		const targets = name === '*' ? keys : keys.includes(name) ? [name] : [];
		for (const key of targets) {
			const change = patch[name];
			const next = change === null ? undefined : mergeRule(rules[key], change, resolveKeyMatch(key, undefined, defaults));
			if (next) rules[key] = next;
			else delete rules[key];
		}
	}
	return Object.keys(rules).length > 0 ? rules : undefined;
}

/**
 * What each entry shows for a staged setting, read the way the Edit… dialog reads it to decide
 * whether a press changes anything. Typed over every key of the edit, like the dialog's knobs.
 */
const SHOWN: { [K in keyof LorebookBulkEdit]-?: (entry: LorebookEntry, defaults: LorebookFacetDefaults) => unknown } = {
	nature: (e) => natureOf(e),
	selectiveLogic: (e) => e.selectiveLogic,
	order: (e) => e.order,
	probability: (e) => (e.useProbability ? e.probability : 100),
	caseSensitive: (e, d) => e.caseSensitive ?? d.caseSensitive,
	matchWholeWords: (e, d) => e.matchWholeWords ?? d.matchWholeWords,
	scanDepth: (e, d) => e.scanDepth ?? d.scanDepth,
	scanFields: () => undefined,
	wokenBy: (e) => lorebookWokenBy(resolveEntryRecursion(e)),
	delayLevel: (e) => Math.max(1, resolveEntryRecursion(e).delayLevel),
	wakesOthers: (e) => !resolveEntryRecursion(e).preventRecursion,
	triggers: () => undefined,
	sticky: (e) => e.sticky || null,
	cooldown: (e) => e.cooldown || null,
	delay: (e) => e.delay || null,
	group: (e) => e.group ?? '',
	groupWeight: (e) => e.groupWeight ?? DEFAULT_GROUP_WEIGHT,
	groupOverride: (e) => e.groupOverride ?? false,
	useGroupScoring: (e) => e.useGroupScoring ?? false,
	position: (e) => e.position ?? LOREBOOK_POSITION_BLOCK,
	depth: (e) => e.depth ?? DEFAULT_LOREBOOK_DEPTH,
	role: (e) => e.role ?? 0
};

/** Whether an entry already holds a list member: a trigger alias counts as its kind. */
function holdsMember(entry: LorebookEntry, list: 'scanFields' | 'triggers', member: string): boolean {
	if (list === 'scanFields') return (entry.scanFields as string[] | undefined)?.includes(member) ?? false;
	return (entry.triggers ?? []).some((t) => TRIGGER_ALIASES[member as keyof typeof TRIGGER_ALIASES]?.includes(t));
}

/** The three settings where null follows the book, and so shows the book's own value. */
function isInheritable(key: keyof LorebookBulkEdit): key is keyof LorebookFacetDefaults {
	return key === 'caseSensitive' || key === 'matchWholeWords' || key === 'scanDepth';
}

/**
 * The edit as the Edit… dialog would have staged it for these entries: a setting every entry
 * already shows is dropped, and a list member every entry already holds (or none holds, for a
 * removal) with it.
 */
function stagedFor(entries: readonly LorebookEntry[], edit: LorebookBulkEdit, defaults: LorebookFacetDefaults): LorebookBulkEdit {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(edit) as (keyof LorebookBulkEdit)[]) {
		const value = edit[key];
		if (value === undefined) continue;
		if (key === 'scanFields' || key === 'triggers') {
			const members: Record<string, boolean> = {};
			for (const [member, on] of Object.entries(value as Record<string, boolean>)) {
				const holding = entries.filter((e) => holdsMember(e, key, member)).length;
				if (!(on ? holding === entries.length : holding === 0)) members[member] = on;
			}
			if (Object.keys(members).length) out[key] = members;
			continue;
		}
		const shown = value === null && isInheritable(key) ? defaults[key] : value;
		if (!entries.every((e) => Object.is(SHOWN[key](e, defaults), shown))) out[key] = value;
	}
	return out as LorebookBulkEdit;
}

/** What a settings write would do to a set of entries, worked out before anything is written. */
export interface EntrySettingsPlan {
	/**
	 * The patch every picked entry takes, keyed by the entry itself so two entries sharing an id
	 * still get their own. Empty when every entry already shows everything staged.
	 */
	patches: Map<LorebookEntry, Partial<LorebookEntry>>;
	/** The picked entries that show a difference once the patches land. */
	changed: LorebookEntry[];
	/** Staged settings that mean nothing for any of these entries, which the call must refuse. */
	inert: (keyof LorebookBulkEdit)[];
	/** Keys the rules name that none of these entries holds, and `/regex/` keys named by text. */
	unknownKeys: string[];
	regexKeys: string[];
}

/**
 * Plan a settings write over the picked entries the way the Edit… dialog applies one: what every
 * entry already shows is dropped, and the rest is the bulk editor's own patch written to every
 * picked entry, including those it changes nothing visible for, so an entry configured here
 * cannot drift from its hand-edited twin once it gains the secondary keys, group or placement
 * the setting waits on. A setting the dialog would not offer for this pick (a filter with no
 * secondary keys, a group rule outside any group, a depth outside the chat, a level for an entry
 * that does not wait) is reported rather than written, since nothing would read it.
 */
export function planEntrySettings(
	entries: readonly LorebookEntry[],
	edit: LorebookBulkEdit,
	keyRules: KeyRulesPatch | undefined,
	defaults: LorebookFacetDefaults
): EntrySettingsPlan {
	const staged = stagedFor(entries, edit, defaults);
	const offered = offeredEdit(entries, staged);
	const inert = (Object.keys(staged) as (keyof LorebookBulkEdit)[]).filter((key) => offered[key] === undefined);
	const unknownKeys: string[] = [];
	const regexKeys: string[] = [];
	if (keyRules) {
		for (const name of Object.keys(keyRules)) {
			if (name === '*') continue;
			if (parseRegexKey(name)) regexKeys.push(name);
			else if (!entries.some((e) => ruleableKeys(e).includes(name))) unknownKeys.push(name);
		}
	}
	const patches = new Map<LorebookEntry, Partial<LorebookEntry>>();
	const changed: LorebookEntry[] = [];
	for (const entry of entries) {
		const patch: Partial<LorebookEntry> = bulkEntryPatch(entry, offered);
		if (keyRules) {
			const after = { ...entry, ...patch };
			const rules = withKeyRules(entry, keyRules, {
				caseSensitive: after.caseSensitive ?? defaults.caseSensitive,
				matchWholeWords: after.matchWholeWords ?? defaults.matchWholeWords
			});
			if (JSON.stringify(rules ?? null) !== JSON.stringify(entry.keyRules ?? null)) patch.keyRules = rules;
		}
		if (Object.keys(patch).length) patches.set(entry, patch);
		if (JSON.stringify(entryRow({ ...entry, ...patch }, true)) !== JSON.stringify(entryRow(entry, true))) changed.push(entry);
	}
	// Nothing any entry would show differently: the dialog would have staged nothing at all.
	if (!changed.length) patches.clear();
	return { patches, changed, inert, unknownKeys, regexKeys };
}
