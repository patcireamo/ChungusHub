import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';
import { CONFIRM_GESTURES, type ConfirmGesture } from '$lib/config/delete-confirm';

/**
 * The destructive-act ladder's three rungs, in one setting rather than two switches
 * (architecture/ui-shell-settings.md). They are one continuum and not two questions: with
 * asking switched off there is no dialog left for a hold to live on, so a pair of booleans
 * would spell one of its four states as nothing at all.
 */
export type DeleteConfirmRung = 'hold' | 'ask' | 'off';

const DELETE_CONFIRM_RUNGS: readonly DeleteConfirmRung[] = ['hold', 'ask', 'off'];

interface AdvancedSettings {
	promptDebugPanel: boolean;
	/** The rung that survives a reload and reaches every device. A temporary drop rides
	 *  `stores/delete-guard.svelte.ts` instead and is deliberately never stored here. */
	deleteConfirm: DeleteConfirmRung;
	/** How the heavy rung is performed: a press and hold, or two presses. Only read while the
	 *  rung is `hold`; the lower rungs never reach a heavy confirm to perform. */
	confirmGesture: ConfirmGesture;
	/** The Developer group under Settings → About. No control writes it: the version row's
	 *  tap streak is its only switch, so it stays a setting nobody meets by accident. */
	developerMode: boolean;
}

const SETTINGS_KEY = 'advancedSettings';

const DEFAULT_SETTINGS: AdvancedSettings = {
	promptDebugPanel: false,
	deleteConfirm: 'hold',
	confirmGesture: 'hold',
	developerMode: false
};

/** Coerce a raw settings blob into a valid config, dropping anything unexpected. */
function normalize(raw: Partial<AdvancedSettings> | null): AdvancedSettings {
	return {
		promptDebugPanel:
			typeof raw?.promptDebugPanel === 'boolean'
				? raw.promptDebugPanel
				: DEFAULT_SETTINGS.promptDebugPanel,
		deleteConfirm: DELETE_CONFIRM_RUNGS.includes(raw?.deleteConfirm as DeleteConfirmRung)
			? (raw!.deleteConfirm as DeleteConfirmRung)
			: DEFAULT_SETTINGS.deleteConfirm,
		confirmGesture: CONFIRM_GESTURES.includes(raw?.confirmGesture as ConfirmGesture)
			? (raw!.confirmGesture as ConfirmGesture)
			: DEFAULT_SETTINGS.confirmGesture,
		developerMode:
			typeof raw?.developerMode === 'boolean' ? raw.developerMode : DEFAULT_SETTINGS.developerMode
	};
}

class AdvancedSettingsStore {
	settings = $state<AdvancedSettings>({ ...DEFAULT_SETTINGS });

	promptDebugPanel = $derived(this.settings.promptDebugPanel);
	deleteConfirm = $derived(this.settings.deleteConfirm);
	confirmGesture = $derived(this.settings.confirmGesture);
	developerMode = $derived(this.settings.developerMode);

	async initialize(): Promise<void> {
		this.settings = normalize(await readSetting<Partial<AdvancedSettings> | null>(SETTINGS_KEY, null));
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		this.settings = normalize(await readSetting<Partial<AdvancedSettings> | null>(SETTINGS_KEY, null));
	}

	setPromptDebugPanel(enabled: boolean): void {
		this.settings.promptDebugPanel = enabled;
		this.persist();
	}

	setDeveloperMode(enabled: boolean): void {
		this.settings.developerMode = enabled;
		this.persist();
	}

	setDeleteConfirm(rung: DeleteConfirmRung): void {
		this.settings.deleteConfirm = rung;
		this.persist();
	}

	setConfirmGesture(gesture: ConfirmGesture): void {
		this.settings.confirmGesture = gesture;
		this.persist();
	}

	private persist(): void {
		writeSetting(SETTINGS_KEY, this.settings);
	}
}

export const advancedSettingsStore = new AdvancedSettingsStore();
