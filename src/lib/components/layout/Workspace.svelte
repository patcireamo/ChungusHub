<script lang="ts">
	import ChatContainer from '$lib/components/chat/ChatContainer.svelte';
	import LibraryView from '$lib/components/library/LibraryView.svelte';
	import LibraryEditorOverlay from '$lib/components/library/LibraryEditorOverlay.svelte';
	import LorebookView from '$lib/components/lorebook/LorebookView.svelte';
	import PresetControlsView from '$lib/components/presetControls/PresetControlsView.svelte';
	import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte';
	import SettingsContentPanel from '$lib/components/settings/SettingsContentPanel.svelte';
	import AssistantFloatingWidget from '$lib/components/assistant/AssistantFloatingWidget.svelte';
	import ChatsView from '$lib/components/sidebar/ChatsView.svelte';
	import StoryMapView from '$lib/components/storymap/StoryMapView.svelte';
	import MemoryPanel from '$lib/components/memory/MemoryPanel.svelte';
	import StatsView from '$lib/components/stats/StatsView.svelte';
	import WelcomeView from '$lib/components/layout/WelcomeView.svelte';
	import AmbientCanvas from '$lib/components/ambient/AmbientCanvas.svelte';
	import PromptDebugPanel from '$lib/components/debug/PromptDebugPanel.svelte';
	import PromptReviewDialog from '$lib/components/chat/PromptReviewDialog.svelte';
	import { fade, fly } from 'svelte/transition';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { ambientStore } from '$lib/stores/ambient.svelte';
	import { backgroundStore } from '$lib/stores/background.svelte';
	import { advancedSettingsStore } from '$lib/stores/advanced-settings.svelte';
	import { generalSettingsStore } from '$lib/stores/general-settings.svelte';
	import { promptLogStore } from '$lib/debug/promptLog.svelte';
	import ShortcutsSheet from '$lib/components/ui/ShortcutsSheet.svelte';
	import HintLayer from '$lib/components/layout/HintLayer.svelte';
	import { matchShortcut } from '$lib/commands/shortcuts.svelte';
	import { chatCursor } from '$lib/stores/chatCursor.svelte';

	let activeOverlay = $derived(uiStore.activeOverlay);
	let welcomeOpen = $derived(uiStore.welcomeOpen);
	let settingsOpen = $derived(uiStore.settingsOpen);
	let canDock = $derived(viewport.canDockSettings);

	// Ambient is a single workspace-wide layer behind every panel, so the chat,
	// Settings, Library, Lorebook, Chats and Assistant all share the same effect.
	// `particlesOverMessages` flips it between a backdrop (behind translucent
	// surfaces) and an overlay that floats above every panel.
	let ambientConfig = $derived(ambientStore.config);
	let ambientTypes = $derived(ambientConfig.types);
	let particlesOverMessages = $derived(ambientConfig.particlesOverMessages);
	let ambientVisible = $derived(ambientConfig.enabled && ambientTypes.length > 0);

	// Background image: the workspace's bottom-most layer. Ambient particles, the
	// chat and every panel paint over it; dim darkens it so text stays readable
	// on any picture (black or theme-tinted per the Shade setting).
	let backgroundUrl = $derived(backgroundStore.url);
	let backgroundDim = $derived(backgroundStore.config.dim);
	let backgroundBlur = $derived(backgroundStore.config.blur);

	// Settings: a left-margin dock on wide screens, a chat-area overlay on narrow ones.
	let settingsDocked = $derived(settingsOpen && canDock);
	let settingsOverlay = $derived(settingsOpen && !canDock);

	// Split settings view (wide screens, default on): the dock keeps the root list
	// and the selected page opens wide and centered, the Library entry editor's
	// pattern. Below dock widths the preference is inert (Settings is a single
	// centered overlay there, drill-down as always).
	let settingsSplit = $derived(settingsDocked && generalSettingsStore.settingsSplitView);
	let settingsContentOpen = $derived(settingsSplit && uiStore.settingsPage !== 'root');

	// Merged Library: mirrors Settings but docks into the right margin instead.
	let libraryOpen = $derived(uiStore.libraryOpen);
	let libraryDocked = $derived(libraryOpen && canDock);
	let libraryOverlay = $derived(libraryOpen && !canDock);
	// A side-snapped Assistant uses the same native seam as a dock. Its transient side
	// state only extends the chat/welcome tint; it does not enter panel choreography.
	let assistantSnapSide = $derived(uiStore.assistantSnapSide);

	// The entry editor pops out of the dock into a wide, centered overlay over the
	// chat. The dock picks which entry (character or persona) it edits.
	let libraryEditorOpen = $derived(libraryOpen && uiStore.libraryEditorId != null);

	// Chats: a centered modal popup over a dimmed workspace on desktop, so the
	// chat stays visible behind it. On phones it falls back to the full chat-area
	// overlay like every other panel.
	let chatsPopup = $derived(activeOverlay === 'chats' && !viewport.isMobile);

	// Prompt debug panel: an opt-in dev tool. Keep the transport-level capture flag in
	// sync with the Advanced toggle so logging turns on/off the moment it's flipped.
	let promptDebugEnabled = $derived(advancedSettingsStore.promptDebugPanel);
	$effect(() => {
		const on = advancedSettingsStore.promptDebugPanel;
		promptLogStore.setEnabled(on);
		if (!on) uiStore.closeDebugPanel();
	});

	// Full-cover overlays (chat-area panels) take over the chat column. We hide the
	// chat beneath them instead of stacking on top, so the panel can be translucent
	// and show the ambient behind it without the chat bleeding through. Side docks
	// don't cover the chat, so they don't count. The welcome landing covers the chat
	// the same way, and any chat-area overlay covers (but never closes) the welcome.
	let coveringOverlay = $derived(
		(activeOverlay !== null && !chatsPopup) ||
			settingsOverlay ||
			settingsContentOpen ||
			libraryOverlay ||
			libraryEditorOpen ||
			(promptDebugEnabled && uiStore.debugPanelOpen)
	);
	let chatCovered = $derived(welcomeOpen || coveringOverlay);

	let workspaceEl = $state<HTMLElement | undefined>(undefined);

	// Click-away dismiss: pressing anywhere outside a panel (the empty margins or
	// the chat itself) closes whatever is open. Clicks on a panel, or on the
	// title-bar toggles (which live outside the workspace), are left alone. Pinned
	// (locked) side docks ignore the click-away entirely.
	function handleBackgroundMouseDown(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		if (!target || !workspaceEl || !workspaceEl.contains(target)) return;
		// Clicks on a panel are left alone, except the welcome landing, which is the
		// workspace backdrop here: clicking it dismisses the side docks like the margins
		// do (it never closes itself, so falling through is safe). Its own controls are
		// exempt: the landing stays live under a docked panel, so dismissing that dock on
		// mousedown would turn a control's toggle into a close-then-reopen.
		const panel = target.closest('[data-panel]');
		if (panel && (!panel.hasAttribute('data-welcome') || target.closest('button, a'))) return;

		// A margin/chat click dismisses whatever panel is open over the workspace. The
		// welcome landing is never touched here: only opening a chat retires it.
		if (activeOverlay) uiStore.closeOverlay(() => lorebookStore.flush());
		if (settingsOpen && !uiStore.settingsLocked) uiStore.closeSettings();
		if (libraryOpen && !uiStore.libraryLocked) uiStore.closeLibrary();
		if (uiStore.debugPanelOpen) uiStore.closeDebugPanel();
	}

	// Keyboard shortcuts. Every binding is declared in `commands/shortcuts.svelte.ts`, which
	// is also what the shortcuts sheet renders: this handler only asks what a press means and
	// runs it. A shortcut may DECLINE (return false) and the key then reaches the browser
	// untouched, which is how find in chat stays out of the way while no chat is on screen.
	function handleKeydown(e: KeyboardEvent) {
		const flush = () => lorebookStore.flush();

		const hit = matchShortcut(e);
		if (hit) {
			if (hit.shortcut.run(hit.pressed) === false) return;
			e.preventDefault();
			return;
		}

		if (e.key === 'Escape') {
			// A modal Dialog owns the keyboard while its portal is mounted: it closes
			// itself on this very event (same guard LorebookView uses).
			if (document.querySelector('.dialog-portal')) return;
			// Panels that consume Esc (lorebook collapse, message editors, image
			// viewers…) mark the event with preventDefault, but their window listeners
			// are registered after this one. Defer to a microtask so their claim is
			// visible before closing anything. One press closes one surface, top-most
			// first; pinned (locked) side docks are left alone.
			queueMicrotask(() => {
				if (e.defaultPrevented) return;
				if (uiStore.debugPanelOpen) uiStore.closeDebugPanel();
				else if (uiStore.activeOverlay) uiStore.closeOverlay(flush);
				else if (uiStore.settingsOpen && !uiStore.settingsLocked) uiStore.closeSettings();
				else if (uiStore.libraryOpen && !uiStore.libraryLocked) uiStore.closeLibrary();
				// Bottom of the ladder, and the reason there is no shortcut of its own for the
				// composer: with nothing left to close, Escape is the way back to the box you
				// type in, from a turn the keyboard was parked on or from anywhere else.
				else chatCursor.toComposer();
			});
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} onmousedown={handleBackgroundMouseDown} />

<div class="workspace-shell">
	<main
		class="workspace-main"
		class:dock-left-open={settingsDocked || assistantSnapSide === 'left'}
		class:dock-right-open={libraryDocked || assistantSnapSide === 'right'}
		data-assistant-snap-workspace
		bind:this={workspaceEl}
	>
		<!-- Workspace background image: bottom of the stack, beneath the ambient layer
		     (same z-index, earlier in the DOM). -->
		{#if backgroundUrl}
			<div class="background-layer" aria-hidden="true">
				<div
					class="background-image"
					class:background-blurred={backgroundBlur > 0}
					style="background-image: url('{backgroundUrl}'); {backgroundBlur > 0 ? `filter: blur(${backgroundBlur}px);` : ''}"
				></div>
				<div class="background-dim" style="opacity: {backgroundDim}"></div>
			</div>
		{/if}

		<!-- Workspace-wide ambient. Behind every panel as a backdrop, or floated above
		     them all when "particles over messages" is on. -->
		{#if ambientVisible}
			<div class="ambient-layer" class:ambient-layer-over={particlesOverMessages}>
				<AmbientCanvas
				types={ambientTypes}
				density={ambientConfig.density}
				speed={ambientConfig.speed}
				visibility={ambientConfig.visibility}
				effectSettings={ambientConfig.effectSettings}
			/>
			</div>
		{/if}

		<div class="chat-host" class:chat-host-hidden={chatCovered}>
			<ChatContainer />
		</div>

		<!-- Welcome landing: a persistent base layer over the chat, below every panel.
		     It stays mounted while panels stack on top (hidden so it doesn't bleed
		     through translucent overlays) and is dismissed only when a chat opens. -->
		{#if welcomeOpen}
			<div class="chat-overlay welcome-layer" class:welcome-hidden={coveringOverlay}>
				<div class="chat-overlay-panel" data-panel data-welcome>
					<WelcomeView />
				</div>
			</div>
		{/if}

		<!-- Chat-area overlay (Library / Lorebook / etc). Covers the chat column at its
		     exact size, no backdrop: the side margins (and the docked side panels)
		     stay untouched. -->
		{#if chatsPopup}
			<!-- Deliberately NOT aria-modal: nothing outside is made inert here (the
			     TitleBar and composer stay reachable by Tab on purpose), and claiming
			     modality a focus trap doesn't back up only misleads a screen reader.
			     ChatsView lands focus in its own search field and Escape closes it. -->
			<div class="chats-modal" role="dialog" aria-label="Chats" transition:fade={{ duration: 120 }}>
				<div class="chats-modal-panel surface-float" data-panel>
					<ChatsView />
				</div>
			</div>
		{:else if activeOverlay}
			<div class="chat-overlay" transition:fade={{ duration: 120 }}>
				<div class="chat-overlay-panel" data-panel>
					{#if activeOverlay === 'chats'}
						<ChatsView />
						{:else if activeOverlay === 'storymap'}
							<StoryMapView />
						{:else if activeOverlay === 'memory'}
							<MemoryPanel />
					{:else if activeOverlay === 'lorebook'}
						<LorebookView />
					{:else if activeOverlay === 'presetControls'}
						<PresetControlsView />
					{:else if activeOverlay === 'stats'}
						<StatsView />
					{/if}
				</div>
			</div>
		{/if}

		<!-- Settings on wide screens: docked into the left margin, glued to the chat. -->
		{#if settingsDocked}
			<aside class="settings-dock" data-panel transition:fly={{ x: -16, duration: 200 }}>
				<SettingsPanel split={settingsSplit} />
			</aside>
		{/if}

		<!-- Split view: the selected settings page, wide and centered over the chat
		     while the dock keeps the root list, the Library entry editor's pattern. -->
		{#if settingsContentOpen}
			<div class="chat-overlay chat-overlay-front" transition:fade={{ duration: 120 }}>
				<div class="chat-overlay-panel" data-panel>
					<SettingsContentPanel />
				</div>
			</div>
		{/if}

		<!-- Settings on narrow screens: a chat-area overlay, above any other overlay. -->
		{#if settingsOverlay}
			<div class="chat-overlay chat-overlay-front" transition:fade={{ duration: 120 }}>
				<div class="chat-overlay-panel" data-panel>
					<SettingsPanel />
				</div>
			</div>
		{/if}

		<!-- Merged Library on wide screens: docked into the right margin, glued to the chat. -->
		{#if libraryDocked}
			<aside class="library-dock" data-panel transition:fly={{ x: 16, duration: 200 }}>
				<LibraryView />
			</aside>
		{/if}

		<!-- Merged Library on narrow screens: a chat-area overlay, above any other overlay. -->
		{#if libraryOverlay}
			<div class="chat-overlay chat-overlay-front" transition:fade={{ duration: 120 }}>
				<div class="chat-overlay-panel" data-panel>
					<LibraryView />
				</div>
			</div>
		{/if}

		<!-- Library entry editor: wide and centered over the chat, so the dock's browse
		     list keeps its place while the editor gets full width. -->
		{#if libraryEditorOpen}
			<div class="chat-overlay chat-overlay-front" transition:fade={{ duration: 120 }}>
				<div class="chat-overlay-panel" data-panel>
					<LibraryEditorOverlay />
				</div>
			</div>
		{/if}

		<!-- Prompt debug log: a chat-sized panel listing every logged query, opened from
		     the Advanced settings tab. Only exists while the toggle is on. -->
		{#if promptDebugEnabled && uiStore.debugPanelOpen}
			<div class="chat-overlay chat-overlay-front" transition:fade={{ duration: 120 }}>
				<div class="chat-overlay-panel" data-panel>
					<PromptDebugPanel />
				</div>
			</div>
		{/if}
	</main>
</div>

<!-- A held request, waiting to be read and released. Mounted here rather than beside the
     composer because the five gates that can hold one are raised from different places, and
     a request must not lose its review to whichever of them happened to unmount. -->
<PromptReviewDialog />

<!-- Lives here rather than in a panel: both its triggers are global (Ctrl+/ above,
     the Settings root's footer row), so the dialog must stay mounted whatever is
     open. -->
<ShortcutsSheet />

<!-- Same reason, one step further out: the labels are drawn over whatever is on screen,
     panels and dialogs included, so the layer belongs to the workspace and to no panel. -->
<HintLayer />

<style>
	.workspace-shell {
		height: 100%;
		min-height: 0;
	}

	.workspace-main {
		position: relative;
		height: 100%;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background: var(--color-bg-primary);
		/* Own stacking context so the ambient / chat / panel z-order below is
		   self-contained and deterministic. */
		isolation: isolate;
		/* Feather vars are @property-registered (app.css), so this retracts the
		   column tint's ramp in step with the docks' 200ms fly transitions. */
		transition:
			--chat-feather-left 200ms ease-out,
			--chat-feather-right 200ms ease-out;
	}

	/* A dock is glued flush to the column's edge (`50% ± --chat-col-max / 2`), so
	   that side has no empty workspace left for the tint to melt into, and the
	   panel is translucent, so a ramp tucked underneath it does not hide, it shows
	   through as a dark band running down the column's edge. Drop the feather
	   instead: the tint ends hard exactly where the dock's own border begins, which
	   is the one place a hard edge is invisible. Inherited by the chat column
	   (ChatContainer) and the welcome layer alike. */
	.dock-left-open {
		--chat-feather-left: 0px;
	}

	.dock-right-open {
		--chat-feather-right: 0px;
	}

	/* Background image layer: same plane as the ambient (z-index 0) but earlier in
	   the DOM, so particles always fall in front of the picture. */
	.background-layer {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.background-image {
		position: absolute;
		inset: 0;
		background-size: cover;
		background-position: center;
	}

	/* Blur samples past the edges; scale slightly so the fringe stays offscreen. */
	.background-blurred {
		transform: scale(1.05);
	}

	/* The picture's dim, strength from Settings → Background. Plain black on every
	   palette, deliberately: this is a photographic scrim, and darkening a picture
	   is what a dim is: the palette gets no say, the same way it gets no say over
	   the picture itself. The column shade above it is the palette-toned scrim; the
	   two are not the same kind of thing and must not be unified. */
	.background-dim {
		position: absolute;
		inset: 0;
		background: #000;
	}

	/* Single ambient layer spanning the whole workspace. Sits behind every panel by
	   default; `-over` floats it above all of them (still click-through). */
	.ambient-layer {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}

	.ambient-layer-over {
		z-index: 40;
	}

	/* Chat fills the workspace as the base layer. Hidden (not unmounted) while a
	   full-cover overlay is up, so its state/scroll survive and nothing bleeds
	   through the translucent overlay. */
	.chat-host {
		position: relative;
		z-index: 1;
		height: 100%;
		min-height: 0;
	}

	.chat-host-hidden {
		visibility: hidden;
	}

	/* Mirrors the chat column geometry (.chat-content + .chat-center-shell): a
	   transparent, pointer-events-free wrapper that centers an opaque panel capped
	   at --chat-col-max. The panel sits exactly over the chat; the margins pass
	   clicks through, so the docked Settings beside it stays usable. */
	.chat-overlay {
		position: absolute;
		inset: 0;
		z-index: 20;
		display: flex;
		justify-content: center;
		padding: 0 1rem;
		pointer-events: none;
	}

	.chat-overlay-front {
		z-index: 30;
	}

	/* The welcome landing sits below the chat-area overlays (z-index 20) but above the
	   chat, so any panel stacks over it. Hidden while covered to stop it bleeding
	   through a translucent overlay, exactly like the chat host beneath. */
	.welcome-layer {
		z-index: 10;
	}

	.welcome-hidden {
		visibility: hidden;
	}

	/* The welcome landing stands in for the chat column, so it copies the chat's
	   backing exactly (see .chat-center-shell in ChatContainer.svelte) instead of
	   the panel chrome: same tint, no frost, no hard vertical borders, and the
	   backing lives on a pseudo-element that fades out at the sides. */
	.welcome-layer .chat-overlay-panel {
		position: relative;
		isolation: isolate;
		border-left: 0;
		border-right: 0;
		background: transparent;
		backdrop-filter: none;
		-webkit-backdrop-filter: none;
		/* Let the ::before tint overhang past the panel edge (under a docked panel).
		   Safe here: WelcomeView scrolls itself, nothing relies on this clip. */
		overflow: visible;
	}

	/* Keep this gradient identical to .chat-center-shell::before in
	   ChatContainer.svelte: same eased feather, same grown box. That file carries
	   the reasoning for the grow. */
	.welcome-layer .chat-overlay-panel::before {
		content: '';
		position: absolute;
		inset: 0;
		left: calc(-1 * var(--chat-feather-left));
		right: calc(-1 * var(--chat-feather-right));
		z-index: -1;
		pointer-events: none;
		/* The palette's own surface tone, opaque, faded by the Column shade strength.
		   The opacity carries BOTH layers on purpose: the grain below exists only to
		   dither this tint's alpha ramp, so it has to vanish with it (theme store). */
		background: var(--theme-column-shade, #1c1718);
		/* Grain over the tint so the low-delta alpha ramp doesn't band (app.css). */
		background-image: var(--chat-col-noise);
		opacity: var(--theme-column-shade-opacity, 0);
		-webkit-mask-image: linear-gradient(
			to right,
			transparent,
			rgb(0 0 0 / 0.16) calc(var(--chat-feather-left) * 0.25),
			rgb(0 0 0 / 0.5) calc(var(--chat-feather-left) * 0.5),
			rgb(0 0 0 / 0.84) calc(var(--chat-feather-left) * 0.75),
			#000 var(--chat-feather-left),
			#000 calc(100% - var(--chat-feather-right)),
			rgb(0 0 0 / 0.84) calc(100% - var(--chat-feather-right) * 0.75),
			rgb(0 0 0 / 0.5) calc(100% - var(--chat-feather-right) * 0.5),
			rgb(0 0 0 / 0.16) calc(100% - var(--chat-feather-right) * 0.25),
			transparent
		);
		mask-image: linear-gradient(
			to right,
			transparent,
			rgb(0 0 0 / 0.16) calc(var(--chat-feather-left) * 0.25),
			rgb(0 0 0 / 0.5) calc(var(--chat-feather-left) * 0.5),
			rgb(0 0 0 / 0.84) calc(var(--chat-feather-left) * 0.75),
			#000 var(--chat-feather-left),
			#000 calc(100% - var(--chat-feather-right)),
			rgb(0 0 0 / 0.84) calc(100% - var(--chat-feather-right) * 0.75),
			rgb(0 0 0 / 0.5) calc(100% - var(--chat-feather-right) * 0.5),
			rgb(0 0 0 / 0.16) calc(100% - var(--chat-feather-right) * 0.25),
			transparent
		);
	}

	.chat-overlay-panel {
		width: 100%;
		max-width: var(--chat-col-max);
		height: 100%;
		min-height: 0;
		pointer-events: auto;
		/* Translucent + frosted so the ambient layer behind reads through, just like
		   the chat. Safe because the chat beneath is hidden while an overlay is up.
		   --theme-panel-bg's opacity tracks the glass setting (more opaque as blur
		   drops), and the backdrop blur is the setting itself. */
		background: var(--theme-panel-bg, color-mix(in srgb, var(--color-bg-primary) 58%, transparent));
		backdrop-filter: var(--backdrop-blur);
		-webkit-backdrop-filter: var(--backdrop-blur);
		border-left: 1px solid var(--color-border-subtle);
		border-right: 1px solid var(--color-border-subtle);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	@media (max-width: 1500px) {
		.chat-overlay {
			padding: 0;
		}
	}

	/* Chats modal: dims the whole workspace and centers a medium panel over it.
	   The layer itself catches clicks, so pressing the backdrop closes the panel via
	   the workspace click-away (the panel is data-panel, so it's left alone). */
	.chats-modal {
		position: absolute;
		inset: 0;
		z-index: 30;
		display: flex;
		/* Anchored near the top rather than dead-center: the panel hangs from a
		   small top offset and grows downward. */
		align-items: flex-start;
		justify-content: center;
		padding: 1.5rem 1.25rem 2.5rem;
		background: color-mix(in srgb, black 45%, transparent);
	}

	/* .surface-float in markup: the backdrop blur keeps the live chat behind the
	   panel from bleeding through, and the float token goes opaque at glass=off. */
	.chats-modal-panel {
		width: min(58rem, 100%);
		height: min(52rem, 100%);
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-lg);
	}

	/* Fills the empty margin left of the centered (max --chat-col-max) chat column,
	   with its right edge glued to the chat's left edge. The chat never moves. */
	.settings-dock {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		right: calc(50% + var(--chat-col-max) / 2);
		z-index: 25;
		display: flex;
		flex-direction: column;
		background: var(--theme-panel-bg, color-mix(in srgb, var(--color-bg-primary) 58%, transparent));
		backdrop-filter: var(--backdrop-blur);
		-webkit-backdrop-filter: var(--backdrop-blur);
		border-right: 1px solid var(--color-border-subtle);
		overflow: hidden;
	}

	/* Mirror of .settings-dock: fills the empty margin right of the chat column,
	   left edge glued to the chat's right edge. */
	.library-dock {
		position: absolute;
		top: 0;
		bottom: 0;
		right: 0;
		left: calc(50% + var(--chat-col-max) / 2);
		z-index: 25;
		display: flex;
		flex-direction: column;
		background: var(--theme-panel-bg, color-mix(in srgb, var(--color-bg-primary) 58%, transparent));
		backdrop-filter: var(--backdrop-blur);
		-webkit-backdrop-filter: var(--backdrop-blur);
		border-left: 1px solid var(--color-border-subtle);
		overflow: hidden;
	}
</style>
