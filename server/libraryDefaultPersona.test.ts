/**
 * The persona new chats with a character start as, against the REAL server database
 * (bun:sqlite).
 *
 * The claim under test is a storage claim and it has two halves. It rides BESIDE `data` in
 * the entry payload, so it never mirrors into a version row and never reaches a card export;
 * and it is written only when set, so an entry that never carries one stores byte for byte
 * what it stored before the field existed, which is why none of this needs a migration.
 *
 * Same env dance as greetingRefresh.test.ts: CHUNGUS_DATA_DIR is pinned to a throwaway dir
 * before the first db call, so no test can silently write into the real user-data.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let serverDb: any;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-default-persona-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('./db'));
	serverDb.closeForTests();
});

afterAll(() => {
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

let clock = 1_700_000_000_000;

function makeCharacter(extra: Record<string, unknown> = {}): Record<string, unknown> {
	clock += 1000;
	return {
		id: crypto.randomUUID(),
		type: 'character',
		identity: { name: 'Aria', tags: [] },
		data: { traits: { description: 'A sharp-tongued sorceress.', firstMessage: 'Hello.' } },
		isFavorite: false,
		createdAt: clock,
		updatedAt: clock,
		...extra
	};
}

/** The entry as every reader gets it: the stored payload spread over the row's own columns.
 *  A key that reaches here reached the payload, which is what these claims are about. */
function readBack(id: string): Record<string, unknown> {
	return serverDb.getLibraryEntry(id) as Record<string, unknown>;
}

describe('defaultPersonaId', () => {
	test('an entry that carries none stores no key at all', () => {
		// Not merely falsy: a stored `null` would be a payload byte that was not there
		// before the field existed, on every character in every install.
		const entry = makeCharacter();
		serverDb.insertLibraryEntry(entry);
		expect('defaultPersonaId' in readBack(entry.id as string)).toBe(false);

		serverDb.updateLibraryEntry(entry);
		expect('defaultPersonaId' in readBack(entry.id as string)).toBe(false);
	});

	test('a set seed round-trips as a sibling of data, never inside it', () => {
		const personaId = crypto.randomUUID();
		const entry = makeCharacter({ defaultPersonaId: personaId });
		serverDb.insertLibraryEntry(entry);

		const read = readBack(entry.id as string);
		expect(read.defaultPersonaId).toBe(personaId);
		expect(read.data).not.toHaveProperty('defaultPersonaId');
	});

	test('clearing it drops the key rather than storing an empty one', () => {
		const entry = makeCharacter({ defaultPersonaId: crypto.randomUUID() });
		serverDb.insertLibraryEntry(entry);

		delete entry.defaultPersonaId;
		serverDb.updateLibraryEntry(entry);
		expect('defaultPersonaId' in readBack(entry.id as string)).toBe(false);
	});

	test('it never reaches the version row the entry data is mirrored into', () => {
		// A version row is one variant's content. Who the story is played by is not a
		// property of a variant, so a fork or a switch must never carry this along.
		const versionId = crypto.randomUUID();
		const entry = makeCharacter({ activeVersionId: versionId, defaultPersonaId: crypto.randomUUID() });
		serverDb.insertLibraryEntry(entry);
		serverDb.insertCharacterVersion({
			id: versionId,
			entryId: entry.id,
			name: 'base',
			data: entry.data,
			createdAt: clock,
			updatedAt: clock
		});

		serverDb.updateLibraryEntry(entry);
		const version = serverDb.getCharacterVersion(versionId) as { data: Record<string, unknown> };
		expect(version.data).not.toHaveProperty('defaultPersonaId');
	});
});
