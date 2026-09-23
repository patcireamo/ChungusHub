<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import SoundscapePlayButton from '$lib/components/audio/SoundscapePlayButton.svelte';
	import SettingsPageView from './SettingsPageView.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { SETTINGS_GROUPS, ANCHOR_PAGES, type SettingsPage } from '$lib/config/settings-pages';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	interface Props {
		/** Split view (wide-screen dock): render only the root list with the active
		 *  row tinted: the page itself opens in the centered SettingsContentPanel,
		 *  which Workspace mounts off the same uiStore.settingsPage. */
		split?: boolean;
	}

	let { split = false }: Props = $props();

	// Phone-style drill-down at every width: the root is a grouped index of every
	// settings page with live value previews; each row slides into its page. The
	// old icon tab rail is gone: grouping with text labels replaces it. In split
	// view the drill never happens here: the list stays put and a row click hands
	// the page to the centered panel instead.
	const page = $derived(uiStore.settingsPage as 'root' | SettingsPage);

	// Assistant deep links: navigation.ts routes `settingsPage` directly and also
	// leaves the one-shot anchor for the case where this panel mounts afterwards.
	$effect(() => {
		const anchor = uiStore.pendingSettingsAnchor;
		if (!anchor) return;
		const target = ANCHOR_PAGES[anchor];
		if (target === undefined) return;
		uiStore.pendingSettingsAnchor = null;
		if (page !== target) go(target);
	});

	let navDir = $state(1); // 1 = drilling in (slide from right), -1 = backing out
	let shellEl = $state<HTMLElement | null>(null);

	// The nav bar exists only while a page is open in this panel. Split view never
	// drills here: the dock keeps the root list and the page opens in
	// SettingsContentPanel, which carries its own header.
	const showHead = $derived(!split && page !== 'root');

	/** Where `back()` lands, named on the chip: sub-views peel one level at a time. */
	const backLabel = $derived(
		uiStore.settingsRoutingModel
			? 'Connection'
			: uiStore.settingsConnectionId
				? 'Connections'
				: uiStore.settingsEngineId
					? 'Engines'
					: 'Settings'
	);

	function go(p: SettingsPage): void {
		navDir = 1;
		uiStore.gotoSettingsPage(p);
	}

	function back(): void {
		// Peel sub-views deepest-first: the chip and Escape step routing ← editor ←
		// list ← root (and engine detail ← list), one level per press.
		if (uiStore.settingsRoutingModel) {
			uiStore.settingsRoutingModel = null;
			return;
		}
		if (uiStore.settingsConnectionId) {
			uiStore.settingsConnectionId = null;
			return;
		}
		if (uiStore.settingsEngineId) {
			uiStore.settingsEngineId = null;
			return;
		}
		navDir = -1;
		uiStore.gotoSettingsPage('root');
	}

	function reducedMotion(): boolean {
		return (
			document.documentElement.dataset.motion === 'reduced' ||
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		);
	}

	// Split view re-keys on page changes too (that remount is what refreshes the
	// root previews, exactly like the drill-down's return to root) but must not
	// replay the slide on a persistent list: suppress the motion, keep the remount.
	const flyParams = $derived(
		split || reducedMotion() ? { x: 0, duration: 0 } : { x: navDir * 26, duration: 190, easing: cubicOut }
	);

	// Reset the shell scroll when the page changes (.settings-shell is the
	// scroller). The split-view list keeps its scroll across page switches.
	//
	// The scroller's own scrollTop, never `scrollIntoView` on the page inside it:
	// that aligns the PAGE's top edge with the top of the scrollport, which parks
	// the shell's gutter above it, so any page long enough to scroll would open a
	// gutter's worth down from where it belongs. It would also be free to scroll
	// the workspace behind this panel on its way up.
	$effect(() => {
		void page;
		if (!split && shellEl) shellEl.scrollTop = 0;
	});

	/** Escape steps back to the root before the workspace may close the dock,
	 *  consumed with preventDefault per the shell Esc contract, standing down
	 *  while a Dialog portal owns the key. In split view "back to root" closes
	 *  the centered page panel; the next Escape reaches the workspace. */
	function handlePageKeydown(e: KeyboardEvent): void {
		if (e.key !== 'Escape' || e.defaultPrevented || page === 'root') return;
		if (document.querySelector('.dialog-portal')) return;
		e.preventDefault();
		back();
	}
</script>

<svelte:window onkeydown={handlePageKeydown} />

<div class="settings-root">
	<!-- Outside the scroller on purpose: the way back has to be reachable from the
	     bottom of a long page, and a header that scrolls away is a dead end at
	     exactly the moment it's needed. Same shape SettingsContentPanel already
	     has in split view. -->
	{#if showHead}
		<header class="page-head">
			<button type="button" class="back-btn" onclick={back}>
				<Icon name="chevronLeft" class="w-4 h-4" strokeWidth={2} />
				{backLabel}
			</button>
		</header>
	{/if}

	<div class="settings-shell panel-scroll" bind:this={shellEl}>
		<div class="settings-content">
			{#key page}
				<div class="page" in:fly={flyParams}>
					{#if page === 'root' || split}
						{#each SETTINGS_GROUPS as group (group.label)}
							<div class="group">
								<span class="section-label group-label">{group.label}</span>
								<nav class="drill" aria-label={group.label}>
									<!-- `shown` is read here rather than baked into the config, so a row
									     that comes and goes (Developer) appears and leaves under a list
									     that is already on screen in split view. -->
									{#each group.rows.filter((r) => r.shown?.() ?? true) as row (row.page)}
										<div class="drill-item">
											<button
												type="button"
												class="drill-row"
												class:is-active-tint={split && page === row.page}
												aria-current={split && page === row.page ? 'page' : undefined}
												onclick={() => go(row.page)}
											>
												<Icon name={row.icon} class="w-4 h-4 drill-icon" strokeWidth={1.75} />
												<span class="drill-label">{row.label}</span>
												{#if row.preview}
													<span class="drill-value">{row.preview()}</span>
												{/if}
												{#if row.page === 'soundscapes'}
													<span class="drill-slot" aria-hidden="true"></span>
												{/if}
												<Icon name="chevronRight" class="w-4 h-4 drill-chev" strokeWidth={2} />
											</button>
											<!-- Laid over the slot its row keeps free rather than placed inside the
											     row, since a button cannot hold another. -->
											{#if row.page === 'soundscapes'}
												<span class="drill-accessory">
													<SoundscapePlayButton />
												</span>
											{/if}
										</div>
									{/each}
								</nav>
							</div>
						{/each}
					{:else}
						<SettingsPageView {page} />
					{/if}
				</div>
			{/key}
		</div>
	</div>
</div>

<style>
	.settings-root {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	/* Fixed nav bar over the scroller. Deliberately quieter than the chat overlays'
	   .overlay-header: it carries one chip, not an identity, so it takes the seam
	   and the horizontal inset but none of the height. */
	.page-head {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		padding: 0.5rem 0.8rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	/* .panel-scroll in markup owns the overflow and the reserved gutter. */
	.settings-shell {
		flex: 1;
		min-height: 0;
		overscroll-behavior: contain;
		padding: clamp(0.65rem, 0.5rem + 0.75vw, 1rem);
		/* Transparent so the host surface (frosted dock / overlay with ambient behind)
		   shows through. */
		background: transparent;
	}

	/* Capped and centered at the shared settings measure, exactly like split view's
	   .content-body: without it a page stretches to the whole chat column in the
	   overlay, and every control in a card ends a screen away from its label.
	   A measure, NOT a surface: it carries no card treatment and no padding of its
	   own. Every page is already a stack of `section.card` (and the root a stack of
	   `.drill` groups) painted on the panel the shell frosts, so a card here is a
	   third tier whose only effect is inset: an extra border and ~20px per side
	   between the panel's gutter and the first control. On a page whose whole
	   content is ONE card (Engines, Regex, Advanced) it drew the very same rounded
	   box twice, concentric, with nothing but padding in the gap. The inset that
	   remains is .settings-shell's, which is the panel's gutter. */
	.settings-content {
		max-width: var(--settings-measure);
		margin-inline: auto;
	}

	.page {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	/* ===== Root: grouped drill index ===== */
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.group + .group {
		margin-top: 0.35rem;
	}

	.group-label {
		padding-left: 0.25rem;
	}

	.drill {
		display: flex;
		flex-direction: column;
		padding: 0.3rem;
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 60%, transparent);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 86%, transparent);
	}

	.drill-item {
		--drill-pad-x: 0.65rem;
		--drill-gap: 0.55rem;
		--drill-slot: 2rem;
		display: grid;
		align-items: center;
	}

	.drill-row {
		grid-area: 1 / 1;
		display: flex;
		align-items: center;
		gap: var(--drill-gap);
		width: 100%;
		padding: 0.72rem var(--drill-pad-x);
		border: none;
		border-radius: var(--radius-md);
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background 110ms ease;
	}

	.drill-row:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
	}

	/* Scoped active tint (split view): the canonical .is-active-tint recipe is in a
	   cascade layer, so the unlayered scoped base above would otherwise override it.
	   Placed after :hover so the active row stays tinted while hovered. */
	.drill-row.is-active-tint {
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
	}

	.drill-row.is-active-tint .drill-label,
	.drill-row.is-active-tint :global(.drill-icon) {
		color: var(--color-accent);
	}

	.drill-item + .drill-item > .drill-row {
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 40%, transparent);
	}

	.drill-row :global(.drill-icon) {
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	.drill-label {
		font-family: var(--font-ui);
		font-size: 0.84rem;
		font-weight: 600;
		color: var(--color-text-primary);
		white-space: nowrap;
	}

	.drill-value {
		margin-left: auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-muted);
	}

	.drill-row :global(.drill-chev) {
		color: var(--color-text-muted);
		opacity: 0.65;
		flex-shrink: 0;
		margin-left: auto;
	}

	.drill-row:has(.drill-value) :global(.drill-chev) {
		margin-left: 0;
	}

	.drill-slot {
		flex-shrink: 0;
		width: var(--drill-slot);
	}

	/* Exactly over the slot: past the row's own padding, the chevron (w-4) and the gap before it. */
	.drill-accessory {
		grid-area: 1 / 1;
		justify-self: end;
		z-index: 1;
		display: flex;
		width: var(--drill-slot);
		margin-right: calc(var(--drill-pad-x) + 1rem + var(--drill-gap));
	}

	/* ===== Sub-page back ===== */
	.back-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		padding: 0.3rem 0.65rem 0.3rem 0.35rem;
		border: none;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 110ms ease;
	}

	.back-btn:hover {
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}
</style>
