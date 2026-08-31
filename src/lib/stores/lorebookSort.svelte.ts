/**
 * How the lorebook lists are ordered on screen.
 *
 * One choice for the whole app, not one per list: the Library's Lorebooks shelf and the link
 * picker in the character editor are two views of the same shelf, and picking an order twice
 * would cost exactly the work this exists to save.
 * Rides the settings spine like the browse-view and sprite prefs, so it survives a reload
 * and follows the user to their other devices.
 *
 * Display only: `lorebookStore.books` is never reordered, because link resolution reads that
 * order to decide what reaches the prompt first (`sortLorebooks` in lorebook/types.ts).
 */
import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';
import type { LorebookSortOrder } from '$lib/lorebook/types';

const SETTINGS_KEY = 'lorebookSort';

/** The orders offered, in the order they are offered. Also the validity list a stored value is
 *  read back through, so an option that goes away cannot leave a device on it. */
export const LOREBOOK_SORT_OPTIONS: { id: LorebookSortOrder; label: string }[] = [
	{ id: 'a-z', label: 'A → Z' },
	{ id: 'z-a', label: 'Z → A' },
	{ id: 'updated', label: 'Recently edited' }
];

const DEFAULT_ORDER: LorebookSortOrder = 'a-z';

function normalize(raw: unknown): LorebookSortOrder {
	return LOREBOOK_SORT_OPTIONS.find((option) => option.id === raw)?.id ?? DEFAULT_ORDER;
}

class LorebookSortPref {
	order = $state<LorebookSortOrder>(DEFAULT_ORDER);

	async initialize(): Promise<void> {
		await this.syncReload();
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		this.order = normalize(await readSetting<unknown>(SETTINGS_KEY, null));
	}

	set(order: LorebookSortOrder): void {
		this.order = order;
		writeSetting(SETTINGS_KEY, order);
	}
}

export const lorebookSortPref = new LorebookSortPref();
