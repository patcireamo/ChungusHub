<script lang="ts">
	/**
	 * Where a selection of entries is going: the body of both transfer popovers in the entry
	 * list's selection bar.
	 *
	 * **The verb is decided by the button that opened this, and printed at the head.** A panel
	 * that only listed books would leave the reader guessing whether the next press copies the
	 * selection or cuts it out of the book they are standing in, and those two presses are not
	 * equally easy to take back.
	 *
	 * The open book is deliberately not in the list: sending entries to the book they are
	 * already in is the Duplicate the row menu offers. Nor is making a book, for the reason
	 * the editor cannot mint one either (architecture/lorebook.md): that is an act on the
	 * archive and it belongs to the shelf.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import LorebookGlobalBadge from './LorebookGlobalBadge.svelte';
	import { foldForSearch } from '$lib/components/library/browse';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { sortLorebooks } from '$lib/lorebook/types';
	import { lorebookViewPrefs, LOREBOOK_SORT_OPTIONS } from '$lib/stores/lorebookViewPrefs.svelte';

	interface Props {
		/** The book the entries are in, kept out of the list. */
		bookId: string;
		/** What the press will do. */
		mode: 'move' | 'copy';
		/** How many entries are going, so the head line says what is at stake. */
		count: number;
		onPick: (targetId: string) => void;
	}

	let { bookId, mode, count, onPick }: Props = $props();

	/**
	 * The three orders offered here, taken from the shelf's own list by id, in its sequence and
	 * with its labels. This row writes the shelf's preference rather than one of its own, so a
	 * fourth wording of A → Z is how two views of one shelf start naming one setting two ways.
	 *
	 * Three of the seven, because the question here is only "where is that book in this list".
	 * A shelf left on one of the other four lights none of them, which is honest: the list
	 * really is in an order these three do not name, and pressing one adopts it everywhere.
	 */
	const SORTS = LOREBOOK_SORT_OPTIONS.filter((o) => ['a-z', 'z-a', 'updated'].includes(o.id));

	// The shelf's own order, so the book a reader is hunting sits where they last saw it.
	let books = $derived(
		sortLorebooks(lorebookStore.books, lorebookViewPrefs.order).filter((b) => b.id !== bookId)
	);

	let query = $state('');
	let visible = $derived.by(() => {
		const q = foldForSearch(query.trim());
		if (!q) return books;
		return books.filter((book) => foldForSearch(book.name || 'Untitled lorebook').includes(q));
	});

	// Escape clears an active search before it bubbles up and closes the popover.
	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && query) {
			e.stopPropagation();
			query = '';
		}
	}
</script>

<p class="lbt-head">
	{mode === 'move' ? 'Move' : 'Copy'} {count} {count === 1 ? 'entry' : 'entries'} to…
</p>

<!-- Nothing to search or order in a list of one, so a shelf holding a single other book gets
     the list alone. Past that, hunting a name in a long archive is the whole difficulty of
     this panel and both are drawn every time. -->
{#if books.length > 1}
	<div class="brw-search lbt-search">
		<Icon name="search" class="brw-search-icon w-3.5 h-3.5" />
		<input
			type="text"
			bind:value={query}
			onkeydown={onSearchKeydown}
			placeholder="Search lorebooks…"
			aria-label="Search lorebooks"
			class="input-base"
		/>
	</div>

	<div class="lbt-sort" role="radiogroup" aria-label="Sort lorebooks by">
		{#each SORTS as option (option.id)}
			<button
				type="button"
				role="radio"
				aria-checked={lorebookViewPrefs.order === option.id}
				class="brw-opt"
				class:is-active={lorebookViewPrefs.order === option.id}
				onclick={() => lorebookViewPrefs.setOrder(option.id)}
			>
				{option.label}
			</button>
		{/each}
	</div>
{/if}

<div class="lbt-list">
	{#if visible.length === 0}
		<p class="lbt-note">No lorebooks match “{query}”.</p>
	{:else}
		{#each visible as book (book.id)}
			<button type="button" class="lbt-row" onclick={() => onPick(book.id)}>
				<Icon name="bookOpen" class="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
				<span class="lbt-name">{book.name || 'Untitled lorebook'}</span>
				<!-- Landing in a book that is in every chat is what that press really does, so the
				     row says it here as well as on the shelf. -->
				{#if book.global}
					<LorebookGlobalBadge />
				{/if}
				<span class="lbt-count">{book.entries.length}</span>
			</button>
		{/each}
	{/if}
</div>

<style>
	.lbt-head {
		padding: 0 0.15rem 0.5rem;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.lbt-search {
		margin-bottom: 0.35rem;
	}

	/* Two to a line at this width: "Recently edited" in a third of a 19rem popover is a label
	   with nowhere to go. */
	.lbt-sort {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.375rem;
		margin-bottom: 0.45rem;
	}

	/* An odd chip takes the whole line rather than half of one, which reads as a column that
	   lost its neighbour. */
	.lbt-sort > :last-child:nth-child(odd) {
		grid-column: 1 / -1;
	}

	/* The search stays put while the list scrolls under it. dvh rather than vh: a static one
	   over-measures under a phone browser's chrome and clips the last rows. */
	.lbt-list {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		max-height: min(17rem, 42dvh);
		overflow-y: auto;
	}

	.lbt-note {
		padding: 0.9rem 0.5rem 0.6rem;
		text-align: center;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-muted);
	}

	.lbt-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		/* A destination is a single press, so the row is a thumb target on touch. */
		min-height: 2rem;
		padding: 0.35rem 0.5rem;
		border-radius: var(--radius-md);
		text-align: left;
		cursor: pointer;
		transition: background-color 130ms ease;
	}

	@media (pointer: coarse) {
		.lbt-row {
			min-height: 2.4rem;
		}
	}

	.lbt-row:hover,
	.lbt-row:focus-visible {
		outline: 0;
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	.lbt-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.76rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.lbt-count {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}
</style>
