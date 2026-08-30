/**
 * Raw row shapes as serverDb returns them: the assistant's ONE view of storage.
 *
 * serverDb's methods return `unknown`, so without one view each caller re-declares its own
 * partial shape of the same row and a schema change in db.ts is invisible to the compiler
 * in every one of them. Every assistant-side cast goes through these shapes instead: when
 * storage changes, THIS file is the one place to update, and every consumer type-errors
 * rather than silently misreading. (db.ts itself still returns `unknown`; these types describe what its
 * map* helpers actually produce.)
 *
 * They are `type` aliases rather than interfaces on purpose: only an alias gets an
 * implicit index signature, and every write path hands these straight back to serverDb,
 * whose row parameters are `Record<string, unknown>`. As interfaces they did not satisfy
 * that constraint, which nothing noticed while server/ went unchecked.
 */

/** library_entries row (mapLibraryEntry: id/type + spread data_json + flags). */
export type RawLibraryEntry = {
	id: string;
	type: 'character' | 'persona';
	identity: {
		name: string;
		imageUrl?: string;
		gallery?: string[];
		/** Their own image set, disjoint from `gallery` (architecture/library.md), so a delete
		 *  that sweeps an entry's files has to name both or the sprite files sit on disk forever. */
		sprites?: { path: string; label: string }[];
		tags?: string[];
	};
	data: { traits: Record<string, string>; lorebookIds?: string[]; alternateGreetings?: string[]; [k: string]: unknown };
	/** Character-versioning pointer; absent on unversioned entries and personas. */
	activeVersionId?: string;
	/** What a new chat with this character starts on (src/lib/types/library.ts). All four are
	 *  read by `create_chat`, which is a real choice: somebody asked for a chat with THIS
	 *  character, and the character's own defaults are the answer the composer gives to the
	 *  same request. Stamping fewer of them here plays the same story as somebody else. */
	defaultPersonaId?: string;
	defaultConnectionId?: string;
	defaultPresetId?: string;
	defaultVersionId?: string;
	isFavorite: boolean;
	createdAt: number;
	updatedAt: number;
}

/** character_versions row (mapCharacterVersion). */
export type RawCharacterVersion = {
	id: string;
	entryId: string;
	name: string;
	data: { traits?: Record<string, string>; [k: string]: unknown };
	createdAt: number;
	updatedAt: number;
}

/** chats row (mapChat): the fields the assistant reads. */
export type RawChat = {
	id: string;
	title: string;
	characterId: string | null;
	/** The character version this chat is pinned to; null until the character is versioned. */
	characterVersionId?: string | null;
	rootMessageId?: string | null;
	activeLeafId: string | null;
	/** Opaque JSON blob (steering reuse history + impersonate state). Degrade-don't-fail
	 *  contract: a corrupt value resets to defaults, never fails the chat read (mapChat). */
	featureState?: string | null;
	createdAt: number;
	updatedAt: number;
}

/** messages row (mapMessage): the fields the assistant reads; the full row carries more
 *  (branchLabel, model stats, …), optional here so a full-row snapshot types through. */
export type RawMessage = {
	id: string;
	chatId: string;
	parentId: string | null;
	role: 'user' | 'assistant' | 'system';
	content: string;
	personaId: string | null;
	createdAt: number;
	editedAt?: number | null;
	siblingIndex?: number;
	attachments?: unknown;
}

/** One lorebook entry: SillyTavern's native field names verbatim (src/lib/lorebook/types.ts). */
export type RawLorebookEntry = {
	id: string;
	comment: string;
	key: string[];
	keysecondary: string[];
	selectiveLogic: number;
	content: string;
	constant: boolean;
	disable: boolean;
	order: number;
	probability: number;
	useProbability: boolean;
	caseSensitive: boolean | null;
	matchWholeWords: boolean | null;
	rest: Record<string, unknown>;
}

/** lorebooks row (mapLorebook). All activation knobs at null = inherit the global settings. */
export type RawLorebookBook = {
	id: string;
	name: string;
	scanDepth: number | null;
	recursiveScanning: boolean | null;
	maxRecursionSteps: number | null;
	caseSensitive: boolean | null;
	matchWholeWords: boolean | null;
	entries: RawLorebookEntry[];
	extensions: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}
