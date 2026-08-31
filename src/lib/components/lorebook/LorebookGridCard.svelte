<script lang="ts">
	/**
	 * One book as a grid tile: the cover over a name, the Library's dense card to the geometry.
	 * Name-only under the picture is the whole reason this mode exists, so the entry and link
	 * counts the other two shapes carry are deliberately left to them.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import LibraryEntryMenu from '$lib/components/library/LibraryEntryMenu.svelte';
	import LorebookGlobalBadge from './LorebookGlobalBadge.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusAim } from '$lib/utils/portrait-focus';
	import type { Lorebook } from '$lib/lorebook/types';

	interface Props {
		book: Lorebook;
		selectionMode?: boolean;
		selected?: boolean;
		onToggleSelect?: (id: string) => void;
		onOpen: (id: string) => void;
		onExport: (id: string) => void;
		onDelete: (id: string) => void;
	}

	let {
		book,
		selectionMode = false,
		selected = false,
		onToggleSelect,
		onOpen,
		onExport,
		onDelete
	}: Props = $props();

	let cover = $derived(imageService.thumbnailUrl(book.cover));
	let name = $derived(book.name || 'Untitled lorebook');

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
	class="group relative flex flex-col bg-bg-secondary border rounded-[var(--radius-lg)] overflow-hidden hover:-translate-y-0.5 hover:shadow-md transition-[border-color,box-shadow,transform] duration-[160ms] ease-out text-left w-full cursor-pointer {selected
		? '!border-accent ring-2 ring-accent ring-inset'
		: 'border-border-subtle hover:border-accent'}"
>
	<div class="relative w-full aspect-[3/4] bg-bg-tertiary overflow-hidden">
		{#if selectionMode}
			<!-- Selection checkbox; the whole card toggles, this is just the indicator. -->
			<div
				class="absolute top-2 left-2 z-10 w-6 h-6 rounded-[var(--radius-md)] flex items-center justify-center border-2 transition-colors
					   {selected ? 'bg-accent border-accent text-white' : 'bg-black/55 border-white/70 text-transparent'}"
			>
				<Icon name="check" class="w-4 h-4" />
			</div>
		{/if}

		{#if cover}
			<img
				src={cover}
				alt={name}
				class="browse-card-portrait w-full h-full object-cover"
				style={portraitFocusAim(book.coverFocus)}
				loading="lazy"
			/>
		{:else}
			<div class="lbc-plate w-full h-full grid place-items-center">
				<Icon name="bookOpen" class="w-10 h-10" strokeWidth={1} />
			</div>
		{/if}

		{#if !selectionMode}
			<div
				class="absolute top-2 right-2 flex items-center [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100 transition-opacity"
			>
				<LibraryEntryMenu
					onExport={() => onExport(book.id)}
					exportLabel="Export World Info"
					onDelete={() => onDelete(book.id)}
					triggerClass="icon-btn !w-7 !h-7 !rounded-[var(--radius-md)] !bg-black/55 !text-white/90 hover:!bg-bg-tertiary hover:!text-text-primary"
				/>
			</div>
		{/if}
	</div>

	<div class="px-2.5 py-2 flex items-center gap-1.5">
		<span
			class="min-w-0 font-ui text-[13px] truncate {book.name
				? 'font-medium text-text-primary'
				: 'italic text-text-muted'}"
		>
			{name}
		</span>
		{#if book.global}
			<LorebookGlobalBadge />
		{/if}
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
