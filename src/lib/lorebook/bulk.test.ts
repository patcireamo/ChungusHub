/**
 * Editing many entries at once (bulk.ts). Run with `bun test`.
 *
 * The rule under test is that a bulk edit writes into each entry exactly what the entry row
 * writes for the same press, and nothing else: an empty edit is an empty patch, a membership
 * list gains or loses only what was staged, and the recursion trio moves the way the row's own
 * `setRecursion` moves it. The offers are the other half: a staged sub-setting under a knob the
 * editor no longer draws must not land.
 */
import { describe, expect, test } from 'bun:test';
import {
	MIXED,
	bulkEntryPatch,
	bulkOffers,
	changedKnobs,
	offeredEdit,
	sharedValue,
	withoutKnob
} from './bulk';
import { createEmptyLorebookEntry, type LorebookEntry } from './types';

function entry(fields: Partial<LorebookEntry> = {}): LorebookEntry {
	return { ...createEmptyLorebookEntry(), ...fields };
}

describe('sharedValue', () => {
	test('names the value every entry holds', () => {
		expect(sharedValue([entry({ order: 5 }), entry({ order: 5 })], (e) => e.order)).toBe(5);
	});

	test('is mixed the moment one entry disagrees', () => {
		expect(sharedValue([entry({ order: 5 }), entry({ order: 6 })], (e) => e.order)).toBe(MIXED);
	});

	test('an empty selection holds nothing in common', () => {
		expect(sharedValue([], (e) => e.order)).toBe(MIXED);
	});
});

describe('bulkEntryPatch: what is stamped', () => {
	test('an empty edit writes nothing at all', () => {
		expect(bulkEntryPatch(entry({ order: 3, constant: true }), {})).toEqual({});
	});

	test('Off keeps the entry constant, and the other two natures set both flags', () => {
		expect(bulkEntryPatch(entry({ constant: true }), { nature: 'off' })).toEqual({ disable: true });
		expect(bulkEntryPatch(entry({ disable: true }), { nature: 'always' })).toEqual({
			disable: false,
			constant: true
		});
		expect(bulkEntryPatch(entry({ constant: true }), { nature: 'keyword' })).toEqual({
			disable: false,
			constant: false
		});
	});

	test('a trigger chance switches the roll on', () => {
		expect(bulkEntryPatch(entry({ useProbability: false }), { probability: 40 })).toEqual({
			probability: 40,
			useProbability: true
		});
	});

	test('follow the book and off are written as null, never dropped', () => {
		const stored = entry({ caseSensitive: true, scanDepth: 3, sticky: 2 });
		expect(
			bulkEntryPatch(stored, { caseSensitive: null, scanDepth: null, sticky: null })
		).toEqual({ caseSensitive: null, scanDepth: null, sticky: null });
	});

	test('every other setting lands as staged, and only the staged ones', () => {
		const patch = bulkEntryPatch(entry(), {
			selectiveLogic: 3,
			order: 7,
			matchWholeWords: false,
			cooldown: 4,
			delay: 9,
			group: 'weather, mood',
			groupWeight: 30,
			groupOverride: true,
			useGroupScoring: false,
			position: 4,
			depth: 2,
			role: 1
		});
		expect(patch).toEqual({
			selectiveLogic: 3,
			order: 7,
			matchWholeWords: false,
			cooldown: 4,
			delay: 9,
			group: 'weather, mood',
			groupWeight: 30,
			groupOverride: true,
			useGroupScoring: false,
			position: 4,
			depth: 2,
			role: 1
		});
	});
});

describe('bulkEntryPatch: the two membership lists', () => {
	test('a source is added or taken out, and the rest of the list stays as the entry had it', () => {
		const own = entry({ scanFields: ['steering', 'scenario'] });
		expect(
			bulkEntryPatch(own, { scanFields: { scenario: false, characterDescription: true } }).scanFields
		).toEqual(['steering', 'characterDescription']);
	});

	test('a source already on is never listed twice', () => {
		const own = entry({ scanFields: ['scenario'] });
		expect(bulkEntryPatch(own, { scanFields: { scenario: true } }).scanFields).toEqual(['scenario']);
	});

	test("an imported alias counts as its kind, and off takes every spelling of it out", () => {
		const imported = entry({ triggers: ['regenerate', 'normal'] });
		expect(bulkEntryPatch(imported, { triggers: { swipe: true } }).triggers).toEqual([
			'regenerate',
			'normal'
		]);
		const both = entry({ triggers: ['swipe', 'regenerate', 'continue'] });
		expect(bulkEntryPatch(both, { triggers: { swipe: false } }).triggers).toEqual(['continue']);
	});

	test('a token for a kind this app never generates is kept', () => {
		const foreign = entry({ triggers: ['quiet'] });
		expect(bulkEntryPatch(foreign, { triggers: { normal: true } }).triggers).toEqual([
			'quiet',
			'normal'
		]);
	});

	test('two entries never share one list', () => {
		const edit = { scanFields: { scenario: true }, triggers: { normal: true } } as const;
		const a = bulkEntryPatch(entry(), edit);
		const b = bulkEntryPatch(entry(), edit);
		expect(a.scanFields).not.toBe(b.scanFields);
		expect(a.triggers).not.toBe(b.triggers);
	});
});

describe('bulkEntryPatch: recursion moves as the row moves it', () => {
	test('the chat only: excluded, not waiting', () => {
		expect(bulkEntryPatch(entry({ delayUntilRecursion: 2 }), { wokenBy: 'chatOnly' })).toEqual({
			excludeRecursion: true,
			preventRecursion: false,
			delayUntilRecursion: false,
			rest: {}
		});
	});

	test('other entries only keeps a waiting entry its own level and starts the rest at one', () => {
		const waiting = entry({ delayUntilRecursion: 3 });
		expect(bulkEntryPatch(waiting, { wokenBy: 'entriesOnly' }).delayUntilRecursion).toBe(3);
		expect(bulkEntryPatch(entry(), { wokenBy: 'entriesOnly' }).delayUntilRecursion).toBe(true);
		expect(
			bulkEntryPatch(entry(), { wokenBy: 'entriesOnly', delayLevel: 2 }).delayUntilRecursion
		).toBe(2);
	});

	test('the chat and other entries clears both the exclusion and the wait', () => {
		const patch = bulkEntryPatch(entry({ excludeRecursion: true, delayUntilRecursion: true }), {
			wokenBy: 'both'
		});
		expect(patch.excludeRecursion).toBe(false);
		expect(patch.delayUntilRecursion).toBe(false);
	});

	test('a level alone moves a waiting entry and leaves one that does not wait untouched', () => {
		expect(bulkEntryPatch(entry({ delayUntilRecursion: true }), { delayLevel: 4 })).toMatchObject({
			delayUntilRecursion: 4
		});
		expect(bulkEntryPatch(entry(), { delayLevel: 4 })).toEqual({});
	});

	test('one flag writes all three from what the entry resolves to, and clears the legacy spellings', () => {
		const imported = entry({
			rest: { exclude_recursion: true, delayUntilRecursion: 2, characterFilter: { names: ['A'] } }
		});
		expect(bulkEntryPatch(imported, { wakesOthers: false })).toEqual({
			excludeRecursion: true,
			preventRecursion: true,
			delayUntilRecursion: 2,
			rest: { characterFilter: { names: ['A'] } }
		});
	});
});

describe('what the editor offers', () => {
	test('filter logic is offered only while some entry has secondary keys', () => {
		const plain = [entry(), entry()];
		expect(bulkOffers(plain, {}).filter).toBe(false);
		expect(offeredEdit(plain, { selectiveLogic: 3 })).toEqual({});
		const filtered = [entry(), entry({ keysecondary: ['night'] })];
		expect(offeredEdit(filtered, { selectiveLogic: 3 })).toEqual({ selectiveLogic: 3 });
	});

	test('nor while every entry holding secondary keys is always active, which reads no keys', () => {
		const always = [entry({ constant: true, keysecondary: ['night'] }), entry({ constant: true })];
		expect(bulkOffers(always, {}).filter).toBe(false);
		expect(offeredEdit(always, { selectiveLogic: 3 })).toEqual({});
		expect(bulkOffers(always, { nature: 'keyword' }).filter).toBe(true);
	});

	test('a level is offered only while every entry waits once the edit lands', () => {
		const mixed = [entry({ delayUntilRecursion: true }), entry()];
		expect(bulkOffers(mixed, {}).level).toBe(false);
		expect(offeredEdit(mixed, { delayLevel: 2 })).toEqual({});
		expect(bulkOffers(mixed, { wokenBy: 'entriesOnly' }).level).toBe(true);
		expect(offeredEdit(mixed, { wokenBy: 'entriesOnly', delayLevel: 2 })).toEqual({
			wokenBy: 'entriesOnly',
			delayLevel: 2
		});
		const waiting = [entry({ delayUntilRecursion: true }), entry({ delayUntilRecursion: 2 })];
		expect(offeredEdit(waiting, { wokenBy: 'both', delayLevel: 2 })).toEqual({ wokenBy: 'both' });
	});

	test('the group rules follow whether any entry is in a group once the edit lands', () => {
		const grouped = [entry({ group: 'mood' }), entry()];
		expect(bulkOffers(grouped, {}).groupRules).toBe(true);
		expect(offeredEdit(grouped, { group: ' ', groupWeight: 10, groupOverride: true })).toEqual({
			group: ' '
		});
		expect(bulkOffers([entry()], { group: 'weather' }).groupRules).toBe(true);
	});

	test('depth and role follow whether any entry is placed in the chat once the edit lands', () => {
		const block = [entry(), entry({ position: 1 })];
		expect(offeredEdit(block, { depth: 2, role: 1 })).toEqual({});
		expect(offeredEdit(block, { position: 4, depth: 2, role: 1 })).toEqual({
			position: 4,
			depth: 2,
			role: 1
		});
	});

	test('Woken by is worded for always-active entries only while every one of them is', () => {
		const pair = [entry({ constant: true }), entry()];
		expect(bulkOffers(pair, {}).allAlways).toBe(false);
		expect(bulkOffers(pair, { nature: 'always' }).allAlways).toBe(true);
		expect(bulkOffers([entry({ constant: true })], { nature: 'off' }).allAlways).toBe(true);
	});
});

describe('knobs', () => {
	test('a knob is one change however many of its settings are staged', () => {
		expect([...changedKnobs({ sticky: 2, cooldown: null, order: 5 })]).toEqual(['timing', 'order']);
	});

	test('Leave as is drops every setting under its knob and nothing else', () => {
		expect(
			withoutKnob({ wokenBy: 'entriesOnly', delayLevel: 2, wakesOthers: false }, 'wokenBy')
		).toEqual({ wakesOthers: false });
	});
});
