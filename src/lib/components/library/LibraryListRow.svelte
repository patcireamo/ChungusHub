<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import LibraryEntryMenu from './LibraryEntryMenu.svelte';
	import TagList from './TagList.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';
	import type { LibraryEntry } from '$lib/types/library';

	interface Props {
		entry: LibraryEntry;
		/** Marks the active persona in the roster (personas only). */
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
		/** Given, a tag chip toggles that tag in the browse filter. Absent on a surface with no
		 *  tag filter to toggle, which leaves the chips as plain labels. */
		onTagClick?: (tag: string) => void;
		/** The tag strip is opt-in per browse surface: it costs the preview line its second row. */
		showTags?: boolean;
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
		onConvert,
		onTagClick,
		showTags = false
	}: Props = $props();

	function handleRowClick() {
		if (selectionMode) onToggleSelect?.(entry.id);
		else onSelect(entry.id);
	}

	let resolvedImageUrl = $state<string | null>(null);
	let isVisible = $state(false);
	let rowRef = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!rowRef) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) {
					isVisible = true;
					observer.disconnect();
				}
			},
			{ rootMargin: '100px' }
		);
		observer.observe(rowRef);
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
	let tags = $derived(showTags ? (entry.identity.tags ?? []) : []);
	// The row's height is the portrait's, and tags cost a line the preview was using.
	// Giving one back keeps every row the same height, tagged or not.
	let notesClamp = $derived(tags.length > 0 ? 'line-clamp-1' : 'line-clamp-2');

	function stop(e: Event) {
		e.stopPropagation();
	}
</script>

<div
	bind:this={rowRef}
	role="button"
	tabindex="0"
	onclick={handleRowClick}
	onkeydown={(e) => e.key === 'Enter' && e.target === e.currentTarget && handleRowClick()}
	aria-pressed={selectionMode ? selected : undefined}
	class="group flex items-center gap-3 px-4 py-3 rounded-[var(--radius-md)] cursor-pointer transition-colors {selected ? 'bg-accent/10 hover:bg-accent/15' : 'hover:bg-bg-tertiary/55'}"
>
	<!-- Portrait -->
	<div class="relative w-[60px] h-20 shrink-0 rounded-[var(--radius-md)] bg-bg-tertiary overflow-hidden">
		{#if resolvedImageUrl}
			<img
				src={resolvedImageUrl}
				alt={name}
				class="w-full h-full object-cover"
				style={portraitFocusStyle(entry.identity.portraitFocus)}
			/>
		{:else}
			<div class="w-full h-full flex items-center justify-center text-text-muted">
				<Icon name="user" class="w-7 h-7" strokeWidth={1} />
			</div>
		{/if}
		{#if selectionMode}
			<!-- Selection checkbox; the whole row toggles, this is just the indicator. -->
			<div class="absolute inset-0 flex items-center justify-center bg-black/35">
				<div
					class="w-6 h-6 rounded-[var(--radius-md)] flex items-center justify-center border-2 transition-colors
						   {selected ? 'bg-accent border-accent text-white' : 'bg-black/40 border-white/80 text-transparent'}"
				>
					<Icon name="check" class="w-4 h-4" />
				</div>
			</div>
		{/if}
	</div>

	<!-- Name + preview line. Held to the portrait's height (h-20 above) so the name starts
	     at the same place in every row: centred, a short preview would sink it down the row
	     and the list would have no line to be scanned by. -->
	<div class="min-w-0 flex-1 min-h-20">
		<span class="flex items-center gap-1.5 min-w-0">
			<span class="font-ui font-medium text-sm text-text-primary truncate">{name}</span>
			{#if active}
				<span class="shrink-0 text-[10px] font-ui px-1.5 py-0.5 rounded-full bg-accent/14 text-accent border border-accent/30">
					Active
				</span>
			{/if}
		</span>
		{#if notes}
			<p class="mt-1 text-xs text-text-muted {notesClamp} leading-relaxed">{notes}</p>
		{/if}
		{#if tags.length > 0}
			<!-- While selecting, the row's job is the checkbox: a chip that filtered would
			     move entries out from under the selection it just made. -->
			<TagList {tags} onTagClick={selectionMode ? undefined : onTagClick} class="mt-1.5" />
		{/if}
	</div>

	{#if !selectionMode}
		<!-- Read-only favorited indicator; the toggle now lives in the ⋮ menu -->
		{#if entry.isFavorite}
			<Icon name="heart" class="shrink-0 w-4 h-4 text-error fill-current" aria-label="Favorited" />
		{/if}

		<!-- Actions: revealed on hover (pointer devices), always shown on touch -->
		<div class="shrink-0 flex items-center gap-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100 transition-opacity">
			<button
				type="button"
				onclick={(e) => { stop(e); onEdit(entry.id); }}
				class="icon-btn !w-8 !h-8 !rounded-[var(--radius-md)] text-text-muted hover:!bg-bg-tertiary hover:!text-text-primary"
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
				triggerClass="icon-btn !w-8 !h-8 !rounded-[var(--radius-md)] text-text-muted hover:!bg-bg-tertiary hover:!text-text-primary"
			/>
		</div>
	{/if}
</div>
