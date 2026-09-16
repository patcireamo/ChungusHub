/**
 * What the keyword chips accept. Run with `bun test`.
 *
 * One contract, and it is the opposite of what it looks like: a repeat is a key the list
 * already holds BYTE FOR BYTE, and alternate capitalisations of a word are NOT repeats. A key
 * carries its own match rule, so an entry can hold a case-sensitive acronym beside an ordinary
 * word, and an entry that has to catch several spellings has to be able to say all of them.
 * Folding case in the input would refuse the rest, for a rule that is set per key and can be
 * changed after the key is added.
 *
 * The second half is that nothing is dropped in silence: what was refused comes back to the
 * caller so it can be said.
 */

import { describe, expect, test } from 'bun:test';

import { addLorebookKeys } from './types';

describe('addLorebookKeys', () => {
	test('a key the list already holds exactly is refused, and named', () => {
		const out = addLorebookKeys(['phone'], ['phone']);
		expect(out.next).toEqual(['phone']);
		expect(out.refused).toEqual(['phone']);
	});

	test('every alternate capitalisation is a key of its own, not just the first letter', () => {
		const out = addLorebookKeys(['phone'], ['Phone', 'PHONE', 'pHoNe']);
		expect(out.next).toEqual(['phone', 'Phone', 'PHONE', 'pHoNe']);
		expect(out.refused).toEqual([]);
	});

	test('a repeat inside one paste is added once and refused once', () => {
		const out = addLorebookKeys([], ['phone', 'tv', 'phone']);
		expect(out.next).toEqual(['phone', 'tv']);
		expect(out.refused).toEqual(['phone']);
	});

	test('one word offered several times is refused once, so the caller counts keywords', () => {
		const out = addLorebookKeys(['phone'], ['phone', 'phone', 'phone']);
		expect(out.next).toEqual(['phone']);
		expect(out.refused).toEqual(['phone']);
	});

	test('unrelated keys are added in the order they were offered', () => {
		const out = addLorebookKeys(['radio'], ['phone', 'tv']);
		expect(out.next).toEqual(['radio', 'phone', 'tv']);
		expect(out.refused).toEqual([]);
	});

	test('nothing offered leaves the list untouched', () => {
		const out = addLorebookKeys(['phone'], []);
		expect(out.next).toEqual(['phone']);
		expect(out.refused).toEqual([]);
	});
});
