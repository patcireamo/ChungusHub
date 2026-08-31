<script lang="ts">
	/**
	 * Lorebooks half of the merged Library (see library/LibraryView): the shelf. Speaks the
	 * same toolbar/row language as the Characters and Personas tabs, and offers exactly what
	 * a shelf of books has a subject for: no layout switch and no card size (a book has no
	 * picture to size), no pager (a shelf is text rows, and paging one is a control that
	 * costs more than it saves).
	 *
	 * A press opens the book's editor over the chat (uiStore.lorebookEditorId), the same slot
	 * and the same reason as the character editor: a book is a document, and the dock is a shelf.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { holdMsForBlast } from '$lib/components/ui/HoldToConfirmButton.svelte';
	import BrowsePopover from '$lib/components/library/BrowsePopover.svelte';
	import { foldForSearch } from '$lib/components/library/browse';
	import LorebookShelfRow from './LorebookShelfRow.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { downloadLorebook, downloadLorebooks, readLorebookFile } from '$lib/lorebook/io';
	import { lorebookDeleteMessage, sortLorebooks } from '$lib/lorebook/types';
	import { lorebookSortPref, LOREBOOK_SORT_OPTIONS } from '$lib/stores/lorebookSort.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';

	let books = $derived(lorebookStore.books);

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
			uiStore.lorebookEditorId = pending;
			uiStore.pendingLorebookId = null;
		} else if (books.length) {
			uiStore.pendingLorebookId = null;
		}
	});

	// ===== search, filter & sort =====

	let search = $state('');
	let filterOpen = $state(false);
	let moreOpen = $state(false);

	/** The two states a book can be in on this shelf, held out of the list independently:
	 *  a reader hunting dead weight wants only the unlinked, and one tidying the working
	 *  shelf wants only the linked. */
	const LINK_STATES = [
		{ id: 'linked', label: 'Linked' },
		{ id: 'unlinked', label: 'Unlinked' }
	] as const;
	type LinkState = (typeof LINK_STATES)[number]['id'];

	let hidden = $state<LinkState[]>([]);

	function toggleLinkState(state: LinkState) {
		hidden = hidden.includes(state) ? hidden.filter((s) => s !== state) : [...hidden, state];
	}

	// The shelf's order is the app-wide lorebook display preference, shared with the editor's
	// switcher and the character editor's link picker: three views of one shelf.
	let ordered = $derived(sortLorebooks(books, lorebookSortPref.order));

	/**
	 * What the shelf's search reads: the book's name plus its INDEX, its entry titles and
	 * keywords. Not entry content, which is what the open book's own search is for: a shelf
	 * answers "which book holds the Charizard entry", and a query matching prose would put
	 * half the archive on screen.
	 *
	 * Folded once per book and kept until that book is edited. Folding every title and key on
	 * every keystroke is a pass over the whole archive per character typed.
	 */
	const index = new Map<string, { stamp: number; text: string }>();

	function searchTextOf(book: (typeof books)[number]): string {
		const cached = index.get(book.id);
		if (cached && cached.stamp === book.updatedAt) return cached.text;
		// The fallback name is searchable too, or the one word an unnamed book is listed
		// under is the one word that cannot find it here while it finds it in the switcher.
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
			const state: LinkState = (links.get(book.id) ?? 0) > 0 ? 'linked' : 'unlinked';
			if (hidden.includes(state)) return false;
			return !query || searchTextOf(book).includes(query);
		})
	);

	// The badge counts what is NARROWING the list and never the order, the same line the
	// Library's own funnel draws.
	let filtersActive = $derived(hidden.length > 0 || query.length > 0);

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

	// Esc leaves selection mode, but only when nothing above it (a popover or a confirm
	// dialog, which consume Esc themselves) is open.
	$effect(() => {
		if (!selectionMode) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (filterOpen || moreOpen || bulkDeleteOpen || deleteId) return;
			// Consume the press so the workspace's global Esc doesn't also close the Library.
			e.preventDefault();
			e.stopPropagation();
			toggleSelectionMode();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});

	// ===== book actions =====

	let fileInput = $state<HTMLInputElement | null>(null);

	function open(id: string) {
		uiStore.lorebookEditorId = id;
	}

	/** A fresh book opens straight into its editor, which is where it is named. */
	async function newBook() {
		const book = await lorebookStore.createBook('');
		open(book.id);
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
		// One book opens, so a reader never has to hunt a long shelf for what just arrived.
		// A batch does not: thirty editors would be thirty answers to the same question.
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
	{#if books.length > 0}
		<!-- Toolbar: search front and center, two quiet disclosures, one primary action.
		     The book count lives in the search placeholder. -->
		<div class="brw-bar">
			<div class="brw-search">
				<Icon name="search" class="brw-search-icon w-3.5 h-3.5" />
				<input
					type="text"
					bind:value={search}
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
								aria-checked={lorebookSortPref.order === option.id}
								class="brw-opt"
								class:is-active={lorebookSortPref.order === option.id}
								onclick={() => lorebookSortPref.set(option.id)}
							>
								{option.label}
							</button>
						{/each}
					</div>
				</div>

				<div class="brw-sec">
					<div class="brw-sec-head"><span class="brw-sec-title">Show</span></div>
					<!-- Independent switches rather than one choice: what a reader wants left is
					     either half, and a single "unlinked only" could not say the other one. -->
					<div class="brw-opts" role="group" aria-label="Filter by whether a book is in use">
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

		<!-- Active filters: a summary line that only exists while something narrows the list -->
		{#if filtersActive}
			<div class="brw-chips">
				<span class="brw-chips-count"><b>{visible.length}</b> of {books.length}</span>
				{#each LINK_STATES as state (state.id)}
					{#if hidden.includes(state.id)}
						<span class="brw-chip">
							No {state.label.toLowerCase()}
							<button
								type="button"
								class="brw-chip-x"
								onclick={() => toggleLinkState(state.id)}
								aria-label="Show {state.label.toLowerCase()} lorebooks again"
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

	<div role="region" aria-label="Lorebooks" class="brw-content">
		{#if lorebookStore.loading && books.length === 0}
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
			<div class="grid place-items-center h-full">
				<EmptyState icon="search" size="sm" title="No matches">
					No lorebooks match your current filters.
					{#snippet actions()}
						<Button
							variant="ghost"
							size="sm"
							onclick={() => {
								search = '';
								hidden = [];
							}}
						>
							Clear all filters
						</Button>
					{/snippet}
				</EmptyState>
			</div>
		{:else}
			<div class="flex flex-col divide-y divide-border-subtle">
				{#each visible as book (book.id)}
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
		{/if}
	</div>
</div>

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
