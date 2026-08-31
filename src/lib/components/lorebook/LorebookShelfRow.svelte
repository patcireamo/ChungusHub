<script lang="ts">
	/**
	 * One book on the Lorebooks shelf. The Library list row's geometry with the portrait
	 * replaced by a glyph tile, since a book has no picture and a shelf of empty frames
	 * would be a taller list saying nothing.
	 *
	 * The meta line answers the two questions a shelf is scanned for: how big the book is,
	 * and whether anything carries it. It deliberately does NOT price the book in tokens:
	 * that is a BPE pass per book, so an archive would pay for every row on every keystroke,
	 * and the figure belongs on the page where one book is decided about anyway.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import LibraryEntryMenu from '$lib/components/library/LibraryEntryMenu.svelte';
	import type { Lorebook } from '$lib/lorebook/types';

	interface Props {
		book: Lorebook;
		/** Characters and personas carrying this book. Zero means it never reaches a prompt. */
		links: number;
		/** Bulk-selection mode: a press toggles selection instead of opening the book. */
		selectionMode?: boolean;
		selected?: boolean;
		onToggleSelect?: (id: string) => void;
		onOpen: (id: string) => void;
		onExport: (id: string) => void;
		onDelete: (id: string) => void;
	}

	let {
		book,
		links,
		selectionMode = false,
		selected = false,
		onToggleSelect,
		onOpen,
		onExport,
		onDelete
	}: Props = $props();

	let count = $derived(book.entries.length);
	let size = $derived(count === 0 ? 'Empty' : `${count} ${count === 1 ? 'entry' : 'entries'}`);

	function press() {
		if (selectionMode) onToggleSelect?.(book.id);
		else onOpen(book.id);
	}
</script>

<div
	role="button"
	tabindex="0"
	onclick={press}
	onkeydown={(e) => e.key === 'Enter' && e.target === e.currentTarget && press()}
	aria-pressed={selectionMode ? selected : undefined}
	class="group flex items-center gap-3 px-4 py-2.5 rounded-[var(--radius-md)] cursor-pointer transition-colors {selected
		? 'bg-accent/10 hover:bg-accent/15'
		: 'hover:bg-bg-tertiary/55'}"
>
	<div
		class="relative w-10 h-10 shrink-0 grid place-items-center rounded-[var(--radius-md)] bg-bg-tertiary text-text-muted overflow-hidden"
	>
		<Icon name="bookOpen" class="w-5 h-5" strokeWidth={1.5} />
		{#if selectionMode}
			<!-- Selection checkbox; the whole row toggles, this is just the indicator. -->
			<div class="absolute inset-0 grid place-items-center bg-black/35">
				<div
					class="w-5 h-5 rounded-[var(--radius-sm)] flex items-center justify-center border-2 transition-colors
						   {selected
						? 'bg-accent border-accent text-white'
						: 'bg-black/40 border-white/80 text-transparent'}"
				>
					<Icon name="check" class="w-3.5 h-3.5" />
				</div>
			</div>
		{/if}
	</div>

	<div class="min-w-0 flex-1">
		<span
			class="block font-ui text-sm truncate {book.name
				? 'font-medium text-text-primary'
				: 'italic text-text-muted'}"
		>
			{book.name || 'Untitled lorebook'}
		</span>
		<p class="mt-0.5 font-ui text-xs text-text-muted truncate">
			{size}
			<span class="opacity-60"> · </span>
			{#if links > 0}
				{links} linked
			{:else}
				<span class="italic">Not linked</span>
			{/if}
		</p>
	</div>

	{#if !selectionMode}
		<!-- Actions: revealed on hover (pointer devices), always shown on touch -->
		<div
			class="shrink-0 flex items-center [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100 transition-opacity"
		>
			<LibraryEntryMenu
				onExport={() => onExport(book.id)}
				onDelete={() => onDelete(book.id)}
				triggerClass="icon-btn !w-8 !h-8 !rounded-[var(--radius-md)] text-text-muted hover:!bg-bg-tertiary hover:!text-text-primary"
			/>
		</div>
	{/if}
</div>
