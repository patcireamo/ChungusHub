/**
 * What a lorebook's cover survives, against the REAL server database (bun:sqlite).
 *
 * Two silent-data failures this file exists to prevent, both of which cost somebody a picture
 * they uploaded with nothing on screen admitting it. `insertLorebook`/`updateLorebook` store
 * an explicit key list, so a field they forget to name round-trips fine in the tab that set it
 * and is gone the moment any device reloads. And the cover file is swept by `deleteLorebook`
 * itself rather than by either of its two callers, so a book that goes must take its file.
 *
 * Same env dance as messageLorebook.test.ts: CHUNGUS_DATA_DIR is pinned to a throwaway dir
 * before the first db call, so no test can silently write into the real user-data.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let serverDb: any;
/**
 * Where `deleteImage` will actually look, which is NOT the dir this file pinned. The database
 * rebinds per test file and this const does not: in the suite it holds whichever dir the first
 * file to import config pinned, so assuming our own would pass alone and fail together. Same
 * reason `defaultCharacters.test.ts` reads it (architecture/testing.md).
 */
let coverDir: string;
const written: string[] = [];

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-lorebook-cover-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('./db'));
	const { IMAGES_ROOT } = await import('./config');
	coverDir = join(IMAGES_ROOT, 'lorebooks');
	// One handle per process, bound on first use (see server/db.ts). Release whatever an
	// earlier file left open so this file's first db call binds to the dir above.
	serverDb.closeForTests();
});

afterAll(() => {
	// Release before deleting: statements against an unlinked file fail for the rest of the run.
	serverDb.closeForTests();
	for (const path of written) {
		try {
			rmSync(path, { force: true });
		} catch {
			/* best effort */
		}
	}
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

const FOCUS = { x: 0.32, y: 0.18, zoom: 1.4 };

/** A stored picture, written where `images/lorebooks/<file>` resolves to. */
function writeCover(name: string): string {
	mkdirSync(coverDir, { recursive: true });
	const abs = join(coverDir, name);
	writeFileSync(abs, 'not really a png');
	written.push(abs);
	return `images/lorebooks/${name}`;
}

function book(id: string, over: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		id,
		name: 'Eldoria',
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

describe('a lorebook cover (architecture/lorebook.md)', () => {
	test('the picture and its framing survive an insert', () => {
		const cover = writeCover('inserted.png');
		serverDb.insertLorebook(book('b-insert', { cover, coverFocus: FOCUS }));
		const back = serverDb.getLorebook('b-insert');
		expect(back.cover).toBe(cover);
		expect(back.coverFocus).toEqual(FOCUS);
	});

	// The client sends the book whole, so every write is a rewrite of the payload: a cover the
	// reader never touched has to ride out on the save that renamed the book.
	test('a write that only renames the book carries them along', () => {
		const cover = writeCover('renamed.png');
		serverDb.insertLorebook(book('b-rename', { cover, coverFocus: FOCUS }));
		const loaded = serverDb.getLorebook('b-rename');
		serverDb.updateLorebook({ ...loaded, name: 'Eldoria, revised' });
		const back = serverDb.getLorebook('b-rename');
		expect(back.name).toBe('Eldoria, revised');
		expect(back.cover).toBe(cover);
		expect(back.coverFocus).toEqual(FOCUS);
	});

	// A book nobody put a picture on must leave a bare row, the same rule an unframed portrait
	// follows: absent is what every book made before covers existed carries.
	test('a book with no cover stores neither key', () => {
		serverDb.insertLorebook(book('b-bare'));
		const back = serverDb.getLorebook('b-bare');
		expect('cover' in back).toBe(false);
		expect('coverFocus' in back).toBe(false);
	});

	test('deleting the book deletes its picture', () => {
		const cover = writeCover('doomed.png');
		serverDb.insertLorebook(book('b-doomed', { cover }));
		serverDb.deleteLorebook('b-doomed');
		expect(serverDb.getLorebook('b-doomed')).toBeNull();
		expect(existsSync(join(coverDir, 'doomed.png'))).toBe(false);
		expect(cover).toBe('images/lorebooks/doomed.png');
	});

	test('deleting a book with no cover is just a delete', () => {
		serverDb.insertLorebook(book('b-plain'));
		expect(() => serverDb.deleteLorebook('b-plain')).not.toThrow();
		expect(serverDb.getLorebook('b-plain')).toBeNull();
	});
});
