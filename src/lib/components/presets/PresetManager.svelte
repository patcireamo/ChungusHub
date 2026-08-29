<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import PromptDialog from '$lib/components/ui/PromptDialog.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { holdMsForBlast } from '$lib/components/ui/HoldToConfirmButton.svelte';
	import BrowsePopover from '$lib/components/library/BrowsePopover.svelte';
	import { presetService } from '$lib/services/presets.svelte';
	import { chatPresetStore } from '$lib/stores/chatPreset.svelte';
	import { triggerDownload } from '$lib/services/libraryExport';
	import { exportPresetCard, readPresetFromPng } from '$lib/services/presetCard';
	import { imageService } from '$lib/services/imageService';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { copyText } from '$lib/utils/clipboard';
	import type { PromptPreset } from '$lib/types/database';

	interface Props {
		id?: string;
		/** When false, only the actions menu renders: the caller supplies its own preset switcher. */
		showSelect?: boolean;
		showCreate?: boolean;
		showSave?: boolean;
		onSave?: () => void | Promise<void>;
		showEdit?: boolean;
		onEdit?: () => void;
		/** Shrinks the menu trigger to sit inline beside small text (the Preset
		 *  Controls identity switcher) instead of on a toolbar row. */
		compact?: boolean;
	}

	let {
		id = 'active-preset',
		showSelect = true,
		showCreate = false,
		showSave = false,
		onSave,
		showEdit = false,
		onEdit,
		compact = false
	}: Props = $props();

	let menuOpen = $state(false);
	let busy = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let allPresets = $derived(presetService.getAllPresets());
	let activeId = $derived(chatPresetStore.resolvedId ?? '');
	let activePreset = $derived(activeId ? presetService.getEffective(activeId) : null);

	type PromptState = {
		title: string;
		label: string;
		initial: string;
		confirmLabel: string;
		resolve: (value: string | null) => void;
	};
	type ConfirmState = {
		title: string;
		message: string;
		confirmLabel: string;
		variant: 'danger' | 'default';
		/** The heavy rung of the destructive-act ladder: > 0 makes the confirm a hold. */
		holdMs?: number;
		/** On the ladder, so the reader's rung may skip the asking altogether. */
		destructive?: boolean;
		resolve: (value: boolean) => void;
	};

	let promptState = $state<PromptState | null>(null);
	let confirmState = $state<ConfirmState | null>(null);

	function askName(title: string, label: string, initial: string, confirmLabel: string): Promise<string | null> {
		return new Promise((resolve) => {
			promptState = { title, label, initial, confirmLabel, resolve };
		});
	}

	function resolvePrompt(value: string | null): void {
		promptState?.resolve(value);
		promptState = null;
	}

	function askConfirm(state: Omit<ConfirmState, 'resolve'>): Promise<boolean> {
		return new Promise((resolve) => {
			confirmState = { ...state, resolve };
		});
	}

	function resolveConfirm(value: boolean): void {
		confirmState?.resolve(value);
		confirmState = null;
	}

	function rejectTakenName(name: string): boolean {
		if (!presetService.isNameTaken(name)) return false;
		toastStore.error(`A preset named "${name.trim()}" already exists`);
		return true;
	}

	/** Every lifecycle action runs through here, so each one has to NAME itself: the thrown
	 *  text alone ("EACCES", "invalid card") says nothing about which of the nine buttons in
	 *  this menu produced it. */
	async function run(act: string, action: () => Promise<unknown>): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await action();
		} catch (error) {
			toastStore.failed(act, error);
		} finally {
			busy = false;
		}
	}

	function closeAnd(action: () => Promise<void> | void): void {
		menuOpen = false;
		void action();
	}

	// Compared against what the open chat is ACTUALLY assembled with, and only a no-op while
	// that chat is already following the app: picking the preset an override happens to name
	// still has work to do, namely standing that override down.
	async function selectPreset(presetId: string): Promise<void> {
		if (!presetId || (presetId === activeId && chatPresetStore.scope === 'global')) return;
		await run('switch the preset', () => chatPresetStore.switchGlobal(presetId));
	}

	async function createPreset(): Promise<void> {
		const name = await askName('New preset', 'Preset name', '', 'Create');
		if (!name?.trim() || rejectTakenName(name)) return;
		await run(`create "${name.trim()}"`, async () => {
			const preset = await presetService.createPreset(name.trim());
			await chatPresetStore.switchGlobal(preset.id);
		});
	}

	async function duplicatePreset(): Promise<void> {
		const source = activePreset;
		if (!source) return;
		const name = await askName(
			'Duplicate preset',
			'Name for the duplicate',
			`${source.name} (Copy)`,
			'Duplicate'
		);
		if (!name?.trim() || rejectTakenName(name)) return;
		await run(`duplicate "${source.name}"`, async () => {
			const preset = await presetService.duplicatePreset(source.id, name.trim());
			await chatPresetStore.switchGlobal(preset.id);
		});
	}

	async function copyJson(): Promise<void> {
		if (!activePreset) return;
		await run('copy the preset JSON', async () => {
			await copyText(presetService.exportPresetJson(activePreset.id));
			toastStore.success('Preset JSON copied to clipboard');
		});
	}

	/** Strip only what filesystems reject, so a preset named in any script keeps its name
	 *  (the lorebook downloader's rule: an ASCII-only filter turns "Kaçış" into "Kaç"). */
	function presetFilename(name: string, ext: 'json' | 'png'): string {
		// eslint-disable-next-line no-control-regex
		const cleaned = (name || '').replace(/[\\/:*?"<>|]|[\x00-\x1f]/g, '').trim();
		return `${cleaned || 'preset'}.${ext}`;
	}

	/** The shareable half of Copy as JSON: same bytes, as a file you can hand someone. */
	async function exportFile(): Promise<void> {
		const preset = activePreset;
		if (!preset) return;
		await run(`export "${preset.name}"`, async () => {
			const json = presetService.exportPresetJson(preset.id);
			triggerDownload(presetFilename(preset.name, 'json'), new Blob([json], { type: 'application/json' }));
			toastStore.success(`Exported "${preset.name}"`);
		});
	}

	/** The same document as a picture: the cover is the image, the preset rides inside it. */
	async function exportCard(): Promise<void> {
		const preset = activePreset;
		if (!preset) return;
		await run(`export "${preset.name}" as a card`, async () => {
			await exportPresetCard(preset, presetFilename(preset.name, 'png'));
			toastStore.success(`Exported "${preset.name}" as a card`);
		});
	}

	/**
	 * One picker for both containers. A card's own art becomes the preset's cover, which is
	 * why the PNG branch saves the file before landing the preset. A JSON has no cover to
	 * offer and simply arrives without one.
	 */
	async function importFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		await run(`import "${file.name}"`, async () => {
			const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
			const limit = isPng ? 8 : 2;
			if (file.size > limit * 1024 * 1024) {
				throw new Error(`preset ${isPng ? 'cards' : 'files'} must be smaller than ${limit} MB`);
			}

			let preset: PromptPreset;
			if (isPng) {
				const imported = readPresetFromPng(new Uint8Array(await file.arrayBuffer()));
				if (!imported) throw new Error('no preset is stored in that image');
				const cover = await imageService.saveImage(file, 'presets');
				preset = await presetService.importPreset(imported, cover);
			} else {
				preset = await presetService.importPresetJson(await file.text());
			}
			await chatPresetStore.switchGlobal(preset.id);
			toastStore.success(`Imported "${preset.name}"`);
		});
	}

	async function deletePreset(): Promise<void> {
		// Snapshot the target: a sync while the dialog is open may swap the active
		// preset, and the delete must hit exactly what the user confirmed.
		const target = activePreset;
		if (!target) return;
		const items = target.items.length;
		const ok = await askConfirm({
			title: 'Delete preset',
			message: `Delete "${target.name}" and its ${items} prompt item${items === 1 ? '' : 's'} permanently?${presetService.hasDraft(target.id) ? ' Its unsaved Prompt Builder draft will also be deleted.' : ''}`,
			confirmLabel: 'Delete preset',
			variant: 'danger',
			destructive: true,
			holdMs: holdMsForBlast(items)
		});
		if (!ok) return;
		await run(`delete "${target.name}"`, async () => {
			await presetService.deletePreset(target.id);
		});
	}

	async function restoreDefaults(): Promise<void> {
		const n = allPresets.length;
		const ok = await askConfirm({
			title: 'Restore default presets',
			message: `This permanently deletes all ${n} preset${n === 1 ? '' : 's'} and every unsaved preset draft, then restores the factory defaults.`,
			confirmLabel: 'Restore all defaults',
			variant: 'danger',
			destructive: true,
			holdMs: holdMsForBlast(n)
		});
		if (!ok) return;
		await run('restore the default presets', async () => {
			await presetService.restoreDefaults();
			toastStore.success('Default presets restored');
		});
	}
</script>

<input
	bind:this={fileInput}
	type="file"
	accept=".json,application/json,.png,image/png"
	class="hidden"
	onchange={importFile}
/>

<div class="pm" aria-busy={busy}>
	{#if showSelect}
		<div class="pm-select">
			<Select
				{id}
				value={activeId}
				disabled={busy}
				onchange={(event) => selectPreset((event.target as HTMLSelectElement).value)}
				class="!h-[2.15rem] !px-3 !pr-8 !py-0 !text-sm"
				aria-label="Active preset"
			>
				<!-- Drafts are held per preset, so the tag is per row and not the active row's
				     alone: a preset edited and then switched away from still has unsaved work,
				     and this list is where you'd go back for it. Same rule as the switcher in
				     Preset Controls, which is the other picker over the same set. -->
				{#each allPresets as preset (preset.id)}
					<option value={preset.id}>{preset.name}{presetService.hasDraft(preset.id) ? ' • Draft' : ''}</option>
				{/each}
			</Select>
		</div>
	{/if}

	{#if showSave}
		<button
			type="button"
			class="pm-save"
			disabled={busy}
			onclick={() => run('save the preset', async () => { await onSave?.(); })}
		>
			<Icon name="check" class="w-3.5 h-3.5" strokeWidth={2} />
			Save
		</button>
	{/if}

	<BrowsePopover bind:open={menuOpen} variant="menu">
		{#snippet trigger({ toggle, open })}
			<button
				type="button"
				class="pm-menu-btn"
				class:pm-compact={compact}
				class:is-open={open}
				disabled={busy}
				title="Preset actions"
				aria-label="Preset actions"
				aria-haspopup="menu"
				aria-expanded={open}
				onclick={toggle}
			>
				<Icon name="dotsVertical" class="w-4 h-4" strokeWidth={1.5} />
			</button>
		{/snippet}

		{#if showEdit}
			<button type="button" role="menuitem" class="brw-menu-item" onclick={() => closeAnd(() => onEdit?.())}>
				<Icon name="wrench" class="w-4 h-4" strokeWidth={1.5} />
				<span>Edit in Prompt Builder</span>
			</button>
			<div class="pm-menu-divider"></div>
		{/if}
		{#if showCreate}
			<button type="button" role="menuitem" class="brw-menu-item" onclick={() => closeAnd(createPreset)}>
				<Icon name="plus" class="w-4 h-4" strokeWidth={1.5} />
				<span>New preset</span>
			</button>
		{/if}
		<button type="button" role="menuitem" class="brw-menu-item" onclick={() => closeAnd(duplicatePreset)}>
			<Icon name="copy" class="w-4 h-4" strokeWidth={1.5} />
			<span>Duplicate</span>
		</button>
		<button type="button" role="menuitem" class="brw-menu-item" onclick={() => closeAnd(() => fileInput?.click())}>
			<Icon name="upload" class="w-4 h-4" strokeWidth={1.5} />
			<span>Import card or JSON…</span>
		</button>
		<!-- The ways out sit together, and each wears its own glyph: a picture, a plain file
		     and a clipboard copy are three different actions, and one `download` on all of
		     them said they weren't. -->
		<button type="button" role="menuitem" class="brw-menu-item" onclick={() => closeAnd(exportCard)}>
			<Icon name="image" class="w-4 h-4" strokeWidth={1.5} />
			<span>Export card (PNG)</span>
		</button>
		<button type="button" role="menuitem" class="brw-menu-item" onclick={() => closeAnd(exportFile)}>
			<Icon name="download" class="w-4 h-4" strokeWidth={1.5} />
			<span>Export JSON file</span>
		</button>
		<button type="button" role="menuitem" class="brw-menu-item" onclick={() => closeAnd(copyJson)}>
			<Icon name="copy" class="w-4 h-4" strokeWidth={1.5} />
			<span>Copy as JSON</span>
		</button>
		<div class="pm-menu-divider"></div>
		<span class="pm-menu-label">Danger zone</span>
		<button type="button" role="menuitem" class="brw-menu-item pm-danger" onclick={() => closeAnd(deletePreset)}>
			<Icon name="trash" class="w-4 h-4" strokeWidth={1.5} />
			<span>Delete preset</span>
		</button>
		<button type="button" role="menuitem" class="brw-menu-item pm-danger" onclick={() => closeAnd(restoreDefaults)}>
			<Icon name="refresh" class="w-4 h-4" strokeWidth={1.5} />
			<span>Restore defaults</span>
		</button>
	</BrowsePopover>
</div>

<PromptDialog
	open={!!promptState}
	title={promptState?.title}
	label={promptState?.label}
	value={promptState?.initial ?? ''}
	confirmLabel={promptState?.confirmLabel}
	onConfirm={(value) => resolvePrompt(value)}
	onCancel={() => resolvePrompt(null)}
/>

<ConfirmDialog
	open={!!confirmState}
	title={confirmState?.title}
	message={confirmState?.message ?? ''}
	confirmLabel={confirmState?.confirmLabel}
	variant={confirmState?.variant}
	holdMs={confirmState?.holdMs ?? 0}
	destructive={confirmState?.destructive ?? false}
	onConfirm={() => resolveConfirm(true)}
	onCancel={() => resolveConfirm(false)}
/>

<style>
	.pm {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.pm-select {
		flex: 1 1 auto;
		min-width: 0;
	}

	.pm-save {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		height: 2.15rem;
		padding: 0 0.85rem;
		border-radius: var(--radius-md);
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		transition: filter 140ms ease, transform 140ms ease;
	}

	.pm-save:hover:not(:disabled) { filter: brightness(1.08); }
	.pm-save:active:not(:disabled) { transform: scale(0.97); }

	.pm-menu-btn {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.15rem;
		height: 2.15rem;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 140ms ease, color 140ms ease;
	}

	.pm-menu-btn:hover:not(:disabled),
	.pm-menu-btn.is-open {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	.pm-menu-btn.pm-compact {
		width: 1.75rem;
		height: 1.75rem;
	}

	.pm-save:disabled,
	.pm-menu-btn:disabled { opacity: 0.5; cursor: wait; }

	.pm-menu-divider {
		height: 1px;
		margin: 0.3rem 0.2rem;
		background: var(--color-border-subtle);
	}

	.pm-menu-label {
		display: block;
		padding: 0.15rem 0.65rem 0.25rem;
		font-family: var(--font-ui);
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: color-mix(in srgb, var(--color-error) 75%, var(--color-text-muted));
	}

	.pm-danger { color: var(--color-error); }
	.pm-danger:hover {
		background: color-mix(in srgb, var(--color-error) 14%, transparent);
		color: var(--color-error);
	}
</style>
