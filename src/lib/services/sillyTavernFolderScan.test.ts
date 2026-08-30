import { describe, it, expect } from 'bun:test';
import {
	cardStemFromKey,
	countFiles,
	planGroups,
	readPersonaSettings,
	scanSillyTavernFolder,
	sourceKey,
	strandedByChoice,
	withoutKeys,
	worldStemFromKey
} from './sillyTavernFolderScan';

/** A picked file, spelled the way the browser hands one over: a flat list, each entry carrying
 *  its path relative to the folder that was chosen, that folder's own name included. */
function pick(paths: string[]): File[] {
	return paths.map((path) => {
		const file = new File(['x'], path.split('/').pop() as string);
		Object.defineProperty(file, 'webkitRelativePath', { value: path });
		return file;
	});
}

/** The profile folder, which is the one thing this reads. */
const PROFILE = [
	'default-user/settings.json',
	'default-user/characters/Alice.png',
	'default-user/characters/Bob.json',
	'default-user/characters/Alice/joy.png',
	'default-user/characters/Alice/anger.png',
	'default-user/worlds/Kingdom.json',
	'default-user/backgrounds/tavern.jpg',
	'default-user/User Avatars/me.png',
	'default-user/chats/Alice/2026-01-01.jsonl',
	'default-user/backups/chat_Alice_2026.jsonl'
];

describe('scanSillyTavernFolder', () => {
	it('reads the profile folder it was pointed at', () => {
		const scan = scanSillyTavernFolder(pick(PROFILE));
		expect(scan).not.toBeNull();
		expect(scan!.root).toBe('default-user');
		expect(scan!.characters.map((f) => f.name).sort()).toEqual(['Alice.png', 'Bob.json']);
		expect(scan!.spritesByFolder.get('Alice')?.length).toBe(2);
		expect(scan!.worlds.map((f) => f.name)).toEqual(['Kingdom.json']);
		expect(scan!.backgrounds.length).toBe(1);
		expect(scan!.avatars.length).toBe(1);
		expect(scan!.chats.map((c) => c.characterName)).toEqual(['Alice']);
		expect(scan!.settingsFile?.name).toBe('settings.json');
	});

	it('takes chat backups for what they are, not for chats', () => {
		expect(scanSillyTavernFolder(pick(PROFILE))!.chats.length).toBe(1);
	});

	it('refuses an ancestor rather than going looking inside it', () => {
		const checkout = [
			'SillyTavern/package.json',
			'SillyTavern/node_modules/sharp/characters/thing.png',
			'SillyTavern/default/content/characters/Seraphina.png',
			...PROFILE.map((p) => `SillyTavern/data/${p}`)
		];
		expect(scanSillyTavernFolder(pick(checkout))).toBeNull();
		expect(scanSillyTavernFolder(pick(PROFILE.map((p) => `data/${p}`)))).toBeNull();
	});

	it('refuses one known folder picked on its own, which is not a profile', () => {
		expect(scanSillyTavernFolder(pick(['characters/Alice.png', 'characters/Bob.json']))).toBeNull();
	});

	it('reads a known name as a folder on the way, never as the file itself', () => {
		const scan = scanSillyTavernFolder(pick(['Lib/worlds/chats', 'Lib/characters/Alice.png']));
		expect(scan!.worlds.length).toBe(0);
		expect(scan!.chats.length).toBe(0);
		expect(scan!.characters.length).toBe(1);
	});

	it('answers null rather than an empty import when nothing is recognizable', () => {
		expect(scanSillyTavernFolder(pick(['Downloads/holiday.png', 'Downloads/notes.txt']))).toBeNull();
	});
});

describe('the import ledger', () => {
	it('names a file by its path inside the pick, so a renamed copy is the same library', () => {
		const scan = scanSillyTavernFolder(pick(PROFILE))!;
		expect(sourceKey(scan.root, scan.characters[0])).toBe('sillytavern:characters/Alice.png');

		const moved = scanSillyTavernFolder(
			pick(PROFILE.map((p) => p.replace('default-user/', 'ST-backup/')))
		)!;
		expect(sourceKey(moved.root, moved.characters[0])).toBe('sillytavern:characters/Alice.png');
	});

	it('takes out what has come over before, sprite by sprite', () => {
		const scan = scanSillyTavernFolder(pick(PROFILE))!;
		expect(countFiles(scan)).toBe(8);

		const fresh = withoutKeys(
			scan,
			new Set([
				'sillytavern:characters/Alice.png',
				'sillytavern:characters/Alice/joy.png',
				'sillytavern:chats/Alice/2026-01-01.jsonl'
			])
		);
		expect(fresh.characters.map((f) => f.name)).toEqual(['Bob.json']);
		expect(fresh.spritesByFolder.get('Alice')?.map((f) => f.name)).toEqual(['anger.png']);
		expect(fresh.chats.length).toBe(0);
		expect(countFiles(fresh)).toBe(5);
		// The persona names are read from it on every run, so it is never claimed or filtered.
		expect(fresh.settingsFile).toBe(scan.settingsFile);
	});

	it('drops a sprite folder whose whole pack is already here', () => {
		const scan = scanSillyTavernFolder(pick(PROFILE))!;
		const fresh = withoutKeys(
			scan,
			new Set(['sillytavern:characters/Alice/joy.png', 'sillytavern:characters/Alice/anger.png'])
		);
		expect(fresh.spritesByFolder.size).toBe(0);
	});

	it('leaves everything standing when the ledger is empty', () => {
		const scan = scanSillyTavernFolder(pick(PROFILE))!;
		expect(countFiles(withoutKeys(scan, new Set()))).toBe(countFiles(scan));
	});

	// The confirm card asks the same filter with what the reader switched off, so the two
	// narrowings compose into one bundle rather than into a bundle plus instructions.
	it('narrows a second time for the reader, on top of the ledger', () => {
		const scan = scanSillyTavernFolder(pick(PROFILE))!;
		const fresh = withoutKeys(scan, new Set(['sillytavern:characters/Alice.png']));
		const chosen = withoutKeys(fresh, new Set(['sillytavern:backgrounds/tavern.jpg']));
		expect(chosen.characters.map((f) => f.name)).toEqual(['Bob.json']);
		expect(chosen.backgrounds.length).toBe(0);
		expect(countFiles(chosen)).toBe(countFiles(fresh) - 1);
	});

	// What a later run binds this folder's chats and sprites with: the card's own filename,
	// never the character's display name, which collides on SillyTavern's Jason / Jason_1 pairs.
	it('reads a card key back as its filename stem, and nothing else as one', () => {
		expect(cardStemFromKey('sillytavern:characters/Jason_1.png')).toBe('jason_1');
		expect(cardStemFromKey('sillytavern:characters/Bob.json')).toBe('bob');
		expect(cardStemFromKey('sillytavern:characters/Jason/joy.png')).toBeNull();
		expect(cardStemFromKey('sillytavern:chats/Jason/2026.jsonl')).toBeNull();
		expect(cardStemFromKey('sillytavern:backgrounds/tavern.jpg')).toBeNull();
	});

	// A world file is named after the book in it, and a card links to that book by the same
	// name, so this is what binds a later run's cards to a book already on the shelf.
	it('reads a world key back as the name a card would link to', () => {
		expect(worldStemFromKey('sillytavern:worlds/Kingdom.json')).toBe('kingdom');
		expect(worldStemFromKey('sillytavern:worlds/A Long Name.json')).toBe('a long name');
		expect(worldStemFromKey('sillytavern:characters/Kingdom.json')).toBeNull();
		expect(worldStemFromKey('sillytavern:worlds/nested/Kingdom.json')).toBeNull();
	});
});

describe('planGroups', () => {
	it('names every row off a path, so nothing has to be opened to draw the card', () => {
		const groups = planGroups(scanSillyTavernFolder(pick(PROFILE))!);
		const byId = new Map(groups.map((g) => [g.id, g]));

		expect(byId.get('characters')!.items.map((i) => i.label).sort()).toEqual(['Alice', 'Bob']);
		expect(byId.get('worlds')!.items.map((i) => i.label)).toEqual(['Kingdom']);
		expect(byId.get('backgrounds')!.items.map((i) => i.label)).toEqual(['tavern']);
		expect(byId.get('personas')!.items.map((i) => i.label)).toEqual(['me']);
	});

	// A persona's name lives in settings.json, so it is the one label that has to be handed in,
	// and it falls back to the filename exactly as the import itself does.
	it('names a persona what the import will name it', () => {
		const scan = scanSillyTavernFolder(
			pick(['default-user/User Avatars/me.png', 'default-user/User Avatars/spare.png'])
		)!;
		const labelled = planGroups(scan, { personas: { 'me.png': ' Anon ' } });
		expect(labelled[0].items.map((i) => i.label)).toEqual(['Anon', 'spare']);

		const unlabelled = planGroups(scan, { personas: { 'me.png': '  ' } });
		expect(unlabelled[0].items.map((i) => i.label)).toEqual(['me', 'spare']);
	});

	it('makes a sprite pack and a character history one row each, carrying all their keys', () => {
		const groups = planGroups(scanSillyTavernFolder(pick(PROFILE))!);
		const sprites = groups.find((g) => g.id === 'sprites')!;
		expect(sprites.items).toHaveLength(1);
		expect(sprites.items[0].label).toBe('Alice');
		expect(sprites.items[0].keys.sort()).toEqual([
			'sillytavern:characters/Alice/anger.png',
			'sillytavern:characters/Alice/joy.png'
		]);

		const chats = groups.find((g) => g.id === 'chats')!;
		expect(chats.items).toHaveLength(1);
		expect(chats.items[0].label).toBe('Alice');
		expect(chats.items[0].keys).toEqual(['sillytavern:chats/Alice/2026-01-01.jsonl']);
	});

	it('drops an empty group rather than drawing a heading nothing sits under', () => {
		const scan = scanSillyTavernFolder(pick(['Lib/characters/Alice.png']))!;
		expect(planGroups(scan).map((g) => g.id)).toEqual(['characters']);
	});

	it('gives every row a key nothing else in its group holds', () => {
		const groups = planGroups(scanSillyTavernFolder(pick(PROFILE))!);
		for (const group of groups) {
			const ids = group.items.map((item) => item.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	// Selecting a row is selecting its files, so the rows must add up to the whole bundle or
	// something in the folder would be unreachable from the card that claims to list it.
	it('accounts for every file the import would write', () => {
		const scan = scanSillyTavernFolder(pick(PROFILE))!;
		const keys = planGroups(scan).flatMap((g) => g.items.flatMap((i) => i.keys));
		expect(keys).toHaveLength(countFiles(scan));
		expect(new Set(keys).size).toBe(countFiles(scan));
	});
});

describe('readPersonaSettings', () => {
	it('reads both halves of a persona identity, keyed by avatar filename', () => {
		const settings = JSON.stringify({
			power_user: {
				personas: { 'anon.png': 'Anon', 'user-default.png': 'Traveller' },
				persona_descriptions: { 'anon.png': { description: 'Quiet type' } }
			},
			// The rest of a real settings.json, which is most of it, is not ours to read.
			theme: 'Dark Lite'
		});
		expect(readPersonaSettings(settings)).toEqual({
			names: { 'anon.png': 'Anon', 'user-default.png': 'Traveller' },
			descriptions: { 'anon.png': 'Quiet type' }
		});
	});

	it('answers empty rather than undefined for a profile that names no persona', () => {
		expect(readPersonaSettings('{}')).toEqual({ names: {}, descriptions: {} });
		expect(readPersonaSettings(JSON.stringify({ power_user: {} }))).toEqual({
			names: {},
			descriptions: {}
		});
	});

	it('drops a description entry that carries no description', () => {
		const settings = JSON.stringify({
			power_user: { persona_descriptions: { 'anon.png': { position: 0 } } }
		});
		expect(readPersonaSettings(settings).descriptions).toEqual({});
	});

	// The run reports this in its own words rather than importing personas under half a file.
	it('throws on a settings file that will not parse', () => {
		expect(() => readPersonaSettings('{ not json')).toThrow();
	});
});

describe('strandedByChoice', () => {
	const ORPHANS = scanSillyTavernFolder(
		pick([
			'default-user/chats/Alice/one.jsonl',
			'default-user/chats/Alice/two.jsonl',
			'default-user/characters/Alice/joy.png',
			'default-user/characters/Alice/anger.png'
		])
	)!;

	it('counts chats as files and sprite packs as folders, matching what the run reports', () => {
		// Alice is on the card and switched off: two chats and one pack, all fixable by a tick.
		expect(strandedByChoice(ORPHANS, new Set(), new Set(['alice']))).toEqual({
			chats: 2,
			sprites: 1
		});
	});

	it('is silent once the character resolves, whatever case the folder is spelled in', () => {
		expect(strandedByChoice(ORPHANS, new Set(['alice']), new Set(['alice']))).toEqual({
			chats: 0,
			sprites: 0
		});
	});

	// A card deleted in SillyTavern leaves its chat folder behind. Nothing on the confirm card
	// would switch that character on, so warning about it is a sentence with no answer to it.
	it('says nothing about a folder whose character is not in the profile at all', () => {
		expect(strandedByChoice(ORPHANS, new Set(), new Set())).toEqual({ chats: 0, sprites: 0 });
	});
});
