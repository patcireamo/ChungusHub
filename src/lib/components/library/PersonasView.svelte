<script lang="ts">
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { personaStore, LAST_PERSONA_REASON } from '$lib/stores/persona.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { workspaceFocus } from '$lib/stores/workspaceFocus.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import BrowsePopover from './BrowsePopover.svelte';
	import LibraryCompactCard from './LibraryCompactCard.svelte';
	import LibraryGalleryCard from './LibraryGalleryCard.svelte';
	import LibraryListRow from './LibraryListRow.svelte';
	import ConvertEntryDialog from './ConvertEntryDialog.svelte';
	import LibraryPager from './LibraryPager.svelte';
	import {
		SORT_OPTIONS,
		PER_PAGE_OPTIONS,
		CARD_SIZE_MAP,
		sortEntries,
		matchesSearch,
		rankSearchResults,
		type SortOption,
		type ViewMode
	} from './browse';
	import { personasViewPrefs, DEFAULTS as BROWSE_DEFAULTS } from '$lib/stores/browseViewPrefs.svelte';
	import { rangeReset } from '$lib/actions/rangeReset';

	// Personas half of the merged Library (see LibraryView): the browse list, speaking
	// the same toolbar/card language as CharacterLibraryView. The entry editor opens
	// wide and centered over the chat (LibraryEditorOverlay) via uiStore.libraryEditorId.
	// Clicking a persona makes it the active "you"; the pencil opens its editor.
	let personas = $derived(characterLibraryStore.personas);
	let activeId = $derived(personaStore.activeEntry?.id ?? null);
	// The app keeps at least one persona (architecture/library.md): the server refuses the
	// last delete, so the menu item goes inert and says why rather than vanishing.
	let deleteBlockedReason = $derived(personas.length > 1 ? undefined : LAST_PERSONA_REASON);

	// Mirror the open entry into the workspace-focus store so the Chungus Assistant can
	// auto-attach "the persona you're editing". Mirrors CharacterLibraryView.
	$effect(() => {
		workspaceFocus.setEntry(uiStore.libraryEditorId);
	});

	// Load library on mount
	$effect(() => {
		characterLibraryStore.load();
	});

	// Deep link from "Edit in Library" style buttons: open the requested
	// entry's editor, then consume the one-shot request so it doesn't re-fire.
	$effect(() => {
		const pending = uiStore.pendingLibraryEntryId;
		if (pending) {
			uiStore.libraryEditorId = pending;
			uiStore.pendingLibraryEntryId = null;
		}
	});

	// Trap navigation while an unsaved brand-new persona is open, exactly like the
	// characters tab does for its new entries.
	$effect(() => {
		const blocker = () => {
			const id = uiStore.libraryEditorId;
			return !!id && characterLibraryStore.isUnconfirmedNew(id);
		};
		uiStore.registerNavBlocker(blocker);
		return () => uiStore.clearNavBlocker(blocker);
	});

	let guardFlash = $state(false);
	let lastGuardPulse = uiStore.guardPulse;
	let guardFlashTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const pulse = uiStore.guardPulse;
		if (pulse === lastGuardPulse) return;
		lastGuardPulse = pulse;
		guardFlash = true;
		if (guardFlashTimer) clearTimeout(guardFlashTimer);
		guardFlashTimer = setTimeout(() => (guardFlash = false), 800);
		toastStore.error('Save or discard this new persona first');
	});

	// ---- View mode & card size. Persisted via the synced settings spine. ----
	let viewMode = $derived(personasViewPrefs.viewMode);
	let listPortraits = $derived(personasViewPrefs.listPortraits);

	function setViewMode(mode: ViewMode) {
		personasViewPrefs.setViewMode(mode);
	}

	let cardSize = $derived(personasViewPrefs.cardSize);

	let cardMinWidth = $derived(CARD_SIZE_MAP[cardSize] ?? 160);

	function handleCardSizeChange(e: Event) {
		personasViewPrefs.setCardSize(parseInt((e.target as HTMLInputElement).value, 10));
	}

	// ---- Search, sort & pagination. Sort + per-page persist via the synced spine. ----
	let searchQuery = $state('');
	let sortOption = $derived(personasViewPrefs.sort);
	let favoritesOnly = $state(false);
	let perPage = $derived(personasViewPrefs.perPage);
	let currentPage = $state(1);

	// Progressive disclosure: search + New stay in the open; sort/favorites and the
	// view options live behind the two popovers, same as the characters tab.
	let filterOpen = $state(false);
	let viewOpen = $state(false);

	function applySort(opt: SortOption) {
		personasViewPrefs.setSort(opt);
		currentPage = 1;
	}

	function applyPerPage(count: number) {
		personasViewPrefs.setPerPage(count);
		currentPage = 1;
	}

	function handleSearchInput(e: Event) {
		searchQuery = (e.target as HTMLInputElement).value;
		currentPage = 1;
	}

	function toggleFavoritesOnly() {
		favoritesOnly = !favoritesOnly;
		currentPage = 1;
	}

	function clearAllFilters() {
		searchQuery = '';
		favoritesOnly = false;
		currentPage = 1;
	}

	// Entries pipeline: personas → search → favorites filter → sort → paginate
	let processedEntries = $derived.by(() => {
		let entries = personas.filter((p) => matchesSearch(p, searchQuery));
		if (favoritesOnly) {
			entries = entries.filter((e) => e.isFavorite);
		}
		const sorted = sortEntries(entries, sortOption);
		return rankSearchResults(sorted, searchQuery);
	});

	// Chips line + funnel badge: anything currently narrowing the list.
	let filtersActive = $derived(favoritesOnly || searchQuery.trim().length > 0);
	let activeFilterCount = $derived(favoritesOnly ? 1 : 0);

	let totalPages = $derived(Math.max(1, Math.ceil(processedEntries.length / perPage)));
	let safePage = $derived(Math.min(currentPage, totalPages));
	let paginatedEntries = $derived(
		processedEntries.slice((safePage - 1) * perPage, safePage * perPage)
	);

	// ---- Entry actions ----
	// In the New chat flow's persona step the pick belongs to the chat being made: it stamps
	// that story's own persona and touches nothing app-wide, because a reader answering "who
	// are you in this one" has not asked to be that person everywhere. (createChat's selectChat
	// clears the flow; the Library is handed back after.) Outside the flow the same press is
	// the app-level choice: the persona new chats start as.
	async function handleSelectEntry(id: string) {
		const characterId = uiStore.newChatStep === 'persona' ? uiStore.newChatCharacterId : null;
		if (!characterId) {
			personaStore.setActive(id);
			return;
		}
		await chatStore.createChat({ characterId, personaId: id });
		uiStore.closeLibrary();
	}

	// Open the editor, wired to the per-card edit button. The editor renders centered
	// over the chat (LibraryEditorOverlay); we just point it at this entry.
	function handleEditEntry(id: string) {
		uiStore.libraryEditorId = id;
	}

	async function handleDuplicate(id: string) {
		const entry = await characterLibraryStore.duplicateEntry(id);
		if (entry) {
			toastStore.success(`Duplicated "${entry.identity.name || 'entry'}"`);
		}
	}

	async function handleToggleFavorite(id: string) {
		await characterLibraryStore.toggleFavorite(id);
	}

	// Making a character of a persona: the dialog holds the id, not the entry, so a library
	// reload under it stays consistent.
	let convertId = $state<string | null>(null);
	let convertEntry = $derived(
		convertId ? (characterLibraryStore.entries.find((e) => e.id === convertId) ?? null) : null
	);

	let deleteTargetId = $state<string | null>(null);
	let deleteTargetName = $derived(
		deleteTargetId
			? characterLibraryStore.entries.find((e) => e.id === deleteTargetId)?.identity.name || 'entry'
			: ''
	);
	let deleteTargetMessage = $derived(
		`Are you sure you want to delete "${deleteTargetName}"? This cannot be undone.` +
			(deleteTargetId === activeId ? ' New chats start as it, so another one takes that over.' : '')
	);

	// The successor is the server's to pick, and it announces the switch on the `settings`
	// scope, so this only has to get the row out of the way. The floor lives there too: with
	// one persona left the delete is refused, which is why it is not offered below.
	async function confirmDelete() {
		if (!deleteTargetId) return;
		const id = deleteTargetId;
		deleteTargetId = null;
		try {
			await characterLibraryStore.deleteEntry(id);
		} catch (e) {
			toastStore.failed('delete that persona', e);
		}
	}

	async function handleCreateNew() {
		const entry = await characterLibraryStore.createPersona();
		uiStore.libraryEditorId = entry.id;
	}
</script>

<div class="brw" class:guard-flash={guardFlash}>
	<!-- Browse list only. The entry editor pops out centered over the chat
	     (LibraryEditorOverlay), so it isn't rendered here. -->
	<!-- Toolbar: search front and center, two quiet disclosures, one primary action.
	     The entry count lives in the search placeholder. -->
	<div class="brw-bar">
		<div class="brw-search">
			<Icon name="search" class="brw-search-icon w-3.5 h-3.5" />
			<input
				type="text"
				value={searchQuery}
				oninput={handleSearchInput}
				placeholder="Search {personas.length} persona{personas.length === 1 ? '' : 's'}…"
				aria-label="Search personas"
				class="input-base"
			/>
		</div>

		<!-- Filter & sort -->
		<BrowsePopover bind:open={filterOpen}>
			{#snippet trigger({ toggle, open })}
				<button
					type="button"
					class="brw-btn"
					class:is-active={open || activeFilterCount > 0}
					onclick={toggle}
					aria-haspopup="true"
					aria-expanded={open}
					aria-label="Filter and sort"
					title="Filter & sort"
				>
					<Icon name="filter" class="w-4 h-4" />
					{#if activeFilterCount > 0}
						<span class="brw-btn-badge">{activeFilterCount}</span>
					{/if}
				</button>
			{/snippet}

			<div class="brw-sec">
				<div class="brw-sec-head">
					<span class="brw-sec-title">Sort by</span>
				</div>
				<div class="brw-opts">
					{#each SORT_OPTIONS as opt}
						<button
							type="button"
							class="brw-opt"
							class:is-active={sortOption === opt.id}
							onclick={() => applySort(opt.id)}
						>
							{opt.label}
						</button>
					{/each}
				</div>
			</div>

			<div class="brw-sec">
				<div class="brw-sec-head">
					<span class="brw-sec-title">Show</span>
				</div>
				<button
					type="button"
					class="brw-opt brw-opt--full"
					class:is-active={favoritesOnly}
					onclick={toggleFavoritesOnly}
					aria-pressed={favoritesOnly}
				>
					<Icon name="heart" class="w-3.5 h-3.5 {favoritesOnly ? 'fill-current' : ''}" />
					Favorites only
				</button>
			</div>
		</BrowsePopover>

		<!-- View options -->
		<BrowsePopover bind:open={viewOpen}>
			{#snippet trigger({ toggle, open })}
				<button
					type="button"
					class="brw-btn"
					class:is-active={open}
					onclick={toggle}
					aria-haspopup="true"
					aria-expanded={open}
					aria-label="View options"
					title="View options"
				>
					<Icon name="sliders" class="w-4 h-4" />
				</button>
			{/snippet}

			<div class="brw-sec">
				<div class="brw-sec-head">
					<span class="brw-sec-title">Layout</span>
				</div>
				<div class="brw-opts brw-opts--3" role="group" aria-label="View mode">
					<button
						type="button"
						class="brw-opt"
						class:is-active={viewMode === 'grid'}
						onclick={() => setViewMode('grid')}
						aria-pressed={viewMode === 'grid'}
					>
						<Icon name="grid" class="w-3.5 h-3.5" />
						Grid
					</button>
					<button
						type="button"
						class="brw-opt"
						class:is-active={viewMode === 'gallery'}
						onclick={() => setViewMode('gallery')}
						aria-pressed={viewMode === 'gallery'}
					>
						<Icon name="gallery" class="w-3.5 h-3.5" />
						Gallery
					</button>
					<button
						type="button"
						class="brw-opt"
						class:is-active={viewMode === 'list'}
						onclick={() => setViewMode('list')}
						aria-pressed={viewMode === 'list'}
					>
						<Icon name="list" class="w-3.5 h-3.5" />
						List
					</button>
				</div>
			</div>

			{#if viewMode === 'list'}
				<div class="brw-sec">
					<div class="flex items-center justify-between gap-2">
						<span class="brw-sec-title">Show Portraits</span>
						<Toggle
							size="sm"
							checked={listPortraits}
							onchange={(v) => personasViewPrefs.setListPortraits(v)}
							label="Show portraits on each row"
						/>
					</div>
				</div>
			{/if}

			{#if viewMode === 'grid'}
				<div class="brw-sec">
					<div class="brw-sec-head">
						<span class="brw-sec-title">Card size</span>
					</div>
					<div class="flex items-center gap-2.5">
						<Icon name="image" class="w-4 h-4 text-text-muted shrink-0" />
						<input
							type="range"
							min="1"
							max="5"
							value={cardSize}
							oninput={handleCardSizeChange}
							use:rangeReset={{ defaultValue: BROWSE_DEFAULTS.cardSize, apply: (v) => personasViewPrefs.setCardSize(v) }}
							class="brw-range"
							aria-label="Card size"
						/>
					</div>
				</div>
			{/if}

			<div class="brw-sec">
				<div class="brw-sec-head">
					<span class="brw-sec-title">Per page</span>
				</div>
				<div class="brw-opts brw-opts--3">
					{#each PER_PAGE_OPTIONS as count}
						<button
							type="button"
							class="brw-opt"
							class:is-active={perPage === count}
							onclick={() => applyPerPage(count)}
						>
							{count}
						</button>
					{/each}
				</div>
			</div>
		</BrowsePopover>

		<button type="button" class="brw-new" onclick={handleCreateNew} title="New persona">
			<Icon name="plus" class="w-4 h-4" />
			<span class="brw-new-label">New</span>
		</button>
	</div>

	<!-- Active filters: a summary line that only exists while something narrows the list -->
	{#if filtersActive}
		<div class="brw-chips">
			<span class="brw-chips-count"><b>{processedEntries.length}</b> of {personas.length}</span>
			{#if favoritesOnly}
				<span class="brw-chip">
					<Icon name="heart" class="w-2.5 h-2.5 fill-current" />
					Favorites
					<button type="button" class="brw-chip-x" onclick={toggleFavoritesOnly} aria-label="Remove favorites filter">
						<Icon name="close" class="w-2.5 h-2.5" />
					</button>
				</span>
			{/if}
			<button type="button" class="brw-chips-clear" onclick={clearAllFilters}>Clear</button>
		</div>
	{/if}

	<!-- Browse area -->
	<div id="personas-panel" role="region" aria-label="Personas" class="brw-content">
		{#if characterLibraryStore.loading}
			<div class="flex items-center justify-center h-full">
				<div class="flex flex-col items-center gap-3 text-text-muted">
					<Spinner size="lg" />
					<span class="text-sm font-ui">Loading personas…</span>
				</div>
			</div>
		<!-- No empty state for an empty library: the app keeps at least one persona
		     (architecture/library.md), so the only way this list runs out is a filter. -->
		{:else if filtersActive && processedEntries.length === 0}
			<div class="grid place-items-center h-full">
				<EmptyState icon="search" size="sm" title="No matches">
					No personas match your current filters.
					{#snippet actions()}
						<Button variant="ghost" size="sm" onclick={clearAllFilters}>
							Clear all filters
						</Button>
					{/snippet}
				</EmptyState>
			</div>
		{:else}
			{#if viewMode === 'grid'}
				<div
					class="brw-grid"
					style="grid-template-columns: repeat(auto-fill, minmax({cardMinWidth}px, 1fr));"
				>
					{#each paginatedEntries as entry (entry.id)}
						<LibraryCompactCard
							{entry}
							active={entry.id === activeId}
							onSelect={handleSelectEntry}
							onEdit={handleEditEntry}
							onDuplicate={handleDuplicate}
							onDelete={(id) => (deleteTargetId = id)}
						{deleteBlockedReason}
							onToggleFavorite={handleToggleFavorite}
							onConvert={(id) => (convertId = id)}
						/>
					{/each}
				</div>
			{:else if viewMode === 'gallery'}
				<div
					class="brw-grid"
					style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));"
				>
					{#each paginatedEntries as entry (entry.id)}
						<LibraryGalleryCard
							{entry}
							active={entry.id === activeId}
							onSelect={handleSelectEntry}
							onEdit={handleEditEntry}
							onDuplicate={handleDuplicate}
							onDelete={(id) => (deleteTargetId = id)}
						{deleteBlockedReason}
							onToggleFavorite={handleToggleFavorite}
							onConvert={(id) => (convertId = id)}
						/>
					{/each}
				</div>
			{:else}
				<div class="flex flex-col divide-y divide-border-subtle">
					{#each paginatedEntries as entry (entry.id)}
						<LibraryListRow
							{entry}
							active={entry.id === activeId}
							onSelect={handleSelectEntry}
							onEdit={handleEditEntry}
							onDuplicate={handleDuplicate}
							onDelete={(id) => (deleteTargetId = id)}
						{deleteBlockedReason}
							onToggleFavorite={handleToggleFavorite}
							onConvert={(id) => (convertId = id)}
							showPortrait={listPortraits}
						/>
					{/each}
				</div>
			{/if}

			<!-- Pagination -->
			{#if totalPages > 1}
				<div class="brw-pager">
					<span class="brw-pager-count">
						Showing {(safePage - 1) * perPage + 1}-{Math.min(safePage * perPage, processedEntries.length)} of {processedEntries.length}
					</span>
					<LibraryPager page={safePage} {totalPages} onPage={(p) => (currentPage = p)} />
				</div>
			{/if}
		{/if}
	</div>
</div>

<ConfirmDialog
	open={deleteTargetId !== null}
	title="Delete from Library"
	message={deleteTargetMessage}
	confirmLabel="Delete"
	variant="danger"
	destructive
	onConfirm={confirmDelete}
	onCancel={() => deleteTargetId = null}
/>

{#if convertEntry}
	<ConvertEntryDialog open entry={convertEntry} onClose={() => (convertId = null)} />
{/if}
