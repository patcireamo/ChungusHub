<script lang="ts">
	import { fly } from 'svelte/transition';
	import Icon from '$lib/components/ui/Icon.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import BranchCompareModal from './BranchCompareModal.svelte';
	import StoryMapInspector from './StoryMapInspector.svelte';
	import StoryMapMinimap from './StoryMapMinimap.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { messageStore } from '$lib/stores/messages.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { generalSettingsStore } from '$lib/stores/general-settings.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { chatPersonaEntry } from '$lib/utils/chat-setup';
	import { memoryStore } from '$lib/memory/store.svelte';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { formatMessageTime, relativeClock } from '$lib/utils/time-format.svelte';
	import { expandSelfRefs } from '$lib/macros';
	import { layoutStoryTree, type StoryMapNode } from '$lib/utils/story-map-layout';
	import { findDeepestLeafFromNode } from '$lib/utils/message-tree';
	import { branchColorHex } from '$lib/utils/branch-labels';
	import type { BranchLabel } from '$lib/types/chat';

	// ===== Geometry =====
	const PAD = 46;
	const COL_W = 56;
	const ROW_H = 98;
	/** A dot's size is how much was written at it. A map where every turn is the same circle
	 *  is a diagram of pointers; sized, the story's own rhythm is in it: a long reply reads
	 *  as weight, a one-line aside as a beat, and a stretch of both as pacing. Square root,
	 *  not linear: turns run from a dozen characters to several thousand, and a linear map
	 *  would leave everything short indistinguishable at the bottom of the range. */
	const R_MIN = 10;
	const R_MAX = 19;
	const R_FULL_AT = 2000;
	/** Invisible hit disc radius: keeps touch targets ~44px without fattening the visuals. */
	const HIT_R = 22;
	const MIN_K = 0.05;
	const MAX_K = 2.6;
	/** Below this the canvas is an overview, not a document: dots are specks, and a reader
	 *  can't tell which one they are standing on. Two things follow from that one fact:
	 *  branch names are dropped (the bookmark bar carries them at this zoom), and the map
	 *  refuses to OPEN here, because a story tall enough to land under it is exactly the
	 *  story whose reader most needs to see where they are. */
	const DETAIL_K = 0.35;

	let chat = $derived(chatStore.currentChatState?.chat ?? null);
	let allMessages = $derived(chatStore.currentChatState?.allMessages ?? []);

	let graph = $derived(layoutStoryTree(allMessages, chat?.activeLeafId ?? null, chat?.canonLeafId ?? null));
	let nodeById = $derived(new Map(graph.nodes.map((n) => [n.id, n])));
	// Children per node in sibling order, which powers keyboard navigation between turns.
	let kidsOf = $derived.by(() => {
		const m = new Map<string | null, StoryMapNode[]>();
		for (const n of graph.nodes) {
			const arr = m.get(n.parentId) ?? [];
			arr.push(n);
			m.set(n.parentId, arr);
		}
		for (const arr of m.values()) arr.sort((a, b) => a.siblingIndex - b.siblingIndex);
		return m;
	});
	// Draw plain edges first, then the active path, then canon on top, so the highlighted
	// orthogonal routes are never painted over by a neighbouring grey elbow.
	let sortedEdges = $derived(
		[...graph.edges].sort(
			(a, b) =>
				(a.onCanonPath ? 2 : a.onActivePath ? 1 : 0) - (b.onCanonPath ? 2 : b.onActivePath ? 1 : 0)
		)
	);
	let worldWidth = $derived((Math.max(1, graph.columns) - 1) * COL_W + 2 * PAD);
	let worldHeight = $derived((Math.max(1, graph.rows) - 1) * ROW_H + 2 * PAD);
	let branchCount = $derived(graph.nodes.filter((n) => n.isLeaf).length);
	// The number the reader recognises as the size of their story: what the transcript would
	// show. Counting every node instead reports the whole forest (every abandoned fork and
	// every unread greeting) under the word "turns", so a sixty-turn story reads as 244.
	// Same rule as the chats panel: two counts, both labelled (see the Chats panel section).
	let pathTurns = $derived(graph.nodes.filter((n) => n.onActivePath).length);
	let labeledNodes = $derived(
		graph.nodes.filter((n) => n.label).sort((a, b) => a.depth - b.depth || a.col - b.col)
	);

	const cxOf = (n: StoryMapNode) => n.col * COL_W + PAD;
	const cyOf = (n: StoryMapNode) => n.depth * ROW_H + PAD;
	const rOf = (n: StoryMapNode) =>
		R_MIN + (R_MAX - R_MIN) * Math.min(1, Math.sqrt(n.content.length / R_FULL_AT));

	// Turns the memory engine has folded into a summary, ghosted here the way the transcript
	// ghosts them: the map is where "the model only remembers this stretch in summary" is
	// worth seeing as a shape. Empty whenever the active preset doesn't inject {{memory}},
	// and only ever covers the active path, so no other branch can read as folded.
	let archivedIds = $derived(memoryStore.archivedMessageIds);

	// {{char}}/{{user}} resolve live for every preview surface, same as the chat renders
	// them (coupling #6 in architecture/chat-sessions.md). Rows stay raw.
	let selfRefChar = $derived(
		characterLibraryStore.entries.find((e) => e.id === chat?.characterId)?.identity.name || 'Story'
	);
	let selfRefUser = $derived(chatPersonaEntry(chatStore.activeChat)?.identity.name || 'You');

	function roleLabel(role: StoryMapNode['role']): string {
		return role === 'user' ? 'You' : role === 'assistant' ? selfRefChar : 'System';
	}

	function expandText(text: string, cap: number): string {
		const t = expandSelfRefs(text, selfRefChar, selfRefUser);
		return t.length > cap ? t.slice(0, cap) + '…' : t || '(empty)';
	}

	function hoverSnippet(text: string, cap: number): string {
		return expandText(text.replace(/\s+/g, ' ').trim(), cap);
	}

	// Times here obey the same Message Details settings the transcript obeys, through the one
	// module allowed to format them (coupling 10). Hand-rolled `toLocale*` at this call site
	// left the map as the one surface ignoring the user's 12/24-hour pick.
	let appearance = $derived(themeStore.appearance);
	function fmtTime(ts: number): string {
		return formatMessageTime(
			ts,
			appearance.timestampFormat,
			appearance.clockFormat,
			// Only a relative label depends on the shared tick; reading it under the same
			// guard keeps absolute labels out of the 30s re-render.
			appearance.timestampFormat === 'relative' ? relativeClock.now : 0
		);
	}

	// ===== View transform (pan/zoom) =====
	let tx = $state(0);
	let ty = $state(0);
	let k = $state(1);
	let stageEl = $state<HTMLDivElement | undefined>(undefined);
	let canvasEl = $state<HTMLDivElement | undefined>(undefined);
	let inspEl = $state<HTMLDivElement | undefined>(undefined);
	let stageW = $state(0);
	let stageH = $state(0);
	let pct = $derived(Math.round(k * 100));
	let lastFitKey = '';
	/** True once the user pans/zooms by hand, after which a resize keeps their framing. */
	let userMovedView = false;

	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

	function reducedMotion(): boolean {
		return (
			document.documentElement.getAttribute('data-motion') === 'reduced' ||
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		);
	}

	let animId: number | null = null;
	function cancelAnim() {
		if (animId !== null) {
			cancelAnimationFrame(animId);
			animId = null;
		}
	}

	/** One rule for every camera move: how long it takes follows how far it actually goes. A
	 *  nudge to the turn next door has no business costing as much as a flight across the
	 *  forest, and a flight crammed into a nudge's time reads as a cut rather than a move. */
	function moveDuration(dx: number, dy: number, kRatio: number): number {
		return clamp(150 + Math.hypot(dx, dy) * 0.16 + Math.abs(Math.log2(kRatio)) * 90, 150, 420);
	}

	/** Camera tween. Two things here are deliberate, and both are about how the move READS
	 *  rather than how long it lasts. **Scale interpolates geometrically**: perceived zoom is
	 *  logarithmic, so stepping k linearly across a wide range swings the actual zoom rate by
	 *  well over 10% mid-move: the view lunges, then crawls. Stepping the ratio holds it
	 *  constant. **The pan is then derived from the world point under the stage centre**
	 *  instead of being lerped from tx/ty, and that half exists ONLY because of the first
	 *  half: tx/ty are pixel offsets that mean something different at every scale, so once k
	 *  moves geometrically a linear tx/ty bows the target's screen path (~190px on a long
	 *  flight) instead of running it straight at its landing spot. Rebuilding tx/ty from the
	 *  frame's own scale keeps that path straight. Change one of these without the other and
	 *  the move gets worse, not better. Both endpoints stay exact either way. */
	function animateView(toTx: number, toTy: number, toK = k, dur?: number) {
		cancelAnim();
		const kRatio = toK / k;
		const ms = dur ?? moveDuration(toTx - tx, toTy - ty, kRatio);
		if (reducedMotion() || ms <= 0) {
			tx = toTx;
			ty = toTy;
			k = toK;
			return;
		}
		const px = stageW / 2;
		const py = stageH / 2;
		const k0 = k;
		const fromCx = (px - tx) / k0;
		const fromCy = (py - ty) / k0;
		const toCx = (px - toTx) / toK;
		const toCy = (py - toTy) / toK;
		const start = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / ms);
			const e = 1 - Math.pow(1 - t, 3);
			const nk = k0 * Math.pow(kRatio, e);
			k = nk;
			tx = px - (fromCx + (toCx - fromCx) * e) * nk;
			ty = py - (fromCy + (toCy - fromCy) * e) * nk;
			animId = t < 1 ? requestAnimationFrame(step) : null;
		};
		animId = requestAnimationFrame(step);
	}

	function computeFit(): { tx: number; ty: number; k: number } | null {
		if (graph.nodes.length === 0 || stageW === 0 || stageH === 0) return null;
		const nk = clamp(Math.min((stageW - 48) / worldWidth, (stageH - 48) / worldHeight, 1), MIN_K, MAX_K);
		return {
			tx: (stageW - worldWidth * nk) / 2,
			ty: Math.max(20, (stageH - worldHeight * nk) / 2),
			k: nk
		};
	}

	/** How the map arrives, which is NOT the same question as what Fit answers. Fitting a
	 *  sixty-turn story into a phone screen is arithmetic: it lands at a few percent, where
	 *  the whole tree is a column of specks and nothing about it can be read. So the opening
	 *  view falls back to the reader's own position at a readable size, with the shape around
	 *  it, and Fit stays one button away for when seeing all of it IS the question. */
	function computeOpeningView(): { tx: number; ty: number; k: number } | null {
		const f = computeFit();
		if (!f || f.k >= DETAIL_K) return f;
		const focusId = chat?.activeLeafId && nodeById.has(chat.activeLeafId) ? chat.activeLeafId : graph.nodes[0]?.id;
		const n = focusId ? nodeById.get(focusId) : null;
		if (!n) return f;
		const nk = FOCUS_K_MIN;
		return { tx: stageW / 2 - cxOf(n) * nk, ty: stageH / 2 - cyOf(n) * nk, k: nk };
	}

	function openView(): boolean {
		const f = computeOpeningView();
		if (!f) return false;
		cancelAnim();
		tx = f.tx;
		ty = f.ty;
		k = f.k;
		userMovedView = false;
		return true;
	}

	function fitAnimated() {
		const f = computeFit();
		if (!f) return;
		animateView(f.tx, f.ty, f.k);
		userMovedView = false;
	}

	/** The stage area the inspector card/sheet doesn't cover, i.e. where nodes are readable. */
	function safeBox(): { left: number; top: number; right: number; bottom: number } {
		let left = 24;
		let top = 24;
		let right = stageW - 24;
		let bottom = stageH - 24;
		if (inspEl && stageEl) {
			const stageRect = stageEl.getBoundingClientRect();
			const r = inspEl.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) {
				const sheetLike = r.top - stageRect.top > stageH * 0.5;
				if (sheetLike) bottom = Math.min(bottom, r.top - stageRect.top - 16);
				else right = Math.min(right, r.left - stageRect.left - 16);
			}
		}
		return { left, top, right, bottom };
	}

	/** Zoom band a focus jump settles into. Centering at whatever scale the view happened to
	 *  hold puts the user on an unreadable speck when they were zoomed out to see the whole
	 *  forest, or on a lone dot with no context when they were pushed right in, so a bookmark
	 *  chip or a search hit pulls the scale back into a band where the node and its neighbours
	 *  both read. Framing already inside the band is left exactly as it is: nudging it would
	 *  fight a deliberate choice for no gain. */
	const FOCUS_K_MIN = 0.7;
	const FOCUS_K_MAX = 1.3;

	function centerOn(id: string) {
		const n = nodeById.get(id);
		if (!n) return;
		const b = safeBox();
		if (b.right - b.left < 80 || b.bottom - b.top < 80) return;
		const nk = clamp(k, FOCUS_K_MIN, FOCUS_K_MAX);
		animateView((b.left + b.right) / 2 - cxOf(n) * nk, (b.top + b.bottom) / 2 - cyOf(n) * nk, nk);
		// Jumping to a branch IS a framing choice, so a later resize must keep it rather than
		// re-fitting the whole forest and throwing the focus away.
		userMovedView = true;
	}

	/** Minimap navigation: instant, it tracks the dragging finger 1:1. */
	function centerWorld(wx: number, wy: number) {
		cancelAnim();
		tx = stageW / 2 - wx * k;
		ty = stageH / 2 - wy * k;
		userMovedView = true;
	}

	function zoomAt(px: number, py: number, factor: number) {
		const nk = clamp(k * factor, MIN_K, MAX_K);
		tx = px - (px - tx) * (nk / k);
		ty = py - (py - ty) * (nk / k);
		k = nk;
		userMovedView = true;
	}

	function zoomBy(factor: number) {
		cancelAnim();
		zoomAt(stageW / 2, stageH / 2, factor);
	}

	/** Wheel deltas are pixels on a trackpad, lines on a Firefox mouse wheel and pages on a
	 *  page-scroll device. Zooming absorbed the difference in its exponent; panning cannot,
	 *  and unconverted a Firefox notch nudges the canvas three pixels. Same conversion as the
	 *  chat column's margin wheel in `ChatContainer`. */
	function wheelPixels(delta: number, mode: number, pageExtent: number): number {
		return delta * (mode === 1 ? 16 : mode === 2 ? pageExtent : 1);
	}

	function onWheel(e: WheelEvent) {
		if (!canvasEl) return;
		e.preventDefault();
		cancelAnim();
		// A trackpad pinch reaches the page as ctrl+wheel, so the zoom modifier IS the pinch
		// gesture and has to keep zooming whichever way the plain wheel is set. Shift is the
		// other fixed one: sideways pan in both modes.
		const zooming =
			e.ctrlKey || e.metaKey || !generalSettingsStore.storyMapWheelPans;
		if (zooming && !e.shiftKey) {
			const rect = canvasEl.getBoundingClientRect();
			const dy = wheelPixels(e.deltaY, e.deltaMode, stageH);
			// A pinch streams tiny deltas where a notch sends one big quantized jump, and with
			// panning on, ctrl+wheel is a mouse's only way to zoom, so the rate follows the
			// delta's own size rather than the modifier, which would give a notch the pinch
			// rate and swing the view several times over per click. Misreading this only makes
			// a zoom faster or slower; it can never turn a gesture into the wrong action.
			const factor = Math.exp(-dy * (Math.abs(dy) < 25 ? 0.012 : 0.0019));
			zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
			return;
		}
		// Shift turns a vertical-only wheel sideways; a trackpad sends its own deltaX and
		// needs no help, so it keeps both axes.
		const dx = wheelPixels(e.deltaX, e.deltaMode, stageW);
		const dy = wheelPixels(e.deltaY, e.deltaMode, stageH);
		tx -= e.shiftKey && dx === 0 ? dy : dx;
		if (!e.shiftKey) ty -= dy;
		userMovedView = true;
	}

	// Stage size drives fit, the minimap and the hover card clamping. A resize keeps the
	// user's framing when they've moved by hand, otherwise re-fits.
	$effect(() => {
		const el = stageEl;
		if (!el) return;
		const ro = new ResizeObserver(() => {
			stageW = el.clientWidth;
			stageH = el.clientHeight;
			if (!userMovedView) openView();
		});
		ro.observe(el);
		stageW = el.clientWidth;
		stageH = el.clientHeight;
		return () => ro.disconnect();
	});

	// Reset the view once per chat (keyed on chat + has-nodes), the first time the stage has
	// a real size. Navigation within the same chat keeps the key stable, so the user's pan
	// / zoom survives jumping between branches.
	$effect(() => {
		const key = `${chat?.id ?? ''}:${graph.nodes.length > 0}`;
		if (key === lastFitKey || !stageEl || graph.nodes.length === 0) return;
		requestAnimationFrame(() => {
			if (openView()) lastFitKey = key;
		});
	});

	// ===== Pointer: pan vs. click vs. pinch =====
	const pointers = new Map<number, { x: number; y: number }>();
	let panning = $state(false);
	let moved = $state(false);
	let pinching = false;
	let pinch0: { d: number; k: number; wx: number; wy: number } | null = null;
	let downX = 0;
	let downY = 0;
	let downTx = 0;
	let downTy = 0;
	let downNodeId: string | null = null;
	let lastPointerType = 'mouse';

	function nodeIdFromEvent(e: Event): string | null {
		const el = (e.target as HTMLElement | null)?.closest?.('[data-node]') as HTMLElement | null;
		return el?.getAttribute('data-node') ?? null;
	}

	/** Chromium arms its middle-click autoscroll on mousedown, and the middle-drag pan needs it gone. */
	function onMouseDown(e: MouseEvent) {
		if (e.button === 1) e.preventDefault();
	}

	function onPointerDown(e: PointerEvent) {
		// Left is drag-or-click; middle is a pure pan (never selects, never opens a turn).
		const middlePan = e.pointerType === 'mouse' && e.button === 1;
		if (e.pointerType === 'mouse' && e.button !== 0 && !middlePan) return;
		lastPointerType = e.pointerType;
		cancelAnim();
		hideHover();
		canvasEl?.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) {
			downX = e.clientX;
			downY = e.clientY;
			downTx = tx;
			downTy = ty;
			downNodeId = middlePan ? null : nodeIdFromEvent(e);
			moved = middlePan;
			panning = true;
		} else if (pointers.size === 2 && canvasEl) {
			const [p1, p2] = [...pointers.values()];
			const rect = canvasEl.getBoundingClientRect();
			const midX = (p1.x + p2.x) / 2 - rect.left;
			const midY = (p1.y + p2.y) / 2 - rect.top;
			pinch0 = {
				d: Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y)),
				k,
				wx: (midX - tx) / k,
				wy: (midY - ty) / k
			};
			pinching = true;
			moved = true; // a second finger is never a click
			downNodeId = null;
		}
	}

	function onPointerMove(e: PointerEvent) {
		if (pointers.has(e.pointerId)) {
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pinching && pointers.size >= 2 && pinch0 && canvasEl) {
				const [p1, p2] = [...pointers.values()];
				const rect = canvasEl.getBoundingClientRect();
				const midX = (p1.x + p2.x) / 2 - rect.left;
				const midY = (p1.y + p2.y) / 2 - rect.top;
				const d = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
				const nk = clamp(pinch0.k * (d / pinch0.d), MIN_K, MAX_K);
				k = nk;
				tx = midX - pinch0.wx * nk;
				ty = midY - pinch0.wy * nk;
				userMovedView = true;
				return;
			}
			if (!panning) return;
			const dx = e.clientX - downX;
			const dy = e.clientY - downY;
			if (!moved && Math.hypot(dx, dy) > 4) moved = true;
			if (moved) {
				tx = downTx + dx;
				ty = downTy + dy;
				userMovedView = true;
			}
			return;
		}
		// No captured pointer: plain mouse travel drives the hover preview.
		if (e.pointerType === 'mouse') trackHover(e);
	}

	function onPointerUp(e: PointerEvent) {
		if (!pointers.has(e.pointerId)) return;
		pointers.delete(e.pointerId);
		canvasEl?.releasePointerCapture?.(e.pointerId);
		if (pinching) {
			if (pointers.size < 2) {
				pinching = false;
				pinch0 = null;
				if (pointers.size === 1) {
					// One finger stays down, so hand over to panning without a jump.
					const [p] = [...pointers.values()];
					downX = p.x;
					downY = p.y;
					downTx = tx;
					downTy = ty;
				} else {
					panning = false;
				}
			}
			return;
		}
		if (pointers.size > 0) return;
		panning = false;
		if (moved) return; // it was a drag, not a click
		if (downNodeId) handleNodeClick(downNodeId);
		else selectedId = null;
	}

	// ===== Hover preview card (mouse only) =====
	const CARD_W = 264;
	let hover = $state<{ id: string; x: number; y: number } | null>(null);
	let hoverPendingId: string | null = null;
	let hoverTimer: ReturnType<typeof setTimeout> | null = null;

	function trackHover(e: PointerEvent) {
		const id = nodeIdFromEvent(e);
		if (id === (hover?.id ?? hoverPendingId)) return;
		if (hoverTimer) clearTimeout(hoverTimer);
		hoverTimer = null;
		if (!id) {
			hover = null;
			hoverPendingId = null;
			return;
		}
		hoverPendingId = id;
		hoverTimer = setTimeout(() => {
			hover = placeHover(id);
			hoverPendingId = null;
		}, 130);
	}

	function placeHover(id: string): { id: string; x: number; y: number } | null {
		const n = nodeById.get(id);
		if (!n) return null;
		const sx = cxOf(n) * k + tx;
		const sy = cyOf(n) * k + ty;
		let x = sx + rOf(n) * k + 16;
		if (x + CARD_W > stageW - 8) x = sx - rOf(n) * k - 16 - CARD_W;
		const y = clamp(sy - 24, 8, Math.max(8, stageH - 180));
		return { id, x: Math.max(8, x), y };
	}

	function hideHover() {
		if (hoverTimer) clearTimeout(hoverTimer);
		hoverTimer = null;
		hoverPendingId = null;
		hover = null;
	}

	// Any view movement (pan, zoom, tween) invalidates the card's anchor, so drop it.
	$effect(() => {
		void tx;
		void ty;
		void k;
		hover = null;
	});

	// ===== Selection + inspector =====
	let selectedId = $state<string | null>(null);
	let selected = $derived(selectedId ? (nodeById.get(selectedId) ?? null) : null);

	// A structural change made in the chat can delete the node under the selection or the
	// compare anchor, so drop the stale ids instead of pointing the UI at ghosts.
	$effect(() => {
		if (selectedId && !nodeById.has(selectedId)) selectedId = null;
		if (compareFrom && !nodeById.has(compareFrom)) compareFrom = null;
	});

	function selectNode(id: string, opts: { center?: boolean; focusDom?: boolean } = {}) {
		selectedId = id;
		// Defer a frame so the freshly-mounted inspector's rect is known to safeBox().
		requestAnimationFrame(() => {
			if (opts.center) centerOn(id);
			else ensureVisible(id);
		});
		if (opts.focusDom) {
			requestAnimationFrame(() => {
				stageEl?.querySelector<SVGGElement>(`[data-node="${CSS.escape(id)}"]`)?.focus();
			});
		}
	}

	function handleNodeClick(id: string) {
		if (compareFrom && compareFrom !== id) {
			openCompare(compareFrom, id);
			return;
		}
		selectNode(id);
	}

	/** Bookmark chips act like node clicks, so two chip taps can drive a compare. */
	function handleChipClick(id: string) {
		if (compareFrom && compareFrom !== id) {
			openCompare(compareFrom, id);
			return;
		}
		selectNode(id, { center: true });
	}

	/** Nudge the view (never the zoom) until the node sits inside the area the inspector
	 *  and edges don't cover, so selecting a node can't leave it hidden under the card. */
	function ensureVisible(id: string) {
		const n = nodeById.get(id);
		if (!n || !stageEl) return;
		const b = safeBox();
		if (b.right - b.left < 80 || b.bottom - b.top < 80) return;
		const sx = cxOf(n) * k + tx;
		const sy = cyOf(n) * k + ty;
		const m = 30;
		let dx = 0;
		let dy = 0;
		if (sx < b.left + m) dx = b.left + m - sx;
		else if (sx > b.right - m) dx = b.right - m - sx;
		if (sy < b.top + m) dy = b.top + m - sy;
		else if (sy > b.bottom - m) dy = b.bottom - m - sy;
		if (dx !== 0 || dy !== 0) animateView(tx + dx, ty + dy);
	}

	async function jumpTo(id: string) {
		if (!chat || messageStore.warnIfBusy()) return;
		await messageStore.navigateToBranch(id);
		// Jumping means "take me there", so land the user in the chat on that branch.
		uiStore.closeOverlay();
		// A branch is reached by its deepest leaf, which is rarely the turn that was picked.
		// Name it so the transcript brings THAT turn into view: without it the reader arrives
		// somewhere down a timeline they have never read, with nothing saying where the turn
		// they were just looking at went.
		messageStore.revealTargetId = id;
	}

	// ===== Compare =====
	let compareFrom = $state<string | null>(null);
	let compareLeaves = $state<{ a: string; b: string } | null>(null);
	let compareAnchor = $derived(compareFrom ? (nodeById.get(compareFrom) ?? null) : null);
	let canCompareCurrent = $derived(!!chat?.activeLeafId && !!compareAnchor && !compareAnchor.onActivePath);

	function startCompare() {
		if (!selectedId) return;
		closeSearch();
		compareFrom = selectedId;
	}

	function openCompare(aNodeId: string, bNodeId: string) {
		// Compare the two *branches*: resolve each picked node to the tip of its subtree so we
		// read full divergent timelines, not just the two clicked points.
		const a = findDeepestLeafFromNode(allMessages, aNodeId);
		const b = findDeepestLeafFromNode(allMessages, bNodeId);
		compareFrom = null;
		compareLeaves = { a, b };
	}

	function compareWithCurrent() {
		if (!compareFrom || !chat?.activeLeafId) return;
		openCompare(compareFrom, chat.activeLeafId);
	}

	// ===== Search =====
	let searchOpen = $state(false);
	let query = $state('');
	let matchIdx = $state(-1);
	let searchInputEl = $state<HTMLInputElement | undefined>(undefined);
	let searchActive = $derived(query.trim().length > 0);
	let matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		return graph.nodes.filter(
			(n) =>
				expandSelfRefs(n.content, selfRefChar, selfRefUser).toLowerCase().includes(q) ||
				(n.label?.name.toLowerCase().includes(q) ?? false)
		);
	});
	let matchSet = $derived(new Set(matches.map((m) => m.id)));

	$effect(() => {
		void query;
		matchIdx = -1;
	});

	$effect(() => {
		if (searchOpen) requestAnimationFrame(() => searchInputEl?.focus());
	});

	function toggleSearch() {
		if (searchOpen) closeSearch();
		else searchOpen = true;
	}

	function closeSearch() {
		searchOpen = false;
		query = '';
	}

	function cycleMatch(dir: 1 | -1) {
		if (matches.length === 0) return;
		matchIdx =
			matchIdx < 0
				? dir === 1
					? 0
					: matches.length - 1
				: (matchIdx + dir + matches.length) % matches.length;
		selectNode(matches[matchIdx].id, { center: true });
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			cycleMatch(e.shiftKey ? -1 : 1);
		} else if (e.key === 'Escape') {
			// Stop the press here: the layered window handler (and the workspace's panel
			// close) must not also consume it.
			e.preventDefault();
			e.stopPropagation();
			closeSearch();
		}
	}

	// ===== Keyboard on the canvas =====
	function moveFocus(from: StoryMapNode, dir: 'up' | 'down' | 'left' | 'right') {
		let next: StoryMapNode | undefined;
		if (dir === 'up') {
			next = from.parentId ? nodeById.get(from.parentId) : undefined;
		} else if (dir === 'down') {
			const kids = kidsOf.get(from.id) ?? [];
			next = kids.find((c) => c.onActivePath) ?? kids[0];
		} else {
			const sibs = kidsOf.get(from.parentId) ?? [];
			const i = sibs.findIndex((s) => s.id === from.id);
			next = dir === 'left' ? sibs[i - 1] : sibs[i + 1];
		}
		if (next) selectNode(next.id, { focusDom: true });
	}

	let rovingId = $derived(
		(selectedId && nodeById.has(selectedId) ? selectedId : null) ??
			(chat?.activeLeafId && nodeById.has(chat.activeLeafId) ? chat.activeLeafId : null) ??
			graph.nodes[0]?.id ??
			null
	);

	function keyContextNode(e: KeyboardEvent): StoryMapNode | null {
		const focused = nodeIdFromEvent(e);
		const id = selected?.id ?? focused ?? rovingId;
		return id ? (nodeById.get(id) ?? null) : null;
	}

	function onCanvasKeydown(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowUp':
			case 'ArrowDown':
			case 'ArrowLeft':
			case 'ArrowRight': {
				e.preventDefault();
				const from = keyContextNode(e);
				if (!from) return;
				if (!selectedId) selectNode(from.id, { focusDom: true });
				else moveFocus(from, e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowLeft' ? 'left' : 'right');
				break;
			}
			case 'Enter': {
				const target = nodeIdFromEvent(e) ?? selectedId;
				if (target) {
					e.preventDefault();
					jumpTo(target);
				}
				break;
			}
			case '+':
			case '=':
				e.preventDefault();
				zoomBy(1.2);
				break;
			case '-':
			case '_':
				e.preventDefault();
				zoomBy(1 / 1.2);
				break;
			case '0':
				e.preventDefault();
				fitAnimated();
				break;
		}
	}

	// Layered Escape, backing out one level per press: compare pick, then search, then the
	// selection; an unconsumed press falls through to the workspace, which closes the panel.
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.defaultPrevented) return;
		if (compareLeaves) return; // the compare modal owns the key
		// Escape inside the inspector's branch-name field just leaves the field.
		// It must not tear down the whole selection (and the typed draft) with it.
		const t = e.target as HTMLElement | null;
		if (t && inspEl?.contains(t) && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) {
			e.preventDefault();
			t.blur();
			return;
		}
		if (compareFrom) {
			e.preventDefault();
			compareFrom = null;
			return;
		}
		if (searchOpen) {
			e.preventDefault();
			closeSearch();
			return;
		}
		if (selectedId) {
			e.preventDefault();
			selectedId = null;
		}
	}

	// ===== Store-backed actions =====
	// The map is a read-and-navigate surface: nothing here writes a turn's content or removes
	// one. The only rows it touches are its own annotations (the chat's canon pointer and a
	// branch's label) plus the active leaf, which is navigation. Rewriting and deleting turns
	// belongs to the transcript, where the memory cost of an edit is measured and confirmed
	// (architecture/memory.md); a second door onto those without that accounting is how a
	// summarised turn gets rewritten with no one told what it cost.
	// Neither of these says anything: the crown and the gold path appear on the canvas the
	// click landed on, and a branch name shows up as its own chip beside the node.
	async function toggleCanon() {
		if (!selected) return;
		await chatStore.setCanonLeaf(selected.isCanonLeaf ? null : selected.id);
	}

	async function saveLabel(label: BranchLabel | null) {
		if (!selectedId) return;
		await messageStore.setBranchLabel(selectedId, label);
	}

	// ===== Minimap =====
	let minimapOn = $state<boolean | null>(null);
	let minimapVisible = $derived(minimapOn ?? (graph.nodes.length > 30 && !viewport.isMobile));

	// ===== SVG helpers =====
	function nodeAria(n: StoryMapNode): string {
		const parts = [`${roleLabel(n.role)} turn ${n.depth + 1}`];
		if (n.label) parts.push(`branch "${n.label.name}"`);
		if (n.siblingCount > 1) parts.push(`variant ${n.siblingIndex + 1} of ${n.siblingCount}`);
		if (n.isForkPoint) parts.push(`${n.childCount} branches below`);
		if (n.isActiveLeaf) parts.push('current position');
		else if (n.onActivePath) parts.push('on current path');
		if (n.isCanonLeaf) parts.push('canon ending');
		else if (n.onCanonPath) parts.push('on canon path');
		return parts.join(', ');
	}

	// Crown glyph placed above the canon leaf. Native path lives in a 24×24 box.
	const CROWN_D = 'M3 8l4 4 5-7 5 7 4-4-1.7 9.5H4.7z';
	function crownTransform(n: StoryMapNode): string {
		const s = 0.62;
		const x = cxOf(n) - 12 * s;
		const y = cyOf(n) - rOf(n) - 6 - 17.5 * s;
		return `translate(${x} ${y}) scale(${s})`;
	}

	/** Screen position of a node's centre, i.e. where the DOM chrome over the canvas anchors. */
	function screenX(n: StoryMapNode): number {
		return cxOf(n) * k + tx;
	}
	function screenY(n: StoryMapNode): number {
		return cyOf(n) * k + ty;
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="map-view">
	<header class="overlay-header overlay-header--stacked">
		<h2 class="overlay-title">Story Map</h2>
		<div class="overlay-crumb">
			{#if chat}
				<span class="overlay-subject">{chat.title}</span>
				<span class="overlay-facts">
					{pathTurns} turn{pathTurns === 1 ? '' : 's'}{branchCount > 1
						? ` on this branch · ${branchCount} branches`
						: ''}
				</span>
			{:else}
				<span class="overlay-facts">No chat open</span>
			{/if}
		</div>
	</header>

	<div class="map-stage" bind:this={stageEl}>
		{#if !chat}
			<div class="map-empty">
				<EmptyState icon="sitemap" size="sm">Open a chat to see its story map.</EmptyState>
			</div>
		{:else if graph.nodes.length === 0}
			<div class="map-empty">
				<EmptyState icon="sitemap" size="sm" title="No messages yet">
					Write your first turn, and branches will appear here as the story splits.
				</EmptyState>
			</div>
		{:else}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- role="application" is the correct ARIA for a pan/zoom canvas; the linter just doesn't count it as interactive -->
			<div
				class="map-canvas"
				class:is-panning={panning && moved}
				class:is-picking={!!compareFrom}
				bind:this={canvasEl}
				onwheel={onWheel}
				onmousedown={onMouseDown}
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerUp}
				onpointerleave={hideHover}
				onkeydown={onCanvasKeydown}
				role="application"
				tabindex="0"
				aria-label="Story branch map"
				aria-describedby="storymap-usage"
			>
				<svg class="map-svg" class:is-searching={searchActive} width="100%" height="100%">
					<g transform="translate({tx} {ty}) scale({k})">
						<!-- Edges: orthogonal elbows (stem down from the parent, horizontal bus, drop to
						     each child). Overlapping sibling stems/buses merge into a clean org-chart. -->
						{#each sortedEdges as e (e.from + '>' + e.to)}
							{@const p = nodeById.get(e.from)}
							{@const c = nodeById.get(e.to)}
							{#if p && c}
								{@const x1 = cxOf(p)}
								{@const y1 = cyOf(p) + rOf(p)}
								{@const x2 = cxOf(c)}
								{@const y2 = cyOf(c) - rOf(c)}
								{@const my = (cyOf(p) + cyOf(c)) / 2}
								<path
									class="edge"
									class:edge--active={e.onActivePath}
									class:edge--canon={e.onCanonPath}
									d="M{x1} {y1} V {my} H {x2} V {y2}"
								/>
							{/if}
						{/each}

						<!-- Nodes -->
						{#each graph.nodes as n (n.id)}
							{@const cx = cxOf(n)}
							{@const cy = cyOf(n)}
							{@const r = rOf(n)}
							{@const dimmed = searchActive && !matchSet.has(n.id)}
							<g
								class="node node--{n.role}"
								class:is-selected={n.id === selectedId}
								class:is-archived={archivedIds.has(n.id)}
								class:is-dimmed={dimmed}
								data-node={n.id}
								role="button"
								tabindex={n.id === rovingId ? 0 : -1}
								aria-label={nodeAria(n)}
								aria-pressed={n.id === selectedId}
								ondblclick={() => {
									if (lastPointerType !== 'touch') jumpTo(n.id);
								}}
							>
								<!-- Oversized invisible disc: the real touch/click/focus-ring target. -->
								<circle class="hit" {cx} {cy} r={HIT_R} />

								<!-- Halo: where the reader stands. Canon needs none, since its whole path is
								     already drawn in gold and its tip wears the crown. -->
								{#if n.isActiveLeaf}
									<circle class="halo halo--active-leaf" {cx} {cy} r={r + 4} />
								{:else if n.onActivePath}
									<circle class="halo halo--active" {cx} {cy} r={r + 4} />
								{/if}

								<circle class="node-dot" {cx} {cy} r={r} />

								{#if n.isForkPoint}
									<circle class="fork-pip" {cx} cy={cy} r={4.5} />
								{/if}
							</g>

							<!-- Canon crown on the blessed tip -->
							{#if n.isCanonLeaf}
								<path class="crown" d={CROWN_D} transform={crownTransform(n)} />
							{/if}

						{/each}
					</g>
				</svg>
			</div>

			<!-- Branch names, in screen space rather than inside the SVG. Three reasons, all
			     of them things SVG text cannot do: it has no ellipsis, so the pill had to be
			     sized from a guess at how wide a character is and every string that wasn't the
			     one that guess was tuned on came out mis-sized and off-centre; it carries no
			     real font metrics; and scaled with the canvas the name shrinks to nothing at
			     exactly the zoom a long story is read at. Constant size here, ellipsised by
			     the browser, and gone below DETAIL_K where the bookmark bar carries them. -->
			{#if k >= DETAIL_K && labeledNodes.length > 0}
				<div class="map-labels">
					{#each labeledNodes as n (n.id)}
						<button
							type="button"
							class="map-label"
							class:is-dimmed={searchActive && !matchSet.has(n.id)}
							style="left: {screenX(n)}px; top: {screenY(n) + rOf(n) * k + 6}px; --bc: {branchColorHex(
								n.label!.color
							)};"
							title={n.label!.name}
							onclick={() => handleNodeClick(n.id)}
						>
							<span class="map-label-dot"></span>
							<span class="map-label-name">{n.label!.name}</span>
						</button>
					{/each}
				</div>
			{/if}

			<!-- Top chrome, stacked so the strips never overlap: labeled-branch bookmarks,
			     then the transient strip (search / compare pick / teaching hint). -->
			<div class="map-top">
			{#if labeledNodes.length > 0}
				<nav class="map-branches surface-float" aria-label="Labeled branches">
					{#each labeledNodes as n (n.id)}
						<button
							type="button"
							class="branch-chip"
							style="--bc: {branchColorHex(n.label!.color)};"
							title={n.label!.name}
							onclick={() => handleChipClick(n.id)}
						>
							<span class="branch-chip-dot"></span>
							<span class="branch-chip-name">{n.label!.name}</span>
						</button>
					{/each}
				</nav>
			{/if}

			{#if searchOpen}
				<div class="map-search surface-float">
					<Icon name="search" class="w-4 h-4" />
					<input
						bind:this={searchInputEl}
						bind:value={query}
						type="text"
						placeholder="Search turns and branch names…"
						aria-label="Search turns and branch names"
						onkeydown={onSearchKeydown}
					/>
					<span class="map-search-count" aria-live="polite">
						{searchActive ? `${matchIdx >= 0 ? `${matchIdx + 1} / ` : ''}${matches.length}` : ''}
					</span>
					<button
						type="button"
						class="map-tool-btn map-tool-btn--sm"
						aria-label="Previous match"
						disabled={matches.length === 0}
						onclick={() => cycleMatch(-1)}
					>
						<Icon name="chevronUp" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="map-tool-btn map-tool-btn--sm"
						aria-label="Next match"
						disabled={matches.length === 0}
						onclick={() => cycleMatch(1)}
					>
						<Icon name="chevronDown" class="w-4 h-4" />
					</button>
					<button type="button" class="map-tool-btn map-tool-btn--sm" aria-label="Close search" onclick={closeSearch}>
						<Icon name="close" class="w-4 h-4" />
					</button>
				</div>
			{:else if compareFrom}
				<div class="map-banner surface-float" role="status" aria-live="polite">
					<Icon name="columns" class="w-4 h-4" />
					<span>Pick the branch to compare against</span>
					{#if canCompareCurrent}
						<button type="button" class="map-banner-btn" onclick={compareWithCurrent}>Use current path</button>
					{/if}
					<button type="button" class="map-banner-btn map-banner-btn--ghost" onclick={() => (compareFrom = null)}>
						Cancel
					</button>
				</div>
			{/if}
			</div>

			<!-- Legend -->
			<div class="map-legend surface-float">
				<span class="lg"><span class="lg-swatch lg-active"></span>Current path</span>
				<span class="lg"><span class="lg-swatch lg-canon"></span>Canon</span>
				<span class="lg"><span class="lg-swatch lg-fork"></span>Fork</span>
			</div>

			<!-- Bottom-right: overview + view controls, thumb-reachable on touch. -->
			<div class="map-corner">
				{#if minimapVisible}
					<StoryMapMinimap
						nodes={graph.nodes}
						{worldWidth}
						{worldHeight}
						colW={COL_W}
						rowH={ROW_H}
						pad={PAD}
						{tx}
						{ty}
						{k}
						viewW={stageW}
						viewH={stageH}
						onNavigate={centerWorld}
					/>
				{/if}
				<div class="map-tools surface-float" role="toolbar" aria-label="Map tools">
					<!-- Search sits with the other tools rather than in the header, so every
					     control over the canvas is in one place. -->
					<button
						type="button"
						class="map-tool-btn"
						class:is-on={searchOpen}
						aria-pressed={searchOpen}
						aria-label="Search turns"
						title="Search turns and branch names"
						onclick={toggleSearch}
					>
						<Icon name="search" class="w-4 h-4" />
					</button>
					<span class="map-tools-sep"></span>
					<button type="button" class="map-tool-btn" aria-label="Zoom out" title="Zoom out (-)" onclick={() => zoomBy(1 / 1.2)}>
						<Icon name="minimize" class="w-4 h-4" />
					</button>
					<span class="map-zoom-level">{pct}%</span>
					<button type="button" class="map-tool-btn" aria-label="Zoom in" title="Zoom in (+)" onclick={() => zoomBy(1.2)}>
						<Icon name="plus" class="w-4 h-4" />
					</button>
					<span class="map-tools-sep"></span>
					<button type="button" class="map-tool-btn" aria-label="Fit map to view" title="Fit to view (0)" onclick={fitAnimated}>
						<Icon name="maximize" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="map-tool-btn"
						aria-label="Center on current position"
						title="Center on current position"
						onclick={() => chat?.activeLeafId && centerOn(chat.activeLeafId)}
					>
						<Icon name="target" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="map-tool-btn"
						class:is-on={minimapVisible}
						aria-pressed={minimapVisible}
						aria-label="Toggle overview map"
						title="Toggle overview map"
						onclick={() => (minimapOn = !minimapVisible)}
					>
						<Icon name="radar" class="w-4 h-4" />
					</button>
				</div>
			</div>

			<!-- Hover preview (mouse only; duplicates the node's aria-label for sighted use) -->
			{#if hover}
				{@const hn = nodeById.get(hover.id)}
				{#if hn}
					<div class="map-hovercard surface-float" style="left: {hover.x}px; top: {hover.y}px;" aria-hidden="true">
						<div class="hc-head">
							<span class="hc-dot hc-dot--{hn.role}"></span>
							<span class="hc-role">{roleLabel(hn.role)}</span>
							<span class="hc-turn">Turn {hn.depth + 1}</span>
							<span class="hc-time">{fmtTime(hn.createdAt)}</span>
						</div>
						{#if hn.label}
							<span class="hc-label" style="--bc: {branchColorHex(hn.label.color)};">
								<span class="hc-label-dot"></span>{hn.label.name}
							</span>
						{/if}
						<p class="hc-preview">{hoverSnippet(hn.content, 240)}</p>
						{#if hn.siblingCount > 1}
							<div class="hc-foot">Variant {hn.siblingIndex + 1} of {hn.siblingCount} · double-click to open</div>
						{:else}
							<div class="hc-foot">Double-click to open in chat</div>
						{/if}
					</div>
				{/if}
			{/if}

			<!-- Inspector: floating card on desktop, bottom sheet on phones. -->
			{#if selected}
				<div class="insp-pos" bind:this={inspEl} transition:fly={{ y: 10, duration: 160 }}>
					<StoryMapInspector
						node={selected}
						roleName={roleLabel(selected.role)}
						timeText={fmtTime(selected.createdAt)}
						previewText={expandText(selected.content, 4000)}
						archived={archivedIds.has(selected.id)}
						onClose={() => (selectedId = null)}
						onJump={() => selected && jumpTo(selected.id)}
						onToggleCanon={toggleCanon}
						onStartCompare={startCompare}
						onSaveLabel={saveLabel}
					/>
				</div>
			{/if}
		{/if}
	</div>

	<p id="storymap-usage" class="sr-only">
		Interactive story branch map. Tab to a turn, then use the arrow keys to move between turns: up to
		the parent, down to a reply, left and right between sibling branches. Press Enter to open a turn in
		the chat. Press plus or minus to zoom and zero to fit the whole map.
	</p>
</div>

<BranchCompareModal leaves={compareLeaves} onClose={() => (compareLeaves = null)} />

<style>
	.map-view {
		height: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.map-tool-btn {
		width: 2rem;
		height: 2rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
	}

	.map-tool-btn:hover:not(:disabled) {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		border-color: color-mix(in srgb, var(--color-border) 70%, transparent);
	}

	.map-tool-btn:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
		outline-offset: 1px;
	}

	.map-tool-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.map-tool-btn.is-on {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 35%, transparent);
	}

	.map-tool-btn--sm {
		width: 1.75rem;
		height: 1.75rem;
	}

	.map-stage {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.map-canvas {
		position: absolute;
		inset: 0;
		overflow: hidden;
		cursor: grab;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-tap-highlight-color: transparent;
		overscroll-behavior: none;
	}

	.map-canvas:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--color-accent) 55%, transparent);
		outline-offset: -2px;
	}

	.map-canvas.is-panning {
		cursor: grabbing;
	}

	.map-canvas.is-picking {
		cursor: crosshair;
	}

	.map-svg {
		display: block;
	}

	/* ===== Edges ===== */
	/* Every stroke on this canvas is a SCREEN weight, never a world one (`non-scaling-stroke`,
	   inherited by the active and canon rules below and matched by the node strokes). Scaled
	   with the view, a 1.6 line is under a pixel at any zoom that shows more than a few turns:
	   it anti-aliases away, and a branch whose connector has vanished reads as a dot floating
	   loose beside the story. The colour is the second half of the same complaint: a border
	   tone is meant to separate two surfaces quietly, not to carry a line across empty space. */
	.edge {
		fill: none;
		stroke: color-mix(in srgb, var(--color-text-muted) 85%, transparent);
		stroke-width: 1.8;
		vector-effect: non-scaling-stroke;
	}

	.edge--active {
		stroke: color-mix(in srgb, var(--color-accent) 85%, transparent);
		stroke-width: 2.4;
	}

	.edge--canon {
		stroke: color-mix(in srgb, var(--color-warning) 88%, transparent);
		stroke-width: 2.6;
	}

	.map-svg.is-searching .edge {
		opacity: 0.4;
	}

	/* ===== Nodes ===== */
	.node {
		cursor: pointer;
		color: var(--color-text-muted);
		transition: opacity 140ms ease;
	}

	.node:focus {
		outline: none;
	}

	/* Role colours are the theme's own, never a fixed hue: a map painted in a teal nobody
	   chose is the one surface in the app that ignores the palette behind it. The reader's
	   own turns wear the accent, the story wears the text colour it is read in. */
	.node--user {
		color: var(--color-accent);
	}

	.node--assistant {
		color: var(--color-text-secondary);
	}

	.node--system {
		color: var(--color-text-muted);
	}

	/* Folded into chat memory, the transcript's ghost treatment in map form. Ordered before
	   the search rule on purpose: both set opacity at the same specificity, and a search must
	   be able to dim a ghosted turn down with everything else it didn't match. */
	.node.is-archived {
		opacity: 0.45;
	}

	.node.is-dimmed {
		opacity: 0.16;
	}

	.hit {
		fill: transparent;
		stroke: none;
		vector-effect: non-scaling-stroke;
	}

	/* The focus ring rides the oversized hit disc, so it reads at any zoom level. */
	.node:focus-visible .hit {
		stroke: var(--color-accent);
		stroke-width: 2;
		stroke-dasharray: 4 3;
	}

	.node.is-selected .hit {
		stroke: color-mix(in srgb, currentColor 45%, transparent);
		stroke-width: 2;
	}

	.node-dot {
		fill: color-mix(in srgb, currentColor 20%, var(--color-bg-elevated));
		stroke: currentColor;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
	}

	.node:hover .node-dot {
		fill: color-mix(in srgb, currentColor 34%, var(--color-bg-elevated));
	}

	.node.is-selected .node-dot {
		stroke-width: 3;
		filter: drop-shadow(0 0 5px color-mix(in srgb, currentColor 60%, transparent));
	}

	.fork-pip {
		fill: var(--color-bg-primary);
		stroke: currentColor;
		stroke-width: 1.6;
		vector-effect: non-scaling-stroke;
		pointer-events: none;
	}

	.halo {
		fill: none;
		vector-effect: non-scaling-stroke;
		pointer-events: none;
	}

	.halo--active {
		stroke: color-mix(in srgb, var(--color-accent) 55%, transparent);
		stroke-width: 2;
	}

	.halo--active-leaf {
		stroke: var(--color-accent);
		stroke-width: 2.5;
		animation: pulse 2s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	.crown {
		fill: var(--color-warning);
		stroke: color-mix(in srgb, var(--color-warning) 60%, #000);
		stroke-width: 0.8;
		pointer-events: none;
		filter: drop-shadow(0 1px 2px color-mix(in srgb, #000 40%, transparent));
	}

	/* ===== Branch names ===== */
	.map-labels {
		position: absolute;
		inset: 0;
		z-index: 10;
		overflow: hidden;
		/* The layer is a pass-through: only the chips themselves take the pointer, so a drag
		   starting on empty canvas still reaches the pan handlers underneath. */
		pointer-events: none;
	}

	.map-label {
		position: absolute;
		/* Anchored to the node's centre and pulled back by half its own width, so the
		   browser's measurement centres it: the thing the SVG version had to guess. */
		transform: translateX(-50%);
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		max-width: 10rem;
		height: 1.35rem;
		padding: 0 0.45rem;
		border-radius: var(--radius-full);
		border: 1px solid var(--bc);
		background: color-mix(in srgb, var(--bc) 22%, var(--color-bg-elevated));
		color: var(--color-text-primary);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 140ms ease;
	}

	.map-label:hover {
		background: color-mix(in srgb, var(--bc) 34%, var(--color-bg-elevated));
	}

	.map-label:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--bc) 80%, transparent);
		outline-offset: 1px;
	}

	.map-label.is-dimmed {
		opacity: 0.16;
	}

	.map-label-dot {
		flex-shrink: 0;
		width: 0.42rem;
		height: 0.42rem;
		border-radius: 999px;
		background: var(--bc);
	}

	.map-label-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ===== Floating chrome ===== */
	/* The top strips stack in a column, so bookmarks and the transient strip
	   (search / pick banner / hint) can never overlap at any width. */
	.map-top {
		position: absolute;
		top: 0.75rem;
		left: 0.75rem;
		right: 0.75rem;
		z-index: 20;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		pointer-events: none;
	}

	.map-top > * {
		pointer-events: auto;
	}

	.map-branches {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.3rem;
		max-width: min(36rem, 100%);
		max-height: 6.6rem;
		overflow-y: auto;
		padding: 0.35rem;
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
	}

	.branch-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		max-width: 100%;
		height: 1.65rem;
		padding: 0 0.55rem;
		border-radius: var(--radius-full);
		border: 1px solid color-mix(in srgb, var(--bc) 45%, transparent);
		background: color-mix(in srgb, var(--bc) 13%, transparent);
		color: var(--color-text-primary);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 120ms ease, border-color 120ms ease;
	}

	.branch-chip:hover {
		background: color-mix(in srgb, var(--bc) 24%, transparent);
		border-color: color-mix(in srgb, var(--bc) 70%, transparent);
	}

	.branch-chip:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--bc) 80%, transparent);
		outline-offset: 1px;
	}

	.branch-chip-dot {
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		background: var(--bc);
	}

	.branch-chip-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.map-search,
	.map-banner {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		border-radius: var(--radius-full);
		box-shadow: var(--shadow-md);
		font-family: var(--font-ui);
		color: var(--color-text-primary);
	}

	.map-search {
		padding: 0.25rem 0.4rem 0.25rem 0.7rem;
		width: min(26rem, 100%);
	}

	.map-search input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		color: var(--color-text-primary);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		outline: none;
	}

	.map-search input::placeholder {
		color: var(--color-text-muted);
	}

	.map-search-count {
		flex-shrink: 0;
		min-width: 2rem;
		text-align: right;
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.map-banner {
		padding: 0.4rem 0.75rem;
		background: color-mix(in srgb, var(--color-accent) 16%, var(--color-float-bg));
		border: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent);
		font-size: 0.76rem;
		font-weight: 600;
		max-width: 100%;
	}

	.map-banner-btn {
		border: 0;
		background: transparent;
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-weight: 700;
		cursor: pointer;
		font-size: 0.76rem;
		padding: 0.15rem 0.3rem;
		border-radius: var(--radius-sm);
		white-space: nowrap;
	}

	.map-banner-btn:hover {
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
	}

	.map-banner-btn--ghost {
		color: var(--color-text-secondary);
	}

	/* ===== Legend ===== */
	.map-legend {
		position: absolute;
		left: 0.75rem;
		bottom: 0.7rem;
		z-index: 20;
		display: flex;
		gap: 0.75rem;
		padding: 0.35rem 0.6rem;
		border-radius: var(--radius-full);
		box-shadow: var(--shadow-md);
		pointer-events: none;
	}

	.lg {
		display: inline-flex;
		align-items: center;
		gap: 0.32rem;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.lg-swatch {
		width: 0.82rem;
		height: 0.24rem;
		border-radius: 999px;
	}

	.lg-active {
		background: var(--color-accent);
	}

	.lg-canon {
		background: var(--color-warning);
	}

	.lg-fork {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		border: 1.5px solid var(--color-text-muted);
		background: var(--color-card-bg);
	}

	/* ===== Corner cluster (minimap + view tools) ===== */
	.map-corner {
		position: absolute;
		right: 0.75rem;
		bottom: 0.7rem;
		z-index: 20;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.5rem;
	}

	.map-tools {
		display: flex;
		align-items: center;
		gap: 0.1rem;
		padding: 0.2rem;
		border-radius: var(--radius-full);
		box-shadow: var(--shadow-md);
	}

	.map-tools .map-tool-btn {
		width: 1.9rem;
		height: 1.9rem;
		border-radius: var(--radius-full);
	}

	.map-zoom-level {
		min-width: 2.6rem;
		text-align: center;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.map-tools-sep {
		width: 1px;
		height: 1.1rem;
		margin: 0 0.2rem;
		background: var(--color-border-subtle);
	}

	/* ===== Hover card ===== */
	.map-hovercard {
		position: absolute;
		z-index: 30;
		width: 264px;
		padding: 0.6rem 0.7rem;
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		pointer-events: none;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.hc-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}

	.hc-dot {
		flex-shrink: 0;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 999px;
	}

	.hc-dot--user {
		background: var(--color-accent);
	}

	.hc-dot--assistant {
		background: var(--color-text-secondary);
	}

	.hc-dot--system {
		background: var(--color-text-muted);
	}

	.hc-role {
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 700;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.hc-turn {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.hc-time {
		flex-shrink: 0;
		margin-left: auto;
		font-family: var(--font-ui);
		font-size: 0.66rem;
		color: var(--color-text-muted);
	}

	.hc-label {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		max-width: 100%;
		padding: 0.08rem 0.45rem;
		border-radius: var(--radius-full);
		border: 1px solid color-mix(in srgb, var(--bc) 45%, transparent);
		background: color-mix(in srgb, var(--bc) 13%, transparent);
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.hc-label-dot {
		flex-shrink: 0;
		width: 0.42rem;
		height: 0.42rem;
		border-radius: 999px;
		background: var(--bc);
	}

	.hc-preview {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.76rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
		display: -webkit-box;
		-webkit-line-clamp: 5;
		line-clamp: 5;
		-webkit-box-orient: vertical;
		overflow: hidden;
		word-break: break-word;
	}

	.hc-foot {
		font-family: var(--font-ui);
		font-size: 0.64rem;
		color: var(--color-text-muted);
	}

	/* ===== Inspector position (card content lives in StoryMapInspector) ===== */
	.insp-pos {
		position: absolute;
		top: 0.75rem;
		right: 0.75rem;
		z-index: 40;
		width: min(21.5rem, 46%);
		max-height: calc(100% - 1.5rem);
		display: flex;
	}

	/* ===== Empty states ===== */
	.map-empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
		text-align: center;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.9rem;
		padding: 1rem;
	}

	.map-empty-sub {
		font-size: 0.78rem;
		max-width: 26rem;
		color: var(--color-text-muted);
		opacity: 0.8;
	}

	@media (max-width: 640px) {
		.map-legend,
		.map-zoom-level {
			display: none;
		}

		.map-branches {
			max-width: 100%;
			max-height: none;
			flex-wrap: nowrap;
			justify-content: flex-start;
			overflow-x: auto;
			overflow-y: hidden;
		}

		.insp-pos {
			top: auto;
			left: 0.5rem;
			right: 0.5rem;
			bottom: 0.5rem;
			width: auto;
			max-height: 52%;
		}
	}
</style>
