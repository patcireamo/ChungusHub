<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { CONVERT_ACTION } from '$lib/utils/entry-conversion';
	import type { LibraryEntryType } from '$lib/types/library';

	interface Props {
		/** The kind this card holds: names the conversion item ("Save as persona…" and back).
		 *  Absent on a row that is neither, which is also a row with nothing to convert to. */
		entryType?: LibraryEntryType;
		/** Favorite toggle lives in the menu now (shared across every view mode). */
		isFavorite?: boolean;
		onToggleFavorite?: () => void;
		/** Absent where the shelf has no copy action, e.g. a lorebook row. */
		onDuplicate?: () => void;
		/** Opens the conversion dialog: a persona made from this character, or the reverse. */
		onConvert?: () => void;
		onDelete: () => void;
		/** Set while this entry cannot be deleted (the last persona, architecture/library.md).
		 *  The item stays on screen and goes inert: this sentence is its tooltip, and the tap
		 *  that cannot hover gets it as a refusal instead. */
		deleteBlockedReason?: string;
		/** Present on characters only: adds the SillyTavern export item. */
		onExport?: () => void;
		/** Extra classes for the trigger button (lets card/list style it differently). */
		triggerClass?: string;
	}

	let { entryType, isFavorite = false, onToggleFavorite, onDuplicate, onConvert, onDelete, deleteBlockedReason, onExport, triggerClass = '' }: Props = $props();

	let open = $state(false);
	let triggerRef = $state<HTMLButtonElement | null>(null);
	let menuRef = $state<HTMLDivElement | null>(null);
	let menuStyle = $state('');

	// The trigger lives inside a card with hover transforms and overflow-hidden:
	// both would hijack/clip a fixed-position descendant, so the menu is portaled
	// to <body> (same pattern as Dialog) and positioned off the trigger's rect.
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	function openMenu(e: Event) {
		e.stopPropagation();
		if (open) close();
		else open = true;
	}

	// Position after render so the real menu height is known: open downward,
	// flip above the trigger when the viewport bottom would cut it off.
	$effect(() => {
		if (!open || !menuRef || !triggerRef) return;
		const rect = triggerRef.getBoundingClientRect();
		const menuHeight = menuRef.offsetHeight;
		const below = rect.bottom + 4;
		const top =
			below + menuHeight > window.innerHeight - 8
				? Math.max(8, rect.top - 4 - menuHeight)
				: below;
		const right = Math.max(8, window.innerWidth - rect.right);
		menuStyle = `top: ${top}px; right: ${right}px;`;
	});

	function close() {
		open = false;
		menuStyle = '';
	}

	function run(action: () => void, e: Event) {
		e.stopPropagation();
		close();
		action();
	}

	/** The blocked delete's press. It keeps the menu open, so the tooltip explaining it is
	 *  still under the pointer, and says the same sentence out loud for touch, where there is
	 *  no hover to have read it with. */
	function refuseDelete(e: Event) {
		e.stopPropagation();
		if (deleteBlockedReason) toastStore.error(deleteBlockedReason);
	}

	function handleOutside(e: MouseEvent) {
		const target = e.target as Node;
		if (triggerRef?.contains(target) || menuRef?.contains(target)) return;
		close();
	}

	$effect(() => {
		if (!open) return;
		document.addEventListener('mousedown', handleOutside, true);
		const onScroll = () => close();
		const onKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				// Consume the press so the workspace's global Esc doesn't also
				// close the hosting Library panel.
				e.preventDefault();
				e.stopPropagation();
				close();
			}
		};
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', onScroll);
		window.addEventListener('keydown', onKeydown);
		return () => {
			document.removeEventListener('mousedown', handleOutside, true);
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onScroll);
			window.removeEventListener('keydown', onKeydown);
		};
	});
</script>

<button
	bind:this={triggerRef}
	type="button"
	onclick={openMenu}
	class={triggerClass}
	aria-label="More actions"
	aria-haspopup="menu"
	aria-expanded={open}
	title="More actions"
>
	<Icon name="dotsVertical" class="w-3.5 h-3.5" />
</button>

{#if open}
	<div
		bind:this={menuRef}
		use:portal
		role="menu"
		class="surface-float fixed z-[100] min-w-[150px] py-1 rounded-[var(--radius-lg)]"
		style="{menuStyle || 'visibility: hidden;'} box-shadow: var(--shadow-md);"
	>
		{#if onToggleFavorite}
			<button
				type="button"
				role="menuitem"
				onclick={(e) => run(() => onToggleFavorite?.(), e)}
				class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-ui text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
			>
				<Icon name="heart" class="w-3.5 h-3.5 {isFavorite ? 'fill-current text-red-400' : ''}" />
				{isFavorite ? 'Unfavorite' : 'Favorite'}
			</button>
			<div class="my-1 border-t border-border-subtle"></div>
		{/if}
		{#if onDuplicate}
			<button
				type="button"
				role="menuitem"
				onclick={(e) => run(onDuplicate, e)}
				class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-ui text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
			>
				<Icon name="copy" class="w-3.5 h-3.5" />
				Duplicate
			</button>
		{/if}
		{#if onConvert && entryType}
			<button
				type="button"
				role="menuitem"
				onclick={(e) => run(onConvert, e)}
				class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-ui text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
			>
				<Icon name={CONVERT_ACTION[entryType].icon} class="w-3.5 h-3.5" />
				{CONVERT_ACTION[entryType].label}
			</button>
		{/if}
		{#if onExport}
			<button
				type="button"
				role="menuitem"
				onclick={(e) => run(onExport, e)}
				class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-ui text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
			>
				<Icon name="download" class="w-3.5 h-3.5" />
				Export…
			</button>
		{/if}
		<button
			type="button"
			role="menuitem"
			aria-disabled={deleteBlockedReason ? true : undefined}
			title={deleteBlockedReason}
			onclick={(e) => (deleteBlockedReason ? refuseDelete(e) : run(onDelete, e))}
			class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-ui transition-colors {deleteBlockedReason
				? 'text-text-muted cursor-not-allowed'
				: 'text-error hover:bg-error/10'}"
		>
			<Icon name="trash" class="w-3.5 h-3.5" />
			Delete
		</button>
	</div>
{/if}
