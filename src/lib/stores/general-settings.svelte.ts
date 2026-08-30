import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';

export type InputHistoryScope = 'global' | 'chat';

/** How the turns behind the transcript window arrive: on their own as the reader scrolls
 *  back, or one press at a time from the button at the top of the window. */
export type TranscriptLoadMode = 'scroll' | 'button';

interface GeneralSettings {
	saveDrafts: boolean;
	inputHistory: boolean;
	/** What ↑/↓ recalls: everything ever sent, or only the current chat's inputs. */
	inputHistoryScope: InputHistoryScope;
	/** How many sent messages the history log keeps (oldest trimmed first). */
	inputHistoryLimit: number;
	/** Render a long chat from its newest end instead of all at once. Every turn on screen
	 *  costs a markdown parse, a card of DOM and a row the scroller re-measures on every
	 *  streaming token, so a long story is slow to open and drags every reply after it. */
	transcriptPaging: boolean;
	/** Turns rendered per load: the window a chat opens on, and every step back from there. */
	transcriptPageSize: number;
	/** What reaches back for earlier turns: the scroll itself, or a press. */
	transcriptLoadMode: TranscriptLoadMode;
	/** Open the per-message reasoning box by default (streaming and saved turns). */
	autoExpandReasoning: boolean;
	/** Read by nothing. Who a story plays as is claimed in the chat itself (the composer's
	 *  setup chip), so there is no app-wide switch to show or hide. The key is still parsed
	 *  and written back so an install that recorded a value keeps it byte for byte. */
	personaSwitcher: boolean;
	/** Show the floating Chungus Assistant launcher in the workspace corner. Off hides
	 *  the button only: the assistant itself is untouched, and Ctrl/⌘+J still opens it. */
	assistantLauncher: boolean;
	/** Split Settings on wide screens: the dock keeps the section list and pages
	 *  open in a wide centered panel. Off = phone-style drill-down everywhere.
	 *  Inert below dock widths (the panel is a single centered overlay there). */
	settingsSplitView: boolean;
	/** What a plain wheel or two-finger trackpad scroll does on the story map canvas:
	 *  on it pans, off it zooms. Ctrl+scroll zooms and Shift+scroll pans sideways either
	 *  way, so a trackpad pinch (which reaches the page as ctrl+wheel) is never affected. */
	storyMapWheelPans: boolean;
	/** Whether the welcome dialog has run once. Not a preference the reader sets from a
	 *  row, but it rides the spine like one deliberately: the settings blob is server-side,
	 *  so opening the app on a phone after setting it up on a desktop does NOT greet you a
	 *  second time. localStorage would, and would also greet a second browser on the same
	 *  machine. Settings → the root's footer row reopens the dialog without clearing it. */
	welcomeSeen: boolean;
	/** Whether the Chungus Assistant's cost notice has been read. Same reasoning as
	 *  `welcomeSeen`: it rides the spine, so a warning read on the desktop is not repeated
	 *  on the phone. Settings → Developer clears it, which is the only way it comes back. */
	assistantCostSeen: boolean;
}

const SETTINGS_KEY = 'generalSettings';

const HISTORY_LIMIT_MIN = 10;
const HISTORY_LIMIT_MAX = 1000;

const DEFAULT_SETTINGS: GeneralSettings = {
	saveDrafts: true,
	inputHistory: true,
	inputHistoryScope: 'global',
	inputHistoryLimit: 100,
	transcriptPaging: true,
	transcriptPageSize: 100,
	transcriptLoadMode: 'scroll',
	autoExpandReasoning: false,
	personaSwitcher: false,
	assistantLauncher: true,
	settingsSplitView: false,
	storyMapWheelPans: false,
	welcomeSeen: false,
	assistantCostSeen: false
};

function clampLimit(value: number): number {
	return Math.min(HISTORY_LIMIT_MAX, Math.max(HISTORY_LIMIT_MIN, Math.round(value)));
}

const PAGE_SIZE_MIN = 10;
const PAGE_SIZE_MAX = 1000;

function clampPageSize(value: number): number {
	return Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, Math.round(value)));
}

/** Coerce a raw settings blob into a valid config, dropping anything unexpected. */
function normalize(raw: Partial<GeneralSettings> | null): GeneralSettings {
	return {
		saveDrafts: typeof raw?.saveDrafts === 'boolean' ? raw.saveDrafts : DEFAULT_SETTINGS.saveDrafts,
		inputHistory:
			typeof raw?.inputHistory === 'boolean' ? raw.inputHistory : DEFAULT_SETTINGS.inputHistory,
		inputHistoryScope:
			raw?.inputHistoryScope === 'chat' || raw?.inputHistoryScope === 'global'
				? raw.inputHistoryScope
				: DEFAULT_SETTINGS.inputHistoryScope,
		inputHistoryLimit:
			typeof raw?.inputHistoryLimit === 'number' && Number.isFinite(raw.inputHistoryLimit)
				? clampLimit(raw.inputHistoryLimit)
				: DEFAULT_SETTINGS.inputHistoryLimit,
		transcriptPaging:
			typeof raw?.transcriptPaging === 'boolean'
				? raw.transcriptPaging
				: DEFAULT_SETTINGS.transcriptPaging,
		transcriptPageSize:
			typeof raw?.transcriptPageSize === 'number' && Number.isFinite(raw.transcriptPageSize)
				? clampPageSize(raw.transcriptPageSize)
				: DEFAULT_SETTINGS.transcriptPageSize,
		transcriptLoadMode:
			raw?.transcriptLoadMode === 'button' || raw?.transcriptLoadMode === 'scroll'
				? raw.transcriptLoadMode
				: DEFAULT_SETTINGS.transcriptLoadMode,
		autoExpandReasoning:
			typeof raw?.autoExpandReasoning === 'boolean'
				? raw.autoExpandReasoning
				: DEFAULT_SETTINGS.autoExpandReasoning,
		personaSwitcher:
			typeof raw?.personaSwitcher === 'boolean'
				? raw.personaSwitcher
				: DEFAULT_SETTINGS.personaSwitcher,
		assistantLauncher:
			typeof raw?.assistantLauncher === 'boolean'
				? raw.assistantLauncher
				: DEFAULT_SETTINGS.assistantLauncher,
		settingsSplitView:
			typeof raw?.settingsSplitView === 'boolean'
				? raw.settingsSplitView
				: DEFAULT_SETTINGS.settingsSplitView,
		storyMapWheelPans:
			typeof raw?.storyMapWheelPans === 'boolean'
				? raw.storyMapWheelPans
				: DEFAULT_SETTINGS.storyMapWheelPans,
		welcomeSeen:
			typeof raw?.welcomeSeen === 'boolean' ? raw.welcomeSeen : DEFAULT_SETTINGS.welcomeSeen,
		assistantCostSeen:
			typeof raw?.assistantCostSeen === 'boolean'
				? raw.assistantCostSeen
				: DEFAULT_SETTINGS.assistantCostSeen
	};
}

class GeneralSettingsStore {
	settings = $state<GeneralSettings>({ ...DEFAULT_SETTINGS });

	saveDrafts = $derived(this.settings.saveDrafts);
	inputHistory = $derived(this.settings.inputHistory);
	inputHistoryScope = $derived(this.settings.inputHistoryScope);
	inputHistoryLimit = $derived(this.settings.inputHistoryLimit);
	transcriptPaging = $derived(this.settings.transcriptPaging);
	transcriptPageSize = $derived(this.settings.transcriptPageSize);
	transcriptLoadMode = $derived(this.settings.transcriptLoadMode);
	autoExpandReasoning = $derived(this.settings.autoExpandReasoning);
	assistantLauncher = $derived(this.settings.assistantLauncher);
	settingsSplitView = $derived(this.settings.settingsSplitView);
	storyMapWheelPans = $derived(this.settings.storyMapWheelPans);
	welcomeSeen = $derived(this.settings.welcomeSeen);
	assistantCostSeen = $derived(this.settings.assistantCostSeen);

	async initialize(): Promise<void> {
		this.settings = normalize(await readSetting<Partial<GeneralSettings> | null>(SETTINGS_KEY, null));
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		this.settings = normalize(await readSetting<Partial<GeneralSettings> | null>(SETTINGS_KEY, null));
	}

	setSaveDrafts(enabled: boolean): void {
		this.settings.saveDrafts = enabled;
		this.persist();
	}

	setInputHistory(enabled: boolean): void {
		this.settings.inputHistory = enabled;
		this.persist();
	}

	setInputHistoryScope(scope: InputHistoryScope): void {
		this.settings.inputHistoryScope = scope;
		this.persist();
	}

	setInputHistoryLimit(limit: number): void {
		this.settings.inputHistoryLimit = clampLimit(limit);
		this.persist();
	}

	setTranscriptPaging(enabled: boolean): void {
		this.settings.transcriptPaging = enabled;
		this.persist();
	}

	setTranscriptPageSize(size: number): void {
		this.settings.transcriptPageSize = clampPageSize(size);
		this.persist();
	}

	setTranscriptLoadMode(mode: TranscriptLoadMode): void {
		this.settings.transcriptLoadMode = mode;
		this.persist();
	}

	setAutoExpandReasoning(enabled: boolean): void {
		this.settings.autoExpandReasoning = enabled;
		this.persist();
	}

	setAssistantLauncher(enabled: boolean): void {
		this.settings.assistantLauncher = enabled;
		this.persist();
	}

	setSettingsSplitView(enabled: boolean): void {
		this.settings.settingsSplitView = enabled;
		this.persist();
	}

	setStoryMapWheelPans(enabled: boolean): void {
		this.settings.storyMapWheelPans = enabled;
		this.persist();
	}

	setWelcomeSeen(seen: boolean): void {
		this.settings.welcomeSeen = seen;
		this.persist();
	}

	setAssistantCostSeen(seen: boolean): void {
		this.settings.assistantCostSeen = seen;
		this.persist();
	}

	private persist(): void {
		writeSetting(SETTINGS_KEY, this.settings);
	}
}

export const generalSettingsStore = new GeneralSettingsStore();
