/**
 * SillyTavern lorebook interchange.
 *
 * SillyTavern has two on-disk shapes for the same data:
 *   - Native "World Info" export: `{ entries: { "0": {...}, "1": {...} } }`. Entries is an
 *     OBJECT keyed by stringified uid; fields are flat (key, keysecondary, selectiveLogic, …).
 *   - `character_book` (Character Card V2/V3): `{ name, entries: [ {...} ] }`. Entries is an
 *     ARRAY with spec names (keys, secondary_keys, insertion_order, enabled, …); the
 *     SillyTavern-specific fields live inside each entry's `extensions` object.
 *
 * Our model uses the native field names verbatim, so the native path is a passthrough: the
 * handful of modelled fields are typed, and everything else rides in `rest` untouched. Only
 * character_book needs real mapping (its spec renames fields). Export is native World Info
 * (what SillyTavern's "Import World Info" reads), reconstructed as: SillyTavern defaults ←
 * preserved originals ← modelled fields.
 *
 * The recursion flags are the one group carried under two spellings at once, so they are read
 * under both names in both shapes and written under the name the target shape reads
 * ({@link asRecursionFlags}, {@link recursionFlags}). A flag written under the other side's
 * spelling is a setting that silently stops applying.
 */

import type {
	Lorebook,
	LorebookEntry,
	LorebookKeyRules,
	LorebookRecursionField,
	LorebookScanField
} from './types';
import {
	createEmptyLorebook,
	DEFAULT_GROUP_WEIGHT,
	DEFAULT_LOREBOOK_DEPTH,
	delayValue,
	LOREBOOK_POSITION_BLOCK,
	LOREBOOK_SCAN_FIELDS,
	RECURSION_FIELDS,
	resolveEntryRecursion,
	withoutStoredRecursion
} from './types';

// ===== coercion helpers =====

function asString(v: unknown, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
	return typeof v === 'boolean' ? v : fallback;
}

function asTriState(v: unknown): boolean | null {
	return typeof v === 'boolean' ? v : null;
}

/** Book-level numbers are null = "inherit the global setting" when absent or malformed. */
function asNumberOrNull(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Book-level activation overrides ChungusHub adds beyond SillyTavern's book fields. They ride
 * in the exported book's `extensions` (harmless metadata to SillyTavern) so our own re-import
 * recovers them; import lifts them out so they can't drift from the modelled values.
 */
function liftBookOverrides(book: Lorebook, ext: Record<string, unknown>): void {
	book.maxRecursionSteps = asNumberOrNull(ext.max_recursion_steps);
	book.caseSensitive = asTriState(ext.case_sensitive);
	book.matchWholeWords = asTriState(ext.match_whole_words);
	delete ext.max_recursion_steps;
	delete ext.case_sensitive;
	delete ext.match_whole_words;
}

/** The non-null overrides, as the extension keys {@link liftBookOverrides} reads back. */
function bookOverrideExtensions(book: Lorebook): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (book.maxRecursionSteps !== null) out.max_recursion_steps = book.maxRecursionSteps;
	if (book.caseSensitive !== null) out.case_sensitive = book.caseSensitive;
	if (book.matchWholeWords !== null) out.match_whole_words = book.matchWholeWords;
	return out;
}

/** SillyTavern keys can be a comma-joined string or an array; normalise to a trimmed list. */
function asKeyList(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((k) => String(k).trim()).filter((k) => k.length > 0);
	if (typeof v === 'string') return v.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
	return [];
}

/** Trigger tokens ride as written; ours are SillyTavern's own, and its extras are kept. */
function asStringList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * Per-key match rules, a ChungusHub-only field. SillyTavern has no per-key anything, so it
 * rides under a name that is obviously not its own and comes back on our own re-import; there
 * the keys degrade to the entry's own case-sensitivity and whole-word flags, which is the
 * closest thing that side has.
 */
const KEY_RULES_FIELD = 'chungus_key_rules';

function asKeyRules(v: unknown): LorebookKeyRules | undefined {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
	const out: LorebookKeyRules = {};
	for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
		if (!raw || typeof raw !== 'object') continue;
		const rule = raw as Record<string, unknown>;
		const mode = rule.mode;
		const caseSensitive = rule.caseSensitive;
		const kept: LorebookKeyRules[string] = {};
		if (mode === 'substring' || mode === 'word' || mode === 'start') kept.mode = mode;
		if (typeof caseSensitive === 'boolean') kept.caseSensitive = caseSensitive;
		if (Object.keys(kept).length > 0) out[key] = kept;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The card fields an entry opted to scan, read from whichever spelling the file uses: flat
 * `matchScenario` in native World Info, `match_scenario` inside a card entry's extensions.
 * Both names come off the one {@link LOREBOOK_SCAN_FIELDS} table.
 */
function asScanFields(raw: Record<string, unknown>, shape: 'native' | 'card'): LorebookScanField[] {
	const out: LorebookScanField[] = [];
	for (const field of LOREBOOK_SCAN_FIELDS) {
		if (raw[shape === 'native' ? field.native : field.card] === true) out.push(field.id);
	}
	return out;
}

/**
 * The recursion flags off whichever spelling the file uses: native World Info writes them flat
 * and camelCase, a card's `character_book` writes them snake_case inside the entry's extensions.
 * Both names are read from both shapes, so a book that has been through either export comes back
 * with its settings intact. A flag the file never named stays absent rather than becoming a
 * decision the author did not make.
 */
function asRecursionFlags(raw: Record<string, unknown>): Partial<LorebookEntry> {
	const read = (field: LorebookRecursionField) => raw[field] ?? raw[RECURSION_FIELDS[field]];
	const delay = read('delayUntilRecursion');
	const flags: Partial<LorebookEntry> = {};
	if (typeof read('excludeRecursion') === 'boolean') flags.excludeRecursion = read('excludeRecursion') as boolean;
	if (typeof read('preventRecursion') === 'boolean') flags.preventRecursion = read('preventRecursion') as boolean;
	if (typeof delay === 'boolean' || (typeof delay === 'number' && Number.isFinite(delay))) {
		flags.delayUntilRecursion = delay as boolean | number;
	}
	return flags;
}

/** The three flags on the way out, under the spelling the target shape reads. */
function recursionFlags(entry: LorebookEntry, shape: 'native' | 'card'): Record<string, unknown> {
	const recursion = resolveEntryRecursion(entry);
	const name = (field: LorebookRecursionField) => (shape === 'native' ? field : RECURSION_FIELDS[field]);
	return {
		[name('excludeRecursion')]: recursion.excludeRecursion,
		[name('preventRecursion')]: recursion.preventRecursion,
		[name('delayUntilRecursion')]: delayValue(recursion.delayLevel)
	};
}

/** The same flags on the way out; always written, so a cleared one reads as cleared there. */
function scanFieldFlags(entry: LorebookEntry, shape: 'native' | 'card'): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const field of LOREBOOK_SCAN_FIELDS) {
		out[shape === 'native' ? field.native : field.card] = !!entry.scanFields?.includes(field.id);
	}
	return out;
}

// ===== import =====

/**
 * Fields we model as typed entry fields. `uid` and `selective` are positional/derived and
 * regenerated on export, so they don't ride in `rest` either.
 */
const MODELLED_KEYS = new Set([
	'uid', 'selective',
	'key', 'keysecondary', 'selectiveLogic', 'comment', 'content', 'constant', 'disable',
	'order', 'probability', 'useProbability', 'caseSensitive', 'matchWholeWords',
	'scanDepth', 'triggers', KEY_RULES_FIELD,
	'sticky', 'cooldown', 'delay',
	'group', 'groupOverride', 'groupWeight', 'useGroupScoring',
	'position', 'depth', 'role',
	// Both spellings, so a file written under either one leaves no stale copy behind in `rest`.
	...Object.keys(RECURSION_FIELDS), ...Object.values(RECURSION_FIELDS),
	...LOREBOOK_SCAN_FIELDS.map((f) => f.native)
]);

/** Native World Info entry → our model. Everything unmapped is preserved verbatim in `rest`. */
function fromNativeEntry(raw: Record<string, unknown>): LorebookEntry {
	const rest: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (!MODELLED_KEYS.has(k)) rest[k] = v;
	}
	return {
		id: crypto.randomUUID(),
		comment: asString(raw.comment),
		key: asKeyList(raw.key),
		keysecondary: asKeyList(raw.keysecondary),
		selectiveLogic: asNumber(raw.selectiveLogic, 0),
		content: asString(raw.content),
		constant: asBool(raw.constant, false),
		disable: asBool(raw.disable, false),
		order: asNumber(raw.order, 100),
		probability: asNumber(raw.probability, 100),
		useProbability: asBool(raw.useProbability, true),
		caseSensitive: asTriState(raw.caseSensitive),
		matchWholeWords: asTriState(raw.matchWholeWords),
		keyRules: asKeyRules(raw[KEY_RULES_FIELD]),
		scanDepth: asNumberOrNull(raw.scanDepth),
		scanFields: asScanFields(raw, 'native'),
		triggers: asStringList(raw.triggers),
		sticky: asNumberOrNull(raw.sticky),
		cooldown: asNumberOrNull(raw.cooldown),
		delay: asNumberOrNull(raw.delay),
		group: asString(raw.group),
		groupOverride: asBool(raw.groupOverride, false),
		groupWeight: asNumber(raw.groupWeight, DEFAULT_GROUP_WEIGHT),
		useGroupScoring: asTriState(raw.useGroupScoring),
		position: asNumber(raw.position, LOREBOOK_POSITION_BLOCK),
		depth: asNumber(raw.depth, DEFAULT_LOREBOOK_DEPTH),
		role: asNumberOrNull(raw.role),
		...asRecursionFlags(raw),
		rest
	};
}

/** character_book entry → our model. The spec's renamed fields map onto the native names. */
function fromCharacterBookEntry(raw: Record<string, unknown>): LorebookEntry {
	const ext: Record<string, unknown> =
		raw.extensions && typeof raw.extensions === 'object' ? { ...(raw.extensions as Record<string, unknown>) } : {};
	// These live in extensions in the card spec but are modelled fields for us. Lift them
	// out so they can't drift from the modelled values on re-export.
	const selectiveLogic = asNumber(ext.selectiveLogic, 0);
	const matchWholeWords = asTriState(ext.match_whole_words);
	const probability = asNumber(ext.probability, 100);
	const useProbability = asBool(ext.useProbability, true);
	const scanDepth = asNumberOrNull(ext.scan_depth);
	const scanFields = asScanFields(ext, 'card');
	const triggers = asStringList(ext.triggers);
	const keyRules = asKeyRules(ext[KEY_RULES_FIELD]);
	const recursion = asRecursionFlags(ext);
	const timing = {
		sticky: asNumberOrNull(ext.sticky),
		cooldown: asNumberOrNull(ext.cooldown),
		delay: asNumberOrNull(ext.delay),
		group: asString(ext.group),
		groupOverride: asBool(ext.group_override, false),
		groupWeight: asNumber(ext.group_weight, DEFAULT_GROUP_WEIGHT),
		useGroupScoring: asTriState(ext.use_group_scoring),
		// The card spec's own top-level `position` is a two-value string; the real enum rides in
		// extensions, which is the one that decides where an entry lands.
		position: asNumber(ext.position, LOREBOOK_POSITION_BLOCK),
		depth: asNumber(ext.depth, DEFAULT_LOREBOOK_DEPTH),
		role: asNumberOrNull(ext.role)
	};
	delete ext.selectiveLogic;
	delete ext.match_whole_words;
	delete ext.probability;
	delete ext.useProbability;
	delete ext.scan_depth;
	delete ext.triggers;
	delete ext[KEY_RULES_FIELD];
	delete ext.sticky;
	delete ext.cooldown;
	delete ext.delay;
	delete ext.group;
	delete ext.group_override;
	delete ext.group_weight;
	delete ext.use_group_scoring;
	delete ext.position;
	delete ext.depth;
	delete ext.role;
	for (const field of Object.keys(RECURSION_FIELDS) as LorebookRecursionField[]) {
		delete ext[field];
		delete ext[RECURSION_FIELDS[field]];
	}
	for (const field of LOREBOOK_SCAN_FIELDS) delete ext[field.card];
	return {
		id: crypto.randomUUID(),
		comment: asString(raw.comment) || asString(raw.name),
		key: asKeyList(raw.keys),
		keysecondary: asKeyList(raw.secondary_keys),
		selectiveLogic,
		content: asString(raw.content),
		constant: asBool(raw.constant, false),
		disable: raw.enabled === undefined ? false : !asBool(raw.enabled, true),
		order: asNumber(raw.insertion_order, 100),
		probability,
		useProbability,
		caseSensitive: asTriState(raw.case_sensitive),
		matchWholeWords,
		keyRules,
		scanDepth,
		scanFields,
		triggers,
		...timing,
		...recursion,
		rest: ext
	};
}

/** A character_book object (the value of `character_book` / `data.character_book`) → Lorebook. */
export function lorebookFromCharacterBook(cb: Record<string, unknown>, fallbackName: string): Lorebook {
	const book = createEmptyLorebook(asString(cb.name) || fallbackName);
	// Absent = inherit our global setting, the same "use the app default" the card meant.
	book.scanDepth = asNumberOrNull(cb.scan_depth);
	book.recursiveScanning = asTriState(cb.recursive_scanning);
	const bookExt: Record<string, unknown> =
		cb.extensions && typeof cb.extensions === 'object' ? { ...(cb.extensions as Record<string, unknown>) } : {};
	if (cb.token_budget !== undefined) bookExt.token_budget = cb.token_budget;
	if (cb.description !== undefined) bookExt.description = cb.description;
	liftBookOverrides(book, bookExt);
	book.extensions = bookExt;
	const entries = Array.isArray(cb.entries) ? (cb.entries as Record<string, unknown>[]) : [];
	book.entries = entries.map(fromCharacterBookEntry);
	return book;
}

/**
 * Parse any supported lorebook JSON shape into a Lorebook. Detects native World Info, a bare
 * `character_book`, or a full character card carrying one. Throws (fail loud) on unrecognised
 * input rather than producing an empty book.
 */
export function parseLorebook(raw: unknown, fallbackName: string): Lorebook {
	if (!raw || typeof raw !== 'object') throw new Error('Not a lorebook: expected a JSON object.');
	const obj = raw as Record<string, unknown>;

	// A full character card with an embedded book.
	const embedded =
		(obj.character_book as Record<string, unknown> | undefined) ??
		((obj.data as Record<string, unknown> | undefined)?.character_book as Record<string, unknown> | undefined);
	if (embedded && typeof embedded === 'object') {
		return lorebookFromCharacterBook(embedded, fallbackName);
	}

	const entries = obj.entries;

	// character_book shape: entries is an array.
	if (Array.isArray(entries)) {
		return lorebookFromCharacterBook(obj, fallbackName);
	}

	// Native World Info shape: entries is an object keyed by stringified uid.
	if (entries && typeof entries === 'object') {
		const book = createEmptyLorebook(asString(obj.name) || fallbackName);
		// Absent = inherit our global setting (native World Info has no book-level scan depth).
		book.scanDepth = asNumberOrNull(obj.scan_depth);
		const ext: Record<string, unknown> =
			obj.extensions && typeof obj.extensions === 'object' ? { ...(obj.extensions as Record<string, unknown>) } : {};
		if (obj.description !== undefined) ext.description = obj.description;
		// Recursive scan is a modelled field for us; lift it out of extensions (where an older
		// import may have parked it) so the two can't drift, then honour a top-level flag too.
		// Native World Info has no such key, so absent → null = inherit the global setting.
		book.recursiveScanning = asTriState(obj.recursive_scanning) ?? asTriState(ext.recursive_scanning);
		delete ext.recursive_scanning;
		liftBookOverrides(book, ext);
		book.extensions = ext;
		const list = Object.values(entries as Record<string, Record<string, unknown>>);
		book.entries = list.map(fromNativeEntry);
		return book;
	}

	throw new Error('Unrecognized lorebook format: no `entries` array or object found.');
}

// ===== export =====

/**
 * SillyTavern's own defaults for the fields we don't model. Emitted only when the entry has
 * no preserved value (i.e. it was authored here, not imported), so an imported entry's
 * originals always win, and a Chungus-authored entry still exports as a complete,
 * ST-idiomatic record.
 */
const ST_ENTRY_DEFAULTS: Record<string, unknown> = {
	addMemo: true,
	vectorized: false,
	automationId: ''
};

/** Build a native World Info entry: ST defaults ← preserved originals ← modelled fields. */
function toNativeEntry(entry: LorebookEntry, uid: number): Record<string, unknown> {
	return {
		...ST_ENTRY_DEFAULTS,
		// The recursion flags are written below from the resolved value, so any copy an older
		// import left behind is dropped rather than shipped beside a value that contradicts it.
		...withoutStoredRecursion(entry.rest),
		uid,
		key: [...entry.key],
		keysecondary: [...entry.keysecondary],
		selective: entry.keysecondary.length > 0,
		selectiveLogic: entry.selectiveLogic,
		comment: entry.comment,
		content: entry.content,
		constant: entry.constant,
		disable: entry.disable,
		order: entry.order,
		probability: entry.probability,
		useProbability: entry.useProbability,
		caseSensitive: entry.caseSensitive,
		matchWholeWords: entry.matchWholeWords,
		scanDepth: entry.scanDepth ?? null,
		triggers: [...(entry.triggers ?? [])],
		sticky: entry.sticky ?? null,
		cooldown: entry.cooldown ?? null,
		delay: entry.delay ?? null,
		group: entry.group ?? '',
		groupOverride: entry.groupOverride ?? false,
		groupWeight: entry.groupWeight ?? DEFAULT_GROUP_WEIGHT,
		useGroupScoring: entry.useGroupScoring ?? null,
		position: entry.position ?? LOREBOOK_POSITION_BLOCK,
		depth: entry.depth ?? DEFAULT_LOREBOOK_DEPTH,
		role: entry.role ?? null,
		...recursionFlags(entry, 'native'),
		...scanFieldFlags(entry, 'native'),
		// Ours alone: emitted only when a key actually overrides something, so an untouched
		// entry exports as a plain SillyTavern record.
		...(entry.keyRules && Object.keys(entry.keyRules).length > 0
			? { [KEY_RULES_FIELD]: entry.keyRules }
			: {}),
		displayIndex: asNumber(entry.rest.displayIndex, uid)
	};
}

/** Export a Lorebook as SillyTavern native World Info JSON (what its "Import World Info" reads). */
export function toNativeWorldInfo(book: Lorebook): Record<string, unknown> {
	const entries: Record<string, unknown> = {};
	book.entries.forEach((entry, i) => {
		entries[String(i)] = toNativeEntry(entry, i);
	});
	// The book-level fields are harmless extra metadata to SillyTavern (it names books by
	// filename and ignores unknown top-level keys) but let our own re-import recover the
	// whole book (title, scan depth, preserved extensions), not just entries.
	const out: Record<string, unknown> = { name: book.name, entries };
	// Only explicit overrides are emitted, so an inheriting book (null) re-imports as inheriting.
	if (book.scanDepth !== null) out.scan_depth = book.scanDepth;
	if (book.recursiveScanning !== null) out.recursive_scanning = book.recursiveScanning;
	const ext = { ...(book.extensions ?? {}), ...bookOverrideExtensions(book) };
	if (Object.keys(ext).length > 0) out.extensions = ext;
	return out;
}

/** Build a character_book entry (Character Card V2) from our model. */
function toCharacterBookEntry(entry: LorebookEntry, i: number): Record<string, unknown> {
	const position = entry.position ?? LOREBOOK_POSITION_BLOCK;
	return {
		id: i,
		keys: [...entry.key],
		secondary_keys: [...entry.keysecondary],
		comment: entry.comment,
		content: entry.content,
		constant: entry.constant,
		selective: entry.keysecondary.length > 0,
		insertion_order: entry.order,
		enabled: !entry.disable,
		position: position === 1 ? 'after_char' : 'before_char',
		case_sensitive: entry.caseSensitive,
		extensions: {
			...withoutStoredRecursion(entry.rest),
			position,
			selectiveLogic: entry.selectiveLogic,
			match_whole_words: entry.matchWholeWords,
			probability: entry.probability,
			useProbability: entry.useProbability,
			scan_depth: entry.scanDepth ?? null,
			triggers: [...(entry.triggers ?? [])],
			sticky: entry.sticky ?? null,
			cooldown: entry.cooldown ?? null,
			delay: entry.delay ?? null,
			group: entry.group ?? '',
			group_override: entry.groupOverride ?? false,
			group_weight: entry.groupWeight ?? DEFAULT_GROUP_WEIGHT,
			use_group_scoring: entry.useGroupScoring ?? null,
			depth: entry.depth ?? DEFAULT_LOREBOOK_DEPTH,
			role: entry.role ?? null,
			...recursionFlags(entry, 'card'),
			...scanFieldFlags(entry, 'card'),
			...(entry.keyRules && Object.keys(entry.keyRules).length > 0
				? { [KEY_RULES_FIELD]: entry.keyRules }
				: {})
		}
	};
}

/** Export a Lorebook as a character_book object for embedding in a Character Card V2/V3. */
export function toCharacterBook(book: Lorebook): Record<string, unknown> {
	const ext = book.extensions ?? {};
	return {
		name: book.name,
		// Only emit an explicit positive scan depth. 0 = "whole chat" and null = "inherit".
		// SillyTavern has no equivalent for either, so both export as absent (ST's global).
		scan_depth: book.scanDepth != null && book.scanDepth > 0 ? book.scanDepth : undefined,
		description: ext.description,
		token_budget: ext.token_budget,
		recursive_scanning: book.recursiveScanning ?? undefined,
		extensions: bookOverrideExtensions(book),
		entries: book.entries.map(toCharacterBookEntry)
	};
}
