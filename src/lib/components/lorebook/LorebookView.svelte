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
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import PortraitFramingDialog from '$lib/components/library/PortraitFramingDialog.svelte';
	import { anchorTo } from '$lib/actions/anchorTo';
	import LorebookEntryRow from './LorebookEntryRow.svelte';
	import LorebookActivationPanel from './LorebookActivationPanel.svelte';
	import LorebookBindPicker from './LorebookBindPicker.svelte';
	import LorebookScanTester from './LorebookScanTester.svelte';
	import { imageService, imageRejectionReason } from '$lib/services/imageService';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import { downloadLorebook } from '$lib/lorebook/io';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { chatLorebookClaim } from '$lib/utils/chat-setup';
	import { workspaceFocus } from '$lib/stores/workspaceFocus.svelte';
	import { countTokens } from '$lib/tokenizer';
	import {
		activationSummary,
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

	/** The cards carrying the open book. A book nothing carries never reaches a prompt. */
	let linked = $derived(
		selectedBook
			? characterLibraryStore.entries.filter((en) =>
					en.data.lorebookIds?.includes(selectedBook.id)
				)
			: []
	);
	/** The chats that attached it for themselves, newest first (architecture/lorebook.md). */
	let boundChats = $derived(
		selectedBook
			? chatStore.sortedChats.filter((chat) => chatLorebookClaim(chat).includes(selectedBook.id))
			: []
	);

	/** Past this the chips are a wall rather than a summary, so the rest wait behind one press. */
	const CARRIER_LIMIT = 3;

	/** Everything carrying the book, in one row of chips: the cards first, since a card link
	 *  is the durable binding, then the chats that took it for one story. Each chip opens what
	 *  it names, which is where the rest of that thing's setup lives. */
	let carriers = $derived([
		...linked.map((en) => ({
			id: en.id,
			name: en.identity.name || 'Unnamed',
			icon: en.type === 'persona' ? ('user' as const) : ('users' as const),
			// The face a card is recognised by, aimed by its own framing like every other
			// cover-fit portrait in the app (architecture/library.md). A card with no picture
			// keeps the glyph, in the same round frame, so a mixed row is still one shape.
			thumb: imageService.thumbnailUrl(en.identity.imageUrl),
			focus: portraitFocusStyle(en.identity.portraitFocus),
			title: `Open ${en.type} editor`,
			open: () => uiStore.openLibraryEntry(en.id, en.type, () => lorebookStore.flush())
		})),
		...boundChats.map((chat) => ({
			id: chat.id,
			name: chat.title?.trim() || 'Untitled chat',
			icon: 'chat' as const,
			// A chat has no portrait of its own, and borrowing its character's would read as a
			// chip naming that character rather than this story.
			thumb: null as string | null,
			focus: undefined as string | undefined,
			title: 'Open this chat',
			open: () => openChat(chat.id)
		}))
	]);
	let allCarriers = $state(false);
	let shownCarriers = $derived(allCarriers ? carriers : carriers.slice(0, CARRIER_LIMIT));

	/** The book stands over the chat, so reaching one means leaving the book: flush what is
	 *  typed, lower the editor, and drop the Library too where it cannot dock beside the chat
	 *  it just opened, which is the recipe the Library's own character pick follows. */
	async function openChat(chatId: string) {
		await lorebookStore.flush();
		uiStore.lorebookEditorId = null;
		await chatStore.selectChat(chatId);
		if (!viewport.canDockSettings) uiStore.closeLibrary();
	}

	// ===== binding, from the book's side =====

	let bindOpen = $state(false);
	let bindAnchor = $state<HTMLElement | undefined>(undefined);
	let bindPanel = $state<HTMLElement | null>(null);

	// The app's popover idiom (KeyChipInput): document listeners while open, so Escape is
	// CONSUMED here and never also reaches the view's own Escape ladder behind it. The panel
	// sits on <body> (anchorTo), so containment is asked of it and the trigger both.
	$effect(() => {
		if (!bindOpen) return;
		// The panel lives at the end of <body>, unreachable by tabbing from the trigger, so
		// focus moves into it on open; Escape hands it back. The search field is deliberately
		// NOT focused: on a phone that answers a press with a keyboard over the list.
		bindPanel?.focus();
		const onDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (!bindAnchor?.contains(target) && !bindPanel?.contains(target)) bindOpen = false;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.stopPropagation();
			bindAnchor?.focus();
			bindOpen = false;
		};
		document.addEventListener('mousedown', onDown, true);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown, true);
			document.removeEventListener('keydown', onKey);
		};
	});

	// A book closing takes its popover with it, or the next one opens with the panel already
	// standing over a page it was never opened from.
	$effect(() => {
		if (!selectedBook) bindOpen = false;
	});

	// ===== the cover =====

	let coverPath = $derived(selectedBook?.cover);
	/** The thumbnail, not the stored file: this box is 17rem at its widest, and the server
	 *  answers with the original where a thumbnail was never written. The framing dialog
	 *  reads the original instead, since that is the screen the picture is judged on. */
	let coverUrl = $derived(imageService.thumbnailUrl(coverPath));
	let coverInput = $state<HTMLInputElement | null>(null);
	let coverBusy = $state(false);
	let framingOpen = $state(false);

	async function onCoverPick(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !selectedBook) return;
		const refused = imageRejectionReason(file);
		if (refused) {
			toastStore.error(refused);
			return;
		}
		coverBusy = true;
		try {
			await lorebookStore.setCover(selectedBook.id, file);
		} catch (error) {
			toastStore.failed(`save "${file.name}"`, error);
		} finally {
			coverBusy = false;
		}
	}

	async function removeCover(e: MouseEvent) {
		// The frame behind these two buttons opens the file picker.
		e.stopPropagation();
		if (!selectedBook) return;
		coverBusy = true;
		try {
			await lorebookStore.setCover(selectedBook.id, null);
		} catch (error) {
			toastStore.failed('remove that cover', error);
		} finally {
			coverBusy = false;
		}
	}

	function openFraming(e: MouseEvent) {
		e.stopPropagation();
		framingOpen = true;
	}

	/** The one settings strip above the list: both layers of the activation cascade. */
	let stripOpen = $state(false);
	/** The scan tester below it: closed until the reader asks what fires. */
	let testerOpen = $state(false);

	let globals = $derived(lorebookSettingsStore.settings);
	/** The strip's collapsed line: what the open book actually runs with, not what either
	 *  layer holds on its own. */
	let summary = $derived(
		selectedBook
			? activationSummary(
					resolveBookActivation(selectedBook, globals),
					globals,
					!!selectedBook.global
				)
			: []
	);

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
				<!-- A book, said in the glyph the shelf and the Bound to chips already use, since
				     this bar is the character editor's too. -->
				<span class="editor-header-glyph" aria-hidden="true">
					<Icon name="bookOpen" class="w-4 h-4" strokeWidth={1.5} />
				</span>
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
		<!-- One scroll, two columns once the panel can hold them: what the book IS on the left,
		     what it HOLDS on the right, the split the character editor's identity pane uses. -->
		<div class="lb-page panel-scroll">
			<div class="lb-rail">
				<!-- The book's cover, in the slot and the shape the other two editors open a
				     portrait in: press to pick one, the two corner actions to drop it or aim it.
				     Empty it keeps the book glyph rather than a photo one, since a plate with
				     nothing on it should still say what kind of thing this page is about. -->
				<div
					class="lb-plate portrait-frame"
					class:is-empty={!coverUrl}
					role="button"
					tabindex="0"
					onclick={() => coverInput?.click()}
					onkeydown={(e) => e.key === 'Enter' && coverInput?.click()}
					aria-label={coverUrl ? 'Change cover' : 'Add a cover'}
					aria-disabled={coverBusy}
				>
					{#if coverBusy}
						<Spinner size="md" />
					{:else if coverUrl}
						<img
							src={coverUrl}
							alt={selectedBook.name || 'lorebook'}
							class="lb-plate-art"
							style={portraitFocusStyle(selectedBook.coverFocus)}
						/>
						<span class="lb-plate-veil">Change cover</span>
						<button
							type="button"
							class="portrait-overlay-action lb-plate-act lb-plate-act--x"
							onclick={removeCover}
							aria-label="Remove cover"
						>
							<Icon name="close" class="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							class="portrait-overlay-action lb-plate-act lb-plate-act--crop"
							onclick={openFraming}
							aria-label="Adjust framing"
							title="Adjust framing"
						>
							<Icon name="crop" class="w-3.5 h-3.5" />
						</button>
					{:else}
						<span class="lb-plate-add">
							<Icon name="bookOpen" class="w-10 h-10" strokeWidth={1.25} />
							<span>Add cover</span>
						</span>
					{/if}
				</div>

				<!-- The book's identity. The name is a labelled field and not a second heading:
				     the bar above already says it, and saying it twice in two sizes is what made
				     this page read as one title with a title under it. -->
				<div class="lb-ident">
					<div>
						<!-- The character editor's own Name field, to the class: two editors sharing a
						     bar must not hold two opinions about what a field looks like. -->
						<label
							for="lb-name-{selectedBook.id}"
							class="block text-sm font-ui font-medium text-text-primary mb-1.5"
						>
							Name
						</label>
						<input
							bind:this={nameEl}
							id="lb-name-{selectedBook.id}"
							type="text"
							value={selectedBook.name}
							oninput={(e) =>
								lorebookStore.updateBookMeta(selectedBook.id, {
									name: (e.target as HTMLInputElement).value
								})}
							placeholder="Name this book…"
							class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm placeholder:text-text-muted"
						/>
					</div>

					<!-- Use in every chat answers the same question from the other end and lives in
					     the Activation strip beside the rest of what the book DOES; this is the
					     named half of it. Binding is offered from here as well as from each card and
					     each chat because a book is where the question is asked from most often, and
					     it writes through those same doors, so there is one binding and not a second
					     kind of one. -->
					<div class="lb-bind">
						<button
							type="button"
							class="lb-bind-add"
							bind:this={bindAnchor}
							onclick={() => (bindOpen = !bindOpen)}
							aria-haspopup="dialog"
							aria-expanded={bindOpen}
							title="Attach this book to a character, a persona or a chat"
						>
							<Icon name="plus" class="w-3.5 h-3.5" />
							<span>Bind to…</span>
						</button>

						{#if carriers.length > 0}
							<span class="section-label">Bound to</span>
							<div class="lb-chips">
								{#each shownCarriers as carrier (carrier.id)}
									<button
										type="button"
										class="lb-chip"
										onclick={carrier.open}
										title={carrier.title}
									>
										<span class="lb-chip-face">
											{#if carrier.thumb}
												<img src={carrier.thumb} alt="" loading="lazy" style={carrier.focus} />
											{:else}
												<Icon name={carrier.icon} class="w-3 h-3" />
											{/if}
										</span>
										<span class="lb-chip-name">{carrier.name}</span>
									</button>
								{/each}
								<!-- The rest behind one press, and the way back beside them: a rail that
								     grew to forty chips has lost the page it is a rail for. -->
								{#if carriers.length > CARRIER_LIMIT}
									<button
										type="button"
										class="lb-chip lb-chip--more"
										onclick={() => (allCarriers = !allCarriers)}
									>
										{allCarriers ? 'Show fewer' : `+${carriers.length - CARRIER_LIMIT} more`}
									</button>
								{/if}
							</div>
						{:else if !selectedBook.global}
							<!-- Held back while the switch above is on, since a book reaching every chat
							     must not read as one reaching nothing right under the control that
							     sends it everywhere. -->
							<p class="lb-bind-none">Not linked</p>
						{/if}
					</div>

					<!-- What the book is made of. The natures are spelled out only where there is
					     more than one, since "3 entries · 3 keyword" says the same number twice; an
					     empty book says so in the empty state below instead. -->
					{#if total > 0}
						<p class="lb-ident-meta">
							<span class="lb-stat">{total} {total === 1 ? 'entry' : 'entries'}</span>
							{#if composition.length > 1}
								{#each composition as part (part.kind)}
									<span class="lb-stat">
										<span class="lb-dot lb-dot-{part.kind}"></span>{part.count}
										{part.kind}
									</span>
								{/each}
							{/if}
							<span class="lb-stat lb-stat--tokens">~{tokens} tokens</span>
						</p>
					{/if}
				</div>

			</div>

			<!-- What the book holds: the second column, and the whole page on a narrow panel. -->
			<div class="lb-page-inner">
				<!-- The two strips take the wide column rather than the rail: three cards of
				     settings and a scan box with results have nothing to spend 17rem on. The rail
				     keeps what the book IS. Stacked, this lands exactly where it did, since the
				     rail's contents still come first down the page. -->
				<div class="lb-strips">
					<section class="lb-strip">
						<button
							type="button"
							class="strip-head lb-strip-head"
							onclick={() => (stripOpen = !stripOpen)}
							aria-expanded={stripOpen}
						>
							<Icon name="settings" class="w-4 h-4 text-text-muted flex-shrink-0" />
							<span class="strip-title">Activation</span>
							<span class="strip-sum">
								{#each summary as part (part.text)}
									<span class="strip-part" class:is-set={part.set}>{part.text}</span>
								{/each}
							</span>
							<span class="strip-chev" class:is-open={stripOpen}>
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
							class="strip-head lb-strip-head"
							onclick={() => (testerOpen = !testerOpen)}
							aria-expanded={testerOpen}
						>
							<Icon name="search" class="w-4 h-4 text-text-muted flex-shrink-0" />
							<span class="strip-title">Test scan</span>
							<span class="strip-sum">
								<span class="strip-part">see what this book fires on</span>
							</span>
							<span class="strip-chev" class:is-open={testerOpen}>
								<Icon name="chevronDown" class="w-4 h-4" />
							</span>
						</button>
						{#if testerOpen}
							<LorebookScanTester book={selectedBook} />
						{/if}
					</section>
				</div>

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

<input
	bind:this={coverInput}
	type="file"
	accept="image/*"
	class="hidden"
	onchange={onCoverPick}
/>

<!-- The bind picker, glued to its trigger and living on <body>: the rail scrolls and the
     panel around it clips, so a panel left in flow would lose its own list. -->
{#if bindOpen && selectedBook}
	<div
		class="bind-pop surface-float"
		role="dialog"
		aria-label="Bind this lorebook"
		tabindex="-1"
		bind:this={bindPanel}
		use:anchorTo={bindAnchor}
	>
		<LorebookBindPicker bookId={selectedBook.id} />
	</div>
{/if}

{#if coverPath}
	<PortraitFramingDialog
		open={framingOpen}
		imagePath={coverPath}
		name={selectedBook?.name || 'Untitled lorebook'}
		focus={selectedBook?.coverFocus}
		onSave={(focus) => lorebookStore.setCoverFocus(bookId, focus)}
		onClose={() => (framingOpen = false)}
	/>
{/if}

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
	/* ===== one scroll, one or two columns ===== */

	.lb-page {
		flex: 1;
		min-height: 0;
		overscroll-behavior: contain;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: 0.75rem;
		padding: 0.75rem 0.75rem 3rem;
	}

	/* What the book IS, beside what it HOLDS. A container query and not a viewport one: this
	   panel is as wide as the chat column, so a window that is wide with both docks open must
	   not be told it has room for two columns. */
	@container browse (min-width: 860px) {
		.lb-page {
			grid-template-columns: minmax(0, 17rem) minmax(0, 1fr);
			gap: 1.5rem;
			padding: 1.5rem 1.5rem 3rem;
		}

		/* It holds still while the entries scroll past it: what a book is does not move. */
		.lb-rail {
			position: sticky;
			top: 0;
			align-self: start;
		}

		/* The rule between the panes, drawn on this side and only side by side, the character
		   editor's own: stacked, the two follow each other down the page and a line across the
		   middle would read as a divider inside the book's identity. */
		.lb-page-inner {
			border-left: 1px solid var(--color-border-subtle);
			padding-left: 1.5rem;
		}
	}

	.lb-rail {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	/* The two strips, stacked as one block above the entries. Its own size container rather
	   than the column's: the column also holds the entry rows, whose popovers position
	   themselves against the viewport, and a containment context here would make this element
	   the box they measure from. */
	.lb-strips {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
		container-type: inline-size;
		container-name: lbstrips;
	}

	/* Narrow, a strip's summary takes its own line under the name: a hint clipped to three
	   words is not a hint, and it is the whole reason a fold can stay folded. Given the room,
	   it rides on the name's line where it belongs. */
	@container lbstrips (max-width: 26rem) {
		.lb-strip-head {
			flex-wrap: wrap;
			row-gap: 0.15rem;
		}

		.lb-strip-head .strip-title {
			flex: 1;
		}

		.lb-strip-head .strip-sum {
			flex: 0 0 100%;
			order: 3;
			text-align: left;
		}
	}

	/* The entries take the column they are given, the way the character editor's fields take
	   theirs: a measure of their own would leave a wide panel mostly empty, and an entry row
	   is a title over a line of keys rather than prose that needs a short line. */
	.lb-page-inner {
		min-width: 0;
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

	/* ===== the book's identity, at the head of the rail ===== */

	/* The other two editors open on a picture, so the rail does too. Capped and centred while
	   the panes are stacked, exactly as their portrait is: at full width a 3:4 plate would be
	   taller than the phone it is on. */
	.lb-plate {
		position: relative;
		display: grid;
		width: 100%;
		max-width: 15rem;
		margin: 0 auto 0.5rem;
		aspect-ratio: 3 / 4;
		place-items: center;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background:
			linear-gradient(
				160deg,
				color-mix(in srgb, var(--color-accent) 10%, transparent),
				transparent 62%
			),
			var(--color-bg-tertiary);
		color: color-mix(in srgb, var(--color-text-muted) 70%, transparent);
		cursor: pointer;
		transition:
			border-color 150ms ease,
			box-shadow 150ms ease;
	}

	.lb-plate:hover,
	.lb-plate:focus-visible {
		border-color: var(--color-accent);
		outline: 0;
		box-shadow: var(--shadow-md);
	}

	/* Cover fit, aimed by the stored framing: this box and the shelf row's square disagree
	   about shape, and a centred crop is right in only one of them. */
	.lb-plate-art {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* The empty plate is the only state that says what a press does, since a plate carrying
	   art already shows it under the veil below. */
	.lb-plate-add {
		display: grid;
		justify-items: center;
		gap: 0.35rem;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		transition: color 150ms ease;
	}

	.lb-plate.is-empty:hover .lb-plate-add {
		color: var(--color-accent);
	}

	.lb-plate-veil {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		padding-bottom: 0.65rem;
		background: linear-gradient(to top, rgb(0 0 0 / 0.7), rgb(0 0 0 / 0.1) 45%, transparent);
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: rgb(255 255 255 / 0.9);
		opacity: 0;
		transition: opacity 150ms ease;
	}

	.lb-plate:hover .lb-plate-veil {
		opacity: 1;
	}

	/* The corner pair the two library editors wear, same glyphs in the same corners: the
	   frame's own .portrait-frame rule is what reveals them, touch screens included. */
	.lb-plate-act {
		position: absolute;
		padding: 0.25rem;
		border-radius: var(--radius-full);
		background: rgb(0 0 0 / 0.5);
		color: rgb(255 255 255 / 0.8);
		transition:
			background 130ms ease,
			color 130ms ease;
	}

	.lb-plate-act--x {
		top: 0.375rem;
		right: 0.375rem;
	}

	.lb-plate-act--x:hover {
		background: var(--color-error);
		color: #fff;
	}

	.lb-plate-act--crop {
		bottom: 0.375rem;
		right: 0.375rem;
	}

	.lb-plate-act--crop:hover {
		background: rgb(0 0 0 / 0.75);
		color: #fff;
	}

	@container browse (min-width: 860px) {
		.lb-plate {
			max-width: none;
			margin-inline: 0;
		}
	}

	.lb-ident {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.35rem;
	}

	.lb-ident-meta {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
		margin: 0.15rem 0 0;
		font-family: var(--font-ui);
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.lb-stat {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	/* Drawn by the part that follows, so the line has no trailing separator to trim. */
	.lb-stat + .lb-stat::before {
		content: '·';
		opacity: 0.75;
	}

	.lb-stat--tokens {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}

	.lb-stat--quiet {
		font-style: italic;
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

	/* Label over the chips: in a rail there is no room to sit them side by side, and who
	   carries the book is a list rather than a value. */
	/* How the book reaches a chat: the way to bind one, then what is bound. The rule above it
	   is what stops the block reading as one more field of the name: what the book is CALLED
	   and what carries it are two questions, and only the first is typed into. */
	.lb-bind {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.5rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	/* Quiet and full width: it is an add affordance in a rail, not the page's action. Its
	   height is the composer chip's, coarse pointer included, since a thumb has to hit it. */
	.lb-bind-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		width: 100%;
		height: 1.9rem;
		border: 1px solid var(--color-border-raised);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		cursor: pointer;
		transition: color 140ms ease, border-color 140ms ease, background-color 140ms ease;
	}

	.lb-bind-add:hover,
	.lb-bind-add[aria-expanded='true'] {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
		background: color-mix(in srgb, var(--color-accent) 8%, transparent);
	}

	@media (pointer: coarse) {
		.lb-bind-add {
			height: 2.4rem;
		}
	}

	/* Nothing carries it, said where the chips would be rather than down among the counts. */
	.lb-bind-none {
		font-family: var(--font-ui);
		font-size: 0.7rem;
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
		gap: 0.35rem;
		max-width: 100%;
		/* Tighter on the face's side: a circle carries its own edge, so equal padding reads
		   as a gap. The composer's own setup chip is built the same way. */
		padding: 0.15rem 0.55rem 0.15rem 0.2rem;
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

	/* A chat's title is a whole sentence in a 17rem rail, so the chip truncates instead of
	   pushing the row it sits in off the page. */
	.lb-chip-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* One frame for both, so a card with a portrait and a chat with none read as one row of
	   chips rather than two kinds. */
	.lb-chip-face {
		display: grid;
		place-items: center;
		width: 1.2rem;
		height: 1.2rem;
		flex-shrink: 0;
		border-radius: 999px;
		overflow: hidden;
		background: var(--color-bg-tertiary);
		color: var(--color-text-muted);
	}

	.lb-chip-face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* The count of what is folded away: it names a quantity rather than a thing, so it wears
	   no face and takes its padding back. */
	.lb-chip--more {
		padding: 0.15rem 0.55rem;
		color: var(--color-text-muted);
		font-weight: 600;
	}

	/* The bind picker's own shell. Narrower than it is tall on purpose: it is a list of names
	   anchored to a 17rem rail, and clamped so a phone never gets one wider than its screen. */
	.bind-pop {
		width: min(20rem, calc(100vw - 2rem));
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		z-index: 60;
		/* What the shared .brw-search recipe sizes itself from; it is declared on the browse
		   container there, which this panel is not inside. */
		--brw-h: 1.9rem;
		opacity: 0;
		transform: translateY(-0.2rem);
		transition: opacity 120ms ease, transform 120ms ease;
	}

	/* :global on the attribute, the way every anchored panel here writes it: the action stamps
	   these at runtime and the compiler would prune a selector it cannot see used. */
	.bind-pop:global([data-placement='above']) {
		transform: translateY(0.2rem);
	}

	.bind-pop:global([data-open]) {
		opacity: 1;
		transform: translateY(0);
	}

	/* ===== the settings strip ===== */

	/* Close enough to read as one stack with the identity above them: what the book is, what
	   it runs with, what it fires on. The rail's own gap spaces them. */
	.lb-strip {
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: var(--color-card-bg);
	}

	/* The line itself is the shared .strip-head recipe in app.css; the card around it owns
	   its padding, which is what keeps a strip in a document and a row on a shelf each
	   aligned to what they sit under. */
	.lb-strip-head {
		padding: 0.6rem 0.85rem;
	}

	/* ===== in-list controls (one row: search takes the room, the actions end it) ===== */

	/* The library toolbar's own shape. The search flexes and the actions ride at the end of the
	   same line, so the list starts one row higher and a phone spends its height on entries. */
	.lb-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		/* Padding, not margin: it cannot collapse into the strips above it, so the gap that
		   separates the book's settings from its entries is the one written here. Several times
		   the space between the strips themselves, which is what makes the zones read apart. */
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
