/**
 * SillyTavern folder importer.
 *
 * The browser hands us the whole picked folder as a flat FileList (via <input webkitdirectory>),
 * each file tagged with its `webkitRelativePath`. We sort those into SillyTavern's known
 * sub-folders and route each one through the SAME import path the app already uses for that
 * kind of asset, so there's ONE character importer, ONE lorebook importer, etc., and this
 * module only does the folder plumbing and orchestration:
 *
 *   backgrounds/       → imageService.saveImage(file, 'backgrounds')
 *   characters/        → importSillyTavernCard + characterLibraryStore.importFromSillyTavern
 *   characters/<name>/ → characterLibraryStore.addSprites, labelled from the filenames
 *   worlds/            → readLorebookFile + lorebookStore.addBook
 *   User Avatars/      → imageService.saveImage(file, 'personas') + persona from settings.json
 *   chats/<name>/      → chatStore.importSillyTavernChat, bound to the matching character
 *   settings.json      → persona names + descriptions
 *
 * The order the phases run in is the binding order, not a preference. Lorebooks land first
 * because a card names its own book (`extensions.world`) and carries a copy of it besides, and
 * a book that is already on the shelf is linked rather than shelved again. Characters land
 * next, before their sprites and their chats, both of which bind to the character their folder
 * names.
 *
 * Reading is two steps, and the split is what lets the reader point at the folder they know the
 * name of. [`sillyTavernFolderScan.ts`](./sillyTavernFolderScan.ts) resolves the pick down to
 * one data root and buckets its files, in pure path arithmetic; this module writes that bundle.
 * Nothing is written before someone has seen which root was resolved, because a wrong one is a
 * wrong library and this app has no undo.
 */
import { imageService } from '$lib/services/imageService';
import { importSillyTavernCard } from '$lib/services/sillyTavernImport';
import { readLorebookFile } from '$lib/lorebook/io';
import { createBookIndex } from '$lib/lorebook/identity';
import { lorebookStore } from '$lib/lorebook/store.svelte';
import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
import { chatStore } from '$lib/stores/chat.svelte';
import { labelFromFilename } from '$lib/utils/sprites';
import { db } from '$lib/services/database';
import type { LibrarySeed } from '$lib/types/library';
import {
	cardStemFromKey,
	readPersonaSettings,
	sourceKey,
	stemOf,
	worldStemFromKey,
	type FolderScan,
	type ImportedSource,
	type PersonaSettings
} from '$lib/services/sillyTavernFolderScan';

export interface ImportProgress {
	/** Human phase label, e.g. "Characters". */
	phase: string;
	done: number;
	total: number;
}

export interface CategoryResult {
	imported: number;
	/** Per-item failures, "<file>: <reason>". */
	failed: string[];
}

export interface ImportReport {
	characters: CategoryResult;
	sprites: CategoryResult & {
		/** Sprite folders that matched no library entry. */
		skippedNoCharacter: string[];
	};
	worlds: CategoryResult & {
		/** How many of the books that landed came out of a character card rather than a
		 *  `worlds/` file. Said on screen because those books have no row on the confirm card:
		 *  they are not files, so nothing in the pick announces them. */
		fromCards: number;
		/** Characters bound to a book that was already here instead of shelving a copy of it.
		 *  The count is what proves the binding ran, since its whole effect is an absence. */
		linked: number;
	};
	backgrounds: CategoryResult;
	personas: CategoryResult;
	chats: CategoryResult & {
		/** Chat files whose character folder matched no library entry. */
		skippedNoCharacter: string[];
	};
	/** How many files landed but could not be claimed, because the ledger refused the batch.
	 *  The same folder brings each of them over a second time, which is the one failure here
	 *  whose cost is paid on a LATER run, so the count is said on screen. */
	ledgerLost: number;
}

export interface ImportOptions {
	onProgress?: (p: ImportProgress) => void;
	/** Stopped by the reader, or by the server going away. Checked between items and never
	 *  inside one: half a character (card written, sprites not) is worse than one more. */
	signal?: AbortSignal;
	/** What earlier runs already claimed, read when this folder was picked. Passed in rather
	 *  than read again here: it is the same answer, and a second read is a second thing that
	 *  can fail mid-import. */
	claims?: ImportedSource[];
}

/** How many claims wait before they are written. One row per file doubles an import's chatter;
 *  one write at the end loses every claim the moment a run is stopped. */
const LEDGER_BATCH = 20;

/** Collects claims as files land and writes them in batches. */
function openLedger(root: string, report: ImportReport) {
	let waiting: { key: string; entityId?: string }[] = [];

	async function flush(): Promise<void> {
		if (waiting.length === 0) return;
		const batch = waiting;
		waiting = [];
		try {
			await db.recordImportedSources(batch);
		} catch {
			// Counted rather than thrown. A lost batch costs one batch of duplicates on some
			// later run; a throw here would cost the reader every count of what actually landed,
			// and the run may well carry on and land plenty more (a refused call is not an
			// outage: reachability only turns over once a reconnect has failed).
			report.ledgerLost += batch.length;
		}
	}

	return {
		flush,
		async claim(file: File, entityId?: string): Promise<void> {
			waiting.push({ key: sourceKey(root, file), entityId });
			if (waiting.length >= LEDGER_BATCH) await flush();
		}
	};
}

function emptyCategory(): CategoryResult {
	return { imported: 0, failed: [] };
}

function reason(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Import one bundle of SillyTavern files. Reports per-category outcomes; a single bad file
 * never aborts the run (it lands in that category's `failed` list).
 *
 * A stop is honoured **between items**, and each file that lands is claimed in the import
 * ledger, so stopping and running the same folder again picks up where this left off with no
 * resume state anywhere: the next scan simply finds less to do.
 */
export async function importSillyTavernFolder(
	scan: FolderScan,
	{ onProgress, signal, claims = [] }: ImportOptions = {}
): Promise<ImportReport> {
	const report: ImportReport = {
		characters: emptyCategory(),
		sprites: { ...emptyCategory(), skippedNoCharacter: [] },
		worlds: { ...emptyCategory(), fromCards: 0, linked: 0 },
		backgrounds: emptyCategory(),
		personas: emptyCategory(),
		chats: { ...emptyCategory(), skippedNoCharacter: [] },
		ledgerLost: 0
	};
	const { characters, spritesByFolder, worlds, backgrounds, avatars, chats } = scan;
	const ledger = openLedger(scan.root, report);
	// Every loop below opens with this, so a stop lands at the next item boundary and every
	// phase after it falls straight through.
	const stopped = () => signal?.aborted === true;

	// Parse settings.json up front (personas need it).
	let personaSettings: PersonaSettings = { names: {}, descriptions: {} };
	if (scan.settingsFile) {
		try {
			personaSettings = readPersonaSettings(await scan.settingsFile.text());
		} catch (e) {
			report.personas.failed.push(`settings.json: ${reason(e)}`);
		}
	}

	// ---- Lorebooks (worlds/, before the cards that name them) ----
	// One shelf-wide answer to "have we got this book", built from the books that are here now
	// and grown as this run lands more. A card meets the same book as a `worlds/` file and as its
	// own embedded copy, and every card sharing a book meets it again, so without this a profile
	// shelves one book per card that uses it.
	const bookIndex = createBookIndex(lorebookStore.books);
	// What earlier runs shelved, by the SillyTavern world name a card would link to. A claim
	// pointing at a book that is gone is left out, exactly as a card's claim is: it would bind
	// this run's characters to nothing.
	const liveBooks = new Set(lorebookStore.books.map((book) => book.id));
	for (const claimed of claims) {
		const world = worldStemFromKey(claimed.key);
		if (world && claimed.entityId && liveBooks.has(claimed.entityId)) {
			bookIndex.bindWorldName(world, claimed.entityId);
		}
	}

	for (let i = 0; i < worlds.length; i++) {
		if (stopped()) break;
		const file = worlds[i];
		onProgress?.({ phase: 'Lorebooks', done: i, total: worlds.length });
		try {
			const book = await readLorebookFile(file);
			await lorebookStore.addBook(book);
			bookIndex.add(book);
			// The file's own name is the world name a card links to.
			bookIndex.bindWorldName(stemOf(file.name), book.id);
			report.worlds.imported++;
			// Claimed WITH what it became, the same as a card: it is what a later run's cards bind
			// to by name, and a book deleted by hand stops counting so the file is offered again.
			await ledger.claim(file, book.id);
		} catch (e) {
			report.worlds.failed.push(`${file.name}: ${reason(e)}`);
		}
	}

	// ---- Characters (before chats, which bind to them) ----
	// SillyTavern folders chats by the character's AVATAR FILENAME, not its display name
	// (same-named cards disambiguate as Jason.png / Jason_1.png → chats/Jason/, chats/Jason_1/).
	// So we remember each imported card's filename stem to bind its chats back precisely.
	// Display-name matching would collide on duplicates and strand the second one's chats.
	const charByFileStem = new Map<string, string>();

	// A card this run skips because an earlier one already brought it over still owns the chats
	// and sprites arriving now, and they name it by that same filename, so the ledger's own
	// answer for it is seeded first, and this run's cards overwrite their own stems below. An
	// entry deleted since is left out: a chat bound to an id nothing holds is worse than one
	// reported as unmatched.
	const liveEntries = new Set(characterLibraryStore.entries.map((entry) => entry.id));
	for (const claimed of claims) {
		const stem = cardStemFromKey(claimed.key);
		if (stem && claimed.entityId && liveEntries.has(claimed.entityId)) {
			charByFileStem.set(stem, claimed.entityId);
		}
	}

	for (let i = 0; i < characters.length; i++) {
		if (stopped()) break;
		const file = characters[i];
		onProgress?.({ phase: 'Characters', done: i, total: characters.length });
		try {
			const result = await importSillyTavernCard(file);
			// SillyTavern's own link first: the card names its book and that book is a file in
			// this same folder, already shelved above. Its embedded copy is the one SillyTavern
			// itself stops reading once that world exists, so a resolved link stands in for it.
			const linkBookId = result.worldName ? bookIndex.byWorldName(result.worldName) : null;
			// Full migration: bring the card's book along and link it.
			const { entry, book } = await characterLibraryStore.importFromSillyTavern(result, {
				importLorebook: true,
				bookIndex,
				linkBookId
			});
			if (book?.created) {
				report.worlds.imported++;
				report.worlds.fromCards++;
			} else if (book) {
				report.worlds.linked++;
			}
			charByFileStem.set(stemOf(file.name).toLowerCase(), entry.id);
			report.characters.imported++;
			await ledger.claim(file, entry.id);
		} catch (e) {
			report.characters.failed.push(`${file.name}: ${reason(e)}`);
		}
	}

	// Both the sprite folders and the chat folders are named by the card's AVATAR FILENAME,
	// so `charByFileStem` above resolves them precisely. The display-name map is the fallback
	// for characters already in the library whose card was not in this batch (a sprites- or
	// chats-only folder, or a card that failed above); cards from this batch never reach it.
	// `entries` is updated_at DESC and the first match wins, so a duplicated display name
	// resolves to the most recently touched entry rather than an arbitrary one.
	const charByName = new Map<string, string>();
	for (const entry of characterLibraryStore.entries) {
		if (entry.type !== 'character') continue;
		const key = entry.identity.name?.trim().toLowerCase();
		if (key && !charByName.has(key)) charByName.set(key, entry.id);
	}
	const characterIdForFolder = (folder: string): string | undefined => {
		const key = folder.trim().toLowerCase();
		return charByFileStem.get(key) ?? charByName.get(key);
	};

	// ---- Sprites (characters/<Name>/<label>.png) ----
	// Grouped by folder in the scan, so a 28-image pack is one write, not 28 writes and
	// 28 broadcasts.
	let spriteFolder = 0;
	for (const [folder, files] of spritesByFolder) {
		if (stopped()) break;
		onProgress?.({ phase: 'Sprites', done: spriteFolder++, total: spritesByFolder.size });
		const characterId = characterIdForFolder(folder);
		if (!characterId) {
			report.sprites.skippedNoCharacter.push(`${folder}/ (${files.length})`);
			continue;
		}
		try {
			const refused = await characterLibraryStore.addSprites(
				characterId,
				files.map((file) => ({ file, label: labelFromFilename(file.name) }))
			);
			report.sprites.imported += files.length - refused.length;
			for (const label of refused) {
				report.sprites.failed.push(`${folder}/${label}: that label is already used`);
			}
			// The whole pack is claimed, refusals included: a label already in use is this file
			// having arrived before, which is exactly what the ledger records.
			for (const file of files) await ledger.claim(file);
		} catch (e) {
			report.sprites.failed.push(`${folder}/: ${reason(e)}`);
		}
	}

	// ---- Backgrounds ----
	for (let i = 0; i < backgrounds.length; i++) {
		if (stopped()) break;
		const file = backgrounds[i];
		onProgress?.({ phase: 'Backgrounds', done: i, total: backgrounds.length });
		try {
			await imageService.saveImage(file, 'backgrounds');
			report.backgrounds.imported++;
			await ledger.claim(file);
		} catch (e) {
			report.backgrounds.failed.push(`${file.name}: ${reason(e)}`);
		}
	}

	// ---- Personas (User Avatars image + settings.json name/description) ----
	for (let i = 0; i < avatars.length; i++) {
		if (stopped()) break;
		const file = avatars[i];
		onProgress?.({ phase: 'Personas', done: i, total: avatars.length });
		try {
			const imageUrl = await imageService.saveImage(file, 'personas');
			const seed: LibrarySeed = {
				id: crypto.randomUUID(),
				name: personaSettings.names[file.name] || stemOf(file.name),
				imageUrl,
				traits: {
					personality: '',
					description: personaSettings.descriptions[file.name] ?? '',
					background: ''
				}
			};
			await characterLibraryStore.savePersona(seed);
			report.personas.imported++;
			// Claimed WITH what it became, the same as a card. A claim that names its entry stops
			// counting the moment that entry is deleted, which is what lets a persona somebody
			// removed by hand be offered again instead of being skipped forever.
			await ledger.claim(file, seed.id);
		} catch (e) {
			report.personas.failed.push(`${file.name}: ${reason(e)}`);
		}
	}

	// ---- Chats (bind to the character their folder names, same resolution as sprites) ----
	for (let i = 0; i < chats.length; i++) {
		if (stopped()) break;
		const { file, characterName } = chats[i];
		onProgress?.({ phase: 'Chats', done: i, total: chats.length });
		const characterId = characterIdForFolder(characterName);
		if (!characterId) {
			report.chats.skippedNoCharacter.push(`${characterName}/${file.name}`);
			continue;
		}
		try {
			const text = await file.text();
			const lines = text.split('\n');
			const { chatId } = await chatStore.importSillyTavernChat({ characterId, lines });
			if (chatId) {
				report.chats.imported++;
				await ledger.claim(file);
			} else report.chats.failed.push(`${file.name}: no importable messages`);
		} catch (e) {
			report.chats.failed.push(`${file.name}: ${reason(e)}`);
		}
	}

	await ledger.flush();
	onProgress?.({ phase: 'Done', done: 1, total: 1 });
	return report;
}
