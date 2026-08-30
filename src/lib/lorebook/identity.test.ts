/**
 * Book identity tests. Run with `bun test`.
 *
 * The load-bearing claim is the one in the middle: a book SillyTavern keeps as a `worlds/` file
 * AND embeds in a card is ONE book, and this has to say so across the two shapes it arrives in.
 * Fail that and importing a profile shelves the same book once per card that uses it, which is
 * exactly what this exists to stop.
 */

import { describe, expect, test } from 'bun:test';

import { bookFingerprint, createBookIndex } from './identity';
import { parseLorebook, toCharacterBook, toNativeWorldInfo } from './sillytavern';
import { createEmptyLorebook } from './types';

/** The same book, written the two ways SillyTavern writes it. */
const NATIVE = {
	name: 'Kingdom',
	entries: {
		'0': {
			uid: 0,
			key: ['dragon', 'wyrm'],
			keysecondary: ['fire'],
			comment: 'The Dragon',
			content: 'A great red wyrm.',
			constant: false,
			disable: false,
			order: 50,
			displayIndex: 0
		},
		'1': {
			uid: 1,
			key: ['tower'],
			keysecondary: [],
			comment: 'The Tower',
			content: 'An arcane spire.',
			constant: true,
			disable: false,
			order: 20,
			displayIndex: 1
		}
	}
};

const CHARACTER_BOOK = {
	name: 'Kingdom Lorebook',
	entries: [
		{
			keys: ['tower'],
			secondary_keys: [],
			comment: 'The Tower',
			content: 'An arcane spire.',
			constant: true,
			enabled: true,
			insertion_order: 20
		},
		{
			keys: ['dragon', 'wyrm'],
			secondary_keys: ['fire'],
			comment: 'The Dragon',
			content: 'A great red wyrm.',
			constant: false,
			enabled: true,
			insertion_order: 50
		}
	]
};

describe('bookFingerprint', () => {
	test('reads one book out of both SillyTavern shapes as the same book', () => {
		expect(bookFingerprint(parseLorebook(NATIVE, 'x'))).toBe(
			bookFingerprint(parseLorebook(CHARACTER_BOOK, 'y')) as string
		);
	});

	// The name is the one thing the two shapes disagree about for the same book: a world file is
	// named after itself, a card's copy after the character carrying it.
	test('ignores what each side calls the book', () => {
		const book = parseLorebook(NATIVE, 'x');
		const renamed = { ...book, name: 'Something else entirely' };
		expect(bookFingerprint(renamed)).toBe(bookFingerprint(book) as string);
	});

	test('ignores the order the entries are stored in', () => {
		const book = parseLorebook(NATIVE, 'x');
		const reversed = { ...book, entries: [...book.entries].reverse() };
		expect(bookFingerprint(reversed)).toBe(bookFingerprint(book) as string);
	});

	test('survives a round trip out through either exporter and back', () => {
		const book = parseLorebook(NATIVE, 'x');
		const print = bookFingerprint(book);
		expect(bookFingerprint(parseLorebook(toNativeWorldInfo(book), 'x'))).toBe(print as string);
		expect(bookFingerprint(parseLorebook(toCharacterBook(book), 'x'))).toBe(print as string);
	});

	test('separates books that differ in what they say or in what wakes them', () => {
		const book = parseLorebook(NATIVE, 'x');
		const print = bookFingerprint(book) as string;

		const edited = structuredClone(book);
		edited.entries[0].content = 'A great BLUE wyrm.';
		expect(bookFingerprint(edited)).not.toBe(print);

		const rekeyed = structuredClone(book);
		rekeyed.entries[0].key = ['drake'];
		expect(bookFingerprint(rekeyed)).not.toBe(print);

		const retitled = structuredClone(book);
		retitled.entries[0].comment = 'The Other Dragon';
		expect(bookFingerprint(retitled)).not.toBe(print);

		// Same words, different behaviour: an always-on variant is not the keyword one.
		const flagged = structuredClone(book);
		flagged.entries[0].constant = !flagged.entries[0].constant;
		expect(bookFingerprint(flagged)).not.toBe(print);

		const switchedOff = structuredClone(book);
		switchedOff.entries[0].disable = true;
		expect(bookFingerprint(switchedOff)).not.toBe(print);

		const reordered = structuredClone(book);
		reordered.entries[0].order = 999;
		expect(bookFingerprint(reordered)).not.toBe(print);
	});

	test('separates a book from a shorter one that shares its entries', () => {
		const book = parseLorebook(NATIVE, 'x');
		const trimmed = { ...book, entries: book.entries.slice(0, 1) };
		expect(bookFingerprint(trimmed)).not.toBe(bookFingerprint(book) as string);
	});

	// Nothing identifies an empty book, so it can only ever be itself: two of them are two books.
	test('answers null for a book with no entries', () => {
		expect(bookFingerprint(createEmptyLorebook('Empty'))).toBeNull();
	});
});

describe('createBookIndex', () => {
	test('finds a book already on the shelf, whichever shape the new one arrived in', () => {
		const shelved = parseLorebook(NATIVE, 'x');
		const index = createBookIndex([shelved]);
		expect(index.same(parseLorebook(CHARACTER_BOOK, 'y'))).toBe(shelved.id);
	});

	test('says nothing about a book it has not seen', () => {
		const index = createBookIndex([parseLorebook(NATIVE, 'x')]);
		const other = parseLorebook(NATIVE, 'x');
		other.entries[0].content = 'Something else.';
		expect(index.same(other)).toBeNull();
	});

	test('never answers for an empty book, even against another empty one', () => {
		const index = createBookIndex([createEmptyLorebook('One')]);
		expect(index.same(createEmptyLorebook('Two'))).toBeNull();
	});

	test('binds a SillyTavern world name to the book it named, case and space blind', () => {
		const index = createBookIndex([]);
		index.bindWorldName('Kingdom', 'book-1');
		expect(index.byWorldName('kingdom')).toBe('book-1');
		expect(index.byWorldName('  KINGDOM ')).toBe('book-1');
		expect(index.byWorldName('Other')).toBeNull();
	});

	test('grows as a run lands books, so the second card meets the first one', () => {
		const index = createBookIndex([]);
		const landed = parseLorebook(NATIVE, 'x');
		expect(index.same(landed)).toBeNull();
		index.add(landed);
		expect(index.same(parseLorebook(CHARACTER_BOOK, 'y'))).toBe(landed.id);
	});

	// Every earlier link points at the first one, so answering with a later copy would scatter
	// links across rows that say the same thing.
	test('answers with the first of two identical books it was given', () => {
		const first = parseLorebook(NATIVE, 'x');
		const second = parseLorebook(NATIVE, 'x');
		const index = createBookIndex([first, second]);
		expect(index.same(parseLorebook(CHARACTER_BOOK, 'y'))).toBe(first.id);
	});
});
