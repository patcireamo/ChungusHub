/** Domain types for the character/persona library. Lorebooks live in `$lib/lorebook`. */
import type { PortraitFocus } from '$lib/utils/portrait-focus';

/** Type discriminator for library entries */
export type LibraryEntryType = 'character' | 'persona';

/** One sprite. `path` is the picture, `label` is what the Sprites engine answers with to
 *  choose it. */
export interface CharacterSprite {
	path: string;
	label: string;
}

/** Identity fields used by character/persona library entries */
export interface LibraryEntryIdentity {
	name: string;
	/** Path to image stored in app data folder */
	imageUrl?: string;
	/** User-defined tags for organization */
	tags?: string[];
	/** Extra image paths shown in the editor's gallery. Lives on identity so it is, like the portrait, NOT versioned. */
	gallery?: string[];
	/**
	 * The pictures the Sprites engine picks between, each with the label it answers by. Its own
	 * image set, disjoint from `gallery`: a path lives in one list or the other, since a picture
	 * in both would draw in both grids and a delete from either would take the file out from
	 * under the other. Labels are free text with a suggested vocabulary; nothing validates them
	 * against a fixed set.
	 */
	sprites?: CharacterSprite[];
	/**
	 * The sprite shown before the engine has picked anything, and whenever a stored pick names
	 * a label no sprite carries. A character with sprites ALWAYS has one (see the library
	 * store's sprite methods): without it, switching the engine on would leave an empty
	 * corner until the next reply and read as broken.
	 */
	defaultSprite?: string;
	/**
	 * Where every avatar box aims inside the portrait (`$lib/utils/portrait-focus`). Absent
	 * means the shipped centred cover. Belongs to the portrait, so it is dropped whenever the
	 * portrait is replaced, and is NOT versioned for the same reason the portrait isn't.
	 */
	portraitFocus?: PortraitFocus;
}

/** Data payload for a library entry */
export interface LibraryEntryData {
	traits: CharacterTraits;
	/** Custom labels for default traits - overrides the default label text */
	traitLabels?: Partial<Record<TraitKey, string>>;
	/** Default traits that have been hidden/deleted */
	hiddenTraits?: TraitKey[];
	/** Optional organizational category per default trait (editor layout only) */
	traitCategories?: Partial<Record<TraitKey, string>>;
	/**
	 * Alternate opening messages (SillyTavern `alternate_greetings`). Characters only.
	 * When a chat is created with this character, the First Message becomes the opening
	 * message and these become sibling branches of it, swipeable in the chat.
	 */
	alternateGreetings?: string[];
	/**
	 * Ids of standalone lorebooks linked to this entry. Both characters and personas can link
	 * books; a chat injects the books linked by its bound character + the active persona.
	 * The books themselves live in the `lorebooks` table (see `$lib/lorebook`).
	 */
	lorebookIds?: string[];
}

/** A character or persona saved to the global library */
export interface LibraryEntry {
	id: string;
	type: LibraryEntryType;
	identity: LibraryEntryIdentity;
	data: LibraryEntryData;
	/**
	 * The CharacterVersion row whose content `data` currently is (characters only).
	 * Absent = unversioned: the entry has no version rows and behaves exactly as before
	 * versions existed. When set, every save of `data` is mirrored into that row, so all
	 * version rows (parked and active) always hold real, current content.
	 */
	activeVersionId?: string;
	/**
	 * What every chat of this character opens on, for values that are otherwise app-wide.
	 * A sibling of `data` rather than a field inside it, deliberately: only `data` is
	 * mirrored into version rows and only `data.traits` reaches a character card, so a
	 * default kept here is neither versioned (a fork must not inherit a stale one) nor
	 * exported (it names ids that mean nothing on another install). Absent for personas.
	 */
	overrides?: LibraryEntryOverrides;
	isFavorite: boolean;
	createdAt: number;
	updatedAt: number;
}

/**
 * Per-character defaults for settings that are otherwise app-wide. Persona is the first
 * one; Connection and Preset are what this shape exists to leave room for.
 *
 * Every field is an id into some other table, and nothing enforces that the id still
 * resolves: a default naming a deleted persona is inert and falls one layer down at
 * resolve time rather than being swept at delete time (stores/chatPersona.svelte.ts).
 */
export interface LibraryEntryOverrides {
	/** The persona every chat of this character plays as, unless the chat pins its own. */
	personaId?: string;
}
/**
 * One named variant of a character ("pirate", "castle guard", "calmer take", …).
 * Versions are peers, not a linear history: the user forks before changing, switches
 * freely, and chats pin the exact variant they were played with. Identity (name,
 * portrait, tags) is deliberately NOT versioned: it stays live on the entry.
 */
export interface CharacterVersion {
	id: string;
	entryId: string;
	name: string;
	data: LibraryEntryData;
	createdAt: number;
	updatedAt: number;
}

export interface CharacterTraits {
	personality: string;
	description: string;
	background: string;
	/**
	 * Character-only permanent fields (see PERMANENT_TRAITS). Optional so personas and
	 * legacy entries stay valid; treated as empty strings when absent.
	 */
	firstMessage?: string;
	creator?: string;
	creatorNotes?: string;
	scenario?: string;
	exampleDialogue?: string;
	/** The card's own system-prompt override (SillyTavern `system_prompt`). */
	systemPrompt?: string;
	/** Instructions injected after chat history (SillyTavern `post_history_instructions`). */
	postHistoryInstructions?: string;
	/** Free-form version tag for the card (SillyTavern `character_version`). */
	characterVersion?: string;
}

export type TraitKey = keyof CharacterTraits;

/**
 * A permanent field: always present on an entry, shown in a fixed order under a fixed
 * category, and never deletable, renamable, or movable to another category.
 */
export interface PermanentTraitDef {
	key: TraitKey;
	label: string;
	/**
	 * The per-field preset macro that places this field in the prompt (SillyTavern-style,
	 * e.g. {{description}}). Absent = pure metadata with no macro (never independently sent).
	 */
	macro?: string;
	/**
	 * Whether this field is part of the whole-sheet {{character}} blob. Blob members are the
	 * descriptive profile; the opening message, instructions and metadata ride only their own
	 * macro instead. Personas have no blob: {{persona}} is their one description, verbatim.
	 */
	inBlob?: boolean;
	/**
	 * The field seeds the chat directly (the opening message becomes the first turn), so it
	 * reaches the AI as context regardless of any preset macro: it's never "not sent".
	 */
	seedsChat?: boolean;
}

/**
 * Permanent trait fields per entry type, in display order. Characters use the full
 * character-card set; personas keep the single description.
 *
 * `inBlob` marks the four descriptive fields the {{character}} blob dumps; the array order
 * is that blob's output order. Every field also carries its own macro so a preset can place
 * it individually. That pairing is what drives the editor's "Not sent to AI" indicator.
 */
export const PERMANENT_TRAITS: Record<LibraryEntryType, PermanentTraitDef[]> = {
	character: [
		{ key: 'description', label: 'Description', macro: 'description', inBlob: true },
		{ key: 'personality', label: 'Personality summary', macro: 'personality', inBlob: true },
		{ key: 'scenario', label: 'Scenario', macro: 'scenario', inBlob: true },
		{ key: 'exampleDialogue', label: 'Examples of dialogue', macro: 'mesExamples', inBlob: true },
		{ key: 'firstMessage', label: 'First Message', macro: 'charFirstMessage', seedsChat: true },
		{ key: 'systemPrompt', label: 'System Prompt', macro: 'charPrompt' },
		{ key: 'postHistoryInstructions', label: 'Post-History Instructions', macro: 'charInstruction' },
		{ key: 'characterVersion', label: 'Character Version', macro: 'charVersion' },
		{ key: 'creator', label: 'Created by', macro: 'charCreator' },
		{ key: 'creatorNotes', label: "Creator's Notes", macro: 'charCreatorNotes' }
	],
	// Personas are a single free-text field (see PersonasView). Everything the
	// protagonist needs lives in this one description, placed verbatim by {{persona}}.
	persona: [{ key: 'description', label: 'Persona Description', macro: 'persona' }]
};

/** The whole-sheet blob macro per entry type: the badge treats its presence as "field sent". */
export const BLOB_MACRO: Record<LibraryEntryType, string> = {
	character: 'character',
	persona: 'persona'
};

/**
 * The editable fields of a fresh or imported character/persona, before it becomes a
 * committed LibraryEntry. Both character and persona share this shape.
 */
export interface LibrarySeed {
	id: string;
	name: string;
	/** Path to image stored in app data folder */
	imageUrl?: string;
	/** User-defined tags for organization in library */
	tags?: string[];
	traits: CharacterTraits;
	/** Custom labels for default traits - overrides the default label text */
	traitLabels?: Partial<Record<TraitKey, string>>;
	/** Default traits that have been hidden/deleted */
	hiddenTraits?: TraitKey[];
	/** Alternate opening messages (characters only) */
	alternateGreetings?: string[];
}

/** Create empty character seed with defaults */
export function createEmptyCharacter(): LibrarySeed {
	return {
		id: crypto.randomUUID(),
		name: '',
		traits: {
			personality: '',
			description: '',
			background: ''
		}
	};
}

/** Create empty persona seed with defaults */
export function createEmptyPersona(): LibrarySeed {
	return {
		id: crypto.randomUUID(),
		name: '',
		traits: {
			personality: '',
			description: '',
			background: ''
		}
	};
}
