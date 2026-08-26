/**
 * Lorebook display-order tests, for both shelves: the books, and the open book's entries.
 * Run with `bun test`.
 *
 * Locks the contract the book lists rely on: the name orders read like a shelf (case- and
 * digit-aware), unnamed books sink to the bottom in BOTH directions, same-named books break
 * the tie on creation and so never reshuffle when one of them is edited, 'updated' leaves the
 * store's own order alone, and no order ever mutates the array it was handed, because link
 * resolution reads that array to decide what reaches the prompt first.
 *
 * The entry orders answer to the same rules plus one of their own: every order tie-breaks on
 * `order`, the sequence the entries actually reach the prompt in, so two rows the chosen order
 * cannot separate hold still instead of sitting in whatever sequence they were stored in.
 * `natureOf` rides here too, because the Show filter and the entry row's own switch have to
 * read a row the same way.
 */

import { describe, expect, test } from 'bun:test';

import { natureOf, sortEntries, sortLorebooks } from './types';

/** Only the two fields the sort reads; `sortLorebooks` is typed to accept exactly this much. */
function book(name: string, createdAt = 0) {
	return { name, createdAt };
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

	test('books sharing a name fall back to newest-created first', () => {
		const shelf = [book('Lore', 100), book('Lore', 300), book('Lore', 200)];
		expect(sortLorebooks(shelf, 'a-z').map((b) => b.createdAt)).toEqual([300, 200, 100]);
	});

	// The reason the tie-break is `createdAt` and not `updatedAt`. Two books imported under the
	// same name read identically in the list, so a tie-break that moved when either was edited
	// would swap them under the cursor with nothing on screen saying so.
	test('editing cannot reorder a same-named pair', () => {
		const original = { name: 'Lore', createdAt: 100, updatedAt: 100 };
		const reimport = { name: 'Lore', createdAt: 300, updatedAt: 100 };
		const before = sortLorebooks([original, reimport], 'a-z');
		// The older one is edited: `updatedAt` now says it is the freshest book on the shelf.
		original.updatedAt = 999;
		expect(sortLorebooks([original, reimport], 'a-z')).toEqual(before);
		expect(before.map((b) => b.createdAt)).toEqual([300, 100]);
	});

	test('unnamed books also tie-break on newest-created first', () => {
		const shelf = [book('', 100), book('', 300), book('Alpha', 200)];
		expect(sortLorebooks(shelf, 'a-z').map((b) => b.createdAt)).toEqual([200, 300, 100]);
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

/** Only the fields an entry order reads; `sortEntries` is typed to accept exactly this much. */
interface TestEntry {
	comment: string;
	content: string;
	key: string[];
	keysecondary: string[];
	order: number;
}

function entry(over: Partial<TestEntry> = {}): TestEntry {
	return { comment: '', content: '', key: [], keysecondary: [], order: 0, ...over };
}

const ENTRY_SORTS = [
	'order',
	'order-desc',
	'a-z',
	'z-a',
	'longest',
	'shortest',
	'most-keys',
	'fewest-keys'
] as const;

const titles = (entries: TestEntry[]) => entries.map((e) => e.comment);
const orders = (entries: TestEntry[]) => entries.map((e) => e.order);

describe('sortEntries', () => {
	test('order runs low to high, and reverse order runs the other way', () => {
		const list = [entry({ order: 300 }), entry({ order: 100 }), entry({ order: 200 })];
		expect(orders(sortEntries(list, 'order'))).toEqual([100, 200, 300]);
		expect(orders(sortEntries(list, 'order-desc'))).toEqual([300, 200, 100]);
	});

	test('the title orders ignore case and reverse each other', () => {
		const list = [entry({ comment: 'zebra' }), entry({ comment: 'Apple' }), entry({ comment: 'mango' })];
		expect(titles(sortEntries(list, 'a-z'))).toEqual(['Apple', 'mango', 'zebra']);
		expect(titles(sortEntries(list, 'z-a'))).toEqual(['zebra', 'mango', 'Apple']);
	});

	test('numbered titles read in counting order, not string order', () => {
		const list = [entry({ comment: 'Scene 10' }), entry({ comment: 'Scene 2' })];
		expect(titles(sortEntries(list, 'a-z'))).toEqual(['Scene 2', 'Scene 10']);
	});

	test('untitled entries sink in both directions', () => {
		const list = [entry({ comment: '' }), entry({ comment: 'Beta' }), entry({ comment: '   ' }), entry({ comment: 'Alpha' })];
		expect(titles(sortEntries(list, 'a-z'))).toEqual(['Alpha', 'Beta', '', '   ']);
		expect(titles(sortEntries(list, 'z-a'))).toEqual(['Beta', 'Alpha', '', '   ']);
	});

	test('longest and shortest read the content, not the title', () => {
		const list = [
			entry({ comment: 'short body', content: 'ab' }),
			entry({ comment: 'a', content: 'abcd' }),
			entry({ comment: 'b', content: 'abc' })
		];
		expect(titles(sortEntries(list, 'longest'))).toEqual(['a', 'b', 'short body']);
		expect(titles(sortEntries(list, 'shortest'))).toEqual(['short body', 'b', 'a']);
	});

	test('the key counts include the secondary keys', () => {
		const list = [
			entry({ comment: 'three', key: ['a', 'b'], keysecondary: ['c'] }),
			entry({ comment: 'one', key: ['a'] }),
			entry({ comment: 'two', keysecondary: ['a', 'b'] })
		];
		expect(titles(sortEntries(list, 'most-keys'))).toEqual(['three', 'two', 'one']);
		expect(titles(sortEntries(list, 'fewest-keys'))).toEqual(['one', 'two', 'three']);
	});

	// The reason every order ends in `|| a.order - b.order`. Two rows an order cannot separate
	// would otherwise sit in whatever sequence the book happens to store them in, and move the
	// moment one of them is edited, with nothing on screen admitting the swap.
	test('every order tie-breaks on order, never on storage position', () => {
		// Alike in every field an order reads, so only the tie-break can separate them, and
		// stored high-first, so leaving them alone would read as 90 then 10.
		const tied = () => [
			entry({ comment: 'Same', content: 'xx', key: ['a'], order: 90 }),
			entry({ comment: 'Same', content: 'xx', key: ['a'], order: 10 })
		];
		for (const sort of ENTRY_SORTS) {
			expect(orders(sortEntries(tied(), sort))).toEqual(
				sort === 'order-desc' ? [90, 10] : [10, 90]
			);
		}
	});

	test('never reorders the input array', () => {
		const list = [entry({ comment: 'zebra', order: 3 }), entry({ comment: 'Apple', order: 1 })];
		for (const sort of ENTRY_SORTS) {
			const out = sortEntries(list, sort);
			expect(out).not.toBe(list);
			expect(titles(list)).toEqual(['zebra', 'Apple']);
		}
	});
});

describe('natureOf', () => {
	test('reads the three kinds the entry row names', () => {
		expect(natureOf({ constant: true, disable: false })).toBe('always');
		expect(natureOf({ constant: false, disable: false })).toBe('keyword');
		expect(natureOf({ constant: false, disable: true })).toBe('off');
	});

	// A disabled entry is inert whatever else it says, so the list must not file it under the
	// kind it would have been. Hiding "Off" has to take it with them.
	test('off wins over always when an entry is both', () => {
		expect(natureOf({ constant: true, disable: true })).toBe('off');
	});
});
