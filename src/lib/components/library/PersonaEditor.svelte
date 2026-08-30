<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { personaStore, LAST_PERSONA_REASON } from '$lib/stores/persona.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { imageService, imageRejectionReason } from '$lib/services/imageService';
	import LibraryEditorHeader from './LibraryEditorHeader.svelte';
	import ConvertEntryDialog from './ConvertEntryDialog.svelte';
	import PortraitFramingDialog from './PortraitFramingDialog.svelte';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';
	import { autoResize } from '$lib/actions/autoResize';
	import { BLOB_MACRO } from '$lib/types/library';
	import { presetService } from '$lib/services/presets.svelte';
	import { extractMacroNames } from '$lib/macros';

	interface Props {
		entryId: string;
		onClose: () => void;
	}

	let { entryId, onClose }: Props = $props();

	let entry = $derived(characterLibraryStore.entries.find((e) => e.id === entryId));
	// Brand-new personas get explicit Save/Discard; confirmed ones autosave silently.
	let isNew = $derived(!!entry && characterLibraryStore.isUnconfirmedNew(entry.id));
	let isActive = $derived(!!entry && personaStore.activeId === entry.id);
	// Edits land on the entry and the store's debounce carries them out, so "saving" is
	// exactly "a write is still waiting".
	let saving = $derived(!!entry && characterLibraryStore.hasPendingWrite(entry.id));
	let committing = $state(false);
	let savedFlash = $state(false);
	let savedFlashTimer: ReturnType<typeof setTimeout> | null = null;

	let snapshot = $derived(
		entry
			? {
					name: entry.identity.name,
					imageUrl: entry.identity.imageUrl,
					portraitFocus: entry.identity.portraitFocus,
					traits: entry.data.traits,
					lorebookIds: entry.data.lorebookIds
				}
			: null
	);

	// "Not sent to AI" mirrors the character editor: the description reaches the AI
	// only when the active preset places the {{persona}} macro somewhere.
	let personaSent = $derived.by(() => {
		const preset = presetService.getActiveEffectivePreset();
		for (const item of preset?.items ?? []) {
			if (item.enabled && extractMacroNames(item.content).includes(BLOB_MACRO.persona)) {
				return true;
			}
		}
		return false;
	});

	function flashSaved() {
		savedFlash = true;
		if (savedFlashTimer) clearTimeout(savedFlashTimer);
		savedFlashTimer = setTimeout(() => (savedFlash = false), 1600);
	}

	// Typing is debounced; the lorebook links are a discrete pick and write at once.
	function handleNameChange(value: string) {
		if (!entry) return;
		characterLibraryStore.scheduleIdentityEdit(entry.id, { name: value });
	}

	function handleDescriptionChange(value: string) {
		if (!entry) return;
		characterLibraryStore.scheduleDataEdit(entry.id, { traits: { description: value } });
	}

	function handleLorebookLinksChange(ids: string[]) {
		if (!entry) return;
		void characterLibraryStore.updateData(entry.id, { lorebookIds: ids });
	}

	// ---- Portrait ----
	let fileInputRef = $state<HTMLInputElement | null>(null);
	let resolvedImageUrl = $state<string | null>(null);
	let imageLoading = $state(false);

	$effect(() => {
		const path = snapshot?.imageUrl;
		if (path) {
			imageService.getImageUrl(path).then((url) => (resolvedImageUrl = url));
		} else {
			resolvedImageUrl = null;
		}
	});

	let showFraming = $state(false);

	function handleImageClick() {
		fileInputRef?.click();
	}

	function handleAdjustFraming(e: MouseEvent) {
		// The frame behind this button opens the file picker.
		e.stopPropagation();
		showFraming = true;
	}

	async function handleImageSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const refused = imageRejectionReason(file);
		if (refused) {
			toastStore.error(refused);
			input.value = '';
			return;
		}
		imageLoading = true;
		try {
			if (entry) await characterLibraryStore.updateEntryImage(entry.id, file);
		} catch (error) {
			console.error('Saving the persona image failed:', error);
			toastStore.failed(`save "${file.name}"`, error);
		} finally {
			imageLoading = false;
			input.value = '';
		}
	}

	async function handleImageRemove(e: Event) {
		e.stopPropagation();
		if (!entry) return;
		imageLoading = true;
		try {
			await characterLibraryStore.updateEntryImage(entry.id, null);
		} finally {
			imageLoading = false;
		}
	}

	// ---- Entry actions ----
	function handleSetActive() {
		if (!entry) return;
		personaStore.setActive(entry.id);
	}

	async function handleToggleFavorite() {
		if (!entry) return;
		await characterLibraryStore.toggleFavorite(entry.id);
	}

	async function handleDuplicate() {
		if (!entry) return;
		const copy = await characterLibraryStore.duplicateEntry(entry.id);
		if (copy) toastStore.success(`Duplicated "${copy.identity.name || 'persona'}"`);
	}

	let showConvert = $state(false);

	let showDeleteConfirm = $state(false);
	let deleteName = $derived(snapshot?.name || 'this persona');
	let deleteMessage = $derived(
		`Are you sure you want to delete ${deleteName}? This cannot be undone.` +
			(isActive ? ' New chats start as it, so another one takes that over.' : '')
	);
	// The app keeps at least one persona (architecture/library.md): the server refuses the last
	// delete, so the menu item goes inert and says why rather than vanishing.
	let deleteBlockedReason = $derived(
		characterLibraryStore.personas.length > 1 ? undefined : LAST_PERSONA_REASON
	);

	// Which persona takes over is the server's call, announced on the `settings` scope; this
	// only has to get the row out of the way and leave if it went.
	async function handleDelete() {
		if (!entry) return;
		try {
			await characterLibraryStore.deleteEntry(entry.id);
		} catch (e) {
			toastStore.failed('delete that persona', e);
			return;
		}
		onClose();
	}

	// ---- Autosave ----
	// The store's own debounce IS the autosave; this only says so on screen, flashing
	// "Saved" the moment a pending write lands.
	let wasSaving = false;
	$effect(() => {
		const now = saving;
		if (wasSaving && !now) flashSaved();
		wasSaving = now;
	});

	// On close/unmount, send whatever is still sitting in the debounce window.
	$effect(() => {
		const activeId = entry?.id;
		return () => {
			if (activeId) void characterLibraryStore.flushEntry(activeId);
		};
	});

	// ---- New-entry actions ----
	async function handleSaveNew() {
		if (!entry || committing) return;
		committing = true;
		try {
			await characterLibraryStore.flushEntry(entry.id);
			characterLibraryStore.confirmNewEntry(entry.id);
			// First persona ever saved becomes the active "you" so a fresh setup works
			// without a second step; otherwise activation stays an explicit choice.
			if (!personaStore.activeId) personaStore.setActive(entry.id);
			flashSaved();
			toastStore.success('Persona saved');
		} finally {
			committing = false;
		}
	}

	async function handleDiscardNew() {
		if (!entry || committing) return;
		committing = true;
		try {
			await characterLibraryStore.deleteEntry(entry.id);
			onClose();
		} catch (e) {
			// Reachable only where this draft is the app's only persona, which the server
			// refuses to let go of (architecture/library.md). Say so instead of dying silently.
			toastStore.failed('discard that persona', e);
		} finally {
			committing = false;
		}
	}

	// Close the editor, sending any pending edit first.
	async function handleClose() {
		if (entry) await characterLibraryStore.flushEntry(entry.id);
		onClose();
	}
</script>

<input
	bind:this={fileInputRef}
	type="file"
	accept="image/*"
	class="hidden"
	onchange={handleImageSelect}
/>

{#if snapshot && entry}
	<!-- Transparent root: the hosting Workspace overlay panel provides the frosted surface. -->
	<div class="flex flex-col h-full">
		<LibraryEditorHeader
			name={snapshot.name}
			fallbackName="Unnamed Persona"
			{isNew}
			busy={committing}
			saving={committing || saving}
			{savedFlash}
			isFavorite={entry.isFavorite}
			lorebookIds={snapshot.lorebookIds ?? []}
			onLorebookChange={handleLorebookLinksChange}
			onToggleFavorite={handleToggleFavorite}
			onDuplicate={handleDuplicate}
			onDelete={() => (showDeleteConfirm = true)}
			{deleteBlockedReason}
			onClose={handleClose}
			onSaveNew={handleSaveNew}
			onDiscardNew={handleDiscardNew}
			entryType="persona"
			onConvert={() => (showConvert = true)}
		>
			{#snippet badge()}
				{#if isActive && !isNew}
					<span class="shrink-0 text-[10px] font-ui px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30">
						New chats
					</span>
				{/if}
			{/snippet}
			{#snippet primaryAction()}
				{#if !isActive}
					<Button variant="secondary" size="sm" onclick={handleSetActive}>
						<Icon name="user" class="w-4 h-4" />
						Start new chats as this
					</Button>
				{/if}
			{/snippet}
		</LibraryEditorHeader>

		<div class="flex-1 panel-scroll">
			<div class="grid grid-cols-1 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] gap-6 p-6">
				<!-- Identity pane: portrait + name, matching the character editor's layout. -->
				<div class="space-y-4 lg:sticky lg:top-6 lg:self-start">
					<div
						class="portrait-frame relative w-full max-w-[15rem] mx-auto lg:mx-0 aspect-[3/4] rounded-[var(--radius-lg)] overflow-hidden border border-border bg-bg-tertiary group/portrait cursor-pointer transition-all hover:border-accent hover:shadow-md"
						role="button"
						tabindex="0"
						onclick={handleImageClick}
						onkeydown={(e) => e.key === 'Enter' && handleImageClick()}
						aria-label="Change persona image"
						aria-disabled={imageLoading}
					>
						{#if imageLoading}
							<div class="absolute inset-0 flex items-center justify-center bg-bg-tertiary">
								<Spinner size="md" />
							</div>
						{:else if resolvedImageUrl}
							<img
								src={resolvedImageUrl}
								alt={snapshot.name || 'persona'}
								class="w-full h-full object-cover"
								style={portraitFocusStyle(snapshot.portraitFocus)}
							/>
							<div class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-0 group-hover/portrait:opacity-100 transition-opacity flex items-end justify-center pb-2.5">
								<span class="text-white/90 text-xs font-ui">Change photo</span>
							</div>
							<button
								type="button"
								class="portrait-overlay-action absolute top-1.5 right-1.5 p-1 rounded-full bg-black/50 text-white/80 hover:bg-error hover:text-white"
								onclick={handleImageRemove}
								aria-label="Remove image"
							>
								<Icon name="close" class="w-3.5 h-3.5" />
							</button>
							<button
								type="button"
								class="portrait-overlay-action absolute bottom-1.5 right-1.5 p-1 rounded-full bg-black/50 text-white/80 hover:bg-black/75 hover:text-white"
								onclick={handleAdjustFraming}
								aria-label="Adjust framing"
								title="Adjust framing"
							>
								<Icon name="crop" class="w-3.5 h-3.5" />
							</button>
						{:else}
							<div class="w-full h-full flex flex-col items-center justify-center text-text-muted group-hover/portrait:text-accent transition-colors gap-1.5">
								<Icon name="image" class="w-7 h-7" />
								<span class="text-xs font-ui">Add photo</span>
							</div>
						{/if}
					</div>

					<div>
						<label for="persona-name-{entry.id}" class="block text-sm font-ui font-medium text-text-primary mb-1.5">
							Name
						</label>
						<input
							id="persona-name-{entry.id}"
							type="text"
							value={snapshot.name}
							oninput={(e) => handleNameChange((e.target as HTMLInputElement).value)}
							placeholder="What should characters call you?"
							class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm placeholder:text-text-muted"
						/>
					</div>
				</div>

				<!-- Fields pane: the single description field. -->
				<div class="min-w-0 space-y-5">
					<div class="space-y-3">
						<div class="w-full flex items-center gap-1.5 py-0.5">
							<Icon name="user" class="w-3.5 h-3.5 text-accent" />
							<span class="text-xs font-ui font-semibold uppercase tracking-wide text-accent">Persona</span>
							<span class="flex-1 border-t border-border-subtle/70 ml-1"></span>
						</div>
						<div class="rounded-[var(--radius-lg)] border border-border-subtle bg-bg-secondary/40 transition-colors hover:border-border">
							<div class="flex items-center gap-2 px-3 pt-2.5 pb-1">
								<span class="flex-1 min-w-0 truncate text-sm font-ui font-medium text-text-primary">
									Persona Description
								</span>
								{#if !personaSent}
									<span
										class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-ui font-medium rounded-[var(--radius-sm)] bg-warning/15 text-warning shrink-0"
										title={`Not sent to the AI. Add {{${BLOB_MACRO.persona}}} to the active preset to include it.`}
									>
										<Icon name="eyeOff" class="w-3 h-3" />
										Not sent to AI
									</span>
								{/if}
							</div>
							<div class="px-3 pb-3 pt-1">
								<textarea
									use:autoResize={{ maxHeight: 480, value: snapshot.traits.description ?? '' }}
									id="persona-description-{entry.id}"
									value={snapshot.traits.description ?? ''}
									oninput={(e) => handleDescriptionChange((e.target as HTMLTextAreaElement).value)}
									placeholder="Who you are: appearance, presence, how you carry yourself, how you speak…"
									class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm placeholder:text-text-muted resize-none min-h-[12rem] {personaSent
										? ''
										: 'opacity-60'}"
								></textarea>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>

	{#if snapshot.imageUrl}
		<PortraitFramingDialog
			open={showFraming}
			entryId={entry.id}
			imagePath={snapshot.imageUrl}
			name={snapshot.name}
			focus={snapshot.portraitFocus}
			onClose={() => (showFraming = false)}
		/>
	{/if}

	<ConvertEntryDialog {entry} open={showConvert} onClose={() => (showConvert = false)} />

	<ConfirmDialog
		open={showDeleteConfirm}
		title="Delete persona"
		message={deleteMessage}
		confirmLabel="Delete"
		variant="danger"
		destructive
		onConfirm={() => { showDeleteConfirm = false; handleDelete(); }}
		onCancel={() => (showDeleteConfirm = false)}
	/>
{/if}
