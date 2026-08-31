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
 * read a row the same way, and so does `lorebookDeleteMessage`, the one sentence the shelf's
 * row menu and the open book's own menu both say before a book goes.
 */

import { describe, expect, test } from 'bun:test';

import {
	activationSummary,
	DEFAULT_LOREBOOK_GLOBAL_SETTINGS,
	lorebookDeleteMessage,
	natureOf,
	resolveLinkedBooks,
	resolveLorebookLinks,
	sortEntries,
	sortLorebooks,
	type Lorebook,
	type LorebookLinks
} from './types';

/** Only the three fields the sort reads; `sortLorebooks` is typed to accept exactly this much. */
function book(name: string, createdAt = 0, entries = 0) {
	return { name, createdAt, entries: new Array(entries).fill(null) };
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

	// 'newest'/'oldest' read the creation stamp, which is what makes them a different question
	// from 'updated': a book made last year and edited this morning is not a new book.
	test('newest and oldest read when the book was made', () => {
		const shelf = [book('mango', 200), book('zebra', 300), book('Apple', 100)];
		expect(names(sortLorebooks(shelf, 'newest'))).toEqual(['zebra', 'mango', 'Apple']);
		expect(names(sortLorebooks(shelf, 'oldest'))).toEqual(['Apple', 'mango', 'zebra']);
	});

	test('the entry counts order by how much each book holds', () => {
		const shelf = [book('mango', 0, 3), book('zebra', 0, 12), book('Apple', 0, 0)];
		expect(names(sortLorebooks(shelf, 'most-entries'))).toEqual(['zebra', 'mango', 'Apple']);
		expect(names(sortLorebooks(shelf, 'fewest-entries'))).toEqual(['Apple', 'mango', 'zebra']);
	});

	// The counting orders are where the tie-break earns its place: a shelf nobody has written in
	// yet is one long tie, and only a key that never moves keeps those rows still.
	test('books holding the same number fall back to newest-created first', () => {
		const shelf = [book('a', 100, 2), book('b', 300, 2), book('c', 200, 2)];
		expect(sortLorebooks(shelf, 'most-entries').map((b) => b.createdAt)).toEqual([300, 200, 100]);
		expect(sortLorebooks(shelf, 'fewest-entries').map((b) => b.createdAt)).toEqual([300, 200, 100]);
	});

	test('never reorders the input array', () => {
		const shelf = [book('zebra'), book('Apple'), book('mango')];
		const orders = ['a-z', 'z-a', 'newest', 'oldest', 'updated', 'most-entries', 'fewest-entries'] as const;
		for (const order of orders) {
			const out = sortLorebooks(shelf, order);
			expect(out).not.toBe(shelf);
			expect(names(shelf)).toEqual(['zebra', 'Apple', 'mango']);
		}
	});
});

/**
 * What a chat plays with. This is coupling #1: the meters resolve over the store's cached
 * books and generation resolves over a fresh server read, so anything this decides by the
 * ARRAY it was handed rather than by the books themselves makes the meter price a prompt the
 * send does not build.
 */
describe('resolveLorebookLinks', () => {
	const shelf = (...books: Partial<Lorebook>[]): Lorebook[] =>
		books.map((b, i) => ({ id: `b${i}`, name: `b${i}`, createdAt: i, ...b }) as Lorebook);

	/** The layers a chat brings, with anything the test does not name left empty. */
	const links = (partial: Partial<LorebookLinks>): LorebookLinks => ({
		cards: [],
		chat: [],
		muted: [],
		...partial
	});

	/** A chat that named nothing of its own, which is every chat until somebody says otherwise. */
	const cardsOnly = (cards: string[] | undefined) => links({ cards });

	test('links resolve in link order, deduped, missing ids dropped', () => {
		const books = shelf({ id: 'a' }, { id: 'b' }, { id: 'c' });
		const out = resolveLorebookLinks(books, cardsOnly(['c', 'a', 'c', 'gone']));
		expect(out.map((b) => b.id)).toEqual(['c', 'a']);
	});

	// What a chip counting an entry's links must ask instead, or a card that links nothing
	// reports the shelf's global books as links it made.
	test('resolveLinkedBooks answers with links alone', () => {
		const books = shelf({ id: 'world', global: true }, { id: 'card' });
		expect(resolveLinkedBooks(books, []).map((b) => b.id)).toEqual([]);
		expect(resolveLinkedBooks(books, ['card']).map((b) => b.id)).toEqual(['card']);
	});

	// The whole point of the switch: no card names it, so nothing in the id list can reach it.
	test('a global book joins a chat that links nothing at all', () => {
		const books = shelf({ id: 'world', global: true }, { id: 'plain' });
		expect(resolveLorebookLinks(books, cardsOnly([])).map((b) => b.id)).toEqual(['world']);
		expect(
			resolveLorebookLinks(books, links({ cards: undefined, chat: null })).map((b) => b.id)
		).toEqual(['world']);
	});

	test('globals lead, and a card cannot reshuffle them by linking one', () => {
		const books = shelf({ id: 'w1', global: true }, { id: 'card' }, { id: 'w2', global: true });
		expect(resolveLorebookLinks(books, cardsOnly(['card', 'w2'])).map((b) => b.id)).toEqual([
			'w1',
			'w2',
			'card'
		]);
	});

	// The three layers are widest first, so neither the cards nor the chat can move what the
	// layer above them laid down.
	test("a chat's own books come after the globals and the cards", () => {
		const books = shelf({ id: 'world', global: true }, { id: 'card' }, { id: 'mine' });
		expect(
			resolveLorebookLinks(books, links({ cards: ['card'], chat: ['mine'] })).map((b) => b.id)
		).toEqual(['world', 'card', 'mine']);
	});

	// The whole point of the chat layer: no card names it, and it still reaches the prompt.
	test('a chat can carry a book nothing else brings', () => {
		const books = shelf({ id: 'plain' }, { id: 'mine' });
		expect(resolveLorebookLinks(books, links({ chat: ['mine'] })).map((b) => b.id)).toEqual([
			'mine'
		]);
	});

	// Attaching a book the card already links must not lay its lore down twice.
	test('a book both a card and the chat name appears once, in the card place', () => {
		const books = shelf({ id: 'card' }, { id: 'other' });
		expect(
			resolveLorebookLinks(books, links({ cards: ['card'], chat: ['other', 'card'] })).map(
				(b) => b.id
			)
		).toEqual(['card', 'other']);
	});

	// Same rule the cards live by: nothing sweeps the id, so the resolver drops it.
	test("a chat's link to a deleted book is dropped", () => {
		const books = shelf({ id: 'plain' });
		expect(
			resolveLorebookLinks(books, links({ chat: ['gone', 'plain'] })).map((b) => b.id)
		).toEqual(['plain']);
	});

	// The two callers read the same query at two different moments, so the array order is not
	// something they agree on. Creation order is, and it never moves.
	test('globals come in creation order, whatever order the array is in', () => {
		const first = { id: 'first', global: true, createdAt: 100 };
		const second = { id: 'second', global: true, createdAt: 200 };
		const forwards = resolveLorebookLinks(shelf(first, second), cardsOnly([]));
		const backwards = resolveLorebookLinks(shelf(second, first), cardsOnly([]));
		expect(forwards.map((b) => b.id)).toEqual(['first', 'second']);
		expect(backwards.map((b) => b.id)).toEqual(['first', 'second']);
	});

	// The clause that actually carries that promise: a folder import stamps a run of books in
	// the same millisecond, so creation order alone leaves them in whatever order each caller's
	// array happened to be in, which is the divergence the sort exists to close.
	test('globals made in the same millisecond resolve in one fixed sequence', () => {
		const alpha = { id: 'alpha', global: true, createdAt: 100 };
		const beta = { id: 'beta', global: true, createdAt: 100 };
		const gamma = { id: 'gamma', global: true, createdAt: 100 };
		expect(resolveLorebookLinks(shelf(gamma, alpha, beta), cardsOnly([])).map((b) => b.id)).toEqual(
			['alpha', 'beta', 'gamma']
		);
		expect(resolveLorebookLinks(shelf(beta, gamma, alpha), cardsOnly([])).map((b) => b.id)).toEqual(
			['alpha', 'beta', 'gamma']
		);
	});

	test('a global book a card also links appears once', () => {
		const books = shelf({ id: 'world', global: true }, { id: 'card' });
		expect(resolveLorebookLinks(books, cardsOnly(['world', 'card'])).map((b) => b.id)).toEqual([
			'world',
			'card'
		]);
	});

	test('never reorders the array it was handed', () => {
		const books = shelf({ id: 'late', global: true, createdAt: 900 }, { id: 'early', global: true, createdAt: 1 });
		resolveLorebookLinks(books, cardsOnly([]));
		expect(books.map((b) => b.id)).toEqual(['late', 'early']);
	});

	// The only way one story can stand outside a book the wider setup brings it. Without this
	// the switch that puts a book in every chat has no exception at all.
	test('a mute takes a global book out of this story alone', () => {
		const books = shelf({ id: 'world', global: true }, { id: 'other', global: true });
		expect(resolveLorebookLinks(books, links({ muted: ['world'] })).map((b) => b.id)).toEqual([
			'other'
		]);
	});

	test("a mute reaches a book this chat's own card links", () => {
		const books = shelf({ id: 'card' }, { id: 'plain' });
		expect(
			resolveLorebookLinks(books, links({ cards: ['card', 'plain'], muted: ['card'] })).map(
				(b) => b.id
			)
		).toEqual(['plain']);
	});

	// Muting is applied after every adding layer, so a book named twice still goes: a
	// subtraction that ran earlier would be undone by whichever layer came after it.
	test('a mute outranks every layer that names the book', () => {
		const books = shelf({ id: 'both', global: true });
		expect(
			resolveLorebookLinks(books, links({ cards: ['both'], chat: ['both'], muted: ['both'] }))
		).toEqual([]);
	});

	test('muting a book nothing brings changes nothing', () => {
		const books = shelf({ id: 'world', global: true });
		expect(
			resolveLorebookLinks(books, links({ muted: ['gone', 'never-linked'] })).map((b) => b.id)
		).toEqual(['world']);
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

describe('lorebookDeleteMessage', () => {
	const book = (name: string, entries: number) => ({
		name,
		entries: Array.from({ length: entries }, () => ({}) as never)
	});

	test('names the book and what goes with it', () => {
		expect(lorebookDeleteMessage(book('Kaldoria', 12), 0)).toBe(
			'Delete "Kaldoria" and its 12 entries? This cannot be undone.'
		);
	});

	test('an empty book holds nothing, so it says nothing about entries', () => {
		expect(lorebookDeleteMessage(book('Kaldoria', 0), 0)).toBe(
			'Delete "Kaldoria"? This cannot be undone.'
		);
	});

	test('a nameless book is named the way every list names it', () => {
		expect(lorebookDeleteMessage(book('', 1), 0)).toBe(
			'Delete "Untitled lorebook" and its 1 entry? This cannot be undone.'
		);
	});

	// Nothing links a global book, so the bound clause alone would report the widest loss on
	// the shelf as a book nobody was using.
	test('a book in every chat says so, linked or not', () => {
		expect(lorebookDeleteMessage({ ...book('Kaldoria', 2), global: true }, 0)).toBe(
			'Delete "Kaldoria" and its 2 entries? It is in every chat. This cannot be undone.'
		);
		expect(lorebookDeleteMessage({ ...book('Kaldoria', 2), global: true }, 1)).toBe(
			'Delete "Kaldoria" and its 2 entries? It is in every chat. It is bound to 1 character or persona. This cannot be undone.'
		);
	});

	// The half that decides whether the reader stops: both surfaces have to say it, and both
	// have to say it in English on either side of one.
	test('says who carries it, singular and plural', () => {
		expect(lorebookDeleteMessage(book('Kaldoria', 2), 1)).toBe(
			'Delete "Kaldoria" and its 2 entries? It is bound to 1 character or persona. This cannot be undone.'
		);
		expect(lorebookDeleteMessage(book('Kaldoria', 2), 3)).toBe(
			'Delete "Kaldoria" and its 2 entries? It is bound to 3 characters or personas. This cannot be undone.'
		);
	});
});

/**
 * The one wording of a strip's collapsed line, read by the open book's Activation strip and
 * by the shelf's Global Settings row. What is locked here is which parts are LIT: the mark
 * means "this departs from what it would inherit", so the root layer marks nothing and a
 * value that has nothing to act on is never sold as a difference.
 */
describe('activationSummary', () => {
	const globals = DEFAULT_LOREBOOK_GLOBAL_SETTINGS;
	const resolvedOf = (over: Partial<typeof globals> = {}) => ({ ...globals, ...over });
	const lit = (parts: { text: string; set: boolean }[]) =>
		parts.filter((p) => p.set).map((p) => p.text);

	test('the defaults against themselves light nothing: the root has nothing to differ from', () => {
		expect(lit(activationSummary(globals, globals))).toEqual([]);
	});

	test('a book lights only what it departs from', () => {
		const parts = activationSummary(resolvedOf({ scanDepth: 12 }), globals);
		expect(lit(parts)).toEqual(['scan 12']);
	});

	test('0 reads as the whole chat, and an uncapped recursion as endless', () => {
		const parts = activationSummary(resolvedOf({ scanDepth: 0 }), globals).map((p) => p.text);
		expect(parts).toContain('scan all');
		expect(parts).toContain('∞ passes');
	});

	test('recursion off takes the pass count off the line entirely', () => {
		const parts = activationSummary(resolvedOf({ recursiveScanning: false }), globals).map(
			(p) => p.text
		);
		expect(parts).toEqual([
			`scan ${globals.scanDepth}`,
			'recursion off',
			'case off',
			'whole words on',
			'budget off'
		]);
	});

	// The switch that puts a book in every chat lives inside the Activation strip, so the
	// folded line is the only place it shows: leave it off and the widest state a book can be
	// in is hidden behind one press. It leads, and the shelf's own row can never carry it.
	test('a book in every chat says so first, and the defaults never do', () => {
		const parts = activationSummary(resolvedOf(), globals, true);
		expect(parts[0]).toEqual({ text: 'every chat', set: true });
		expect(activationSummary(globals, globals).map((p) => p.text)).not.toContain('every chat');
	});

	// While books recurse together there is ONE loop, so a book's own cap runs nothing: the
	// line prints the global number and refuses to mark it, or the strip would name a cap the
	// scan never reaches for.
	test('books recursing together print the global cap, unlit', () => {
		const crossing = { ...globals, crossBookRecursion: true, maxRecursionSteps: 3 };
		const parts = activationSummary(resolvedOf({ maxRecursionSteps: 9 }), crossing);
		expect(parts.map((p) => p.text)).toContain('≤3 passes');
		expect(lit(parts)).toEqual([]);
	});
});
