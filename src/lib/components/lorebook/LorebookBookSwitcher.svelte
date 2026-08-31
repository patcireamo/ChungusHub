<script lang="ts">
	/**
	 * The open book's name in the header, and behind it every book: searched, ordered, picked.
	 *
	 * One job: pick the book the page is showing. What you can DO to a book (export, delete,
	 * make, bring) is the actions menu beside it, the same split Preset Controls uses over
	 * its own subject.
	 *
	 * The panel is the model picker's shape (Settings → Connections) read for a shelf: type to
	 * narrow, arrow through what is left, Enter to open it. A shelf long enough to need an
	 * order is long enough that scrolling it is the slow way to reach one book.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import { foldForSearch } from '$lib/components/library/browse';
	import { sortLorebooks, type Lorebook } from '$lib/lorebook/types';
	import { lorebookSortPref, LOREBOOK_SORT_OPTIONS } from '$lib/stores/lorebookSort.svelte';

	interface Props {
		/** The open book, whose name the header shows. */
		book: Lorebook;
		/** Every book, for the list. */
		books: Lorebook[];
		onSelect: (id: string) => void;
	}

	let { book, books, onSelect }: Props = $props();

	/** A touch screen opens this to read the shelf, and a caret in the search would answer by
	 *  putting the keyboard over the list. The search is still one tap away there. */
	const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

	let open = $state(false);
	let query = $state('');
	let highlighted = $state(0);

	let menuRef = $state<HTMLDivElement | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);

	const nameOf = (b: Lorebook) => b.name || 'Untitled lorebook';

	// The list's order is a display preference shared with the character editor's link picker;
	// `books` itself stays in store order, which is what link resolution reads.
	let ordered = $derived(sortLorebooks(books, lorebookSortPref.order));
	let visible = $derived.by(() => {
		const q = foldForSearch(query.trim());
		return q ? ordered.filter((b) => foldForSearch(nameOf(b)).includes(q)) : ordered;
	});

	function show() {
		query = '';
		// Opens on the book being read, so the first arrow press moves from where the reader is
		// rather than from the top of a shelf they are already somewhere inside.
		highlighted = Math.max(
			0,
			ordered.findIndex((b) => b.id === book.id)
		);
		open = true;
	}

	function hide() {
		open = false;
		query = '';
	}

	function pick(id: string) {
		hide();
		onSelect(id);
	}

	function scrollHighlightedIntoView() {
		const node = listEl?.querySelector(`[data-index="${highlighted}"]`) as HTMLElement | null;
		node?.scrollIntoView({ block: 'nearest' });
	}

	function handleKeydown(e: KeyboardEvent) {
		// Mid-composition Enter closes the IME candidate, it does not choose a book.
		if (e.isComposing) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (visible.length === 0) return;
			highlighted =
				e.key === 'ArrowDown'
					? Math.min(highlighted + 1, visible.length - 1)
					: Math.max(highlighted - 1, 0);
			scrollHighlightedIntoView();
			e.preventDefault();
		} else if (e.key === 'Enter') {
			const target = visible[highlighted];
			if (target) {
				pick(target.id);
				e.preventDefault();
			}
		} else if (e.key === 'Escape') {
			// A live search is what Escape clears first; the panel goes on the next press.
			// Consumed either way, or the same press cascades into the view and the workspace.
			e.preventDefault();
			e.stopPropagation();
			if (query) query = '';
			else hide();
		}
	}

	$effect(() => {
		if (open && !coarse) inputEl?.focus();
	});

	$effect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (menuRef && !menuRef.contains(e.target as Node)) hide();
		};
		// The panel is reachable without the caret in its search (a touch screen, or a click on
		// a sort chip), so Escape answers there too.
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				hide();
			}
		};
		document.addEventListener('mousedown', onDown, true);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown, true);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<div class="lb-switcher" bind:this={menuRef}>
	<button
		type="button"
		class="overlay-switch"
		onclick={() => (open ? hide() : show())}
		aria-haspopup="listbox"
		aria-expanded={open}
		title="Switch lorebook"
	>
		<span class="overlay-subject" class:is-untitled={!book.name}>
			{book.name || 'Untitled lorebook'}
		</span>
		<Icon name="chevronDown" class="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
	</button>
	{#if open}
		<div class="lb-pop">
			<div class="lb-find">
				<Icon name="search" class="lb-find-icon w-3.5 h-3.5" />
				<input
					bind:this={inputEl}
					bind:value={query}
					type="text"
					class="lb-find-input"
					placeholder="Search {books.length} lorebook{books.length === 1 ? '' : 's'}…"
					role="combobox"
					aria-label="Search lorebooks"
					aria-autocomplete="list"
					aria-expanded="true"
					aria-controls="lb-book-options"
					aria-activedescendant={visible[highlighted] ? `lb-book-${visible[highlighted].id}` : undefined}
					oninput={() => (highlighted = 0)}
					onkeydown={handleKeydown}
					autocomplete="off"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
				/>
			</div>

			<!-- Under the search, over the list: the order is how the shelf reads when nothing is
			     typed. Picking one leaves the panel open, since the point is to look again. -->
			<div class="lb-sort" role="group" aria-label="Sort lorebooks">
				{#each LOREBOOK_SORT_OPTIONS as option (option.id)}
					<button
						type="button"
						class="lb-sort-opt"
						class:is-active={lorebookSortPref.order === option.id}
						aria-pressed={lorebookSortPref.order === option.id}
						onclick={() => {
							lorebookSortPref.set(option.id);
							highlighted = 0;
						}}
					>
						{option.label}
					</button>
				{/each}
			</div>

			<div bind:this={listEl} id="lb-book-options" class="lb-list" role="listbox">
				{#if visible.length === 0}
					<p class="lb-none">No lorebooks match “{query}”.</p>
				{:else}
					{#each visible as b, i (b.id)}
						<button
							type="button"
							id="lb-book-{b.id}"
							role="option"
							aria-selected={b.id === book.id}
							data-index={i}
							class="lb-book"
							class:is-open={b.id === book.id}
							class:is-highlighted={i === highlighted}
							onmouseenter={() => (highlighted = i)}
							onclick={() => pick(b.id)}
						>
							<span class="lb-book-tick" aria-hidden="true">
								{#if b.id === book.id}<Icon name="check" class="w-3.5 h-3.5" />{/if}
							</span>
							<span class="lb-book-name" class:is-untitled={!b.name}>
								{b.name || 'Untitled lorebook'}
							</span>
							<span class="lb-book-count">{b.entries.length}</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	/* The trigger itself is the shared .overlay-switch recipe. */
	.lb-switcher {
		position: relative;
		min-width: 0;
		max-width: 100%;
	}

	/* Anchored to the switch's own left edge. */
	.lb-pop {
		position: absolute;
		top: calc(100% + 0.375rem);
		left: 0;
		z-index: 45;
		display: flex;
		flex-direction: column;
		width: min(18rem, calc(100cqw - 1.5rem));
		padding: 0.25rem;
		background: var(--color-float-bg);
		backdrop-filter: var(--backdrop-blur) saturate(140%);
		-webkit-backdrop-filter: var(--backdrop-blur) saturate(140%);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
	}

	/* Search and order both stay put while the books under them scroll. */
	.lb-find {
		position: relative;
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}

	.lb-find :global(.lb-find-icon) {
		position: absolute;
		left: 0.6rem;
		color: var(--color-text-muted);
		pointer-events: none;
	}

	/* The link picker's own search, to the value: the two search the same shelf and a reader
	   who meets one has met the other. */
	.lb-find-input {
		width: 100%;
		height: 2rem;
		padding: 0 0.6rem 0 1.85rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
		font-family: var(--font-ui);
		font-size: 0.76rem;
		color: var(--color-text-primary);
	}

	.lb-find-input::placeholder {
		color: var(--color-text-muted);
	}

	.lb-find-input:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: var(--color-bg-secondary);
	}

	.lb-sort {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem;
		flex-shrink: 0;
		padding: 0.35rem 0.15rem 0.4rem;
		margin-bottom: 0.25rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.lb-sort-opt {
		padding: 0.2rem 0.45rem;
		border-radius: var(--radius-sm);
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: background-color 130ms ease, color 130ms ease;
	}

	.lb-sort-opt:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.lb-sort-opt.is-active {
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		color: var(--color-accent);
		font-weight: 650;
	}

	/* dvh: static vh over-measures under mobile browser chrome and clips the list. */
	.lb-list {
		min-height: 0;
		max-height: min(15rem, 34dvh);
		overflow-y: auto;
	}

	.lb-none {
		padding: 0.75rem 0.65rem;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		color: var(--color-text-muted);
		text-align: center;
	}

	.lb-book {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.45rem 0.65rem;
		border-radius: var(--radius-md);
		text-align: left;
		cursor: pointer;
		transition: background-color 140ms ease;
	}

	/* One cursor for the mouse and the arrow keys, so hovering and arrowing cannot leave two
	   rows looking equally next. */
	.lb-book.is-highlighted {
		background: var(--color-bg-tertiary);
	}

	.lb-book.is-open {
		background: color-mix(in srgb, var(--color-accent) 11%, transparent);
	}

	.lb-book.is-open.is-highlighted {
		background: color-mix(in srgb, var(--color-accent) 16%, transparent);
	}

	/* An always-present gutter, so which book is open reads down one column and the
	   names below it stay on one x. */
	.lb-book-tick {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		width: 0.875rem;
		height: 0.875rem;
		color: var(--color-accent);
	}

	.lb-book-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.lb-book.is-open .lb-book-name {
		color: var(--color-accent);
	}

	.lb-book-name.is-untitled {
		font-style: italic;
		font-weight: 400;
		color: var(--color-text-muted);
	}

	.lb-book-count {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}
</style>
