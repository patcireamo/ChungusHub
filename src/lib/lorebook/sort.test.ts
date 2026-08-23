/**
 * Lorebook display-order tests. Run with `bun test`.
 *
 * Locks the contract the book lists rely on: the name orders read like a shelf (case- and
 * digit-aware), unnamed books sink to the bottom in BOTH directions, 'updated' leaves the
 * store's own order alone, and no order ever mutates the array it was handed, because link
 * resolution reads that array to decide what reaches the prompt first.
 */

import { describe, expect, test } from 'bun:test';

import { sortLorebooks } from './types';

/** Only the two fields the sort reads; `sortLorebooks` is typed to accept exactly this much. */
function book(name: string, updatedAt = 0) {
	return { name, updatedAt };
}

const names = (books: { name: string }[]) => books.map((b) => b.name);

describe('sortLorebooks', () => {
	test('a-z orders by name, ignoring case', () => {
		const shelf = [book('zebra'), book('Apple'), book('mango')];
		expect(names(sortLorebooks(shelf, 'a-z'))).toEqual(['Apple', 'mango', 'zebra']);
	});

	test('z-a is the reverse of a-z', () => {
		const shelf = [book('zebra'), book('Apple'), book('mango')];
		expect(names(sortLorebooks(shelf, 'z-a'))).toEqual(['zebra', 'mango', 'Apple']);
	});

	test('numbered books read in counting order, not string order', () => {
		const shelf = [book('Arc 10'), book('Arc 2'), book('Arc 1')];
		expect(names(sortLorebooks(shelf, 'a-z'))).toEqual(['Arc 1', 'Arc 2', 'Arc 10']);
	});

	test('unnamed books sink to the bottom in both directions', () => {
		const shelf = [book(''), book('Beta'), book('   '), book('Alpha')];
		expect(names(sortLorebooks(shelf, 'a-z'))).toEqual(['Alpha', 'Beta', '', '   ']);
		expect(names(sortLorebooks(shelf, 'z-a'))).toEqual(['Beta', 'Alpha', '', '   ']);
	});

	test('books sharing a name fall back to most-recently-edited first', () => {
		const shelf = [book('Lore', 100), book('Lore', 300), book('Lore', 200)];
		expect(sortLorebooks(shelf, 'a-z').map((b) => b.updatedAt)).toEqual([300, 200, 100]);
	});

	test("'updated' keeps the order the store handed over", () => {
		const shelf = [book('zebra', 300), book('Apple', 200), book('mango', 100)];
		expect(names(sortLorebooks(shelf, 'updated'))).toEqual(['zebra', 'Apple', 'mango']);
	});

	test('never reorders the input array', () => {
		const shelf = [book('zebra'), book('Apple'), book('mango')];
		for (const order of ['a-z', 'z-a', 'updated'] as const) {
			const out = sortLorebooks(shelf, order);
			expect(out).not.toBe(shelf);
			expect(names(shelf)).toEqual(['zebra', 'Apple', 'mango']);
		}
	});
});
