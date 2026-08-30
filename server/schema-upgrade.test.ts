/**
 * What a migration is allowed to do to a database that already holds someone's stories.
 *
 * Restoring an old snapshot is not a special path, it is the upgrade path a user who did not
 * open the app all year would take anyway: the app finds an older `_migrations` and runs
 * whatever is missing. That only stays safe while migrations are structure, so the one that
 * rewrites rows has to be a decision made here rather than something discovered later.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';

import { MIGRATIONS_FOR_TESTS } from './db';

/**
 * The migrations that deliberately rewrite rows. Every entry must be idempotent, must narrow
 * itself with a WHERE to the rows that actually need it, and must be able to state what it
 * would cost if it ran twice.
 */
const DATA_MIGRATIONS: string[] = ['44: backfill_chat_default_version'];

describe('migrations', () => {
	test('a migration only moves data when it was decided here', () => {
		const movers = MIGRATIONS_FOR_TESTS.filter((m) =>
			/\b(UPDATE\s+\w+\s+SET|INSERT\s+INTO|DELETE\s+FROM)\b/i.test(m.sql)
		).map((m) => `${m.version}: ${m.name}`);
		expect(movers).toEqual(DATA_MIGRATIONS);
	});
});

/**
 * The one data migration, driven against real rows in the shape they sit on disk.
 *
 * It runs the schema up to the migration under test, seeds the rows an install would be
 * carrying, and then applies that migration by hand, which is what lets the same statement be
 * run a second time: re-firing is the failure this whole class of change is guarded against,
 * and it cannot be tested through the boot path, where `_migrations` makes a second run
 * impossible by construction.
 */
const BACKFILL = MIGRATIONS_FOR_TESTS.find((m) => m.version === 44)!;

let db: Database;

/** The stored payload as `libraryPayload` writes it: identity + data, and each pointer only
 *  when set, which is why an entry from before these fields simply has no key for them. */
function entry(id: string, type: 'character' | 'persona', payload: Record<string, unknown>): void {
	db.run('INSERT INTO character_library (id, type, data_json, is_favorite, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)', [
		id,
		type,
		JSON.stringify({ identity: { name: id }, data: { traits: {} }, ...payload })
	]);
}

/** An entry whose stored payload is not JSON at all. The library read fails loud on this
 *  row; the migration's job is to leave it exactly as it found it. */
function tornEntry(id: string): void {
	db.run('INSERT INTO character_library (id, type, data_json, is_favorite, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)', [
		id,
		'character',
		'{not json'
	]);
}

function version(id: string, entryId: string): void {
	db.run('INSERT INTO character_versions (id, entry_id, name, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)', [
		id,
		entryId,
		id,
		'{}'
	]);
}

const raw = (id: string): string =>
	(db.query('SELECT data_json FROM character_library WHERE id = ?').get(id) as { data_json: string }).data_json;

const defaultVersionOf = (id: string): unknown => JSON.parse(raw(id)).defaultVersionId;

function runBackfill(): void {
	db.exec(BACKFILL.sql);
}

beforeEach(() => {
	db = new Database(':memory:');
	for (const migration of [...MIGRATIONS_FOR_TESTS].sort((a, b) => a.version - b.version)) {
		if (migration.version >= BACKFILL.version) continue;
		db.exec(migration.sql);
	}
});

afterEach(() => db.close());

describe('44: the chat-default version backfill', () => {
	test('a character that was being played on a fork keeps being played on it', () => {
		// The whole point. Before the seed existed the pin came off `activeVersionId`, so this
		// reader has been getting "Pirate" for months; the seed alone would hand them the
		// first variant ever made and say nothing.
		entry('aria', 'character', { activeVersionId: 'pirate' });
		version('original', 'aria');
		version('pirate', 'aria');

		runBackfill();

		expect(defaultVersionOf('aria')).toBe('pirate');
	});

	test('a row that already names a default is not touched', () => {
		entry('aria', 'character', { activeVersionId: 'pirate', defaultVersionId: 'original' });
		version('original', 'aria');
		version('pirate', 'aria');
		const before = raw('aria');

		runBackfill();

		expect(raw('aria')).toBe(before);
	});

	test('an unversioned character is left byte for byte alone', () => {
		// Nothing to pin: the entry stores exactly what it stored before any of these fields
		// existed, and it has to go on doing that.
		entry('solo', 'character', {});
		const before = raw('solo');

		runBackfill();

		expect(raw('solo')).toBe(before);
	});

	test('an active pointer naming a version that is gone is not revived', () => {
		// Writing that id in would make a default nothing resolves; the seed's own fallback to
		// the first variant is the truer answer.
		entry('aria', 'character', { activeVersionId: 'deleted-one' });
		version('original', 'aria');
		const before = raw('aria');

		runBackfill();

		expect(raw('aria')).toBe(before);
	});

	test('a version belonging to another character does not qualify', () => {
		entry('aria', 'character', { activeVersionId: 'someone-elses' });
		entry('bram', 'character', {});
		version('original', 'aria');
		version('someone-elses', 'bram');
		const before = raw('aria');

		runBackfill();

		expect(raw('aria')).toBe(before);
	});

	test('a persona is never touched', () => {
		entry('reader', 'persona', { activeVersionId: 'pirate' });
		const before = raw('reader');

		runBackfill();

		expect(raw('reader')).toBe(before);
	});

	test('a payload it cannot parse is left alone instead of failing the upgrade', () => {
		// A torn row must not take the boot down with it: json_extract raises on malformed
		// JSON, and the guards are what keep that raise out of the migration.
		tornEntry('torn');
		entry('aria', 'character', { activeVersionId: 'pirate' });
		version('pirate', 'aria');

		expect(() => runBackfill()).not.toThrow();

		expect(raw('torn')).toBe('{not json');
		expect(defaultVersionOf('aria')).toBe('pirate');
	});

	test('running it twice changes nothing the second time', () => {
		entry('aria', 'character', { activeVersionId: 'pirate' });
		entry('solo', 'character', {});
		entry('kept', 'character', { activeVersionId: 'pirate2', defaultVersionId: 'original2' });
		tornEntry('torn');
		version('original', 'aria');
		version('pirate', 'aria');
		version('original2', 'kept');
		version('pirate2', 'kept');

		runBackfill();
		const afterFirst = ['aria', 'solo', 'kept', 'torn'].map(raw);

		runBackfill();

		expect(['aria', 'solo', 'kept', 'torn'].map(raw)).toEqual(afterFirst);
	});
});
