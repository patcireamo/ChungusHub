/**
 * How the open lorebook's entry list is ordered and narrowed on screen.
 *
 * One choice for the whole app rather than one per book: a reader hunting a long book sets an
 * order once and expects the next book to keep it, and re-picking it per book would cost
 * exactly the work this exists to save. Per book would also mean writing the preference onto
 * the book itself, which is stored data every install already holds. Rides the settings spine
 * like the browse-view, sprite and book-shelf prefs, so it survives a reload and follows the
 * user to their other devices.
 *
 * Display only: `book.entries` is never reordered and nothing here reaches a prompt. The
 * engine returns survivors in `order` sequence and the block is built from that
 * (`sortEntries` in lorebook/types.ts).
 */
import type { LorebookEntryNature, LorebookEntrySort } from '$lib/lorebook/types';
import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';

const SETTINGS_KEY = 'lorebookEntryPrefs';

/** The orders offered, in the order they are offered: the two everyday ones first, then the
 *  two that answer a question about the text, then the pair that answers one about the keys.
 *  Also the validity list a stored value is read back through, so an option that goes away
 *  cannot leave a device on it. */
export const LOREBOOK_ENTRY_SORT_OPTIONS: { id: LorebookEntrySort; label: string }[] = [
	{ id: 'order', label: 'Order' },
	{ id: 'order-desc', label: 'Reverse order' },
	{ id: 'a-z', label: 'A → Z' },
	{ id: 'z-a', label: 'Z → A' },
	{ id: 'longest', label: 'Longest' },
	{ id: 'shortest', label: 'Shortest' },
	{ id: 'most-keys', label: 'Most keys' },
	{ id: 'fewest-keys', label: 'Fewest keys' }
];

/** The three natures, worded and ordered exactly as the entry row's own behavior switch
 *  words them: a row the list calls "Off" cannot read as something else once it is open. */
export const LOREBOOK_ENTRY_NATURE_OPTIONS: { id: LorebookEntryNature; label: string }[] = [
	{ id: 'always', label: 'Always' },
	{ id: 'keyword', label: 'Keyword' },
	{ id: 'off', label: 'Off' }
];

/** Today's order, kept as the default so no existing book rearranges itself on upgrade. */
const DEFAULT_SORT: LorebookEntrySort = 'order';

interface EntryPrefsState {
	sort: LorebookEntrySort;
	/** The natures held OUT of the list, not the ones let in. Stored as the exception so the
	 *  quiet state is an empty array, and so a nature added later arrives visible. */
	hidden: LorebookEntryNature[];
}

function normalize(raw: Partial<EntryPrefsState> | null): EntryPrefsState {
	const sort = LOREBOOK_ENTRY_SORT_OPTIONS.some((o) => o.id === raw?.sort)
		? (raw!.sort as LorebookEntrySort)
		: DEFAULT_SORT;
	const stored = Array.isArray(raw?.hidden) ? raw.hidden : [];
	const hidden = LOREBOOK_ENTRY_NATURE_OPTIONS.filter((o) => stored.includes(o.id)).map((o) => o.id);
	return { sort, hidden };
}

class LorebookEntryPrefs {
	sort = $state<LorebookEntrySort>(DEFAULT_SORT);
	hidden = $state<LorebookEntryNature[]>([]);

	async initialize(): Promise<void> {
		await this.syncReload();
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		this.apply(normalize(await readSetting<Partial<EntryPrefsState> | null>(SETTINGS_KEY, null)));
	}

	private apply(state: EntryPrefsState): void {
		this.sort = state.sort;
		this.hidden = state.hidden;
	}

	setSort(sort: LorebookEntrySort): void {
		this.sort = sort;
		this.persist();
	}

	toggleNature(nature: LorebookEntryNature): void {
		this.hidden = this.hidden.includes(nature)
			? this.hidden.filter((n) => n !== nature)
			: [...this.hidden, nature];
		this.persist();
	}

	showAll(): void {
		this.hidden = [];
		this.persist();
	}

	private persist(): void {
		// Spread rather than hand over the reactive array itself: what is stored is a snapshot,
		// not a live view of the store.
		writeSetting(SETTINGS_KEY, {
			sort: this.sort,
			hidden: [...this.hidden]
		} satisfies EntryPrefsState);
	}
}

export const lorebookEntryPrefs = new LorebookEntryPrefs();
