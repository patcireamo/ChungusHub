/**
 * Global lorebook activation settings: one JSON row in the settings table, loaded at app
 * boot and read reactively everywhere the activation engine runs (real prompt, token meters,
 * the lorebook page). Books override individual values; `null` on a book = inherit these.
 */
import { db } from '$lib/services/database';
import { registerSettingsReload } from '$lib/services/syncedSetting';
import {
	DEFAULT_LOREBOOK_GLOBAL_SETTINGS,
	LOREBOOK_SETTINGS_KEY as SETTINGS_KEY,
	type LorebookGlobalSettings
} from './types';

class LorebookSettingsStore {
	private _settings = $state<LorebookGlobalSettings>({ ...DEFAULT_LOREBOOK_GLOBAL_SETTINGS });
	private _initialized = false;

	get settings(): LorebookGlobalSettings {
		return this._settings;
	}

	async initialize(): Promise<void> {
		if (this._initialized) return;
		await this.syncReload();
		// These values steer real prompt assembly (scan depth, budget, recursion), so a
		// device that missed a change here builds quietly different prompts.
		registerSettingsReload(() => this.syncReload());
		this._initialized = true;
	}

	async syncReload(): Promise<void> {
		const raw = await db.getSetting(SETTINGS_KEY);
		if (raw) {
			// Merge over the defaults so a settings row from an older version stays complete.
			this._settings = { ...DEFAULT_LOREBOOK_GLOBAL_SETTINGS, ...JSON.parse(raw) };
		}
	}

	async update(patch: Partial<LorebookGlobalSettings>): Promise<void> {
		this._settings = { ...this._settings, ...patch };
		await db.setSetting(SETTINGS_KEY, JSON.stringify(this._settings));
	}
}

export const lorebookSettingsStore = new LorebookSettingsStore();
