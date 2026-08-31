<script lang="ts">
	/**
	 * Lorebooks half of the merged Library (see library/LibraryView): the shelf, wearing the
	 * Characters and Personas tabs' own browse bar, selection bar, view options (layout, card
	 * size, per page) and pager.
	 *
	 * A press opens the book's editor over the chat (uiStore.lorebookEditorId), the same slot
	 * and the same reason as the character editor: a book is a document, and the dock is a shelf.
	 */
	import { tick } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { holdMsForBlast } from '$lib/components/ui/HoldToConfirmButton.svelte';
	import BrowsePopover from '$lib/components/library/BrowsePopover.svelte';
	import LibraryPager from '$lib/components/library/LibraryPager.svelte';
	import { foldForSearch, CARD_SIZE_MAP, PER_PAGE_OPTIONS } from '$lib/components/library/browse';
	import LorebookShelfRow from './LorebookShelfRow.svelte';
	import LorebookGalleryCard from './LorebookGalleryCard.svelte';
	import LorebookGridCard from './LorebookGridCard.svelte';
	import LorebookActivationPanel from './LorebookActivationPanel.svelte';
	import { rangeReset } from '$lib/actions/rangeReset';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import { downloadLorebook, downloadLorebooks, readLorebookFile } from '$lib/lorebook/io';
	import { activationSummary, lorebookDeleteMessage, sortLorebooks } from '$lib/lorebook/types';
	import {
		lorebookViewPrefs,
		LOREBOOK_SORT_OPTIONS,
		LOREBOOK_VIEW_DEFAULTS
	} from '$lib/stores/lorebookViewPrefs.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';

	let books = $derived(lorebookStore.books);

	/** The Global Settings row's own line: the defaults, in the wording the open book's
	 *  Activation strip uses. Passed as both layers, so nothing is lit: this IS the root. */
	let defaults = $derived(
		activationSummary(lorebookSettingsStore.settings, lorebookSettingsStore.settings)
	);

	/** bookId → how many characters and personas carry it. One pass over the library rather
	 *  than a filter per row, which would walk the whole library once for every book. An
	 *  entry counts once however many times its own link list names the book, or a row would
	 *  claim two carriers where one stands. */
	let links = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const entry of characterLibraryStore.entries) {
			for (const id of new Set(entry.data.lorebookIds ?? [])) {
				counts.set(id, (counts.get(id) ?? 0) + 1);
			}
		}
		return counts;
	});

	// Consume the one-shot deep link (an assistant chip pointing at a book), the shape the
	// two library views use for theirs. An id naming no book is dropped once the shelf has
	// books, rather than left armed to open an editor over a book that is gone.
	$effect(() => {
		const pending = uiStore.pendingLorebookId;
		if (!pending) return;
		if (books.some((b) => b.id === pending)) {
			open(pending);
			uiStore.pendingLorebookId = null;
		} else if (books.length) {
			uiStore.pendingLorebookId = null;
		}
	});

	// ===== search, filter & sort =====

	let search = $state('');
	let filterOpen = $state(false);
	let viewOpen = $state(false);
	let moreOpen = $state(false);
	let currentPage = $state(1);

	/** Every narrowing and every reordering sends the reader back to the first page: the row
	 *  they were looking at is not on page four of a list that just changed under them. */
	function resetPage() {
		currentPage = 1;
	}

	/** The defaults page, a drill-down over the shelf: a layer every book falls back to is a
	 *  property of the archive, never of one book (architecture/lorebook.md). */
	let defaultsOpen = $state(false);
	let defaultsRow = $state<HTMLButtonElement | null>(null);
	let defaultsBack = $state<HTMLButtonElement | null>(null);

	/** Either end of this navigation unmounts the block the press came from, so the keyboard is
	 *  carried across by hand: left alone it would land on `<body>` and have to Tab back in. */
	async function setDefaults(open: boolean) {
		defaultsOpen = open;
		await tick();
		if (open) defaultsBack?.focus();
		else defaultsRow?.focus();
	}

	/** The Show filter's three answers: how a book reaches a prompt, with global outranking
	 *  linked (architecture/lorebook.md). `noun` writes the chips and their screen-reader
	 *  labels, in the same every-chat vocabulary the rest of the shelf speaks. */
	const LINK_STATES = [
		{ id: 'global', label: 'In every chat', noun: 'every-chat books' },
		{ id: 'linked', label: 'Linked', noun: 'linked books' },
		{ id: 'unlinked', label: 'Unlinked', noun: 'unlinked books' }
	] as const;
	type LinkState = (typeof LINK_STATES)[number]['id'];

	let hidden = $state<LinkState[]>([]);

	function toggleLinkState(state: LinkState) {
		hidden = hidden.includes(state) ? hidden.filter((s) => s !== state) : [...hidden, state];
		resetPage();
	}

	// The app-wide lorebook display order, shared with both pickers over this shelf; layout,
	// card size and per-page are this shelf's alone (architecture/lorebook.md coupling 10).
	let ordered = $derived(sortLorebooks(books, lorebookViewPrefs.order));
	let cardMinWidth = $derived(CARD_SIZE_MAP[lorebookViewPrefs.cardSize] ?? 160);

	/** The search reads names, entry titles and keywords, never entry content (architecture/
	 *  lorebook.md), folded once per book and kept until that book is edited: folding on every
	 *  keystroke is a pass over the whole archive per character typed. */
	const index = new Map<string, { stamp: number; text: string }>();

	function searchTextOf(book: (typeof books)[number]): string {
		const cached = index.get(book.id);
		if (cached && cached.stamp === book.updatedAt) return cached.text;
		// The fallback name is searchable too, or the one word an unnamed book is listed
		// under is the one word that cannot find it.
		const parts = [book.name || 'Untitled lorebook'];
		for (const entry of book.entries) {
			if (entry.comment) parts.push(entry.comment);
			parts.push(...entry.key, ...entry.keysecondary);
		}
		const text = foldForSearch(parts.join('\n'));
		index.set(book.id, { stamp: book.updatedAt, text });
		return text;
	}

	let query = $derived(foldForSearch(search.trim()));
	let visible = $derived(
		ordered.filter((book) => {
			const state: LinkState = book.global
				? 'global'
				: (links.get(book.id) ?? 0) > 0
					? 'linked'
					: 'unlinked';
			if (hidden.includes(state)) return false;
			return !query || searchTextOf(book).includes(query);
		})
	);

	// The badge counts what is NARROWING the list and never the order, the same line the
	// Library's own funnel draws.
	let filtersActive = $derived(hidden.length > 0 || query.length > 0);

	let totalPages = $derived(Math.max(1, Math.ceil(visible.length / lorebookViewPrefs.perPage)));
	let safePage = $derived(Math.min(currentPage, totalPages));
	let paged = $derived(
		visible.slice(
			(safePage - 1) * lorebookViewPrefs.perPage,
			safePage * lorebookViewPrefs.perPage
		)
	);

	// ===== bulk selection =====

	let selectionMode = $state(false);
	let selectedIds = $state<Set<string>>(new Set());

	// Count live books, not raw ids: one deleted while selected would keep inflating the label.
	let selected = $derived(books.filter((b) => selectedIds.has(b.id)));
	let allVisibleSelected = $derived(
		visible.length > 0 && visible.every((b) => selectedIds.has(b.id))
	);

	function toggleSelectionMode() {
		selectionMode = !selectionMode;
		if (!selectionMode) selectedIds = new Set();
	}

	function toggleSelect(id: string) {
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	// Esc steps back out of the defaults page, or out of selection mode, but only when
	// nothing above it (a popover or a confirm dialog, which consume Esc themselves) is open.
	$effect(() => {
		// An open book is the top-most surface and answers Escape itself. This listener is on
		// `document`, which fires before its window handler, so it stands down while one is up.
		if (uiStore.lorebookEditorId) return;
		if (!selectionMode && !defaultsOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (filterOpen || viewOpen || moreOpen || bulkDeleteOpen || deleteId) return;
			// Consume the press so the workspace's global Esc doesn't also close the Library.
			e.preventDefault();
			e.stopPropagation();
			if (defaultsOpen) void setDefaults(false);
			else toggleSelectionMode();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});

	// ===== book actions =====

	let fileInput = $state<HTMLInputElement | null>(null);

	function open(id: string) {
		// A defaults page left standing behind an open book is a shelf that has lost the list
		// the book came off.
		defaultsOpen = false;
		uiStore.lorebookEditorId = id;
	}

	/** A fresh book opens straight into its editor, which is where it is named. Nothing opens
	 *  when the row never reached the server: an editor over a book that is not on disk. */
	async function newBook() {
		try {
			const book = await lorebookStore.createBook('');
			open(book.id);
		} catch (err) {
			toastStore.failed('create a lorebook', err);
		}
	}

	async function onFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		const landed: string[] = [];
		for (const file of files) {
			try {
				const book = await readLorebookFile(file);
				await lorebookStore.addBook(book);
				landed.push(book.id);
				toastStore.success(`Imported "${book.name}" (${book.entries.length} entries)`);
			} catch (err) {
				toastStore.failed(`import "${file.name}"`, err);
			}
		}
		// One book opens so it never has to be hunted for; a batch does not, since thirty
		// editors would be thirty answers to the same question.
		if (landed.length === 1) open(landed[0]);
	}

	function exportOne(id: string) {
		const book = lorebookStore.getBook(id);
		if (book) downloadLorebook(book);
	}

	function exportSelection() {
		if (selected.length > 0) downloadLorebooks(selected);
	}

	// ---- delete ----

	let deleteId = $state<string | null>(null);
	let deleteTarget = $derived(deleteId ? lorebookStore.getBook(deleteId) : null);
	let deleteMessage = $derived(
		deleteTarget ? lorebookDeleteMessage(deleteTarget, links.get(deleteTarget.id) ?? 0) : ''
	);

	async function confirmDelete() {
		if (!deleteId) return;
		const id = deleteId;
		deleteId = null;
		// The editor stands over this shelf, so a book going means it has nothing left to show.
		if (uiStore.lorebookEditorId === id) uiStore.lorebookEditorId = null;
		try {
			await lorebookStore.deleteBook(id);
		} catch (err) {
			toastStore.failed('delete that lorebook', err);
		}
	}

	let bulkDeleteOpen = $state(false);
	let bulkEntryCount = $derived(selected.reduce((sum, b) => sum + b.entries.length, 0));
	/** What the press destroys, and it is whichever count is larger: twenty empty books are
	 *  still twenty books, and one book of nine hundred entries is still a big loss. Priced
	 *  on entries alone, a shelf of small books would clear on a single click. */
	let bulkBlast = $derived(Math.max(selected.length, bulkEntryCount));
	let bulkDeleteMessage = $derived.by(() => {
		const n = selected.length;
		// A selection of empty books holds nothing, so it says nothing about entries: "and
		// their 0 entries" states a loss that is not there.
		const held =
			bulkEntryCount > 0
				? ` and their ${bulkEntryCount} ${bulkEntryCount === 1 ? 'entry' : 'entries'}`
				: '';
		const carried = selected.filter((b) => (links.get(b.id) ?? 0) > 0).length;
		const bound = carried > 0 ? ` ${carried} of them ${carried === 1 ? 'is' : 'are'} in use.` : '';
		return `Delete ${n} lorebook${n === 1 ? '' : 's'}${held}?${bound} This cannot be undone.`;
	});

	async function confirmBulkDelete() {
		const ids = selected.map((b) => b.id);
		bulkDeleteOpen = false;
		if (ids.includes(uiStore.lorebookEditorId ?? '')) uiStore.lorebookEditorId = null;
		try {
			await lorebookStore.deleteBooks(ids);
			toastStore.success(`Deleted ${ids.length} lorebook${ids.length === 1 ? '' : 's'}`);
		} catch (err) {
			toastStore.failed('delete those lorebooks', err);
		}
		selectionMode = false;
		selectedIds = new Set();
	}
</script>

<div class="brw">
	{#if defaultsOpen}
		<!-- The defaults page's top row, standing where the toolbar was so the two pages
		     line up: the way back, then the name of what is on screen. -->
		<div class="brw-bar">
			<button
				type="button"
				class="brw-btn"
				bind:this={defaultsBack}
				onclick={() => void setDefaults(false)}
				aria-label="Back to lorebooks"
				title="Back (Esc)"
			>
				<Icon name="chevronLeft" class="w-4 h-4" strokeWidth={2} />
			</button>
			<span class="lbd-title">Global Settings</span>
		</div>
	{:else if books.length > 0}
		<!-- Toolbar: search front and center, two quiet disclosures, one primary action.
		     The book count lives in the search placeholder. -->
		<div class="brw-bar">
			<div class="brw-search">
				<Icon name="search" class="brw-search-icon w-3.5 h-3.5" />
				<input
					type="text"
					value={search}
					oninput={(e) => {
						search = (e.target as HTMLInputElement).value;
						resetPage();
					}}
					placeholder="Search {books.length} lorebook{books.length === 1 ? '' : 's'}…"
					aria-label="Search lorebooks by name, entry title or keyword"
					class="input-base"
				/>
			</div>

			<!-- Filter & sort -->
			<BrowsePopover bind:open={filterOpen}>
				{#snippet trigger({ toggle, open: isOpen })}
					<button
						type="button"
						class="brw-btn"
						class:is-active={isOpen || hidden.length > 0}
						onclick={toggle}
						aria-haspopup="true"
						aria-expanded={isOpen}
						aria-label="Filter and sort"
						title="Filter & sort"
					>
						<Icon name="filter" class="w-4 h-4" />
						{#if hidden.length > 0}
							<span class="brw-btn-badge">{hidden.length}</span>
						{/if}
					</button>
				{/snippet}

				<div class="brw-sec">
					<div class="brw-sec-head"><span class="brw-sec-title">Sort by</span></div>
					<div class="brw-opts" role="radiogroup" aria-label="Sort lorebooks by">
						{#each LOREBOOK_SORT_OPTIONS as option (option.id)}
							<button
								type="button"
								role="radio"
								aria-checked={lorebookViewPrefs.order === option.id}
								class="brw-opt"
								class:is-active={lorebookViewPrefs.order === option.id}
								onclick={() => {
									lorebookViewPrefs.setOrder(option.id);
									resetPage();
								}}
							>
								{option.label}
							</button>
						{/each}
					</div>
				</div>

				<div class="brw-sec">
					<div class="brw-sec-head"><span class="brw-sec-title">Show</span></div>
					<!-- Independent switches rather than one choice: what a reader wants left is any
					     of the three, and a single "globals only" could not say the other two. -->
					<div
						class="brw-opts brw-opts--3"
						role="group"
						aria-label="Filter by how a book reaches a chat"
					>
						{#each LINK_STATES as state (state.id)}
							<button
								type="button"
								class="brw-opt"
								class:is-active={!hidden.includes(state.id)}
								aria-pressed={!hidden.includes(state.id)}
								onclick={() => toggleLinkState(state.id)}
							>
								{state.label}
							</button>
						{/each}
					</div>
				</div>
			</BrowsePopover>

			<!-- View options, its own disclosure and not the funnel's: one popover narrows the
			     list, the other only changes how what is left is drawn. -->
			<BrowsePopover bind:open={viewOpen}>
				{#snippet trigger({ toggle, open: isOpen })}
					<button
						type="button"
						class="brw-btn"
						class:is-active={isOpen}
						onclick={toggle}
						aria-haspopup="true"
						aria-expanded={isOpen}
						aria-label="View options"
						title="View options"
					>
						<Icon name="sliders" class="w-4 h-4" />
					</button>
				{/snippet}

				<div class="brw-sec">
					<div class="brw-sec-head"><span class="brw-sec-title">Layout</span></div>
					<div class="brw-opts brw-opts--3" role="group" aria-label="View mode">
						<button
							type="button"
							class="brw-opt"
							class:is-active={lorebookViewPrefs.viewMode === 'grid'}
							onclick={() => lorebookViewPrefs.setViewMode('grid')}
							aria-pressed={lorebookViewPrefs.viewMode === 'grid'}
						>
							<Icon name="grid" class="w-3.5 h-3.5" />
							Grid
						</button>
						<button
							type="button"
							class="brw-opt"
							class:is-active={lorebookViewPrefs.viewMode === 'gallery'}
							onclick={() => lorebookViewPrefs.setViewMode('gallery')}
							aria-pressed={lorebookViewPrefs.viewMode === 'gallery'}
						>
							<Icon name="gallery" class="w-3.5 h-3.5" />
							Gallery
						</button>
						<button
							type="button"
							class="brw-opt"
							class:is-active={lorebookViewPrefs.viewMode === 'list'}
							onclick={() => lorebookViewPrefs.setViewMode('list')}
							aria-pressed={lorebookViewPrefs.viewMode === 'list'}
						>
							<Icon name="list" class="w-3.5 h-3.5" />
							List
						</button>
					</div>
				</div>

				{#if lorebookViewPrefs.viewMode === 'grid'}
					<div class="brw-sec">
						<div class="brw-sec-head"><span class="brw-sec-title">Card size</span></div>
						<div class="flex items-center gap-2.5">
							<Icon name="image" class="w-4 h-4 text-text-muted shrink-0" />
							<input
								type="range"
								min="1"
								max="5"
								value={lorebookViewPrefs.cardSize}
								oninput={(e) =>
									lorebookViewPrefs.setCardSize(
										parseInt((e.target as HTMLInputElement).value, 10)
									)}
								use:rangeReset={{
									defaultValue: LOREBOOK_VIEW_DEFAULTS.cardSize,
									apply: (v) => lorebookViewPrefs.setCardSize(v)
								}}
								class="brw-range"
								aria-label="Card size"
							/>
						</div>
					</div>
				{/if}

				<div class="brw-sec">
					<div class="brw-sec-head"><span class="brw-sec-title">Per page</span></div>
					<div class="brw-opts brw-opts--3">
						{#each PER_PAGE_OPTIONS as count (count)}
							<button
								type="button"
								class="brw-opt"
								class:is-active={lorebookViewPrefs.perPage === count}
								onclick={() => {
									lorebookViewPrefs.setPerPage(count);
									resetPage();
								}}
							>
								{count}
							</button>
						{/each}
					</div>
				</div>
			</BrowsePopover>

			<!-- More: import + bulk selection -->
			<BrowsePopover bind:open={moreOpen} variant="menu">
				{#snippet trigger({ toggle, open: isOpen })}
					<button
						type="button"
						class="brw-btn"
						class:is-active={isOpen}
						onclick={toggle}
						aria-haspopup="menu"
						aria-expanded={isOpen}
						aria-label="More actions"
						title="More actions"
					>
						<Icon name="dotsVertical" class="w-4 h-4" />
					</button>
				{/snippet}

				<button
					type="button"
					role="menuitem"
					class="brw-menu-item"
					onclick={() => {
						moreOpen = false;
						fileInput?.click();
					}}
				>
					<Icon name="upload" class="w-3.5 h-3.5" />
					Import World Info…
				</button>
				<button
					type="button"
					role="menuitem"
					class="brw-menu-item"
					onclick={() => {
						moreOpen = false;
						toggleSelectionMode();
					}}
				>
					<Icon name="check" class="w-3.5 h-3.5" />
					{selectionMode ? 'Exit selection' : 'Select multiple'}
				</button>
			</BrowsePopover>

			<button type="button" class="brw-new" onclick={newBook} title="New lorebook">
				<Icon name="plus" class="w-4 h-4" />
				<span class="brw-new-label">New</span>
			</button>
		</div>
	{/if}

	{#if !defaultsOpen}
		<!-- The archive's own settings row, drawn with no books too: how books will behave is
		     decidable before there is a book to try it on. -->
		<button
			type="button"
			class="brw-bar strip-head lbd-row"
			bind:this={defaultsRow}
			onclick={() => void setDefaults(true)}
		>
			<Icon name="settings" class="w-4 h-4 text-text-muted flex-shrink-0" />
			<span class="strip-title">Global Settings</span>
			<span class="strip-sum">
				{#each defaults as part (part.text)}
					<span class="strip-part">{part.text}</span>
				{/each}
			</span>
			<span class="strip-chev">
				<Icon name="chevronRight" class="w-4 h-4" />
			</span>
		</button>
	{/if}

	{#if !defaultsOpen && books.length > 0}
		<!-- Active filters: a summary line that only exists while something narrows the list -->
		{#if filtersActive}
			<div class="brw-chips">
				<span class="brw-chips-count"><b>{visible.length}</b> of {books.length}</span>
				{#each LINK_STATES as state (state.id)}
					{#if hidden.includes(state.id)}
						<span class="brw-chip">
							No {state.noun}
							<button
								type="button"
								class="brw-chip-x"
								onclick={() => toggleLinkState(state.id)}
								aria-label="Show {state.noun} again"
							>
								<Icon name="close" class="w-2.5 h-2.5" />
							</button>
						</span>
					{/if}
				{/each}
				<button
					type="button"
					class="brw-chips-clear"
					onclick={() => {
						search = '';
						hidden = [];
						resetPage();
					}}
				>
					Clear
				</button>
			</div>
		{/if}

		<!-- Bulk selection bar: exit + count + scope links on the left, two actions on the
		     right. Labels appear when the container has room; Esc leaves the mode. -->
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
				<span class="brw-bulk-count"><b>{selected.length}</b> selected</span>
				<button
					type="button"
					class="brw-bulk-link"
					onclick={() => (selectedIds = new Set([...selectedIds, ...visible.map((b) => b.id)]))}
					disabled={allVisibleSelected}
				>
					All ({visible.length})
				</button>
				<button
					type="button"
					class="brw-bulk-link"
					onclick={() => (selectedIds = new Set())}
					disabled={selected.length === 0}
				>
					None
				</button>
				<div class="brw-bulk-spacer"></div>

				<button
					type="button"
					class="brw-bulk-btn"
					onclick={exportSelection}
					disabled={selected.length === 0}
					title="Export as SillyTavern World Info"
				>
					<Icon name="download" class="w-3.5 h-3.5" />
					<span class="brw-bulk-label">Export</span>
				</button>
				<button
					type="button"
					class="brw-bulk-btn brw-bulk-btn--danger"
					onclick={() => (bulkDeleteOpen = true)}
					disabled={selected.length === 0}
				>
					<Icon name="trash" class="w-3.5 h-3.5" />
					<span class="brw-bulk-label">Delete</span>
				</button>
			</div>
		{/if}
	{/if}

	<div
		role="region"
		aria-label={defaultsOpen ? 'Global lorebook settings' : 'Lorebooks'}
		class="brw-content"
		class:is-flush={defaultsOpen}
	>
		{#if defaultsOpen}
			<!-- No book, so the rows write to the layer every book falls back to. -->
			<LorebookActivationPanel />
		{:else if lorebookStore.loading && books.length === 0}
			<div class="flex items-center justify-center h-full">
				<div class="flex flex-col items-center gap-3 text-text-muted">
					<Spinner size="lg" />
					<span class="text-sm font-ui">Loading lorebooks…</span>
				</div>
			</div>
		{:else if books.length === 0}
			<div class="grid place-items-center h-full">
				<EmptyState icon="bookOpen" title="No lorebooks yet">
					A lorebook holds world facts that are woven into the story when their keywords come up.
					{#snippet actions()}
						<Button variant="primary" size="sm" onclick={newBook}>
							<Icon name="plus" class="w-4 h-4" />
							New lorebook
						</Button>
						<Button variant="secondary" size="sm" onclick={() => fileInput?.click()}>
							<Icon name="upload" class="w-4 h-4" />
							Import
						</Button>
					{/snippet}
				</EmptyState>
			</div>
		{:else if visible.length === 0}
			<!-- Names the narrowing that emptied the shelf and offers a way out of each one that
			     is on: a list the funnel emptied must not send the reader to clear the search. -->
			<div class="grid place-items-center h-full">
				<EmptyState icon="search" size="sm">
					{query ? `Nothing matches “${search.trim()}”.` : 'Every lorebook here is hidden.'}
					{#snippet actions()}
						{#if query}
							<Button
								variant="ghost"
								size="sm"
								onclick={() => {
									search = '';
									resetPage();
								}}
							>
								Clear search
							</Button>
						{/if}
						{#if hidden.length > 0}
							<Button
								variant="ghost"
								size="sm"
								onclick={() => {
									hidden = [];
									resetPage();
								}}
							>
								Show all
							</Button>
						{/if}
					{/snippet}
				</EmptyState>
			</div>
		{:else if lorebookViewPrefs.viewMode === 'grid'}
			<div
				class="brw-grid"
				style="grid-template-columns: repeat(auto-fill, minmax({cardMinWidth}px, 1fr));"
			>
				{#each paged as book (book.id)}
					<LorebookGridCard
						{book}
						{selectionMode}
						selected={selectedIds.has(book.id)}
						onToggleSelect={toggleSelect}
						onOpen={open}
						onExport={exportOne}
						onDelete={(id) => (deleteId = id)}
					/>
				{/each}
			</div>
			{@render pager()}
		{:else if lorebookViewPrefs.viewMode === 'gallery'}
			<div class="brw-grid" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));">
				{#each paged as book (book.id)}
					<LorebookGalleryCard
						{book}
						links={links.get(book.id) ?? 0}
						{selectionMode}
						selected={selectedIds.has(book.id)}
						onToggleSelect={toggleSelect}
						onOpen={open}
						onExport={exportOne}
						onDelete={(id) => (deleteId = id)}
					/>
				{/each}
			</div>
			{@render pager()}
		{:else}
			<div class="flex flex-col divide-y divide-border-subtle">
				{#each paged as book (book.id)}
					<LorebookShelfRow
						{book}
						links={links.get(book.id) ?? 0}
						{selectionMode}
						selected={selectedIds.has(book.id)}
						onToggleSelect={toggleSelect}
						onOpen={open}
						onExport={exportOne}
						onDelete={(id) => (deleteId = id)}
					/>
				{/each}
			</div>
			{@render pager()}
		{/if}
	</div>
</div>

<!-- Drawn under all three layouts, so the way to page a shelf is in the same place whichever
     shape it is wearing. -->
{#snippet pager()}
	{#if totalPages > 1}
		<div class="brw-pager">
			<span class="brw-pager-count">
				Showing {(safePage - 1) * lorebookViewPrefs.perPage + 1}-{Math.min(
					safePage * lorebookViewPrefs.perPage,
					visible.length
				)} of {visible.length}
			</span>
			<LibraryPager page={safePage} {totalPages} onPage={(p) => (currentPage = p)} />
		</div>
	{/if}
{/snippet}

<input
	bind:this={fileInput}
	type="file"
	accept=".json,application/json"
	multiple
	class="hidden"
	onchange={onFiles}
/>

<!-- Open on the resolved book, not on the id: one deleted on another device while the
     question stands would otherwise leave a dialog with a blank message in it. -->
<ConfirmDialog
	open={deleteTarget !== null}
	title="Delete lorebook"
	message={deleteMessage}
	confirmLabel="Delete"
	variant="danger"
	destructive
	holdMs={holdMsForBlast(deleteTarget?.entries.length ?? 0)}
	onConfirm={confirmDelete}
	onCancel={() => (deleteId = null)}
/>

<ConfirmDialog
	open={bulkDeleteOpen}
	title="Delete {selected.length} lorebook{selected.length === 1 ? '' : 's'}"
	message={bulkDeleteMessage}
	confirmLabel="Delete {selected.length}"
	variant="danger"
	destructive
	holdMs={holdMsForBlast(bulkBlast)}
	onConfirm={confirmBulkDelete}
	onCancel={() => (bulkDeleteOpen = false)}
/>

<style>
	/* The settings row wears the toolbar's own bar so it lines up with the row above it,
	   and the strip vocabulary inside so it reads like the book editor's own strips. */
	.lbd-row:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
	}

	/* The page's name, in the row that holds the way back to the shelf. */
	.lbd-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	/* The settings panel brings its own padding, so the scroller drops the shelf's. */
	.brw-content.is-flush {
		padding: 0;
	}
</style>
