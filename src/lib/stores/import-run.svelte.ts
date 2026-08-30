/**
 * The SillyTavern folder import, held outside the page that starts it.
 *
 * An import walks a whole library and takes as long as that takes, so the reader closes
 * Settings and goes back to a chat while it runs. The run's state therefore cannot live in
 * `settings/ImportPage.svelte`: closing the panel unmounts that card, and the progress goes off
 * the screen and the summary lands nowhere while the import itself carries on writing
 * characters, chats and pictures. Held here, `layout/ImportBar` reports it for as long as it
 * runs and the page picks the summary back up on its next mount.
 *
 * Reading the pick is a step of its own (`pending`), because an import is hundreds of
 * irreversible writes and this app has no undo: the counts belong on screen while the answer
 * is still no.
 *
 * That step is also where the pick is narrowed, and the two costs are deliberately unequal.
 * **Everything is on by default, so bringing a whole profile over is still the pick and one
 * press**, with nothing to open and nothing to tick; only somebody who wants less pays for it.
 * Narrowing is subtraction and nothing else (`excluded` → `withoutKeys`), so the importer is
 * handed a smaller bundle rather than a bundle plus instructions, and there is no second place
 * where a file can be decided against.
 *
 * **A run can be stopped and there is no resuming it**, by decision. What continues a stopped
 * import is running the same folder again: every file that landed is claimed in the import
 * ledger (architecture/server-core.md), so the next scan finds only what is left. That is the
 * same mechanism that keeps a second run from duplicating a first one, and it survives a stop,
 * a reload and a server that died mid-way, none of which a stored resume position would.
 *
 * The page draws its own summary and its own failure line, so neither says anything through the
 * toast stack: whoever is looking at that card is looking straight at the thing that did the
 * work. The standing row carries the running condition, and the finish toast fires only for a
 * reader who is somewhere else.
 *
 * Runtime state, written nowhere. The run is one page's async call, so a reload ends it, and
 * anything persisted here would outlive the thing it describes.
 */
import {
	importSillyTavernFolder,
	type ImportProgress,
	type ImportReport
} from '$lib/services/sillyTavernFolderImport';
import {
	cardStemFromKey,
	countFiles,
	planGroups,
	readPersonaSettings,
	scanSillyTavernFolder,
	stemOf,
	strandedByChoice,
	withoutKeys,
	type FolderScan,
	type ImportedSource
} from '$lib/services/sillyTavernFolderScan';
import { db } from '$lib/services/database';
import { isReachable, onReachabilityChange } from '$lib/services/transport';
import { characterLibraryStore } from './characterLibrary.svelte';
import { lorebookStore } from '$lib/lorebook/store.svelte';
import { failureText, toastStore } from './toast.svelte';
import { SvelteSet } from 'svelte/reactivity';

/** A pick that was not a profile folder. It names what to pick instead, since "not found"
 *  without a way forward is where an import stops for good. */
const NOT_FOUND =
	'No SillyTavern data in that folder. Pick your profile folder, usually "data/default-user".';

/** Why a run ended early. Both are ordinary endings rather than failures, and each is said in
 *  its own words: one is a decision, the other is an outage the reader has to fix first. */
export type StopReason = 'you' | 'connection';

class ImportRunStore {
	/** The whole pick, waiting for the reader to confirm it. */
	pending = $state<FolderScan | null>(null);
	/** What the ledger already holds, read when the folder was picked and handed to the run so
	 *  it can bind this folder's chats to cards an earlier run brought over. */
	private claims = $state<ImportedSource[]>([]);
	/**
	 * Which claims still stand.
	 *
	 * **A claim that names what it became is only worth as much as that thing still existing.**
	 * Cards and personas record their library entry and world files record their lorebook, so one
	 * the reader has since deleted by hand stops counting and the file is offered again: skipping
	 * it would be the card stating something about the library that is not true any more, with
	 * the reader's own deletion as the reason. The kinds that record nothing (backgrounds, chats,
	 * sprites) cannot be asked, so their claims stand and the checkbox below stays the way back
	 * to them.
	 */
	private known = $derived.by(() => {
		const live = new Set<string>(characterLibraryStore.entries.map((entry) => entry.id));
		// One set for two shelves: an `entity_id` names a library entry or a lorebook, and the
		// only question asked of it is whether that thing is still there.
		for (const book of lorebookStore.books) live.add(book.id);
		const keys = new Set<string>();
		for (const claim of this.claims) {
			if (claim.entityId && !live.has(claim.entityId)) continue;
			keys.add(claim.key);
		}
		return keys;
	});
	/** Bring the already-imported files over a second time. Off by default and deliberately
	 *  reachable even when everything in the folder is known, since re-importing something the
	 *  reader has since deleted is the one thing skipping would otherwise make impossible. */
	bringKnownAgain = $state(false);
	/**
	 * Source keys the reader has switched off on the confirm card.
	 *
	 * Held as EXCLUSIONS rather than as a selection, and the difference shows the moment the
	 * plan grows: a file arriving because the ledger checkbox was ticked is on, which is the
	 * answer somebody who never opened that group expects. A stored selection would have to
	 * guess, and would guess "off" for everything nobody has touched.
	 */
	excluded = $state(new SvelteSet<string>());

	running = $state(false);
	progress = $state<ImportProgress | null>(null);
	report = $state<ImportReport | null>(null);
	error = $state<string | null>(null);
	/** Set when the last run ended early, cleared when the next one starts. */
	stoppedBy = $state<StopReason | null>(null);

	private controller: AbortController | null = null;

	/** The pick minus what the ledger already holds. Stands on its own rather than living inside
	 *  `plan`, so the count below can be measured against it whatever the checkbox says. */
	private fresh = $derived(this.pending ? withoutKeys(this.pending, this.known) : null);

	/**
	 * Everything on offer: the pick minus what the ledger already holds, unless the reader
	 * asked for all of it. This is what the card DRAWS, switched off rows included, because a
	 * row that vanished when it was unticked would take its own way back with it.
	 */
	private offered = $derived.by(() => {
		if (!this.pending) return null;
		return this.bringKnownAgain ? this.pending : this.fresh;
	});

	/** What Import would actually write: everything on offer, minus what has been switched off. */
	plan = $derived(this.offered ? withoutKeys(this.offered, this.excluded) : null);

	/** Persona display names, read off the picked profile's `settings.json` when the folder was
	 *  chosen. It is the only label on this card that does not come off a path. */
	private personaNames = $state<Record<string, string>>({});

	/** The rows themselves, in the order the import writes them. */
	groups = $derived(
		this.offered ? planGroups(this.offered, { personas: this.personaNames }) : []
	);

	/** How many files Import would write, which is the number the button carries. */
	planned = $derived(this.plan ? countFiles(this.plan) : 0);

	/**
	 * Every name a chat or sprite folder could bind to: the character cards this run would
	 * write, the ones an earlier run claimed that the library still holds, and the display
	 * names already in the library. **The importer's own three sources, restated here to ask
	 * before the run what the report would otherwise only answer after it.** The two move
	 * together: a change to how `sillyTavernFolderImport` resolves a folder belongs here in the
	 * same piece of work, or this card warns about the wrong files.
	 */
	private resolvableCharacters = $derived.by(() => {
		const names = new Set<string>();
		const live = new Set(characterLibraryStore.entries.map((entry) => entry.id));
		for (const claimed of this.claims) {
			const stem = cardStemFromKey(claimed.key);
			if (stem && claimed.entityId && live.has(claimed.entityId)) names.add(stem);
		}
		for (const entry of characterLibraryStore.entries) {
			if (entry.type !== 'character') continue;
			const name = entry.identity.name?.trim().toLowerCase();
			if (name) names.add(name);
		}
		for (const file of this.plan?.characters ?? []) names.add(stemOf(file.name).toLowerCase());
		return names;
	});

	/** The card stems this card is OFFERING, which is what "tick it back on" can reach. A card
	 *  an earlier run already claimed is not among them and does not need to be: it resolves
	 *  above, so nothing of its ever reads as stranded. */
	private offeredStems = $derived.by(() => {
		const stems = new Set<string>();
		for (const file of this.offered?.characters ?? []) stems.add(stemOf(file.name).toLowerCase());
		return stems;
	});

	/** Chats and sprite packs the plan would send to a character the reader switched off.
	 *  Measured against the PLAN, so unticking the character that strands them is what makes
	 *  the warning appear, and ticking it back is what makes it go. */
	stranded = $derived(
		this.plan
			? strandedByChoice(this.plan, this.resolvableCharacters, this.offeredStems)
			: { chats: 0, sprites: 0 }
	);

	/** How many of the picked files this folder has sent before. Measured against the pick and
	 *  never against the plan: off the plan it collapses to zero the moment the reader ticks the
	 *  box, which erases the number the box is asking about and takes the row itself off screen
	 *  with it, leaving no way to untick. */
	alreadyImported = $derived(
		this.pending && this.fresh ? countFiles(this.pending) - countFiles(this.fresh) : 0
	);

	/** How many Import pages are on screen. Not reactive: it is read once, at the end of a run. */
	private onScreen = 0;

	/** Called by the Import page for its lifetime, so the finish toast can stand down while the
	 *  summary it would repeat is already being drawn. */
	watch(): () => void {
		this.onScreen++;
		return () => {
			this.onScreen--;
		};
	}

	/** Read a picked folder and hold what was found, against what has come over before. */
	async scan(files: File[]): Promise<void> {
		this.report = null;
		this.error = null;
		this.stoppedBy = null;
		this.bringKnownAgain = false;
		// A new pick is a clean slate: keys from the last folder would switch off files in this
		// one that happen to sit at the same path, which is every second SillyTavern profile.
		this.excluded.clear();
		this.pending = null;

		const found = scanSillyTavernFolder(files);
		if (!found) {
			this.error = NOT_FOUND;
			return;
		}
		// The card is published only once the ledger has answered, and both are set together:
		// shown a moment earlier it would state the whole folder as the plan, and an Import
		// pressed in that moment writes every duplicate the ledger exists to prevent.
		try {
			this.claims = await db.getImportedSources();
		} catch (e) {
			// Without the ledger every file reads as new. The pick is dropped rather than offered
			// under a count that would be a lie.
			this.error = failureText('check what has already been imported', e);
			return;
		}

		// A persona's name lives in settings.json rather than in its picture's filename, so the
		// card reads that one file to label those rows. A profile with none, or one whose
		// settings cannot be parsed, leaves the rows on the filename, which is not a failure
		// papered over: it is the same name the run itself would write for that persona, and a
		// file that will not parse is reported by the run in its own words.
		this.personaNames = {};
		if (found.settingsFile) {
			try {
				this.personaNames = readPersonaSettings(await found.settingsFile.text()).names;
			} catch (e) {
				console.error('Reading SillyTavern persona names failed:', e);
			}
		}
		this.pending = found;
	}

	/** Switch a row on or off. A row is its whole key list, so a sprite pack and a character's
	 *  chat history move as the one thing they are written as. */
	setKeys(keys: string[], on: boolean): void {
		for (const key of keys) {
			if (on) this.excluded.delete(key);
			else this.excluded.add(key);
		}
	}

	/** Everything on, or everything off. Off is what makes "only these two characters" two
	 *  clicks instead of one per group, and it is why it sits beside All rather than being
	 *  reachable only by unticking each heading. */
	setAll(on: boolean): void {
		if (on) {
			this.excluded.clear();
			return;
		}
		for (const group of this.groups) {
			for (const item of group.items) this.setKeys(item.keys, false);
		}
	}

	discard(): void {
		this.pending = null;
	}

	/** End the run at the next item boundary. Never inside one: half a character, its card
	 *  written and its sprites not, is worse than one more character. */
	stop(reason: StopReason = 'you'): void {
		if (!this.running) return;
		this.stoppedBy = reason;
		this.controller?.abort();
	}

	async start(): Promise<void> {
		const plan = this.plan;
		if (!plan) throw new Error('Nothing scanned to import');
		this.pending = null;
		this.running = true;
		this.report = null;
		this.error = null;
		this.progress = null;
		this.stoppedBy = null;
		this.controller = new AbortController();

		// An outage ends the run rather than grinding the rest of the folder into a list of
		// identical failures: every write fails while the server is gone, and what has landed
		// is already claimed, so the way to finish is to run the folder again once it is back.
		const watchConnection = onReachabilityChange((reachable) => {
			if (!reachable) this.stop('connection');
		});
		if (!isReachable()) this.stop('connection');

		try {
			const report = await importSillyTavernFolder(plan, {
				onProgress: (p) => (this.progress = p),
				signal: this.controller.signal,
				claims: this.claims
			});
			this.report = report;
			if (this.onScreen === 0) this.announce(report);
		} catch (e) {
			this.error = failureText('import that folder', e);
		} finally {
			watchConnection();
			this.controller = null;
			this.running = false;
			this.progress = null;
		}
	}

	/** Work that landed off-screen, which is the toast channel's own case. The counts are the
	 *  headline; the per-category summary is waiting on the page. */
	private announce(report: ImportReport): void {
		const groups = [
			report.characters,
			report.sprites,
			report.worlds,
			report.backgrounds,
			report.personas,
			report.chats
		];
		const imported = groups.reduce((sum, g) => sum + g.imported, 0);
		const failed = groups.reduce((sum, g) => sum + g.failed.length, 0);
		if (this.stoppedBy === 'connection') {
			toastStore.warning(`SillyTavern import stopped, the server went away. ${imported} items came over.`);
			return;
		}
		if (this.stoppedBy === 'you') {
			toastStore.info(`SillyTavern import stopped, ${imported} items came over`);
			return;
		}
		if (failed > 0) {
			toastStore.warning(`Imported ${imported} items from SillyTavern, ${failed} failed`);
			return;
		}
		toastStore.success(`Imported ${imported} items from SillyTavern`);
	}
}

export const importRun = new ImportRunStore();
