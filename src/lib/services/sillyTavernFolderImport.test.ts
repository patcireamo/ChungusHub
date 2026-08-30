/**
 * What a folder import does with the lorebooks it meets. Run with `bun test`.
 *
 * SillyTavern keeps one shared book in two places at once: as a file under `worlds/`, and
 * embedded in the `character_book` of every card that uses it. A profile therefore offers the
 * same book once per card plus once as a file, and shelving each meeting is how a library of
 * twelve books arrives as forty. This locks the two answers that stop it: SillyTavern's own
 * `world` link, and the book's own substance.
 *
 * The real `characterLibraryStore` and `lorebookStore` run here, since the decision under test
 * lives inside them; only the leaves they write through are stubbed.
 *
 * Runes are compile-time macros and nothing compiles a store under bun test, so `$state` and
 * `$derived` are shimmed to identity BEFORE any store module loads, exactly as
 * transcript-refresh.test.ts does. Behaviour is under test; reactivity is not.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

const identity = <T>(value?: T): T | undefined => value;
(globalThis as unknown as { $state: unknown }).$state = Object.assign(identity, {
	raw: identity,
	snapshot: <T>(value: T): T => structuredClone(value)
});
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(identity, {
	by: <T>(fn: () => T): T => fn()
});

/**
 * Bun's module registry is process-wide and one run loads every test file into it, so a stub
 * left behind here is served to every file that loads after this one. Each mock is a SPREAD of
 * the real module and every one is put back in `afterAll`, with the restore registered BEFORE
 * the first stub goes in so a throw in the setup cannot leave one standing.
 */
const realDatabase = { ...(await import('$lib/services/database')) };
const realImages = { ...(await import('$lib/services/imageService')) };
const realChat = { ...(await import('$lib/stores/chat.svelte')) };

afterAll(() => {
	mock.module('$lib/services/database', () => realDatabase);
	mock.module('$lib/services/imageService', () => realImages);
	mock.module('$lib/stores/chat.svelte', () => realChat);
});

/** Every row the run wrote, so the shelf and the ledger can be read back. */
const written = {
	entries: new Map<string, { id: string; data: { lorebookIds?: string[] } }>(),
	books: [] as { id: string; name: string }[],
	claims: [] as { key: string; entityId?: string | null }[]
};

mock.module('$lib/services/database', () => ({
	...realDatabase,
	db: {
		insertLibraryEntry: async (entry: never) => void written.entries.set((entry as any).id, entry),
		updateLibraryEntry: async (entry: never) => void written.entries.set((entry as any).id, entry),
		insertLorebook: async (book: never) => void written.books.push(book),
		recordImportedSources: async (claims: never[]) => void written.claims.push(...claims)
	}
}));
mock.module('$lib/services/imageService', () => ({
	...realImages,
	imageService: { saveImage: async () => 'images/stub.png', copyImage: async () => null }
}));
mock.module('$lib/stores/chat.svelte', () => ({
	...realChat,
	chatStore: { importSillyTavernChat: async () => ({ chatId: null }) }
}));

const { importSillyTavernFolder } = await import('./sillyTavernFolderImport');
const { scanSillyTavernFolder } = await import('./sillyTavernFolderScan');
const { lorebookStore } = await import('$lib/lorebook/store.svelte');
const { characterLibraryStore } = await import('$lib/stores/characterLibrary.svelte');

/** A world file, in the shape SillyTavern writes one. */
function worldInfo(name: string, entries: { key: string[]; content: string }[]) {
	return {
		name,
		entries: Object.fromEntries(
			entries.map((entry, uid) => [
				String(uid),
				{ uid, key: entry.key, keysecondary: [], comment: entry.key[0], content: entry.content, order: 100 }
			])
		)
	};
}

/** The same book as a card carries it: renamed, re-ordered and under the spec's own field names. */
function characterBook(name: string, entries: { key: string[]; content: string }[]) {
	return {
		name,
		entries: [...entries].reverse().map((entry) => ({
			keys: entry.key,
			secondary_keys: [],
			comment: entry.key[0],
			content: entry.content,
			enabled: true,
			insertion_order: 100
		}))
	};
}

const KINGDOM = [
	{ key: ['dragon'], content: 'A great red wyrm.' },
	{ key: ['tower'], content: 'An arcane spire.' }
];
const SEA = [{ key: ['kraken'], content: 'It waits below.' }];

function card(name: string, extras: Record<string, unknown>) {
	return JSON.stringify({ spec: 'chara_card_v2', data: { name, description: `${name} is here.`, ...extras } });
}

/** The pick, as the browser hands one over: a flat list, each file carrying its path. */
function pick(files: { path: string; body: string }[]): File[] {
	return files.map(({ path, body }) => {
		const file = new File([body], path.split('/').pop() as string, { type: 'application/json' });
		Object.defineProperty(file, 'webkitRelativePath', { value: path });
		return file;
	});
}

const PROFILE = pick([
	{ path: 'default-user/worlds/Kingdom.json', body: JSON.stringify(worldInfo('Kingdom', KINGDOM)) },
	// Links to the world file by SillyTavern's own name for it, and carries a copy besides.
	{
		path: 'default-user/characters/Alice.json',
		body: card('Alice', { extensions: { world: 'Kingdom' }, character_book: characterBook('Kingdom Lorebook', KINGDOM) })
	},
	// The same book with no link to name it: only its substance says it is already here.
	{
		path: 'default-user/characters/Bob.json',
		body: card('Bob', { character_book: characterBook('Bob Lorebook', KINGDOM) })
	},
	// A book nothing in the profile holds, shared by two cards.
	{
		path: 'default-user/characters/Cara.json',
		body: card('Cara', { character_book: characterBook('Deep Sea', SEA) })
	},
	{
		path: 'default-user/characters/Dave.json',
		body: card('Dave', { character_book: characterBook('The Deep', SEA) })
	},
	// A book made in SillyTavern and attached there: the card names it and carries no copy, so
	// the link is the only thing that can bind it.
	{ path: 'default-user/characters/Finn.json', body: card('Finn', { extensions: { world: 'Kingdom' } }) }
]);

/** The books this run put on the shelf, which is what a fresh install would hold. */
const shelved = () => written.books;
const linksOf = (name: string): string[] => {
	const entry = [...written.entries.values()].find((e) => (e as any).identity?.name === name);
	return entry?.data.lorebookIds ?? [];
};

let report: Awaited<ReturnType<typeof importSillyTavernFolder>>;

beforeAll(async () => {
	report = await importSillyTavernFolder(scanSillyTavernFolder(PROFILE)!);
});

describe('a profile whose lorebook is on disk many times over', () => {
	test('shelves each book once, however many cards carry it', () => {
		expect(shelved().map((b) => b.name)).toEqual(['Kingdom', 'Deep Sea']);
		expect(lorebookStore.books).toHaveLength(2);
	});

	test('counts the book that only a card carried, since no row on the confirm card names it', () => {
		expect(report.worlds.imported).toBe(2);
		expect(report.worlds.fromCards).toBe(1);
		expect(report.worlds.failed).toEqual([]);
	});

	test('says how many characters bound to a book that was already here', () => {
		// Alice and Finn by SillyTavern's own link, Bob and Dave by what their book says.
		expect(report.worlds.linked).toBe(4);
	});

	test('binds every character to the one book, not to a copy of its own', () => {
		const kingdom = shelved()[0].id;
		const sea = shelved()[1].id;
		expect(linksOf('Alice')).toEqual([kingdom]);
		expect(linksOf('Bob')).toEqual([kingdom]);
		expect(linksOf('Cara')).toEqual([sea]);
		expect(linksOf('Dave')).toEqual([sea]);
		// Nothing was embedded in this one, so without the link it would arrive with no book.
		expect(linksOf('Finn')).toEqual([kingdom]);
	});

	// The world file is what a later run's cards bind to by name, and a book deleted by hand has
	// to stop counting so the file is offered again.
	test('claims a world file with the book it became', () => {
		const claim = written.claims.find((c) => c.key === 'sillytavern:worlds/Kingdom.json');
		expect(claim?.entityId).toBe(shelved()[0].id);
	});

	test('brings every character over regardless', () => {
		expect(report.characters.failed).toEqual([]);
		expect(report.characters.imported).toBe(5);
	});
});

describe('a second run, against what the first one left', () => {
	test('binds a card to the book an earlier run shelved, by the world it names', () => {
		const before = shelved().length;
		return importSillyTavernFolder(
			scanSillyTavernFolder(
				pick([
					{
						path: 'default-user/characters/Eve.json',
						body: card('Eve', {
							extensions: { world: 'Kingdom' },
							character_book: characterBook('Kingdom Lorebook', KINGDOM)
						})
					}
				])
			)!,
			{ claims: written.claims.map((c) => ({ key: c.key, entityId: c.entityId ?? null })) }
		).then((second) => {
			expect(shelved()).toHaveLength(before);
			expect(second.worlds.linked).toBe(1);
			expect(second.worlds.fromCards).toBe(0);
			expect(linksOf('Eve')).toEqual([shelved()[0].id]);
		});
	});
});
