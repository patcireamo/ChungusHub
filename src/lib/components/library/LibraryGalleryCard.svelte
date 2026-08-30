<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import LibraryEntryMenu from './LibraryEntryMenu.svelte';
	import TagList from './TagList.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusAim } from '$lib/utils/portrait-focus';
	import type { LibraryEntry } from '$lib/types/library';

	interface Props {
		entry: LibraryEntry;
		/** Marks the persona new chats start as (personas only). */
		active?: boolean;
		/** Bulk-selection mode: a click toggles selection instead of opening the entry. */
		selectionMode?: boolean;
		selected?: boolean;
		onToggleSelect?: (id: string) => void;
		onSelect: (id: string) => void;
		onEdit: (id: string) => void;
		onDuplicate: (id: string) => void;
		onDelete: (id: string) => void;
		/** Set while this entry cannot be deleted (the last persona): the ⋮ menu's Delete
		 *  stays put and goes inert, wearing this sentence. */
		deleteBlockedReason?: string;
		onToggleFavorite: (id: string) => void;
		/** Present on characters only: adds the export item to the ⋮ menu. */
		onExport?: (id: string) => void;
		/** Opens the conversion dialog from the ⋮ menu: a persona made from this character, or the reverse. */
		onConvert?: (id: string) => void;
	}

	let {
		entry,
		active = false,
		selectionMode = false,
		selected = false,
		onToggleSelect,
		onSelect,
		onEdit,
		onDuplicate,
		onDelete,
		deleteBlockedReason,
		onToggleFavorite,
		onExport,
		onConvert
	}: Props = $props();

	function handleCardClick() {
		if (selectionMode) onToggleSelect?.(entry.id);
		else onSelect(entry.id);
	}

	let resolvedImageUrl = $state<string | null>(null);
	let isVisible = $state(false);
	let cardRef = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!cardRef) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) {
					isVisible = true;
					observer.disconnect();
				}
			},
			{ rootMargin: '150px' }
		);
		observer.observe(cardRef);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!isVisible) return;
		const imageUrl = entry.identity.imageUrl;
		if (imageUrl) {
			imageService.getThumbnailUrl(imageUrl).then((url) => {
				resolvedImageUrl = url;
			});
		} else {
			resolvedImageUrl = null;
		}
	});

	let name = $derived(
		entry.identity.name || (entry.type === 'character' ? 'Unnamed Character' : 'Unnamed Persona')
	);
	// Characters preview their creator's notes; personas have no notes, so their own
	// description is the natural preview line.
	let notes = $derived(
		entry.type === 'persona'
			? entry.data.traits.description || ''
			: entry.data.traits.creatorNotes || ''
	);
	let tags = $derived(entry.identity.tags || []);

	function stop(e: Event) {
		e.stopPropagation();
	}
</script>

<div
	bind:this={cardRef}
	role="button"
	tabindex="0"
	onclick={handleCardClick}
	onkeydown={(e) => e.key === 'Enter' && e.target === e.currentTarget && handleCardClick()}
	aria-pressed={selectionMode ? selected : undefined}
	class="group relative aspect-[3/4] overflow-hidden rounded-[var(--radius-lg)] bg-bg-tertiary cursor-pointer border transition-[transform,box-shadow,border-color] duration-[160ms] ease-out hover:-translate-y-0.5 hover:shadow-md {selected ? '!border-accent ring-2 ring-accent ring-inset' : 'border-border-subtle hover:border-accent/60'}"
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
	<!-- Portrait fills the whole card -->
	{#if resolvedImageUrl}
		<img
			src={resolvedImageUrl}
			alt={name}
			class="browse-card-portrait absolute inset-0 w-full h-full object-cover"
			style={portraitFocusAim(entry.identity.portraitFocus)}
		/>
	{:else}
		<div class="absolute inset-0 flex items-center justify-center text-text-muted/60">
			<Icon name="user" class="w-16 h-16" strokeWidth={1} />
		</div>
	{/if}

	<!-- Legibility scrim under the overlaid text -->
	<div class="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/95 via-black/55 to-transparent pointer-events-none"></div>

	{#if !selectionMode}
		<!-- Read-only favorited indicator (top-left); the toggle now lives in the ⋮ menu -->
		{#if entry.isFavorite}
			<div class="absolute top-2 left-2 w-8 h-8 rounded-[var(--radius-md)] flex items-center justify-center bg-black/45 backdrop-blur-sm text-error pointer-events-none">
				<Icon name="heart" class="w-4 h-4 fill-current" />
			</div>
		{/if}

		<!-- Edit + ⋮ menu (top-right): revealed on hover, always shown on touch -->
		<div class="absolute top-2 right-2 flex items-center gap-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100 transition-opacity">
			<button
				type="button"
				onclick={(e) => { stop(e); onEdit(entry.id); }}
				class="icon-btn !w-8 !h-8 !rounded-[var(--radius-md)] !bg-black/45 backdrop-blur-sm !text-white/90 hover:!bg-black/70 hover:!text-white"
				aria-label="Edit"
				title="Edit"
			>
				<Icon name="pencil" class="w-4 h-4" />
			</button>
			<LibraryEntryMenu
				isFavorite={entry.isFavorite}
				onToggleFavorite={() => onToggleFavorite(entry.id)}
				onDuplicate={() => onDuplicate(entry.id)}
				onDelete={() => onDelete(entry.id)}
				{deleteBlockedReason}
				onExport={onExport ? () => onExport(entry.id) : undefined}
				entryType={entry.type}
				onConvert={onConvert ? () => onConvert(entry.id) : undefined}
				triggerClass="icon-btn !w-8 !h-8 !rounded-[var(--radius-md)] !bg-black/45 backdrop-blur-sm !text-white/90 hover:!bg-black/70 hover:!text-white"
			/>
		</div>
	{/if}

	<!-- Overlaid identity: name + notes + tags float over the scrim -->
	<div class="absolute inset-x-0 bottom-0 p-3.5 flex flex-col gap-1.5">
		<div class="flex items-center gap-1.5">
			<h3 class="font-ui font-semibold text-[15px] text-white truncate" style="text-shadow: 0 1px 4px rgb(0 0 0 / 0.85), 0 0 2px rgb(0 0 0 / 0.5);">{name}</h3>
			{#if active}
				<span class="shrink-0 text-[10px] font-ui px-1.5 py-0.5 rounded-full bg-accent/14 text-accent border border-accent/30 backdrop-blur-sm">
					Default
				</span>
			{/if}
		</div>

		{#if notes}
			<p class="text-xs text-white/85 line-clamp-2 leading-relaxed" style="text-shadow: 0 1px 3px rgb(0 0 0 / 0.75);">{notes}</p>
		{/if}

		{#if tags.length > 0}
			<TagList {tags} tone="overlay" class="pt-0.5" />
		{/if}
	</div>
</div>
