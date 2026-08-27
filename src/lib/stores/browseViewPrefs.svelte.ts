/**
 * Browse-view preferences for the Library's Characters and Personas lists.
 *
 * View mode, card size, sort order, and results-per-page: the toolbar choices the
 * user makes while browsing. Formerly stored per-device in localStorage; now they
 * ride the settings spine so a choice on one device follows the user to the others.
 * One packed settings key per surface.
 */
import { PER_PAGE_OPTIONS, CHARACTER_SORT_OPTIONS, type SortOption, type ViewMode } from '$lib/components/library/browse';
import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';

interface BrowseViewState {
	viewMode: ViewMode;
	cardSize: number;
	sort: SortOption;
	perPage: number;
	/** List rows draw the entry's tags. Off by default: the strip costs the preview line
	 *  its second row, which is a trade only the reader can make. */
	listTags: boolean;
}

export const DEFAULTS: BrowseViewState = {
	viewMode: 'list',
	cardSize: 3,
	sort: 'newest',
	perPage: 50,
	listTags: false
};

const VIEW_MODES: ViewMode[] = ['grid', 'list', 'gallery'];

/** Coerce a raw settings blob into a valid state, dropping anything out of range. */
function normalize(raw: Partial<BrowseViewState> | null): BrowseViewState {
	const viewMode = VIEW_MODES.includes(raw?.viewMode as ViewMode) ? (raw!.viewMode as ViewMode) : DEFAULTS.viewMode;
	const cardSize =
		typeof raw?.cardSize === 'number' && raw.cardSize >= 1 && raw.cardSize <= 5 ? raw.cardSize : DEFAULTS.cardSize;
	// Validate against the characters superset: personas simply never offer the extras.
	const sort = CHARACTER_SORT_OPTIONS.some((o) => o.id === raw?.sort) ? (raw!.sort as SortOption) : DEFAULTS.sort;
	const perPage = PER_PAGE_OPTIONS.includes(raw?.perPage as number) ? (raw!.perPage as number) : DEFAULTS.perPage;
	const listTags = typeof raw?.listTags === 'boolean' ? raw.listTags : DEFAULTS.listTags;
	return { viewMode, cardSize, sort, perPage, listTags };
}

class BrowseViewPrefs {
	#key: string;

	viewMode = $state<ViewMode>(DEFAULTS.viewMode);
	cardSize = $state<number>(DEFAULTS.cardSize);
	sort = $state<SortOption>(DEFAULTS.sort);
	perPage = $state<number>(DEFAULTS.perPage);
	listTags = $state<boolean>(DEFAULTS.listTags);

	constructor(key: string) {
		this.#key = key;
	}

	async initialize(): Promise<void> {
		this.apply(normalize(await readSetting<Partial<BrowseViewState> | null>(this.#key, null)));
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		this.apply(normalize(await readSetting<Partial<BrowseViewState> | null>(this.#key, null)));
	}

	private apply(state: BrowseViewState): void {
		this.viewMode = state.viewMode;
		this.cardSize = state.cardSize;
		this.sort = state.sort;
		this.perPage = state.perPage;
		this.listTags = state.listTags;
	}

	setViewMode(mode: ViewMode): void {
		this.viewMode = mode;
		this.persist();
	}

	setCardSize(size: number): void {
		this.cardSize = size;
		this.persist();
	}

	setSort(sort: SortOption): void {
		this.sort = sort;
		this.persist();
	}

	setPerPage(perPage: number): void {
		this.perPage = perPage;
		this.persist();
	}

	setListTags(listTags: boolean): void {
		this.listTags = listTags;
		this.persist();
	}

	private persist(): void {
		writeSetting(this.#key, {
			viewMode: this.viewMode,
			cardSize: this.cardSize,
			sort: this.sort,
			perPage: this.perPage,
			listTags: this.listTags
		} satisfies BrowseViewState);
	}
}

export const libraryViewPrefs = new BrowseViewPrefs('libraryViewPrefs');
export const personasViewPrefs = new BrowseViewPrefs('personasViewPrefs');
