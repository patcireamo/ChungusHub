<script lang="ts">
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { db } from '$lib/services/database';
	import { chatCastStore } from '$lib/stores/chatCast.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { workspaceFocus } from '$lib/stores/workspaceFocus.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { importSillyTavernCard } from '$lib/services/sillyTavernImport';
	import { createBookIndex } from '$lib/lorebook/identity';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { holdMsForBlast } from '$lib/components/ui/HoldToConfirmButton.svelte';
	import Dialog from '$lib/components/ui/Dialog.svelte';
	import type { ImportResult } from '$lib/services/sillyTavernImport';
	import BrowsePopover from './BrowsePopover.svelte';
	import LibraryCompactCard from './LibraryCompactCard.svelte';
	import LibraryGalleryCard from './LibraryGalleryCard.svelte';
	import LibraryListRow from './LibraryListRow.svelte';
	import LibraryPager from './LibraryPager.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import ConvertEntryDialog from './ConvertEntryDialog.svelte';
	import {
		CHARACTER_SORT_OPTIONS,
		PER_PAGE_OPTIONS,
		CARD_SIZE_MAP,
		sortEntries,
		matchesSearch,
		rankSearchResults,
		type ChatStats,
		type SortOption,
		type ViewMode
	} from './browse';
	import { libraryViewPrefs, DEFAULTS as BROWSE_DEFAULTS } from '$lib/stores/browseViewPrefs.svelte';
	import { rangeReset } from '$lib/actions/rangeReset';

	// Characters half of the merged Library (see LibraryView): the browse list. The
	// entry editor itself opens wide and centered over the chat (LibraryEditorOverlay);
	// this view just picks which entry that is via uiStore.libraryEditorId.
	let selectedEntryId = $derived(uiStore.libraryEditorId);

	// Mirror the open entry into the workspace-focus store so the Chungus Assistant can
	// auto-attach "the character you're editing". On close (libraryEditorId → null while
	// mounted) this clears it; on unmount the effect is torn down without running:
	// uiStore releases the focus itself on every real navigation away from the Library.
	$effect(() => {
		workspaceFocus.setEntry(selectedEntryId);
	});

	// View mode (grid cards vs. detail list). Persisted via the synced settings spine.
	let viewMode = $derived(libraryViewPrefs.viewMode);
	let listTags = $derived(libraryViewPrefs.listTags);
	let listPortraits = $derived(libraryViewPrefs.listPortraits);

	function setViewMode(mode: ViewMode) {
		libraryViewPrefs.setViewMode(mode);
	}

	// Trap navigation while an unsaved brand-new entry is open: the ui store asks
	// this blocker before letting any panel switch through, and pulses guardPulse
	// when it vetoes so we can flash the panel red.
	$effect(() => {
		const blocker = () => !!selectedEntryId && characterLibraryStore.isUnconfirmedNew(selectedEntryId);
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
		toastStore.error('Save or discard this new character first');
	});

	// SillyTavern import
	let importInputRef = $state<HTMLInputElement | null>(null);
	let importing = $state(false);

	// Parsed cards waiting on the embedded-lorebook decision. A card without an
	// embedded book has hasBook=false and imports its character regardless.
	type PendingImport = { result: ImportResult; hasBook: boolean; importBook: boolean };
	let pendingImports = $state<PendingImport[]>([]);
	let lorebookPromptOpen = $state(false);
	let pendingWithBooks = $derived(pendingImports.filter((p) => p.hasBook));
	let allBooksSelected = $derived(
		pendingWithBooks.length > 0 && pendingWithBooks.every((p) => p.importBook)
	);

	// Card size preference (1-5, where 3 is default). Persisted via the synced spine.
	let cardSize = $derived(libraryViewPrefs.cardSize);

	// Computed min-width for grid
	let cardMinWidth = $derived(CARD_SIZE_MAP[cardSize] ?? 160);

	function handleCardSizeChange(e: Event) {
		libraryViewPrefs.setCardSize(parseInt((e.target as HTMLInputElement).value, 10));
	}

	// Load library on mount
	$effect(() => {
		characterLibraryStore.load();
	});

	// Per-chat message stats for the chat-aware sorts. Re-fetched whenever the chat set
	// changes (not just on mount), so a bulk import that adds chats while the Library is
	// already open (docked/split view) refreshes the counts instead of reading stale ones
	// until a full page reload.
	let messageCounts = $state<Record<string, number>>({});
	let lastTalked = $state<Record<string, number>>({});

	$effect(() => {
		// Track the chat set so this effect re-runs on add/remove (import, delete), not
		// just on mount. The cleanup-guarded `cancelled` flag makes the LATEST fetch win:
		// a bulk import reassigns chatStore.chats once per chat, so several fetches can be
		// in flight at once and resolve out of order. Without the guard an earlier (staler)
		// aggregate could land after a newer one and freeze the counts mid-import.
		void chatStore.chats.length;
		let cancelled = false;
		Promise.all([db.getMessageCounts(), db.getLastUserMessageTimes()]).then(
			([counts, talked]) => {
				if (cancelled) return;
				messageCounts = counts;
				lastTalked = talked;
			}
		);
		return () => {
			cancelled = true;
		};
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

	// Sort & filter. Sort + per-page persist via the synced spine; the rest is transient.
	let searchQuery = $state('');
	let sortOption = $derived(libraryViewPrefs.sort);
	let selectedTags = $state<string[]>([]);
	let favoritesOnly = $state(false);
	let perPage = $derived(libraryViewPrefs.perPage);
	let currentPage = $state(1);

	// Progressive disclosure: the toolbar keeps search + New in the open; the power
	// features live behind these three popovers (filter / view options / more).
	let filterOpen = $state(false);
	let viewOpen = $state(false);
	let moreOpen = $state(false);

	// Random sort seed: fresh on mount and rerolled every time Random is picked, so each
	// pick reshuffles, but the order holds steady while searching/paging within a pick.
	let randomSeed = $state(Math.floor(Math.random() * 0xffffffff));

	function applySort(opt: SortOption) {
		if (opt === 'random') randomSeed = Math.floor(Math.random() * 0xffffffff);
		libraryViewPrefs.setSort(opt);
		currentPage = 1;
	}

	function applyPerPage(count: number) {
		libraryViewPrefs.setPerPage(count);
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

	function toggleTag(tag: string) {
		if (selectedTags.includes(tag)) {
			selectedTags = selectedTags.filter(t => t !== tag);
		} else {
			selectedTags = [...selectedTags, tag];
		}
		currentPage = 1;
	}

	function clearAllFilters() {
		searchQuery = '';
		selectedTags = [];
		favoritesOnly = false;
		currentPage = 1;
	}

	// Tag filter mode + the checklist's type-ahead state (filter popover)
	type TagFilterMode = 'any' | 'all';
	let tagFilterMode = $state<TagFilterMode>('any');
	let tagSearchQuery = $state('');
	let highlightedIndex = $state(-1);

	// Reset highlight when the type-ahead query changes; reset both when the
	// popover closes so it reopens clean.
	$effect(() => {
		tagSearchQuery;
		highlightedIndex = -1;
	});

	$effect(() => {
		if (!filterOpen) {
			tagSearchQuery = '';
			highlightedIndex = -1;
		}
	});

	function handleTagInputKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightedIndex = Math.min(highlightedIndex + 1, filteredAvailableTags.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlightedIndex = Math.max(highlightedIndex - 1, 0);
		} else if (e.key === 'Enter' && filteredAvailableTags.length > 0) {
			e.preventDefault();
			const idx = highlightedIndex >= 0 ? highlightedIndex : 0;
			toggleTag(filteredAvailableTags[idx].tag);
			tagSearchQuery = '';
			highlightedIndex = -1;
		}
	}

	async function handleToggleFavorite(id: string) {
		await characterLibraryStore.toggleFavorite(id);
	}

	// Entries pipeline: characters → search → tag filter → favorites filter → sort → paginate
	let sectionEntries = $derived(characterLibraryStore.characters);

	let availableTags = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const entry of sectionEntries) {
			if (entry.identity.tags) {
				for (const tag of entry.identity.tags) {
					counts.set(tag, (counts.get(tag) || 0) + 1);
				}
			}
		}
		return Array.from(counts.entries())
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count);
	});

	let filteredAvailableTags = $derived(
		availableTags.filter(t =>
			t.tag.toLowerCase().includes(tagSearchQuery.toLowerCase())
		)
	);

	// Per-character chat stats feeding the chat-aware sorts. lastActivity comes
	// from the last real user message. Creating a chat or seeding greetings does
	// NOT count as "talked", so never-talked characters sink to the bottom of Recent.
	let chatStats = $derived.by(() => {
		const map = new Map<string, ChatStats>();
		for (const chat of chatStore.chats) {
			if (!chat.characterId) continue;
			const messages = messageCounts[chat.id] ?? 0;
			const talked = lastTalked[chat.id] ?? 0;
			const cur = map.get(chat.characterId);
			if (cur) {
				cur.chats += 1;
				cur.messages += messages;
				if (talked > cur.lastActivity) cur.lastActivity = talked;
			} else {
				map.set(chat.characterId, { chats: 1, messages, lastActivity: talked });
			}
		}
		return map;
	});

	let processedEntries = $derived.by(() => {
		let entries = sectionEntries.filter((e) => matchesSearch(e, searchQuery));
		if (selectedTags.length > 0) {
			if (tagFilterMode === 'all') {
				entries = entries.filter(e => selectedTags.every(t => e.identity.tags?.includes(t)));
			} else {
				entries = entries.filter(e => e.identity.tags?.some(t => selectedTags.includes(t)));
			}
		}
		if (favoritesOnly) {
			entries = entries.filter(e => e.isFavorite);
		}
		const sorted = sortEntries(entries, sortOption, { chatStats, randomSeed });
		return rankSearchResults(sorted, searchQuery);
	});

	// Chips line + funnel badge: anything currently narrowing the list.
	let filtersActive = $derived(
		selectedTags.length > 0 || favoritesOnly || searchQuery.trim().length > 0
	);
	let activeFilterCount = $derived(selectedTags.length + (favoritesOnly ? 1 : 0));

	let totalPages = $derived(Math.max(1, Math.ceil(processedEntries.length / perPage)));
	let safePage = $derived(Math.min(currentPage, totalPages));
	let paginatedEntries = $derived(
		processedEntries.slice((safePage - 1) * perPage, safePage * perPage)
	);

	// Primary click opens the character's chat. When the library can't dock
	// beside the chat (narrow window / phone), it renders as an overlay covering
	// the chat it just opened. Close it so the chat is actually visible.
	// During the New chat flow the pick advances the flow instead (on to the
	// persona step); no chat opens or is created yet.
	async function handleSelectEntry(id: string) {
		if (uiStore.newChatStep) {
			uiStore.advanceNewChat(id);
			return;
		}
		// Picking a character while an entry editor is open exits the editor first, then
		// opens the chat like a normal browse pick. Honour the nav guard so an unsaved
		// brand-new entry isn't silently abandoned.
		if (uiStore.libraryEditorId) {
			if (uiStore.guardBlocksNav()) return;
			uiStore.libraryEditorId = null;
		}
		const latest = chatCastStore.latestChatForCharacter(id, chatStore.chats);
		if (latest) {
			await chatStore.selectChat(latest);
		} else {
			await chatStore.createChat({ characterId: id });
		}
		uiStore.closeOverlay();
		if (!viewport.canDockSettings) uiStore.closeLibrary();
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

	// Export: opens the format/version dialog for the clicked card or the current selection.
	// No editor needed. Ids (not entry refs) stay live if the library reloads under the dialog.
	let exportIds = $state<string[] | null>(null);
	let exportTargets = $derived(
		exportIds
			? exportIds.flatMap((id) => {
					const entry = characterLibraryStore.entries.find((e) => e.id === id);
					return entry ? [{ entry, versions: characterLibraryStore.versionsFor(entry.id) }] : [];
				})
			: null
	);
	function handleExport(id: string) {
		exportIds = [id];
	}
	function exportSelection() {
		if (selectedCount === 0) return;
		exportIds = [...selectedIds];
	}

	// Making a persona of a character: the dialog holds the id, not the entry, so a library
	// reload under it stays consistent, the same rule the export dialog follows.
	let convertId = $state<string | null>(null);
	let convertEntry = $derived(
		convertId ? (characterLibraryStore.entries.find((e) => e.id === convertId) ?? null) : null
	);

	let deleteTargetId = $state<string | null>(null);
	let deleteTargetUsage = $state<{ chatCount: number; castCount: number } | null>(null);
	let deleteTargetName = $derived(
		deleteTargetId
			? characterLibraryStore.entries.find(e => e.id === deleteTargetId)?.identity.name || 'entry'
			: ''
	);
	let deleteTargetMessage = $derived.by(() => {
		const base = `Are you sure you want to delete "${deleteTargetName}"? This cannot be undone.`;
		if (!deleteTargetUsage || deleteTargetUsage.castCount === 0) {
			return base;
		}
		return `${base} It is bound to ${deleteTargetUsage.chatCount} chat(s); those chats will be left without a character.`;
	});

	async function handleDelete(id: string) {
		deleteTargetId = id;
		deleteTargetUsage = await characterLibraryStore.getEntryUsage(id);
	}

	async function confirmDelete() {
		if (!deleteTargetId) return;
		const id = deleteTargetId;
		deleteTargetId = null;
		deleteTargetUsage = null;
		const usage = await characterLibraryStore.deleteEntry(id);
		chatStore.unbindCharacterFromChats(usage.chatIds);
	}

	async function handleCreateNew() {
		const entry = await characterLibraryStore.createCharacter();
		uiStore.libraryEditorId = entry.id;
	}

	function handleImportClick() {
		importInputRef?.click();
	}

	async function handleImportFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = input.files;
		if (!files || files.length === 0) return;

		importing = true;
		const parsed: PendingImport[] = [];
		for (const file of Array.from(files)) {
			try {
				const result = await importSillyTavernCard(file);
				const hasBook = !!(result.lorebook && result.lorebook.entries.length > 0);
				parsed.push({ result, hasBook, importBook: hasBook });
			} catch (error) {
				console.error(`Failed to import ${file.name}:`, error);
				toastStore.failed(`import "${file.name}"`, error);
			}
		}
		input.value = '';
		importing = false;

		if (parsed.length === 0) return;

		// Any embedded lorebooks? Let the user choose which (if any) to bring in.
		if (parsed.some((p) => p.hasBook)) {
			pendingImports = parsed;
			lorebookPromptOpen = true;
			return;
		}

		await finalizeImport(parsed);
	}

	// Persist the parsed cards, importing each embedded lorebook only when its
	// importBook flag is set. Shared by the no-lorebook fast path and the dialog.
	async function finalizeImport(items: PendingImport[]) {
		lorebookPromptOpen = false;
		importing = true;
		let successCount = 0;
		let lastEntry: typeof characterLibraryStore.entries[0] | null = null;
		// Built once for the batch: a series of cards ships the same book in every one of them,
		// and one shelf row with a link from each character is what the reader asked for.
		const bookIndex = createBookIndex(lorebookStore.books);

		for (const item of items) {
			try {
				const { entry } = await characterLibraryStore.importFromSillyTavern(item.result, {
					importLorebook: item.importBook,
					bookIndex
				});
				lastEntry = entry;
				successCount++;
			} catch (error) {
				const name = item.result.character.name || 'character';
				console.error(`Failed to import ${name}:`, error);
				toastStore.failed(`import "${name}"`, error);
			}
		}
		if (successCount > 0) {
			if (successCount === 1 && lastEntry) {
				toastStore.success(`Imported "${lastEntry.identity.name || 'character'}"`);
				uiStore.libraryEditorId = lastEntry.id;
			} else {
				toastStore.success(`Imported ${successCount} character${successCount > 1 ? 's' : ''}`);
			}
		}

		pendingImports = [];
		importing = false;
	}

	function toggleAllBooks() {
		const next = !allBooksSelected;
		for (const p of pendingImports) if (p.hasBook) p.importBook = next;
	}

	function importCharactersOnly() {
		for (const p of pendingImports) p.importBook = false;
		finalizeImport(pendingImports);
	}

	function cancelImport() {
		lorebookPromptOpen = false;
		pendingImports = [];
	}

	// ==================== Bulk selection ====================
	// Entered from the ⋯ menu ("Select multiple"), exited via the bar's Done.
	let selectionMode = $state(false);
	let selectedIds = $state<Set<string>>(new Set());

	let selectedEntries = $derived(sectionEntries.filter((e) => selectedIds.has(e.id)));
	// Count live entries, not raw ids: an entry deleted while selected would
	// otherwise keep inflating the "N selected" label with a stale id.
	let selectedCount = $derived(selectedEntries.length);
	let allFilteredSelected = $derived(
		processedEntries.length > 0 && processedEntries.every((e) => selectedIds.has(e.id))
	);

	// Union of tags across the current selection, which drives the "Remove tags" popover.
	let selectionTagUnion = $derived.by(() => {
		const set = new Set<string>();
		for (const e of selectedEntries) for (const t of e.identity.tags ?? []) set.add(t);
		return Array.from(set).sort((a, b) => a.localeCompare(b));
	});

	function toggleSelectionMode() {
		selectionMode = !selectionMode;
		if (!selectionMode) clearSelection();
	}

	function toggleSelect(id: string) {
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	function selectAllFiltered() {
		const next = new Set(selectedIds);
		for (const e of processedEntries) next.add(e.id);
		selectedIds = next;
	}

	function clearSelection() {
		selectedIds = new Set();
		favMenuOpen = false;
		tagsOpen = false;
	}

	// Esc leaves selection mode, but only when nothing above it (a popover or a
	// confirm dialog, which consume Esc themselves) is open.
	$effect(() => {
		if (!selectionMode) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (filterOpen || viewOpen || moreOpen || favMenuOpen || tagsOpen) return;
			if (bulkDeleteOpen || lorebookPromptOpen || exportIds || convertId) return;
			// Consume the press so the workspace's global Esc doesn't also close
			// the hosting Library panel.
			e.preventDefault();
			e.stopPropagation();
			toggleSelectionMode();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});

	// ---- Bulk delete ----
	let bulkDeleteOpen = $state(false);
	let bulkDeleteUsage = $state<{ boundCount: number; chatCount: number } | null>(null);
	let bulkDeleteMessage = $derived.by(() => {
		const n = selectedCount;
		const base = `Delete ${n} character${n === 1 ? '' : 's'}? This cannot be undone.`;
		if (!bulkDeleteUsage || bulkDeleteUsage.boundCount === 0) return base;
		const { boundCount, chatCount } = bulkDeleteUsage;
		return `${base} ${boundCount} of them ${boundCount === 1 ? 'is' : 'are'} bound to ${chatCount} chat(s); those chats will be left without a character.`;
	});

	async function openBulkDelete() {
		if (selectedCount === 0) return;
		bulkDeleteUsage = await characterLibraryStore.getEntriesUsage([...selectedIds]);
		bulkDeleteOpen = true;
	}

	async function confirmBulkDelete() {
		const ids = [...selectedIds];
		bulkDeleteOpen = false;
		bulkDeleteUsage = null;
		const unboundChatIds = await characterLibraryStore.deleteEntries(ids);
		chatStore.unbindCharacterFromChats(unboundChatIds);
		toastStore.success(`Deleted ${ids.length} character${ids.length === 1 ? '' : 's'}`);
		clearSelection();
	}

	// ---- Bulk favorite ----
	async function bulkSetFavorite(isFavorite: boolean) {
		const ids = [...selectedIds];
		if (ids.length === 0) return;
		await characterLibraryStore.setFavoriteMany(ids, isFavorite);
		toastStore.success(
			`${isFavorite ? 'Favorited' : 'Unfavorited'} ${ids.length} character${ids.length === 1 ? '' : 's'}`
		);
	}

	// ---- Bulk favorite menu + tag editor popovers ----
	let favMenuOpen = $state(false);
	let tagsOpen = $state(false);
	let addTagsValue = $state('');

	async function submitAddTags() {
		const tags = addTagsValue.split(',').map((t) => t.trim()).filter(Boolean);
		if (tags.length === 0) return;
		const changed = await characterLibraryStore.addTagsMany([...selectedIds], tags);
		addTagsValue = '';
		tagsOpen = false;
		toastStore.success(
			`Added tag${tags.length === 1 ? '' : 's'} to ${changed} character${changed === 1 ? '' : 's'}`
		);
	}

	function handleAddTagsKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			submitAddTags();
		}
	}

	async function removeBulkTag(tag: string) {
		const changed = await characterLibraryStore.removeTagsMany([...selectedIds], [tag]);
		toastStore.success(`Removed "${tag}" from ${changed} character${changed === 1 ? '' : 's'}`);
	}
</script>

<div class="brw" class:guard-flash={guardFlash}>
	<!-- Browse list only. The entry editor pops out centered over the chat
	     (LibraryEditorOverlay), so it isn't rendered here. -->
	{#if sectionEntries.length > 0}
		<!-- Toolbar: search front and center, three quiet disclosures, one primary action.
		     The entry count lives in the search placeholder. -->
		<div class="brw-bar">
			<div class="brw-search">
				<Icon name="search" class="brw-search-icon w-3.5 h-3.5" />
				<input
					type="text"
					value={searchQuery}
					oninput={handleSearchInput}
					placeholder="Search {sectionEntries.length} character{sectionEntries.length === 1 ? '' : 's'}…"
					aria-label="Search characters"
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
						{#each CHARACTER_SORT_OPTIONS as opt}
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

				{#if availableTags.length > 0}
					<div class="brw-sec">
						<div class="brw-sec-head">
							<span class="brw-sec-title">Tags</span>
							{#if selectedTags.length > 1}
								<div class="brw-mini-seg" role="group" aria-label="Tag match mode">
									<button
										type="button"
										class:is-active={tagFilterMode === 'any'}
										onclick={() => { tagFilterMode = 'any'; currentPage = 1; }}
										title="Entries with any selected tag"
									>
										ANY
									</button>
									<button
										type="button"
										class:is-active={tagFilterMode === 'all'}
										onclick={() => { tagFilterMode = 'all'; currentPage = 1; }}
										title="Entries with all selected tags"
									>
										ALL
									</button>
								</div>
							{/if}
						</div>
						{#if availableTags.length > 6}
							<input
								type="text"
								bind:value={tagSearchQuery}
								onkeydown={handleTagInputKeydown}
								placeholder="Find a tag…"
								role="combobox"
								aria-label="Find a tag"
								aria-autocomplete="list"
								aria-expanded="true"
								aria-controls="tag-filter-options"
								class="input-base w-full h-7 px-2.5 text-xs font-ui text-text-primary placeholder:text-text-muted"
							/>
						{/if}
						<div id="tag-filter-options" role="listbox" class="brw-tag-list">
							{#each filteredAvailableTags as { tag, count }, i}
								<button
									type="button"
									role="option"
									aria-selected={selectedTags.includes(tag)}
									class="brw-tag-row"
									class:is-checked={selectedTags.includes(tag)}
									class:is-highlighted={i === highlightedIndex}
									onclick={() => toggleTag(tag)}
								>
									<span class="brw-tag-check">
										<Icon name="check" class="w-2.5 h-2.5" />
									</span>
									<span class="brw-tag-name">{tag}</span>
									<span class="brw-tag-count">{count}</span>
								</button>
							{:else}
								<p class="px-1 py-1.5 text-xs font-ui text-text-muted">No tags match.</p>
							{/each}
						</div>
					</div>
				{/if}
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
					<div class="brw-sec space-y-2.5">
						<div class="flex items-center justify-between gap-2">
							<span class="brw-sec-title">Show Portraits</span>
							<Toggle
								size="sm"
								checked={listPortraits}
								onchange={(v) => libraryViewPrefs.setListPortraits(v)}
								label="Show portraits on each row"
							/>
						</div>
						<div class="flex items-center justify-between gap-2">
							<span class="brw-sec-title">Show Tags</span>
							<Toggle
								size="sm"
								checked={listTags}
								onchange={(v) => libraryViewPrefs.setListTags(v)}
								label="Show tags on each row"
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
								use:rangeReset={{ defaultValue: BROWSE_DEFAULTS.cardSize, apply: (v) => libraryViewPrefs.setCardSize(v) }}
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

			<!-- More: import + bulk selection -->
			<BrowsePopover bind:open={moreOpen} variant="menu">
				{#snippet trigger({ toggle, open })}
					<button
						type="button"
						class="brw-btn"
						class:is-active={open}
						onclick={toggle}
						aria-haspopup="menu"
						aria-expanded={open}
						aria-label="More actions"
						title="More actions"
					>
						{#if importing}
							<Spinner size="sm" />
						{:else}
							<Icon name="dotsVertical" class="w-4 h-4" />
						{/if}
					</button>
				{/snippet}

				<button
					type="button"
					role="menuitem"
					class="brw-menu-item"
					disabled={importing}
					onclick={() => { moreOpen = false; handleImportClick(); }}
				>
					<Icon name="upload" class="w-3.5 h-3.5" />
					Import cards…
				</button>
				<button
					type="button"
					role="menuitem"
					class="brw-menu-item"
					onclick={() => { moreOpen = false; toggleSelectionMode(); }}
				>
					<Icon name="check" class="w-3.5 h-3.5" />
					{selectionMode ? 'Exit selection' : 'Select multiple'}
				</button>
			</BrowsePopover>

			<button type="button" class="brw-new" onclick={handleCreateNew} title="New character">
				<Icon name="plus" class="w-4 h-4" />
				<span class="brw-new-label">New</span>
			</button>
		</div>

		<!-- Active filters: a summary line that only exists while something narrows the list -->
		{#if filtersActive}
			<div class="brw-chips">
				<span class="brw-chips-count"><b>{processedEntries.length}</b> of {sectionEntries.length}</span>
				{#if selectedTags.length > 1}
					<button
						type="button"
						class="brw-chip-mode"
						onclick={() => { tagFilterMode = tagFilterMode === 'any' ? 'all' : 'any'; currentPage = 1; }}
						title={tagFilterMode === 'any' ? 'Showing entries with ANY selected tag. Click for ALL' : 'Showing entries with ALL selected tags. Click for ANY'}
					>
						{tagFilterMode === 'any' ? 'any of' : 'all of'}
					</button>
				{/if}
				{#each selectedTags as tag}
					<span class="brw-chip">
						{tag}
						<button type="button" class="brw-chip-x" onclick={() => toggleTag(tag)} aria-label="Remove {tag}">
							<Icon name="close" class="w-2.5 h-2.5" />
						</button>
					</span>
				{/each}
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

		<!-- Bulk selection bar: exit + count + scope links on the left, three actions
		     on the right (favorite menu, tag editor, delete). Labels appear when the
		     container has room; Esc leaves the mode. -->
		{#if selectionMode}
			<div class="brw-bulk">
				<button
					type="button"
					class="brw-bulk-x"
					onclick={toggleSelectionMode}
					aria-label="Exit selection"
					title="Exit selection (Esc)"
				>
					<Icon name="close" class="w-4 h-4" />
				</button>
				<span class="brw-bulk-count"><b>{selectedCount}</b> selected</span>
				<button
					type="button"
					class="brw-bulk-link"
					onclick={selectAllFiltered}
					disabled={allFilteredSelected}
				>
					All ({processedEntries.length})
				</button>
				<button
					type="button"
					class="brw-bulk-link"
					onclick={clearSelection}
					disabled={selectedCount === 0}
				>
					None
				</button>
				<div class="brw-bulk-spacer"></div>

				<BrowsePopover bind:open={favMenuOpen} variant="menu">
					{#snippet trigger({ toggle, open })}
						<button
							type="button"
							class="brw-bulk-btn"
							onclick={toggle}
							disabled={selectedCount === 0}
							aria-haspopup="menu"
							aria-expanded={open}
							title="Favorite"
						>
							<Icon name="heart" class="w-3.5 h-3.5" />
							<span class="brw-bulk-label">Favorite</span>
							<Icon name="chevronDown" class="w-3 h-3" />
						</button>
					{/snippet}
					<button
						type="button"
						role="menuitem"
						class="brw-menu-item"
						onclick={() => { favMenuOpen = false; bulkSetFavorite(true); }}
					>
						<Icon name="heart" class="w-3.5 h-3.5 fill-current" />
						Favorite {selectedCount}
					</button>
					<button
						type="button"
						role="menuitem"
						class="brw-menu-item"
						onclick={() => { favMenuOpen = false; bulkSetFavorite(false); }}
					>
						<Icon name="heart" class="w-3.5 h-3.5" />
						Unfavorite {selectedCount}
					</button>
				</BrowsePopover>

				<BrowsePopover bind:open={tagsOpen}>
					{#snippet trigger({ toggle, open })}
						<button
							type="button"
							class="brw-bulk-btn"
							onclick={toggle}
							disabled={selectedCount === 0}
							aria-haspopup="true"
							aria-expanded={open}
							title="Tags"
						>
							<Icon name="tag" class="w-3.5 h-3.5" />
							<span class="brw-bulk-label">Tags</span>
						</button>
					{/snippet}
					<div class="brw-sec">
						<div class="brw-sec-head">
							<span class="brw-sec-title">Add tags</span>
						</div>
						<div class="flex items-center gap-1.5">
							<!-- svelte-ignore a11y_autofocus -->
							<input
								type="text"
								bind:value={addTagsValue}
								onkeydown={handleAddTagsKeydown}
								placeholder="tag1, tag2, …"
								autofocus
								class="input-base flex-1 min-w-0 px-2.5 py-1.5 text-xs font-ui text-text-primary placeholder:text-text-muted"
							/>
							<Button
								variant="primary"
								size="sm"
								class="!px-2.5 !py-1.5 !text-xs"
								onclick={submitAddTags}
								disabled={!addTagsValue.trim()}
							>
								Add
							</Button>
						</div>
					</div>
					<div class="brw-sec">
						<div class="brw-sec-head">
							<span class="brw-sec-title">On selection: click to remove</span>
						</div>
						{#if selectionTagUnion.length === 0}
							<p class="px-1 py-1 text-xs font-ui text-text-muted">No tags on the selection.</p>
						{:else}
							<div class="brw-tag-list">
								{#each selectionTagUnion as tag}
									<button
										type="button"
										class="brw-tag-row"
										onclick={() => removeBulkTag(tag)}
										title={`Remove "${tag}" from the selection`}
									>
										<span class="brw-tag-name">{tag}</span>
										<Icon name="close" class="w-3 h-3 shrink-0 text-text-muted" />
									</button>
								{/each}
							</div>
						{/if}
					</div>
				</BrowsePopover>

				<button
					type="button"
					class="brw-bulk-btn"
					onclick={exportSelection}
					disabled={selectedCount === 0}
					title="Export as SillyTavern cards"
				>
					<Icon name="download" class="w-3.5 h-3.5" />
					<span class="brw-bulk-label">Export</span>
				</button>

				<button
					type="button"
					class="brw-bulk-btn brw-bulk-btn--danger"
					onclick={openBulkDelete}
					disabled={selectedCount === 0}
				>
					<Icon name="trash" class="w-3.5 h-3.5" />
					<span class="brw-bulk-label">Delete</span>
				</button>
			</div>
		{/if}
	{/if}

	<!-- Browse area -->
	<div id="library-panel" role="region" aria-label="Characters" class="brw-content">
		{#if characterLibraryStore.loading}
			<div class="flex items-center justify-center h-full">
				<div class="flex flex-col items-center gap-3 text-text-muted">
					<Spinner size="lg" />
					<span class="text-sm font-ui">Loading library…</span>
				</div>
			</div>
		{:else if sectionEntries.length === 0}
			<div class="grid place-items-center h-full">
				<EmptyState icon="users" title="No characters yet">
					Characters you write or import live here, ready to reuse in any chat.
					{#snippet actions()}
						<Button variant="primary" size="sm" onclick={handleCreateNew}>
							<Icon name="plus" class="w-4 h-4" />
							New character
						</Button>
						<Button variant="secondary" size="sm" onclick={handleImportClick} disabled={importing}>
							{#if importing}
								<Spinner size="sm" />
							{:else}
								<Icon name="upload" class="w-4 h-4" />
							{/if}
							Import
						</Button>
					{/snippet}
				</EmptyState>
			</div>
		{:else if processedEntries.length === 0}
			<div class="grid place-items-center h-full">
				<EmptyState icon="search" size="sm" title="No matches">
					No characters match your current filters.
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
							{selectionMode}
							selected={selectedIds.has(entry.id)}
							onToggleSelect={toggleSelect}
							onSelect={handleSelectEntry}
							onEdit={handleEditEntry}
							onDuplicate={handleDuplicate}
							onDelete={handleDelete}
							onToggleFavorite={handleToggleFavorite}
							onExport={handleExport}
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
							{selectionMode}
							selected={selectedIds.has(entry.id)}
							onToggleSelect={toggleSelect}
							onSelect={handleSelectEntry}
							onEdit={handleEditEntry}
							onDuplicate={handleDuplicate}
							onDelete={handleDelete}
							onToggleFavorite={handleToggleFavorite}
							onExport={handleExport}
							onConvert={(id) => (convertId = id)}
						/>
					{/each}
				</div>
			{:else}
				<div class="flex flex-col divide-y divide-border-subtle">
					{#each paginatedEntries as entry (entry.id)}
						<LibraryListRow
							{entry}
							{selectionMode}
							selected={selectedIds.has(entry.id)}
							onToggleSelect={toggleSelect}
							onSelect={handleSelectEntry}
							onEdit={handleEditEntry}
							onDuplicate={handleDuplicate}
							onDelete={handleDelete}
							onToggleFavorite={handleToggleFavorite}
							onExport={handleExport}
							onConvert={(id) => (convertId = id)}
							onTagClick={toggleTag}
							showTags={listTags}
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

<!-- Hidden file input for SillyTavern import -->
<input
	bind:this={importInputRef}
	type="file"
	accept=".png,.json"
	multiple
	onchange={handleImportFile}
	class="hidden"
/>

<ConfirmDialog
	open={deleteTargetId !== null}
	title="Delete from library"
	message={deleteTargetMessage}
	confirmLabel="Delete"
	variant="danger"
	destructive
	onConfirm={confirmDelete}
	onCancel={() => deleteTargetId = null}
/>

{#if exportTargets && exportTargets.length > 0}
	<ExportDialog open targets={exportTargets} onClose={() => (exportIds = null)} />
{/if}

{#if convertEntry}
	<ConvertEntryDialog open entry={convertEntry} onClose={() => (convertId = null)} />
{/if}

<ConfirmDialog
	open={bulkDeleteOpen}
	title="Delete {selectedCount} character{selectedCount === 1 ? '' : 's'}"
	message={bulkDeleteMessage}
	confirmLabel="Delete {selectedCount}"
	variant="danger"
	destructive
	holdMs={holdMsForBlast(selectedCount)}
	onConfirm={confirmBulkDelete}
	onCancel={() => { bulkDeleteOpen = false; bulkDeleteUsage = null; }}
/>

<Dialog
	open={lorebookPromptOpen}
	onClose={cancelImport}
	title="Import embedded lorebooks?"
	size="lg"
>
	<div class="space-y-4">
		<p class="text-sm text-text-secondary">
			{pendingWithBooks.length} of the imported character{pendingImports.length === 1 ? '' : 's'}
			{pendingWithBooks.length === 1 ? 'comes' : 'come'} with an embedded lorebook. Pick which to
			bring in. Characters import either way.
		</p>

		<div class="flex items-center justify-between">
			<button type="button" class="text-sm text-accent hover:underline" onclick={toggleAllBooks}>
				{allBooksSelected ? 'Deselect all' : 'Select all'}
			</button>
			<span class="text-xs text-text-tertiary">
				{pendingWithBooks.filter((p) => p.importBook).length} selected
			</span>
		</div>

		<ul class="space-y-2 max-h-[50dvh] overflow-y-auto">
			{#each pendingWithBooks as item (item.result)}
				<li>
					<label class="flex items-start gap-3 p-3 rounded-[var(--radius-lg)] border border-border-subtle hover:bg-bg-tertiary cursor-pointer">
						<input type="checkbox" bind:checked={item.importBook} class="mt-1" />
						<span class="min-w-0">
							<span class="block text-sm font-medium text-text-primary truncate">
								{item.result.character.name || 'Unnamed character'}
							</span>
							<span class="block text-xs text-text-secondary truncate">
								{item.result.lorebook?.name || 'Lorebook'} · {item.result.lorebook?.entries.length ?? 0} entries
							</span>
						</span>
					</label>
				</li>
			{/each}
		</ul>

		<div class="flex justify-end gap-2 pt-1">
			<Button variant="ghost" onclick={cancelImport}>Cancel</Button>
			<Button variant="secondary" onclick={importCharactersOnly}>Characters only</Button>
			<Button variant="primary" onclick={() => finalizeImport(pendingImports)}>Import</Button>
		</div>
	</div>
</Dialog>
