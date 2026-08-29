/**
 * Per-character override defaults (`LibraryEntry.overrides`), against the REAL server database.
 *
 * Three defaults share the one key: `personaId`, `connectionId` and `presetId`. They are one
 * object rather than three because they have one lifetime and one storage rule, and every
 * claim below holds for each of them.
 *
 * `overrides` is stored as a third top-level key in `character_library.data_json`, beside
 * `identity` and `data` (see `libraryPayload`). That placement is the whole design and it is
 * what these tests hold:
 *
 *  - it round-trips, so a default survives the column it lives in;
 *  - a character that has never carried one writes byte-for-byte the payload it wrote before
 *    the feature existed, so nothing already on disk is rewritten by merely being saved;
 *  - it never reaches a version row, because only `data` is mirrored there. A default is a
 *    property of the character, not of one variant of it, and a fork must not inherit a stale
 *    one.
 *
 * Same env dance as personaFloor.test.ts: CHUNGUS_DATA_DIR is pinned to a throwaway dir before
 * the first db call, so no test can silently write into the real user-data.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let serverDb: any;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-overrides-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('./db'));
	// One handle per process, bound on first use (see server/db.ts). Release whatever an
	// earlier file left open so this file's first db call binds to the dir above.
	serverDb.closeForTests();
});

afterAll(() => {
	// Release before deleting: statements against an unlinked file fail for the rest of the run.
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

let clock = 1_700_000_000_000;

type Entry = {
	id: string;
	type: string;
	identity: { name: string };
	data: { traits: { description: string } };
	activeVersionId?: string;
	overrides?: Overrides;
	isFavorite: boolean;
	createdAt: number;
	updatedAt: number;
};

/** All three per-character defaults, which share one key and one set of rules. */
type Overrides = { personaId?: string; connectionId?: string; presetId?: string };

function makeCharacter(name: string, overrides?: Overrides): Entry {
	const id = crypto.randomUUID();
	const entry: Entry = {
		id,
		type: 'character',
		identity: { name },
		data: { traits: { description: `${name} is here.` } },
		isFavorite: false,
		createdAt: (clock += 1000),
		updatedAt: clock
	};
	if (overrides) entry.overrides = overrides;
	serverDb.insertLibraryEntry(entry);
	return entry;
}

function read(id: string): Entry {
	return serverDb.getLibraryEntry(id) as Entry;
}

/** The raw stored payload, which is what the placement claims are actually about. */
function storedPayload(id: string): Record<string, unknown> {
	const entry = read(id);
	// Round-tripping through the mapper would hide a key the column never held, so rebuild
	// what the column stores from what the mapper handed back: everything but the row's own
	// columns is what `libraryPayload` wrote.
	const { id: _id, type: _type, isFavorite: _fav, createdAt: _c, updatedAt: _u, ...payload } = entry;
	return payload;
}

describe('per-character overrides: storage', () => {
	test('a default round-trips through the column it is stored in', () => {
		const entry = makeCharacter('Kasumi', { personaId: 'persona-mai' });
		expect(read(entry.id).overrides).toEqual({ personaId: 'persona-mai' });
	});

	test('a character carrying none stores no key at all', () => {
		// The upgrade path in both directions: an entry written before this existed reads
		// back with `overrides` absent rather than as an empty object, and an entry written
		// now without one is indistinguishable from it. Nothing on disk is rewritten by a
		// save that had nothing to say about overrides.
		const entry = makeCharacter('Plain');
		expect(read(entry.id).overrides).toBeUndefined();
		expect('overrides' in storedPayload(entry.id)).toBe(false);
	});

	test('a default is added, changed and removed by an ordinary entry save', () => {
		const entry = makeCharacter('Rin');
		expect(read(entry.id).overrides).toBeUndefined();

		serverDb.updateLibraryEntry({ ...entry, overrides: { personaId: 'persona-mai' } });
		expect(read(entry.id).overrides).toEqual({ personaId: 'persona-mai' });

		serverDb.updateLibraryEntry({ ...entry, overrides: { personaId: 'persona-polka' } });
		expect(read(entry.id).overrides).toEqual({ personaId: 'persona-polka' });

		// The client drops the key rather than writing an empty object (characterLibrary's
		// updateOverrides), and the payload has to follow it all the way out of the column.
		serverDb.updateLibraryEntry({ ...entry, overrides: undefined });
		expect(read(entry.id).overrides).toBeUndefined();
		expect('overrides' in storedPayload(entry.id)).toBe(false);
	});

	test('an id naming nothing is stored as written, not validated away', () => {
		// Deliberate. The fall-through happens at resolve time on the client
		// (stores/chatPersona.svelte.ts) so that a persona deleted on one device cannot
		// silently rewrite character cards on another.
		const entry = makeCharacter('Dangling', { personaId: 'persona-that-never-existed' });
		expect(read(entry.id).overrides).toEqual({ personaId: 'persona-that-never-existed' });
	});
});

describe('per-character overrides: all three defaults share the one key', () => {
	test('a card can carry persona, connection and preset defaults at once', () => {
		const entry = makeCharacter('Full house', {
			personaId: 'persona-mai',
			connectionId: 'conn-local',
			presetId: 'preset-standard'
		});
		expect(read(entry.id).overrides).toEqual({
			personaId: 'persona-mai',
			connectionId: 'conn-local',
			presetId: 'preset-standard'
		});
	});

	test('one default is removed without disturbing the others', () => {
		// The client merges and drops undefined keys (characterLibrary's updateOverrides), so
		// what reaches the column is the surviving subset. Clearing one must not take the
		// object with it while another still holds something.
		const entry = makeCharacter('Partial', { personaId: 'persona-mai', presetId: 'preset-standard' });
		serverDb.updateLibraryEntry({ ...entry, overrides: { presetId: 'preset-standard' } });
		expect(read(entry.id).overrides).toEqual({ presetId: 'preset-standard' });
		expect('overrides' in storedPayload(entry.id)).toBe(true);
	});

	test('the key goes only once the LAST default does', () => {
		const entry = makeCharacter('Emptying', { connectionId: 'conn-local' });
		serverDb.updateLibraryEntry({ ...entry, overrides: undefined });
		expect(read(entry.id).overrides).toBeUndefined();
		expect('overrides' in storedPayload(entry.id)).toBe(false);
	});

	test('none of the three is validated on the way in', () => {
		// Same rule as the persona case above, for the same reason: a connection or preset
		// deleted on one device must not silently rewrite character cards on another. All
		// three fall one layer down at resolve time instead (types/chat.ts resolveOverrideId).
		const entry = makeCharacter('All dangling', {
			personaId: 'gone-persona',
			connectionId: 'gone-connection',
			presetId: 'gone-preset'
		});
		expect(read(entry.id).overrides).toEqual({
			personaId: 'gone-persona',
			connectionId: 'gone-connection',
			presetId: 'gone-preset'
		});
	});
});

describe('per-character overrides: not versioned', () => {
	test('a default never reaches the active version row', () => {
		// `updateLibraryEntry` mirrors the entry's `data` into its active version row. A
		// default living beside `data` rather than inside it is the whole reason it stays
		// out of that mirror, so a fork cannot carry a stale one.
		const entry = makeCharacter('Versioned');
		const versionId = crypto.randomUUID();
		serverDb.insertCharacterVersion({
			id: versionId,
			entryId: entry.id,
			name: 'base',
			data: entry.data,
			createdAt: (clock += 1000),
			updatedAt: clock
		});
		serverDb.updateLibraryEntry({
			...entry,
			activeVersionId: versionId,
			overrides: { personaId: 'persona-mai' }
		});

		const version = serverDb.getCharacterVersion(versionId) as { data: Record<string, unknown> };
		expect(read(entry.id).overrides).toEqual({ personaId: 'persona-mai' });
		expect('overrides' in version.data).toBe(false);
		expect(version.data).toEqual(entry.data);
	});
});
