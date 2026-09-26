/**
 * Picking a selection of entries: by the answers they give the settings Edit… sets (Select
 * by), and by stretching one press across the rows between it and the one pressed before it.
 *
 * **Select by reads what each entry's own row shows**, never how it is stored: a switch that
 * follows the book answers with the value in force, the way the row draws it, so a pick can
 * never split entries by a difference the list does not show.
 *
 * Pure, and tested in select.test.ts.
 */
import { LOREBOOK_KNOBS, type LorebookBulkKnob } from './bulk';
import {
	LOREBOOK_POSITION_BLOCK,
	LOREBOOK_SCAN_FIELDS,
	LOREBOOK_TIMED_FIELDS,
	LOREBOOK_TRIGGERS,
	TRIGGER_ALIASES,
	lorebookGroupsOf,
	lorebookWokenBy,
	natureOf,
	resolveEntryRecursion,
	type LorebookEntry
} from './types';

/**
 * A knob read as the answers entries give it. Every knob but Order, which is picked as a span
 * instead: a book can hold as many orders as it holds entries.
 */
export type LorebookFacet = Exclude<LorebookBulkKnob, 'order'>;

/** In the bulk editor's own order, so Select by and Edit… read down one list. */
export const LOREBOOK_FACETS = LOREBOOK_KNOBS.filter(
	(knob): knob is LorebookFacet => knob !== 'order'
);

/** What a switch that follows the book reads as: the book's resolved defaults. */
export interface LorebookFacetDefaults {
	caseSensitive: boolean;
	matchWholeWords: boolean;
	scanDepth: number;
}

/** The answer of an entry that sets none of a facet: no filter, the chat alone, every kind,
 *  no timing, no group. */
export const NONE = '';

function onOff(value: boolean): string {
	return value ? 'on' : 'off';
}

function listed(members: string[]): string[] {
	return members.length > 0 ? members : [NONE];
}

/**
 * The answers one entry gives a facet: one for a setting, one per member for a list, one per
 * label for a group. A list naming only kinds this app never generates answers nothing, since
 * no pill here stands for what it holds.
 */
export function answersOf(
	entry: LorebookEntry,
	facet: LorebookFacet,
	defaults: LorebookFacetDefaults
): string[] {
	switch (facet) {
		case 'nature':
			return [natureOf(entry)];
		case 'filter':
			// Read only beside secondary keys, and never by an entry that is always in.
			return [!entry.constant && entry.keysecondary.length > 0 ? String(entry.selectiveLogic) : NONE];
		case 'probability':
			return [String(entry.useProbability ? entry.probability : 100)];
		case 'caseSensitive':
			return [onOff(entry.caseSensitive ?? defaults.caseSensitive)];
		case 'matchWholeWords':
			return [onOff(entry.matchWholeWords ?? defaults.matchWholeWords)];
		case 'scanDepth':
			return [String(entry.scanDepth ?? defaults.scanDepth)];
		case 'scanFields':
			return listed(
				LOREBOOK_SCAN_FIELDS.filter((f) => entry.scanFields?.includes(f.id)).map((f) => f.id)
			);
		case 'wokenBy':
			return [lorebookWokenBy(resolveEntryRecursion(entry))];
		case 'wakesOthers':
			return [onOff(!resolveEntryRecursion(entry).preventRecursion)];
		case 'triggers': {
			const tokens = entry.triggers ?? [];
			if (tokens.length === 0) return [NONE];
			return LOREBOOK_TRIGGERS.filter((t) => TRIGGER_ALIASES[t.id].some((a) => tokens.includes(a))).map(
				(t) => t.id
			);
		}
		case 'timing':
			return listed(LOREBOOK_TIMED_FIELDS.filter((t) => entry[t.field]).map((t) => t.field));
		case 'group':
			return listed([...new Set(lorebookGroupsOf(entry))]);
		case 'placement':
			return [String(entry.position ?? LOREBOOK_POSITION_BLOCK)];
	}
}

/** One facet's answers across a set of entries, each with how many of them give it. */
export interface LorebookFacetCounts {
	facet: LorebookFacet;
	counts: Map<string, number>;
}

/**
 * Every facet that can tell the entries apart, with how many give each answer. One that every
 * entry answers alike picks all of them or none, which is All's job, so it is left out.
 */
export function facetsOf(
	entries: readonly LorebookEntry[],
	defaults: LorebookFacetDefaults
): LorebookFacetCounts[] {
	const out: LorebookFacetCounts[] = [];
	for (const facet of LOREBOOK_FACETS) {
		const counts = new Map<string, number>();
		for (const entry of entries) {
			for (const answer of answersOf(entry, facet, defaults)) {
				counts.set(answer, (counts.get(answer) ?? 0) + 1);
			}
		}
		if ([...counts.values()].some((n) => n < entries.length)) out.push({ facet, counts });
	}
	return out;
}

/** The lowest and highest order a set of entries holds, or null for no entries. */
export function orderSpan(entries: readonly LorebookEntry[]): { min: number; max: number } | null {
	if (entries.length === 0) return null;
	const orders = entries.map((e) => e.order);
	return { min: Math.min(...orders), max: Math.max(...orders) };
}

/** What Select by has picked: per facet the answers any one of which an entry must give, and
 *  a span of orders with either end left open. */
export interface LorebookPicks {
	answers: Partial<Record<LorebookFacet, readonly string[]>>;
	order: { from?: number; to?: number };
}

/** Whether anything is picked at all, since picking nothing narrows nothing. */
export function isPicking(picks: LorebookPicks): boolean {
	return (
		Object.values(picks.answers).some((answers) => (answers?.length ?? 0) > 0) ||
		picks.order.from !== undefined ||
		picks.order.to !== undefined
	);
}

/**
 * The entries giving a picked answer for every facet picked from, with an order inside the
 * span: answers picked within one facet widen the pick, and each facet picked from narrows it.
 */
export function pickedEntries(
	entries: readonly LorebookEntry[],
	picks: LorebookPicks,
	defaults: LorebookFacetDefaults
): LorebookEntry[] {
	const { from, to } = picks.order;
	return entries.filter((entry) => {
		if ((from !== undefined && entry.order < from) || (to !== undefined && entry.order > to)) {
			return false;
		}
		return LOREBOOK_FACETS.every((facet) => {
			const wanted = picks.answers[facet];
			if (!wanted?.length) return true;
			return answersOf(entry, facet, defaults).some((answer) => wanted.includes(answer));
		});
	});
}

/**
 * The selection after a press that stretches from the last row pressed: every row between the
 * two, both ends included, takes the state the pressed row takes, the way a checklist's
 * Shift-click works. Read in the order the list shows its rows, since that is the stretch the
 * reader sees, and a last row no longer on screen leaves the press an ordinary toggle.
 */
export function extendSelection(
	shown: readonly string[],
	selected: ReadonlySet<string>,
	anchor: string | null,
	target: string
): Set<string> {
	const on = !selected.has(target);
	const from = anchor === null ? -1 : shown.indexOf(anchor);
	const to = shown.indexOf(target);
	const stretch =
		from < 0 || to < 0 ? [target] : shown.slice(Math.min(from, to), Math.max(from, to) + 1);
	const next = new Set(selected);
	for (const id of stretch) {
		if (on) next.add(id);
		else next.delete(id);
	}
	return next;
}
