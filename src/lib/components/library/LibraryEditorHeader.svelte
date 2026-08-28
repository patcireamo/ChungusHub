<script lang="ts">
	/**
	 * Shared header bar for the character/persona editors. One row, two clusters:
	 * identity on the left (name, badge, save state), actions on the right (lorebooks
	 * popover, favorite, overflow menu, close). New entries swap the action cluster
	 * for explicit Save/Discard. Collapses gracefully on narrow screens: labels drop,
	 * icons stay, nothing wraps.
	 */
	import type { Snippet } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import LorebookLinkPicker from '$lib/components/lorebook/LorebookLinkPicker.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { CONVERT_ACTION } from '$lib/utils/entry-conversion';
	import type { LibraryEntryType } from '$lib/types/library';

	interface Props {
		name: string;
		fallbackName: string;
		isNew: boolean;
		/** A commit is in flight: disables the new-entry Save/Discard buttons. */
		busy: boolean;
		/** Unsaved edits exist or a commit is in flight: shows the saving pulse. */
		saving: boolean;
		savedFlash: boolean;
		isFavorite: boolean;
		lorebookIds: string[];
		onLorebookChange: (ids: string[]) => void;
		onToggleFavorite: () => void;
		onDuplicate: () => void;
		onDelete: () => void;
		/** Set while this entry cannot be deleted (the last persona, architecture/library.md).
		 *  The item stays put and goes inert: this sentence is its tooltip, and the tap that
		 *  cannot hover gets it as a refusal instead. */
		deleteBlockedReason?: string;
		onClose: () => void;
		onSaveNew: () => void;
		onDiscardNew: () => void;
		/** Present on characters only: adds the export item to the overflow menu. */
		onExport?: () => void;
		/** The kind being edited: names the conversion item ("Save as persona…" and back). */
		entryType: LibraryEntryType;
		/** Opens the conversion dialog: a persona made from this character, or the reverse. */
		onConvert?: () => void;
		/** Rendered next to the name: version chip (character) or Active pill (persona). */
		badge?: Snippet;
		/** Rendered first in the action cluster, e.g. the persona's Set Active button. */
		primaryAction?: Snippet;
	}

	let {
		name,
		fallbackName,
		isNew,
		busy,
		saving,
		savedFlash,
		isFavorite,
		lorebookIds,
		onLorebookChange,
		onToggleFavorite,
		onDuplicate,
		onDelete,
		deleteBlockedReason,
		onClose,
		onSaveNew,
		onDiscardNew,
		onExport,
		entryType,
		onConvert,
		badge,
		primaryAction
	}: Props = $props();

	let lorebookOpen = $state(false);
	let menuOpen = $state(false);
	let lorebookRef = $state<HTMLDivElement | null>(null);
	let menuRef = $state<HTMLDivElement | null>(null);

	// Deleting a book leaves its id on the entry (architecture/lorebook.md), so the count
	// resolves like every other reader. Counting the raw ids makes a link to a book that is
	// gone read as a live one, and the shelf's remaining book gets the blame.
	let lorebookCount = $derived(lorebookStore.resolveBooks(lorebookIds).length);

	$effect(() => {
		if (!lorebookOpen && !menuOpen) return;
		const onDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (lorebookOpen && lorebookRef && !lorebookRef.contains(target)) lorebookOpen = false;
			if (menuOpen && menuRef && !menuRef.contains(target)) menuOpen = false;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				// Consume the press so the workspace's global Esc doesn't also
				// close the hosting Library panel.
				e.preventDefault();
				e.stopPropagation();
				lorebookOpen = false;
				menuOpen = false;
			}
		};
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});

	function menuItem(action: () => void) {
		return () => {
			menuOpen = false;
			action();
		};
	}

	/** The blocked delete's press. It leaves the menu open, so the tooltip explaining it is
	 *  still under the pointer, and says the same sentence out loud for touch, where there is
	 *  no hover to have read it with. */
	function refuseDelete() {
		if (deleteBlockedReason) toastStore.error(deleteBlockedReason);
	}
</script>

<header class="edh">
	<div class="edh-identity">
		<!-- Muted "name me" placeholder only while the entry is brand-new; once saved without a
		     name, its fallback ("Unnamed Character") reads as a normal name. -->
		<h2 class="edh-name" class:is-empty={!name && isNew}>{name || fallbackName}</h2>
		{@render badge?.()}
		{#if isNew}
			<span class="edh-pill">New</span>
		{:else if saving}
			<span class="edh-status" role="status" aria-label="Saving">
				<span class="edh-status-dot"></span>
				<span class="edh-status-text">Saving…</span>
			</span>
		{:else if savedFlash}
			<span class="edh-status is-saved" role="status" aria-label="Saved">
				<Icon name="check" class="w-3.5 h-3.5" />
				<span class="edh-status-text">Saved</span>
			</span>
		{/if}
	</div>

	<div class="edh-actions">
		{#if !isNew}
			{@render primaryAction?.()}
		{/if}

		<!-- Lorebooks: link standalone world-info books to this entry, right from the bar. -->
		<div class="edh-anchor" bind:this={lorebookRef}>
			<button
				type="button"
				class="edh-chip"
				class:is-open={lorebookOpen}
				class:has-links={lorebookCount > 0}
				onclick={() => (lorebookOpen = !lorebookOpen)}
				aria-haspopup="dialog"
				aria-expanded={lorebookOpen}
				title="Linked lorebooks"
			>
				<Icon name="bookOpen" class="w-4 h-4" />
				<span class="edh-chip-label">Lorebooks</span>
				{#if lorebookCount > 0}
					<span class="edh-chip-count">{lorebookCount}</span>
				{/if}
			</button>
			{#if lorebookOpen}
				<div class="edh-popover surface-float" role="dialog" aria-label="Linked lorebooks">
					<div class="edh-popover-head">
						<p class="edh-popover-title">Lorebooks</p>
					</div>
					<LorebookLinkPicker
						selected={lorebookIds}
						onChange={onLorebookChange}
						onNavigate={() => (lorebookOpen = false)}
					/>
				</div>
			{/if}
		</div>

		{#if isNew}
			<span class="edh-divider"></span>
			<button type="button" class="edh-btn" disabled={busy} onclick={onDiscardNew}>
				Discard
			</button>
			<button type="button" class="edh-btn is-primary" disabled={busy} onclick={onSaveNew}>
				<Icon name="check" class="w-4 h-4" />
				Save
			</button>
		{:else}
			<button
				type="button"
				class="edh-icon"
				class:is-favorite={isFavorite}
				onclick={onToggleFavorite}
				aria-label={isFavorite ? 'Unfavorite' : 'Favorite'}
				aria-pressed={isFavorite}
				title={isFavorite ? 'Unfavorite' : 'Favorite'}
			>
				<Icon name="heart" class="w-4 h-4 {isFavorite ? 'fill-current' : ''}" />
			</button>

			<div class="edh-anchor" bind:this={menuRef}>
				<button
					type="button"
					class="edh-icon"
					class:is-open={menuOpen}
					onclick={() => (menuOpen = !menuOpen)}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					aria-label="More actions"
					title="More actions"
				>
					<Icon name="dotsVertical" class="w-4 h-4" />
				</button>
				{#if menuOpen}
					<div class="edh-menu surface-float" role="menu">
						{#if onExport}
							<button type="button" role="menuitem" class="edh-menu-item" onclick={menuItem(onExport)}>
								<Icon name="download" class="w-4 h-4" />
								Export…
							</button>
						{/if}
						<button type="button" role="menuitem" class="edh-menu-item" onclick={menuItem(onDuplicate)}>
							<Icon name="copy" class="w-4 h-4" />
							Duplicate
						</button>
						{#if onConvert}
							<button type="button" role="menuitem" class="edh-menu-item" onclick={menuItem(onConvert)}>
								<Icon name={CONVERT_ACTION[entryType].icon} class="w-4 h-4" />
								{CONVERT_ACTION[entryType].label}
							</button>
						{/if}
						<div class="edh-menu-sep"></div>
						<button
							type="button"
							role="menuitem"
							class="edh-menu-item"
							class:is-danger={!deleteBlockedReason}
							class:is-blocked={!!deleteBlockedReason}
							aria-disabled={deleteBlockedReason ? true : undefined}
							title={deleteBlockedReason}
							onclick={deleteBlockedReason ? refuseDelete : menuItem(onDelete)}
						>
							<Icon name="trash" class="w-4 h-4" />
							Delete
						</button>
					</div>
				{/if}
			</div>

			<span class="edh-divider"></span>

			<button type="button" class="edh-icon" onclick={onClose} aria-label="Close editor" title="Close">
				<Icon name="close" class="w-[1.15rem] h-[1.15rem]" />
			</button>
		{/if}
	</div>
</header>

<style>
	.edh {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-height: 3.75rem;
		padding: 0.6rem 1rem 0.6rem 1.5rem;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
	}

	/* ---- Identity cluster ---- */

	.edh-identity {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-width: 0;
		flex: 1;
	}

	.edh-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 1.05rem;
		font-weight: 650;
		color: var(--color-text-primary);
	}

	.edh-name.is-empty {
		color: var(--color-text-muted);
		font-weight: 500;
		font-style: italic;
	}

	.edh-pill {
		flex-shrink: 0;
		padding: 0.15rem 0.55rem;
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-accent) 15%, transparent);
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.62rem;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.edh-status {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.32rem;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.7rem;
	}

	.edh-status.is-saved {
		color: var(--color-success);
	}

	.edh-status-dot {
		width: 0.42rem;
		height: 0.42rem;
		border-radius: var(--radius-full);
		background: currentColor;
		animation: edh-pulse 1.1s ease-in-out infinite;
	}

	@keyframes edh-pulse {
		0%, 100% { opacity: 0.35; }
		50% { opacity: 1; }
	}

	/* ---- Action cluster ---- */

	.edh-actions {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	.edh-anchor {
		position: relative;
	}

	.edh-divider {
		width: 1px;
		height: 1.35rem;
		margin: 0 0.3rem;
		background: var(--color-border-subtle);
	}

	.edh-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		transition: background-color 140ms ease, color 140ms ease, transform 120ms ease;
	}

	.edh-icon:hover,
	.edh-icon.is-open {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
	}

	.edh-icon:active {
		transform: translateY(1px);
	}

	.edh-icon.is-favorite {
		color: var(--color-error);
	}

	.edh-icon.is-favorite:hover {
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
	}

	.edh-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		height: 2.25rem;
		padding: 0 0.7rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		transition: color 140ms ease, border-color 140ms ease, background-color 140ms ease;
	}

	.edh-chip:hover,
	.edh-chip.is-open {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-accent) 36%, transparent);
	}

	.edh-chip.has-links {
		color: var(--color-text-primary);
	}

	.edh-chip-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.15rem;
		height: 1.15rem;
		padding: 0 0.3rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
		color: var(--color-accent);
		font-size: 0.66rem;
		font-weight: 700;
	}

	.edh-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		height: 2.25rem;
		padding: 0 0.9rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 600;
		transition: color 140ms ease, border-color 140ms ease, background-color 140ms ease, opacity 140ms ease;
	}

	.edh-btn:hover:not(:disabled) {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
	}

	.edh-btn.is-primary {
		border-color: transparent;
		background: var(--color-accent);
		color: var(--color-on-accent);
	}

	.edh-btn.is-primary:hover:not(:disabled) {
		background: var(--color-accent-hover);
		color: var(--color-on-accent);
	}

	.edh-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	/* ---- Popovers ---- */

	.edh-popover {
		position: absolute;
		top: calc(100% + 0.4rem);
		right: 0;
		z-index: 50;
		width: min(21rem, calc(100vw - 2rem));
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		overflow: hidden;
	}

	.edh-popover-head {
		padding: 0.7rem 0.9rem 0.15rem;
		text-align: center;
	}

	.edh-popover-title {
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 650;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-accent);
	}

	.edh-menu {
		position: absolute;
		top: calc(100% + 0.4rem);
		right: 0;
		z-index: 50;
		min-width: 11rem;
		padding: 0.3rem;
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
	}

	.edh-menu-item {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius-md);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.78rem;
		text-align: left;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.edh-menu-item:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	.edh-menu-item.is-danger:hover {
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
		color: var(--color-error);
	}

	/* Inert but present: it reads as a row that is out of reach right now, and its tooltip
	   says why. No hover response at all, or the row would look like it still acts. */
	.edh-menu-item.is-blocked {
		color: var(--color-text-muted);
		cursor: not-allowed;
	}

	.edh-menu-item.is-blocked:hover {
		background: transparent;
		color: var(--color-text-muted);
	}

	.edh-menu-sep {
		height: 1px;
		margin: 0.3rem 0.4rem;
		background: var(--color-border-subtle);
	}

	/* ---- Narrow screens: labels drop, icons stay, one row holds. ---- */

	@media (max-width: 640px) {
		.edh {
			min-height: 3.25rem;
			padding: 0.5rem 0.6rem 0.5rem 0.9rem;
			gap: 0.5rem;
		}

		.edh-name {
			font-size: 0.92rem;
		}

		.edh-status-text,
		.edh-chip-label {
			display: none;
		}

		.edh-chip {
			padding: 0 0.55rem;
			gap: 0.3rem;
		}

		.edh-actions {
			gap: 0.15rem;
		}

		.edh-divider {
			margin: 0 0.15rem;
		}
	}
</style>
