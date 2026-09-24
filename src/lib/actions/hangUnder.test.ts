/**
 * Where a turn's dropdown hangs across the screen. Run with `bun test`.
 *
 * The spans are the ones a 288px menu actually meets: a wide desktop column, a tablet's short
 * icon row, and a phone whose column is barely wider than the menu.
 */

import { describe, expect, test } from 'bun:test';

import { hangLeft } from './hangUnder';

const MENU = 288;
const desktop = { column: { left: 422, right: 921 }, bounds: { left: 300, right: 1270 } };
const phone = { column: { left: 54, right: 368 }, bounds: { left: 0, right: 375 } };

describe('hangLeft', () => {
	test('the last button of a row opens leftward, flush with its right edge', () => {
		const trigger = { left: 787, right: 858 };
		const left = hangLeft({ ...desktop, trigger, row: { left: 422, right: 862 } }, MENU);
		expect(left + MENU).toBe(trigger.right);
	});

	test('a button in the first half of its row opens rightward, flush with its left edge', () => {
		const trigger = { left: 553, right: 618 };
		expect(hangLeft({ ...desktop, trigger, row: { left: 422, right: 862 } }, MENU)).toBe(trigger.left);
	});

	test('the middle button of a row grows toward the middle of the column', () => {
		const trigger = { left: 687, right: 726 };
		const row = { left: 565, right: 848 };
		const towardLeft = { trigger, row, column: { left: 360, right: 1040 }, bounds: desktop.bounds };
		expect(hangLeft(towardLeft, MENU) + MENU).toBe(trigger.right);
		const towardRight = { trigger, row, column: { left: 380, right: 1260 }, bounds: desktop.bounds };
		expect(hangLeft(towardRight, MENU)).toBe(trigger.left);
	});

	test('it takes the other edge when only that one keeps it over its own turn', () => {
		const trigger = { left: 296, right: 324 };
		const at = { trigger, row: { left: 160, right: 324 }, column: { left: 54, right: 750 }, bounds: { left: 0, right: 768 } };
		expect(hangLeft(at, MENU)).toBe(trigger.left);
	});

	test('on a phone a menu may leave the column but never the screen', () => {
		const del = { left: 265, right: 304 };
		expect(hangLeft({ ...phone, trigger: del, row: { left: 54, right: 307 } }, MENU)).toBe(16);

		const retry = { left: 140, right: 179 };
		expect(hangLeft({ ...phone, trigger: retry, row: { left: 54, right: 307 } }, MENU)).toBe(375 - 8 - MENU);
	});

	test('a menu wider than the room keeps its left edge on screen', () => {
		const at = { trigger: { left: 200, right: 240 }, row: { left: 20, right: 240 }, column: phone.column, bounds: { left: 0, right: 280 } };
		expect(hangLeft(at, MENU)).toBe(8);
	});
});
