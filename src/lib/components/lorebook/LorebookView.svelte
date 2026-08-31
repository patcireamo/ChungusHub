<script lang="ts">
	/**
	 * One book, open. The editor half of the Lorebooks shelf (lorebook/LorebooksView): it
	 * renders wide and centered over the chat while the shelf keeps the Library dock, the
	 * same split the character editor and its browse list use.
	 *
	 * Which book is open belongs to `uiStore.lorebookEditorId`, never to this component, so
	 * a deep link and a shelf press are the same act. Picking another book is the shelf's
	 * job alone, exactly as it is for a character: the header states what is open.
	 */
	import { tick } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { holdMsForBlast } from '$lib/components/ui/HoldToConfirmButton.svelte';
	import BrowsePopover from '$lib/components/library/BrowsePopover.svelte';
	import LorebookEntryRow from './LorebookEntryRow.svelte';
	import LorebookActivationPanel from './LorebookActivationPanel.svelte';
	import LorebookScanTester from './LorebookScanTester.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import { downloadLorebook } from '$lib/lorebook/io';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { workspaceFocus } from '$lib/stores/workspaceFocus.svelte';
	import { countTokens } from '$lib/tokenizer';
	import {
		lorebookDeleteMessage,
		natureOf,
		partitionEntries,
		resolveBookActivation,
		sortEntries,
		type LorebookEntry
	} from '$lib/lorebook/types';
	import {
		lorebookEntryPrefs,
		LOREBOOK_ENTRY_NATURE_OPTIONS,
		LOREBOOK_ENTRY_SORT_OPTIONS
	} from '$lib/stores/lorebookEntryPrefs.svelte';

	interface Props {
		/** The book being edited. Owned by uiStore, so the shelf alone reassigns it. */
		bookId: string;
		onClose: () => void;
	}

	let { bookId, onClose }: Props = $props();

	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

	let books = $derived(lorebookStore.books);
	let selectedBook = $derived(books.find((b) => b.id === bookId) ?? null);

	// One column, zero navigation: entries unfold in place, any number at once. Nothing on
	// this page replaces anything else: reaching a thing never means closing another.
	let expandedIds = $state<Set<string>>(new Set());

	function toggleExpand(id: string) {
		const next = new Set(expandedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedIds = next;
	}

	// ===== the book's own title =====

	/** What the open book is made of, empty groups left out: a zero is not a fact worth a slot. */
	let composition = $derived.by(() => {
		if (!selectedBook) return [] as { kind: string; count: number }[];
		const parts = partitionEntries(selectedBook.entries);
		return [
			{ kind: 'always', count: parts.alwaysActive.length },
			{ kind: 'keyword', count: parts.keyword.length },
			{ kind: 'off', count: parts.disabled.length }
		].filter((part) => part.count > 0);
	});

	/** Prompt weight if every enabled entry fired at once: an honest upper bound. */
	let tokens = $derived(
		selectedBook
			? selectedBook.entries.reduce((sum, e) => (e.disable ? sum : sum + countTokens(e.content)), 0)
			: 0
	);

	/** Who carries the open book. A book nothing links to never reaches a prompt. */
	let linked = $derived(
		selectedBook
			? characterLibraryStore.entries.filter((en) =>
					en.data.lorebookIds?.includes(selectedBook.id)
				)
			: []
	);

	/** The one settings strip above the list: both layers of the activation cascade. */
	let stripOpen = $state(false);
	/** The scan tester below it: closed until the reader asks what fires. */
	let testerOpen = $state(false);

	let globals = $derived(lorebookSettingsStore.settings);
	/**
	 * The strip's collapsed line: what the open book actually runs with, not what either layer
	 * holds on its own. A part is lit where the book's value DIFFERS from the default it would
	 * otherwise take, the same reading the panel's stars give: a value typed back to the
	 * default is not a difference, however the book happens to store it.
	 */
	let summary = $derived.by(() => {
		const b = selectedBook;
		if (!b) return [] as { text: string; set: boolean }[];
		const a = resolveBookActivation(b, globals);
		const out = [
			{ text: `scan ${a.scanDepth === 0 ? 'all' : a.scanDepth}`, set: a.scanDepth !== globals.scanDepth },
			{
				text: `recursion ${a.recursiveScanning ? 'on' : 'off'}`,
				set: a.recursiveScanning !== globals.recursiveScanning
			}
		];
		if (a.recursiveScanning) {
			// While books recurse together there is one shared loop, so the cap that runs is the
			// global one; printing the book's own here would name a number the scan never uses.
			const passes = globals.crossBookRecursion ? globals.maxRecursionSteps : a.maxRecursionSteps;
			out.push({
				text: passes > 0 ? `≤${passes} passes` : '∞ passes',
				set: !globals.crossBookRecursion && a.maxRecursionSteps !== globals.maxRecursionSteps
			});
			if (globals.crossBookRecursion) out.push({ text: 'books together', set: false });
		}
		out.push({
			text: `case ${a.caseSensitive ? 'on' : 'off'}`,
			set: a.caseSensitive !== globals.caseSensitive
		});
		out.push({
			text: `whole words ${a.matchWholeWords ? 'on' : 'off'}`,
			set: a.matchWholeWords !== globals.matchWholeWords
		});
		out.push({
			text: `budget ${globals.budgetPercent > 0 ? `${globals.budgetPercent}%` : 'off'}`,
			set: false
		});
		return out;
	});

	let searchEl = $state<HTMLInputElement | null>(null);
	let nameEl = $state<HTMLInputElement | null>(null);

	// ===== search / filter / sort =====

	let search = $state('');
	let filterOpen = $state(false);

	let q = $derived(search.trim().toLowerCase());
	/** The natures held out of the list. The order is not a filter and never counts as one,
	 *  which is the same line the Library's own funnel badge draws. */
	let hidden = $derived(lorebookEntryPrefs.hidden);

	function matches(e: LorebookEntry): boolean {
		if (hidden.includes(natureOf(e))) return false;
		if (!q) return true;
		return (
			e.comment.toLowerCase().includes(q) ||
			e.content.toLowerCase().includes(q) ||
			e.key.some((k) => k.toLowerCase().includes(q)) ||
			e.keysecondary.some((k) => k.toLowerCase().includes(q))
		);
	}

	let entries = $derived(
		selectedBook
			? sortEntries(selectedBook.entries.filter(matches), lorebookEntryPrefs.sort)
			: []
	);
	let total = $derived(selectedBook?.entries.length ?? 0);

	/** Search hits in the other books, capped so the section stays a hint. */
	let elsewhere = $derived.by(() => {
		if (!q) return [] as { bookId: string; bookName: string; entry: LorebookEntry }[];
		const out: { bookId: string; bookName: string; entry: LorebookEntry }[] = [];
		for (const b of books) {
			if (b.id === bookId) continue;
			for (const e of b.entries) {
				if (matches(e)) {
					out.push({ bookId: b.id, bookName: b.name || 'Untitled lorebook', entry: e });
					if (out.length >= 8) return out;
				}
			}
		}
		return out;
	});

	// ===== bulk selection =====

	let selectMode = $state(false);
	let selectedIds = $state<Set<string>>(new Set());
	let bulkDeleteOpen = $state(false);

	// Entering/leaving select mode resets the set; entering also folds every open row so
	// the list reads as a flat checklist.
	$effect(() => {
		if (selectMode) expandedIds = new Set();
		selectedIds = new Set();
	});

	function toggleSelect(id: string) {
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	function bulkSet(patch: { disable: boolean }) {
		if (!selectedBook) return;
		for (const id of selectedIds) lorebookStore.updateEntry(selectedBook.id, id, patch);
	}

	function bulkDelete() {
		if (!selectedBook) return;
		for (const id of selectedIds) lorebookStore.removeEntry(selectedBook.id, id);
		bulkDeleteOpen = false;
		selectMode = false;
	}

	// ===== housekeeping effects =====

	// A book that goes while it is open (deleted on another device, or from the shelf under
	// this editor) leaves nothing to edit, so the editor stands down rather than rendering
	// an empty document over the chat.
	$effect(() => {
		if (!selectedBook && !lorebookStore.loading) onClose();
	});

	// Mirror the open book into the workspace focus so the assistant auto-attaches "the
	// lorebook you're editing", and release it on unmount: this view exists exactly while
	// the editor is open, so unmounting IS the user navigating away, and a focus left
	// standing would keep the assistant pointing at a book they closed.
	$effect(() => {
		workspaceFocus.setLorebook(bookId);
	});
	$effect(() => () => workspaceFocus.setLorebook(null));
	// Reset per-book transient UI on book switch. Expanded ids are keyed by entry id, so the
	// other book's rows simply don't render them. A cross-book jump survives the swap.
	$effect(() => {
		bookId;
		search = '';
		selectMode = false;
	});
	// A book with no name is one still waiting to be named, so the caret lands there. Not on
	// a touch screen, where a caret answers by putting the keyboard over the page that was
	// asked for.
	// The book is read inside the tick, not in the effect body: every keystroke anywhere in
	// it reassigns the store's list, and an effect tracking that would yank the caret back
	// to the title on each one.
	$effect(() => {
		const id = bookId;
		if (coarse) return;
		void tick().then(() => {
			if (!lorebookStore.getBook(id)?.name) nameEl?.focus();
		});
	});
	// Commit pending debounced writes when the view unmounts.
	$effect(() => () => void lorebookStore.flush());

	// ===== the actions menu (everything you can do TO the book the header names) =====

	let actionsOpen = $state(false);
	let bookDeleteOpen = $state(false);

	/** The menu is a popover over the header, so it leaves before what it opened arrives. */
	function closeActionsAnd(run: () => void) {
		actionsOpen = false;
		run();
	}

	function exportBook() {
		if (selectedBook) downloadLorebook(selectedBook);
	}

	let bookDeleteMessage = $derived(
		selectedBook ? lorebookDeleteMessage(selectedBook, linked.length) : ''
	);

	async function deleteBook() {
		if (!selectedBook) return;
		bookDeleteOpen = false;
		onClose();
		await lorebookStore.deleteBook(selectedBook.id);
	}

	// ===== entry actions =====

	async function revealEntry(entryId: string) {
		expandedIds = new Set([...expandedIds, entryId]);
		await tick();
		requestAnimationFrame(() =>
			document
				.getElementById('lb-row-' + entryId)
				?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' })
		);
	}

	function addEntry() {
		if (!selectedBook) return;
		const entry = lorebookStore.addEntry(selectedBook.id);
		if (!entry) return;
		selectMode = false;
		void revealEntry(entry.id);
	}

	let entryDeleteId = $state<string | null>(null);
	let entryToDelete = $derived(
		entryDeleteId ? (selectedBook?.entries.find((e) => e.id === entryDeleteId) ?? null) : null
	);

	function deleteEntry() {
		if (selectedBook && entryDeleteId) lorebookStore.removeEntry(selectedBook.id, entryDeleteId);
		entryDeleteId = null;
	}

	function duplicateEntry(entryId: string) {
		if (!selectedBook) return;
		const copy = lorebookStore.duplicateEntry(selectedBook.id, entryId);
		if (copy) void revealEntry(copy.id);
	}

	async function openInBook(id: string, entryId: string) {
		uiStore.lorebookEditorId = id;
		await revealEntry(entryId);
	}

	// ===== keyboard =====

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			void lorebookStore.flush();
			return;
		}
		// A modal dialog owns the keyboard: Dialog closes itself on the same window
		// Escape event without stopping propagation, so stand down while one is open.
		if (document.querySelector('.dialog-portal')) return;
		// Ctrl+F, not Ctrl+K: the workspace owns Ctrl+K (Chats) and this view
		// must not shadow it.
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
			e.preventDefault();
			searchEl?.focus();
			return;
		}
		if (e.key === 'Escape') {
			// Open popovers consume Escape themselves (stopPropagation) before this
			// handler sees it, so no popover guard is needed here.
			if (selectMode) selectMode = false;
			else if (expandedIds.size > 0) expandedIds = new Set();
			// The editor is the top-most surface, so the last rung closes IT and leaves the
			// shelf standing, rather than falling through to the workspace and taking the
			// whole Library with it.
			else onClose();
			e.preventDefault();
			return;
		}
		if (e.key === '/' && !isTyping(e.target)) {
			e.preventDefault();
			searchEl?.focus();
		}
	}

	function isTyping(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		return (
			!!el &&
			(el.tagName === 'INPUT' ||
				el.tagName === 'TEXTAREA' ||
				el.tagName === 'SELECT' ||
				el.isContentEditable)
		);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="brw">
	{#if selectedBook}
		<!-- The centered editors' shared bar (app.css, .editor-header): the open book is the
		     subject, what acts on it trails right, and the way out ends the row. -->
		<header class="editor-header">
			<div class="editor-header-identity">
				<h2 class="editor-header-name" class:is-untitled={!selectedBook.name}>
					{selectedBook.name || 'Untitled lorebook'}
				</h2>
			</div>
			<div class="editor-header-actions">
				<div class="lb-acts">
					<BrowsePopover bind:open={actionsOpen} variant="menu">
						{#snippet trigger({ toggle, open })}
							<button
								type="button"
								class="editor-header-btn"
								onclick={toggle}
								aria-haspopup="menu"
								aria-expanded={open}
								aria-label="Lorebook actions"
								title="Lorebook actions"
							>
								<Icon name="dotsVertical" class="w-4 h-4" strokeWidth={1.5} />
							</button>
						{/snippet}
						<button
							type="button"
							role="menuitem"
							class="brw-menu-item"
							onclick={() => closeActionsAnd(exportBook)}
						>
							<Icon name="download" class="w-4 h-4" strokeWidth={1.5} />
							<span>Export World Info</span>
						</button>
						<button
							type="button"
							role="menuitem"
							class="brw-menu-item lb-acts-danger"
							onclick={() => closeActionsAnd(() => (bookDeleteOpen = true))}
						>
							<Icon name="trash" class="w-4 h-4" strokeWidth={1.5} />
							<span>Delete lorebook</span>
						</button>
					</BrowsePopover>
				</div>

				<span class="editor-header-divider"></span>

				<button
					type="button"
					class="editor-header-btn"
					onclick={onClose}
					aria-label="Close lorebook"
					title="Close (Esc)"
				>
					<Icon name="close" class="w-[1.15rem] h-[1.15rem]" strokeWidth={1.5} />
				</button>
			</div>
		</header>
		<!-- Everything below lives in ONE scroll: the settings strip, controls, entries. -->
		<div class="lb-page panel-scroll">
			<div class="lb-page-inner">
				<!-- The book's identity: named here, then what it is made of and who carries it. -->
				<div class="lb-title">
					<input
						bind:this={nameEl}
						class="lb-title-name"
						value={selectedBook.name}
						oninput={(e) =>
							lorebookStore.updateBookMeta(selectedBook.id, {
								name: (e.target as HTMLInputElement).value
							})}
						placeholder="Name this book…"
						aria-label="Lorebook name"
					/>
					<!-- An empty book says so in the empty state below; twice would be noise. -->
					{#if composition.length > 0}
						<p class="lb-title-meta">
							{#each composition as part (part.kind)}
								<span class="lb-title-stat">
									<span class="lb-dot lb-dot-{part.kind}"></span>{part.count}
									{part.kind}
								</span>
							{/each}
							<span class="lb-title-tokens">~{tokens} tokens</span>
						</p>
					{/if}
					<div class="lb-bound">
						<span class="lb-bound-cap section-label">Bound to</span>
						{#if linked.length === 0}
							<span class="lb-bound-none">Link it from a character or persona</span>
						{:else}
							<div class="lb-chips">
								{#each linked as en (en.id)}
									<button
										type="button"
										class="lb-chip"
										onclick={() =>
											uiStore.openLibraryEntry(en.id, en.type, () => lorebookStore.flush())}
										title="Open {en.type} editor"
									>
										<Icon
											name={en.type === 'persona' ? 'user' : 'users'}
											class="w-3 h-3 flex-shrink-0"
										/>
										{en.identity.name || 'Unnamed'}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				</div>

				<section class="lb-strip">
					<button
						type="button"
						class="lb-strip-head"
						onclick={() => (stripOpen = !stripOpen)}
						aria-expanded={stripOpen}
					>
						<Icon name="settings" class="w-4 h-4 text-text-muted flex-shrink-0" />
						<span class="lb-strip-title">Activation</span>
						<span class="lb-strip-sum">
							{#each summary as part (part.text)}
								<span class="lb-sum-part" class:is-set={part.set}>{part.text}</span>
							{/each}
						</span>
						<span class="lb-strip-chev" class:is-open={stripOpen}>
							<Icon name="chevronDown" class="w-4 h-4" />
						</span>
					</button>
					{#if stripOpen}
						<LorebookActivationPanel book={selectedBook} />
					{/if}
				</section>

				<!-- Same shape as Activation, and deliberately under it: that strip states the
				     rules this one lets you try. Collapsed until asked for, since a book is read
				     far more often than it is debugged. -->
				<section class="lb-strip">
					<button
						type="button"
						class="lb-strip-head"
						onclick={() => (testerOpen = !testerOpen)}
						aria-expanded={testerOpen}
					>
						<Icon name="search" class="w-4 h-4 text-text-muted flex-shrink-0" />
						<span class="lb-strip-title">Test scan</span>
						<span class="lb-strip-sum">
							<span class="lb-sum-part">see what this book fires on</span>
						</span>
						<span class="lb-strip-chev" class:is-open={testerOpen}>
							<Icon name="chevronDown" class="w-4 h-4" />
						</span>
					</button>
					{#if testerOpen}
						<LorebookScanTester book={selectedBook} />
					{/if}
				</section>

				{#if total === 0}
					<div class="py-14">
						<EmptyState icon="feather" size="sm" title="No entries yet">
							Entries are facts injected into the story when their keywords come up, or on
							every turn.
							{#snippet actions()}
								<Button variant="ghost" size="sm" onclick={addEntry}>
									<Icon name="plus" class="w-3.5 h-3.5" />
									Add the first entry
								</Button>
							{/snippet}
						</EmptyState>
					</div>
				{:else}
					<div class="lb-controls">
						<div class="brw-search">
							<Icon name="search" class="brw-search-icon w-3.5 h-3.5" />
							<input
								bind:this={searchEl}
								bind:value={search}
								type="text"
								placeholder="Search {total} {total === 1 ? 'entry' : 'entries'}…"
								aria-label="Search entries"
								class="input-base"
							/>
						</div>

						<div class="lb-controls-row">
							<BrowsePopover bind:open={filterOpen}>
								{#snippet trigger({ toggle, open })}
									<button
										type="button"
										class="brw-btn"
										class:is-active={open || hidden.length > 0}
										onclick={toggle}
										aria-haspopup="true"
										aria-expanded={open}
										aria-label="Filter and sort entries"
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
									<!-- One list of finished answers, not a field plus a direction: "Z → A" is the
									     whole choice, so nothing has to be combined in the reader's head. -->
									<div class="brw-opts" role="radiogroup" aria-label="Sort entries by">
										{#each LOREBOOK_ENTRY_SORT_OPTIONS as option (option.id)}
											<button
												type="button"
												role="radio"
												aria-checked={lorebookEntryPrefs.sort === option.id}
												class="brw-opt"
												class:is-active={lorebookEntryPrefs.sort === option.id}
												onclick={() => lorebookEntryPrefs.setSort(option.id)}
											>
												{option.label}
											</button>
										{/each}
									</div>
								</div>
								<div class="brw-sec">
									<div class="brw-sec-head"><span class="brw-sec-title">Show</span></div>
									<!-- The three natures wear the dot their rows wear, so the filter and the list
									     name a row the same way. Independent switches rather than one choice: a
									     reader hiding the disabled entries still wants both of the live kinds. -->
									<div class="brw-opts brw-opts--3" role="group" aria-label="Filter by entry behavior">
										{#each LOREBOOK_ENTRY_NATURE_OPTIONS as option (option.id)}
											<button
												type="button"
												class="brw-opt lb-nature"
												class:is-active={!hidden.includes(option.id)}
												aria-pressed={!hidden.includes(option.id)}
												onclick={() => lorebookEntryPrefs.toggleNature(option.id)}
											>
												<span class="lb-dot lb-dot-{option.id}"></span>{option.label}
											</button>
										{/each}
									</div>
								</div>
							</BrowsePopover>

							<button
								type="button"
								class="brw-btn"
								class:is-active={selectMode}
								onclick={() => (selectMode = !selectMode)}
								aria-pressed={selectMode}
								aria-label="Select entries"
								title="Select entries"
							>
								<Icon name="checkCircle" class="w-4 h-4" />
							</button>

							<button type="button" class="brw-new" onclick={addEntry} title="New entry">
								<Icon name="plus" class="w-4 h-4" />
								<span class="brw-new-label">New</span>
							</button>
						</div>
					</div>

					{#if selectMode}
						<div class="brw-bulk lb-bulk">
							<button
								type="button"
								class="brw-bulk-x"
								onclick={() => (selectMode = false)}
								aria-label="Exit selection"
							>
								<Icon name="close" class="w-4 h-4" />
							</button>
							<span class="brw-bulk-count"><b>{selectedIds.size}</b> selected</span>
							<button
								type="button"
								class="brw-bulk-link"
								onclick={() => (selectedIds = new Set(entries.map((e) => e.id)))}
							>
								Select all
							</button>
							<span class="brw-bulk-spacer"></span>
							<button
								type="button"
								class="brw-bulk-btn"
								disabled={selectedIds.size === 0}
								onclick={() => bulkSet({ disable: false })}
							>
								Enable
							</button>
							<button
								type="button"
								class="brw-bulk-btn"
								disabled={selectedIds.size === 0}
								onclick={() => bulkSet({ disable: true })}
							>
								Disable
							</button>
							<button
								type="button"
								class="brw-bulk-btn brw-bulk-btn--danger"
								disabled={selectedIds.size === 0}
								onclick={() => (bulkDeleteOpen = true)}
							>
								<Icon name="trash" class="w-3.5 h-3.5" />
								<span class="brw-bulk-label">Delete</span>
							</button>
						</div>
					{/if}

					{#if entries.length === 0 && elsewhere.length === 0 && (q || hidden.length > 0)}
						<div class="text-center py-12 px-6">
							<!-- Names the narrowing that actually emptied the list, and offers a way out of
							     each one that is on. A list emptied by the funnel must not read as a search
							     that missed, or the reader clears the thing that was not in the way. -->
							<p class="text-sm font-ui text-text-secondary">
								{q ? `Nothing matches “${search}”.` : 'Every entry here is hidden.'}
							</p>
							<div class="mt-2 flex items-center justify-center gap-4">
								{#if q}
									<button
										type="button"
										onclick={() => (search = '')}
										class="text-xs font-ui text-accent hover:underline"
									>
										Clear search
									</button>
								{/if}
								{#if hidden.length > 0}
									<button
										type="button"
										onclick={() => lorebookEntryPrefs.showAll()}
										class="text-xs font-ui text-accent hover:underline"
									>
										Show all
									</button>
								{/if}
							</div>
						</div>
					{:else}
						<!-- Entries, unfolding in place -->
						<ul class="lb-rows">
							{#each entries as entry (entry.id)}
								<li>
									<LorebookEntryRow
										lorebookId={selectedBook.id}
										entryId={entry.id}
										expanded={expandedIds.has(entry.id)}
										onToggle={() => toggleExpand(entry.id)}
										onDelete={() => (entryDeleteId = entry.id)}
										onDuplicate={() => duplicateEntry(entry.id)}
										{selectMode}
										selected={selectedIds.has(entry.id)}
										onSelectToggle={() => toggleSelect(entry.id)}
									/>
								</li>
							{/each}
						</ul>

						{#if elsewhere.length > 0}
							<section class="mt-3">
								<div class="lb-part">
									<Icon name="globe" class="w-3.5 h-3.5 text-text-muted" />
									<span class="lb-part-label section-label">Elsewhere in the archive</span>
									<span class="lb-part-rule"></span>
								</div>
								<ul>
									{#each elsewhere as hit (hit.bookId + hit.entry.id)}
										<li>
											<button
												type="button"
												class="lb-else"
												onclick={() => openInBook(hit.bookId, hit.entry.id)}
											>
												<span class="lb-else-title" class:is-untitled={!hit.entry.comment}>
													{hit.entry.comment || 'Untitled entry'}
												</span>
												<span class="lb-else-book">{hit.bookName}</span>
											</button>
										</li>
									{/each}
								</ul>
							</section>
						{/if}
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>

<ConfirmDialog
	open={bookDeleteOpen}
	title="Delete lorebook"
	message={bookDeleteMessage}
	confirmLabel="Delete"
	variant="danger"
	destructive
	holdMs={holdMsForBlast(selectedBook?.entries.length ?? 0)}
	onConfirm={deleteBook}
	onCancel={() => (bookDeleteOpen = false)}
/>

<ConfirmDialog
	open={bulkDeleteOpen}
	title="Delete entries"
	message={`Delete ${selectedIds.size} ${selectedIds.size === 1 ? 'entry' : 'entries'} from "${selectedBook?.name || 'Untitled lorebook'}"? This cannot be undone.`}
	confirmLabel="Delete"
	variant="danger"
	destructive
	holdMs={holdMsForBlast(selectedIds.size)}
	onConfirm={bulkDelete}
	onCancel={() => (bulkDeleteOpen = false)}
/>

<ConfirmDialog
	open={entryDeleteId !== null}
	title="Delete entry"
	message={`Delete "${entryToDelete?.comment || 'Untitled entry'}"? This cannot be undone.`}
	confirmLabel="Delete"
	variant="danger"
	destructive
	onConfirm={deleteEntry}
	onCancel={() => (entryDeleteId = null)}
/>

<style>
	/* ===== the single scroll column ===== */

	.lb-page {
		flex: 1;
		min-height: 0;
		overscroll-behavior: contain;
	}

	/* One measured column: the page reads as a document, not a stretched sheet. */
	.lb-page-inner {
		width: 100%;
		max-width: 52rem;
		margin-inline: auto;
		padding: 0.75rem 0.75rem 3rem;
	}

	/* ===== the book's own actions menu ===== */

	/* The panel anchors here, so it drops under the button and not off the panel's edge. */
	.lb-acts {
		position: relative;
		flex-shrink: 0;
		display: flex;
		align-items: center;
	}

	/* Compounded onto the base class so the red survives whatever order the two
	   stylesheets land in: .brw-menu-item's own hover is otherwise a tie. */
	.brw-menu-item.lb-acts-danger {
		color: var(--color-error);
	}

	.brw-menu-item.lb-acts-danger:hover {
		background: color-mix(in srgb, var(--color-error) 14%, transparent);
		color: var(--color-error);
	}

	/* ===== the book's own title ===== */

	.lb-title {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.3rem;
		margin-bottom: 0.9rem;
	}

	/* The page's heading, editable in place: it reads as the book's name first and a
	   field second. The surface reaches out of the column so the text stays on its edge. */
	.lb-title-name {
		width: calc(100% + 1rem);
		margin-inline: -0.5rem;
		padding: 0.15rem 0.5rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		font-family: var(--font-ui);
		font-size: 1.15rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--color-text-primary);
		outline: none;
		transition: background-color 140ms ease, box-shadow 140ms ease;
	}

	.lb-title-name::placeholder {
		font-style: italic;
		font-weight: 400;
		color: var(--color-text-muted);
	}

	.lb-title-name:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
	}

	.lb-title-name:focus {
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	.lb-title-meta {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		flex-wrap: wrap;
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.lb-title-stat {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	/* The three natures, in the entry rows' own colours. */
	.lb-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: var(--radius-full);
		flex-shrink: 0;
	}

	.lb-dot-always {
		background: var(--color-accent);
	}

	.lb-dot-keyword {
		background: var(--color-success);
	}

	.lb-dot-off {
		background: var(--color-border);
	}

	.lb-title-tokens {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}

	/* Label and value on one line: who carries this book is a fact, not a paragraph. */
	.lb-bound {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.15rem;
	}

	/* Typography comes from the global .section-label. */
	.lb-bound-cap {
		flex-shrink: 0;
	}

	.lb-bound-none {
		font-family: var(--font-ui);
		font-size: 0.6875rem;
		font-style: italic;
		color: var(--color-text-muted);
	}

	.lb-chips {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-wrap: wrap;
	}

	.lb-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		max-width: 100%;
		padding: 0.2rem 0.55rem;
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
		font-family: var(--font-ui);
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: border-color 140ms ease, color 140ms ease;
	}

	.lb-chip:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
	}

	/* ===== the settings strip ===== */

	/* Close enough to read as one stack: Activation states the rules and Test scan tries them,
	   so the two are one subject and the space below them is where the page changes subject. */
	.lb-strip {
		margin-bottom: 0.5rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: var(--color-card-bg);
	}

	.lb-strip-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		padding: 0.6rem 0.85rem;
		cursor: pointer;
		text-align: left;
	}

	.lb-strip-head:hover .lb-strip-title {
		color: var(--color-accent);
	}

	.lb-strip-title {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-primary);
		transition: color 140ms ease;
	}

	.lb-strip-sum {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 0.68rem;
		color: var(--color-text-muted);
		text-align: right;
	}

	/* The parts this book set for itself, lit inside the resolved line. The separator is
	   drawn by the part that follows it so it keeps the muted colour either way. */
	.lb-sum-part.is-set {
		color: var(--color-accent);
	}

	.lb-sum-part + .lb-sum-part::before {
		content: '· ';
		color: var(--color-text-muted);
		opacity: 0.75;
	}

	.lb-strip-chev {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		color: var(--color-text-muted);
	}

	.lb-strip-chev :global(svg) {
		transition: transform 160ms ease;
	}

	.lb-strip-chev.is-open :global(svg) {
		transform: rotate(180deg);
	}

	/* ===== in-list controls (one row: search takes the room, the actions end it) ===== */

	/* The library toolbar's own shape. The search flexes and the actions ride at the end of the
	   same line, so the list starts one row higher and a phone spends its height on entries. */
	.lb-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		/* Padding, not margin: it cannot collapse into the strip above, so the gap that separates
		   the book's settings from its entries is the one written here. Several times the space
		   between the strips themselves, which is what makes the two zones read apart. */
		padding: 1.25rem 0 0.5rem;
	}

	/* Tighter than the gap above, which is what makes the three read as one group beside the
	   search rather than as three loose buttons. Also the position context the BrowsePopover
	   panel anchors to, the same job .brw-bar does for the library toolbars: without it the
	   panel resolves against an ancestor further up, lands away from its trigger, and
	   .panel-scroll clips it. Its right edge is the group's, so the panel drops under the
	   buttons that summoned it. */
	.lb-controls-row {
		position: relative;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	/* The tallest thing this row opens, and it opens inside .lb-page's scroller. Capping it
	   keeps the whole panel reachable where the viewport is short (a phone held sideways)
	   instead of making the page taller to reach the last option.
	   dvh: static vh over-measures under mobile browser chrome. */
	.lb-controls-row :global(.brw-pop-panel) {
		max-height: min(26rem, 62dvh);
		overflow-y: auto;
	}

	/* A hidden kind still names itself, but its dot stops reading as lit. */
	.lb-nature:not(.is-active) .lb-dot {
		opacity: 0.4;
	}

	/* Inside the column the bulk bar reads as a banner, not a full-bleed strip. */
	.lb-bulk {
		margin: 0 0 0.5rem;
		border: 1px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
		border-radius: var(--radius-md);
	}

	/* ===== entry rows ===== */

	.lb-rows {
		display: flex;
		flex-direction: column;
	}

	/* Hairline between collapsed rows so a long list scans as lines, not a floating
	   cloud of titles. Open rows carve themselves out with their own border+margin. */
	.lb-rows > li + li {
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 55%, transparent);
	}

	/* ===== cross-book section ===== */

	.lb-part {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.5rem;
	}

	/* Typography comes from the global .section-label; only the wrap rule is local. */
	.lb-part-label {
		white-space: nowrap;
	}

	.lb-part-rule {
		flex: 1;
		height: 1px;
		background: color-mix(in srgb, var(--color-border-subtle) 80%, transparent);
	}

	.lb-else {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		width: 100%;
		padding: 0.4rem 0.65rem;
		border-radius: var(--radius-md);
		text-align: left;
		cursor: pointer;
		transition: background-color 130ms ease;
	}

	.lb-else:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
	}

	.lb-else-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.lb-else-title.is-untitled {
		font-style: italic;
		font-weight: 400;
		color: var(--color-text-muted);
	}

	.lb-else-book {
		flex-shrink: 0;
		max-width: 9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.6875rem;
		font-style: italic;
		color: var(--color-text-muted);
	}
</style>
