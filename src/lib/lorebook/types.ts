/**
 * Lorebook domain model.
 *
 * A lorebook (SillyTavern: "World Info" / "character_book") is a first-class, standalone
 * record: a named collection of entries injected into the prompt when their keywords appear.
 * Characters and personas LINK to lorebooks by id (see `LibraryEntryData.lorebookIds`), a chat
 * can attach its own on top of those (`ChatFeatureState.lorebooks`), and a book can be switched
 * into every chat at once (`Lorebook.global`). All three meet in `resolveLorebookLinks`.
 *
 * Entries use SillyTavern's native World Info field names VERBATIM (`key`, `keysecondary`,
 * `selectiveLogic`, `constant`, `disable`, `order`, `probability`, `caseSensitive`,
 * `matchWholeWords`, `scanDepth`, `triggers`, the `match*` source flags, the recursion flags, …)
 * so import/export is a passthrough, not a translation. The fields we deliberately don't surface
 * (characterFilter, automationId, vectorization, …) ride along untouched in `rest`, so a book
 * round-trips losslessly through SillyTavern either way.
 */

import type { CharacterTraits } from '$lib/types/library';
import type { PortraitFocus } from '$lib/utils/portrait-focus';

/**
 * SillyTavern's selectiveLogic enum: how primary and secondary keys combine.
 * AND_ANY=0, NOT_ALL=1, NOT_ANY=2, AND_ALL=3.
 */
export const LOREBOOK_LOGICS: { id: number; label: string; hint: string }[] = [
	{ id: 0, label: 'AND ANY', hint: 'A primary key matches AND at least one secondary key matches.' },
	{ id: 3, label: 'AND ALL', hint: 'A primary key matches AND every secondary key matches.' },
	{ id: 2, label: 'NOT ANY', hint: 'A primary key matches AND none of the secondary keys match.' },
	{ id: 1, label: 'NOT ALL', hint: 'A primary key matches AND not all secondary keys match.' }
];

// ===== how one key is matched =====

/**
 * How one key is matched against the text.
 *
 * `regex` is never stored as a mode: a key WRITTEN as `/pattern/flags` is one, which is also
 * how SillyTavern writes regex keys, so that mode needs no side channel and survives a round
 * trip on its own. The other three are ChungusHub's, carried per key in {@link LorebookKeyRules}.
 */
export type LorebookKeyMode = 'substring' | 'word' | 'start' | 'regex';

/** The three storable modes, in the order the chip's picker offers them. */
export const LOREBOOK_KEY_MODES: { id: Exclude<LorebookKeyMode, 'regex'>; label: string; hint: string }[] = [
	{ id: 'substring', label: 'Anywhere', hint: 'Matches wherever the letters appear, even inside another word.' },
	{ id: 'word', label: 'Whole word', hint: 'Matches only as its own word, so “art” stays out of “cartography”.' },
	{ id: 'start', label: 'Word start', hint: 'Matches any word beginning with it: plurals, and other suffixes.' }
];

/** One key's override of the entry's match defaults. An absent field inherits. */
export interface LorebookKeyRule {
	/** `regex` never lands here: the key's own `/…/` syntax carries that mode. */
	mode?: Exclude<LorebookKeyMode, 'regex'>;
	caseSensitive?: boolean;
}

/**
 * Per-key overrides for one entry, by the key's own text. Primary and secondary keys share
 * one map: the same word matched two ways inside a single entry is a distinction nobody wants,
 * and keying by text (rather than by position) survives reordering a chip list.
 */
export type LorebookKeyRules = Record<string, LorebookKeyRule>;

/** Only the flags a RegExp actually takes, so a plain key like `and/or x` stays plain. */
const REGEX_KEY_RE = /^\/(.+)\/([dgimsuvy]*)$/;

/** A key written `/pattern/flags` (SillyTavern's own regex-key syntax), split, or null. */
export function parseRegexKey(key: string): { pattern: string; flags: string } | null {
	const hit = REGEX_KEY_RE.exec(key.trim());
	return hit ? { pattern: hit[1], flags: hit[2] } : null;
}

/**
 * Compile a regex key, or null when the pattern is unusable. The ONE compile: the scan runs it
 * and the chip marks it, so a pattern the editor accepts can never be one the scan refuses.
 *
 * `g` and `y` are dropped. One RegExp is reused across every source in a pass, and a sticky
 * `lastIndex` would carry from one turn into the next and start losing matches.
 */
export function compileRegexKey(regex: { pattern: string; flags: string }): RegExp | null {
	try {
		return new RegExp(regex.pattern, regex.flags.replace(/[gy]/g, ''));
	} catch {
		return null;
	}
}

/** Drop the rules of keys the entry no longer carries, so a removed chip leaves nothing behind. */
export function pruneKeyRules(
	rules: LorebookKeyRules | undefined,
	keys: string[]
): LorebookKeyRules | undefined {
	if (!rules) return undefined;
	const live = new Set(keys);
	const out: LorebookKeyRules = {};
	for (const [key, rule] of Object.entries(rules)) {
		if (live.has(key)) out[key] = rule;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** How one key of one entry is matched, once its rule has resolved over the entry's defaults. */
export interface ResolvedKeyMatch {
	mode: LorebookKeyMode;
	caseSensitive: boolean;
	/** Regex keys only: what was written between the slashes. */
	regex?: { pattern: string; flags: string };
}

/**
 * Resolve one key's matching: its own rule over the entry's resolved defaults. The ONE place
 * a key's effective mode is decided, so the chip's picker can never name a mode the scan won't
 * apply (architecture/lorebook.md coupling #5).
 *
 * A regex key answers only to its own slashes, its `i` flag included: an entry-level
 * case-sensitivity switch has nothing to say about a pattern the author wrote out.
 */
export function resolveKeyMatch(
	key: string,
	rules: LorebookKeyRules | undefined,
	defaults: { caseSensitive: boolean; matchWholeWords: boolean }
): ResolvedKeyMatch {
	const regex = parseRegexKey(key);
	if (regex) return { mode: 'regex', caseSensitive: !regex.flags.includes('i'), regex };
	const rule = rules?.[key] ?? {};
	// A key with whitespace never INHERITS whole-word: SillyTavern applies that flag to
	// single-word keys only, and a phrase quietly gaining word boundaries would change what
	// every existing book matches. Picking `word` on the chip still applies it to a phrase.
	const inherited: LorebookKeyMode = defaults.matchWholeWords && !/\s/.test(key) ? 'word' : 'substring';
	return {
		mode: rule.mode ?? inherited,
		caseSensitive: rule.caseSensitive ?? defaults.caseSensitive
	};
}

// ===== what the scan reads besides the chat =====

/**
 * The story fields an entry can scan on top of the chat, each with the SillyTavern flag that
 * carries it in both interchange shapes (flat native World Info, snake_case card extensions).
 * This ONE table drives the engine's sources, the editor's toggles and both import/export
 * mappings, so a new source is a single row.
 */
export const LOREBOOK_SCAN_FIELDS = [
	{ id: 'characterDescription', label: 'Description', native: 'matchCharacterDescription', card: 'match_character_description' },
	{ id: 'characterPersonality', label: 'Personality', native: 'matchCharacterPersonality', card: 'match_character_personality' },
	{ id: 'scenario', label: 'Scenario', native: 'matchScenario', card: 'match_scenario' },
	{ id: 'personaDescription', label: 'Persona', native: 'matchPersonaDescription', card: 'match_persona_description' },
	{ id: 'creatorNotes', label: 'Creator’s notes', native: 'matchCreatorNotes', card: 'match_creator_notes' }
] as const;

export type LorebookScanField = (typeof LOREBOOK_SCAN_FIELDS)[number]['id'];

/** The scannable text of the cards in play, gathered for {@link LOREBOOK_SCAN_FIELDS}. */
export type LorebookScanFieldText = Partial<Record<LorebookScanField, string>>;

/** Join what several characters carry in one field; a group chat scans all of them. */
function joinTrait(characters: { traits: CharacterTraits }[], key: keyof CharacterTraits): string {
	return characters
		.map((c) => c.traits[key] ?? '')
		.filter((t) => t.trim().length > 0)
		.join('\n');
}

/**
 * The story text a scan may read besides the chat, off the cards in play. The ONE derivation:
 * generation, the live meters and the memory context all call it, so an entry that scans the
 * scenario reads the same scenario at every surface (architecture/lorebook.md coupling #6).
 */
export function lorebookScanFields(
	characters: { traits: CharacterTraits }[],
	persona: { traits: CharacterTraits } | null | undefined
): LorebookScanFieldText {
	return {
		characterDescription: joinTrait(characters, 'description'),
		characterPersonality: joinTrait(characters, 'personality'),
		scenario: joinTrait(characters, 'scenario'),
		creatorNotes: joinTrait(characters, 'creatorNotes'),
		personaDescription: persona ? persona.traits.description : ''
	};
}

// ===== what wakes an entry, and what it wakes =====

/**
 * Each recursion flag under both SillyTavern spellings: the flat native World Info name, and
 * the snake_case name it wears inside a character card's `character_book`. This ONE table
 * drives the reader below, both import mappings and both export mappings, so a flag can never
 * be written under a name the other side does not read.
 */
export const RECURSION_FIELDS = {
	excludeRecursion: 'exclude_recursion',
	preventRecursion: 'prevent_recursion',
	delayUntilRecursion: 'delay_until_recursion'
} as const;

export type LorebookRecursionField = keyof typeof RECURSION_FIELDS;

/** An entry's recursion settings, resolved. */
export interface ResolvedRecursion {
	/** Another entry's content cannot wake it; only the chat and the card fields can. */
	excludeRecursion: boolean;
	/** Its own content is never re-scanned, so it wakes nobody. */
	preventRecursion: boolean;
	/** The recursion level it waits for. 0 = it may fire from the first pass. */
	delayLevel: number;
}

/**
 * One flag's stored value: the modelled field, else either spelling an earlier import left in
 * `rest`. Rows written before these fields existed are never rewritten, so both are read; an
 * explicit `false` on the modelled field stops the fallback, which is what makes clearing a
 * flag in the editor stick.
 */
function storedRecursion(entry: LorebookEntry, field: LorebookRecursionField): unknown {
	return entry[field] ?? entry.rest[field] ?? entry.rest[RECURSION_FIELDS[field]];
}

/**
 * An entry's recursion settings. The ONE reader: the engine gates with it, the entry row labels
 * its control from it, and both exporters write through it, so the row can never name a
 * behaviour the scan will not apply (architecture/lorebook.md coupling #9).
 */
export function resolveEntryRecursion(entry: LorebookEntry): ResolvedRecursion {
	// SillyTavern writes the delay as `true` or as the recursion level to wait for.
	const delay = storedRecursion(entry, 'delayUntilRecursion');
	return {
		excludeRecursion: storedRecursion(entry, 'excludeRecursion') === true,
		preventRecursion: storedRecursion(entry, 'preventRecursion') === true,
		delayLevel:
			delay === true ? 1 : typeof delay === 'number' && delay >= 1 ? Math.floor(delay) : 0
	};
}

/** The stored form of a resolved delay: `true` for the first level, the level itself above it. */
export function delayValue(delayLevel: number): boolean | number {
	if (delayLevel < 1) return false;
	return delayLevel > 1 ? delayLevel : true;
}

/**
 * `rest` without the recursion flags in either spelling. Written whenever the editor settles
 * the modelled fields: a copy left behind would keep answering for a flag the reader already
 * has, and the two would drift apart on the next edit.
 */
export function withoutStoredRecursion(rest: Record<string, unknown>): Record<string, unknown> {
	const out = { ...rest };
	for (const [field, card] of Object.entries(RECURSION_FIELDS)) {
		delete out[field];
		delete out[card];
	}
	return out;
}

/**
 * The three settings read as one choice: what may wake this entry. `never` is the pair that
 * cancels out (it waits for recursion and refuses to be woken by it), which only a SillyTavern
 * import can carry, and which the editor names rather than offers.
 */
export type LorebookWokenBy = 'both' | 'chatOnly' | 'entriesOnly' | 'never';

export function lorebookWokenBy(recursion: ResolvedRecursion): LorebookWokenBy {
	if (recursion.excludeRecursion) return recursion.delayLevel > 0 ? 'never' : 'chatOnly';
	return recursion.delayLevel > 0 ? 'entriesOnly' : 'both';
}

// ===== where an entry lands =====

/**
 * SillyTavern's `position` enum, carried verbatim. Only two of its eight values name a place
 * this app has: 4 puts the entry at a depth inside the chat, and every other value puts it in
 * the `{{lorebook}}` block the preset placed. The other six describe SillyTavern's own prompt
 * skeleton (its author's note, its example-message block), which we do not have; they survive
 * a round trip untouched and read here as the block.
 */
export const LOREBOOK_POSITION_BLOCK = 0;
export const LOREBOOK_POSITION_AT_DEPTH = 4;

/** SillyTavern's own name for a position this app cannot place, so an imported entry says what
 *  it actually is instead of quietly reading as one of ours. */
export const ST_POSITION_NAMES: Record<number, string> = {
	1: 'After the character (SillyTavern)',
	2: 'Author’s note, top (SillyTavern)',
	3: 'Author’s note, bottom (SillyTavern)',
	5: 'Example messages, top (SillyTavern)',
	6: 'Example messages, bottom (SillyTavern)',
	7: 'Outlet (SillyTavern)'
};

/** The turn role an at-depth injection wears. */
export type LorebookRole = 'system' | 'user' | 'assistant';

/** SillyTavern's `role` enum for at-depth entries: system 0, user 1, assistant 2. */
export const LOREBOOK_ROLES: { id: number; label: string; role: LorebookRole }[] = [
	{ id: 0, label: 'System', role: 'system' },
	{ id: 1, label: 'User', role: 'user' },
	{ id: 2, label: 'Assistant', role: 'assistant' }
];

/** How far back an at-depth entry lands when it names no depth. SillyTavern's own default. */
export const DEFAULT_LOREBOOK_DEPTH = 4;

/** Whether an entry asks to be placed inside the chat rather than in the block. */
export function lorebookIsAtDepth(entry: LorebookEntry): boolean {
	return (entry.position ?? LOREBOOK_POSITION_BLOCK) === LOREBOOK_POSITION_AT_DEPTH;
}

/** The role an at-depth entry wears, its `role` number resolved. Unknown numbers read as system. */
export function lorebookRoleOf(entry: LorebookEntry): LorebookRole {
	return LOREBOOK_ROLES.find((r) => r.id === (entry.role ?? 0))?.role ?? 'system';
}

/**
 * One at-depth injection: the entries that share a role and a depth, joined into a single turn.
 * A stack of five entries is not five turns littered through the story, the same rule steering
 * lives by (architecture/engines.md).
 */
export interface LorebookPlacedGroup {
	role: LorebookRole;
	/** Turns back from the newest injected one; 0 lands after it. */
	depth: number;
	text: string;
}

// ===== which generations an entry fires on =====

/** What the app is generating. An entry naming its kinds sits out every other one. */
export type LorebookTrigger = 'normal' | 'swipe' | 'continue' | 'impersonate';

/** The kinds the editor offers, labelled in the app's own words. Values are SillyTavern's
 *  own trigger tokens, so the filter exports natively. */
export const LOREBOOK_TRIGGERS: { id: LorebookTrigger; label: string }[] = [
	{ id: 'normal', label: 'Send' },
	{ id: 'swipe', label: 'Regenerate' },
	{ id: 'continue', label: 'Continue' },
	{ id: 'impersonate', label: 'Impersonate' }
];

/** SillyTavern splits replacing a reply from swiping a new one; one Regenerate answers both.
 *  Exported so the editor's pills read and clear the same tokens the engine answers to. */
export const TRIGGER_ALIASES: Record<LorebookTrigger, string[]> = {
	normal: ['normal'],
	swipe: ['swipe', 'regenerate'],
	continue: ['continue'],
	impersonate: ['impersonate']
};

/** Whether an entry's trigger list admits the generation in progress. Empty = every kind. */
export function firesOnTrigger(triggers: string[] | undefined, current: LorebookTrigger): boolean {
	if (!triggers?.length) return true;
	return TRIGGER_ALIASES[current].some((t) => triggers.includes(t));
}

export interface LorebookEntry {
	/** Our stable id. SillyTavern's per-book `uid` is positional and regenerated on export. */
	id: string;
	/** Title / memo. Organizational only, never sent to the model. */
	comment: string;
	/** Primary trigger keywords. */
	key: string[];
	/** Optional secondary keywords, combined with `key` via `selectiveLogic`. */
	keysecondary: string[];
	/** How primary & secondary keys combine (see LOREBOOK_LOGICS). Ignored when `keysecondary` is empty. */
	selectiveLogic: number;
	/** The text injected into context when the entry activates. */
	content: string;
	/** Always active regardless of keywords (SillyTavern's blue circle). */
	constant: boolean;
	/** When true the entry is inert: never scanned, never injected. */
	disable: boolean;
	/** Injection priority: lower numbers are injected first. */
	order: number;
	/** Trigger chance in percent (SillyTavern "Trigger %"). Applied when `useProbability` is true. */
	probability: number;
	useProbability: boolean;
	/** Keys must match case as written. null = use the default (insensitive). */
	caseSensitive: boolean | null;
	/** Single-word keys match only as whole words. null = use the default (on). */
	matchWholeWords: boolean | null;
	/**
	 * Per-key overrides of the two fields above, plus each key's mode. Absent (or a key with
	 * no rule) = that key follows the entry. Older rows carry none, which is why it is optional.
	 */
	keyRules?: LorebookKeyRules;
	/** Scan window for THIS entry, in messages. 0 = the whole chat, null/absent = follow the book. */
	scanDepth?: number | null;
	/** Story fields scanned besides the chat. Empty/absent = the chat only. */
	scanFields?: LorebookScanField[];
	/** Generation kinds this entry fires on ({@link LOREBOOK_TRIGGERS}). Empty/absent = all. */
	triggers?: string[];
	/** Once it fires on its own, it stays in for this many more generations. 0/absent = none. */
	sticky?: number | null;
	/** After that window closes, it cannot fire again for this many generations. */
	cooldown?: number | null;
	/** It cannot fire at all until the chat holds this many messages. */
	delay?: number | null;
	/** Inclusion group labels, comma-joined (SillyTavern's own shape). Empty/absent = ungrouped. */
	group?: string;
	/** Wins its group ahead of every candidate that does not set it. */
	groupOverride?: boolean;
	/** Its share of its group's weighted pick. Absent = {@link DEFAULT_GROUP_WEIGHT}. */
	groupWeight?: number;
	/** Decide this group by how many keys matched instead of by weight. */
	useGroupScoring?: boolean | null;
	/** Where the entry lands ({@link LOREBOOK_POSITION_BLOCK} / {@link LOREBOOK_POSITION_AT_DEPTH}
	 *  and SillyTavern's own structural values). Absent = the block. */
	position?: number;
	/** At-depth only: turns back from the newest one. Absent = {@link DEFAULT_LOREBOOK_DEPTH}. */
	depth?: number;
	/** At-depth only: the role the injected turn wears ({@link LOREBOOK_ROLES}). Absent = system. */
	role?: number | null;
	/** Another entry's content cannot wake it. Absent = the copy in `rest`, else off. */
	excludeRecursion?: boolean;
	/** Its own content is never re-scanned, so it wakes nobody. Absent reads the same way. */
	preventRecursion?: boolean;
	/** It waits for recursion. `true` is the first level, a number names the level. */
	delayUntilRecursion?: boolean | number;
	/**
	 * Every other SillyTavern field (characterFilter, automationId, vectorized, …), carried
	 * verbatim so export → import in SillyTavern is lossless. Apart from the recursion flags
	 * an older row may still hold here ({@link resolveEntryRecursion}), the app never reads these.
	 */
	rest: Record<string, unknown>;
}

/**
 * Global activation settings: app-wide defaults for how every book scans and injects.
 * Each book can override any of them (`null` on the book = inherit these); an entry's
 * tri-state match fields override the book in turn (entry → book → global).
 */
export interface LorebookGlobalSettings {
	/** How many of the most recent messages to scan for keywords. 0 = scan the whole chat. */
	scanDepth: number;
	/** Activated content is re-scanned so entries can activate each other. */
	recursiveScanning: boolean;
	/** Max recursion passes after the chat scan. 0 = keep going until nothing new fires. */
	maxRecursionSteps: number;
	/**
	 * Whether recursion reaches across the books in play, so an entry can wake one in another
	 * book. This is a property of the whole scan rather than of any one book, which is why it
	 * has no book layer: two books cannot disagree about whether they read each other.
	 *
	 * Off by default. Turning it on widens what every existing setup injects and makes the
	 * per-book pass cap inert, since one shared loop can only be capped once, so it is a
	 * decision to take rather than one to inherit.
	 */
	crossBookRecursion: boolean;
	/** Default for entries that leave `caseSensitive` unset. */
	caseSensitive: boolean;
	/** Default for entries that leave `matchWholeWords` unset. */
	matchWholeWords: boolean;
	/**
	 * Max share of the prompt budget lorebook content may take, in percent (0–100).
	 * 0 = no limit. When exceeded, the lowest-priority entries (highest `order`) are
	 * dropped from the injection.
	 */
	budgetPercent: number;
}

export interface Lorebook {
	id: string;
	name: string;
	/**
	 * Cover art, as the stored `images/lorebooks/<file>` path. Absent = no cover, which is
	 * what every book made or imported before this carries. It never reaches a model and
	 * never leaves in an export: a World Info file is JSON, and the picture is a file.
	 */
	cover?: string;
	/** Where the cover's boxes aim inside it, the framing every portrait in the app uses.
	 *  Absent = the centred cover fit. Belongs to the picture, so replacing one drops it. */
	coverFocus?: PortraitFocus;
	/**
	 * In every chat, with no card linking it. Absent = off, which is every book made or
	 * imported before this and every book nobody switched on.
	 *
	 * Deliberately does NOT travel in an export: it is a decision about this install's whole
	 * setup rather than a property of what the book says, and a shared book that switched
	 * itself into every one of a stranger's chats would rewrite every prompt they send.
	 */
	global?: boolean;
	/**
	 * How many of the most recent messages to scan for keywords. 0 = scan the whole chat,
	 * null = inherit the global setting. (Books saved before the global settings existed
	 * carry their old concrete value, which now simply reads as an explicit override.)
	 */
	scanDepth: number | null;
	/**
	 * When on, an activated entry's content is scanned again so it can activate other entries
	 * by their keywords (SillyTavern's "Recursive scan"). null/undefined = inherit the global
	 * setting, so books predating the field follow the global default.
	 */
	recursiveScanning: boolean | null;
	/** Max recursion passes. 0 = until nothing new fires, null = inherit the global setting. */
	maxRecursionSteps: number | null;
	/** Book-level default for entries that leave `caseSensitive` unset. null = inherit global. */
	caseSensitive: boolean | null;
	/** Book-level default for entries that leave `matchWholeWords` unset. null = inherit global. */
	matchWholeWords: boolean | null;
	entries: LorebookEntry[];
	/** Book-level fields we don't model (description, token_budget, …), preserved for round-trip. */
	extensions: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

/** The activation knobs a book runs with once its `null`s have fallen back to the globals. */
export interface ResolvedActivation {
	scanDepth: number;
	recursiveScanning: boolean;
	maxRecursionSteps: number;
	caseSensitive: boolean;
	matchWholeWords: boolean;
}

/**
 * Resolve a book's activation knobs against the global settings: its own value where it sets
 * one, the global where it left `null`. The ONE book-over-global resolver, so a row in the
 * editor can never name a value the scan doesn't use (architecture/lorebook.md coupling #2).
 */
export function resolveBookActivation(
	book: Lorebook,
	settings: LorebookGlobalSettings
): ResolvedActivation {
	return {
		scanDepth: book.scanDepth ?? settings.scanDepth,
		recursiveScanning: book.recursiveScanning ?? settings.recursiveScanning,
		maxRecursionSteps: book.maxRecursionSteps ?? settings.maxRecursionSteps,
		caseSensitive: book.caseSensitive ?? settings.caseSensitive,
		matchWholeWords: book.matchWholeWords ?? settings.matchWholeWords
	};
}

/**
 * The one wording of an activation strip's collapsed line: what will actually run, in the
 * order the panel below it asks. Read by the open book's Activation strip and by the shelf's
 * Global Settings row, so the same setting cannot be named two ways one press apart.
 *
 * A part is `set` where the resolved value DIFFERS from the default it would otherwise take,
 * which is the reading the panel's stars give. The shelf passes the defaults as both, so
 * nothing is lit there: the root layer has nothing to differ from.
 *
 * `global` leads the line when the book is switched into every chat, and it is the one part
 * the shelf's own row can never carry: the switch lives in this panel now, so a folded strip
 * that did not say it would hide the widest thing a book can be doing behind one press.
 */
export function activationSummary(
	resolved: ResolvedActivation,
	settings: LorebookGlobalSettings,
	global = false
): { text: string; set: boolean }[] {
	const out = [
		{
			text: `scan ${resolved.scanDepth === 0 ? 'all' : resolved.scanDepth}`,
			set: resolved.scanDepth !== settings.scanDepth
		},
		{
			text: `recursion ${resolved.recursiveScanning ? 'on' : 'off'}`,
			set: resolved.recursiveScanning !== settings.recursiveScanning
		}
	];
	if (global) out.unshift({ text: 'every chat', set: true });
	if (resolved.recursiveScanning) {
		// While books recurse together there is one shared loop, so the cap that runs is the
		// global one; printing the book's own here would name a number the scan never uses.
		const passes = settings.crossBookRecursion ? settings.maxRecursionSteps : resolved.maxRecursionSteps;
		out.push({
			text: passes > 0 ? `≤${passes} passes` : '∞ passes',
			set: !settings.crossBookRecursion && resolved.maxRecursionSteps !== settings.maxRecursionSteps
		});
		if (settings.crossBookRecursion) out.push({ text: 'books together', set: false });
	}
	out.push({
		text: `case ${resolved.caseSensitive ? 'on' : 'off'}`,
		set: resolved.caseSensitive !== settings.caseSensitive
	});
	out.push({
		text: `whole words ${resolved.matchWholeWords ? 'on' : 'off'}`,
		set: resolved.matchWholeWords !== settings.matchWholeWords
	});
	out.push({
		text: `budget ${settings.budgetPercent > 0 ? `${settings.budgetPercent}%` : 'off'}`,
		set: false
	});
	return out;
}

// ===== the scan and what it decided =====

/**
 * One piece of text the scan reads, and where it came from. A message carries its distance
 * from the newest turn (0 = newest), which is what lets an entry clamp the window to its scan
 * depth and lets a match say which turn it hit. A field source is a card's own text, seen only
 * by the entries that opted into it. Recursion appends the content of entries that already
 * fired, so a match can name the entry that pulled another one in.
 */
export type LorebookScanSource =
	| { kind: 'message'; depth: number; text: string }
	| { kind: 'field'; field: LorebookScanField; text: string }
	| { kind: 'entry'; entryId: string; title: string; bookName: string; text: string };

/** Where a key was found. The scan source it hit, minus the text itself. */
export type LorebookMatchSource =
	| { kind: 'message'; depth: number }
	| { kind: 'field'; field: LorebookScanField }
	/** `bookName` names the waking entry's book, so a wake across books can say which one.
	 *  Absent on traces stored before recursion could cross them. */
	| { kind: 'entry'; entryId: string; title: string; bookName?: string };

/** A key that was found, and where. */
export interface LorebookKeyMatch {
	/** The key as written on the entry. */
	key: string;
	/** Primary keys decide whether an entry fires; secondary keys filter that decision. */
	role: 'primary' | 'secondary';
	source: LorebookMatchSource;
	/** The text around the hit, collapsed to one line and elided, for the reader. */
	excerpt: string;
}

/**
 * What the scan decided about one entry. `constant` and `keyword` are the two that reach the
 * prompt; every other value names the reason the entry's text is not in it.
 */
export type LorebookStatus =
	/** Fires without keywords. */
	| 'constant'
	/** Its keys matched. */
	| 'keyword'
	/** No primary key was found. */
	| 'noMatch'
	/** A primary key matched, then the secondary filter refused. */
	| 'filtered'
	/** Matched, then lost its Trigger % roll. */
	| 'rolledOut'
	/** Waits for another entry to wake it, and none that fired did. */
	| 'delayed'
	/** It waits for recursion and also refuses to be woken by it, so nothing can fire it. */
	| 'neverFires'
	/** Fired, then the token budget dropped it. */
	| 'trimmed'
	/** Switched off. */
	| 'disabled'
	/** Nothing to inject. */
	| 'empty'
	/** This kind of generation is not one it fires on. */
	| 'offTrigger'
	/** Still held in by the window that opened when it last fired. */
	| 'sticky'
	/** Fired recently, and its window has not reopened. */
	| 'cooldown'
	/** The chat is not long enough for it yet. */
	| 'tooEarly'
	/** Another entry in its inclusion group took the slot. */
	| 'groupLost';

/** Whether a status means the entry's text reached the prompt. */
export function lorebookWasInjected(status: LorebookStatus): boolean {
	return status === 'constant' || status === 'keyword' || status === 'sticky';
}

/**
 * Whether the entry EARNED its place on that turn rather than inheriting it from an earlier one.
 * Sticky windows and cooldowns are measured from these and no others, so a sticky entry cannot
 * keep renewing its own window and never let go.
 */
export function lorebookFiredNaturally(status: LorebookStatus): boolean {
	return status === 'constant' || status === 'keyword';
}

/** Statuses that carry no information beyond "this entry had nothing to say". */
const SILENT_STATUSES: readonly LorebookStatus[] = ['noMatch', 'disabled', 'empty', 'offTrigger'];

/** One entry's fate in one scan. */
export interface LorebookEntryRecord {
	bookId: string;
	bookName: string;
	entryId: string;
	/** The entry's title at scan time, stored so a trace still reads after the entry is gone. */
	title: string;
	status: LorebookStatus;
	/** Every key that was found. Empty when nothing matched. */
	matches: LorebookKeyMatch[];
	/** The chance a `rolledOut` entry failed. */
	probability?: number;
	/** Where an entry landed when it did not go into the `{{lorebook}}` block. */
	placedAt?: { role: LorebookRole; depth: number };
	/** The group a `groupLost` entry lost, and the entry that took the slot. Without this the
	 *  feature is invisible: the reader sees an entry that matched and did not arrive. */
	lostTo?: { group: string; title: string };
}

/**
 * What one earlier generation on the active path decided, as far as timed effects care: the
 * entries that earned their place on it. Derived from the trace that generation stored, so the
 * whole mechanism is branch-correct for free (a branch IS a path through turns) and no mutable
 * per-chat counter can drift out from under a swipe.
 */
export interface LorebookPastScan {
	fired: Set<string>;
}

/**
 * The scans earlier turns on this path recorded, newest first. The ONE derivation: every context
 * builder calls it over the same path it scans, so an entry's sticky window is the same length
 * at the meter as at the send (architecture/lorebook.md coupling #7).
 */
export function lorebookHistory(turns: { lorebook?: LorebookTrace | null }[]): LorebookPastScan[] {
	const out: LorebookPastScan[] = [];
	for (let i = turns.length - 1; i >= 0; i--) {
		const trace = turns[i].lorebook;
		if (!trace) continue;
		out.push({
			fired: new Set(trace.records.filter((r) => lorebookFiredNaturally(r.status)).map((r) => r.entryId))
		});
	}
	return out;
}

/**
 * What one scan decided, compact enough to store on the turn it shaped. Entries that simply
 * stayed silent are counted rather than listed: their reason is uniform, and a book of two
 * hundred entries would otherwise weigh more than the reply it rode with. The lorebook page's
 * live tester is where a silent entry is inspected, against text the reader chooses.
 */
export interface LorebookTrace {
	records: LorebookEntryRecord[];
	/** Entries that were scanned and stayed silent (no match, switched off, or empty). */
	silent: number;
}

export const EMPTY_LOREBOOK_TRACE: LorebookTrace = { records: [], silent: 0 };

/** Reduce a complete record list to the storable trace. */
export function buildLorebookTrace(records: LorebookEntryRecord[]): LorebookTrace {
	const kept = records.filter((r) => !SILENT_STATUSES.includes(r.status));
	return { records: kept, silent: records.length - kept.length };
}

/**
 * How the entry list orders itself on screen. Each value is a finished answer rather than a
 * field plus a direction: "Z → A" is the whole choice, so the reader picks once instead of
 * combining two questions in their head. Display only, exactly as the book order is.
 */
export type LorebookEntrySort =
	| 'order'
	| 'order-desc'
	| 'a-z'
	| 'z-a'
	| 'longest'
	| 'shortest'
	| 'most-keys'
	| 'fewest-keys';

/** Stock scan window (most recent N messages), the global setting's default. */
export const DEFAULT_SCAN_DEPTH = 25;

/** An entry's share of its inclusion group's pick when it names none. SillyTavern's own default. */
export const DEFAULT_GROUP_WEIGHT = 100;

/** The labels an entry's `group` names. SillyTavern stores them comma-joined in one string. */
export function lorebookGroupsOf(entry: LorebookEntry): string[] {
	return entry.group ? parseKeys(entry.group) : [];
}

/** The engine's stock behavior: what a fresh install (and every book pre-settings) got. */
export const DEFAULT_LOREBOOK_GLOBAL_SETTINGS: LorebookGlobalSettings = {
	scanDepth: DEFAULT_SCAN_DEPTH,
	recursiveScanning: true,
	maxRecursionSteps: 0,
	crossBookRecursion: false,
	caseSensitive: false,
	matchWholeWords: true,
	budgetPercent: 0
};

/**
 * Which of these ids still name a book, in link order, deduped.
 *
 * The question a COUNT of links asks, and deliberately not the one below: that one answers
 * what a chat plays with, which includes books no card links at all, and a chip counting
 * those would claim links the card has not made.
 */
export function resolveLinkedBooks(
	books: Lorebook[],
	ids: string[] | undefined | null
): Lorebook[] {
	if (!ids?.length) return [];
	const byId = new Map(books.map((b) => [b.id, b]));
	const out: Lorebook[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		const book = byId.get(id);
		if (book) out.push(book);
	}
	return out;
}

/**
 * Every way a chat names a book, one layer per source. Both keys are required rather than
 * optional: a surface that assembles a prompt has to answer both questions, and a key it could
 * simply leave out is a layer it can drop in silence.
 */
export interface LorebookLinks {
	/** What the cards this chat plays link: the character's list, then the persona's. */
	cards: string[] | null | undefined;
	/** What the chat itself attached (`ChatFeatureState.lorebooks`), from the setup chip. */
	chat: string[] | null | undefined;
}

/**
 * The books a chat plays with, widest layer first: every book switched into every chat, then
 * the ones its cards link, then the ones the chat attached for itself, deduped across all
 * three and dropping ids that no longer exist. The ONE implementation: the meters resolve
 * through the store's cached books and generation resolves through a fresh server read, but
 * both must produce the same list in the same order or the meter prices a different prompt
 * than the one sent (architecture/lorebook.md coupling #1).
 *
 * **A `global` book comes first and needs no link**: it is the world every story sits in, what
 * a card links is the specific on top of it, and what the chat named is the specific on top of
 * that. Each layer trails the one it narrows, so nothing a chat or a card names can reshuffle
 * the baseline under it.
 *
 * The globals are ordered by when they were made and never by the array they arrived in. The
 * store's cached array and the server's fresh read are the same query at two moments, so an
 * edit that moves a book in one and not the other would have the meter and the send lay lore
 * down in a different order.
 */
export function resolveLorebookLinks(books: Lorebook[], links: LorebookLinks): Lorebook[] {
	const out = books
		.filter((b) => b.global)
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	const seen = new Set(out.map((b) => b.id));
	for (const book of [
		...resolveLinkedBooks(books, links.cards),
		...resolveLinkedBooks(books, links.chat)
	]) {
		if (seen.has(book.id)) continue;
		seen.add(book.id);
		out.push(book);
	}
	return out;
}

/** A fresh book inherits every activation setting from the global defaults. */
export function createEmptyLorebook(name = ''): Lorebook {
	const now = Date.now();
	return {
		id: crypto.randomUUID(),
		name,
		scanDepth: null,
		recursiveScanning: null,
		maxRecursionSteps: null,
		caseSensitive: null,
		matchWholeWords: null,
		entries: [],
		extensions: {},
		createdAt: now,
		updatedAt: now
	};
}

/** Defaults match a freshly created SillyTavern entry. */
export function createEmptyLorebookEntry(): LorebookEntry {
	return {
		id: crypto.randomUUID(),
		comment: '',
		key: [],
		keysecondary: [],
		selectiveLogic: 0,
		content: '',
		constant: false,
		disable: false,
		order: 100,
		probability: 100,
		useProbability: true,
		caseSensitive: null,
		matchWholeWords: null,
		rest: {}
	};
}

/** The three behavior groups. Pure derivation over `constant` + `disable`, no extra field. */
export interface PartitionedEntries {
	/** !disable && constant: injected every turn. */
	alwaysActive: LorebookEntry[];
	/** !disable && !constant: fires on keyword match. */
	keyword: LorebookEntry[];
	/** disable: inert, never scanned. */
	disabled: LorebookEntry[];
}

/** What an entry is, in the three words the entry row's own behavior switch uses. */
export type LorebookEntryNature = 'always' | 'keyword' | 'off';

/** The ONE reading of `constant`/`disable` as a nature: the row's switch, the book's
 *  composition line and the list's Show filter must never disagree about what a row is. */
export function natureOf(entry: Pick<LorebookEntry, 'constant' | 'disable'>): LorebookEntryNature {
	return entry.disable ? 'off' : entry.constant ? 'always' : 'keyword';
}

/** Split entries into always-active / keyword / disabled groups, preserving input order.
 *  The same three natures `natureOf` names, bucketed: a partition that read `constant` and
 *  `disable` itself could file a row under a kind the entry row does not show. */
export function partitionEntries(entries: LorebookEntry[]): PartitionedEntries {
	const buckets: Record<LorebookEntryNature, LorebookEntry[]> = {
		always: [],
		keyword: [],
		off: []
	};
	for (const e of entries) buckets[natureOf(e)].push(e);
	return { alwaysActive: buckets.always, keyword: buckets.keyword, disabled: buckets.off };
}

/** Exactly the fields an order reads. Declared this narrowly so the sort answers for a literal
 *  as well as for a stored entry, which is what makes it testable without building one. */
type SortableEntry = Pick<LorebookEntry, 'comment' | 'content' | 'key' | 'keysecondary' | 'order'>;

/** Every key that can wake an entry, which is what "most keys" counts. */
function keyCount(entry: SortableEntry): number {
	return entry.key.length + entry.keysecondary.length;
}

/**
 * Compare two titles at base sensitivity and numerically, so `Scene 2` sorts before `Scene 10`.
 * Untitled entries sink in BOTH directions, as unnamed books do: a blank title is not a "Z"
 * either, and reversing would otherwise open the list on the rows carrying the least to read.
 */
function compareTitles(a: SortableEntry, b: SortableEntry, sign: number): number {
	const at = a.comment.trim();
	const bt = b.comment.trim();
	if (!at || !bt) return !at && !bt ? 0 : at ? -1 : 1;
	return at.localeCompare(bt, undefined, { sensitivity: 'base', numeric: true }) * sign;
}

/**
 * Return a new array of entries in the chosen display order.
 *
 * Every order tie-breaks on `order`, which is the sequence the entries actually reach the
 * prompt in: two rows the chosen order has nothing to separate would otherwise sit in
 * whatever sequence they happen to be stored in, and reshuffle when one of them is edited.
 *
 * Display only. `book.entries` is never reordered by this: the engine returns survivors in
 * `order` sequence and the block is built from that, so sorting the stored array to tidy the
 * list would let a view preference decide what reaches the model first.
 */
export function sortEntries<T extends SortableEntry>(
	entries: T[],
	sort: LorebookEntrySort
): T[] {
	const by = (cmp: (a: T, b: T) => number): T[] =>
		[...entries].sort((a, b) => cmp(a, b) || a.order - b.order);
	switch (sort) {
		case 'order':
			return by((a, b) => a.order - b.order);
		case 'order-desc':
			return by((a, b) => b.order - a.order);
		case 'a-z':
			return by((a, b) => compareTitles(a, b, 1));
		case 'z-a':
			return by((a, b) => compareTitles(a, b, -1));
		case 'longest':
			return by((a, b) => b.content.length - a.content.length);
		case 'shortest':
			return by((a, b) => a.content.length - b.content.length);
		case 'most-keys':
			return by((a, b) => keyCount(b) - keyCount(a));
		case 'fewest-keys':
			return by((a, b) => keyCount(a) - keyCount(b));
	}
}

/** How a list of books orders itself on screen. Display only: no stored order moves. */
export type LorebookSortOrder =
	| 'a-z'
	| 'z-a'
	| 'newest'
	| 'oldest'
	| 'updated'
	| 'most-entries'
	| 'fewest-entries';

/**
 * Return a new array of books in the chosen display order.
 *
 * 'updated' is the order the store already holds (most recently edited first), so it only
 * copies. The name orders put unnamed books last in BOTH directions, because a book with no
 * name is not an "A" and Z → A would otherwise bury it twice.
 *
 * **Every order ends on the same tie-break, `createdAt` newest first, and deliberately NOT on
 * `updatedAt`.** Nothing dedupes names on import, so a card or a folder brought in twice leaves
 * two rows that read identically, often down to the entry count. A last-edited tie-break makes
 * that pair swap places the moment either one is touched, with nothing on screen admitting the
 * swap, so the row you clicked yesterday opens a different book today. `createdAt` never moves
 * after the insert, so the pair's order is fixed for good; newest first because a duplicate
 * name is made BY the re-import, and the fresh copy is the one being hunted for. The counting
 * orders need it most: a shelf where nothing has been written yet is one long tie.
 *
 * Never applied to `lorebookStore.books` itself: link resolution reads that order to decide
 * what reaches the prompt first, and a display preference must not move a prompt.
 */
export function sortLorebooks<
	T extends { name: string; createdAt: number; entries: readonly unknown[] }
>(books: T[], order: LorebookSortOrder): T[] {
	if (order === 'updated') return [...books];
	const byAge = (a: T, b: T) => b.createdAt - a.createdAt;

	if (order === 'a-z' || order === 'z-a') {
		const sign = order === 'a-z' ? 1 : -1;
		return [...books].sort((a, b) => {
			const an = a.name.trim();
			const bn = b.name.trim();
			if (!an || !bn) {
				if (!an && !bn) return byAge(a, b);
				return an ? -1 : 1;
			}
			const cmp = an.localeCompare(bn, undefined, { sensitivity: 'base', numeric: true });
			return cmp !== 0 ? cmp * sign : byAge(a, b);
		});
	}

	const dated = order === 'newest' || order === 'oldest';
	const key = (book: T) => (dated ? book.createdAt : book.entries.length);
	const sign = order === 'newest' || order === 'most-entries' ? -1 : 1;
	return [...books].sort((a, b) => sign * (key(a) - key(b)) || byAge(a, b));
}

/**
 * The one wording of what deleting a book costs, read by both surfaces that offer it: the
 * shelf's row menu and the open book's own actions menu. Two copies would let the menu
 * standing beside the book's own name be the one that forgot to say who carries it, which
 * is the half where the warning matters most.
 *
 * `links` is a count of characters and personas, each counted once, so it says the same
 * number the book page's Bound to row shows. A book switched into every chat says so too,
 * and says it first: nothing links it, so the bound clause alone would report the widest
 * loss on the shelf as a book nobody was using.
 */
export function lorebookDeleteMessage(
	book: Pick<Lorebook, 'name' | 'entries' | 'global'>,
	links: number
): string {
	const n = book.entries.length;
	const held = n > 0 ? ` and its ${n} ${n === 1 ? 'entry' : 'entries'}` : '';
	const everywhere = book.global ? ' It is in every chat.' : '';
	const s = links === 1 ? '' : 's';
	const bound = links > 0 ? ` It is bound to ${links} character${s} or persona${s}.` : '';
	return `Delete "${book.name || 'Untitled lorebook'}"${held}?${everywhere}${bound} This cannot be undone.`;
}

/** Parse a comma-separated keyword string into a trimmed, non-empty list. */
export function parseKeys(input: string): string[] {
	return input
		.split(',')
		.map((k) => k.trim())
		.filter((k) => k.length > 0);
}

/** Join keys back into the comma-separated form the inputs edit. */
export function formatKeys(keys: string[]): string {
	return keys.join(', ');
}
