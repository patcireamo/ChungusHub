<script lang="ts">
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { connectionStore } from '$lib/stores/connections.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import EntryFormFields from './EntryFormFields.svelte';
	import CharacterVersionMenu from './CharacterVersionMenu.svelte';
	import CharacterStatsBar from './CharacterStatsBar.svelte';
	import LibraryEditorHeader from './LibraryEditorHeader.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import ConvertEntryDialog from './ConvertEntryDialog.svelte';
	import type { CharacterTraits, ChatDefaultKey } from '$lib/types/library';

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

	function handleChatDefaultChange(key: ChatDefaultKey, value: string | null) {
		if (!entry) return;
		characterLibraryStore
			.setChatDefault(entry.id, key, value)
			.catch((error) => toastStore.failed('save what new chats with this character start on', error));
	}

	// Closed by default and per open editor: what a chat starts on is set once and then left
	// alone, so it costs the pane nothing until somebody comes looking for it.
	let defaultsOpen = $state(false);

	/** One row of the New Chat Defaults panel. A fourth seed is one more entry here. */
	interface ChatDefaultRow {
		key: ChatDefaultKey;
		label: string;
		/** The neutral option: what a new chat gets while this row is left alone. */
		fallback: string;
		options: { id: string; name: string }[];
		/** Said when the stored id names something that no longer exists. */
		gone: string;
	}

	let chatDefaults = $derived.by<ChatDefaultRow[]>(() => {
		if (!entry) return [];
		const versions = characterLibraryStore.versionsFor(entry.id);
		const rows: ChatDefaultRow[] = [
			{
				key: 'defaultPersonaId',
				label: 'Persona',
				// The word the library badges the app's own persona with, so the option points at
				// something the reader can go and look at.
				fallback: 'Default',
				options: characterLibraryStore.personas.map((p) => ({
					id: p.id,
					name: p.identity.name || 'Unnamed persona'
				})),
				gone: "That persona is no longer in your library, so new chats start as the app's."
			},
			{
				key: 'defaultConnectionId',
				label: 'Connection',
				// Not "Default" here: a connection can BE named Default (a fresh install's is), and
				// an option naming one of the rows under it is a trap.
				fallback: 'Global',
				options: connectionStore.list().map((c) => ({ id: c.id, name: c.name })),
				gone: "That connection is gone, so new chats send on the app's."
			}
		];
		// Nothing to choose between on an unversioned character, and its chats pin nothing.
		if (versions.length > 0) {
			rows.push({
				key: 'defaultVersionId',
				label: 'Version',
				// Which one that is carries the Default badge in the header's version menu, rather
				// than a name spelled out here that would go stale the moment it is renamed.
				fallback: 'Default',
				options: versions.map((v) => ({ id: v.id, name: v.name })),
				gone: 'That version is gone, so new chats start on the first one made.'
			});
		}
		return rows;
	});

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

		<!-- Seeds, not claims: each one stamps a chat at birth and has no say afterwards, so
		     changing anything here never touches a story already under way.
		     It sits at the foot of the identity pane, quiet and closed: what a chat with this
		     character starts on belongs beside who the character IS rather than among the card
		     fields, and it is read far less often than any of them. Deliberately not the accent
		     section headings the card fields wear, since this is not part of the card and the
		     eye should not read it as one more of them. A fourth seed is one more row. -->
		{#snippet chatDefaultsPanel()}
			<div class="pt-3 border-t border-border-subtle/60">
				<button
					type="button"
					class="group w-full flex items-center gap-1.5 py-1 text-text-muted transition-colors"
					onclick={() => (defaultsOpen = !defaultsOpen)}
					aria-expanded={defaultsOpen}
				>
					<Icon
						name="chevronDown"
						class="w-3 h-3 shrink-0 transition-transform {defaultsOpen ? '' : '-rotate-90'}"
					/>
					<span class="section-label group-hover:text-text-secondary">New Chat Defaults</span>
				</button>

				{#if defaultsOpen}
					<div class="mt-2 space-y-3">
						{#each chatDefaults as row (row.key)}
							{@const stored = entry[row.key]}
							{@const lost = !!stored && !row.options.some((option) => option.id === stored)}
							<div>
								<label for="{row.key}-{entryId}" class="slider-label block mb-1">{row.label}</label>
								{#if lost}
									<p class="mb-1 text-xs font-ui text-warning">{row.gone}</p>
								{/if}
								<Select
									id="{row.key}-{entryId}"
									value={stored ?? ''}
									onchange={(e) =>
										handleChatDefaultChange(
											row.key,
											(e.currentTarget as HTMLSelectElement).value || null
										)}
								>
									<option value="">{row.fallback}</option>
									{#if lost}
										<!-- The seed is never swept, so the control shows that something IS set
										     rather than blanking to a value nobody chose. -->
										<option value={stored}>No longer here</option>
									{/if}
									{#each row.options as option (option.id)}
										<option value={option.id}>{option.name}</option>
									{/each}
								</Select>
							</div>
						{/each}
						<p class="text-xs font-ui leading-relaxed text-text-muted">
							Only new chats; the ones already going keep what they have. Nothing here is written
							into an exported card.
						</p>
					</div>
				{/if}
			</div>
		{/snippet}

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
					identityExtra={chatDefaultsPanel}
			/>
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
