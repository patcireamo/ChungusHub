/**
 * Editing a selection of entries at once: what the selection holds for each setting, and the
 * patch one staged edit writes into every entry of it.
 *
 * **A bulk edit is the entry row's own edit made once per entry**, never a second reading of
 * what a setting means: each staged value is written exactly as the row writes that press, so
 * an entry edited in bulk cannot be told from one edited by hand. That is why three settings
 * are patched per entry rather than stamped: the recursion trio is written together with its
 * legacy spellings cleared, and the two membership lists gain or lose only the members that
 * were staged, keeping everything the reader did not touch.
 *
 * Pure, and tested in bulk.test.ts.
 */
import {
	LOREBOOK_POSITION_AT_DEPTH,
	LOREBOOK_POSITION_BLOCK,
	LOREBOOK_SCAN_FIELDS,
	LOREBOOK_TRIGGERS,
	TRIGGER_ALIASES,
	delayValue,
	lorebookWokenBy,
	resolveEntryRecursion,
	withoutStoredRecursion,
	type LorebookEntry,
	type LorebookEntryNature,
	type LorebookScanField,
	type LorebookTrigger,
	type LorebookWokenBy
} from './types';

type EntryPatch = Partial<Omit<LorebookEntry, 'id'>>;

/** What a selection holds for a setting its entries disagree about. */
export const MIXED = Symbol('mixed');

/** One setting read across a selection: the value every entry holds, or {@link MIXED}. */
export type Shared<T> = T | typeof MIXED;

/** The value every entry holds for one setting. An empty selection holds nothing in common. */
export function sharedValue<T>(
	entries: readonly LorebookEntry[],
	read: (entry: LorebookEntry) => T
): Shared<T> {
	if (entries.length === 0) return MIXED;
	const first = read(entries[0]);
	for (let i = 1; i < entries.length; i++) {
		if (!Object.is(read(entries[i]), first)) return MIXED;
	}
	return first;
}

/** Settings staged for a whole selection. An absent key leaves every entry's own value alone. */
export interface LorebookBulkEdit {
	/** Off keeps each entry's `constant`, as the row's Off does. */
	nature?: LorebookEntryNature;
	selectiveLogic?: number;
	order?: number;
	/** The trigger chance in force. Writing one switches the roll on, as the row does. */
	probability?: number;
	/** `null` follows the book. */
	caseSensitive?: boolean | null;
	matchWholeWords?: boolean | null;
	scanDepth?: number | null;
	/** Per source: true adds it to each entry's list, false takes it out. */
	scanFields?: Partial<Record<LorebookScanField, boolean>>;
	/** `never` is only ever read off an import, so it cannot be staged. */
	wokenBy?: Exclude<LorebookWokenBy, 'never'>;
	/** The level a waiting entry waits for. An entry that does not wait takes nothing from it. */
	delayLevel?: number;
	wakesOthers?: boolean;
	/** Per kind, as `scanFields`. */
	triggers?: Partial<Record<LorebookTrigger, boolean>>;
	/** `null` is off. */
	sticky?: number | null;
	cooldown?: number | null;
	delay?: number | null;
	group?: string;
	groupWeight?: number;
	groupOverride?: boolean;
	useGroupScoring?: boolean;
	position?: number;
	depth?: number;
	role?: number;
}

/** One control of the bulk editor, which may write several settings. */
export type LorebookBulkKnob =
	| 'nature'
	| 'filter'
	| 'order'
	| 'probability'
	| 'caseSensitive'
	| 'matchWholeWords'
	| 'scanDepth'
	| 'scanFields'
	| 'wokenBy'
	| 'wakesOthers'
	| 'triggers'
	| 'timing'
	| 'group'
	| 'placement';

/** What both selection dialogs, Edit… and Select by, call each knob: the entry row's own
 *  names, which the row keeps by hand. */
export const LOREBOOK_KNOB_NAMES: Record<LorebookBulkKnob, string> = {
	nature: 'Behavior',
	filter: 'Filter',
	order: 'Order',
	probability: 'Trigger %',
	caseSensitive: 'Case-sensitive',
	matchWholeWords: 'Whole words',
	scanDepth: 'Scan depth',
	scanFields: 'Also scan',
	wokenBy: 'Woken by',
	wakesOthers: 'Wakes others',
	triggers: 'Fires on',
	timing: 'Timing',
	group: 'Inclusion group',
	placement: 'Placement'
};

/** The knobs in the order Edit… draws them, the row's own order. */
export const LOREBOOK_KNOBS = Object.keys(LOREBOOK_KNOB_NAMES) as LorebookBulkKnob[];

/**
 * The knob each staged setting sits under: what that knob's Leave as is clears and what the
 * count of changes counts once. Exhaustive by type, so a setting added to the edit cannot be
 * staged without a knob to count it and clear it.
 */
const KNOB_OF: Record<keyof LorebookBulkEdit, LorebookBulkKnob> = {
	nature: 'nature',
	selectiveLogic: 'filter',
	order: 'order',
	probability: 'probability',
	caseSensitive: 'caseSensitive',
	matchWholeWords: 'matchWholeWords',
	scanDepth: 'scanDepth',
	scanFields: 'scanFields',
	wokenBy: 'wokenBy',
	delayLevel: 'wokenBy',
	wakesOthers: 'wakesOthers',
	triggers: 'triggers',
	sticky: 'timing',
	cooldown: 'timing',
	delay: 'timing',
	group: 'group',
	groupWeight: 'group',
	groupOverride: 'group',
	useGroupScoring: 'group',
	position: 'placement',
	depth: 'placement',
	role: 'placement'
};

function stagedKeys(edit: LorebookBulkEdit): (keyof LorebookBulkEdit)[] {
	return (Object.keys(edit) as (keyof LorebookBulkEdit)[]).filter((key) => edit[key] !== undefined);
}

/** The knobs an edit changes. */
export function changedKnobs(edit: LorebookBulkEdit): Set<LorebookBulkKnob> {
	return new Set(stagedKeys(edit).map((key) => KNOB_OF[key]));
}

/** The edit with every setting under one knob dropped. */
export function withoutKnob(edit: LorebookBulkEdit, knob: LorebookBulkKnob): LorebookBulkEdit {
	const next = { ...edit };
	for (const key of stagedKeys(edit)) {
		if (KNOB_OF[key] === knob) delete next[key];
	}
	return next;
}

/** What the editor offers for this selection under this edit. */
export interface LorebookBulkOffers {
	/** Filter logic is read only beside secondary keys, and never by an always-active entry,
	 *  which fires without reading its keys at all. */
	filter: boolean;
	/** A level is part of waiting, so writing one to an entry that does not wait would make it
	 *  wait: it is offered only while every entry does. */
	level: boolean;
	/** Weight and the two contest switches decide nothing outside a group. */
	groupRules: boolean;
	/** Depth and role place nothing outside the chat. */
	depthRules: boolean;
	/** Every entry is always active, which is what the Woken by list is worded for. */
	allAlways: boolean;
}

function constantAfter(entry: LorebookEntry, edit: LorebookBulkEdit): boolean {
	if (edit.nature === 'always') return true;
	if (edit.nature === 'keyword') return false;
	return entry.constant;
}

function wokenByAfter(entry: LorebookEntry, edit: LorebookBulkEdit): LorebookWokenBy {
	return edit.wokenBy ?? lorebookWokenBy(resolveEntryRecursion(entry));
}

/**
 * A knob that would mean nothing for every entry is not offered, and neither is one that would
 * change what another entry does. Read against the edit, since a staged group or placement is
 * what decides whether the rules under it mean anything.
 */
export function bulkOffers(
	entries: readonly LorebookEntry[],
	edit: LorebookBulkEdit
): LorebookBulkOffers {
	const any = entries.length > 0;
	return {
		filter: entries.some((e) => !constantAfter(e, edit) && e.keysecondary.length > 0),
		level: any && entries.every((e) => wokenByAfter(e, edit) === 'entriesOnly'),
		groupRules: entries.some((e) => (edit.group ?? e.group ?? '').trim() !== ''),
		depthRules: entries.some(
			(e) => (edit.position ?? e.position ?? LOREBOOK_POSITION_BLOCK) === LOREBOOK_POSITION_AT_DEPTH
		),
		allAlways: any && entries.every((e) => constantAfter(e, edit))
	};
}

/**
 * The edit as it will be written. A staged setting whose knob is no longer offered is dropped,
 * since a change nothing on screen shows must not land.
 */
export function offeredEdit(
	entries: readonly LorebookEntry[],
	edit: LorebookBulkEdit
): LorebookBulkEdit {
	const offers = bulkOffers(entries, edit);
	const out = { ...edit };
	if (!offers.filter) delete out.selectiveLogic;
	if (!offers.level) delete out.delayLevel;
	if (!offers.groupRules) {
		delete out.groupWeight;
		delete out.groupOverride;
		delete out.useGroupScoring;
	}
	if (!offers.depthRules) {
		delete out.depth;
		delete out.role;
	}
	return out;
}

/** The settings an entry stores exactly as they were staged. */
const STORED_AS_STAGED = [
	'selectiveLogic',
	'order',
	'caseSensitive',
	'matchWholeWords',
	'scanDepth',
	'sticky',
	'cooldown',
	'delay',
	'group',
	'groupWeight',
	'groupOverride',
	'useGroupScoring',
	'position',
	'depth',
	'role'
] as const satisfies readonly (keyof LorebookBulkEdit & keyof LorebookEntry)[];

function withSources(
	current: readonly LorebookScanField[],
	staged: Partial<Record<LorebookScanField, boolean>>
): LorebookScanField[] {
	const next = current.filter((field) => staged[field] !== false);
	for (const { id } of LOREBOOK_SCAN_FIELDS) {
		if (staged[id] && !next.includes(id)) next.push(id);
	}
	return next;
}

/** An imported alias counts as its kind (SillyTavern's `regenerate` is our Regenerate), and a
 *  token for a kind this app never generates is kept, since nothing here can speak for it. */
function withKinds(
	current: readonly string[],
	staged: Partial<Record<LorebookTrigger, boolean>>
): string[] {
	let next = [...current];
	for (const { id } of LOREBOOK_TRIGGERS) {
		const aliases = TRIGGER_ALIASES[id];
		if (staged[id] === true && !next.some((t) => aliases.includes(t))) next.push(id);
		else if (staged[id] === false) next = next.filter((t) => !aliases.includes(t));
	}
	return next;
}

/** The row's `setRecursion`: all three flags from the resolved values, legacy spellings cleared. */
function recursionPatch(entry: LorebookEntry, edit: LorebookBulkEdit): EntryPatch | null {
	const current = resolveEntryRecursion(entry);
	const next = { ...current };
	if (edit.wokenBy !== undefined) {
		next.excludeRecursion = edit.wokenBy === 'chatOnly';
		next.delayLevel =
			edit.wokenBy === 'entriesOnly' ? Math.max(1, edit.delayLevel ?? current.delayLevel) : 0;
	} else if (edit.delayLevel !== undefined && current.delayLevel > 0) {
		next.delayLevel = Math.max(1, edit.delayLevel);
	}
	if (edit.wakesOthers !== undefined) next.preventRecursion = !edit.wakesOthers;
	const touched =
		edit.wokenBy !== undefined ||
		edit.wakesOthers !== undefined ||
		next.delayLevel !== current.delayLevel;
	if (!touched) return null;
	return {
		excludeRecursion: next.excludeRecursion,
		preventRecursion: next.preventRecursion,
		delayUntilRecursion: delayValue(next.delayLevel),
		rest: withoutStoredRecursion(entry.rest)
	};
}

/**
 * The patch one entry takes from a bulk edit: exactly what its own row writes for the same
 * presses. Every array and object in it is new, so no two entries end up sharing one.
 */
export function bulkEntryPatch(entry: LorebookEntry, edit: LorebookBulkEdit): EntryPatch {
	const patch: EntryPatch = {};
	if (edit.nature === 'off') patch.disable = true;
	else if (edit.nature) Object.assign(patch, { disable: false, constant: edit.nature === 'always' });
	if (edit.probability !== undefined) {
		Object.assign(patch, { probability: edit.probability, useProbability: true });
	}
	for (const key of STORED_AS_STAGED) {
		if (edit[key] !== undefined) Object.assign(patch, { [key]: edit[key] });
	}
	if (edit.scanFields) patch.scanFields = withSources(entry.scanFields ?? [], edit.scanFields);
	if (edit.triggers) patch.triggers = withKinds(entry.triggers ?? [], edit.triggers);
	const recursion = recursionPatch(entry, edit);
	if (recursion) Object.assign(patch, recursion);
	return patch;
}
