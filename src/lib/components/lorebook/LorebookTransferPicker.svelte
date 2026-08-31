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
	import { lorebookViewPrefs } from '$lib/stores/lorebookViewPrefs.svelte';

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

	/** Below this the list is short enough to read whole, and a search field costs more
	 *  attention than the scrolling it saves. The number every picker in the app uses. */
	const SEARCH_FROM = 8;

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

{#if books.length >= SEARCH_FROM}
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
