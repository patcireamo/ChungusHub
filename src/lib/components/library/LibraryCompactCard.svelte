<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import LibraryEntryMenu from './LibraryEntryMenu.svelte';
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

	let resolvedImageUrl = $state<string | null>(null);
	let isVisible = $state(false);
	let cardRef = $state<HTMLDivElement | null>(null);

	// Lazy loading: only resolve image when card becomes visible
	$effect(() => {
		if (!cardRef) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) {
					isVisible = true;
					observer.disconnect();
				}
			},
			{ rootMargin: '100px' } // Start loading 100px before entering viewport
		);

		observer.observe(cardRef);
		return () => observer.disconnect();
	});

	// Only load thumbnail once visible
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

	function getName(): string {
		return entry.identity.name || (entry.type === 'character' ? 'Unnamed Character' : 'Unnamed Persona');
	}

	function handleCardClick() {
		if (selectionMode) onToggleSelect?.(entry.id);
		else onSelect(entry.id);
	}

	function handleEdit(e: Event) {
		e.stopPropagation();
		onEdit(entry.id);
	}
</script>

<div
	bind:this={cardRef}
	role="button"
	tabindex="0"
	onclick={handleCardClick}
	onkeydown={(e) => e.key === 'Enter' && e.target === e.currentTarget && handleCardClick()}
	aria-pressed={selectionMode ? selected : undefined}
	class="group relative flex flex-col bg-bg-secondary border rounded-[var(--radius-lg)] overflow-hidden hover:-translate-y-0.5 hover:shadow-md transition-[border-color,box-shadow,transform] duration-[160ms] ease-out text-left w-full cursor-pointer {selected ? '!border-accent ring-2 ring-accent ring-inset' : 'border-border-subtle hover:border-accent'}"
>
	<!-- Image Section -->
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
		{#if resolvedImageUrl}
			<img
				src={resolvedImageUrl}
				alt={getName()}
				class="browse-card-portrait w-full h-full object-cover"
				style={portraitFocusAim(entry.identity.portraitFocus)}
			/>
		{:else}
			<div class="w-full h-full flex items-center justify-center text-text-muted">
				<Icon name="user" class="w-12 h-12" strokeWidth={1} />
			</div>
		{/if}

		{#if !selectionMode}
			<!-- Read-only favorited indicator; the toggle now lives in the ⋮ menu -->
			{#if entry.isFavorite}
				<div class="absolute top-2 left-2 w-7 h-7 rounded-[var(--radius-md)] flex items-center justify-center bg-black/55 text-error pointer-events-none">
					<Icon name="heart" class="w-3.5 h-3.5 fill-current" />
				</div>
			{/if}

			<!-- Edit + ⋮ menu (favorite / duplicate / delete): revealed on hover, always shown on touch -->
			<div class="absolute top-2 right-2 flex items-center gap-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100 transition-opacity">
				<button
					type="button"
					onclick={handleEdit}
					class="icon-btn !w-7 !h-7 !rounded-[var(--radius-md)] !bg-black/55 !text-white/90 hover:!bg-bg-tertiary hover:!text-text-primary"
					aria-label="Edit"
					title="Edit"
				>
					<Icon name="pencil" class="w-3.5 h-3.5" />
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
					triggerClass="icon-btn !w-7 !h-7 !rounded-[var(--radius-md)] !bg-black/55 !text-white/90 hover:!bg-bg-tertiary hover:!text-text-primary"
				/>
			</div>
		{/if}

	</div>

	<!-- Content Section: name only (the dense "tiles" view) -->
	<div class="px-2.5 py-2 flex items-center gap-1.5">
		<span class="font-ui font-medium text-[13px] text-text-primary truncate">{getName()}</span>
		{#if active}
			<span class="shrink-0 ml-auto text-[10px] font-ui px-1.5 py-0.5 rounded-full bg-accent/14 text-accent border border-accent/30">
				Default
			</span>
		{/if}
	</div>
</div>
