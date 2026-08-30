import { db } from '$lib/services/database';
import { imageService, type ImageCategory } from '$lib/services/imageService';
import type {
	CharacterSprite,
	CharacterVersion,
	LibraryEntry,
	LibraryEntryType,
	LibraryEntryIdentity,
	LibraryEntryData,
	LibrarySeed
} from '$lib/types/library';
import { createEmptyCharacter, createEmptyPersona } from '$lib/types/library';
import type { ImportResult } from '$lib/services/sillyTavernImport';
import { lorebookStore } from '$lib/lorebook/store.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { DebouncedWriter } from '$lib/utils/debounced-write';
import {
	clampPortraitFocus,
	isDefaultPortraitFocus,
	type PortraitFocus
} from '$lib/utils/portrait-focus';
import { findLabelConflict, normalizeSpriteLabel, resolveDefaultSprite } from '$lib/utils/sprites';

/** What a caller may change about an entry's data in one go. Traits are patched field by
 *  field (the editor sends one), everything else is replaced whole. */
type LibraryDataUpdate = Partial<Omit<LibraryEntryData, 'traits'>> & {
	traits?: Partial<LibraryEntryData['traits']>;
};

export interface LibraryEntryUsage {
	chatCount: number;
	castCount: number;
	chatIds: string[];
}

export interface ResolvedLibraryEntity {
	entryId: string;
	type: LibraryEntryType;
	name: string;
	imageUrl?: string;
	tags?: string[];
	traits: LibraryEntryData['traits'];
	traitLabels?: LibraryEntryData['traitLabels'];
	hiddenTraits?: LibraryEntryData['hiddenTraits'];
}

class CharacterLibraryStore {
	private static readonly SAVE_DEBOUNCE_MS = 500;

	private _entries = $state<LibraryEntry[]>([]);
	private _versions = $state<CharacterVersion[]>([]);
	private _loading = $state(false);
	private _initialized = $state(false);
	private _selectedEntryId = $state<string | null>(null);
	private writer = new DebouncedWriter(CharacterLibraryStore.SAVE_DEBOUNCE_MS, (id) =>
		this.writeEntry(id)
	);
	// Brand-new entries created via the "New" button that the user hasn't confirmed
	// yet. They live in the DB already (everything is committed) but are treated as
	// throwaway until saved: the editor offers Save/Discard instead of autosave, and
	// leaving the Library while one is open is blocked. Memory-only by design.
	private _unconfirmedNewIds = $state<Set<string>>(new Set());

	get entries() { return this._entries; }
	get loading() { return this._loading; }
	get initialized() { return this._initialized; }
	get selectedEntryId() { return this._selectedEntryId; }

	get selectedEntry() {
		if (!this._selectedEntryId) return null;
		return this._entries.find((entry) => entry.id === this._selectedEntryId) ?? null;
	}

	get characters() {
		return this._entries.filter((entry) => entry.type === 'character');
	}

	get personas() {
		return this._entries.filter((entry) => entry.type === 'persona');
	}

	selectEntry(id: string | null) {
		this._selectedEntryId = id;
	}

	/** True while a freshly created entry hasn't been confirmed (saved/discarded) yet. */
	isUnconfirmedNew(id: string): boolean {
		return this._unconfirmedNewIds.has(id);
	}

	private markUnconfirmedNew(id: string): void {
		const next = new Set(this._unconfirmedNewIds);
		next.add(id);
		this._unconfirmedNewIds = next;
	}

	/** Promote a brand-new entry to a normal one (called on Save). */
	confirmNewEntry(id: string): void {
		if (!this._unconfirmedNewIds.has(id)) return;
		const next = new Set(this._unconfirmedNewIds);
		next.delete(id);
		this._unconfirmedNewIds = next;
	}

	clearSelection() {
		this._selectedEntryId = null;
	}

	/**
	 * Detach a value from reactive state so a caller can hold and mutate it freely.
	 * Everything on the editing path is a state proxy, which is
	 * exactly what `$state.snapshot` is for, and it runs on this path once per
	 * keystroke, so it must not be a JSON round trip.
	 */
	private clone<T>(value: T): T {
		return $state.snapshot(value) as T;
	}

	private getDefaultTraits() {
		return {
			personality: '',
			description: '',
			background: ''
		};
	}

	// ==================== Entry Access ====================

	private getEntryById(id: string): LibraryEntry | null {
		return this._entries.find((entry) => entry.id === id) ?? null;
	}

	findByName(type: LibraryEntryType, name: string): LibraryEntry | null {
		const normalized = name.trim().toLowerCase();
		if (!normalized) return null;
		return this._entries.find(
			(entry) => entry.type === type && entry.identity.name.trim().toLowerCase() === normalized
		) ?? null;
	}

	// ==================== Editing & write-through ====================
	//
	// The editor writes onto the entry itself and the shared writer carries it to the
	// server a moment later, the same shape the lorebook and steering stores use, so
	// there is one answer in this app to "where does typed text go". Typing rides
	// `scheduleIdentityEdit`/`scheduleDataEdit`; a discrete action (a tag, a portrait, a
	// version switch) writes at once, because a click must never sit in a timer.

	/** Is an edit to this entry still waiting to reach the server? Reactive: the editor
	 *  header renders its saving state off this. */
	hasPendingWrite(id: string): boolean {
		return this.writer.pending(id);
	}

	/** Commit a waiting write now: one entry, or every pending one. Call before anything
	 *  that reads the server's copy (leaving the editor, forking a version). */
	flushEntry(id?: string): Promise<void> {
		return this.writer.flush(id);
	}

	private async writeEntry(id: string): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) return;
		try {
			await this.persistEntry(entry);
		} catch (error) {
			console.error('Failed to save library entry:', error);
			toastStore.error('Couldn\'t save. Your edits are on screen but not on disk.');
		}
	}

	/** Builds a fresh object from both sides, merging traits one level deep. Runs per
	 *  keystroke, so it copies rather than clones: the result is what gets assigned. */
	private mergeData(base: LibraryEntryData, updates: LibraryDataUpdate): LibraryEntryData {
		return {
			...base,
			...updates,
			traits: {
				...base.traits,
				...(updates.traits ?? {})
			}
		};
	}

	/** Debounced identity edit: the editor's name field. */
	scheduleIdentityEdit(id: string, updates: Partial<LibraryEntryIdentity>): void {
		const entry = this.getEntryById(id);
		if (!entry) return;
		entry.identity = { ...entry.identity, ...updates };
		this.writer.schedule(id);
	}

	/** Debounced data edit: the editor's trait fields. */
	scheduleDataEdit(id: string, updates: LibraryDataUpdate): void {
		const entry = this.getEntryById(id);
		if (!entry) return;
		entry.data = this.mergeData(entry.data, updates);
		this.writer.schedule(id);
	}

	/** Route an entry's image upload to its own folder: characters vs. personas. */
	private imageCategoryFor(id: string): ImageCategory {
		return this.getEntryById(id)?.type === 'persona' ? 'personas' : 'characters';
	}

	/** Add files to the entry's gallery. Every image is already this entry's own copy
	 *  (`imageService.saveImage` writes a new file), so nothing is shared. */
	async addGalleryImages(id: string, files: File[]): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry || files.length === 0) return;

		const uploaded: string[] = [];
		for (const file of files) {
			uploaded.push(await imageService.saveImage(file, this.imageCategoryFor(id)));
		}
		entry.identity = {
			...entry.identity,
			gallery: [...(entry.identity.gallery ?? []), ...uploaded]
		};
		await this.persistEntry(entry);
	}

	/** Drop one gallery image and delete its file. An entry's art is exclusively its own,
	 *  so nothing else can still be pointing at it. Sprites are a separate set and cannot
	 *  name this path, so there is nothing else to sweep. */
	async removeGalleryImage(id: string, path: string): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) return;

		// Emptied out, the key goes rather than staying as []: an empty set is stored as no key
		// at all, the same rule the sprite list and the assistant's own image writes follow.
		const gallery = (entry.identity.gallery ?? []).filter((galleryPath) => galleryPath !== path);
		entry.identity = {
			...entry.identity,
			gallery: gallery.length ? gallery : undefined
		};
		await this.persistEntry(entry);
		await imageService.deleteImage(path);
	}

	/**
	 * Upload pictures into the sprite set, each carrying its label from the same write. One
	 * write per call, not per file: a SillyTavern sprite pack is dozens of images and a write
	 * each would be dozens of broadcasts.
	 *
	 * Returns the labels it refused (a label the character already uses), so a bulk caller can
	 * report them instead of leaving the user with silently missing sprites.
	 */
	async addSprites(id: string, items: { file: File; label: string }[]): Promise<string[]> {
		const entry = this.getEntryById(id);
		if (!entry) throw new Error('That entry no longer exists.');
		if (items.length === 0) return [];

		const sprites = [...(entry.identity.sprites ?? [])];
		const refused: string[] = [];

		for (const { file, label } of items) {
			const clean = normalizeSpriteLabel(label);
			if (!clean || findLabelConflict(sprites, clean)) {
				refused.push(clean || file.name);
				continue;
			}
			const path = await imageService.saveImage(file, this.imageCategoryFor(id));
			sprites.push({ path, label: clean });
		}

		entry.identity = {
			...entry.identity,
			sprites: sprites.length ? sprites : undefined,
			defaultSprite: resolveDefaultSprite(sprites, entry.identity.defaultSprite)
		};
		await this.persistEntry(entry);
		return refused;
	}

	/** Rename one sprite. The picture and its place in the list stay exactly where they are. */
	async setSpriteLabel(id: string, path: string, label: string): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) throw new Error('That entry no longer exists.');
		const existing = entry.identity.sprites ?? [];
		if (!existing.some((sprite) => sprite.path === path)) {
			throw new Error('That picture is not one of this character’s sprites.');
		}
		const clean = normalizeSpriteLabel(label);
		if (!clean) throw new Error('A sprite needs a label.');
		if (findLabelConflict(existing, clean, path)) {
			throw new Error(`Another sprite is already “${clean}”.`);
		}

		entry.identity = {
			...entry.identity,
			sprites: existing.map((sprite) => (sprite.path === path ? { path, label: clean } : sprite))
		};
		await this.persistEntry(entry);
	}

	/** Drop one sprite and delete its file. The same shape as the gallery's own remove: a
	 *  sprite's picture belongs to this entry alone, so the row and the file go together. */
	async removeSprite(id: string, path: string): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) return;

		const sprites = (entry.identity.sprites ?? []).filter((sprite) => sprite.path !== path);
		entry.identity = {
			...entry.identity,
			sprites: sprites.length ? sprites : undefined,
			defaultSprite: resolveDefaultSprite(sprites, entry.identity.defaultSprite)
		};
		await this.persistEntry(entry);
		await imageService.deleteImage(path);
	}

	/** Choose which sprite stands in before the engine has read anything. */
	async setDefaultSprite(id: string, path: string): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) throw new Error('That entry no longer exists.');
		if (!(entry.identity.sprites ?? []).some((sprite) => sprite.path === path)) {
			throw new Error('Only a sprite can be the default.');
		}
		entry.identity = { ...entry.identity, defaultSprite: path };
		await this.persistEntry(entry);
	}

	getResolvedEntity(entryId: string): ResolvedLibraryEntity | null {
		const entry = this.getEntryById(entryId);
		if (!entry) return null;

		return {
			entryId: entry.id,
			type: entry.type,
			name: entry.identity.name,
			imageUrl: entry.identity.imageUrl,
			tags: entry.identity.tags,
			traits: entry.data.traits,
			traitLabels: entry.data.traitLabels,
			hiddenTraits: entry.data.hiddenTraits
		};
	}

	// ==================== Load ====================

	// Versions land BEFORE entries in both loaders, and that order is load-bearing: an
	// entry becoming findable is what makes readers resolve its pinned version row
	// (dataForVersion, which throws on a missing row). Assigning entries first opens a
	// window (one await wide, but enough for effects to flush) where a versioned
	// character is visible against a stale/empty version list.
	async load(): Promise<void> {
		if (this._initialized) return;
		this._loading = true;
		try {
			this._versions = await db.getAllCharacterVersions();
			this._entries = await db.getAllLibraryEntries();
			this._initialized = true;
		} finally {
			this._loading = false;
		}
	}

	async refresh(): Promise<void> {
		this._loading = true;
		try {
			// Commit what this device has typed but not yet sent, so the refetch can't hand
			// back a row that is older than what is on screen.
			await this.writer.flush();
			const versions = await db.getAllCharacterVersions();
			const rows = await db.getAllLibraryEntries();
			this._versions = versions;
			// Typing carries on through those awaits, and an entry with a write still pending
			// is one that was touched since the flush, so the copy on screen is the newer one.
			// Keep it; its own pending write carries it to the server a moment later.
			this._entries = rows.map((row) => {
				const live = this.writer.pending(row.id) ? this.getEntryById(row.id) : null;
				return live ?? row;
			});
		} finally {
			this._loading = false;
		}
	}

	// ==================== Create / Import ====================

	private buildEntryFromEntityData(
		type: LibraryEntryType,
		entity: LibrarySeed,
		createdAt = Date.now(),
		updatedAt = Date.now()
	): LibraryEntry {
		const plain = this.clone(entity);
		const identity: LibraryEntryIdentity = {
			name: plain.name ?? '',
			imageUrl: plain.imageUrl,
			tags: plain.tags ? [...plain.tags] : []
		};
		const data: LibraryEntryData = {
			traits: plain.traits ?? this.getDefaultTraits(),
			traitLabels: plain.traitLabels,
			hiddenTraits: plain.hiddenTraits,
			alternateGreetings: plain.alternateGreetings
		};

		return {
			id: crypto.randomUUID(),
			type,
			identity,
			data,
			isFavorite: false,
			createdAt,
			updatedAt
		};
	}

	private async createEntryFromEntityData(
		type: LibraryEntryType,
		entity: LibrarySeed,
		options?: { cloneImage?: boolean }
	): Promise<LibraryEntry> {
		const entry = this.buildEntryFromEntityData(type, this.clone(entity));

		if (options?.cloneImage && entry.identity.imageUrl) {
			const clonedPath = await imageService.copyImage(entry.identity.imageUrl);
			if (clonedPath) {
				entry.identity.imageUrl = clonedPath;
			}
		}

		await db.insertLibraryEntry(entry);
		this._entries = [entry, ...this._entries];
		return entry;
	}

	async saveCharacter(
		character: LibrarySeed,
		options?: { cloneImage?: boolean }
	): Promise<LibraryEntry> {
		return this.createEntryFromEntityData('character', character, options);
	}

	async savePersona(
		persona: LibrarySeed,
		options?: { cloneImage?: boolean }
	): Promise<LibraryEntry> {
		return this.createEntryFromEntityData('persona', persona, options);
	}

	async createCharacter(): Promise<LibraryEntry> {
		const character = createEmptyCharacter();
		character.tags = [];
		const entry = await this.createEntryFromEntityData('character', character);
		this.markUnconfirmedNew(entry.id);
		return entry;
	}

	async createPersona(): Promise<LibraryEntry> {
		const persona = createEmptyPersona();
		const entry = await this.createEntryFromEntityData('persona', persona);
		this.markUnconfirmedNew(entry.id);
		return entry;
	}

	async importFromSillyTavern(
		importResult: ImportResult,
		options: { importLorebook?: boolean } = {}
	): Promise<LibraryEntry> {
		const character = { ...importResult.character };
		const isPersona = importResult.entryType === 'persona';

		if (importResult.imageFile) {
			const imageUrl = await imageService.saveImage(
				importResult.imageFile,
				isPersona ? 'personas' : 'characters'
			);
			character.imageUrl = imageUrl;
		}
		if (!character.tags) {
			character.tags = [];
		}

		const entry = isPersona ? await this.savePersona(character) : await this.saveCharacter(character);

		// A ChungusHub v2 export travels with every variant of a versioned character;
		// rebuild the rows with fresh ids and land the entry on the variant it was on.
		if (!isPersona && importResult.versions?.length) {
			const now = Date.now();
			let activeId: string | null = null;
			for (const [i, v] of importResult.versions.entries()) {
				const version: CharacterVersion = {
					id: crypto.randomUUID(),
					entryId: entry.id,
					name: v.name,
					data: this.clone(v.data),
					createdAt: now + i,
					updatedAt: now + i
				};
				await db.insertCharacterVersion(version);
				this._versions = [...this._versions, version];
				if (v.active) activeId = version.id;
			}
			// An export without an active mark is malformed, so surface it instead of
			// guessing which variant the character should be on.
			if (!activeId) throw new Error('Import file marks no active character version.');
			entry.activeVersionId = activeId;
			entry.data = this.clone(this.getVersion(activeId)!.data);
			await this.persistEntry(entry);
		}

		// An embedded character_book becomes a standalone lorebook linked to the new
		// character, but only when the caller opted in (import is user-confirmed).
		if (options.importLorebook && importResult.lorebook && importResult.lorebook.entries.length > 0) {
			await lorebookStore.addBook(importResult.lorebook);
			entry.data.lorebookIds = [...(entry.data.lorebookIds ?? []), importResult.lorebook.id];
			await this.persistEntry(entry);
		}

		return entry;
	}

	// ==================== Update ====================

	private async persistEntry(entry: LibraryEntry): Promise<void> {
		// This sends the whole entry, so a debounced write still waiting for it would only
		// repeat the same row, and broadcast it to every other device a second time.
		this.writer.cancel(entry.id);
		entry.updatedAt = Date.now();
		await db.updateLibraryEntry(entry);
		this._entries = [...this._entries];
		// The server mirrors every save into the active variant's row (server/db.ts
		// updateLibraryEntry), so mirror it into our cached rows too. Readers resolve a
		// pin THROUGH the row now (dataForVersion), and the `library` sync broadcast
		// skips the device that wrote, so nothing else would ever refresh this copy.
		if (entry.activeVersionId) {
			const activeId = entry.activeVersionId;
			this._versions = this._versions.map((v) =>
				v.id === activeId ? { ...v, data: this.clone(entry.data), updatedAt: entry.updatedAt } : v
			);
		}
	}

	async updateIdentity(id: string, updates: Partial<LibraryEntryIdentity>): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) return;

		entry.identity = {
			...this.clone(entry.identity),
			...this.clone(updates)
		};
		await this.persistEntry(entry);
	}

	/** Merge changes into the entry's live data (= the active version's content; the
	 *  server mirrors the save into the active row) and write at once. */
	async updateData(id: string, updates: LibraryDataUpdate): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) throw new Error('That entry no longer exists.');
		entry.data = this.mergeData(entry.data, updates);
		await this.persistEntry(entry);
	}

	/** Set (or clear, with null) the persona new chats with this character start as. A
	 *  sibling of `data`, so it never mirrors into a version row: which persona a story is
	 *  played by is not a property of one variant of the character. */
	async setDefaultPersona(id: string, personaId: string | null): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) throw new Error('That entry no longer exists.');
		if (personaId) entry.defaultPersonaId = personaId;
		else delete entry.defaultPersonaId;
		await this.persistEntry(entry);
	}

	/** Trait-only `updateData`. The proposal apply path writes through here right after
	 *  forking a version. */
	updateTraits(id: string, changes: Partial<LibraryEntryData['traits']>): Promise<void> {
		return this.updateData(id, { traits: changes });
	}

	/** A framing belongs to the picture it was aimed at, so a new portrait arrives unframed
	 *  rather than inheriting coordinates chosen for a picture that is no longer there. */
	async updateEntryImage(id: string, file: File | null): Promise<string | null> {
		const entry = this.getEntryById(id);
		if (!entry) return null;
		const currentImage = entry.identity.imageUrl;

		if (!file) {
			entry.identity = {
				...this.clone(entry.identity),
				imageUrl: undefined,
				portraitFocus: undefined
			};
			await this.persistEntry(entry);
			if (currentImage) await imageService.deleteImage(currentImage);
			return null;
		}

		const imagePath = await imageService.saveImage(file, this.imageCategoryFor(id));
		entry.identity = {
			...this.clone(entry.identity),
			imageUrl: imagePath,
			portraitFocus: undefined
		};
		await this.persistEntry(entry);
		if (currentImage && currentImage !== imagePath) await imageService.deleteImage(currentImage);
		return imagePath;
	}

	/** Aim the portrait (architecture/library.md). A discrete act, so it writes at once;
	 *  the centred default is stored as nothing, so an untouched entry keeps a bare row. */
	async setPortraitFocus(id: string, focus: PortraitFocus | null): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) throw new Error('That entry no longer exists.');
		const next = focus ? clampPortraitFocus(focus) : null;
		entry.identity = {
			...this.clone(entry.identity),
			portraitFocus: next && !isDefaultPortraitFocus(next) ? next : undefined
		};
		await this.persistEntry(entry);
	}

	async duplicateEntry(id: string): Promise<LibraryEntry | null> {
		const original = this.getEntryById(id);
		if (!original) return null;

		let copiedImageUrl: string | undefined;
		if (original.identity.imageUrl) {
			copiedImageUrl = (await imageService.copyImage(original.identity.imageUrl)) ?? undefined;
		}

		// Gallery files get their own copies too: shared paths would break on delete.
		let copiedGallery: string[] | undefined;
		if (original.identity.gallery?.length) {
			copiedGallery = [];
			for (const path of original.identity.gallery) {
				const copiedPath = await imageService.copyImage(path);
				if (copiedPath) copiedGallery.push(copiedPath);
			}
		}
		// Sprites are copied the same way and for the same reason, keeping their labels: a copy
		// with the character's art but none of their sprites would be a different character. One
		// whose file failed to copy is dropped rather than left naming the original's image,
		// which the original's delete would take away.
		const copiedSprites: CharacterSprite[] = [];
		const copiedSpritePathByOriginal = new Map<string, string>();
		for (const sprite of original.identity.sprites ?? []) {
			const copiedPath = await imageService.copyImage(sprite.path);
			if (copiedPath) {
				copiedSprites.push({ path: copiedPath, label: sprite.label });
				copiedSpritePathByOriginal.set(sprite.path, copiedPath);
			}
		}

		const duplicatedEntry: LibraryEntry = {
			id: crypto.randomUUID(),
			type: original.type,
			identity: {
				...this.clone(original.identity),
				name: `${original.identity.name || 'Unnamed'} (Copy)`,
				imageUrl: copiedImageUrl,
				gallery: copiedGallery,
				sprites: copiedSprites.length ? copiedSprites : undefined,
				defaultSprite: resolveDefaultSprite(
					copiedSprites,
					original.identity.defaultSprite
						? copiedSpritePathByOriginal.get(original.identity.defaultSprite)
						: undefined
				)
			},
			data: this.clone(original.data),
			isFavorite: false,
			createdAt: Date.now(),
			updatedAt: Date.now()
		};

		await db.insertLibraryEntry(duplicatedEntry);
		this._entries = [duplicatedEntry, ...this._entries];
		return duplicatedEntry;
	}

	/**
	 * Create the other kind of entry from this one: a persona from a character, a character
	 * from a persona. It is a **copy, never a flip of `type`**: chats name their character by
	 * id, version rows hang off it, and every user message carries the id of the persona it
	 * was sent with, so a row that changed kind under them would leave all three pointing at
	 * something that no longer answers. The source is left untouched.
	 *
	 * `description` is the text the conversion dialog settled on (a character folds through
	 * `personaDescriptionFromCharacter`, a persona travels verbatim). The portrait and its
	 * framing come along, copied into the new kind's own folder, and so do the linked
	 * lorebooks, since both kinds link books. Nothing shaped like a character does: versions,
	 * greetings, sprites, gallery, tags and the card metadata stay where they were authored.
	 */
	async convertEntry(id: string, description: string): Promise<LibraryEntry> {
		const source = this.getEntryById(id);
		if (!source) throw new Error('That entry no longer exists.');
		const type: LibraryEntryType = source.type === 'character' ? 'persona' : 'character';

		// The new entry owns its art outright, like every other entry: a shared path would
		// die with whichever of the two is deleted first.
		const imageUrl = source.identity.imageUrl
			? ((await imageService.copyImage(
					source.identity.imageUrl,
					type === 'persona' ? 'personas' : 'characters'
				)) ?? undefined)
			: undefined;

		const entry: LibraryEntry = {
			id: crypto.randomUUID(),
			type,
			identity: {
				name: source.identity.name,
				imageUrl,
				tags: [],
				// The framing belongs to the picture, and this is the same picture.
				portraitFocus: imageUrl ? this.clone(source.identity.portraitFocus) : undefined
			},
			data: {
				traits: { ...this.getDefaultTraits(), description },
				lorebookIds: source.data.lorebookIds ? [...source.data.lorebookIds] : undefined
			},
			isFavorite: false,
			createdAt: Date.now(),
			updatedAt: Date.now()
		};

		await db.insertLibraryEntry(entry);
		this._entries = [entry, ...this._entries];
		return entry;
	}

	async toggleFavorite(id: string): Promise<void> {
		const entry = this.getEntryById(id);
		if (!entry) return;

		entry.isFavorite = !entry.isFavorite;
		await db.updateLibraryEntryFavorite(id, entry.isFavorite);
		this._entries = [...this._entries];
	}

	async updateTags(id: string, tags: string[]): Promise<void> {
		await this.updateIdentity(id, { tags: [...tags] });
	}

	// ==================== Character Versions ====================
	//
	// Versions are named variants, not a linear history: the user forks BEFORE changing
	// (like copying the character and working on the copy), switches freely, and chats
	// pin the exact variant they were played with. The entry's `data` is always the active
	// variant's content, so the editor, autosave and every existing reader stay untouched;
	// the server mirrors each save into the active row so parked rows are the only frozen
	// ones. A character with no version rows is simply unversioned (pre-feature behavior).

	/** All versions of an entry, in creation order. Empty = unversioned. */
	versionsFor(entryId: string): CharacterVersion[] {
		return this._versions.filter((v) => v.entryId === entryId);
	}

	getVersion(versionId: string): CharacterVersion | null {
		return this._versions.find((v) => v.id === versionId) ?? null;
	}

	/** The data a chat pinned to `versionId` plays against: that row's content, full
	 *  stop. Being the active variant earns it no shortcut, so which variant a chat
	 *  uses never depends on where the library's active pointer happens to sit. Null
	 *  (unversioned characters, legacy chats) reads the entry's live data.
	 *
	 *  A pin with no row is a dangling pin and throws, exactly like the generation path
	 *  (prompt-builder): falling back to `entry.data` would quietly serve a DIFFERENT
	 *  variant of the character. (Reactive meter path; the generation path resolves the
	 *  same rule from the db.) */
	dataForVersion(entry: LibraryEntry, versionId: string | null): LibraryEntryData {
		if (!versionId) return entry.data;
		const version = this.getVersion(versionId);
		if (!version || version.entryId !== entry.id) {
			throw new Error(
				'This chat is pinned to a character version that no longer exists. Repin it from the version menu.'
			);
		}
		return version.data;
	}

	/** chatId-count per version of an entry. Drives delete guards and menu labels. */
	async versionUsage(entryId: string): Promise<Record<string, number>> {
		const chats = await db.getAllChats();
		const out: Record<string, number> = {};
		for (const chat of chats) {
			if (chat.characterId !== entryId || !chat.characterVersionId) continue;
			out[chat.characterVersionId] = (out[chat.characterVersionId] ?? 0) + 1;
		}
		return out;
	}

	/**
	 * Fork the current state as a new named version and make it active. The user edits
	 * the fork; the state they forked FROM stays parked and untouched.
	 *
	 * First fork of an unversioned character also materializes the current state as a
	 * baseline row and anchors every existing chat of the character to it, so they keep
	 * exactly what they were played against. This runs once, at the moment the user opts
	 * into versioning, never on load.
	 */
	async createVersion(entryId: string, name: string): Promise<CharacterVersion | null> {
		const entry = this.getEntryById(entryId);
		if (!entry || entry.type !== 'character') return null;
		// Send any pending editor keystrokes first, so the fork captures what the user sees.
		await this.flushEntry(entryId);
		const now = Date.now();

		if (!entry.activeVersionId) {
			const baseline: CharacterVersion = {
				id: crypto.randomUUID(),
				entryId,
				name: 'Original',
				data: this.clone(entry.data),
				createdAt: now,
				updatedAt: now
			};
			await db.insertCharacterVersion(baseline);
			await db.pinUnpinnedChatsToVersion(entryId, baseline.id);
			this._versions = [...this._versions, baseline];
			entry.activeVersionId = baseline.id;
		}

		const version: CharacterVersion = {
			id: crypto.randomUUID(),
			entryId,
			name,
			data: this.clone(entry.data),
			createdAt: now + 1,
			updatedAt: now + 1
		};
		await db.insertCharacterVersion(version);
		this._versions = [...this._versions, version];
		entry.activeVersionId = version.id;
		await this.persistEntry(entry);
		return version;
	}

	/** Switch which variant the entry's live data is. Pending edits are parked into the
	 *  outgoing variant's row first (the flush commits while it is still active), so
	 *  nothing is lost and nothing bleeds across variants. */
	async switchActiveVersion(entryId: string, versionId: string): Promise<void> {
		const entry = this.getEntryById(entryId);
		if (!entry || entry.activeVersionId === versionId) return;
		const version = this._versions.find((v) => v.id === versionId && v.entryId === entryId);
		if (!version) throw new Error(`No version "${versionId}" on this character.`);
		await this.flushEntry(entryId);
		entry.data = this.clone(version.data);
		entry.activeVersionId = versionId;
		await this.persistEntry(entry);
	}

	async renameVersion(versionId: string, name: string): Promise<void> {
		await db.renameCharacterVersion(versionId, name);
		this._versions = this._versions.map((v) =>
			v.id === versionId ? { ...v, name, updatedAt: Date.now() } : v
		);
	}

	/** Delete a version. Chats pinned to it are refused loudly, since deleting their
	 *  variant would silently corrupt pinned state. Deleting the active version first
	 *  switches the entry to another variant; the last remaining one is refused (the
	 *  menu hides its delete button, this guard keeps it honest). */
	async deleteVersion(versionId: string): Promise<void> {
		const version = this.getVersion(versionId);
		if (!version) return;
		const usage = await this.versionUsage(version.entryId);
		const pinned = usage[versionId] ?? 0;
		if (pinned > 0) {
			throw new Error(
				`${pinned} chat${pinned === 1 ? ' is' : 's are'} pinned to "${version.name}". Repin ${pinned === 1 ? 'it' : 'them'} first.`
			);
		}
		const entry = this.getEntryById(version.entryId);
		if (entry?.activeVersionId === versionId) {
			const fallback = this._versions.find(
				(v) => v.entryId === version.entryId && v.id !== versionId
			);
			if (!fallback) {
				throw new Error('This is the only version: there is nothing to switch back to.');
			}
			await this.switchActiveVersion(version.entryId, fallback.id);
		}
		await db.deleteCharacterVersion(versionId);
		this._versions = this._versions.filter((v) => v.id !== versionId);
	}

	// ==================== Usage / Lorebook ====================

	/** How many chats are bound to this entry as their character. */
	async getEntryUsage(id: string): Promise<LibraryEntryUsage> {
		const chats = await db.getAllChats();
		const chatIds = chats.filter((chat) => chat.characterId === id).map((chat) => chat.id);
		return {
			chatCount: chatIds.length,
			castCount: chatIds.length,
			chatIds
		};
	}

	async deleteEntry(id: string): Promise<LibraryEntryUsage> {
		const entry = this.getEntryById(id);
		const usage = await this.getEntryUsage(id);
		// Nothing left to send for a row that is about to be gone.
		this.writer.cancel(id);

		// The row goes FIRST, because it is the only step that can refuse: the last persona is
		// undeletable and the server is where that floor lives (architecture/library.md). A
		// sweep that ran ahead of it would have unbound chats and taken the portrait off an
		// entry that is still in the library.
		await db.deleteLibraryEntry(id);

		// Unbind any chats that pointed at this character so they don't dangle. The
		// version pin goes with it: it referenced a row that cascaded away above.
		for (const chatId of usage.chatIds) {
			await db.updateChat({ id: chatId, characterId: null, characterVersionId: null });
		}

		if (entry?.identity.imageUrl) {
			await imageService.deleteImage(entry.identity.imageUrl);
		}
		for (const path of new Set(entry?.identity.gallery ?? [])) {
			await imageService.deleteImage(path);
		}
		// Sprites are their own set, so their files are swept on their own too. What the row
		// names is still the whole of it.
		for (const sprite of entry?.identity.sprites ?? []) {
			await imageService.deleteImage(sprite.path);
		}

		this.confirmNewEntry(id);
		this._entries = this._entries.filter((libraryEntry) => libraryEntry.id !== id);
		// Version rows cascade with the entry in the DB; mirror that here.
		this._versions = this._versions.filter((v) => v.entryId !== id);
		return usage;
	}

	// ==================== Bulk operations ====================
	//
	// Each method touches the DB per entry but mutates the reactive `_entries`
	// array exactly once at the end, so a 100+ selection doesn't trigger 100
	// store re-renders. Chat lookups are fetched once, not per entry.

	/** Aggregate chat binding across a selection, for the bulk-delete warning. */
	async getEntriesUsage(ids: string[]): Promise<{ boundCount: number; chatCount: number }> {
		const idSet = new Set(ids);
		const chats = await db.getAllChats();
		const bound = new Set<string>();
		let chatCount = 0;
		for (const chat of chats) {
			if (chat.characterId && idSet.has(chat.characterId)) {
				bound.add(chat.characterId);
				chatCount++;
			}
		}
		return { boundCount: bound.size, chatCount };
	}

	/** Returns the ids of chats that were unbound, so the caller can mirror it in memory. */
	async deleteEntries(ids: string[]): Promise<string[]> {
		if (ids.length === 0) return [];
		const idSet = new Set(ids);

		// Unbind every chat pointing at any of the deleted characters in one sweep.
		const chats = await db.getAllChats();
		const unboundChatIds: string[] = [];
		for (const chat of chats) {
			if (chat.characterId && idSet.has(chat.characterId)) {
				await db.updateChat({ id: chat.id, characterId: null, characterVersionId: null });
				unboundChatIds.push(chat.id);
			}
		}

		for (const id of ids) {
			const entry = this.getEntryById(id);
			this.writer.cancel(id);
			if (entry?.identity.imageUrl) await imageService.deleteImage(entry.identity.imageUrl);
			for (const path of new Set(entry?.identity.gallery ?? [])) {
				await imageService.deleteImage(path);
			}
			for (const sprite of entry?.identity.sprites ?? []) {
				await imageService.deleteImage(sprite.path);
			}
			await db.deleteLibraryEntry(id);
			this.confirmNewEntry(id);
		}

		this._entries = this._entries.filter((entry) => !idSet.has(entry.id));
		this._versions = this._versions.filter((v) => !idSet.has(v.entryId));
		return unboundChatIds;
	}

	async setFavoriteMany(ids: string[], isFavorite: boolean): Promise<void> {
		let changed = false;
		for (const id of ids) {
			const entry = this.getEntryById(id);
			if (!entry || entry.isFavorite === isFavorite) continue;
			entry.isFavorite = isFavorite;
			await db.updateLibraryEntryFavorite(id, isFavorite);
			changed = true;
		}
		if (changed) this._entries = [...this._entries];
	}

	/** Add the given tags to every entry that's missing them. Returns how many changed. */
	async addTagsMany(ids: string[], tags: string[]): Promise<number> {
		const clean = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
		if (clean.length === 0 || ids.length === 0) return 0;
		let changed = 0;
		for (const id of ids) {
			const entry = this.getEntryById(id);
			if (!entry) continue;
			const existing = entry.identity.tags ?? [];
			const merged = [...existing];
			for (const tag of clean) if (!merged.includes(tag)) merged.push(tag);
			if (merged.length === existing.length) continue;
			entry.identity = { ...this.clone(entry.identity), tags: merged };
			entry.updatedAt = Date.now();
			await db.updateLibraryEntry(entry);
			changed++;
		}
		if (changed) this._entries = [...this._entries];
		return changed;
	}

	/** Strip the given tags from every selected entry. Returns how many changed. */
	async removeTagsMany(ids: string[], tags: string[]): Promise<number> {
		const toRemove = new Set(tags.map((t) => t.trim()).filter(Boolean));
		if (toRemove.size === 0 || ids.length === 0) return 0;
		let changed = 0;
		for (const id of ids) {
			const entry = this.getEntryById(id);
			if (!entry) continue;
			const existing = entry.identity.tags ?? [];
			const filtered = existing.filter((tag) => !toRemove.has(tag));
			if (filtered.length === existing.length) continue;
			entry.identity = { ...this.clone(entry.identity), tags: filtered };
			entry.updatedAt = Date.now();
			await db.updateLibraryEntry(entry);
			changed++;
		}
		if (changed) this._entries = [...this._entries];
		return changed;
	}

	/** Get all unique tags across all entries */
	get allTags(): string[] {
		const tagSet = new Set<string>();
		for (const entry of this._entries) {
			if (entry.identity.tags) {
				for (const tag of entry.identity.tags) {
					tagSet.add(tag);
				}
			}
		}
		return Array.from(tagSet).sort();
	}
}

export const characterLibraryStore = new CharacterLibraryStore();
