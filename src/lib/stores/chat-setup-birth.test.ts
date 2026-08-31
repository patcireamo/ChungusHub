/**
 * What a chat is born running on, and what happens to that when the thing it named goes
 * away. Driven through the doors a reader actually presses: the composer's New chat, the
 * New chat flow's persona step, the character editor's New Chat Defaults card, the version
 * menu, and the deletes on the Library, Connections and Presets screens. Run with `bun test`.
 *
 * Two rules carry the whole design and each fails silently on its own. A character's four
 * defaults are SEEDS: they stamp a chat at birth and have no say afterwards, so moving one
 * must leave every story already under way exactly where it was. And what a story runs on is
 * its own claim while the thing it names still exists, else the app's, with the stored id
 * never swept, so restoring a deleted persona, connection or preset brings the claim back
 * instead of having quietly lost it.
 *
 * Runes are compile-time macros and nothing compiles a store under `bun test`, so `$state`
 * and `$derived` are shimmed BEFORE the modules load, the same way transcript-refresh.test.ts
 * does. `$state.snapshot` clones for real rather than returning its argument: the library
 * store detaches everything it hands out through it, and an aliasing shim would let a test
 * mutate the store by accident and then read its own write back as a pass.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';

const identity = <T>(value?: T): T | undefined => value;
(globalThis as unknown as { $state: unknown }).$state = Object.assign(identity, {
	raw: identity,
	snapshot: <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T))
});
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(identity, {
	by: <T>(fn: () => T): T => fn()
});

/** The server, as far as this file is concerned: the rows every store under test reads and
 *  writes. Deliberately a store rather than per-method canned answers, because the point is
 *  that one door's write is what the next door reads. */
const server = {
	chats: new Map<string, Record<string, unknown>>(),
	messages: [] as Record<string, unknown>[],
	entries: [] as Record<string, unknown>[],
	versions: [] as Record<string, unknown>[],
	settings: new Map<string, string>(),
	greetings: new Map<string, string[]>()
};

const copy = <T>(value: T): T => structuredClone(value);

/**
 * Bun's module registry is process-wide and one run loads every test file into it, so a stub
 * left behind here is served to every file that loads after this one, in whatever order the
 * platform walks the tree. Each stub is a SPREAD of the real module so nothing an importer
 * expects goes missing, and the restore is registered BEFORE the first one goes in, so a
 * throw during setup cannot leave one standing.
 */
const realDatabase = { ...(await import('$lib/services/database')) };
const realTransport = { ...(await import('$lib/services/transport')) };
const realMemory = { ...(await import('$lib/memory/store.svelte')) };

afterAll(() => {
	mock.module('$lib/services/database', () => realDatabase);
	mock.module('$lib/services/transport', () => realTransport);
	mock.module('$lib/memory/store.svelte', () => realMemory);
});

mock.module('$lib/services/database', () => ({
	...realDatabase,
	db: {
		getSetting: async (key: string) => server.settings.get(key) ?? null,
		setSetting: async (key: string, value: string) => {
			server.settings.set(key, value);
		},

		getAllChats: async () => [...server.chats.values()].map(copy),
		getChat: async (id: string) => (server.chats.has(id) ? copy(server.chats.get(id)!) : null),
		insertChat: async (chat: Record<string, unknown>) => {
			server.chats.set(chat.id as string, copy(chat));
		},
		importChat: async (chat: Record<string, unknown>, messages: Record<string, unknown>[]) => {
			server.chats.set(chat.id as string, copy(chat));
			for (const message of messages) server.messages.push(copy(message));
		},
		updateChat: async (patch: Record<string, unknown>) => {
			const row = server.chats.get(patch.id as string);
			if (!row) throw new Error(`updateChat: no chat ${patch.id}`);
			Object.assign(row, copy(patch));
		},
		deleteChat: async (id: string) => {
			server.chats.delete(id);
		},
		setChatSeededGreetings: async (chatId: string, greetings: string[]) => {
			server.greetings.set(chatId, [...greetings]);
		},
		insertMessage: async (message: Record<string, unknown>) => {
			server.messages.push(copy(message));
		},
		getMessagesDelta: async (chatId: string) => ({
			rev: 1,
			full: true,
			messages: server.messages.filter((m) => m.chatId === chatId).map(copy)
		}),
		getLastPersonaByChat: async () => ({}),

		getAllLibraryEntries: async () => server.entries.map(copy),
		insertLibraryEntry: async (entry: Record<string, unknown>) => {
			server.entries.push(copy(entry));
		},
		updateLibraryEntry: async (entry: Record<string, unknown>) => {
			const at = server.entries.findIndex((e) => e.id === entry.id);
			if (at < 0) throw new Error(`updateLibraryEntry: no entry ${entry.id}`);
			server.entries[at] = copy(entry);
		},
		deleteLibraryEntry: async (id: string) => {
			server.entries = server.entries.filter((e) => e.id !== id);
			server.versions = server.versions.filter((v) => v.entryId !== id);
			return null;
		},

		getAllCharacterVersions: async () => server.versions.map(copy),
		insertCharacterVersion: async (version: Record<string, unknown>) => {
			server.versions.push(copy(version));
		},
		deleteCharacterVersion: async (id: string) => {
			server.versions = server.versions.filter((v) => v.id !== id);
		},
		renameCharacterVersion: async (id: string, name: string) => {
			const row = server.versions.find((v) => v.id === id);
			if (row) row.name = name;
		},
		pinUnpinnedChatsToVersion: async (entryId: string, versionId: string) => {
			for (const chat of server.chats.values()) {
				if (chat.characterId === entryId && !chat.characterVersionId) chat.characterVersionId = versionId;
			}
		},

		deleteConnectionCredentials: async () => {}
	}
}));

mock.module('$lib/services/transport', () => ({
	...realTransport,
	llmStatus: async () => [],
	stopGeneration: () => {},
	getClientId: () => 'test-client',
	apiGet: async () => ({ presets: [], drafts: [] }),
	apiSend: async () => ({})
}));

mock.module('$lib/memory/store.svelte', () => ({
	...realMemory,
	memoryStore: {
		activeChatId: null,
		loadForChat: async () => {},
		syncForPath: async () => {},
		clear: () => {}
	}
}));

const { chatStore } = await import('./chat.svelte');
const { characterLibraryStore } = await import('./characterLibrary.svelte');
const { connectionStore } = await import('./connections.svelte');
const { personaStore } = await import('./persona.svelte');
const { presetService } = await import('$lib/services/presets.svelte');
const { presetControlsStore, readPresetControlValues } = await import('./presetControls.svelte');
const { reloadAllSyncedSettings } = await import('$lib/services/syncedSetting');
const {
	chatConnectionId,
	chatPersonaClaim,
	chatPreset,
	chatPresetClaim,
	chatPresetId,
	chatPersonaEntry,
	resolvePromptTarget
} = await import('$lib/utils/chat-setup');
const { normalizeChatFeatureState } = await import('$lib/types/chat');
const { DEFAULT_GENERATION_SETTINGS } = await import('$lib/types/llm');

type Claims = ReturnType<typeof normalizeChatFeatureState>;

const APP_CONNECTION = 'conn-app';
const OWN_CONNECTION = 'conn-own';
const APP_PRESET = 'app-preset';
const OWN_PRESET = 'own-preset';

function connectionRow(id: string, model: string, contextSize: number) {
	return {
		id,
		name: id,
		provider: 'openrouter',
		model,
		contextSize,
		postProcessing: 'strict',
		promptPlaceholder: `[${id}]`,
		routing: null,
		samplingParams: [],
		reasoningDialect: 'none',
		generation: { ...DEFAULT_GENERATION_SETTINGS }
	};
}

let clock = 1_700_000_000_000;

function libraryRow(type: 'character' | 'persona', name: string, extra: Record<string, unknown> = {}) {
	clock += 1000;
	return {
		id: crypto.randomUUID(),
		type,
		identity: { name, tags: [] },
		data: { traits: { personality: '', description: `${name} description`, background: '', firstMessage: `Hi, ${name} here.` } },
		isFavorite: false,
		createdAt: clock,
		updatedAt: clock,
		...extra
	};
}

/** Everything the app answers when a chat claims nothing, plus a cast to build chats from.
 *  Rebuilt per test so no case inherits another's claims. */
let appPersonaId = '';
let otherPersonaId = '';

async function reset(): Promise<void> {
	server.chats.clear();
	server.messages.length = 0;
	server.entries = [];
	server.versions = [];
	server.greetings.clear();
	server.settings.clear();

	const appPersona = libraryRow('persona', 'Reader');
	const otherPersona = libraryRow('persona', 'Stranger');
	appPersonaId = appPersona.id;
	otherPersonaId = otherPersona.id;
	server.entries.push(appPersona, otherPersona);

	server.settings.set('connections', JSON.stringify([connectionRow(APP_CONNECTION, 'openai/app-model', 32_000), connectionRow(OWN_CONNECTION, 'anthropic/own-model', 200_000)]));
	server.settings.set('connectionAssignments', JSON.stringify({ primary: APP_CONNECTION }));
	server.settings.set('activePersonaId', appPersonaId);

	chatStore.chats = [];
	chatStore.activeChatId = null;
	chatStore.currentChatState = null;

	await characterLibraryStore.refresh();
	await personaStore.initialize();
	await connectionStore.initialize();
	// The store is initialized once per process; every later case seeds the settings rows and
	// comes in through the reload every other device's write arrives by.
	await reloadAllSyncedSettings();

	// The service is one process-wide singleton, so the app's preset is put back before
	// anything else goes: deleting the ACTIVE preset mints a replacement, and a case would
	// then start against a preset no test wrote.
	for (const id of [APP_PRESET, OWN_PRESET]) {
		if (!presetService.getEffective(id)) await presetService.createPreset(id);
	}
	await presetService.activatePreset(APP_PRESET);
	for (const preset of presetService.getAllPresets()) {
		if (preset.id !== APP_PRESET && preset.id !== OWN_PRESET) await presetService.deletePreset(preset.id);
	}
}

beforeEach(reset);

/** A character in the library, with whatever New Chat Defaults the case is about. */
async function character(defaults: Record<string, unknown> = {}): Promise<string> {
	const entry = libraryRow('character', 'Aria', defaults);
	server.entries.push(entry);
	await characterLibraryStore.refresh();
	return entry.id;
}

/** The chat row as it reached the server: what the next boot and every other device sees. */
function stored(chatId: string): Record<string, unknown> {
	const row = server.chats.get(chatId);
	if (!row) throw new Error(`no chat ${chatId} on the server`);
	return row;
}

const claims = (chatId: string): Claims => normalizeChatFeatureState(stored(chatId).featureState ?? null);

/** The chat as a surface holding it would read it, straight off the stored row. */
const asChat = (chatId: string) => stored(chatId) as never;

describe('a chat born from the composer', () => {
	test('a character with every default set is born claiming all four', async () => {
		const versionId = crypto.randomUUID();
		const entryId = await character({
			defaultPersonaId: otherPersonaId,
			defaultConnectionId: OWN_CONNECTION,
			defaultPresetId: OWN_PRESET,
			defaultVersionId: versionId
		});
		server.versions.push({ id: versionId, entryId, name: 'Pirate', data: { traits: {} }, createdAt: clock, updatedAt: clock });
		await characterLibraryStore.refresh();

		const chatId = await chatStore.createChat({ characterId: entryId });

		expect(stored(chatId).characterVersionId).toBe(versionId);
		expect(claims(chatId)).toMatchObject({
			persona: otherPersonaId,
			connection: OWN_CONNECTION,
			preset: OWN_PRESET
		});
		// The claims are not merely stored: every surface resolves the story to them.
		expect(chatPersonaEntry(asChat(chatId))?.id).toBe(otherPersonaId);
		expect(chatConnectionId(asChat(chatId))).toBe(OWN_CONNECTION);
		expect(chatPreset(asChat(chatId))?.id).toBe(OWN_PRESET);
		expect(resolvePromptTarget(asChat(chatId)).model).toBe('anthropic/own-model');
	});

	test('a character with no defaults is born with no blob at all and follows the app', async () => {
		// Not merely a blob whose fields are null: a chat minted with nobody present must store
		// exactly what a chat stored before any of this existed, or every install grows a row of
		// pins nobody made.
		const chatId = await chatStore.createChat({ characterId: await character() });

		expect(stored(chatId).featureState).toBeNull();
		expect(stored(chatId).characterVersionId).toBeNull();
		expect(chatPersonaEntry(asChat(chatId))?.id).toBe(appPersonaId);
		expect(chatConnectionId(asChat(chatId))).toBeNull();
		expect(chatPresetId(asChat(chatId))).toBeNull();
		expect(chatPreset(asChat(chatId))?.id).toBe(APP_PRESET);
		expect(resolvePromptTarget(asChat(chatId)).model).toBe('openai/app-model');
	});

	test("the New chat flow's persona outranks the character's own seed", async () => {
		// Somebody just chose this persona for this story, one press ago. The seed is what the
		// character answers when nobody asked.
		const entryId = await character({ defaultPersonaId: otherPersonaId, defaultConnectionId: OWN_CONNECTION });
		const chatId = await chatStore.createChat({ characterId: entryId, personaId: appPersonaId });

		expect(claims(chatId).persona).toBe(appPersonaId);
		// The other seeds are untouched by the flow: it asks about a persona and nothing else.
		expect(claims(chatId).connection).toBe(OWN_CONNECTION);
	});

	test('a flow persona on a character with no seeds stamps the persona and nothing else', async () => {
		const chatId = await chatStore.createChat({ characterId: await character(), personaId: otherPersonaId });

		expect(claims(chatId)).toMatchObject({ persona: otherPersonaId, connection: null, preset: null });
	});

	test('an imported story is a door that stamps nothing', async () => {
		// A SillyTavern import carries somebody else's story, not a choice about this install's
		// personas, connections or presets.
		const entryId = await character({
			defaultPersonaId: otherPersonaId,
			defaultConnectionId: OWN_CONNECTION,
			defaultPresetId: OWN_PRESET
		});
		const { chatId } = await chatStore.importSillyTavernChat({
			characterId: entryId,
			lines: [
				JSON.stringify({ user_name: 'Reader', character_name: 'Aria' }),
				JSON.stringify({ name: 'Aria', is_user: false, mes: 'The gate stands open.', send_date: clock })
			]
		});

		expect(chatId).not.toBeNull();
		expect(stored(chatId!).featureState).toBeNull();
	});
});

describe('the defaults are seeds and stop deciding at birth', () => {
	test('moving a character default leaves a story already under way exactly where it was', async () => {
		const entryId = await character({ defaultPersonaId: otherPersonaId, defaultConnectionId: OWN_CONNECTION, defaultPresetId: OWN_PRESET });
		const first = await chatStore.createChat({ characterId: entryId });
		const bornWith = stored(first).featureState;

		await characterLibraryStore.setChatDefault(entryId, 'defaultPersonaId', appPersonaId);
		await characterLibraryStore.setChatDefault(entryId, 'defaultConnectionId', APP_CONNECTION);
		await characterLibraryStore.setChatDefault(entryId, 'defaultPresetId', APP_PRESET);

		expect(stored(first).featureState).toBe(bornWith);
		expect(chatPersonaEntry(asChat(first))?.id).toBe(otherPersonaId);

		const second = await chatStore.createChat({ characterId: entryId });
		expect(claims(second)).toMatchObject({ persona: appPersonaId, connection: APP_CONNECTION, preset: APP_PRESET });
	});

	test('clearing every default stops stamping without disturbing the chats already born', async () => {
		const entryId = await character({ defaultPersonaId: otherPersonaId, defaultConnectionId: OWN_CONNECTION, defaultPresetId: OWN_PRESET });
		const first = await chatStore.createChat({ characterId: entryId });

		for (const key of ['defaultPersonaId', 'defaultConnectionId', 'defaultPresetId'] as const) {
			await characterLibraryStore.setChatDefault(entryId, key, null);
		}

		expect(claims(first)).toMatchObject({ persona: otherPersonaId, connection: OWN_CONNECTION, preset: OWN_PRESET });
		expect(stored(await chatStore.createChat({ characterId: entryId })).featureState).toBeNull();
	});

	test('a cleared default leaves no key behind on the entry', async () => {
		// A stored empty string would read as a claim on nothing and stamp one at the next birth.
		const entryId = await character({ defaultPresetId: OWN_PRESET });
		await characterLibraryStore.setChatDefault(entryId, 'defaultPresetId', null);

		const row = server.entries.find((e) => e.id === entryId)!;
		expect('defaultPresetId' in row).toBe(false);
	});
});

describe('the version a new chat starts on', () => {
	/** Fork a named variant, which is also what makes an unversioned character versioned:
	 *  the first fork parks the current state as "Original" and opens the new one. */
	const fork = (entryId: string, name: string) => characterLibraryStore.createVersion(entryId, name);

	test("with no default, birth pins the first version made and never the library's active one", async () => {
		// The active pointer says which variant the LIBRARY is editing. Let it decide here and
		// opening another variant in the editor quietly changes what every story started
		// afterwards is played against.
		const entryId = await character();
		const pirate = await fork(entryId, 'Pirate');
		const versions = characterLibraryStore.versionsFor(entryId);
		const original = versions[0];

		expect(characterLibraryStore.getEntryById(entryId)?.activeVersionId).toBe(pirate!.id);
		expect(stored(await chatStore.createChat({ characterId: entryId })).characterVersionId).toBe(original.id);
	});

	test('a defaultVersionId outranks the first version made', async () => {
		const entryId = await character();
		const pirate = await fork(entryId, 'Pirate');
		await characterLibraryStore.setChatDefault(entryId, 'defaultVersionId', pirate!.id);

		expect(stored(await chatStore.createChat({ characterId: entryId })).characterVersionId).toBe(pirate!.id);
	});

	test('a defaultVersionId naming a deleted version falls back to the first, and is never swept', async () => {
		// Same rule as every other claim: the seed stays put, so restoring the version restores
		// what new chats start on rather than silently having lost it.
		const entryId = await character();
		const pirate = await fork(entryId, 'Pirate');
		await characterLibraryStore.setChatDefault(entryId, 'defaultVersionId', pirate!.id);
		const original = characterLibraryStore.versionsFor(entryId)[0];

		await characterLibraryStore.deleteVersion(pirate!.id);

		expect(characterLibraryStore.chatVersionSeed(entryId)).toBe(original.id);
		expect(stored(await chatStore.createChat({ characterId: entryId })).characterVersionId).toBe(original.id);
		expect(server.entries.find((e) => e.id === entryId)!.defaultVersionId).toBe(pirate!.id);
	});

	test('an unversioned character pins nothing and follows its live data', async () => {
		expect(stored(await chatStore.createChat({ characterId: await character() })).characterVersionId).toBeNull();
	});

	test('switching the library to another variant does not move an existing chat', async () => {
		const entryId = await character();
		const pirate = await fork(entryId, 'Pirate');
		const original = characterLibraryStore.versionsFor(entryId)[0];
		const chatId = await chatStore.createChat({ characterId: entryId });

		await characterLibraryStore.switchActiveVersion(entryId, original.id);
		expect(stored(chatId).characterVersionId).toBe(original.id);

		await characterLibraryStore.switchActiveVersion(entryId, pirate!.id);
		expect(stored(chatId).characterVersionId).toBe(original.id);
	});
});

describe('the lorebooks a chat attaches for itself', () => {
	const plainChat = async (): Promise<string> => chatStore.createChat({ characterId: await character() });

	test('a chat is born attaching nothing, and attaching one claims only that chat', async () => {
		const chatId = await plainChat();
		const other = await plainChat();
		expect(claims(chatId).lorebooks).toEqual([]);

		await chatStore.toggleChatLorebook(chatId, 'book-1');

		expect(claims(chatId).lorebooks).toEqual(['book-1']);
		expect(claims(other).lorebooks).toEqual([]);
		// The press decided one thing: what this story plays as is still the app's business.
		expect(claims(chatId).persona).toBeNull();
	});

	test('pressing the same row again takes the book back off', async () => {
		const chatId = await plainChat();
		await chatStore.toggleChatLorebook(chatId, 'book-1');
		await chatStore.toggleChatLorebook(chatId, 'book-2');
		await chatStore.toggleChatLorebook(chatId, 'book-1');
		expect(claims(chatId).lorebooks).toEqual(['book-2']);
	});

	// Why the toggle lives in the store rather than in the panel: computed from the caller's
	// own copy of the list, a press would drop whatever the press before it added, and a run
	// of presses inside one round trip is what attaching several books actually is.
	test('two presses landing inside one round trip both take', async () => {
		const chatId = await plainChat();
		await Promise.all([
			chatStore.toggleChatLorebook(chatId, 'book-1'),
			chatStore.toggleChatLorebook(chatId, 'book-2')
		]);
		expect(claims(chatId).lorebooks).toEqual(['book-1', 'book-2']);
	});

});

describe('the lorebooks a chat leaves out', () => {
	const plainChat = async (): Promise<string> => chatStore.createChat({ characterId: await character() });

	test('a chat is born muting nothing, and a mute claims only that chat', async () => {
		const chatId = await plainChat();
		const other = await plainChat();
		expect(claims(chatId).mutedLorebooks).toEqual([]);

		await chatStore.toggleChatLorebookMute(chatId, 'book-1');

		expect(claims(chatId).mutedLorebooks).toEqual(['book-1']);
		expect(claims(other).mutedLorebooks).toEqual([]);
		// Muting says nothing about what this story attached: two lists, two answers.
		expect(claims(chatId).lorebooks).toEqual([]);
	});

	test('pressing the same row again lets the book back in', async () => {
		const chatId = await plainChat();
		await chatStore.toggleChatLorebookMute(chatId, 'book-1');
		await chatStore.toggleChatLorebookMute(chatId, 'book-1');
		expect(claims(chatId).mutedLorebooks).toEqual([]);
	});

	// The one place the two lists meet, and the reason attaching writes through the shared
	// transform: a book in both would read as attached and reach no prompt.
	test('attaching a muted book clears the mute', async () => {
		const chatId = await plainChat();
		await chatStore.toggleChatLorebookMute(chatId, 'book-1');
		await chatStore.toggleChatLorebook(chatId, 'book-1');
		expect(claims(chatId).lorebooks).toEqual(['book-1']);
		expect(claims(chatId).mutedLorebooks).toEqual([]);
	});

	test('two presses landing inside one round trip both take', async () => {
		const chatId = await plainChat();
		await Promise.all([
			chatStore.toggleChatLorebookMute(chatId, 'book-1'),
			chatStore.toggleChatLorebookMute(chatId, 'book-2')
		]);
		expect(claims(chatId).mutedLorebooks).toEqual(['book-1', 'book-2']);
	});
});

describe('a claim outlives the thing it names', () => {
	async function claimedChat(): Promise<string> {
		const entryId = await character({
			defaultPersonaId: otherPersonaId,
			defaultConnectionId: OWN_CONNECTION,
			defaultPresetId: OWN_PRESET
		});
		return chatStore.createChat({ characterId: entryId });
	}

	test('deleting the claimed connection sends on the app and keeps the id for its return', async () => {
		const chatId = await claimedChat();

		connectionStore.remove(OWN_CONNECTION);

		expect(claims(chatId).connection).toBe(OWN_CONNECTION);
		expect(chatConnectionId(asChat(chatId))).toBeNull();
		expect(resolvePromptTarget(asChat(chatId)).target).toBe('primary');
		expect(resolvePromptTarget(asChat(chatId)).model).toBe('openai/app-model');

		// Restored from a snapshot, or arriving from the device that still has it: the same
		// settings reload either way, and the claim comes back live.
		server.settings.set('connections', JSON.stringify([connectionRow(APP_CONNECTION, 'openai/app-model', 32_000), connectionRow(OWN_CONNECTION, 'anthropic/own-model', 200_000)]));
		await reloadAllSyncedSettings();

		expect(chatConnectionId(asChat(chatId))).toBe(OWN_CONNECTION);
		expect(resolvePromptTarget(asChat(chatId)).model).toBe('anthropic/own-model');
	});

	test('deleting the claimed preset builds from the app one and keeps the id for its return', async () => {
		const chatId = await claimedChat();

		await presetService.deletePreset(OWN_PRESET);

		expect(chatPresetClaim(asChat(chatId))).toBe(OWN_PRESET);
		expect(chatPresetId(asChat(chatId))).toBeNull();
		expect(chatPreset(asChat(chatId))?.id).toBe(APP_PRESET);

		// Re-imported under the same name, which is the same id: the claim resolves again.
		await presetService.createPreset(OWN_PRESET);
		expect(chatPresetId(asChat(chatId))).toBe(OWN_PRESET);
	});

	test('deleting the claimed persona plays as the app one and keeps the id for its return', async () => {
		const chatId = await claimedChat();

		await characterLibraryStore.deleteEntry(otherPersonaId);

		expect(chatPersonaClaim(asChat(chatId))).toBe(otherPersonaId);
		expect(chatPersonaEntry(asChat(chatId))?.id).toBe(appPersonaId);

		server.entries.push({ ...libraryRow('persona', 'Stranger'), id: otherPersonaId });
		await characterLibraryStore.refresh();
		expect(chatPersonaEntry(asChat(chatId))?.id).toBe(otherPersonaId);
	});

	test('deleting the character leaves its orphaned chats claiming what they claimed', async () => {
		// The chat loses its cast and its version pin, because both named rows that are gone.
		// Who plays it, where it sends and what it is built from are the reader's and survive.
		const entryId = await character({
			defaultPersonaId: otherPersonaId,
			defaultConnectionId: OWN_CONNECTION,
			defaultPresetId: OWN_PRESET
		});
		const pirate = await characterLibraryStore.createVersion(entryId, 'Pirate');
		const chatId = await chatStore.createChat({ characterId: entryId });
		expect(stored(chatId).characterVersionId).not.toBe(pirate!.id);

		await characterLibraryStore.deleteEntry(entryId);

		expect(stored(chatId).characterId).toBeNull();
		expect(stored(chatId).characterVersionId).toBeNull();
		expect(claims(chatId)).toMatchObject({
			persona: otherPersonaId,
			connection: OWN_CONNECTION,
			preset: OWN_PRESET
		});
		expect(chatPersonaEntry(asChat(chatId))?.id).toBe(otherPersonaId);
		expect(chatConnectionId(asChat(chatId))).toBe(OWN_CONNECTION);
		expect(chatPreset(asChat(chatId))?.id).toBe(OWN_PRESET);
	});
});

describe('one blob, every feature', () => {
	test('the four claims and the composer state share it without disturbing each other', async () => {
		const chatId = await chatStore.createChat({ characterId: await character({ defaultPresetId: OWN_PRESET }) });

		await chatStore.updateChatFeatureState(chatId, { connection: OWN_CONNECTION });
		await chatStore.pushSteeringHistory(chatId, ['Colder.', 'Slower.']);
		await chatStore.setImpersonatePerspective(chatId, 'second');
		await chatStore.updateChatFeatureState(chatId, { persona: otherPersonaId });
		await chatStore.updateChatFeatureState(chatId, {
			scene: { enabled: true, background: { type: 'none' }, ambient: { effect: 'none' } } as never
		});

		const held = claims(chatId);
		expect(held.connection).toBe(OWN_CONNECTION);
		expect(held.persona).toBe(otherPersonaId);
		expect(held.preset).toBe(OWN_PRESET);
		expect(held.impersonatePerspective).toBe('second');
		expect(held.steeringHistory).toEqual(['Slower.', 'Colder.']);
		expect(held.scene?.enabled).toBe(true);
	});

	test('a blob written before a chat could claim anything reads as following the app', async () => {
		// The whole reason none of this needed a migration: a missing key is "no claim", and a
		// later write must carry the old keys forward rather than replacing the blob.
		const chatId = await chatStore.createChat({ characterId: await character() });
		const old = JSON.stringify({ steeringHistory: ['Older note.'], impersonatePerspective: 'third', scene: null });
		stored(chatId).featureState = old;
		chatStore.chats = chatStore.chats.map((c) => (c.id === chatId ? { ...c, featureState: old } : c));
		chatStore.currentChatState = null;

		expect(claims(chatId)).toMatchObject({ connection: null, persona: null, preset: null });
		expect(chatPersonaEntry(asChat(chatId))?.id).toBe(appPersonaId);
		expect(chatPreset(asChat(chatId))?.id).toBe(APP_PRESET);

		await chatStore.updateChatFeatureState(chatId, { preset: OWN_PRESET });

		const held = claims(chatId);
		expect(held.preset).toBe(OWN_PRESET);
		expect(held.impersonatePerspective).toBe('third');
		expect(held.steeringHistory).toEqual(['Older note.']);
	});
});

describe("a preset's control values", () => {
	const VALUES_KEY = 'presetControlValuesByPreset';
	const GLOBAL_KEY = 'presetControlValues';

	/** The stored row, as the next boot and every other device read it. */
	const row = (): string | null => server.settings.get(VALUES_KEY) ?? null;
	const bucket = (presetId: string): Record<string, unknown> => JSON.parse(row() ?? '{}')[presetId] ?? {};

	test('two presets sharing a macro name no longer share its value', async () => {
		// The whole point. Duplicating a preset is the normal way to get two documents
		// declaring the same macro, and while values were one flat map keyed by macro name,
		// tuning a knob for the chat on one silently rewrote the prompt of the chat on the
		// other, with nothing on either screen saying so.
		await presetControlsStore.initialize();

		presetControlsStore.setValue(APP_PRESET, 'tone', 'warm');
		presetControlsStore.setValue(OWN_PRESET, 'tone', 'cold');

		expect(presetControlsStore.valuesFor(APP_PRESET).tone).toBe('warm');
		expect(presetControlsStore.valuesFor(OWN_PRESET).tone).toBe('cold');
		// And what the send actually reads, which is the row rather than the cache.
		expect(await readPresetControlValues(APP_PRESET)).toEqual({ tone: 'warm' });
		expect(await readPresetControlValues(OWN_PRESET)).toEqual({ tone: 'cold' });
	});

	test('a preset nobody has tuned reads as every control on its default', async () => {
		await presetControlsStore.initialize();

		expect(presetControlsStore.valuesFor(OWN_PRESET)).toEqual({});
		expect(await readPresetControlValues(OWN_PRESET)).toEqual({});
	});

	test('an install that had tuned knobs keeps them, on every preset it holds', async () => {
		// The carry-over. Copying the whole flat map to each preset is what makes it exact:
		// every preset goes on resolving each macro to the value it resolved to yesterday,
		// and they diverge only from the next edit.
		server.settings.set(GLOBAL_KEY, JSON.stringify({ tone: 'warm', bannedPhrases: ['slop'] }));

		await presetControlsStore.initialize();

		expect(bucket(APP_PRESET)).toEqual({ tone: 'warm', bannedPhrases: ['slop'] });
		expect(bucket(OWN_PRESET)).toEqual({ tone: 'warm', bannedPhrases: ['slop'] });
		// Never destructive: the row it read is the reader's data and an older build still
		// reads it, so it is left exactly where it was.
		expect(server.settings.get(GLOBAL_KEY)).toBe(JSON.stringify({ tone: 'warm', bannedPhrases: ['slop'] }));
	});

	test('running it a second time changes nothing', async () => {
		server.settings.set(GLOBAL_KEY, JSON.stringify({ tone: 'warm' }));
		await presetControlsStore.initialize();
		const afterFirst = row();

		await presetControlsStore.initialize();

		expect(row()).toBe(afterFirst);
	});

	test('it never reaches a bucket that already exists', async () => {
		// The failure this class of change is guarded against: a re-fire would hand every
		// preset the old flat map again and wipe whatever the reader had tuned since.
		server.settings.set(GLOBAL_KEY, JSON.stringify({ tone: 'warm' }));
		await presetControlsStore.initialize();

		presetControlsStore.setValue(APP_PRESET, 'tone', 'cold');
		await presetControlsStore.syncReload();

		expect(presetControlsStore.valuesFor(APP_PRESET).tone).toBe('cold');
	});

	test('a preset made after the carry-over starts on its author defaults', async () => {
		// Writing the row IS the marker, so a preset imported later cannot inherit a
		// stranger's tuning off a flat map that is still sitting on disk.
		server.settings.set(GLOBAL_KEY, JSON.stringify({ tone: 'warm' }));
		await presetControlsStore.initialize();

		await presetService.createPreset('later-preset');
		await presetControlsStore.syncReload();

		expect(presetControlsStore.valuesFor('later-preset')).toEqual({});
		await presetService.deletePreset('later-preset');
	});

	test('a fresh install carries nothing across and still marks itself', async () => {
		await presetControlsStore.initialize();

		expect(row()).toBe('{}');
		expect(presetControlsStore.valuesFor(APP_PRESET)).toEqual({});
	});

	test("a deleted preset's tuning is kept, so restoring the preset restores it", async () => {
		// Same rule the adopted-setup key follows: an orphan bucket sits inert rather than
		// turning a delete into permanent loss of everything the reader had tuned.
		await presetControlsStore.initialize();
		presetControlsStore.setValue(OWN_PRESET, 'tone', 'cold');

		await presetService.deletePreset(OWN_PRESET);
		await presetControlsStore.syncReload();

		expect(presetControlsStore.valuesFor(OWN_PRESET).tone).toBe('cold');
	});
});
