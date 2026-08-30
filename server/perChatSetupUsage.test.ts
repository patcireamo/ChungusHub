/**
 * Per-chat setup driven through the SERVER's own doors, against the real database
 * (bun:sqlite): the assistant's `create_chat`, the chat duplicate, the library delete, and
 * the assistant's chat read, which is the one place the persona rule is spelled twice
 * because the server cannot import `src/lib/utils/chat-setup.ts`.
 *
 * The client half of the same feature is driven in src/lib/stores/chat-setup-birth.test.ts.
 * What this file adds is everything only real SQL can answer: that a claim survives the row
 * it names being deleted, that a duplicate is the same story rather than a fresh one, and
 * that the second spelling of the persona rule agrees with the first.
 *
 * Same env dance as perChatSetup.test.ts: CHUNGUS_DATA_DIR is pinned to a throwaway dir
 * before the first db call, so no test can silently write into the real user-data.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let serverDb: any;
let createChat: any;
let readChatContext: any;

/** What a capability is handed by the loop. No image family, so no portrait is read and
 *  nothing here touches the images tree. */
const ctx = { permissions: { groups: new Set<string>() }, broadcast: () => {} } as any;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-per-chat-usage-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('./db'));
	serverDb.closeForTests();
	({ createChat } = await import('./assistant/registry/workspace'));
	({ readChatContext } = await import('./assistant/registry/chat-reads'));
});

afterAll(() => {
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

let clock = 1_800_000_000_000;

function entry(type: 'character' | 'persona', name: string, extra: Record<string, unknown> = {}) {
	clock += 1000;
	const row = {
		id: crypto.randomUUID(),
		type,
		identity: { name, tags: [] },
		data: { traits: { description: `${name} description`, firstMessage: `Hi, ${name} here.` } },
		isFavorite: false,
		createdAt: clock,
		updatedAt: clock,
		...extra
	};
	serverDb.insertLibraryEntry(row);
	return row;
}

function version(entryId: string, name: string): string {
	clock += 1000;
	const id = crypto.randomUUID();
	serverDb.insertCharacterVersion({ id, entryId, name, data: { traits: {} }, createdAt: clock, updatedAt: clock });
	return id;
}

/** The chat row as it sits on disk: what the next boot and every other device read. */
function chatRow(id: string): Record<string, any> {
	const chat = serverDb.getChat(id);
	if (!chat) throw new Error(`no chat ${id}`);
	return chat;
}

const blobOf = (id: string): Record<string, unknown> => JSON.parse(chatRow(id).featureState ?? '{}');

/** Run a capability the way the loop does, and read the model-facing half of its answer. */
function run(capability: any, args: Record<string, unknown>): Record<string, any> {
	return JSON.parse(capability.run(args, ctx).toolMessage);
}

/** A chat born the way the composer mints one, with every claim on it. Written straight
 *  through `insertChat` because that is the call chatStore.createChat makes. */
function claimedChat(options: Record<string, unknown> = {}): string {
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
		characterVersionId: null,
		...options
	});
	return id;
}

describe("the assistant's create_chat", () => {
	test("pins the first version made, never the library's active one", () => {
		// Second spelling of `characterLibraryStore.chatVersionSeed`, which this process cannot
		// import. Two answers here and a chat the assistant made plays a different variant than
		// the same chat started from the composer.
		const character = entry('character', 'Aria');
		const original = version(character.id, 'Original');
		const pirate = version(character.id, 'Pirate');
		serverDb.updateLibraryEntry({ ...character, activeVersionId: pirate });

		const made = run(createChat, { characterId: character.id });
		expect(made.pinnedVersionId).toBe(original);
		expect(chatRow(made.chatId).characterVersionId).toBe(original);
	});

	test('a defaultVersionId outranks the first version made', () => {
		const character = entry('character', 'Aria');
		version(character.id, 'Original');
		const pirate = version(character.id, 'Pirate');
		serverDb.updateLibraryEntry({ ...character, defaultVersionId: pirate });

		expect(run(createChat, { characterId: character.id }).pinnedVersionId).toBe(pirate);
	});

	test('a defaultVersionId naming a deleted version falls back to the first', () => {
		const character = entry('character', 'Aria');
		const original = version(character.id, 'Original');
		serverDb.updateLibraryEntry({ ...character, defaultVersionId: crypto.randomUUID() });

		expect(run(createChat, { characterId: character.id }).pinnedVersionId).toBe(original);
	});

	test('an unversioned character pins nothing', () => {
		const made = run(createChat, { characterId: entry('character', 'Aria').id });
		expect(made.pinnedVersionId).toBeUndefined();
		expect(chatRow(made.chatId).characterVersionId).toBeNull();
	});

	test('it mints a DIFFERENT setup than the composer: the version seed alone', () => {
		// The composer stamps all four of a character's New Chat Defaults at birth
		// (src/lib/stores/chat.svelte.ts createChat, pinned by chat-setup-birth.test.ts). This
		// door answers the version and drops the other three, so the same character started
		// from the assistant is played by a different persona, sent on a different connection
		// and built from a different preset than the same character started from the composer,
		// with nothing on either screen saying why. Characterized here rather than asserted as
		// correct: architecture/ui-shell-settings.md calls this door's silence deliberate in one
		// sentence and calls the character's own seeds a real choice in the sentence before it.
		const persona = entry('persona', 'Stranger');
		const character = entry('character', 'Aria', {
			defaultPersonaId: persona.id,
			defaultConnectionId: 'conn-own',
			defaultPresetId: 'preset-own'
		});
		const pinned = version(character.id, 'Original');

		const chatId = run(createChat, { characterId: character.id }).chatId;

		expect(chatRow(chatId).characterVersionId).toBe(pinned);
		expect(chatRow(chatId).featureState).toBeNull();
	});

	test('a chat it made carries the greetings the card handed it', () => {
		// The other half of birth: the claims ride the feature blob, the opening rides rows.
		const character = entry('character', 'Aria', {
			data: { traits: { description: 'd', firstMessage: 'The gate stands open.' }, alternateGreetings: ['The gate is barred.'] }
		});
		expect(run(createChat, { characterId: character.id }).greetingsSeeded).toBe(2);
	});
});

describe('duplicating a chat', () => {
	test('the copy is the same story: every claim and the version pin come along', () => {
		// A duplicate is this story again, not a fresh one with the same transcript. A copy that
		// re-derived its setup from the character would silently answer the CURRENT defaults and
		// play the copy as somebody else.
		const character = entry('character', 'Aria');
		const pinned = version(character.id, 'Original');
		const featureState = JSON.stringify({
			steeringHistory: ['Colder.'],
			impersonatePerspective: 'second',
			scene: null,
			connection: 'conn-own',
			persona: 'persona-own',
			preset: 'preset-own'
		});
		const source = claimedChat({ characterId: character.id, characterVersionId: pinned, featureState });

		const copyId = serverDb.duplicateChat({ chatId: source, title: 'A story (copy)', includeMemory: false });

		expect(chatRow(copyId).featureState).toBe(featureState);
		expect(chatRow(copyId).characterVersionId).toBe(pinned);
	});

	test('a chat that claimed nothing copies as a chat that claims nothing', () => {
		const source = claimedChat();
		const copyId = serverDb.duplicateChat({ chatId: source, title: 'A story (copy)', includeMemory: false });
		expect(chatRow(copyId).featureState).toBeNull();
	});
});

describe('a claim outlives the row it names', () => {
	test('deleting the claimed persona leaves the id on the chat and plays as the app one', () => {
		// Never swept: restoring the persona restores the claim. The read has to fall back on
		// its own, because a story is not allowed to stop having somebody playing it.
		const app = entry('persona', 'Reader');
		const claimed = entry('persona', 'Stranger');
		serverDb.setSetting('activePersonaId', app.id);
		const character = entry('character', 'Aria');
		const chatId = claimedChat({
			characterId: character.id,
			featureState: JSON.stringify({ persona: claimed.id })
		});

		expect(run(readChatContext, { chatId }).activePersona).toMatchObject({ id: claimed.id });

		serverDb.deleteLibraryEntry(claimed.id);

		expect(blobOf(chatId).persona).toBe(claimed.id);
		expect(run(readChatContext, { chatId }).activePersona).toMatchObject({ id: app.id });

		// Back from a snapshot, or from the device that still has it: same row, same id.
		serverDb.insertLibraryEntry({ ...claimed, createdAt: clock, updatedAt: clock });
		expect(run(readChatContext, { chatId }).activePersona).toMatchObject({ id: claimed.id });
	});

	test('a claim naming a character rather than a persona is not a persona claim', () => {
		// The library holds both kinds in one table, so the type check is the whole guard.
		const app = entry('persona', 'Reader');
		serverDb.setSetting('activePersonaId', app.id);
		const character = entry('character', 'Aria');
		const chatId = claimedChat({
			characterId: character.id,
			featureState: JSON.stringify({ persona: character.id })
		});

		expect(run(readChatContext, { chatId }).activePersona).toMatchObject({ id: app.id });
	});

	test('a blob written before a chat could claim anything reads as following the app', () => {
		// Why none of this needed a migration: a missing key is "no claim", and a blob that will
		// not parse at all still leaves the story readable rather than taking the read down.
		const app = entry('persona', 'Reader');
		serverDb.setSetting('activePersonaId', app.id);
		const character = entry('character', 'Aria');
		const old = claimedChat({
			characterId: character.id,
			featureState: JSON.stringify({ steeringHistory: ['A note.'], impersonatePerspective: 'third', scene: null })
		});
		const torn = claimedChat({ characterId: character.id, featureState: '{not json' });

		expect(run(readChatContext, { chatId: old }).activePersona).toMatchObject({ id: app.id });
		expect(run(readChatContext, { chatId: torn }).activePersona).toMatchObject({ id: app.id });
	});

	test('deleting the character leaves its orphaned chat claiming what it claimed', () => {
		const app = entry('persona', 'Reader');
		const claimed = entry('persona', 'Stranger');
		serverDb.setSetting('activePersonaId', app.id);
		const character = entry('character', 'Aria');
		const pinned = version(character.id, 'Original');
		const featureState = JSON.stringify({ connection: 'conn-own', persona: claimed.id, preset: 'preset-own' });
		const chatId = claimedChat({ characterId: character.id, characterVersionId: pinned, featureState });

		serverDb.deleteLibraryEntry(character.id);

		expect(chatRow(chatId).featureState).toBe(featureState);
		expect(run(readChatContext, { chatId }).activePersona).toMatchObject({ id: claimed.id });
		// `chats.character_id` carries no foreign key, so the row still names the gone
		// character until the client's own sweep unbinds it. Whatever that sweep does, it
		// touches the cast and the version pin and never the claims above.
		expect(chatRow(chatId).characterId).toBe(character.id);
	});
});
