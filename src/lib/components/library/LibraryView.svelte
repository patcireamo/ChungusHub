<script lang="ts">
	import Icon, { type IconName } from '$lib/components/ui/Icon.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import CharacterLibraryView from './CharacterLibraryView.svelte';
	import PersonasView from './PersonasView.svelte';
	import LorebooksView from '$lib/components/lorebook/LorebooksView.svelte';
	import type { LibraryTab } from '$lib/stores/ui.svelte';

	// The merged Library: a top switcher over the three shelves. Only the active one is
	// mounted, so each view's own $effects (nav-blocker, workspace-focus mirror) run in
	// isolation, with no changes needed inside them.
	let tab = $derived(uiStore.libraryTab);
	const flush = () => lorebookStore.flush();

	const TABS: { id: LibraryTab; icon: IconName; label: string }[] = [
		{ id: 'characters', icon: 'users', label: 'Characters' },
		{ id: 'personas', icon: 'user', label: 'Personas' },
		{ id: 'lorebooks', icon: 'bookOpen', label: 'Lorebooks' }
	];

	// The New chat flow rides this panel: a banner names the current step, the tabs
	// double as the step indicator, and picks in the views drive uiStore's flow state.
	let flowStep = $derived(uiStore.newChatStep);
	let flowCharacterName = $derived.by(() => {
		const id = uiStore.newChatCharacterId;
		if (!id) return null;
		return (
			characterLibraryStore.entries.find((e) => e.id === id)?.identity.name?.trim() || null
		);
	});
</script>

<div class="library-host flex flex-col h-full overflow-hidden">
	{#if flowStep}
		<div class="library-flow" role="status">
			<Icon name="sparkles" class="w-4 h-4" />
			<span class="library-flow-text">
				{#if flowStep === 'character'}
					New chat: choose a character
				{:else if flowCharacterName}
					New chat with {flowCharacterName}: choose your persona
				{:else}
					New chat: choose your persona
				{/if}
			</span>
			<button
				type="button"
				class="library-flow-cancel"
				onclick={() => uiStore.clearNewChat()}
				aria-label="Cancel new chat"
				title="Cancel new chat"
			>
				<Icon name="close" class="w-3.5 h-3.5" />
			</button>
		</div>
	{/if}

	<div class="library-switch">
		<div class="library-tabs" role="tablist" aria-label="Library sections">
			{#each TABS as item (item.id)}
				<button
					type="button"
					role="tab"
					aria-selected={tab === item.id}
					class="library-tab-btn"
					class:is-active-tint={tab === item.id}
					onclick={() => uiStore.setLibraryTab(item.id, flush)}
				>
					<Icon name={item.icon} class="w-4 h-4" strokeWidth={2} />
					<span class="library-tab-label">{item.label}</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="flex-1 min-h-0">
		{#if tab === 'characters'}
			<CharacterLibraryView />
		{:else if tab === 'personas'}
			<PersonasView />
		{:else}
			<LorebooksView />
		{/if}
	</div>
</div>

<style>
	/* The host measures its own width so the tab row can match the browse
	   toolbar's horizontal rhythm (0.75rem in the dock, 1.5rem in the overlay). */
	.library-host {
		container-type: inline-size;
	}

	/* New chat flow banner: an accent-tinted strip above the tabs that names the
	   current step; the X cancels the flow and leaves the panel as a plain browse. */
	.library-flow {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 600;
	}

	.library-flow-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.library-flow-cancel {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.2rem;
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease, background-color 120ms ease;
	}

	.library-flow-cancel:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
	}

	/* Segmented pill switcher, the app's sub-tab language: a bordered, tinted track
	   holding three equal cells that fill the row, so the tabs sit centered instead of
	   hugging the left edge. */
	.library-switch {
		flex-shrink: 0;
		padding: 0.7rem 0.75rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.library-tabs {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.35rem;
		padding: 0.25rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 40%, transparent);
	}

	/* Three cells share a row that is barely 340px wide in a narrow dock, so the glyphs come
	   back only once the panel can carry them beside the longest word. A truncated tab name
	   is the one thing this must never trade for them: the label IS the navigation. */
	.library-tab-btn :global(svg) {
		display: none;
	}

	.library-tab-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.library-tab-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-width: 0;
		height: 2.1rem;
		padding: 0 0.5rem;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 640;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
	}

	.library-tab-btn:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 84%, transparent);
		color: var(--color-text-primary);
	}

	/* Scoped active tint: the shared .is-active-tint recipe lives in a cascade layer,
	   so this unlayered scoped base would override it. Re-apply the recipe values at
	   scoped specificity, after :hover so the active tab stays tinted while hovered. */
	.library-tab-btn.is-active-tint {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 33%, transparent);
	}

	@container (min-width: 27rem) {
		.library-tab-btn :global(svg) {
			display: block;
		}

		.library-tab-btn {
			padding: 0 0.6rem;
		}
	}

	@container (min-width: 640px) {
		.library-switch {
			padding: 0.7rem 1.5rem;
		}

		.library-flow {
			padding: 0.5rem 1.5rem;
		}
	}
</style>
