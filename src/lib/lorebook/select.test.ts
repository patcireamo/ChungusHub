/**
 * Picking a selection of entries (select.ts). Run with `bun test`.
 *
 * Select by answers the way each entry's own row reads: a switch that follows the book answers
 * with the value in force, a list with every member (an imported alias counting as its kind),
 * and a facet every entry answers alike is not offered. A stretch is read in the order the list
 * shows, takes the state the pressed row takes, and falls back to a plain toggle when the row it
 * would stretch from is not on screen.
 */
import { describe, expect, test } from 'bun:test';
import {
	NONE,
	answersOf,
	extendSelection,
	facetsOf,
	isPicking,
	orderSpan,
	pickedEntries,
	type LorebookFacetDefaults
} from './select';
import { createEmptyLorebookEntry, type LorebookEntry } from './types';

function entry(fields: Partial<LorebookEntry> = {}): LorebookEntry {
	return { ...createEmptyLorebookEntry(), ...fields };
}

const book: LorebookFacetDefaults = { caseSensitive: false, matchWholeWords: true, scanDepth: 4 };

describe('answersOf', () => {
	test('a switch that follows the book answers with the value in force', () => {
		expect(answersOf(entry(), 'caseSensitive', book)).toEqual(['off']);
		expect(answersOf(entry({ caseSensitive: true }), 'caseSensitive', book)).toEqual(['on']);
		expect(answersOf(entry(), 'matchWholeWords', book)).toEqual(['on']);
		expect(answersOf(entry(), 'scanDepth', book)).toEqual(['4']);
		expect(answersOf(entry({ scanDepth: 0 }), 'scanDepth', book)).toEqual(['0']);
	});

	test('a chance with the roll off is the 100 the row shows', () => {
		expect(answersOf(entry({ probability: 40, useProbability: false }), 'probability', book)).toEqual([
			'100'
		]);
		expect(answersOf(entry({ probability: 40, useProbability: true }), 'probability', book)).toEqual([
			'40'
		]);
	});

	test('a filter answers only where a keyword entry reads it', () => {
		const filtered = entry({ keysecondary: ['night'], selectiveLogic: 2 });
		expect(answersOf(filtered, 'filter', book)).toEqual(['2']);
		expect(answersOf(entry({ selectiveLogic: 2 }), 'filter', book)).toEqual([NONE]);
		expect(answersOf({ ...filtered, constant: true }, 'filter', book)).toEqual([NONE]);
	});

	test('a list answers with each member, and an empty one with none', () => {
		expect(answersOf(entry({ scanFields: ['scenario', 'steering'] }), 'scanFields', book)).toEqual([
			'scenario',
			'steering'
		]);
		expect(answersOf(entry(), 'scanFields', book)).toEqual([NONE]);
		expect(answersOf(entry({ sticky: 2, delay: 5 }), 'timing', book)).toEqual(['sticky', 'delay']);
		expect(answersOf(entry({ sticky: 0 }), 'timing', book)).toEqual([NONE]);
	});

	test("an imported alias answers as its kind, and a kind this app never generates answers nothing", () => {
		expect(answersOf(entry({ triggers: ['regenerate', 'normal'] }), 'triggers', book)).toEqual([
			'normal',
			'swipe'
		]);
		expect(answersOf(entry(), 'triggers', book)).toEqual([NONE]);
		expect(answersOf(entry({ triggers: ['quiet'] }), 'triggers', book)).toEqual([]);
	});

	test('each group label is an answer of its own, once', () => {
		expect(answersOf(entry({ group: 'weather, mood, weather' }), 'group', book)).toEqual([
			'weather',
			'mood'
		]);
		expect(answersOf(entry({ group: ' ' }), 'group', book)).toEqual([NONE]);
	});

	test('recursion answers through the one reader, legacy spellings included', () => {
		const imported = entry({ rest: { exclude_recursion: true, prevent_recursion: true } });
		expect(answersOf(imported, 'wokenBy', book)).toEqual(['chatOnly']);
		expect(answersOf(imported, 'wakesOthers', book)).toEqual(['off']);
		expect(answersOf(entry({ delayUntilRecursion: 2 }), 'wokenBy', book)).toEqual(['entriesOnly']);
	});

	test('a placement never set is the block, and a foreign one keeps its number', () => {
		expect(answersOf(entry(), 'placement', book)).toEqual(['0']);
		expect(answersOf(entry({ position: 6 }), 'placement', book)).toEqual(['6']);
	});
});

describe('facetsOf', () => {
	test('leaves out a facet every entry answers alike, and counts the rest', () => {
		const entries = [entry({ disable: true }), entry(), entry({ constant: true })];
		const facets = facetsOf(entries, book);
		expect(facets.map((f) => f.facet)).toEqual(['nature']);
		expect([...facets[0].counts]).toEqual([
			['off', 1],
			['keyword', 1],
			['always', 1]
		]);
	});

	test('offers a list where only some entries hold a member, counting each entry once', () => {
		const entries = [entry({ group: 'mood, weather' }), entry({ group: 'mood' })];
		const group = facetsOf(entries, book).find((f) => f.facet === 'group');
		expect(group && [...group.counts]).toEqual([
			['mood', 2],
			['weather', 1]
		]);
	});

	test('a facet reads the book, so entries pinned to its value do not split from those following it', () => {
		expect(facetsOf([entry({ caseSensitive: false }), entry()], book)).toEqual([]);
	});
});

describe('pickedEntries', () => {
	const off = entry({ disable: true, order: 10, group: 'mood' });
	const always = entry({ constant: true, order: 50, group: 'weather' });
	const keyword = entry({ order: 100, group: 'mood' });
	const entries = [off, always, keyword];

	test('answers picked within one facet widen the pick', () => {
		const picks = { answers: { nature: ['off', 'always'] }, order: {} };
		expect(pickedEntries(entries, picks, book)).toEqual([off, always]);
	});

	test('each facet picked from narrows it', () => {
		const picks = { answers: { nature: ['off', 'keyword'], group: ['mood'] }, order: {} };
		expect(pickedEntries(entries, picks, book)).toEqual([off, keyword]);
		const narrower = { answers: { nature: ['keyword'], group: ['mood'] }, order: {} };
		expect(pickedEntries(entries, narrower, book)).toEqual([keyword]);
	});

	test('the order span holds both ends, and either may be left open', () => {
		expect(pickedEntries(entries, { answers: {}, order: { from: 50, to: 100 } }, book)).toEqual([
			always,
			keyword
		]);
		expect(pickedEntries(entries, { answers: {}, order: { to: 50 } }, book)).toEqual([off, always]);
	});

	test('picking nothing is not picking', () => {
		expect(isPicking({ answers: { nature: [] }, order: {} })).toBe(false);
		expect(isPicking({ answers: {}, order: { from: 0 } })).toBe(true);
	});
});

describe('orderSpan', () => {
	test('names the lowest and highest order, and nothing for no entries', () => {
		expect(orderSpan([entry({ order: 30 }), entry({ order: 5 })])).toEqual({ min: 5, max: 30 });
		expect(orderSpan([])).toBe(null);
	});
});

const shown = ['a', 'b', 'c', 'd', 'e'];

describe('extendSelection', () => {
	test('selects every row between the last press and this one, both ends included', () => {
		expect([...extendSelection(shown, new Set(['b']), 'b', 'd')].sort()).toEqual(['b', 'c', 'd']);
	});

	test('stretches upward as readily as down', () => {
		expect([...extendSelection(shown, new Set(), 'e', 'c')].sort()).toEqual(['c', 'd', 'e']);
	});

	test('keeps what was already selected outside the stretch', () => {
		expect([...extendSelection(shown, new Set(['a']), 'c', 'e')].sort()).toEqual([
			'a',
			'c',
			'd',
			'e'
		]);
	});

	test('a press on a selected row clears the stretch, the state that row takes', () => {
		const all = new Set(shown);
		expect([...extendSelection(shown, all, 'a', 'c')].sort()).toEqual(['d', 'e']);
	});

	test('with no row to stretch from, or one no longer shown, it toggles the pressed row alone', () => {
		expect([...extendSelection(shown, new Set(), null, 'c')]).toEqual(['c']);
		expect([...extendSelection(shown, new Set(['c']), 'gone', 'c')]).toEqual([]);
	});

	test('leaves the set it was handed untouched', () => {
		const selected = new Set(['a']);
		extendSelection(shown, selected, 'a', 'c');
		expect([...selected]).toEqual(['a']);
	});
});
