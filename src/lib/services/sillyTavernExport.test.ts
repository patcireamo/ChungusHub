import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { buildCharacterFiles, buildSillyTavernCard, embedCardInPng } from './sillyTavernExport';
import { importSillyTavernCard } from './sillyTavernImport';
import type { CharacterVersion, LibraryEntry, LibraryEntryData } from '$lib/types/library';

function makeData(over: Partial<LibraryEntryData['traits']> = {}): LibraryEntryData {
	return {
		traits: {
			description: 'A weathered sailor.',
			personality: 'gruff',
			background: 'raised at sea',
			firstMessage: 'Ahoy.',
			exampleDialogue: '<START>\n{{char}}: Arr.',
			scenario: 'on a ship',
			systemPrompt: 'stay in character',
			postHistoryInstructions: 'keep it tense',
			characterVersion: '1.0',
			creator: 'me',
			creatorNotes: 'notes',
			...over
		},
		traitLabels: { description: 'Bio' },
		hiddenTraits: ['background'],
		alternateGreetings: ['Yarr.']
	};
}

function makeEntry(over: Partial<LibraryEntry> = {}): LibraryEntry {
	return {
		id: 'entry-1',
		type: 'character',
		identity: { name: 'Redbeard', tags: ['pirate'] },
		data: makeData(),
		isFavorite: false,
		createdAt: 1,
		updatedAt: 2,
		...over
	};
}

/** Minimal structurally-valid PNG (bogus CRCs, since neither writer nor reader validates them). */
function minimalPng(extraChunks: Uint8Array[] = []): Uint8Array {
	const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const out = new Uint8Array(12 + data.length);
		new DataView(out.buffer).setUint32(0, data.length);
		for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
		out.set(data, 8);
		return out;
	};
	const ihdr = chunk('IHDR', new Uint8Array(13));
	const iend = chunk('IEND', new Uint8Array(0));
	const parts = [sig, ihdr, ...extraChunks, iend];
	const total = parts.reduce((s, p) => s + p.length, 0);
	const png = new Uint8Array(total);
	let pos = 0;
	for (const p of parts) {
		png.set(p, pos);
		pos += p.length;
	}
	return png;
}

/** Independent CRC-32 (verified against known vectors below): cross-checks production output. */
function refCrc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc ^= bytes[i];
		for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Walk PNG chunks and return the first of `type` as its (type+data) range and stored CRC. */
function findChunk(png: Uint8Array, type: string): { typeAndData: Uint8Array; storedCrc: number } | null {
	const dec = new TextDecoder('latin1');
	let offset = 8;
	while (offset + 8 <= png.length) {
		const len = ((png[offset] << 24) | (png[offset + 1] << 16) | (png[offset + 2] << 8) | png[offset + 3]) >>> 0;
		const t = dec.decode(png.subarray(offset + 4, offset + 8));
		if (t === type) {
			const typeAndData = png.subarray(offset + 4, offset + 8 + len);
			const view = new DataView(png.buffer, png.byteOffset + offset + 8 + len, 4);
			return { typeAndData, storedCrc: view.getUint32(0) };
		}
		offset += 12 + len;
	}
	return null;
}

function charaTextChunk(text: string): Uint8Array {
	const enc = new TextEncoder();
	const keyword = enc.encode('chara');
	const body = enc.encode(text);
	const data = new Uint8Array(keyword.length + 1 + body.length);
	data.set(keyword, 0);
	data[keyword.length] = 0;
	data.set(body, keyword.length + 1);
	const out = new Uint8Array(12 + data.length);
	new DataView(out.buffer).setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = 'tEXt'.charCodeAt(i);
	out.set(data, 8);
	return out;
}

describe('SillyTavern card export', () => {
	test('maps traits onto standard V2 fields and mirrors them at the top level', () => {
		const card = buildSillyTavernCard(makeEntry(), [], 'all');
		expect(card.spec).toBe('chara_card_v2');
		expect(card.data.name).toBe('Redbeard');
		expect(card.data.description).toBe('A weathered sailor.');
		expect(card.data.first_mes).toBe('Ahoy.');
		expect(card.data.system_prompt).toBe('stay in character');
		expect(card.data.post_history_instructions).toBe('keep it tense');
		expect(card.data.character_version).toBe('1.0');
		expect(card.data.tags).toEqual(['pirate']);
		expect(card.data.alternate_greetings).toEqual(['Yarr.']);
		// Top-level mirror for V2-unaware readers.
		expect(card.description).toBe('A weathered sailor.');
		expect(card.first_mes).toBe('Ahoy.');
	});

	test('unversioned export embeds data but no versions array', () => {
		const card = buildSillyTavernCard(makeEntry(), [], 'all');
		const block = card.data.extensions.chungushub;
		expect(block.format).toBe('chungushub.libraryEntry');
		expect(block.data.traits.description).toBe('A weathered sailor.');
		expect(block.versions).toBeUndefined();
		expect(block.activeVersionId).toBeUndefined();
	});

	test('"all" surfaces the active version and embeds every version', () => {
		const versions: CharacterVersion[] = [
			{ id: 'v1', entryId: 'entry-1', name: 'Original', data: makeData({ description: 'Old bio.' }), createdAt: 1, updatedAt: 1 },
			{ id: 'v2', entryId: 'entry-1', name: 'Pirate', data: makeData({ description: 'Pirate bio.' }), createdAt: 2, updatedAt: 2 }
		];
		const entry = makeEntry({ activeVersionId: 'v2', data: makeData({ description: 'Pirate bio.' }) });
		const card = buildSillyTavernCard(entry, versions, 'all');
		// Surface = active version.
		expect(card.data.description).toBe('Pirate bio.');
		const block = card.data.extensions.chungushub;
		expect(block.versions?.map((v) => v.name)).toEqual(['Original', 'Pirate']);
		expect(block.activeVersionId).toBe('v2');
	});

	// The editor's New Chat Defaults card tells the reader in as many words that nothing in it
	// is written into an exported card. Only the explicit shape `buildExportBlock` copies keeps
	// that true, so this searches the whole serialized card rather than a list of fields: a
	// second default added beside `data` would otherwise ride out silently and make the line lie.
	test('a chat default never leaves with the card', () => {
		const entry = makeEntry({
			defaultPersonaId: 'persona-7',
			defaultConnectionId: 'connection-7',
			defaultVersionId: 'version-7'
		});
		const serialized = JSON.stringify(buildSillyTavernCard(entry, [], 'all'));
		for (const seed of ['persona-7', 'connection-7', 'version-7']) {
			expect(serialized).not.toContain(seed);
		}
		for (const key of ['defaultPersonaId', 'defaultConnectionId', 'defaultVersionId']) {
			expect(serialized).not.toContain(key);
		}
	});

	test('a specific version surfaces only that version and embeds no version list', () => {
		const versions: CharacterVersion[] = [
			{ id: 'v1', entryId: 'entry-1', name: 'Original', data: makeData({ description: 'Old bio.' }), createdAt: 1, updatedAt: 1 },
			{ id: 'v2', entryId: 'entry-1', name: 'Pirate', data: makeData({ description: 'Pirate bio.' }), createdAt: 2, updatedAt: 2 }
		];
		const entry = makeEntry({ activeVersionId: 'v2', data: makeData({ description: 'Pirate bio.' }) });
		const card = buildSillyTavernCard(entry, versions, 'v1');
		expect(card.data.description).toBe('Old bio.');
		expect(card.data.extensions.chungushub.versions).toBeUndefined();
	});
});

describe('archive layout (bulk / pictures)', () => {
	const TEXT_ONLY = { format: 'json' as const, includeGallery: false, includeSprites: false };

	// Every stored picture answers as one byte of PNG: the layout is what these tests are about,
	// and the bytes only have to survive into the entry.
	const realFetch = globalThis.fetch;
	beforeAll(() => {
		globalThis.fetch = (async () =>
			new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }))) as typeof fetch;
	});
	afterAll(() => {
		globalThis.fetch = realFetch;
	});

	test('same-named characters get (2), (3) bases sharing one usedBases set', async () => {
		const used = new Set<string>();
		const names = [];
		for (let i = 0; i < 3; i++) {
			const files = await buildCharacterFiles(makeEntry({ identity: { name: 'Asami', tags: [] } }), [], 'all', TEXT_ONLY, used);
			names.push(...files.map((f) => f.name));
		}
		expect(names).toEqual(['Asami.json', 'Asami(2).json', 'Asami(3).json']);
	});

	test('a distinct name is untouched', async () => {
		const used = new Set<string>(['Asami']);
		const files = await buildCharacterFiles(makeEntry({ identity: { name: 'Bolin', tags: [] } }), [], 'all', TEXT_ONLY, used);
		expect(files.map((f) => f.name)).toEqual(['Bolin.json']);
	});

	test('a nameless character exports as its display name, not "entry"', async () => {
		const files = await buildCharacterFiles(makeEntry({ identity: { name: '', tags: [] } }), [], 'all', TEXT_ONLY, new Set());
		expect(files.map((f) => f.name)).toEqual(['Unnamed Character.json']);
	});

	test('spaces in names survive into the filename', async () => {
		const files = await buildCharacterFiles(makeEntry({ identity: { name: 'Asami  Sato', tags: [] } }), [], 'all', TEXT_ONLY, new Set());
		expect(files.map((f) => f.name)).toEqual(['Asami Sato.json']);
	});

	test('sprites land flat in the card folder under their labels, gallery one level below', async () => {
		const entry = makeEntry({
			identity: {
				name: 'Asami',
				tags: [],
				gallery: ['images/characters/g1.jpg'],
				sprites: [
					{ path: 'images/characters/s1.png', label: 'neutral' },
					{ path: 'images/characters/s2.png', label: 'quiet anger' }
				]
			}
		});
		const files = await buildCharacterFiles(entry, [], 'all', { format: 'json', includeGallery: true, includeSprites: true }, new Set());
		// The flat folder is SillyTavern's sprite layout, so gallery art must not share it.
		expect(files.map((f) => f.name)).toEqual([
			'Asami.json',
			'Asami/neutral.png',
			'Asami/quiet anger.png',
			'Asami/gallery/1.jpg'
		]);
	});

	test('two labels that sanitize alike stay separate files', async () => {
		const entry = makeEntry({
			identity: {
				name: 'Asami',
				tags: [],
				sprites: [
					{ path: 'images/characters/s1.png', label: 'joy' },
					{ path: 'images/characters/s2.png', label: 'joy!' }
				]
			}
		});
		const files = await buildCharacterFiles(entry, [], 'all', { format: 'json', includeGallery: false, includeSprites: true }, new Set());
		expect(files.map((f) => f.name)).toEqual(['Asami.json', 'Asami/joy.png', 'Asami/joy(2).png']);
	});

	test('an unticked set is not fetched at all', async () => {
		const entry = makeEntry({
			identity: {
				name: 'Asami',
				tags: [],
				gallery: ['images/characters/g1.jpg'],
				sprites: [{ path: 'images/characters/s1.png', label: 'neutral' }]
			}
		});
		const files = await buildCharacterFiles(entry, [], 'all', { format: 'json', includeGallery: false, includeSprites: true }, new Set());
		expect(files.map((f) => f.name)).toEqual(['Asami.json', 'Asami/neutral.png']);
	});
});

describe('SillyTavern PNG round-trip', () => {
	test('embeds a card that the importer reads back with all versions', async () => {
		const versions: CharacterVersion[] = [
			{ id: 'v1', entryId: 'entry-1', name: 'Original', data: makeData({ description: 'Old bio.' }), createdAt: 1, updatedAt: 1 },
			{ id: 'v2', entryId: 'entry-1', name: 'Pirate', data: makeData({ description: 'Pirate bio.' }), createdAt: 2, updatedAt: 2 }
		];
		const entry = makeEntry({ activeVersionId: 'v2', data: makeData({ description: 'Pirate bio.' }) });
		const card = buildSillyTavernCard(entry, versions, 'all');
		const png = embedCardInPng(minimalPng(), card);
		const file = new File([png], 'redbeard.png', { type: 'image/png' });

		const result = await importSillyTavernCard(file);
		expect(result.character.name).toBe('Redbeard');
		expect(result.character.traits.description).toBe('Pirate bio.');
		expect(result.character.traitLabels?.description).toBe('Bio');
		expect(result.character.hiddenTraits).toEqual(['background']);
		expect(result.versions?.map((v) => v.name)).toEqual(['Original', 'Pirate']);
		expect(result.versions?.find((v) => v.active)?.name).toBe('Pirate');
		expect(result.imageFile).toBe(file);
	});

	test('strips a stale chara chunk so only the fresh card is read', async () => {
		const stale = charaTextChunk('deadbeef-not-base64-of-anything');
		const card = buildSillyTavernCard(makeEntry(), [], 'all');
		const png = embedCardInPng(minimalPng([stale]), card);
		const file = new File([png], 'redbeard.png', { type: 'image/png' });

		const result = await importSillyTavernCard(file);
		expect(result.character.name).toBe('Redbeard');
		expect(result.character.traits.description).toBe('A weathered sailor.');
	});

	test('produces a structurally valid PNG with a correct chara-chunk CRC', () => {
		// Guard the reference CRC itself against a classic known vector.
		expect(refCrc32(new Uint8Array([0x49, 0x45, 0x4e, 0x44]))).toBe(0xae426082);

		const card = buildSillyTavernCard(makeEntry(), [], 'all');
		const png = embedCardInPng(minimalPng(), card);
		expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(new TextDecoder('latin1').decode(png.subarray(png.length - 8, png.length - 4))).toBe('IEND');

		const chunk = findChunk(png, 'tEXt');
		expect(chunk).not.toBeNull();
		// A wrong byte range or a broken CRC in the writer would fail here: real PNG readers
		// (SillyTavern included) reject a chunk whose stored CRC doesn't match.
		expect(refCrc32(chunk!.typeAndData)).toBe(chunk!.storedCrc);
	});

	test('JSON export round-trips a single version through the importer', async () => {
		const card = buildSillyTavernCard(makeEntry(), [], 'all');
		const file = new File([JSON.stringify(card)], 'redbeard.json', { type: 'application/json' });
		const result = await importSillyTavernCard(file);
		expect(result.character.name).toBe('Redbeard');
		expect(result.versions).toBeUndefined();
		expect(result.imageFile).toBeNull();
	});
});
