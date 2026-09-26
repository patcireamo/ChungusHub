/**
 * The assistant's reading of lorebook settings. Every case holds the assistant's words to the
 * editor's own semantics: a row names what the entry row would mark, a census counts what Select
 * by would offer, and a write patches what the bulk editor would patch.
 */
import { describe, test, expect } from 'bun:test';
import {
	CENSUS_ANSWERS,
	entryCensus,
	entryRow,
	entrySettings,
	lorebookRevisionView,
	lorebookTextView,
	parseLorebookDefaults,
	parseWhere,
	planEntrySettings,
	selectEntries,
	type EntrySelector
} from './lorebook-core';
import { createEmptyLorebook, createEmptyLorebookEntry, DEFAULT_LOREBOOK_GLOBAL_SETTINGS, type LorebookEntry } from '../../src/lib/lorebook/types';

function entry(overrides: Partial<LorebookEntry> = {}): LorebookEntry {
	return { ...createEmptyLorebookEntry(), comment: 'Entry', key: ['dragon'], content: 'A dragon sleeps.', ...overrides };
}

const BOOK_DEFAULTS = { caseSensitive: false, matchWholeWords: true, scanDepth: 25 };
const estimate = (text: string) => text.length;

function where(raw: Record<string, unknown>): EntrySelector['where'] {
	const parsed = parseWhere(raw);
	if ('problems' in parsed) throw new Error(parsed.problems.join(' '));
	return parsed;
}

describe('entrySettings', () => {
	test('a fresh entry sets nothing', () => {
		expect(entrySettings(entry())).toEqual({});
	});

	test('names every setting an entry departs on, in the tools\' words', () => {
		const sets = entrySettings(
			entry({
				keysecondary: ['cave'],
				selectiveLogic: 3,
				probability: 30,
				caseSensitive: true,
				scanDepth: 0,
				scanFields: ['scenario', 'characterDescription'],
				delayUntilRecursion: 2,
				preventRecursion: true,
				triggers: ['regenerate', 'quiet'],
				sticky: 3,
				group: 'weather',
				groupWeight: 50,
				groupOverride: true,
				useGroupScoring: true,
				position: 4,
				depth: 2,
				role: 1,
				keyRules: { dragon: { mode: 'start' }, cave: { caseSensitive: true } }
			})
		);
		expect(sets).toEqual({
			logic: 'andAll',
			probability: 30,
			caseSensitive: true,
			scanDepth: 0,
			scanFields: ['characterDescription', 'scenario'],
			wokenBy: 'entriesOnly',
			recursionLevel: 2,
			wakesOthers: false,
			triggers: ['swipe', 'quiet'],
			sticky: 3,
			group: 'weather',
			groupWeight: 50,
			groupPriority: true,
			groupScoring: true,
			placement: 'depth',
			depth: 2,
			role: 'user',
			keyRules: { cave: { caseSensitive: true }, dragon: { mode: 'start' } }
		});
	});

	test('a setting nothing reads is not named', () => {
		// Logic with no secondary keys, or on an always entry, filters nothing; a roll that is
		// switched off is a certainty; group rules outside a group decide nothing.
		expect(entrySettings(entry({ selectiveLogic: 3 }))).toEqual({});
		expect(entrySettings(entry({ constant: true, keysecondary: ['x'], selectiveLogic: 3 }))).toEqual({});
		expect(entrySettings(entry({ useProbability: false, probability: 10 }))).toEqual({});
		expect(entrySettings(entry({ groupWeight: 5, groupOverride: true }))).toEqual({});
	});

	test('recursion an import left in `rest` reads the way the entry row reads it', () => {
		expect(entrySettings(entry({ rest: { exclude_recursion: true } }))).toEqual({ wokenBy: 'chatOnly' });
	});

	test('a SillyTavern position with no place here is named rather than read as ours', () => {
		expect(entrySettings(entry({ position: 1 })).placement).toBe('After the character (SillyTavern)');
	});
});

describe('entryRow', () => {
	test('carries text only when asked, and a preview for an untitled entry', () => {
		const titled = entryRow(entry(), false);
		expect(titled).not.toHaveProperty('content');
		expect(titled).not.toHaveProperty('preview');
		expect(entryRow(entry(), true).content).toBe('A dragon sleeps.');
		const untitled = entryRow(entry({ comment: '' }), false);
		expect(untitled.preview).toBe('A dragon sleeps.');
		expect(untitled).not.toHaveProperty('comment');
	});

	test('reads behavior through the one nature rule: off outranks always', () => {
		expect(entryRow(entry({ constant: true, disable: true }), false).behavior).toBe('off');
	});
});

describe('entryCensus', () => {
	test('a book nothing departs in reads as its behaviors, its orders and its size', () => {
		const census = entryCensus([entry({ order: 10 }), entry({ order: 30 })], BOOK_DEFAULTS, estimate);
		expect(census).toEqual({ behavior: { keyword: 2 }, order: { min: 10, max: 30 }, estimatedTokens: { enabled: 32, alwaysOn: 0 } });
	});

	test('counts what entries hold, reading a setting left to the book as the book\'s', () => {
		const census = entryCensus(
			[
				entry({ probability: 30 }),
				entry({ caseSensitive: true, triggers: ['normal'] }),
				entry({ group: 'weather', position: 4 }),
				entry({ constant: true, sticky: 2 })
			],
			BOOK_DEFAULTS,
			estimate
		);
		expect(census.behavior).toEqual({ keyword: 3, always: 1 });
		expect(census.probability).toEqual({ '100': 3, '30': 1 });
		expect(census.caseSensitive).toEqual({ false: 3, true: 1 });
		expect(census.triggers).toEqual({ all: 3, normal: 1 });
		expect(census.group).toEqual({ none: 3, weather: 1 });
		expect(census.placement).toEqual({ block: 3, depth: 1 });
		expect(census.timing).toEqual({ none: 3, sticky: 1 });
		expect(census).not.toHaveProperty('wokenBy');
		expect(census.estimatedTokens).toEqual({ enabled: 64, alwaysOn: 16 });
	});

	test('a book of many labels still reads as one short map', () => {
		const entries = Array.from({ length: 30 }, (_, i) => entry({ group: `g${String(i).padStart(2, '0')}` }));
		const group = entryCensus(entries, BOOK_DEFAULTS, estimate).group as Record<string, number>;
		expect(Object.keys(group)).toHaveLength(CENSUS_ANSWERS + 1);
		expect(group['(other)']).toBe(30 - CENSUS_ANSWERS);
	});

	test('a switched-off entry weighs nothing', () => {
		const census = entryCensus([entry({ disable: true }), entry()], BOOK_DEFAULTS, estimate);
		expect(census.estimatedTokens).toEqual({ enabled: 16, alwaysOn: 0 });
	});
});

describe('parseWhere', () => {
	test('reads the census vocabulary, one answer or several per setting', () => {
		const parsed = parseWhere({ behavior: ['always', 'keyword'], logic: 'andAll', caseSensitive: true, probability: '030', triggers: 'all', placement: 'depth', order: { from: 10 } });
		expect(parsed).toEqual({
			answers: { nature: ['always', 'keyword'], filter: ['andAll'], caseSensitive: ['true'], probability: ['30'], triggers: ['all'], placement: ['depth'] },
			order: { from: 10, to: undefined }
		});
	});

	test('names every setting it cannot filter by and every answer no entry can give', () => {
		const parsed = parseWhere({ sticky: 3, behavior: 'sometimes', order: { from: 'low' } });
		expect('problems' in parsed && parsed.problems).toEqual([
			expect.stringContaining('"sticky" is not a setting to filter by'),
			'"sometimes" is not an answer `behavior` can give.',
			'`order` takes {from, to} with at least one number.'
		]);
	});
});

describe('selectEntries', () => {
	const a = entry({ id: 'a', comment: 'Red dragon', probability: 30 });
	const b = entry({ id: 'b', comment: 'Blue dragon', caseSensitive: true });
	const c = entry({ id: 'c', comment: 'Harbor', key: ['port'], content: 'Ships.', position: 1 });

	test('every picker given narrows', () => {
		expect(selectEntries([a, b, c], { ids: ['a', 'b'], query: 'blue' }, BOOK_DEFAULTS).map((e) => e.id)).toEqual(['b']);
		expect(selectEntries([a, b, c], { query: 'dragon', where: where({ probability: 30 }) }, BOOK_DEFAULTS).map((e) => e.id)).toEqual(['a']);
	});

	test('a setting left to the book answers with the book\'s value', () => {
		const picked = selectEntries([a, b, c], { where: where({ caseSensitive: true }) }, { ...BOOK_DEFAULTS, caseSensitive: true });
		expect(picked.map((e) => e.id)).toEqual(['a', 'b', 'c']);
	});

	test('foreign picks the SillyTavern positions, and nothing when there are none', () => {
		expect(selectEntries([a, b, c], { where: where({ placement: 'foreign' }) }, BOOK_DEFAULTS).map((e) => e.id)).toEqual(['c']);
		expect(selectEntries([a, b], { where: where({ placement: 'foreign' }) }, BOOK_DEFAULTS)).toEqual([]);
		expect(selectEntries([a, b, c], { where: where({ placement: ['block', 'foreign'] }) }, BOOK_DEFAULTS)).toHaveLength(3);
	});

	test('an entry limited to kinds this app never generates is counted and picked as foreign', () => {
		const quiet = entry({ id: 'q', triggers: ['quiet'] });
		const send = entry({ id: 's', triggers: ['normal'] });
		expect(entryCensus([quiet, send, a], BOOK_DEFAULTS, estimate).triggers).toEqual({ all: 1, foreign: 1, normal: 1 });
		expect(selectEntries([quiet, send, a], { where: where({ triggers: 'foreign' }) }, BOOK_DEFAULTS).map((e) => e.id)).toEqual(['q']);
	});

	test('an order span narrows with the settings', () => {
		const low = entry({ id: 'l', order: 10, probability: 30 });
		const high = entry({ id: 'h', order: 900, probability: 30 });
		expect(selectEntries([low, high], { where: where({ probability: 30, order: { to: 100 } }) }, BOOK_DEFAULTS).map((e) => e.id)).toEqual(['l']);
	});
});

describe('planEntrySettings', () => {
	const D = BOOK_DEFAULTS;

	test('writes what the bulk editor writes, to every picked entry, and counts what shows a change', () => {
		const x = entry({ id: 'x', probability: 30 });
		const y = entry({ id: 'y' });
		const plan = planEntrySettings([x, y], { probability: 30 }, undefined, D);
		expect(plan.changed).toEqual([y]);
		expect(plan.patches.get(y)).toEqual({ probability: 30, useProbability: true });
		// The dialog writes a staged value to the whole selection, the entry already holding it too.
		expect(plan.patches.get(x)).toEqual({ probability: 30, useProbability: true });
	});

	test('drops what every entry already shows, as the dialog never stages it', () => {
		expect(planEntrySettings([entry({ probability: 30 }), entry({ probability: 30 })], { probability: 30 }, undefined, D).patches.size).toBe(0);
		// A switch following a book that is already on reads as on, so staging on changes nothing.
		expect(planEntrySettings([entry()], { matchWholeWords: true }, undefined, D).patches.size).toBe(0);
		// Handing back a value every entry already shows is dropped too, the pinned one included.
		expect(planEntrySettings([entry({ caseSensitive: false }), entry()], { caseSensitive: null }, undefined, D).patches.size).toBe(0);
		// Zero is off, and turning off what is on is a change.
		expect(planEntrySettings([entry({ sticky: 3 })], { sticky: null }, undefined, D).changed).toHaveLength(1);
	});

	test('a setting only some picked entries read is written to all of them, like the dialog', () => {
		const keyed = entry({ id: 'k', keysecondary: ['cave'] });
		const plain = entry({ id: 'p' });
		const plan = planEntrySettings([keyed, plain], { selectiveLogic: 3 }, undefined, D);
		expect(plan.changed).toEqual([keyed]);
		expect(plan.patches.get(plain)).toEqual({ selectiveLogic: 3 });
	});

	test('two entries sharing an id each take their own patch', () => {
		const one = entry({ id: 'same', scanFields: ['scenario'], rest: { owner: 'Alice' } });
		const two = entry({ id: 'same', scanFields: ['steering'], rest: { owner: 'Bob' } });
		const plan = planEntrySettings([one, two], { wakesOthers: false, scanFields: { personaDescription: true } }, undefined, D);
		expect(plan.patches.get(one)).toMatchObject({ scanFields: ['scenario', 'personaDescription'], rest: { owner: 'Alice' } });
		expect(plan.patches.get(two)).toMatchObject({ scanFields: ['steering', 'personaDescription'], rest: { owner: 'Bob' } });
	});

	test('reports a setting that would reach no picked entry instead of writing it', () => {
		expect(planEntrySettings([entry()], { selectiveLogic: 3 }, undefined, D).inert).toEqual(['selectiveLogic']);
		expect(planEntrySettings([entry()], { groupWeight: 5 }, undefined, D).inert).toEqual(['groupWeight']);
		expect(planEntrySettings([entry()], { group: 'weather', groupWeight: 5 }, undefined, D).inert).toEqual([]);
		expect(planEntrySettings([entry()], { depth: 2 }, undefined, D).inert).toEqual(['depth']);
		expect(planEntrySettings([entry()], { delayLevel: 2 }, undefined, D).inert).toEqual(['delayLevel']);
		expect(planEntrySettings([entry()], { wokenBy: 'entriesOnly', delayLevel: 2 }, undefined, D).inert).toEqual([]);
	});

	test('writes the recursion trio together and clears the spellings an import left', () => {
		const e = entry({ id: 'r', rest: { prevent_recursion: true, other: 1 } });
		const plan = planEntrySettings([e], { wokenBy: 'chatOnly' }, undefined, D);
		expect(plan.patches.get(e)).toEqual({ excludeRecursion: true, preventRecursion: true, delayUntilRecursion: false, rest: { other: 1 } });
	});

	test('adds and removes one source at a time, keeping the rest', () => {
		const e = entry({ id: 's', scanFields: ['steering', 'scenario'] });
		const plan = planEntrySettings([e], { scanFields: { personaDescription: true, steering: false } }, undefined, D);
		expect(plan.patches.get(e)?.scanFields).toEqual(['scenario', 'personaDescription']);
	});

	test('key rules: every key, a named key after it, a drop, and what cannot take one', () => {
		const e = entry({ id: 'k', key: ['dragon', 'wyrm', '/dra+gon/i'], keysecondary: ['cave'], keyRules: { cave: { caseSensitive: true } } });
		// wyrm asks for whole word, which a single-word key in a whole-words book already has: the
		// chip would store nothing for it, so nothing is stored.
		const plan = planEntrySettings([e], {}, { '*': { mode: 'start' }, wyrm: { mode: 'word' }, cave: null }, D);
		expect(plan.patches.get(e)?.keyRules).toEqual({ dragon: { mode: 'start' } });
		expect(planEntrySettings([e], {}, { lindwurm: { mode: 'start' } }, D).unknownKeys).toEqual(['lindwurm']);
		expect(planEntrySettings([e], {}, { '/dra+gon/i': { mode: 'start' } }, D).regexKeys).toEqual(['/dra+gon/i']);
	});

	test('a rule naming what a key already inherits stores nothing, as the chip does', () => {
		const e = entry({ key: ['dragon', 'red dragon'] });
		const plan = planEntrySettings([e], {}, { '*': { mode: 'word', caseSensitive: false } }, D);
		// The phrase inherits "anywhere" (whole words is for single words), so only it differs.
		expect(plan.patches.get(e)?.keyRules).toEqual({ 'red dragon': { mode: 'word' } });
		expect(planEntrySettings([entry()], {}, { '*': { mode: 'word' } }, D).patches.size).toBe(0);
	});

	test('a null field drops that half of a rule and an emptied rule goes', () => {
		const e = entry({ id: 'n', keyRules: { dragon: { mode: 'start', caseSensitive: true } } });
		expect(planEntrySettings([e], {}, { dragon: { caseSensitive: null } }, D).patches.get(e)?.keyRules).toEqual({ dragon: { mode: 'start' } });
		expect(planEntrySettings([e], {}, { dragon: { mode: null, caseSensitive: null } }, D).patches.get(e)?.keyRules).toBeUndefined();
	});
});

describe('lorebookRevisionView', () => {
	const book = () => ({ ...createEmptyLorebook('Lore'), entries: [entry({ id: 'e' })] });

	test('moves with a setting and a switch the tools can report', () => {
		const base = book();
		const before = JSON.stringify(lorebookRevisionView(base));
		expect(JSON.stringify(lorebookRevisionView({ ...base, entries: [entry({ id: 'e', sticky: 2 })] }))).not.toBe(before);
		expect(JSON.stringify(lorebookRevisionView({ ...base, global: true }))).not.toBe(before);
		expect(JSON.stringify(lorebookRevisionView({ ...base, scanDepth: 4 }))).not.toBe(before);
	});

	test('leaves a titled entry\'s text to the text view, which only moves with the text', () => {
		const base = book();
		const rewritten = { ...base, entries: [entry({ id: 'e', content: 'The dragon wakes.' })] };
		expect(JSON.stringify(lorebookRevisionView(rewritten))).toBe(JSON.stringify(lorebookRevisionView(base)));
		expect(JSON.stringify(lorebookTextView(rewritten))).not.toBe(JSON.stringify(lorebookTextView(base)));
		expect(JSON.stringify(lorebookTextView({ ...base, scanDepth: 4 }))).toBe(JSON.stringify(lorebookTextView(base)));
	});

	test('holds still for what no tool shows', () => {
		const base = book();
		const before = JSON.stringify(lorebookRevisionView(base));
		expect(JSON.stringify(lorebookRevisionView({ ...base, entries: [entry({ id: 'e', rest: { characterFilter: { names: ['x'] } } })] }))).toBe(before);
		expect(JSON.stringify(lorebookRevisionView({ ...base, cover: 'images/lorebooks/c.webp', extensions: { description: 'x' } }))).toBe(before);
	});
});

describe('parseLorebookDefaults', () => {
	test('no row is the stock settings, and a partial row is merged over them', () => {
		expect(parseLorebookDefaults(null)).toEqual(DEFAULT_LOREBOOK_GLOBAL_SETTINGS);
		expect(parseLorebookDefaults('{"scanDepth":4}')).toEqual({ ...DEFAULT_LOREBOOK_GLOBAL_SETTINGS, scanDepth: 4 });
	});

	test('a row that will not parse is refused, never guessed at', () => {
		expect(() => parseLorebookDefaults('{"scanDepth":')).toThrow();
		expect(() => parseLorebookDefaults('[1]')).toThrow();
	});
});
