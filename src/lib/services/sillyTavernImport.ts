/**
 * SillyTavern Character Card Import Service
 * Handles importing character cards from PNG (with embedded JSON) and JSON files.
 *
 * PNG cards store character data as base64 JSON in the "chara" tEXt chunk.
 * JSON files follow the SillyTavern V2 character card spec.
 */

import type { LibrarySeed, CharacterTraits, LibraryEntryData } from '$lib/types/library';
import type { ExportedLibraryEntry } from '$lib/services/libraryExport';
import type { Lorebook } from '$lib/lorebook/types';
import { lorebookFromCharacterBook } from '$lib/lorebook/sillytavern';
import { decodeBase64Utf8, readTextChunk } from '$lib/services/pngText';

/** SillyTavern character card V2 format */
interface SillyTavernCharacter {
	name?: string;
	description?: string;
	personality?: string;
	scenario?: string;
	first_mes?: string;
	mes_example?: string;
	creator_notes?: string;
	system_prompt?: string;
	post_history_instructions?: string;
	tags?: string[];
	creator?: string;
	character_version?: string;
	alternate_greetings?: string[];
	character_book?: Record<string, unknown>;
	extensions?: Record<string, unknown>;
	// V2 spec fields
	spec?: string;
	spec_version?: string;
	data?: {
		name?: string;
		description?: string;
		personality?: string;
		scenario?: string;
		first_mes?: string;
		mes_example?: string;
		creator_notes?: string;
		system_prompt?: string;
		post_history_instructions?: string;
		tags?: string[];
		creator?: string;
		character_version?: string;
		alternate_greetings?: string[];
		character_book?: Record<string, unknown>;
		extensions?: Record<string, unknown>;
	};
}

export interface ImportResult {
	character: LibrarySeed;
	/** Which library shelf this entry belongs on. SillyTavern cards are always characters. */
	entryType: 'character' | 'persona';
	/** The raw PNG file for image extraction (null if JSON import) */
	imageFile: File | null;
	/** Embedded character_book (SillyTavern lorebook), parsed into a standalone book. */
	lorebook: Lorebook | null;
	/**
	 * The world info book this card LINKS to, under SillyTavern's own name for it
	 * (`extensions.world`). That name is a world file's name, so only an importer holding a
	 * `worlds/` folder can resolve it; a card picked on its own has nothing to resolve it
	 * against and leaves it alone.
	 */
	worldName: string | null;
	/** Character versions from a ChungusHub v2 export, in order, recreated with fresh
	 *  ids on import. Exactly one carries `active`. Absent for SillyTavern cards and v1. */
	versions?: { name: string; data: LibraryEntryData; active: boolean }[];
}

/** True for our ChungusHub-native block: a legacy top-level JSON export or the
 *  `extensions.chungushub` block embedded in a SillyTavern card. */
function isChungusExport(parsed: unknown): parsed is ExportedLibraryEntry {
	return (
		!!parsed &&
		typeof parsed === 'object' &&
		(parsed as { format?: unknown }).format === 'chungushub.libraryEntry'
	);
}

/** Turn a "data:...;base64,..." URL into a File so it can flow through the normal image save.
 *  A malformed URL throws: the export carried a portrait, and importing the entry without it
 *  while reporting success leaves the user hunting for an image the file actually had. */
async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
	const blob = await fetch(dataUrl).then((r) => r.blob());
	return new File([blob], name, { type: blob.type || 'image/png' });
}

/** Map one of our own exports back onto a seed, preserving every field the seed can hold. */
async function importChungusExport(entry: ExportedLibraryEntry): Promise<ImportResult> {
	const name = entry.identity?.name || '';
	const character: LibrarySeed = {
		id: crypto.randomUUID(),
		name,
		tags: entry.identity?.tags ? [...entry.identity.tags] : [],
		traits: entry.data?.traits ?? { personality: '', description: '', background: '' },
		traitLabels: entry.data?.traitLabels,
		hiddenTraits: entry.data?.hiddenTraits,
		alternateGreetings: entry.data?.alternateGreetings
	};
	const imageFile = entry.image ? await dataUrlToFile(entry.image, `${name || 'entry'}.png`) : null;
	// v2 exports carry every variant of a versioned character; ids are only used to spot
	// the active one. The importer mints fresh rows. Lorebook ids are this-install-only
	// (books don't travel in the export), so they're dropped like the main data's are.
	const versions = entry.versions?.length
		? entry.versions.map((v) => ({
				name: v.name,
				data: { ...v.data, lorebookIds: undefined },
				active: v.id === entry.activeVersionId
			}))
		: undefined;
	return {
		character,
		entryType: entry.type === 'persona' ? 'persona' : 'character',
		imageFile,
		// Embedded lorebooks don't travel in our export (only ids), so nothing to bring in here,
		// and nothing here names a SillyTavern world either.
		lorebook: null,
		worldName: null,
		...(versions ? { versions } : {})
	};
}

/**
 * Parse a PNG file to extract the "chara" tEXt chunk containing character data.
 * The chunk walk itself lives in `pngText.ts`, shared with the writer that produced it.
 */
async function extractCharaFromPng(file: File): Promise<string | null> {
	return readTextChunk(new Uint8Array(await file.arrayBuffer()), 'chara');
}

/**
 * Parse SillyTavern character data and map it onto our character fields. Every core card
 * field (including system_prompt, post_history_instructions and character_version) is now
 * a first-class permanent field, so a plain import preserves the whole card straight onto
 * traits. Whether each field reaches the prompt is decided by the active preset's macros.
 */
function mapSillyTavernToCharacter(stChar: SillyTavernCharacter): LibrarySeed {
	// Handle V2 format where data is nested
	const charData = stChar.data || stChar;

	const traits: CharacterTraits = {
		description: charData.description || '',
		firstMessage: charData.first_mes || '',
		creator: charData.creator || '',
		creatorNotes: charData.creator_notes || '',
		personality: charData.personality || '',
		scenario: charData.scenario || '',
		exampleDialogue: charData.mes_example || '',
		systemPrompt: charData.system_prompt || '',
		postHistoryInstructions: charData.post_history_instructions || '',
		characterVersion: charData.character_version || '',
		background: ''
	};

	const alternateGreetings = (charData.alternate_greetings ?? [])
		.map((g) => (g ?? '').trim())
		.filter((g) => g.length > 0);

	return {
		id: crypto.randomUUID(),
		name: charData.name || '',
		traits,
		tags: charData.tags || [],
		...(alternateGreetings.length ? { alternateGreetings } : {})
	};
}

/**
 * The world info book the card links to, by name.
 *
 * The one card field read outside `mapSillyTavernToCharacter`, and it is not a trait: it names
 * a file in the same profile rather than describing the character, so it stays a claim about
 * the folder for whoever holds one to resolve.
 */
function readWorldName(stChar: SillyTavernCharacter): string | null {
	const world = stChar.data?.extensions?.world ?? stChar.extensions?.world;
	return typeof world === 'string' && world.trim() ? world.trim() : null;
}

/**
 * Import a SillyTavern character card from a File.
 * Supports both PNG (with embedded JSON) and JSON files.
 */
export async function importSillyTavernCard(file: File): Promise<ImportResult> {
	const isJson = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
	const isPng = file.name.toLowerCase().endsWith('.png') || file.type === 'image/png';

	if (!isJson && !isPng) {
		throw new Error('Unsupported file type. Please use a PNG or JSON character card.');
	}

	let jsonData: string;
	let imageFile: File | null = null;

	if (isPng) {
		// Extract character data from PNG tEXt chunk
		const charaData = await extractCharaFromPng(file);
		if (!charaData) {
			throw new Error('No character data found in PNG. Is this a valid SillyTavern character card?');
		}

		// Decode base64 to JSON (with proper UTF-8 support)
		try {
			jsonData = decodeBase64Utf8(charaData);
		} catch {
			// Might not be base64 encoded
			jsonData = charaData;
		}

		// Keep the PNG for image extraction
		imageFile = file;
	} else {
		// Read JSON file with explicit UTF-8 decoding
		const buffer = await file.arrayBuffer();
		jsonData = new TextDecoder('utf-8').decode(buffer);
	}

	// Parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonData);
	} catch {
		throw new Error('Invalid JSON in character card.');
	}

	// Our legacy top-level JSON export round-trips through a dedicated mapper (SillyTavern's
	// shape would misread its top-level `data` key as the card body and yield an empty character).
	if (isChungusExport(parsed)) {
		return importChungusExport(parsed);
	}

	const stChar = parsed as SillyTavernCharacter;

	// A ChungusHub-exported ST card carries our native fidelity block in `extensions.chungushub`
	// (versions, trait labels, hidden traits). Route it through the same mapper as our JSON export
	// so nothing is lost: the card's standard fields are just SillyTavern's clean view of the
	// active version. The portrait rides in the PNG (the block's own image is always null).
	const embedded = stChar.data?.extensions?.chungushub ?? stChar.extensions?.chungushub;
	if (isChungusExport(embedded)) {
		const result = await importChungusExport(embedded);
		return { ...result, imageFile };
	}

	// Map to our format
	const character = mapSillyTavernToCharacter(stChar);

	// Pull an embedded character_book (V2/V3) into a standalone lorebook, if present.
	const rawBook = stChar.data?.character_book ?? stChar.character_book;
	const lorebook =
		rawBook && typeof rawBook === 'object'
			? lorebookFromCharacterBook(rawBook, `${character.name || 'Character'} Lorebook`)
			: null;

	return { character, entryType: 'character', imageFile, lorebook, worldName: readWorldName(stChar) };
}
