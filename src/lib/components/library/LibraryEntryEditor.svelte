<script lang="ts">
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import EntryFormFields from './EntryFormFields.svelte';
	import CharacterVersionMenu from './CharacterVersionMenu.svelte';
	import CharacterStatsBar from './CharacterStatsBar.svelte';
	import LibraryEditorHeader from './LibraryEditorHeader.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import ConvertEntryDialog from './ConvertEntryDialog.svelte';
	import type { CharacterTraits } from '$lib/types/library';

	interface Props {
		entryId: string;
		onClose: () => void;
	}

	let { entryId, onClose }: Props = $props();

	let entry = $derived(characterLibraryStore.entries.find((candidate) => candidate.id === entryId));
	// Brand-new entries get explicit Save/Discard; confirmed ones autosave silently.
	let isNew = $derived(!!entry && characterLibraryStore.isUnconfirmedNew(entry.id));
	// Edits land on the entry and the store's debounce carries them out, so "saving" is
	// exactly "a write is still waiting".
	let saving = $derived(!!entry && characterLibraryStore.hasPendingWrite(entry.id));
	let committing = $state(false);
	let savedFlash = $state(false);
	let savedFlashTimer: ReturnType<typeof setTimeout> | null = null;

	function flashSaved() {
		savedFlash = true;
		if (savedFlashTimer) clearTimeout(savedFlashTimer);
		savedFlashTimer = setTimeout(() => (savedFlash = false), 1600);
	}

	let data = $derived(
		entry
			? {
					name: entry.identity.name,
					imageUrl: entry.identity.imageUrl,
					portraitFocus: entry.identity.portraitFocus,
					tags: entry.identity.tags,
					gallery: entry.identity.gallery,
					sprites: entry.identity.sprites,
					defaultSprite: entry.identity.defaultSprite,
					traits: entry.data.traits,
					alternateGreetings: entry.data.alternateGreetings,
					lorebookIds: entry.data.lorebookIds
				}
			: null
	);

	function handleLorebookLinksChange(ids: string[]) {
		if (!entry) return;
		void characterLibraryStore.updateData(entry.id, { lorebookIds: ids });
	}

	function handleDefaultPersonaChange(personaId: string | null) {
		if (!entry) return;
		characterLibraryStore
			.setDefaultPersona(entry.id, personaId)
			.catch((error) => toastStore.failed('save who new chats with this character start as', error));
	}

	// The seed names a persona that has since been deleted. Nothing sweeps it (deleting a
	// persona moves the app's pointer and touches no character), and it is deliberately not
	// swept here either: the select keeps showing that something IS set, so the state is a
	// line the reader can read and fix rather than a silent blank.
	let seedPersonaMissing = $derived(
		!!entry?.defaultPersonaId &&
			!characterLibraryStore.personas.some((p) => p.id === entry?.defaultPersonaId)
	);

	const typeLabel = 'Character';
	const typeLabelLower = 'character';

	// Typing is debounced; everything below it is a discrete action and writes at once.
	function handleFieldChange(field: 'name', value: string) {
		if (!entry) return;
		characterLibraryStore.scheduleIdentityEdit(entry.id, { [field]: value });
	}

	function handleTraitChange(traitKey: keyof CharacterTraits, value: string) {
		if (!entry) return;
		characterLibraryStore.scheduleDataEdit(entry.id, { traits: { [traitKey]: value } });
	}

	async function handleImageSelect(file: File): Promise<void> {
		if (!entry) return;
		await characterLibraryStore.updateEntryImage(entry.id, file);
	}

	async function handleImageRemove(): Promise<void> {
		if (!entry) return;
		await characterLibraryStore.updateEntryImage(entry.id, null);
	}

	function handleTagsChange(tags: string[]) {
		if (!entry) return;
		void characterLibraryStore.updateTags(entry.id, tags);
	}

	// Debounced, not immediate: the greetings modal reports the whole list on every
	// keystroke in one of them, so this is a typing path wearing a list's clothes.
	function handleAlternateGreetingsChange(greetings: string[]) {
		if (!entry) return;
		characterLibraryStore.scheduleDataEdit(entry.id, { alternateGreetings: greetings });
	}

	async function handleGalleryAdd(files: File[]): Promise<void> {
		if (!entry) return;
		await characterLibraryStore.addGalleryImages(entry.id, files);
	}

	async function handleGalleryRemove(path: string): Promise<void> {
		if (!entry) return;
		await characterLibraryStore.removeGalleryImage(entry.id, path);
	}

	async function handleSpritesAdd(items: { file: File; label: string }[]): Promise<void> {
		if (!entry) return;
		const refused = await characterLibraryStore.addSprites(entry.id, items);
		// Silently missing sprites would read as a failed upload, so name the ones that
		// collided with a label this character already uses.
		if (refused.length) {
			toastStore.error(
				`Skipped, those labels are already taken: ${refused.join(', ')}`
			);
		}
	}

	async function handleSpriteLabel(path: string, label: string): Promise<void> {
		if (!entry) return;
		await characterLibraryStore.setSpriteLabel(entry.id, path, label);
	}

	async function handleSpriteDefault(path: string): Promise<void> {
		if (!entry) return;
		await characterLibraryStore.setDefaultSprite(entry.id, path);
	}

	async function handleSpriteRemove(path: string): Promise<void> {
		if (!entry) return;
		await characterLibraryStore.removeSprite(entry.id, path);
	}

	let showDeleteConfirm = $state(false);
	let deleteUsage = $state<{ chatCount: number; castCount: number } | null>(null);
	let deleteMessage = $derived.by(() => {
		const name = data?.name || `this ${typeLabelLower}`;
		const base = `Are you sure you want to delete ${name}? This cannot be undone.`;
		if (!deleteUsage || deleteUsage.castCount === 0) return base;
		return `${base} It is currently in ${deleteUsage.chatCount} chat cast(s) (${deleteUsage.castCount} reference(s)); those references will be removed.`;
	});

	async function openDeleteConfirm() {
		deleteUsage = await characterLibraryStore.getEntryUsage(entryId);
		showDeleteConfirm = true;
	}

	async function handleDelete() {
		await characterLibraryStore.deleteEntry(entryId);
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
			flashSaved();
			toastStore.success(`${typeLabel} saved`);
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
		} finally {
			committing = false;
		}
	}

	// ---- Confirmed-entry actions ----
	// Close the editor, sending any pending edit first.
	async function handleClose() {
		if (entry) await characterLibraryStore.flushEntry(entry.id);
		onClose();
	}

	async function handleToggleFavorite() {
		if (!entry) return;
		await characterLibraryStore.toggleFavorite(entry.id);
	}

	let showExport = $state(false);
	function openExport() {
		if (!entry) return;
		showExport = true;
	}

	let showConvert = $state(false);

	async function handleDuplicate() {
		if (!entry) return;
		const copy = await characterLibraryStore.duplicateEntry(entry.id);
		if (copy) toastStore.success(`Duplicated "${copy.identity.name || 'entry'}"`);
	}
</script>

{#if data && entry}
	<!-- Transparent root: the hosting Workspace overlay panel provides the frosted surface. -->
	<div class="flex flex-col h-full">
		<LibraryEditorHeader
			name={data.name}
			fallbackName={`Unnamed ${typeLabel}`}
			{isNew}
			busy={committing}
			saving={committing || saving}
			{savedFlash}
			isFavorite={entry.isFavorite}
			lorebookIds={data.lorebookIds ?? []}
			onLorebookChange={handleLorebookLinksChange}
			onToggleFavorite={handleToggleFavorite}
			onDuplicate={handleDuplicate}
			onDelete={openDeleteConfirm}
			onClose={handleClose}
			onSaveNew={handleSaveNew}
			onDiscardNew={handleDiscardNew}
			onExport={openExport}
			entryType="character"
			onConvert={() => (showConvert = true)}
		>
			{#snippet badge()}
				{#if !isNew}
					<CharacterVersionMenu entryId={entry.id} />
				{/if}
			{/snippet}
		</LibraryEditorHeader>

		<div class="flex-1 panel-scroll">
			<EntryFormFields
					name={data.name}
					imageUrl={data.imageUrl}
				portraitFocus={data.portraitFocus}
					tags={data.tags}
					traits={data.traits}
					alternateGreetings={data.alternateGreetings}
					gallery={data.gallery}
					sprites={data.sprites}
					defaultSprite={data.defaultSprite}
					entityId={entryId}
					onFieldChange={handleFieldChange}
					onTraitChange={handleTraitChange}
					onImageSelect={handleImageSelect}
					onImageRemove={handleImageRemove}
					onTagsChange={handleTagsChange}
					onAlternateGreetingsChange={handleAlternateGreetingsChange}
					onGalleryAdd={handleGalleryAdd}
					onGalleryRemove={handleGalleryRemove}
					onSpritesAdd={handleSpritesAdd}
					onSpriteLabel={handleSpriteLabel}
					onSpriteDefault={handleSpriteDefault}
					onSpriteRemove={handleSpriteRemove}
			/>

			<!-- Seeds, not claims: each one stamps a chat at birth and has no say afterwards, so
			     changing anything here never touches a story already under way.
			     It wears the settings card recipe rather than the editor's own section headings
			     because that is the difference a reader has to see at a glance: everything above
			     is the character and travels with them, everything here is how this install
			     starts chats with them. A second default is one more row and nothing else. -->
			<div class="px-6 pb-6">
				<section class="card max-w-[40rem]">
					<div class="card-head">
						<span class="card-title">New Chat Defaults</span>
					</div>

					<div class="card-body">
						<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
							<div class="flex-[1_1_12rem] min-w-0">
								<label for="default-persona-{entryId}" class="slider-label block">Play as</label>
								<p class="mt-0.5 text-xs font-ui text-text-muted">
									Only new chats. The ones already going keep theirs.
								</p>
								{#if seedPersonaMissing}
									<p class="mt-1 text-xs font-ui text-warning">
										That persona is no longer in your library, so new chats start as the app's.
									</p>
								{/if}
							</div>
							<!-- Both halves grow, so the control is never narrower than the text above it
							     once the row wraps onto two lines on a narrow screen. -->
							<div class="flex-[1_1_14rem]">
								<Select
									id="default-persona-{entryId}"
									value={entry.defaultPersonaId ?? ''}
									onchange={(e) =>
										handleDefaultPersonaChange((e.currentTarget as HTMLSelectElement).value || null)}
								>
									<option value="">Whoever new chats start as</option>
									{#if seedPersonaMissing}
										<option value={entry.defaultPersonaId}>Deleted persona</option>
									{/if}
									{#each characterLibraryStore.personas as persona (persona.id)}
										<option value={persona.id}>{persona.identity.name || 'Unnamed persona'}</option>
									{/each}
								</Select>
							</div>
						</div>
					</div>

					<p class="mt-3.5 pt-2.5 border-t border-border-subtle/60 text-xs font-ui text-text-muted">
						Stays in your library. None of it is written into an exported card.
					</p>
				</section>
			</div>
		</div>

		<CharacterStatsBar {entry} />
	</div>

	<ConfirmDialog
		open={showDeleteConfirm}
		title="Delete {typeLabel}"
		message={deleteMessage}
		confirmLabel="Delete"
		variant="danger"
		destructive
		onConfirm={() => { showDeleteConfirm = false; handleDelete(); }}
		onCancel={() => (showDeleteConfirm = false)}
	/>

	<ExportDialog
		open={showExport}
		targets={[{ entry, versions: characterLibraryStore.versionsFor(entry.id) }]}
		onClose={() => (showExport = false)}
	/>

	<!-- Folds the active version, which is the content the editor has on screen. -->
	<ConvertEntryDialog {entry} open={showConvert} onClose={() => (showConvert = false)} />
{/if}
