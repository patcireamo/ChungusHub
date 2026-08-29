/**
 * What happens to a stored override when something it depends on is deleted, against the REAL
 * server database. Persona is the worked example, because it is the only one of the three
 * whose target is a row here; the last describe covers connection and preset. Two overrides,
 * two different subjects, and the answers differ:
 *
 *  - **Its own subject going away takes it with it.** A chat's pin lives in that chat's
 *    `feature_state` column and a character's default lives in that character's `data_json`,
 *    so each delete reaps its own override with no sweep to write and none to forget.
 *  - **Its TARGET going away does not.** A persona delete deliberately leaves the id where it
 *    is, in both places. The fall-through happens at resolve time on the client
 *    (`stores/chatPersona.svelte.ts`), which costs no writes, cannot miss a chat, and cannot
 *    turn one device's delete into a silent rewrite of another device's chats and cards. What
 *    the reader sees is the next layer down; what the column holds is inert.
 *
 * That second half is the one worth pinning, because "it still resolves correctly" and "the
 * row was cleaned up" look identical from the UI and only one of them is true.
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
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-override-life-'));
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

/** All three per-character defaults, which share one key, one lifetime and one storage rule. */
type Overrides = { personaId?: string; connectionId?: string; presetId?: string };

/** What a chat may have decided, one entry per overridable setting. */
type Decisions = {
	persona?: { follows: string; id?: string };
	connection?: { follows: string; id?: string };
	preset?: { follows: string; id?: string };
};

function makeEntry(type: 'character' | 'persona', name: string, overrides?: Overrides): string {
	const id = crypto.randomUUID();
	const entry: Record<string, unknown> = {
		id,
		type,
		identity: { name },
		data: { traits: { description: `${name} is here.` } },
		isFavorite: false,
		createdAt: (clock += 1000),
		updatedAt: clock
	};
	if (overrides) entry.overrides = overrides;
	serverDb.insertLibraryEntry(entry);
	return id;
}

/** A chat, optionally bound to a character and optionally pinning a persona. */
function makeChat(characterId: string | null, personaPin: string | null): string {
	return makeChatWith(characterId, personaPin === null ? null : { persona: { follows: 'persona', id: personaPin } });
}

/** The same, for a chat whose decisions are not only about persona. */
function makeChatWith(characterId: string | null, decisions: Decisions | null): string {
	const id = crypto.randomUUID();
	serverDb.insertChat({
		id,
		title: 'Test chat',
		createdAt: (clock += 1000),
		updatedAt: clock,
		rootMessageId: null,
		activeLeafId: null,
		canonLeafId: null,
		settings: null,
		characterId,
		characterVersionId: null
	});
	if (decisions !== null) {
		// The column is an opaque JSON string the server never parses, which is exactly why
		// neither the pins nor their later reshaping needed a migration to live here, and why
		// a second and third decision cost no schema change at all.
		serverDb.updateChat({
			id,
			featureState: JSON.stringify({
				steeringHistory: [],
				impersonatePerspective: 'first',
				scene: null,
				...decisions
			})
		});
	}
	return id;
}

/** The id a chat pinned for one setting, or null if it pinned none. */
function pinFor(chatId: string, kind: 'persona' | 'connection' | 'preset'): string | null {
	const chat = serverDb.getChat(chatId) as { featureState: string | null } | null;
	if (!chat?.featureState) return null;
	const decision = (JSON.parse(chat.featureState) as Decisions)[kind];
	return decision?.follows === kind ? (decision.id ?? null) : null;
}

function chatPin(chatId: string): string | null {
	return pinFor(chatId, 'persona');
}

function characterDefault(entryId: string, key: keyof Overrides = 'personaId'): string | null {
	const entry = serverDb.getLibraryEntry(entryId) as { overrides?: Overrides } | null;
	return entry?.overrides?.[key] ?? null;
}

describe('deleting the thing an override belongs to', () => {
	test('deleting a chat takes its persona pin with it', () => {
		const persona = makeEntry('persona', 'Mai');
		const chat = makeChat(null, persona);
		expect(chatPin(chat)).toBe(persona);

		serverDb.deleteChat(chat);
		// The pin is a column on the row, so there is no orphan to sweep and nothing that
		// can outlive the story it belonged to.
		expect(serverDb.getChat(chat)).toBeNull();
	});

	test('deleting a character takes its default persona with it', () => {
		const persona = makeEntry('persona', 'Polka');
		const character = makeEntry('character', 'Kasumi', { personaId: persona });
		expect(characterDefault(character)).toBe(persona);

		serverDb.deleteLibraryEntry(character);
		expect(serverDb.getLibraryEntry(character)).toBeNull();
	});

	test("deleting a character leaves its chats' OWN pins alone", () => {
		// The two layers are independent stores, and a chat orphaned by a character delete is
		// a state this app already has (chats.character_id carries no foreign key, see
		// architecture/chat-sessions.md). Its own pin is still the layer that decides; what
		// it loses is only the character default it might have been inheriting.
		const persona = makeEntry('persona', 'Rin');
		const character = makeEntry('character', 'Doomed', { personaId: persona });
		const pinned = makeChat(character, persona);
		const following = makeChat(character, null);

		serverDb.deleteLibraryEntry(character);

		expect(chatPin(pinned)).toBe(persona);
		expect(chatPin(following)).toBeNull();
		// The binding is left dangling rather than nulled, which is what makes the Character
		// layer resolve as unreachable for these chats rather than as empty.
		const chat = serverDb.getChat(pinned) as { characterId: string | null };
		expect(chat.characterId).toBe(character);
	});
});

describe('deleting the persona an override POINTS AT', () => {
	test("a chat's pin is left dangling, not swept", () => {
		const keep = makeEntry('persona', 'Survivor');
		const doomed = makeEntry('persona', 'Doomed');
		const chat = makeChat(null, doomed);

		serverDb.deleteLibraryEntry(doomed);

		expect(serverDb.getLibraryEntry(doomed)).toBeNull();
		// Deliberate: the id stays put and resolves one layer down on the client. A sweep
		// here would let a delete on one device rewrite chats on every other one.
		expect(chatPin(chat)).toBe(doomed);
		expect(serverDb.getLibraryEntry(keep)).not.toBeNull();
	});

	test("a character's default is left dangling, not swept", () => {
		makeEntry('persona', 'Survivor 2');
		const doomed = makeEntry('persona', 'Doomed 2');
		const character = makeEntry('character', 'Holder', { personaId: doomed });

		serverDb.deleteLibraryEntry(doomed);

		expect(serverDb.getLibraryEntry(doomed)).toBeNull();
		expect(characterDefault(character)).toBe(doomed);
	});

	test('the persona floor still decides what a delete is even allowed to do', () => {
		// The floor is what makes both dangling cases rare rather than routine: the library
		// keeps at least one persona, and deleting the ACTIVE one hands the role to a
		// survivor instead of clearing the pointer. Neither half looks at overrides, which
		// is precisely why the fall-through above has to exist.
		const personas = (serverDb.getAllLibraryEntries() as { id: string; type: string }[]).filter(
			(e) => e.type === 'persona'
		);
		expect(personas.length).toBeGreaterThan(0);
		// Every persona but the last goes; the last one has to refuse.
		for (const p of personas.slice(0, -1)) serverDb.deleteLibraryEntry(p.id);
		expect(() => serverDb.deleteLibraryEntry(personas[personas.length - 1].id)).toThrow();
	});
});

describe('the other two overrides live and die by the same rules', () => {
	// Connection and preset differ from persona in exactly one way this file can see: neither
	// is a row in this database. Connections live in the settings table as one JSON blob and
	// presets are files under data/presets, so there is no "the target was deleted" case to
	// pin here. That fall-through is one pure rule for all three and is held in
	// src/lib/types/chat.test.ts instead.
	//
	// Everything that IS a row behaves identically, and that is what these hold.

	test('a chat carries all three decisions in the one blob, with no schema change', () => {
		const chat = makeChatWith(null, {
			persona: { follows: 'persona', id: 'persona-mai' },
			connection: { follows: 'connection', id: 'conn-local' },
			preset: { follows: 'preset', id: 'preset-standard' }
		});
		expect(pinFor(chat, 'persona')).toBe('persona-mai');
		expect(pinFor(chat, 'connection')).toBe('conn-local');
		expect(pinFor(chat, 'preset')).toBe('preset-standard');
	});

	test('the three share a column without disturbing each other', () => {
		// One column is the one way they could interfere, so the blob is read back raw rather
		// than through a reader that could paper over a lost key.
		const chat = makeChatWith(null, {
			persona: { follows: 'app' },
			connection: { follows: 'connection', id: 'conn-local' }
		});
		const stored = JSON.parse(
			(serverDb.getChat(chat) as { featureState: string }).featureState
		) as Decisions;
		expect(stored.persona).toEqual({ follows: 'app' });
		expect(stored.connection).toEqual({ follows: 'connection', id: 'conn-local' });
		expect(stored.preset).toBeUndefined();
	});

	test('deleting a chat takes all three of its decisions with it', () => {
		const chat = makeChatWith(null, {
			connection: { follows: 'connection', id: 'conn-local' },
			preset: { follows: 'preset', id: 'preset-standard' }
		});
		serverDb.deleteChat(chat);
		expect(serverDb.getChat(chat)).toBeNull();
	});

	test('deleting a character takes all three of its defaults with it', () => {
		const character = makeEntry('character', 'Departing', {
			personaId: 'persona-mai',
			connectionId: 'conn-local',
			presetId: 'preset-standard'
		});
		expect(characterDefault(character, 'connectionId')).toBe('conn-local');
		expect(characterDefault(character, 'presetId')).toBe('preset-standard');

		serverDb.deleteLibraryEntry(character);
		expect(serverDb.getLibraryEntry(character)).toBeNull();
	});

	test("deleting a character leaves its chats' own connection and preset pins alone", () => {
		const character = makeEntry('character', 'Doomed as well', { connectionId: 'conn-card' });
		const pinned = makeChatWith(character, {
			connection: { follows: 'connection', id: 'conn-chat' },
			preset: { follows: 'preset', id: 'preset-chat' }
		});
		const following = makeChatWith(character, null);

		serverDb.deleteLibraryEntry(character);

		expect(pinFor(pinned, 'connection')).toBe('conn-chat');
		expect(pinFor(pinned, 'preset')).toBe('preset-chat');
		expect(pinFor(following, 'connection')).toBeNull();
	});
});
