/**
 * What a chat and a character store about who plays the story, against the REAL server
 * database (bun:sqlite).
 *
 * Two storage claims. Each of the character's seeds rides BESIDE `data` in the entry payload,
 * so none of them mirrors into a version row or reaches a card export, and each is written
 * only when set, so an entry that carries none stores byte for byte what it stored before the
 * fields existed: that is why none of this needs a migration. And a chat born with something
 * stamped on it keeps that stamp, which is a claim about the INSERT rather than about a later
 * write, and the way it fails is silently: the row lands, the chat opens, and the choice the
 * reader made is simply not there.
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
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-per-chat-setup-'));
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

/** Every seed the New Chat Defaults card writes. Each is tested the same way because each
 *  makes the same three promises about the payload it lands in. */
const SEED_KEYS = [
	'defaultPersonaId',
	'defaultConnectionId',
	'defaultPresetId',
	'defaultVersionId'
] as const;

for (const key of SEED_KEYS) {
	describe(key, () => {
		test('an entry that carries none stores no key at all', () => {
			// Not merely falsy: a stored `null` would be a payload byte that was not there
			// before the field existed, on every character in every install.
			const entry = makeCharacter();
			serverDb.insertLibraryEntry(entry);
			expect(key in readBack(entry.id as string)).toBe(false);

			serverDb.updateLibraryEntry(entry);
			expect(key in readBack(entry.id as string)).toBe(false);
		});

		test('a set seed round-trips as a sibling of data, never inside it', () => {
			const seed = crypto.randomUUID();
			const entry = makeCharacter({ [key]: seed });
			serverDb.insertLibraryEntry(entry);

			const read = readBack(entry.id as string);
			expect(read[key]).toBe(seed);
			expect(read.data).not.toHaveProperty(key);
		});

		test('clearing it drops the key rather than storing an empty one', () => {
			const entry = makeCharacter({ [key]: crypto.randomUUID() });
			serverDb.insertLibraryEntry(entry);

			delete entry[key];
			serverDb.updateLibraryEntry(entry);
			expect(key in readBack(entry.id as string)).toBe(false);
		});

		test('it never reaches the version row the entry data is mirrored into', () => {
			// A version row is one variant's content. Who plays a story, and where it is sent,
			// are not properties of a variant, so a fork or a switch must never carry them along.
			const versionId = crypto.randomUUID();
			const entry = makeCharacter({ activeVersionId: versionId, [key]: crypto.randomUUID() });
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
			expect(version.data).not.toHaveProperty(key);
		});
	});
}

describe('a chat born with a claim', () => {
	function makeChat(featureState: string | null): string {
		clock += 1000;
		const id = crypto.randomUUID();
		serverDb.insertChat({
			id,
			title: 'A story',
			createdAt: clock,
			updatedAt: clock,
			rootMessageId: null,
			activeLeafId: null,
			settings: null,
			characterId: null,
			...(featureState === null ? {} : { featureState })
		});
		return id;
	}

	test('keeps the persona it was stamped with at the insert', () => {
		const id = makeChat(JSON.stringify({ persona: 'persona-1' }));
		const chat = serverDb.getChat(id) as { featureState: string | null };
		expect(JSON.parse(chat.featureState as string).persona).toBe('persona-1');
	});

	test('a chat born from every other door carries no blob at all', () => {
		const chat = serverDb.getChat(makeChat(null)) as { featureState: string | null };
		expect(chat.featureState).toBeNull();
	});

	test('the blob round-trips unparsed, exactly as written', () => {
		// The server never reads this column (mapChat), which is what lets the client add a
		// key to it without a schema change. A byte lost here is a claim lost.
		const written = JSON.stringify({
			steeringHistory: ['a note'],
			impersonatePerspective: 'second',
			scene: null,
			connection: 'conn-1',
			persona: 'persona-1',
			preset: 'preset-1',
			lorebooks: ['book-1', 'book-2']
		});
		const chat = serverDb.getChat(makeChat(written)) as { featureState: string | null };
		expect(chat.featureState).toBe(written);
	});
});
