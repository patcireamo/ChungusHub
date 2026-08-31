<script lang="ts">
	/**
	 * One book on the Lorebooks shelf: the Library list row, to the geometry. Same 60x80
	 * frame, so a cover is drawn in the shape it was authored and framed in, and so the two
	 * shelves scan as one list rather than as a tall one and a short one. It holds the book
	 * glyph where there is no cover, which is most books, and the row's height is the frame's
	 * either way.
	 *
	 * The meta line answers the two questions a shelf is scanned for: how big the book is,
	 * and whether anything carries it. It deliberately does NOT price the book in tokens:
	 * that is a BPE pass per book, so an archive would pay for every row on every keystroke,
	 * and the figure belongs on the page where one book is decided about anyway.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import LibraryEntryMenu from '$lib/components/library/LibraryEntryMenu.svelte';
	import LorebookGlobalBadge from './LorebookGlobalBadge.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';
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

	let cover = $derived(imageService.thumbnailUrl(book.cover));
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
	class="group flex items-center gap-3 px-4 py-3 rounded-[var(--radius-md)] cursor-pointer transition-colors {selected
		? 'bg-accent/10 hover:bg-accent/15'
		: 'hover:bg-bg-tertiary/55'}"
>
	<!-- The cover, in the character row's own frame: 3:4, which is the shape it was authored
	     and framed in. -->
	<div
		class="relative w-[60px] h-20 shrink-0 grid place-items-center rounded-[var(--radius-md)] bg-bg-tertiary text-text-muted overflow-hidden"
	>
		{#if cover}
			<img
				src={cover}
				alt=""
				class="w-full h-full object-cover"
				style={portraitFocusStyle(book.coverFocus)}
				loading="lazy"
			/>
		{:else}
			<Icon name="bookOpen" class="w-7 h-7" strokeWidth={1} />
		{/if}
		{#if selectionMode}
			<!-- Selection checkbox; the whole row toggles, this is just the indicator. -->
			<div class="absolute inset-0 grid place-items-center bg-black/35">
				<div
					class="w-6 h-6 rounded-[var(--radius-md)] flex items-center justify-center border-2 transition-colors
						   {selected
						? 'bg-accent border-accent text-white'
						: 'bg-black/40 border-white/80 text-transparent'}"
				>
					<Icon name="check" class="w-4 h-4" />
				</div>
			</div>
		{/if}
	</div>

	<!-- Held to the frame's height, so the name starts at the same place in every row: centred,
	     it would sink down the row and the list would have no line to be scanned by. -->
	<div class="min-w-0 flex-1 min-h-20 pt-1">
		<span class="flex items-center gap-1.5 min-w-0">
			<span
				class="font-ui text-sm truncate {book.name
					? 'font-medium text-text-primary'
					: 'italic text-text-muted'}"
			>
				{book.name || 'Untitled lorebook'}
			</span>
			{#if book.global}
				<LorebookGlobalBadge />
			{/if}
		</span>
		<!-- Not linked is held back behind the badge: a book the badge says is in every chat
		     must not also read as one nothing uses. The link count still shows, since a global
		     book a card ALSO links is a fact neither line says on its own. -->
		<p class="mt-1 font-ui text-xs text-text-muted truncate">
			{size}
			{#if links > 0}
				<span class="opacity-60"> · </span>{links} linked
			{:else if !book.global}
				<span class="opacity-60"> · </span><span class="italic">Not linked</span>
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
				exportLabel="Export World Info"
				onDelete={() => onDelete(book.id)}
				triggerClass="icon-btn !w-8 !h-8 !rounded-[var(--radius-md)] text-text-muted hover:!bg-bg-tertiary hover:!text-text-primary"
			/>
		</div>
	{/if}
</div>
