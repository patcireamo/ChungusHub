/**
 * Recognising a book that is already here.
 *
 * SillyTavern keeps one shared book as a file under `worlds/` AND embedded in the
 * `character_book` of every card that uses it, so an import meets the same book many times over
 * (architecture/sillytavern-interchange.md). Two answers, in that order: the world name a card
 * links to, which SillyTavern itself wrote on both sides, then the book's own substance.
 *
 * **Every judgement here favours a miss over a hit.** A miss costs one duplicate book; a false
 * hit binds a character to somebody else's book and drops the one that arrived, and there is no
 * way back from that.
 */
import type { Lorebook, LorebookEntry } from './types';

/**
 * One entry's substance: what it says, what wakes it, and whether it is on.
 *
 * Every field here is one both entry parsers land on identically, defaults included, which is
 * what makes a book recognisable across the two shapes it travels in.
 */
function entryPrint(entry: LorebookEntry): string {
	return JSON.stringify([
		entry.comment,
		[...entry.key].sort(),
		[...entry.keysecondary].sort(),
		entry.content,
		entry.constant,
		entry.disable,
		entry.order
	]);
}

/**
 * What identifies a book, or **null** for one with no entries.
 *
 * The name is left out on purpose: the same book is called one thing as a world file and
 * another inside the card carrying it. An empty book is identified by nothing, so it can only
 * ever be itself.
 */
export function bookFingerprint(book: Lorebook): string | null {
	if (book.entries.length === 0) return null;
	return JSON.stringify(book.entries.map(entryPrint).sort());
}

/** SillyTavern world names are matched the way filenames are: trimmed and case-blind. */
function nameKey(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * The books an import may bind to instead of copying. Built when a run starts and grown as it
 * lands books, so a book edited since the last import fingerprints as what it says now.
 */
export interface BookIndex {
	/** The book a SillyTavern world name binds to, or null. */
	byWorldName(name: string): string | null;
	/** A book already here that says the same thing, or null. */
	same(book: Lorebook): string | null;
	/** A book that just landed, so the rest of the run can bind to it. */
	add(book: Lorebook): void;
	/** Bind a SillyTavern world name to a book, for a world file this run or an earlier one
	 *  brought over. */
	bindWorldName(name: string, bookId: string): void;
}

export function createBookIndex(books: Lorebook[]): BookIndex {
	const byPrint = new Map<string, string>();
	const byName = new Map<string, string>();

	const index: BookIndex = {
		byWorldName(name) {
			return byName.get(nameKey(name)) ?? null;
		},
		same(book) {
			const print = bookFingerprint(book);
			return print ? (byPrint.get(print) ?? null) : null;
		},
		add(book) {
			const print = bookFingerprint(book);
			// First one wins: two identical books already on the shelf are one answer, and the
			// older of them is the one every earlier link already points at.
			if (print && !byPrint.has(print)) byPrint.set(print, book.id);
		},
		bindWorldName(name, bookId) {
			const key = nameKey(name);
			if (key) byName.set(key, bookId);
		}
	};

	for (const book of books) index.add(book);
	return index;
}
