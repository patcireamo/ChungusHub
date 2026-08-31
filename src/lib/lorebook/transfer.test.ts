/**
 * Sending entries from one book to another: the store call behind the entry list's Move to…
 * and Copy to… buttons. Run with `bun test`.
 *
 * Two things it must never get wrong, and neither of them shows on screen until it is too
 * late. A copy has to be a copy all the way down, its id included, since sticky and cooldown
 * windows are measured per entry id across every book at once and a scan's records are keyed
 * by it. And a move must write the DESTINATION first, then cut the source: a failure between
 * the two is then a duplicate the reader can see and delete, rather than entries that left
 * one book without ever arriving in the other.
 *
 * The harness is the real store over an in-memory server, so two blocks at the foot ride it for
 * the rest of what a write owes: a book another device deleted takes no writes and says so, and
 * a book of this one's own is deleted with a keystroke still scheduled for it.
 *
 * Runes are compile-time macros and nothing compiles a store under `bun test`, so `$state` is
 * shimmed BEFORE the module loads, the way chat-setup-birth.test.ts does. `$state.snapshot`
 * clones for real rather than returning its argument: the store detaches every entry it hands
 * to another book through it, and an aliasing shim would report two books sharing one object
 * as a pass.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import type { Lorebook, LorebookEntry } from './types';

const identity = <T>(value?: T): T | undefined => value;
(globalThis as unknown as { $state: unknown }).$state = Object.assign(identity, {
	raw: identity,
	snapshot: <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T))
});

const copy = <T>(value: T): T => structuredClone(value);

/** The server: the lorebook rows as the next boot and every other device would read them. */
const rows = new Map<string, Lorebook>();
/** The id of the one book whose next write is to fail, for the half-finished-move cases. */
let breakWriteOf: string | null = null;

/**
 * Bun's module registry is process-wide, so the stub is a SPREAD of the real module and the
 * restore is registered before it goes in, where a throw during setup cannot skip it.
 *
 * The shelf is process-wide too: `lorebookStore` is one singleton, and a book this file left
 * standing on it is a book every test file loading afterwards would find there. So it is
 * emptied first, through the stub, and only then is the real module put back.
 */
const realDatabase = { ...(await import('$lib/services/database')) };

afterAll(async () => {
	try {
		rows.clear();
		await lorebookStore.refresh();
	} finally {
		mock.module('$lib/services/database', () => realDatabase);
	}
});

mock.module('$lib/services/database', () => ({
	...realDatabase,
	db: {
		getAllLorebooks: async () => [...rows.values()].map(copy),
		insertLorebook: async (book: Lorebook) => {
			rows.set(book.id, copy(book));
		},
		updateLorebook: async (book: Lorebook) => {
			if (breakWriteOf === book.id) {
				breakWriteOf = null;
				throw new Error('the write failed');
			}
			// The real SQL is `UPDATE … WHERE id = ?`, which changes nothing against a row that
			// is gone and reports nothing about it, so the server turns that silence into a
			// throw (server/db.ts, driven in server/lorebookRows.test.ts). A fake that upserted
			// here would report a destination write landing in a book that no longer exists.
			if (!rows.has(book.id)) throw new Error(`updateLorebook: no lorebook with id ${book.id}`);
			rows.set(book.id, copy(book));
		},
		deleteLorebook: async (id: string) => {
			rows.delete(id);
		}
	}
}));

const { lorebookStore } = await import('./store.svelte');
const { createEmptyLorebook, createEmptyLorebookEntry } = await import('./types');

function entry(comment: string, extra: Partial<LorebookEntry> = {}): LorebookEntry {
	return { ...createEmptyLorebookEntry(), comment, ...extra };
}

async function book(name: string, entries: LorebookEntry[]): Promise<Lorebook> {
	const fresh = { ...createEmptyLorebook(name), entries };
	await lorebookStore.addBook(fresh);
	return lorebookStore.getBook(fresh.id)!;
}

/** What the book holds on screen, and what the server holds. Both are asked every time: a
 *  transfer that only ever happened in memory is exactly the bug worth catching. */
const titles = (id: string): string[] =>
	lorebookStore.getBook(id)!.entries.map((e) => e.comment);
const storedTitles = (id: string): string[] => rows.get(id)!.entries.map((e) => e.comment);
const ids = (id: string): string[] => lorebookStore.getBook(id)!.entries.map((e) => e.id);

beforeEach(async () => {
	rows.clear();
	breakWriteOf = null;
	// The store is one process-wide singleton: re-reading an empty server is what empties it.
	await lorebookStore.refresh();
});

describe('moving entries to another book', () => {
	test('they leave one book, arrive in the other, and keep their own ids', async () => {
		const from = await book('Source', [entry('Alpha'), entry('Beta'), entry('Gamma')]);
		const to = await book('Target', [entry('Kept')]);
		const moving = [from.entries[0].id, from.entries[2].id];

		const landed = await lorebookStore.transferEntries(from.id, to.id, moving, 'move');

		expect(landed).toBe(2);
		expect(titles(from.id)).toEqual(['Beta']);
		expect(titles(to.id)).toEqual(['Kept', 'Alpha', 'Gamma']);
		// The same entries rather than new ones, which is what carries their sticky and
		// cooldown history along with them.
		expect(ids(to.id).slice(1)).toEqual(moving);
		expect(storedTitles(from.id)).toEqual(['Beta']);
		expect(storedTitles(to.id)).toEqual(['Kept', 'Alpha', 'Gamma']);
	});

	test('an id naming nothing is skipped rather than counted', async () => {
		const from = await book('Source', [entry('Alpha')]);
		const to = await book('Target', []);

		const landed = await lorebookStore.transferEntries(
			from.id,
			to.id,
			[from.entries[0].id, crypto.randomUUID()],
			'move'
		);

		expect(landed).toBe(1);
		expect(storedTitles(to.id)).toEqual(['Alpha']);
	});

	test('a selection with nothing live in it writes neither book', async () => {
		const from = await book('Source', [entry('Alpha')]);
		const to = await book('Target', []);
		const before = to.updatedAt;

		expect(await lorebookStore.transferEntries(from.id, to.id, [crypto.randomUUID()], 'move')).toBe(0);
		expect(lorebookStore.getBook(to.id)!.updatedAt).toBe(before);
		expect(storedTitles(from.id)).toEqual(['Alpha']);
	});

	test('a book cannot send entries to itself', async () => {
		const from = await book('Source', [entry('Alpha')]);

		expect(await lorebookStore.transferEntries(from.id, from.id, [from.entries[0].id], 'move')).toBe(0);
		expect(titles(from.id)).toEqual(['Alpha']);
	});
});

describe('copying entries to another book', () => {
	test('both books end up holding them, and the copies are entries of their own', async () => {
		const from = await book('Source', [entry('Alpha')]);
		const to = await book('Target', []);
		const original = from.entries[0].id;

		const landed = await lorebookStore.transferEntries(from.id, to.id, [original], 'copy');

		expect(landed).toBe(1);
		expect(titles(from.id)).toEqual(['Alpha']);
		expect(storedTitles(to.id)).toEqual(['Alpha']);
		// A fresh id, or the two would share one sticky window and collapse into a single
		// record in the trace. The title is NOT marked a copy: it lands in a book that has no
		// entry of that name, so there is nothing to tell it apart from.
		expect(ids(to.id)[0]).not.toBe(original);
	});

	test('the source is left exactly as it was, on the server too', async () => {
		const from = await book('Source', [entry('Alpha')]);
		const to = await book('Target', []);
		const untouched = copy(rows.get(from.id)!);

		await lorebookStore.transferEntries(from.id, to.id, [from.entries[0].id], 'copy');

		expect(rows.get(from.id)).toEqual(untouched);
	});

	test('the copy shares no nested state with the entry it came from', async () => {
		// Entries carry nested maps and arrays (keyRules' rule objects, rest's preserved
		// SillyTavern values). Hand one object to two books and editing either rewrites both,
		// in two different lorebooks, with nothing on screen admitting the link.
		const from = await book('Source', [
			entry('Alpha', {
				key: ['dragon'],
				keyRules: { dragon: { mode: 'word' } },
				rest: { characterFilter: { names: ['Aria'] } }
			})
		]);
		const to = await book('Target', []);

		await lorebookStore.transferEntries(from.id, to.id, [from.entries[0].id], 'copy');

		const landedEntry = lorebookStore.getBook(to.id)!.entries[0];
		landedEntry.key.push('wyvern');
		landedEntry.keyRules!.dragon.mode = 'substring';
		(landedEntry.rest.characterFilter as { names: string[] }).names.push('Kai');

		const source = lorebookStore.getBook(from.id)!.entries[0];
		expect(source.key).toEqual(['dragon']);
		expect(source.keyRules).toEqual({ dragon: { mode: 'word' } });
		expect(source.rest).toEqual({ characterFilter: { names: ['Aria'] } });
	});
});

describe('a write that fails partway', () => {
	test('the destination failing leaves the source holding everything', async () => {
		// The whole reason the destination is written first. The other order would have the
		// entries gone from one book and in neither.
		const from = await book('Source', [entry('Alpha'), entry('Beta')]);
		const to = await book('Target', []);
		breakWriteOf = to.id;

		await expect(
			lorebookStore.transferEntries(from.id, to.id, [from.entries[0].id], 'move')
		).rejects.toThrow();

		expect(titles(from.id)).toEqual(['Alpha', 'Beta']);
		expect(storedTitles(from.id)).toEqual(['Alpha', 'Beta']);
		expect(titles(to.id)).toEqual([]);
		expect(storedTitles(to.id)).toEqual([]);
	});

	test('the cut failing leaves a duplicate rather than a book that disagrees with the server', async () => {
		// The destination is already committed, so the honest state is the same entries in
		// both books, on screen and on disk alike: visible, and one delete away.
		const from = await book('Source', [entry('Alpha')]);
		const to = await book('Target', []);
		breakWriteOf = from.id;

		await expect(
			lorebookStore.transferEntries(from.id, to.id, [from.entries[0].id], 'move')
		).rejects.toThrow();

		expect(titles(from.id)).toEqual(['Alpha']);
		expect(storedTitles(from.id)).toEqual(['Alpha']);
		expect(titles(to.id)).toEqual(['Alpha']);
		expect(storedTitles(to.id)).toEqual(['Alpha']);
	});

	test('a rolled back book does not outrank the server on the next refresh', async () => {
		// `refresh` keeps whichever copy is newer, so a failed write that left its timestamp
		// bumped would have the local phantom win and come true on the next edit.
		const from = await book('Source', [entry('Alpha')]);
		const to = await book('Target', []);
		breakWriteOf = to.id;

		await expect(
			lorebookStore.transferEntries(from.id, to.id, [from.entries[0].id], 'move')
		).rejects.toThrow();
		await lorebookStore.refresh();

		expect(titles(to.id)).toEqual([]);
		expect(titles(from.id)).toEqual(['Alpha']);
	});

	// The same failure arriving from the other device rather than from a broken connection, and
	// the one that would cost the entries outright: a destination write reporting nothing is the
	// step after which the source is cut.
	test('a destination another device deleted keeps the entries in the source', async () => {
		const from = await book('Source', [entry('Alpha'), entry('Beta')]);
		const to = await book('Target', []);
		rows.delete(to.id);

		await expect(
			lorebookStore.transferEntries(from.id, to.id, ids(from.id), 'move')
		).rejects.toThrow();
		await lorebookStore.refresh();

		expect(lorebookStore.books.flatMap((b) => b.entries.map((e) => e.comment)).sort()).toEqual([
			'Alpha',
			'Beta'
		]);
	});

	test('an ordinary edit to a book another device deleted fails loudly', async () => {
		// The cheaper half of the same cause: a write resolving against a row that is gone leaves
		// the keystrokes nowhere while the editor still shows them.
		const target = await book('Notes', [entry('Alpha')]);
		rows.delete(target.id);
		lorebookStore.updateEntry(target.id, target.entries[0].id, { comment: 'edited here' });

		await expect(lorebookStore.flush()).rejects.toThrow();
	});
});

describe('a book on the shelf', () => {
	// The write is debounced, so a delete lands while one is still scheduled. Left standing, the
	// timer writes a book the reader deleted back onto the server.
	test('deleting cancels its pending write instead of resurrecting the row', async () => {
		const doomed = await book('Doomed', [entry('Alpha')]);
		lorebookStore.updateEntry(doomed.id, doomed.entries[0].id, { comment: 'edited' });

		await lorebookStore.deleteBook(doomed.id);
		await lorebookStore.flush();

		expect(rows.has(doomed.id)).toBe(false);
		expect(lorebookStore.getBook(doomed.id)).toBeNull();
	});

	// Off stores as NOTHING, so every book made before the switch existed keeps the row it
	// always had rather than growing a key that says it is not switched on.
	test('the every-chat switch stores as nothing when it goes off', async () => {
		const world = await book('World', []);
		await lorebookStore.setGlobal(world.id, true);
		expect(rows.get(world.id)!.global).toBe(true);

		await lorebookStore.setGlobal(world.id, false);
		expect(rows.get(world.id)!.global).toBeUndefined();
	});
});
