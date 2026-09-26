/**
 * Picking a selection of entries (select.ts). Run with `bun test`.
 *
 * A stretch is read in the order the list shows, takes the state the pressed row takes, and
 * falls back to a plain toggle when the row it would stretch from is not on screen.
 */
import { describe, expect, test } from 'bun:test';
import { extendSelection } from './select';

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
