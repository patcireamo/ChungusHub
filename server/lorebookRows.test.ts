/**
 * What a lorebook ROW does on the way in and out of the real database (bun:sqlite), which is
 * the half no client-side fake can answer honestly.
 *
 * Two failures this file exists to stop, both of which cost the reader work they can still see
 * on screen. A write aimed at a book another device deleted has to throw: `UPDATE … WHERE id`
 * changes nothing and reports nothing, and in `transferEntries` a silent destination write is
 * the step after which the source is cut and both copies of the entries are gone. And a row
 * whose payload will not parse has to cost its own book and nothing else: the shelf reads every
 * book and so does every send, so one unreadable row taking `getAllLorebooks` down is a library
 * with no books and an install that cannot generate.
 *
 * Same env dance as lorebookCover.test.ts: CHUNGUS_DATA_DIR is pinned to a mkdtemp dir before
 * the first db call and the handle is released at both ends, so nothing can reach user-data/.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let serverDb: any;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-lorebook-rows-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('./db'));
	// One handle per process, bound on first use (see server/db.ts). Release whatever an
	// earlier file left open so this file's first db call binds to the dir above.
	serverDb.closeForTests();
});

afterAll(() => {
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort: Windows may still hold the file */
	}
});

function book(id: string, over: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		id,
		name: id,
		scanDepth: null,
		recursiveScanning: null,
		maxRecursionSteps: null,
		caseSensitive: null,
		matchWholeWords: null,
		entries: [],
		extensions: {},
		createdAt: now,
		updatedAt: now,
		...over
	};
}

const entry = (comment: string, over: Record<string, unknown> = {}) => ({
	id: `e-${comment}`,
	comment,
	key: [],
	keysecondary: [],
	selectiveLogic: 0,
	content: 'lore',
	constant: false,
	disable: false,
	order: 100,
	probability: 100,
	useProbability: true,
	caseSensitive: null,
	matchWholeWords: null,
	rest: {},
	...over
});

/** A row the app itself can never write, which is the only way to reach the torn-payload path. */
function insertTornRow(id: string): void {
	serverDb.execute('INSERT INTO lorebooks (id, data_json, created_at, updated_at) VALUES (?,?,?,?)', [
		id,
		'{not json',
		1,
		1
	]);
}

describe('a write aimed at a row that is gone (architecture/lorebook.md)', () => {
	test('updating a deleted book throws instead of reporting nothing', () => {
		serverDb.insertLorebook(book('b-gone', { entries: [entry('A'), entry('B')] }));
		serverDb.deleteLorebook('b-gone');
		expect(serverDb.getLorebook('b-gone')).toBeNull();
		expect(() => serverDb.updateLorebook(book('b-gone', { entries: [entry('A')] }))).toThrow();
		expect(serverDb.getLorebook('b-gone')).toBeNull();
	});

	// The delete is the one act with nothing left to fail: two devices pressing it is ordinary.
	test('deleting a book that is already gone is a quiet no-op', () => {
		expect(() => serverDb.deleteLorebook('never-existed')).not.toThrow();
	});

	// The other direction, and the loud one: an id that lands twice would merge two books into
	// one row, taking the entries of whichever wrote second.
	test('inserting an id the shelf already holds throws', () => {
		serverDb.insertLorebook(book('b-dupe'));
		expect(() => serverDb.insertLorebook(book('b-dupe', { name: 'Impostor' }))).toThrow();
		expect(serverDb.getLorebook('b-dupe').name).toBe('b-dupe');
	});
});

describe('what the payload whitelist carries (architecture/lorebook.md)', () => {
	// Entries are stored as opaque JSON, which is why only a BOOK-level field needs naming.
	test('a per-entry field the server has never heard of rides through whole', () => {
		serverDb.insertLorebook(
			book('b-fields', {
				entries: [entry('A', { someFutureField: { deep: [1, 2] }, keyRules: { a: { mode: 'word' } } })]
			})
		);
		const back = serverDb.getLorebook('b-fields');
		expect(back.entries[0].someFutureField).toEqual({ deep: [1, 2] });
		expect(back.entries[0].keyRules).toEqual({ a: { mode: 'word' } });
	});

	// The failure the doc warns about, pinned: the client sends the book whole, so a key the
	// write does not name round-trips fine in the tab that set it and is gone on the next load.
	test('a book-level field the whitelist does not name is dropped on the first write', () => {
		serverDb.insertLorebook(book('b-unknown', { someNewBookField: 'lost' }));
		expect('someNewBookField' in serverDb.getLorebook('b-unknown')).toBe(false);
	});

	test('the row timestamps are the server\'s, never the client\'s claim', () => {
		serverDb.insertLorebook(book('b-stamp', { createdAt: 1000, updatedAt: 1000 }));
		expect(serverDb.getLorebook('b-stamp').createdAt).toBe(1000);
		serverDb.updateLorebook({ ...serverDb.getLorebook('b-stamp'), updatedAt: 1000, name: 'renamed' });
		expect(serverDb.getLorebook('b-stamp').updatedAt).toBeGreaterThan(1000);
	});
});

describe('a payload that will not parse (architecture/lorebook.md)', () => {
	test('one torn row costs its own book and nothing else', () => {
		serverDb.insertLorebook(book('b-ok', { entries: [entry('A')] }));
		insertTornRow('b-torn');
		try {
			const shelf = serverDb.getAllLorebooks() as { id: string }[];
			expect(shelf.some((b) => b.id === 'b-ok')).toBe(true);
			expect(shelf.some((b) => b.id === 'b-torn')).toBe(false);
			expect(serverDb.getLorebook('b-torn')).toBeNull();
		} finally {
			// Always swept, or the torn row is served to every case after this one.
			serverDb.execute('DELETE FROM lorebooks WHERE id = ?', ['b-torn']);
		}
	});

	test('the stats screen counts it without reading it', () => {
		insertTornRow('b-torn-2');
		try {
			expect(() => serverDb.getUserStats()).not.toThrow();
		} finally {
			serverDb.execute('DELETE FROM lorebooks WHERE id = ?', ['b-torn-2']);
		}
	});

	// The delete reads the row first, to sweep the cover. Leaving it unreadable there would make
	// a torn book the one thing in the app that cannot be got rid of through the app.
	test('a torn book can still be deleted through the app\'s own door', () => {
		insertTornRow('b-torn-3');
		expect(() => serverDb.deleteLorebook('b-torn-3')).not.toThrow();
		expect(serverDb.getLorebook('b-torn-3')).toBeNull();
	});
});

describe('the order the shelf comes back in', () => {
	// The premise the resolver's own sort answers to: this order MOVES under an edit, so the
	// globals are laid down by creation instead (architecture/lorebook.md coupling 1). The
	// layers under them read their own id arrays, so nothing else depends on it.
	test('getAllLorebooks is most-recently-written first, which is not creation order', () => {
		serverDb.insertLorebook(book('o-first', { createdAt: 1, updatedAt: 1 }));
		serverDb.insertLorebook(book('o-second', { createdAt: 2, updatedAt: 2 }));
		const ids = () =>
			(serverDb.getAllLorebooks() as { id: string }[]).filter((b) => b.id.startsWith('o-')).map((b) => b.id);
		expect(ids()).toEqual(['o-second', 'o-first']);
		serverDb.updateLorebook({ ...serverDb.getLorebook('o-first'), name: 'touched' });
		expect(ids()).toEqual(['o-first', 'o-second']);
	});
});
