<script lang="ts">
	/**
	 * One book as a gallery card: the cover fills a 3:4 frame with the name and what the book
	 * holds laid over a scrim, the Library's own gallery card to the geometry.
	 *
	 * A book without a cover is the common case and must still read as a card rather than as a
	 * hole in the grid, so it falls back to the tinted plate the open book's rail wears. That is
	 * also why the meta line is drawn from the book itself and never from the picture: what a
	 * card says is true whether or not anyone set a cover.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import LibraryEntryMenu from '$lib/components/library/LibraryEntryMenu.svelte';
	import LorebookGlobalBadge from './LorebookGlobalBadge.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusAim } from '$lib/utils/portrait-focus';
	import type { Lorebook } from '$lib/lorebook/types';

	interface Props {
		book: Lorebook;
		/** Characters and personas carrying this book. Zero means it never reaches a prompt. */
		links: number;
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
	let name = $derived(book.name || 'Untitled lorebook');
	let count = $derived(book.entries.length);

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
	class="group relative aspect-[3/4] overflow-hidden rounded-[var(--radius-lg)] bg-bg-tertiary cursor-pointer border transition-[transform,box-shadow,border-color] duration-[160ms] ease-out hover:-translate-y-0.5 hover:shadow-md {selected
		? '!border-accent ring-2 ring-accent ring-inset'
		: 'border-border-subtle hover:border-accent/60'}"
>
	{#if selectionMode}
		<!-- Selection checkbox; the whole card toggles, this is just the indicator. -->
		<div
			class="absolute top-2 left-2 z-10 w-7 h-7 rounded-[var(--radius-md)] flex items-center justify-center border-2 backdrop-blur-sm transition-colors
				   {selected ? 'bg-accent border-accent text-white' : 'bg-black/45 border-white/70 text-transparent'}"
		>
			<Icon name="check" class="w-4 h-4" />
		</div>
	{/if}

	{#if cover}
		<img
			src={cover}
			alt={name}
			class="browse-card-portrait absolute inset-0 w-full h-full object-cover"
			style={portraitFocusAim(book.coverFocus)}
			loading="lazy"
		/>
	{:else}
		<div class="lbc-plate absolute inset-0 grid place-items-center">
			<Icon name="bookOpen" class="w-14 h-14" strokeWidth={1} />
		</div>
	{/if}

	<!-- Legibility scrim under the overlaid text -->
	<div
		class="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/95 via-black/55 to-transparent pointer-events-none"
	></div>

	{#if !selectionMode}
		<div
			class="absolute top-2 right-2 flex items-center [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100 transition-opacity"
		>
			<LibraryEntryMenu
				onExport={() => onExport(book.id)}
				exportLabel="Export World Info"
				onDelete={() => onDelete(book.id)}
				triggerClass="icon-btn !w-8 !h-8 !rounded-[var(--radius-md)] !bg-black/45 backdrop-blur-sm !text-white/90 hover:!bg-black/70 hover:!text-white"
			/>
		</div>
	{/if}

	<div class="absolute inset-x-0 bottom-0 p-3.5 flex flex-col gap-1">
		<div class="flex items-center gap-1.5 min-w-0">
			<h3
				class="font-ui font-semibold text-[15px] truncate {book.name ? 'text-white' : 'italic text-white/70'}"
				style="text-shadow: 0 1px 4px rgb(0 0 0 / 0.85), 0 0 2px rgb(0 0 0 / 0.5);"
			>
				{name}
			</h3>
			{#if book.global}
				<LorebookGlobalBadge />
			{/if}
		</div>
		<!-- Not linked is held back behind the badge, the same rule the list row draws. -->
		<p
			class="font-ui text-xs text-white/85 truncate"
			style="text-shadow: 0 1px 3px rgb(0 0 0 / 0.75);"
		>
			{count === 0 ? 'Empty' : `${count} ${count === 1 ? 'entry' : 'entries'}`}
			{#if links > 0}
				<span class="opacity-60"> · </span>{links} linked
			{:else if !book.global}
				<span class="opacity-60"> · </span><span class="italic">Not linked</span>
			{/if}
		</p>
	</div>
</div>

<style>
	/* The open book's own cover plate, so a book with no picture wears the same empty frame
	   wherever it is drawn. */
	.lbc-plate {
		background:
			linear-gradient(
				160deg,
				color-mix(in srgb, var(--color-accent) 12%, transparent),
				transparent 62%
			),
			var(--color-bg-tertiary);
		color: color-mix(in srgb, var(--color-text-muted) 60%, transparent);
	}
</style>
