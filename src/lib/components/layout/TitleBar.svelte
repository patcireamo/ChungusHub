<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import { shortcutLabel } from '$lib/components/ui/ShortcutsSheet.svelte';
	import MemoryNavStatus from '$lib/components/memory/MemoryNavStatus.svelte';
	import { uiStore, type OverlayType } from '$lib/stores/ui.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
	import { memoryStore } from '$lib/memory/store.svelte';

	let activeOverlay = $derived(uiStore.activeOverlay);
	let settingsOpen = $derived(uiStore.settingsOpen);
	let settingsLocked = $derived(uiStore.settingsLocked);
	let libraryOpen = $derived(uiStore.libraryOpen);
	let libraryLocked = $derived(uiStore.libraryLocked);
	// Pinning only matters for a side dock; below the dock width both panels are
	// centered overlays, so the pin is hidden and does nothing on mobile/narrow.
	let canDock = $derived(viewport.canDockSettings);

	const flush = () => lorebookStore.flush();

	const shortcut = shortcutLabel;

	function handleToggleOverlay(overlay: OverlayType) {
		// Toggle: clicking the active button again closes the panel.
		uiStore.toggleOverlay(overlay, flush);
	}

	// The centred navigation cluster: each opens a chat-area overlay. Characters, Personas
	// and Lorebooks all moved into the merged Library dock (the right pill, which reopens on
	// the shelf you left it on); Chats is reached from the composer's hamburger menu.
	type NavItem = {
		overlay: OverlayType;
		icon: 'sliders' | 'sitemap' | 'brain';
		label: string;
		title: string;
	};

	const NAV: NavItem[] = [
		{ overlay: 'presetControls', icon: 'sliders', label: 'Preset Controls', title: 'Preset Controls' },
		{ overlay: 'storymap', icon: 'sitemap', label: 'Story Map', title: 'Story Map' },
		{ overlay: 'memory', icon: 'brain', label: 'Memory', title: 'Memory' }
	];

	// One entry a setting can retire: with the Chat Memory engine globally off the panel
	// has nothing to run, so the button is filtered out rather than opening a dead surface.
	let nav = $derived(
		NAV.filter((item) => item.overlay !== 'memory' || featurePromptsStore.memoryEnabled)
	);

	// Whether the buttons carry their labels is decided against ONE width: the dock
	// regime's column at the current window width (`--chat-col-docked`, measured off
	// the probe below), never the bar's own rendered width. The bar's room is
	// non-monotonic by design: while the docks are held the column squeezes toward
	// its floor, and the moment they vanish it springs back to the content cap
	// (app.css, the dock branch), so a rule that asks "do the labels fit right now"
	// turns the labels back on in the middle of a narrowing drag. The docked column
	// is the tightest form the current window can take and moves only in the
	// window's own direction, so keying on it flips the labels exactly once per
	// direction; below the dock breakpoint the bar is wider than the deciding
	// width, and that slack stays icons-only on purpose. The threshold is the row's
	// own widest state (both split pills with their pins, every nav label) plus
	// room to spare, erring on the side of dropping early: a bar that scrolls or
	// clips is the failure this exists to prevent. In rem, against the live root
	// font size, so browser zoom keeps working.
	//
	// The verdict is stamped on <html> inside the observer callback, synchronously
	// before paint, and app.css's `.overlay-title` reads the same attribute: the
	// panels these buttons raise name themselves exactly while the buttons are bare
	// icons, off one writer, with nothing to keep in step. contracts.test.ts pins
	// the attribute's name and the probe's variable.
	const NAV_LABELS_MIN_REM = 46;
	let navRoomProbe: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!navRoomProbe) return;
		const root = document.documentElement;
		const observer = new ResizeObserver((entries) => {
			const width = entries[entries.length - 1].contentRect.width;
			const rem = parseFloat(getComputedStyle(root).fontSize);
			root.toggleAttribute('data-nav-labels', width >= NAV_LABELS_MIN_REM * rem);
		});
		observer.observe(navRoomProbe);
		return () => {
			observer.disconnect();
			root.removeAttribute('data-nav-labels');
		};
	});

	// Memory is the one entry here that does work on its own, so its button carries that work:
	// MemoryNavStatus renders the glyph and lights it while a pass runs, and the tooltip states
	// it, both from the store's single `standing` derivation, the same line the panel's status
	// row prints, never a second copy.
	// The store holds one chat at a time, so this is always the open chat, and the wording
	// never claims otherwise. Silent when there is nothing to say, back to the plain name.
	//
	// It also rides `aria-label`, because the indicator itself is aria-hidden and the bar's
	// icons-only mode drops the visible label: without it the button would fall back to the
	// tooltip at one width and to a hidden status line at the other. The label always opens
	// with the button's own name, so the visible word stays part of the accessible one.
	let memoryStanding = $derived(memoryStore.standing);
	function titleFor(item: NavItem): string {
		if (item.overlay !== 'memory' || memoryStanding.kind === 'idle') return item.title;
		return `${item.title} · ${memoryStanding.label}`;
	}
</script>

<header class="title-bar">
	<div class="nav-room-probe" aria-hidden="true" bind:this={navRoomProbe}></div>
	<div class="title-bar-inner" data-assistant-snap-column>
		<div class="nav-group nav-group-start">
			<div class="overlay-split" class:is-open={settingsOpen}>
				<button
					type="button"
					class="overlay-split-main"
					class:is-open={settingsOpen}
					title={settingsOpen ? `Close Settings (${shortcut(',')})` : `Settings (${shortcut(',')})`}
					onclick={() => uiStore.toggleSettings(flush)}
				>
					<Icon name="settings" class="w-3.5 h-3.5" />
					<span>Settings</span>
				</button>
				{#if canDock}
					<button
						type="button"
						class="overlay-split-lock"
						class:is-locked={settingsLocked}
						aria-pressed={settingsLocked}
						title={settingsLocked ? 'Pinned open. Click to unpin' : 'Pin open (ignores click-away and other panels)'}
						onclick={() => uiStore.toggleSettingsLock()}
					>
						<Icon name="pin" class="w-4 h-4" />
					</button>
				{/if}
			</div>
		</div>

		<div class="nav-cluster">
			{#each nav as item (item.overlay)}
				<button
					type="button"
					class="overlay-btn"
					class:is-active-tint={activeOverlay === item.overlay}
					title={titleFor(item)}
					aria-label={item.overlay === 'memory' ? titleFor(item) : undefined}
					onclick={() => handleToggleOverlay(item.overlay)}
				>
					{#if item.overlay === 'memory'}
						<MemoryNavStatus icon={item.icon} />
					{:else}
						<Icon name={item.icon} class="w-3.5 h-3.5" />
					{/if}
					<span>{item.label}</span>
				</button>
			{/each}
		</div>

		<div class="nav-group nav-group-end">
			<div class="overlay-split" class:is-open={libraryOpen}>
				{#if canDock}
					<button
						type="button"
						class="overlay-split-lock"
						class:is-locked={libraryLocked}
						aria-pressed={libraryLocked}
						title={libraryLocked ? 'Pinned open. Click to unpin' : 'Pin open (ignores click-away and other panels)'}
						onclick={() => uiStore.toggleLibraryLock()}
					>
						<Icon name="pin" class="w-4 h-4" />
					</button>
				{/if}
				<button
					type="button"
					class="overlay-split-main"
					class:is-open={libraryOpen}
					title={libraryOpen ? `Close Library (${shortcut('L')})` : `Library (${shortcut('L')})`}
					onclick={() => uiStore.toggleLibrary(flush)}
				>
					<Icon name="bookOpen" class="w-3.5 h-3.5" />
					<span>Library</span>
				</button>
			</div>
		</div>
	</div>
</header>

<style>
	.title-bar {
		position: relative;
		/* Grow by the notch/status-bar inset; the content row stays 2.5rem. */
		height: calc(2.5rem + env(safe-area-inset-top, 0px));
		padding-top: env(safe-area-inset-top, 0px);
		flex-shrink: 0;
		background: color-mix(in srgb, var(--color-bg-secondary) 87%, transparent);
		border-bottom: 1px solid var(--color-border-subtle);
		isolation: isolate;
		overflow: visible;
		z-index: 80;
	}

	/* The ruler the label rule measures: the dock regime's column at this window
	   width, whatever regime the window is actually in. Out of flow and invisible,
	   because nothing on screen is this wide below the dock breakpoint; it exists
	   only to hand the ResizeObserver above a width the CSS already knows how to
	   compute, instead of a second JavaScript copy of the column equation. */
	.nav-room-probe {
		position: absolute;
		top: 0;
		left: 0;
		height: 0;
		width: var(--chat-col-docked);
		visibility: hidden;
		pointer-events: none;
	}

	.title-bar-inner {
		/* Capped at the chat column so the end pills sit on the column's edges, the
		   same lines the side docks glue to below. The label decision deliberately
		   does NOT measure this element: see the probe above. */
		height: 100%;
		max-width: var(--chat-col-max);
		margin: 0 auto;
		padding: 0 0.5rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		-webkit-app-region: no-drag;
	}

	.nav-group {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		flex-shrink: 0;
	}

	/* The centred cluster of overlay buttons. It neither scrolls nor shrinks below
	   its content: the label rule guarantees the fit, and if that guarantee ever
	   breaks the overflow paints where it can be seen rather than hiding behind an
	   invisible scrollbar. */
	.nav-cluster {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.overlay-btn {
		/* Anchors the Memory button's status indicator, which is absolutely positioned so the
		   cluster's geometry never depends on what memory is doing. */
		position: relative;
		border: 1px solid transparent;
		background: transparent;
		color: var(--color-text-secondary);
		height: 1.8rem;
		border-radius: var(--radius-md);
		padding: 0 0.62rem;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
		-webkit-app-region: no-drag;
	}

	.overlay-btn:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	/* Scoped active tint: the canonical .is-active-tint recipe is in a cascade layer,
	   so this unlayered scoped base would otherwise override it. Placed after :hover so
	   the open overlay's button stays tinted while hovered. */
	.overlay-btn.is-active-tint {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 33%, transparent);
	}

	/* Settings / Chungus Assistant are split pills: a main toggle segment plus a lock
	   segment that pins the panel open. */
	.overlay-split {
		display: inline-flex;
		align-items: stretch;
		height: 1.8rem;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		overflow: hidden;
		color: var(--color-text-secondary);
		transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
		-webkit-app-region: no-drag;
	}

	.overlay-split.is-open {
		border-color: color-mix(in srgb, var(--color-accent) 32%, transparent);
	}

	.overlay-split-main.is-open {
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		color: var(--color-accent);
	}

	.overlay-split-main,
	.overlay-split-lock {
		border: 0;
		background: transparent;
		color: inherit;
		display: inline-flex;
		align-items: center;
		cursor: pointer;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		white-space: nowrap;
		transition: background-color 140ms ease, color 140ms ease;
		-webkit-app-region: no-drag;
	}

	.overlay-split-main {
		gap: 0.35rem;
		padding: 0 0.5rem 0 0.62rem;
	}

	.overlay-split-lock {
		padding: 0 0.42rem;
		color: var(--color-text-muted);
	}

	.overlay-split-lock:last-child {
		border-left: 1px solid color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
	}

	.overlay-split-lock:first-child {
		border-right: 1px solid color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
	}

	.overlay-split-main:hover,
	.overlay-split-lock:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	.overlay-split-lock.is-locked {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
	}

	/* The pill clips its own rounded corners, and the app's focus ring is drawn OUTSIDE the
	   element it belongs to, so a ring on either half is cut down to the one sliver falling in
	   the seam between them: a bare vertical bar that says nothing about which button has the
	   keyboard. The ring goes on the PILL instead, which nothing clips and whose corners it
	   follows, and the half holding the keyboard says so with a wash of the same accent. Any
	   other control sitting tight inside a clipping box owes itself the same pair.

	   Last in the block, and both halves of that is deliberate: the wash has to beat the open
	   and pinned tints above it, and it touches only `background`, so a pinned pin keeps the
	   accent it says that with. */
	.overlay-split:has(:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.overlay-split-main:focus-visible,
	.overlay-split-lock:focus-visible {
		outline: none;
		background: color-mix(in srgb, var(--color-accent) 26%, transparent);
	}

	/* Without the attribute the script stamps, every button is a bare icon, and the
	   panels these buttons raise name themselves in their own headers instead
	   (`.overlay-title` in app.css reads the same attribute). The rule that grants
	   it sits with the probe in the script above. */
	:global(:root:not([data-nav-labels])) .overlay-btn span,
	:global(:root:not([data-nav-labels])) .overlay-split-main span {
		display: none;
	}

	:global(:root:not([data-nav-labels])) .overlay-btn {
		padding: 0 0.5rem;
	}
</style>
