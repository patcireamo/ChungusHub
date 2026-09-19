<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import ChungusAssistantPanel from './ChungusAssistantPanel.svelte';
	import AssistantMascot from './AssistantMascot.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { generalSettingsStore } from '$lib/stores/general-settings.svelte';
	import { assistantSessionStore } from '$lib/stores/assistantSessions.svelte';
	import { onDestroy, onMount } from 'svelte';
	import { scale } from 'svelte/transition';

	// The Chungus Assistant as a floating live-chat widget: a mascot launcher bottom-right
	// that animates open into a draggable + resizable panel (full-screen on phones).
	// Size/position persist in localStorage and re-clamp to the viewport.
	const RECT_KEY = 'assistant-widget-rect';
	const MIN_W = 320;
	const MIN_H = 360;
	const MARGIN = 16;

	let open = $derived(uiStore.assistantOpen);
	let busy = $derived(assistantSessionStore.anyBusy);
	/** A turn somewhere has stopped and needs an answer. It outranks the working state on the
	 *  closed launcher: a pulsing ring says "leave it alone", and this one means the opposite. */
	let waiting = $derived(assistantSessionStore.anyPendingAsk);
	let isMobile = $derived(viewport.isMobile);
	/** Settings → General can hide the launcher: the fix for a phone reader who keeps having
	 *  to drag the corner mascot off the text it's sitting on. It hides the BUTTON and nothing
	 *  else: the assistant keeps running, keeps its tabs, and two other doors open the panel in
	 *  its place, Ctrl/⌘+J always, and TitleBar grows a plain button of its own
	 *  (`AssistantNavStatus.svelte` mirrors this launcher's busy/waiting marks; the "just
	 *  finished" bounce below stays launcher-only, see that component's own doc comment). */
	let showLauncher = $derived(generalSettingsStore.assistantLauncher);

	// "Just finished" badge: when a turn wraps up while the widget is minimized, mark
	// the launcher done until the user opens it. Turns finished with the panel open
	// were already seen, so they never badge. A hidden launcher neither arms nor keeps
	// the mark: it has nowhere to show, and re-enabling the button would otherwise
	// announce a turn that finished hours ago.
	let notify = $state(false);
	let wasBusy = false;
	$effect(() => {
		const b = busy;
		if (wasBusy && !b && !open && showLauncher) notify = true;
		wasBusy = b;
	});
	$effect(() => {
		if (open || !showLauncher) notify = false;
	});

	type Rect = { x: number; y: number; w: number; h: number };
	let rect = $state<Rect>({ x: 0, y: 0, w: 420, h: 640 });
	let rectReady = $state(false);

	function clampRect(r: Rect): Rect {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const w = Math.min(Math.max(r.w, MIN_W), vw - MARGIN * 2);
		const h = Math.min(Math.max(r.h, MIN_H), vh - MARGIN * 2);
		const x = Math.min(Math.max(r.x, MARGIN), vw - w - MARGIN);
		const y = Math.min(Math.max(r.y, MARGIN), vh - h - MARGIN);
		return { x, y, w, h };
	}

	/** Persisted placement: the rect, the snap slot it sits in (null = free-floating),
	 *  and the remembered free size a tear-off restores. Old saves are plain Rects. */
	interface SavedPlacement extends Rect {
		snappedZone?: SnapZone | null;
		freeW?: number;
		freeH?: number;
	}

	function readSavedRect(): SavedPlacement | null {
		try {
			const raw = localStorage.getItem(RECT_KEY);
			return raw ? (JSON.parse(raw) as SavedPlacement) : null;
		} catch {
			return null; // unreadable / malformed, so fall back to the default placement
		}
	}

	function loadRect(): Rect {
		const saved = readSavedRect();
		if (saved) return clampRect(saved);
		// Never placed: a medium box anchored bottom-right.
		const w = 420;
		const h = Math.min(640, window.innerHeight - MARGIN * 2);
		return clampRect({ w, h, x: window.innerWidth - w - MARGIN, y: window.innerHeight - h - MARGIN });
	}

	function saveRect() {
		try {
			localStorage.setItem(
				RECT_KEY,
				JSON.stringify({
					...rect,
					snappedZone: isSnapped ? snappedZone : null,
					...(restoreSize ? { freeW: restoreSize.w, freeH: restoreSize.h } : {})
				} satisfies SavedPlacement)
			);
		} catch {
			/* storage unavailable, so position just won't persist */
		}
	}

	const SNAP_ZONES = ['left', 'right', 'center', 'tl', 'tr', 'bl', 'br'] as const;

	// Load the saved placement the first time the widget opens on desktop, including
	// the snap slot: reopening must not demote a docked panel to a free-floating window
	// wearing the dock's dimensions (which then clobbered the tuned free size too).
	$effect(() => {
		if (open && !isMobile && !rectReady) {
			const saved = readSavedRect();
			rect = loadRect();
			if (saved && typeof saved.freeW === 'number' && typeof saved.freeH === 'number') {
				restoreSize = { w: saved.freeW, h: saved.freeH };
			}
			if (saved?.snappedZone && (SNAP_ZONES as readonly string[]).includes(saved.snappedZone)) {
				snappedZone = saved.snappedZone;
				isSnapped = true;
				rect = snapRegion(saved.snappedZone);
			}
			rectReady = true;
		}
		if (!open) rectReady = false;
	});

	// ---- Launcher drag ----
	// The closed-state mascot docks to the left or right edge (horizontal snaps to a side:
	// only those two, never top/bottom) but slides FREELY up and down that edge and stays
	// exactly where it's dropped; side + vertical offset persist. A press that never crosses
	// the threshold is a plain click that opens the panel.
	const POS_KEY = 'assistant-launcher-pos';
	const DRAG_THRESHOLD = 6;
	let launcherSide = $state<'left' | 'right'>('right');
	let launcherY = $state<number | null>(null); // persisted top px; null = default bottom anchor
	let launcherEl = $state<HTMLButtonElement | null>(null);
	let launcherDragX = $state<number | null>(null); // live top-left px while dragging; null = docked
	let launcherDragY = $state<number | null>(null);
	let launcherDragging = $state(false);
	let launcherPointerDown = false;
	let suppressClick = false;
	let launcherGrab = { offsetX: 0, offsetY: 0, startX: 0, startY: 0 };

	// Resolved inline position: the live drag coords while dragging, else the persisted
	// vertical offset (horizontal comes from the .launcher-left class / default right).
	let launcherStyle = $derived(
		launcherDragX !== null
			? `left:${launcherDragX}px; right:auto; top:${launcherDragY}px; bottom:auto;`
			: launcherY !== null
				? `top:${launcherY}px; bottom:auto;`
				: ''
	);

	function clampLauncherY(y: number): number {
		const h = launcherEl?.offsetHeight ?? 56;
		return Math.min(Math.max(y, MARGIN), window.innerHeight - h - MARGIN);
	}

	onMount(() => {
		try {
			const raw = localStorage.getItem(POS_KEY);
			if (raw) {
				const p = JSON.parse(raw) as { side?: string; y?: number };
				if (p.side === 'left' || p.side === 'right') launcherSide = p.side;
				if (typeof p.y === 'number') launcherY = clampLauncherY(p.y);
			}
		} catch {
			/* storage unavailable / malformed, so keep the default right dock */
		}
	});

	// Keep a dropped launcher on-screen when the viewport shrinks.
	$effect(() => {
		const onResize = () => {
			if (launcherY !== null) launcherY = clampLauncherY(launcherY);
		};
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	});

	function onLauncherPointerDown(e: PointerEvent) {
		if (e.button && e.button !== 0) return; // primary button / touch only
		launcherPointerDown = true;
		launcherDragging = false;
		const r = launcherEl?.getBoundingClientRect();
		launcherGrab = {
			offsetX: r ? e.clientX - r.left : 0,
			offsetY: r ? e.clientY - r.top : 0,
			startX: e.clientX,
			startY: e.clientY
		};
		launcherEl?.setPointerCapture(e.pointerId);
	}
	function onLauncherPointerMove(e: PointerEvent) {
		if (!launcherPointerDown) return;
		if (
			!launcherDragging &&
			Math.abs(e.clientX - launcherGrab.startX) < DRAG_THRESHOLD &&
			Math.abs(e.clientY - launcherGrab.startY) < DRAG_THRESHOLD
		)
			return;
		launcherDragging = true;
		const w = launcherEl?.offsetWidth ?? 56;
		const h = launcherEl?.offsetHeight ?? 56;
		launcherDragX = Math.min(Math.max(e.clientX - launcherGrab.offsetX, MARGIN), window.innerWidth - w - MARGIN);
		launcherDragY = Math.min(Math.max(e.clientY - launcherGrab.offsetY, MARGIN), window.innerHeight - h - MARGIN);
	}
	function onLauncherPointerUp(e: PointerEvent) {
		if (!launcherPointerDown) return;
		launcherPointerDown = false;
		launcherEl?.releasePointerCapture(e.pointerId);
		if (launcherDragging) {
			const w = launcherEl?.offsetWidth ?? 56;
			const center = (launcherDragX ?? 0) + w / 2;
			launcherSide = center < window.innerWidth / 2 ? 'left' : 'right'; // horizontal: side only
			launcherY = launcherDragY; // vertical: keep exactly where it was dropped
			try {
				localStorage.setItem(POS_KEY, JSON.stringify({ side: launcherSide, y: launcherY }));
			} catch {
				/* position just won't persist */
			}
			suppressClick = true; // swallow the click the browser fires after the drag
			// Touch drags usually fire NO trailing click, so without this reset the armed
			// flag would eat the NEXT genuine tap instead.
			setTimeout(() => (suppressClick = false), 350);
		}
		launcherDragX = null;
		launcherDragY = null;
		launcherDragging = false;
	}
	function onLauncherClick() {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		uiStore.openAssistant();
	}

	// ---- Snap (Windows-style: drag a cursor to an edge/corner) ----
	const SNAP_EDGE = 40; // px from a viewport edge that arms a snap zone
	type SnapZone = 'left' | 'right' | 'center' | 'tl' | 'tr' | 'bl' | 'br';
	// While dragging, the region the widget would snap to on release (null = free drop),
	// and the zone that region belongs to (remembered so a release can re-fit later).
	let snapTarget = $state<Rect | null>(null);
	let pendingZone: SnapZone | null = null;
	// Snapped state stays reactive because both geometry and chrome change when the
	// responsive dock breakpoint flips.
	let isSnapped = $state(false);
	let snappedZone = $state<SnapZone | null>(null);

	function snapZoneFor(px: number, py: number, vw: number, vh: number): SnapZone | null {
		const nearL = px <= SNAP_EDGE;
		const nearR = px >= vw - SNAP_EDGE;
		const nearT = py <= SNAP_EDGE;
		const nearB = py >= vh - SNAP_EDGE;
		if (nearL && nearT) return 'tl';
		if (nearL && nearB) return 'bl';
		if (nearL) return 'left';
		if (nearR && nearT) return 'tr';
		if (nearR && nearB) return 'br';
		if (nearR) return 'right';
		// Top edge, away from the corners: cover the centred chat column like a
		// full-cover overlay (Memory / Story Map).
		if (nearT) return 'center';
		return null;
	}

	function snapAnchors() {
		const workspace = document.querySelector<HTMLElement>('[data-assistant-snap-workspace]');
		const column = document.querySelector<HTMLElement>('[data-assistant-snap-column]');
		if (!workspace || !column) throw new Error('Assistant snap layout anchors are missing');
		return { workspace, column };
	}

	function toRect(bounds: DOMRect): Rect {
		return { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
	}

	// Snap against the native layout itself. The title-bar column shares the exact
	// --chat-col-max geometry used by chat overlays and side docks, while Workspace
	// supplies the vertical bounds below the title bar. No responsive CSS math is
	// duplicated here, so zoom, chat width and breakpoint changes stay in sync.
	function snapRegion(zone: SnapZone): Rect {
		const anchors = snapAnchors();
		const workspace = toRect(anchors.workspace.getBoundingClientRect());
		const column = toRect(anchors.column.getBoundingClientRect());
		const center = { x: column.x, y: workspace.y, w: column.w, h: workspace.h };
		const useSideDock = viewport.canDockSettings;
		const left = useSideDock
			? { x: workspace.x, y: workspace.y, w: column.x - workspace.x, h: workspace.h }
			: center;
		const right = useSideDock
			? {
					x: column.x + column.w,
					y: workspace.y,
					w: workspace.x + workspace.w - column.x - column.w,
					h: workspace.h
				}
			: center;

		if (zone === 'left') return left;
		if (zone === 'right') return right;
		if (zone === 'center') return center;

		const base = zone === 'tl' || zone === 'bl' ? left : right;
		const top = zone === 'tl' || zone === 'tr';
		const topHeight = Math.floor(base.h / 2);
		return top
			? { ...base, h: topHeight }
			: { ...base, y: base.y + topHeight, h: base.h - topHeight };
	}

	// Re-fit snapped panels whenever their real layout anchors change size. A free
	// panel only needs the viewport clamp; snapped rectangles deliberately skip it so
	// minimum floating dimensions can never push them off their native boundaries.
	function refitToLayout() {
		if (isSnapped && snappedZone) rect = snapRegion(snappedZone);
		else rect = clampRect(rect);
		if (snapTarget && pendingZone) snapTarget = snapRegion(pendingZone);
	}

	$effect(() => {
		if (!open || isMobile) return;
		const anchors = snapAnchors();
		const observer = new ResizeObserver(refitToLayout);
		observer.observe(anchors.workspace);
		observer.observe(anchors.column);
		window.addEventListener('resize', refitToLayout);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', refitToLayout);
		};
	});

	$effect(() => {
		viewport.canDockSettings;
		if (open && !isMobile && isSnapped && snappedZone) refitToLayout();
	});

	// ---- Drag (by the header) ----
	let dragging = false;
	let dragStart = { px: 0, py: 0, x: 0, y: 0 };
	// The free size restores when a snapped window tears off, so it follows the cursor
	// at its old floating dimensions instead of dragging the entire native slot.
	let restoreSize: { w: number; h: number } | null = null;

	/** A header press only becomes a drag past the same threshold the launcher uses:
	 *  a plain click on a snapped panel's header must never tear it out of its dock. */
	let headerMoved = false;

	function onHeaderPointerDown(e: PointerEvent) {
		if (isMobile) return;
		if ((e.target as HTMLElement).closest('button')) return; // let the minimize button work
		dragging = true;
		headerMoved = false;
		dragStart = { px: e.clientX, py: e.clientY, x: rect.x, y: rect.y };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onHeaderPointerMove(e: PointerEvent) {
		if (!dragging) return;
		if (!headerMoved) {
			if (
				Math.abs(e.clientX - dragStart.px) < DRAG_THRESHOLD &&
				Math.abs(e.clientY - dragStart.py) < DRAG_THRESHOLD
			) {
				return;
			}
			headerMoved = true;
			// First real movement tears a snapped window off: restore its free size,
			// dropped under the cursor with the grab point kept on the header.
			if (isSnapped && restoreSize) {
				const relX = rect.w > 0 ? (e.clientX - rect.x) / rect.w : 0.5;
				const grabY = Math.min(Math.max(e.clientY - rect.y, 0), 32);
				rect = clampRect({
					w: restoreSize.w,
					h: restoreSize.h,
					x: e.clientX - relX * restoreSize.w,
					y: e.clientY - grabY
				});
				isSnapped = false;
				snappedZone = null;
				dragStart = { px: e.clientX, py: e.clientY, x: rect.x, y: rect.y };
			}
		}
		// Follow the cursor with NO clamp so the header can reach any edge/corner; the
		// window may hang off-screen mid-drag and release pulls it back or snaps it.
		rect = {
			...rect,
			x: dragStart.x + (e.clientX - dragStart.px),
			y: dragStart.y + (e.clientY - dragStart.py)
		};
		const zone = snapZoneFor(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
		pendingZone = zone;
		snapTarget = zone ? snapRegion(zone) : null;
	}
	function onHeaderPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		if (!headerMoved) return; // a plain click: nothing moved, nothing to re-place
		if (snapTarget) {
			// Remember the free size (only on the free → snapped transition) to restore later.
			if (!isSnapped) restoreSize = { w: rect.w, h: rect.h };
			rect = snapTarget;
			isSnapped = true;
			snappedZone = pendingZone;
		} else {
			rect = clampRect(rect); // a free drop: pull it fully back on-screen
			isSnapped = false;
			snappedZone = null;
		}
		snapTarget = null;
		pendingZone = null;
		saveRect();
	}

	// ---- Resize (edges + corners) ----
	const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
	let resizing: string | null = null;
	let resizeStart = { px: 0, py: 0, x: 0, y: 0, w: 0, h: 0 };

	function onResizePointerDown(e: PointerEvent, dir: string) {
		e.stopPropagation();
		resizing = dir;
		resizeStart = { px: e.clientX, py: e.clientY, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onResizePointerMove(e: PointerEvent) {
		if (!resizing) return;
		const dx = e.clientX - resizeStart.px;
		const dy = e.clientY - resizeStart.py;
		// A snapped panel resizes from exactly where it sits and leaves its slot on the first
		// real movement, not on the press, so a stray click on an edge cannot undock it. It
		// has to leave: the layout anchors would re-fit a hand-sized rectangle away.
		if (isSnapped && (dx !== 0 || dy !== 0)) {
			isSnapped = false;
			snappedZone = null;
		}
		let { x, y, w, h } = resizeStart;
		if (resizing.includes('e')) w = resizeStart.w + dx;
		if (resizing.includes('s')) h = resizeStart.h + dy;
		if (resizing.includes('w')) {
			w = resizeStart.w - dx;
			x = resizeStart.x + dx;
		}
		if (resizing.includes('n')) {
			h = resizeStart.h - dy;
			y = resizeStart.y + dy;
		}
		// Enforce the minimum by pinning the anchored edge instead of letting it drift.
		if (w < MIN_W && resizing.includes('w')) x = resizeStart.x + resizeStart.w - MIN_W;
		if (h < MIN_H && resizing.includes('n')) y = resizeStart.y + resizeStart.h - MIN_H;
		rect = clampRect({ x, y, w, h });
	}
	function onResizePointerUp(e: PointerEvent) {
		if (!resizing) return;
		resizing = null;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		saveRect();
	}

	let frameStyle = $derived(
		isMobile ? '' : `left:${rect.x}px; top:${rect.y}px; width:${rect.w}px; height:${rect.h}px;`
	);
	let snapPlacement = $derived.by(() => {
		if (!isSnapped || !snappedZone || !viewport.canDockSettings) return 'center';
		if (snappedZone === 'left' || snappedZone === 'tl' || snappedZone === 'bl') return 'left';
		if (snappedZone === 'right' || snappedZone === 'tr' || snappedZone === 'br') return 'right';
		return 'center';
	});

	// Workspace owns the chat/welcome tint animation. Publish only the transient side
	// attachment needed to reuse its native dock overhang; floating, centered, narrow,
	// mobile and minimized states all explicitly release it.
	$effect(() => {
		const side =
			open && !isMobile && isSnapped && viewport.canDockSettings &&
			(snapPlacement === 'left' || snapPlacement === 'right')
				? snapPlacement
				: null;
		uiStore.setAssistantSnapSide(side);
	});
	onDestroy(() => uiStore.setAssistantSnapSide(null));
</script>

{#if open}
	{#if snapTarget}
		<!-- Snap preview: the ghost region the widget will jump to on release. -->
		<div
			class="assistant-snap-ghost"
			style="left:{snapTarget.x}px; top:{snapTarget.y}px; width:{snapTarget.w}px; height:{snapTarget.h}px;"
		></div>
	{/if}
	<div
		class="assistant-widget surface-float"
		class:assistant-widget--mobile={isMobile}
		class:assistant-widget--snapped={isSnapped && !isMobile}
		class:assistant-widget--snap-left={isSnapped && !isMobile && snapPlacement === 'left'}
		class:assistant-widget--snap-right={isSnapped && !isMobile && snapPlacement === 'right'}
		class:assistant-widget--snap-center={isSnapped && !isMobile && snapPlacement === 'center'}
		class:assistant-widget--snap-top-half={isSnapped && !isMobile && (snappedZone === 'tl' || snappedZone === 'tr')}
		class:assistant-widget--snap-bottom-half={isSnapped && !isMobile && (snappedZone === 'bl' || snappedZone === 'br')}
		style={frameStyle}
		data-panel
		transition:scale={{ duration: 180, start: 0.9, opacity: 0 }}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<header
			class="assistant-widget-header"
			onpointerdown={onHeaderPointerDown}
			onpointermove={onHeaderPointerMove}
			onpointerup={onHeaderPointerUp}
		>
			<span class="assistant-widget-title">
				<AssistantMascot size={18} />
				Chungus Assistant
			</span>
			<button
				type="button"
				class="assistant-widget-min"
				title="Minimize"
				onclick={() => uiStore.closeAssistant()}
			>
				<Icon name="minimize" class="w-4 h-4" />
			</button>
		</header>

		<div class="assistant-widget-body">
			<ChungusAssistantPanel />
		</div>

		{#if !isMobile}
			{#each HANDLES as dir (dir)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="assistant-resize assistant-resize--{dir}"
					onpointerdown={(e) => onResizePointerDown(e, dir)}
					onpointermove={onResizePointerMove}
					onpointerup={onResizePointerUp}
				></div>
			{/each}
		{/if}
	</div>
{:else if showLauncher}
	<button
		type="button"
		bind:this={launcherEl}
		class="assistant-launcher"
		class:launcher-left={launcherSide === 'left'}
		class:is-dragging={launcherDragging}
		class:is-busy={busy && !waiting}
		class:is-waiting={waiting}
		class:is-done={!busy && !waiting && notify}
		style={launcherStyle}
		title={waiting
			? 'Chungus Assistant · waiting for your approval'
			: busy
				? 'Chungus Assistant · working…'
				: notify
					? 'Chungus Assistant · finished'
					: 'Chungus Assistant'}
		onpointerdown={onLauncherPointerDown}
		onpointermove={onLauncherPointerMove}
		onpointerup={onLauncherPointerUp}
		onclick={onLauncherClick}
		transition:scale={{ duration: 160, start: 0.6, opacity: 0 }}
	>
		{#if busy && !waiting}<span class="assistant-launcher-ring"></span>{/if}
		<!-- Sized as a share of the button, which shrinks on phones. The button's own title
		     names it, so the face stays decorative. -->
		<AssistantMascot size="78%" />
		{#if waiting}
			<span class="assistant-launcher-waiting">
				<Icon name="shield" class="w-3 h-3" />
			</span>
		{:else if busy}
			<span class="assistant-launcher-dot"></span>
		{:else if notify}
			<span class="assistant-launcher-done">
				<Icon name="check" class="w-3 h-3" />
			</span>
		{/if}
	</button>
{/if}

<style>
	/* ---- Floating panel (frost via .surface-float in markup) ---- */
	.assistant-widget {
		position: fixed;
		z-index: 200;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		overflow: hidden;
	}

	.assistant-widget--mobile {
		inset: 0;
		border: 0;
		border-radius: 0;
		box-shadow: none;
		/* Full-screen on phones: keep the header and composer out of the notch/home bar. */
		padding-top: env(safe-area-inset-top, 0px);
		padding-bottom: env(safe-area-inset-bottom, 0px);
	}

	/* Snapped panels use the same flush surface and seams as Workspace's native
	   docks/overlays. Floating-only radius, shadow and all-edge glass border stay off. */
	.assistant-widget--snapped {
		border: 0;
		border-radius: 0;
		box-shadow: none;
		background: var(--theme-panel-bg, color-mix(in srgb, var(--color-bg-primary) 58%, transparent));
		backdrop-filter: var(--backdrop-blur);
		-webkit-backdrop-filter: var(--backdrop-blur);
	}

	.assistant-widget--snap-left {
		border-right: 1px solid var(--color-border-subtle);
	}

	.assistant-widget--snap-right {
		border-left: 1px solid var(--color-border-subtle);
	}

	.assistant-widget--snap-center {
		border-left: 1px solid var(--color-border-subtle);
		border-right: 1px solid var(--color-border-subtle);
	}

	.assistant-widget--snap-top-half {
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.assistant-widget--snap-bottom-half {
		border-top: 1px solid var(--color-border-subtle);
	}

	/* Snap preview ghost: glides between zones as the cursor moves near edges. */
	.assistant-snap-ghost {
		position: fixed;
		z-index: 199;
		border: 2px solid var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		border-radius: 0;
		pointer-events: none;
		transition: left 90ms ease, top 90ms ease, width 90ms ease, height 90ms ease;
	}

	@media (prefers-reduced-motion: reduce) {
		.assistant-snap-ghost {
			transition: none;
		}
	}

	.assistant-widget-header {
		flex-shrink: 0;
		height: 2.4rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 0.4rem 0 0.75rem;
		border-bottom: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-secondary) 80%, transparent);
		cursor: grab;
		touch-action: none;
		user-select: none;
	}

	.assistant-widget-header:active {
		cursor: grabbing;
	}

	.assistant-widget--mobile .assistant-widget-header {
		cursor: default;
	}

	.assistant-widget-title {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.assistant-widget-min {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.8rem;
		height: 1.8rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 140ms ease, color 140ms ease;
	}

	.assistant-widget-min:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	.assistant-widget-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	/* ---- Resize handles ---- */
	.assistant-resize {
		position: absolute;
		touch-action: none;
	}
	.assistant-resize--n {
		top: -3px;
		left: 10px;
		right: 10px;
		height: 8px;
		cursor: ns-resize;
	}
	.assistant-resize--s {
		bottom: -3px;
		left: 10px;
		right: 10px;
		height: 8px;
		cursor: ns-resize;
	}
	.assistant-resize--e {
		right: -3px;
		top: 10px;
		bottom: 10px;
		width: 8px;
		cursor: ew-resize;
	}
	.assistant-resize--w {
		left: -3px;
		top: 10px;
		bottom: 10px;
		width: 8px;
		cursor: ew-resize;
	}
	.assistant-resize--ne {
		top: -4px;
		right: -4px;
		width: 14px;
		height: 14px;
		cursor: nesw-resize;
	}
	.assistant-resize--nw {
		top: -4px;
		left: -4px;
		width: 14px;
		height: 14px;
		cursor: nwse-resize;
	}
	.assistant-resize--se {
		bottom: -4px;
		right: -4px;
		width: 14px;
		height: 14px;
		cursor: nwse-resize;
	}
	.assistant-resize--sw {
		bottom: -4px;
		left: -4px;
		width: 14px;
		height: 14px;
		cursor: nesw-resize;
	}

	/* ---- Launcher button ---- */
	.assistant-launcher {
		position: fixed;
		right: 1.25rem;
		bottom: calc(1.25rem + env(safe-area-inset-bottom, 0px));
		z-index: 200;
		width: 3.5rem;
		height: 3.5rem;
		padding: 0;
		border: 1px solid var(--color-border-subtle);
		border-radius: 50%;
		background: color-mix(in srgb, var(--color-bg-secondary) 92%, transparent);
		box-shadow: var(--shadow-lg);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: visible;
		/* Horizontal drag must not scroll the page under the finger on touch. */
		touch-action: none;
		transition: transform 140ms ease, box-shadow 140ms ease;
	}

	/* Docked to the left corner instead of the default right. */
	.assistant-launcher.launcher-left {
		left: 1.25rem;
		right: auto;
	}

	.assistant-launcher:hover {
		transform: translateY(-2px) scale(1.04);
		box-shadow: var(--shadow-glow);
	}

	/* While dragging, freeze the hover lift and animation so it tracks the pointer 1:1. */
	.assistant-launcher.is-dragging,
	.assistant-launcher.is-dragging:hover {
		transform: none;
		cursor: grabbing;
		transition: none;
	}

	/* Phone (same 640px break as viewport.isMobile): the composer spans the full
	   width down there, so lift the launcher clear of it and its send button. */
	@media (max-width: 640px) {
		.assistant-launcher {
			right: 0.75rem;
			bottom: calc(10rem + env(safe-area-inset-bottom, 0px));
			width: 3rem;
			height: 3rem;
		}
		.assistant-launcher.launcher-left {
			left: 0.75rem;
			right: auto;
		}
	}

	.assistant-launcher :global(.mascot) {
		pointer-events: none;
	}

	/* Working: a pulsing accent ring + a steady dot badge. */
	.assistant-launcher.is-busy {
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	.assistant-launcher-ring {
		position: absolute;
		inset: -2px;
		border-radius: 50%;
		border: 2px solid var(--color-accent);
		animation: assistant-launcher-pulse 1.4s ease-out infinite;
		pointer-events: none;
	}

	.assistant-launcher-dot {
		position: absolute;
		top: 0.05rem;
		right: 0.05rem;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 50%;
		background: var(--color-accent);
		border: 2px solid var(--color-bg-primary);
		pointer-events: none;
	}

	@keyframes assistant-launcher-pulse {
		0% {
			transform: scale(1);
			opacity: 0.7;
		}
		70% {
			transform: scale(1.35);
			opacity: 0;
		}
		100% {
			transform: scale(1.35);
			opacity: 0;
		}
	}

	/* Waiting on an answer: the accent badge held STILL, and no ring. Nothing is running and
	   nothing is at risk: the turn simply cannot go on until the user looks. */
	.assistant-launcher.is-waiting {
		border-color: color-mix(in srgb, var(--color-accent) 70%, transparent);
	}

	.assistant-launcher-waiting {
		position: absolute;
		top: -0.15rem;
		right: -0.15rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 50%;
		background: var(--color-accent);
		color: var(--color-on-accent);
		border: 2px solid var(--color-bg-primary);
		pointer-events: none;
	}

	/* Finished: a steady success check badge, with a one-shot bounce to catch the eye
	   the moment it appears. */
	.assistant-launcher.is-done {
		border-color: color-mix(in srgb, var(--color-success) 55%, transparent);
		animation: assistant-launcher-bounce 0.5s ease;
	}

	.assistant-launcher-done {
		position: absolute;
		top: -0.15rem;
		right: -0.15rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 50%;
		background: var(--color-success);
		color: var(--color-on-success);
		border: 2px solid var(--color-bg-primary);
		pointer-events: none;
	}

	@keyframes assistant-launcher-bounce {
		0% {
			transform: translateY(0);
		}
		35% {
			transform: translateY(-6px);
		}
		60% {
			transform: translateY(0);
		}
		78% {
			transform: translateY(-3px);
		}
		100% {
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.assistant-launcher-ring,
		.assistant-launcher.is-done {
			animation: none;
		}
	}
</style>
