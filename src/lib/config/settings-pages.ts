/**
 * The settings information architecture, in ONE place: the root groups and rows
 * (a phone-style drill-down, with no icon tab rail), which page hosts each
 * assistant deep-link anchor, and the per-row live previews shown on the root.
 *
 * Hand-kept couplings:
 *  - Every `data-setting` anchor in a page component (and its twin in
 *    `server/assistant/registry/settings.ts`) needs an ANCHOR_PAGES entry, or
 *    `navigateTo` can't reach its page (architecture/chungus-assistant.md rule 1).
 *  - `TAB_FALLBACK_PAGE` covers every `SettingsTab`: the assistant's `tab` ids are
 *    the deep-link contract, and there is no rail for them to point at.
 *  - Previews read singleton stores/services; the root re-renders on every
 *    page return (keyed), so they refresh without being reactive.
 *  - A page added here needs its arm in `SettingsPageView.svelte`, or its row
 *    opens an empty panel.
 */
import { llmService } from '$lib/services/llm/provider';
import { connectionStore } from '$lib/stores/connections.svelte';
import { ENGINES } from '$lib/engines/registry';
import { backupStore } from '$lib/stores/backups.svelte';
import { advancedSettingsStore } from '$lib/stores/advanced-settings.svelte';
import { APP_VERSION } from '$lib/version';

/**
 * The assistant's deep-link tab ids. No icon rail carries them, so they exist purely
 * as the `navigate` contract, which is why they live here with the rest of the settings IA
 * rather than in the UI store. `TAB_FALLBACK_PAGE` below is typed `Record<SettingsTab, …>`,
 * which is what forces a new tab to land somewhere real. `NavTarget` (types/assistant.ts)
 * imports this union; the server's copy is asserted in `src/lib/contracts.test.ts`.
 */
export type SettingsTab =
	| 'general'
	| 'connection'
	| 'interface'
	| 'advanced'
	| 'security'
	| 'engines'
	| 'promptBuilder'
	| 'regex';

export type SettingsPage =
	// Connection
	| 'connections'
	// Appearance
	| 'interface'
	| 'chat'
	// App
	| 'general'
	| 'engines'
	| 'security'
	| 'import'
	| 'backups'
	// Advanced
	| 'prompt-builder'
	| 'regex'
	| 'advanced'
	// About
	| 'about'
	| 'developer';

/** Literal subset of ui/Icon's IconName (not exported there), all verified members. */
export type SettingsRowIcon =
	| 'radar'
	| 'sun'
	| 'columns'
	| 'image'
	| 'settings'
	| 'bolt'
	| 'shield'
	| 'wrench'
	| 'filter'
	| 'flask'
	| 'download'
	| 'archive'
	| 'info'
	| 'sliders';

export interface SettingsRow {
	page: SettingsPage;
	label: string;
	icon: SettingsRowIcon;
	/** Live value shown on the root row; omit for rows with no one-line summary. */
	preview?: () => string;
	/** A row that is not always there. Omit for the permanent ones. Read on every render of
	 *  the root list, so a row can come and go while the list is on screen (split view). */
	shown?: () => boolean;
}

export interface SettingsGroup {
	label: string;
	rows: SettingsRow[];
}

function connectionsSummary(): string {
	const id = llmService.getPrimaryModel();
	const model = id ? (id.split('/').pop() ?? id) : 'No model';
	const count = connectionStore.list().length;
	return count > 1 ? `${model} · ${count} connections` : model;
}

function enginesSummary(): string {
	const on = ENGINES.filter((e) => e.enabled.get()).length;
	return `${on} of ${ENGINES.length} on`;
}

/**
 * Reads the settings half only. The listing is server state the page fetches when it opens,
 * and the root row must not be the thing that goes and gets it, since every return to the root
 * re-renders these previews, which would make walking around Settings poll the backup store.
 */
function backupsSummary(): string {
	const { automatic, intervalHours } = backupStore.settings;
	if (!automatic) return 'Automatic backups off';
	if (intervalHours === 6) return 'Every 6 hours';
	return intervalHours === 24 ? 'Once a day' : 'Once a week';
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
	{
		label: 'Connection',
		rows: [{ page: 'connections', label: 'Connections', icon: 'radar', preview: connectionsSummary }]
	},
	{
		label: 'App',
		rows: [
			{ page: 'general', label: 'General', icon: 'settings' },
			{ page: 'engines', label: 'Engines', icon: 'bolt', preview: enginesSummary },
			{ page: 'security', label: 'Security', icon: 'shield' },
			{ page: 'backups', label: 'Backups', icon: 'archive', preview: backupsSummary },
			{ page: 'import', label: 'Import', icon: 'download' }
		]
	},
	{
		label: 'Appearance',
		rows: [
			{ page: 'interface', label: 'Interface', icon: 'sun' },
			{ page: 'chat', label: 'Chat', icon: 'columns' }
		]
	},
	{
		label: 'Advanced',
		rows: [
			{ page: 'prompt-builder', label: 'Prompt Builder', icon: 'wrench' },
			{ page: 'regex', label: 'Regex', icon: 'filter' },
			{ page: 'advanced', label: 'Advanced', icon: 'flask' }
		]
	},
	{
		label: 'About',
		rows: [
			{ page: 'about', label: 'About', icon: 'info', preview: () => APP_VERSION },
			{
				page: 'developer',
				label: 'Developer',
				icon: 'sliders',
				shown: () => advancedSettingsStore.developerMode
			}
		]
	}
];

/** Which page hosts each assistant deep-link `data-setting` anchor. */
export const ANCHOR_PAGES: Record<string, SettingsPage> = {
	// Connection (all live inside the Connections page / its editor)
	connections: 'connections',
	'model-routing': 'connections',
	provider: 'connections',
	'api-key': 'connections',
	'primary-model': 'connections',
	generation: 'connections',
	'response-behavior': 'connections',
	'context-size': 'connections',
	'prompt-post-processing': 'connections',
	'prompt-caching': 'connections',
	// Appearance
	palette: 'interface',
	// A conditional anchor: it exists only while a palette is open in the editor, so a deep
	// link with none open lands on the page and flashes nothing. It is routable rather than a
	// bare marker because a `data-setting` with no entry here is an anchor the app cannot
	// reach, which is the rule at the top of this file. `interface-defaults` and
	// `chat-defaults` below are the same shape.
	'palette-editor': 'interface',
	accent: 'interface',
	'interface-type': 'interface',
	surfaces: 'interface',
	'chat-scene': 'interface',
	background: 'interface',
	'ambient-effects': 'interface',
	'reading-column': 'chat',
	'story-type': 'chat',
	'chat-style': 'chat',
	'message-shape': 'chat',
	'message-colors': 'chat',
	'message-avatars': 'chat',
	'story-text': 'chat',
	'message-chrome': 'chat',
	'message-details': 'chat',
	// One of these on each Appearance page, conditional the way `palette-editor` is: a page
	// already at the shipped default carries no Restore defaults, so a link lands on the
	// page and flashes nothing.
	'interface-defaults': 'interface',
	'chat-defaults': 'chat',
	// General
	'message-drafts': 'general',
	'input-history': 'general',
	'long-chats': 'general',
	reasoning: 'general',
	'assistant-button': 'general',
	'story-map-scroll': 'general',
	'split-view': 'general',
	// Security
	'network-access': 'security',
	'ip-allowlist': 'security',
	'password-lock': 'security',
	// Backups
	'automatic-backups': 'backups',
	'backup-history': 'backups',
	// Engines
	engines: 'engines',
	// Workshop
	'prompt-builder': 'prompt-builder',
	'regex-rules': 'regex',
	'prompt-debug-panel': 'advanced',
	'prompt-review': 'advanced',
	'delete-confirmations': 'advanced',
	thumbnails: 'advanced'
};

/** Landing page per assistant tab id, for deep links whose anchor is unknown. */
export const TAB_FALLBACK_PAGE: Record<SettingsTab, SettingsPage> = {
	general: 'general',
	connection: 'connections',
	interface: 'interface',
	security: 'security',
	engines: 'engines',
	promptBuilder: 'prompt-builder',
	regex: 'regex',
	advanced: 'advanced'
};

