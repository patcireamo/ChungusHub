<script lang="ts">
	import {
		generalSettingsStore,
		type InputHistoryScope,
		type TranscriptLoadMode
	} from '$lib/stores/general-settings.svelte';
	import { inputHistoryStore } from '$lib/stores/inputHistory.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import PillRow from '$lib/components/ui/PillRow.svelte';
	import { MOD_KEY } from '$lib/components/ui/ShortcutsSheet.svelte';
	import { toggleRow } from '$lib/actions/toggleRow';

	const SCOPE_OPTIONS: { value: InputHistoryScope; label: string }[] = [
		{ value: 'global', label: 'All chats' },
		{ value: 'chat', label: 'Current chat only' }
	];

	const LOAD_MODE_OPTIONS: { value: TranscriptLoadMode; label: string }[] = [
		{ value: 'scroll', label: 'As I scroll back' },
		{ value: 'button', label: 'With a button' }
	];

	let saveDrafts = $derived(generalSettingsStore.saveDrafts);
	let inputHistory = $derived(generalSettingsStore.inputHistory);
	let historyScope = $derived(generalSettingsStore.inputHistoryScope);
	let historyLimit = $derived(generalSettingsStore.inputHistoryLimit);
	let historyCount = $derived(inputHistoryStore.entries.length);
	let transcriptPaging = $derived(generalSettingsStore.transcriptPaging);
	let transcriptPageSize = $derived(generalSettingsStore.transcriptPageSize);
	let transcriptLoadMode = $derived(generalSettingsStore.transcriptLoadMode);
	let autoExpandReasoning = $derived(generalSettingsStore.autoExpandReasoning);
	let assistantLauncher = $derived(generalSettingsStore.assistantLauncher);
	let settingsSplitView = $derived(generalSettingsStore.settingsSplitView);
	let storyMapWheelPans = $derived(generalSettingsStore.storyMapWheelPans);

	let clearing = $state(false);

	function handleHistoryLimit(event: Event): void {
		const input = event.target as HTMLInputElement;
		const value = Number(input.value);
		if (!Number.isFinite(value)) return;
		generalSettingsStore.setInputHistoryLimit(value);
		// The store clamps; reflect the value that actually stuck.
		input.value = String(generalSettingsStore.inputHistoryLimit);
	}

	function handlePageSize(event: Event): void {
		const input = event.target as HTMLInputElement;
		const value = Number(input.value);
		if (!Number.isFinite(value)) return;
		generalSettingsStore.setTranscriptPageSize(value);
		// The store clamps; reflect the value that actually stuck.
		input.value = String(generalSettingsStore.transcriptPageSize);
	}

	async function clearHistory(): Promise<void> {
		if (clearing) return;
		clearing = true;
		try {
			await inputHistoryStore.clearAll();
		} finally {
			clearing = false;
		}
	}
</script>

<div class="general">
	<section class="card" data-setting="message-drafts">
		<div class="card-head">
			<span class="card-title">Message Drafts</span>
			<InfoTip
				text="Unsent text in the chat box is kept per chat and synced across your devices until you send it or clear it."
			/>
		</div>
		<div class="toggle-row" use:toggleRow>
			<span class="slider-label">Save unsent drafts</span>
			<Toggle
				checked={saveDrafts}
				onchange={(v) => generalSettingsStore.setSaveDrafts(v)}
				label="Save unsent drafts"
			/>
		</div>
	</section>

	<section class="card" data-setting="input-history">
		<div class="card-head">
			<span class="card-title">Input History</span>
			<InfoTip
				text="With the chat box empty, ↑ and ↓ step through messages you've already sent. Keyboard only, and entries outlive the messages and chats they came from."
			/>
		</div>
		<div class="toggle-row" use:toggleRow>
			<span class="slider-label">Recall sent messages with ↑ / ↓</span>
			<Toggle
				checked={inputHistory}
				onchange={(v) => generalSettingsStore.setInputHistory(v)}
				label="Recall sent messages with ↑ / ↓"
			/>
		</div>

		{#if inputHistory}
			<div class="sub">
				<span class="section-label">Recall</span>
				<div class="row-block">
					<span class="slider-label">Recall from</span>
					<PillRow
						options={SCOPE_OPTIONS}
						current={historyScope}
						onpick={(v) => generalSettingsStore.setInputHistoryScope(v as InputHistoryScope)}
						label="Recall from"
					/>
				</div>
				<div class="row-block">
					<label for="history-limit" class="slider-label">Max entries kept</label>
					<input
						id="history-limit"
						class="input-base limit-input"
						type="number"
						min="10"
						max="1000"
						value={historyLimit}
						onchange={handleHistoryLimit}
					/>
				</div>
				<div class="history-clear-row">
					<button
						type="button"
						class="history-clear-btn"
						onclick={clearHistory}
						disabled={clearing || historyCount === 0}
					>
						Clear input history
					</button>
					<span class="text-xs font-ui text-text-muted">
						{historyCount} {historyCount === 1 ? 'entry' : 'entries'} stored
					</span>
				</div>
			</div>
		{/if}
	</section>

	<section class="card" data-setting="reasoning">
		<div class="card-head">
			<span class="card-title">Reasoning</span>
			<InfoTip
				text="A reasoning model's thinking lives in a collapsible box above the message, never in the story and never sent back with later prompts."
			/>
		</div>
		<div class="toggle-row" use:toggleRow>
			<span class="slider-label">Auto-expand the reasoning box</span>
			<Toggle
				checked={autoExpandReasoning}
				onchange={(v) => generalSettingsStore.setAutoExpandReasoning(v)}
				label="Auto-expand the reasoning box"
			/>
		</div>
	</section>

	<section class="card" data-setting="long-chats">
		<div class="card-head">
			<span class="card-title">Long Chats</span>
			<InfoTip
				text="A chat opens on its newest turns instead of drawing its whole branch at once, which is what makes a long story slow to open and slow to stream on an older machine. Nothing is hidden from search: find in chat covers the whole branch and loads back to whatever it lands on, and the story map and the chats panel are never limited."
			/>
		</div>
		<div class="toggle-row" use:toggleRow>
			<span class="slider-label">Load long chats in parts</span>
			<Toggle
				checked={transcriptPaging}
				onchange={(v) => generalSettingsStore.setTranscriptPaging(v)}
				label="Load long chats in parts"
			/>
		</div>

		{#if transcriptPaging}
			<div class="sub">
				<span class="section-label">Loading</span>
				<div class="row-block">
					<label for="transcript-page-size" class="slider-label">Turns per load</label>
					<input
						id="transcript-page-size"
						class="input-base limit-input"
						type="number"
						min="10"
						max="1000"
						value={transcriptPageSize}
						onchange={handlePageSize}
					/>
				</div>
				<div class="row-block">
					<span class="slider-label">Earlier turns arrive</span>
					<PillRow
						options={LOAD_MODE_OPTIONS}
						current={transcriptLoadMode}
						onpick={(v) => generalSettingsStore.setTranscriptLoadMode(v as TranscriptLoadMode)}
						label="Earlier turns arrive"
					/>
				</div>
			</div>
		{/if}
	</section>

	<section class="card" data-setting="assistant-button">
		<div class="card-head">
			<span class="card-title">Chungus Assistant</span>
			<InfoTip
				text="The floating assistant button in the corner of the workspace. Hidden, {MOD_KEY}+J still opens the panel and turn activity announces itself inside it instead."
			/>
		</div>
		<div class="toggle-row" use:toggleRow>
			<span class="slider-label">Floating assistant button</span>
			<Toggle
				checked={assistantLauncher}
				onchange={(v) => generalSettingsStore.setAssistantLauncher(v)}
				label="Floating assistant button"
			/>
		</div>
	</section>

	<section class="card" data-setting="story-map-scroll">
		<div class="card-head">
			<span class="card-title">Story Map</span>
			<InfoTip
				text="Zooming moves to {MOD_KEY}+scroll. A trackpad pinch zooms either way."
			/>
		</div>
		<div class="toggle-row" use:toggleRow>
			<span class="slider-label">Scroll moves the map instead of zooming</span>
			<Toggle
				checked={storyMapWheelPans}
				onchange={(v) => generalSettingsStore.setStoryMapWheelPans(v)}
				label="Scroll moves the map instead of zooming"
			/>
		</div>
	</section>

		<!-- Split view only exists at dock widths (≥76rem): below that Settings is
		     a single centered overlay and the toggle would be inert, so don't pretend
		     it works (the panel is a plain drill-down there). -->
		{#if viewport.canDockSettings}
			<section class="card" data-setting="split-view">
				<div class="card-head">
					<span class="card-title">Settings Panel</span>
					<InfoTip
						text="On wide screens the section list stays docked and pages open in a panel beside it. Off keeps the phone-style drill-down."
					/>
				</div>
				<div class="toggle-row" use:toggleRow>
					<span class="slider-label">Split view on wide screens</span>
					<Toggle
						checked={settingsSplitView}
						onchange={(v) => generalSettingsStore.setSettingsSplitView(v)}
						label="Split view on wide screens"
					/>
				</div>
			</section>
		{/if}
</div>

<style>
	.general {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	/* Labeled sub-group inside a card (Recall): a quiet seam + micro label. */
	.sub {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin-top: 0.9rem;
		padding-top: 0.8rem;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 45%, transparent);
	}

	.row-block {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.limit-input {
		width: 100%;
		padding: 0.45rem 0.6rem;
		font-family: var(--font-mono);
		font-size: 0.85rem;
		color: var(--color-text-primary);
	}

	.history-clear-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.history-clear-btn {
		padding: 0.45rem 0.8rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-error) 45%, var(--color-border));
		background: transparent;
		color: var(--color-error);
		font-family: var(--font-ui);
		font-weight: 600;
		font-size: 0.78rem;
		cursor: pointer;
		transition: background-color 120ms ease;
	}

	.history-clear-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
	}

	.history-clear-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
