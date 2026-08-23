<script lang="ts">
	/**
	 * Lorebook link picker: the body of the editor header's Lorebooks popover.
	 * Linked books float to the top (captured once at mount so rows don't jump while
	 * toggling), each row shows what the book actually holds, and a search field
	 * appears once the shelf is big enough to need one.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { sortLorebooks } from '$lib/lorebook/types';
	import { lorebookSortPref } from '$lib/stores/lorebookSort.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';

	interface Props {
		/** Currently-linked lorebook ids. */
		selected: string[];
		/** Called with the next id list whenever a link is toggled. */
		onChange: (ids: string[]) => void;
		/** Called before the picker navigates the user away (create / manage). */
		onNavigate?: () => void;
	}

	let { selected, onChange, onNavigate }: Props = $props();

	let books = $derived(lorebookStore.books);
	let selectedSet = $derived(new Set(selected));

	// Linked books first, then the shared display order (Lorebooks pane → switcher → Sort)
	// within each group. The split is captured once at mount so a toggle restyles the row
	// instead of teleporting it, and the outer sort is stable, so it can't undo that.
	// svelte-ignore state_referenced_locally -- freezing the open-time order is the point
	const linkedAtOpen = new Set(selected);
	let ordered = $derived(
		sortLorebooks(books, lorebookSortPref.order).sort(
			(a, b) => Number(linkedAtOpen.has(b.id)) - Number(linkedAtOpen.has(a.id))
		)
	);

	let query = $state('');
	let visible = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return ordered;
		return ordered.filter((book) => (book.name || 'Untitled lorebook').toLowerCase().includes(q));
	});

	function toggle(id: string) {
		const next = new Set(selectedSet);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		// Preserve store order so the resolved injection order is stable.
		onChange(books.filter((b) => next.has(b.id)).map((b) => b.id));
	}

	function openManager() {
		onNavigate?.();
		uiStore.toggleOverlay('lorebook');
	}

	// Escape clears an active search before it bubbles up and closes the popover.
	function handleSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && query) {
			e.stopPropagation();
			query = '';
		}
	}
</script>

{#if books.length === 0}
	<div class="lbp-empty">
		<span class="lbp-empty-icon">
			<Icon name="bookOpen" class="w-5 h-5" />
		</span>
		<p class="lbp-empty-title">No lorebooks yet</p>
		<p class="lbp-empty-text">
			Lorebooks hold world info that slips into the prompt when its keywords come up.
		</p>
		<button type="button" class="lbp-empty-cta" onclick={openManager}>
			<Icon name="plus" class="w-3.5 h-3.5" />
			Create a lorebook
		</button>
	</div>
{:else}
	<div class="lbp-search">
		<span class="lbp-search-icon">
			<Icon name="search" class="w-3.5 h-3.5" />
		</span>
		<!-- svelte-ignore a11y_autofocus -- the popover was opened to pick from this list -->
		<input
			type="text"
			class="lbp-search-input"
			placeholder="Search lorebooks…"
			bind:value={query}
			onkeydown={handleSearchKeydown}
			autofocus
		/>
	</div>

	<div class="lbp-list" role="group" aria-label="Lorebooks to link">
		{#if visible.length === 0}
			<p class="lbp-no-results">No lorebooks match “{query}”.</p>
		{:else}
			{#each visible as book (book.id)}
				{@const linked = selectedSet.has(book.id)}
				<button
					type="button"
					class="lbp-row"
					class:is-linked={linked}
					aria-pressed={linked}
					onclick={() => toggle(book.id)}
				>
					<span class="lbp-book-icon">
						<Icon name="bookOpen" class="w-3.5 h-3.5" />
					</span>
					<span class="lbp-name">{book.name || 'Untitled lorebook'}</span>
					<span class="lbp-count">{book.entries.length}</span>
					<span class="lbp-check" aria-hidden="true">
						<Icon name="check" class="w-3.5 h-3.5" />
					</span>
				</button>
			{/each}
		{/if}
	</div>

	<div class="lbp-foot">
		<span class="lbp-foot-count">
			{selected.length ? `${selected.length} of ${books.length} linked` : 'Nothing linked yet'}
		</span>
		<button type="button" class="lbp-foot-manage" onclick={openManager}>
			Manage
			<Icon name="arrowRight" class="w-3 h-3" />
		</button>
	</div>
{/if}

<style>
	/* ---- Search ---- */

	.lbp-search {
		position: relative;
		padding: 0.6rem 0.65rem 0.15rem;
	}

	.lbp-search-icon {
		position: absolute;
		left: 1.25rem;
		top: 50%;
		transform: translateY(calc(-50% + 0.14rem));
		display: inline-flex;
		color: var(--color-text-muted);
		pointer-events: none;
	}

	.lbp-search-input {
		width: 100%;
		height: 2rem;
		padding: 0 0.6rem 0 1.85rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
		color: var(--color-text-primary);
		font-family: var(--font-ui);
		font-size: 0.76rem;
	}

	.lbp-search-input::placeholder {
		color: var(--color-text-muted);
	}

	.lbp-search-input:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: var(--color-bg-secondary);
	}

	/* ---- List ---- */

	.lbp-list {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.5rem 0.45rem;
		/* dvh: static vh over-measures under mobile browser chrome and clips the list. */
		max-height: min(17rem, 45dvh);
		overflow-y: auto;
	}

	.lbp-no-results {
		padding: 0.9rem 0.5rem 1rem;
		text-align: center;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-muted);
	}

	.lbp-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.35rem 0.55rem;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		text-align: left;
		cursor: pointer;
		transition: background-color 130ms ease, border-color 130ms ease;
	}

	.lbp-row:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 75%, transparent);
	}

	.lbp-row.is-linked {
		background: color-mix(in srgb, var(--color-accent) 8%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 24%, transparent);
	}

	.lbp-row.is-linked:hover {
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
	}

	.lbp-book-icon {
		flex-shrink: 0;
		display: inline-flex;
		color: var(--color-text-muted);
		transition: color 130ms ease;
	}

	.lbp-row.is-linked .lbp-book-icon {
		color: var(--color-accent);
	}

	.lbp-name {
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

	.lbp-row.is-linked .lbp-name {
		font-weight: 600;
	}

	.lbp-count {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.lbp-check {
		flex-shrink: 0;
		display: inline-flex;
		color: var(--color-accent);
		opacity: 0;
		transform: scale(0.6);
		transition: opacity 130ms ease, transform 130ms ease;
	}

	.lbp-row.is-linked .lbp-check {
		opacity: 1;
		transform: scale(1);
	}

	/* ---- Footer ---- */

	.lbp-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.lbp-foot-count {
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--color-text-muted);
	}

	.lbp-foot-manage {
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		padding: 0.25rem 0.45rem;
		border-radius: var(--radius-sm);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		transition: color 130ms ease, background-color 130ms ease;
	}

	.lbp-foot-manage:hover {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	/* ---- Empty state ---- */

	.lbp-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		padding: 1.4rem 1.2rem 1.3rem;
		text-align: center;
	}

	.lbp-empty-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.6rem;
		height: 2.6rem;
		margin-bottom: 0.2rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
	}

	.lbp-empty-title {
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 650;
		color: var(--color-text-primary);
	}

	.lbp-empty-text {
		max-width: 15rem;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		line-height: 1.5;
		color: var(--color-text-muted);
	}

	.lbp-empty-cta {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.55rem;
		padding: 0.4rem 0.8rem;
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.73rem;
		font-weight: 600;
		transition: background-color 130ms ease, border-color 130ms ease;
	}

	.lbp-empty-cta:hover {
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
	}
</style>
