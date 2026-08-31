/**
 * How the lorebook shelf is drawn and ordered: layout, card size, results per page, and the
 * display order.
 *
 * The ORDER is one choice for the whole app, not one per list: the Library's Lorebooks shelf
 * and the link picker in the character editor are two views of the same shelf, and picking an
 * order twice would cost exactly the work this exists to save. The other three belong to the
 * shelf alone, since the picker is a popover with one shape.
 *
 * Rides the settings spine like the browse-view and sprite prefs, so it survives a reload and
 * follows the user to their other devices. **The key is still `lorebookSort`**, which is what
 * every install already holds: a bare string there is a stored order from before the shelf had
 * anything else to remember, and it is read back as one rather than dropped.
 *
 * Display only: `lorebookStore.books` is never reordered, because link resolution reads that
 * order to decide what reaches the prompt first (`sortLorebooks` in lorebook/types.ts).
 */
import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';
import { PER_PAGE_OPTIONS, type ViewMode } from '$lib/components/library/browse';
import type { LorebookSortOrder } from '$lib/lorebook/types';

const SETTINGS_KEY = 'lorebookSort';

/** The orders offered, in the order they are offered. Also the validity list a stored value is
 *  read back through, so an option that goes away cannot leave a device on it. */
export const LOREBOOK_SORT_OPTIONS: { id: LorebookSortOrder; label: string }[] = [
	{ id: 'a-z', label: 'A → Z' },
	{ id: 'z-a', label: 'Z → A' },
	{ id: 'updated', label: 'Recently edited' }
];

const VIEW_MODES: ViewMode[] = ['grid', 'list', 'gallery'];

interface LorebookViewState {
	order: LorebookSortOrder;
	viewMode: ViewMode;
	cardSize: number;
	perPage: number;
}

/** List, because a shelf is scanned by name far more often than it is browsed by cover, and
 *  most books carry no cover at all. */
const DEFAULTS: LorebookViewState = {
	order: 'a-z',
	viewMode: 'list',
	cardSize: 3,
	perPage: 50
};

function normalize(raw: unknown): LorebookViewState {
	// A bare string is the stored order from before this held anything else.
	const blob = (typeof raw === 'string' ? { order: raw } : (raw ?? {})) as Partial<LorebookViewState>;
	return {
		order: LOREBOOK_SORT_OPTIONS.find((option) => option.id === blob.order)?.id ?? DEFAULTS.order,
		viewMode: VIEW_MODES.includes(blob.viewMode as ViewMode)
			? (blob.viewMode as ViewMode)
			: DEFAULTS.viewMode,
		cardSize:
			typeof blob.cardSize === 'number' && blob.cardSize >= 1 && blob.cardSize <= 5
				? blob.cardSize
				: DEFAULTS.cardSize,
		perPage: PER_PAGE_OPTIONS.includes(blob.perPage as number) ? (blob.perPage as number) : DEFAULTS.perPage
	};
}

class LorebookViewPrefs {
	order = $state<LorebookSortOrder>(DEFAULTS.order);
	viewMode = $state<ViewMode>(DEFAULTS.viewMode);
	cardSize = $state<number>(DEFAULTS.cardSize);
	perPage = $state<number>(DEFAULTS.perPage);

	async initialize(): Promise<void> {
		await this.syncReload();
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		const state = normalize(await readSetting<unknown>(SETTINGS_KEY, null));
		this.order = state.order;
		this.viewMode = state.viewMode;
		this.cardSize = state.cardSize;
		this.perPage = state.perPage;
	}

	setOrder(order: LorebookSortOrder): void {
		this.order = order;
		this.persist();
	}

	setViewMode(viewMode: ViewMode): void {
		this.viewMode = viewMode;
		this.persist();
	}

	setCardSize(cardSize: number): void {
		this.cardSize = cardSize;
		this.persist();
	}

	setPerPage(perPage: number): void {
		this.perPage = perPage;
		this.persist();
	}

	private persist(): void {
		writeSetting(SETTINGS_KEY, {
			order: this.order,
			viewMode: this.viewMode,
			cardSize: this.cardSize,
			perPage: this.perPage
		} satisfies LorebookViewState);
	}
}

export const lorebookViewPrefs = new LorebookViewPrefs();

/** The default card size, for the range control's own reset gesture. */
export const LOREBOOK_VIEW_DEFAULTS = DEFAULTS;
