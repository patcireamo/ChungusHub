<script lang="ts">
	import { untrack } from 'svelte';
	import Dialog from '$lib/components/ui/Dialog.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Slider from '$lib/components/ui/Slider.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { imageService } from '$lib/services/imageService';
	import { toastStore } from '$lib/stores/toast.svelte';
	import {
		DEFAULT_PORTRAIT_FOCUS,
		MAX_PORTRAIT_ZOOM,
		clampPortraitFocus,
		isDefaultPortraitFocus,
		portraitDrawRect,
		portraitFocusFromDrawOffset,
		portraitFocusStyle,
		type PortraitFocus
	} from '$lib/utils/portrait-focus';

	interface Props {
		open: boolean;
		/** Stored path of the portrait being aimed. */
		imagePath: string;
		name: string;
		/** The framing as stored, which is what reopening starts from. */
		focus: PortraitFocus | undefined;
		/** Where the framing goes. `null` is the centred default, which every caller stores
		 *  as nothing: an untouched picture must leave no row behind. The dialog owns the
		 *  geometry and never the storage, which is what lets a lorebook cover and a
		 *  character portrait be aimed by the same screen. */
		onSave: (focus: PortraitFocus | null) => Promise<void>;
		onClose: () => void;
	}

	let { open, imagePath, name, focus, onSave, onClose }: Props = $props();

	/**
	 * The lenses. Every box the app draws a portrait in sits between these two ratios: 2:3
	 * is the narrowest (chat portraits), 1:1 the widest (chat squares, and every silhouette
	 * on a phone), with the 3:4 browse cards in between. A framing that reads in both reads
	 * everywhere, which is why there is one framing and not one per shape. The circle
	 * repeats 1:1 on purpose, because what it takes away is the corners, not the crop.
	 */
	const LENSES = [
		{ id: 'tall', label: 'Tall', ratio: 2 / 3, radius: 'var(--radius-lg)' },
		{ id: 'square', label: 'Square', ratio: 1, radius: 'var(--radius-lg)' },
		{ id: 'circle', label: 'Circle', ratio: 1, radius: 'var(--radius-full)' }
	] as const;

	type LensId = (typeof LENSES)[number]['id'];

	/** The chat gives every silhouette the same width and lets the ratio set the height, so
	 *  the preview does too: switching lens changes what the frame keeps, never how large
	 *  the picture behind it is drawn. */
	const FRAME_WIDTH = 190;
	const STAGE_HEIGHT = 348;
	const MORPH_MS = 280;

	let lensId = $state<LensId>('tall');
	let draft = $state<PortraitFocus>({ ...DEFAULT_PORTRAIT_FOCUS });
	let natural = $state<{ width: number; height: number } | null>(null);
	let sourceUrl = $state<string | null>(null);
	let stageEl = $state<HTMLDivElement | null>(null);
	let saving = $state(false);
	let dragging = $state(false);
	/** True only across a lens change, so the frame animates between shapes while a drag
	 *  stays glued to the pointer. */
	let morphing = $state(false);
	let morphTimer: ReturnType<typeof setTimeout> | null = null;

	let lens = $derived(LENSES.find((l) => l.id === lensId) ?? LENSES[0]);
	let frame = $derived({ width: FRAME_WIDTH, height: Math.round(FRAME_WIDTH / lens.ratio) });
	let rect = $derived(natural ? portraitDrawRect(draft, natural, frame) : null);
	let isDefault = $derived(isDefaultPortraitFocus(draft));

	// Opening always starts from what is stored, so adjusting a framing is a nudge and not
	// a restart. Untracked: the store's copy changes underneath us the moment we save, and
	// re-seeding the draft from it would fight the close.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			draft = focus ? { ...focus } : { ...DEFAULT_PORTRAIT_FOCUS };
			lensId = 'tall';
		});
	});

	// The full-size original, not the thumbnail: this is the one screen where the picture is
	// being judged. Its own dimensions are what every frame's geometry is measured against.
	$effect(() => {
		if (!open) return;
		const path = imagePath;
		let cancelled = false;
		natural = null;
		sourceUrl = null;

		void imageService.getImageUrl(path).then((url) => {
			if (cancelled || !url) return;
			const probe = new Image();
			probe.onload = () => {
				if (cancelled) return;
				natural = { width: probe.naturalWidth, height: probe.naturalHeight };
				sourceUrl = url;
			};
			probe.onerror = () => {
				if (cancelled) return;
				toastStore.error('That portrait could not be loaded.');
				onClose();
			};
			probe.src = url;
		});

		return () => {
			cancelled = true;
		};
	});

	// Zooming has to cancel the page scroll behind it, which a passive listener cannot do.
	$effect(() => {
		const el = stageEl;
		if (!el) return;
		el.addEventListener('wheel', handleWheel, { passive: false });
		return () => el.removeEventListener('wheel', handleWheel);
	});

	$effect(() => () => {
		if (morphTimer) clearTimeout(morphTimer);
	});

	function setZoom(next: number) {
		draft = clampPortraitFocus({ ...draft, zoom: next });
	}

	/** Move the picture to where a gesture put it, then read the focal point back out of
	 *  that position: the same geometry the frames render from, run backwards. */
	function moveTo(left: number, top: number) {
		if (!natural) return;
		draft = portraitFocusFromDrawOffset({ left, top }, draft.zoom, natural, frame);
	}

	let dragStart: { pointerX: number; pointerY: number; left: number; top: number } | null = null;

	function handlePointerDown(e: PointerEvent) {
		if (!rect) return;
		dragging = true;
		dragStart = { pointerX: e.clientX, pointerY: e.clientY, left: rect.left, top: rect.top };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e: PointerEvent) {
		if (!dragging || !dragStart) return;
		moveTo(
			dragStart.left + (e.clientX - dragStart.pointerX),
			dragStart.top + (e.clientY - dragStart.pointerY)
		);
	}

	function endDrag() {
		dragging = false;
		dragStart = null;
	}

	function handleWheel(e: WheelEvent) {
		if (!natural) return;
		e.preventDefault();
		setZoom(draft.zoom - e.deltaY * 0.0015);
	}

	/** Arrow keys nudge in the same unit a drag moves in: one pixel of frame travel. */
	function handleKeydown(e: KeyboardEvent) {
		if (!rect) return;
		const step = e.shiftKey ? 10 : 1;
		const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
		const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
		if (!dx && !dy) return;
		e.preventDefault();
		moveTo(rect.left + dx, rect.top + dy);
	}

	function pickLens(id: LensId) {
		if (id === lensId) return;
		lensId = id;
		morphing = true;
		if (morphTimer) clearTimeout(morphTimer);
		morphTimer = setTimeout(() => (morphing = false), MORPH_MS);
	}

	async function handleSave() {
		if (saving) return;
		saving = true;
		try {
			await onSave(isDefault ? null : draft);
			onClose();
		} catch (error) {
			toastStore.failed('save that framing', error);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog {open} {onClose} title="Adjust framing" size="lg">
	<div class="space-y-4">
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- a direct-manipulation
		     canvas is what role="application" is for: the arrow keys belong to this widget,
		     not to the reader's browse mode. Everything else in the dialog stays reachable. -->
		<div
			bind:this={stageEl}
			class="framing-stage"
			class:dragging
			style="height: {STAGE_HEIGHT}px;"
			role="application"
			aria-label="Drag the picture to aim the frame"
			tabindex="0"
			onpointerdown={handlePointerDown}
			onpointermove={handlePointerMove}
			onpointerup={endDrag}
			onpointercancel={endDrag}
			onkeydown={handleKeydown}
		>
			{#if sourceUrl && rect}
				<div
					class="framing-frame"
					class:morph={morphing}
					style="width: {frame.width}px; height: {frame.height}px;"
				>
					<img
						class="framing-ghost"
						class:morph={morphing}
						src={sourceUrl}
						alt=""
						draggable="false"
						style="left: {rect.left}px; top: {rect.top}px; width: {rect.width}px; height: {rect.height}px;"
					/>
					<div class="framing-scrim"></div>
					<div
						class="framing-window"
						class:morph={morphing}
						style="border-radius: {lens.radius};"
					>
						<img
							src={sourceUrl}
							alt="{name} portrait"
							draggable="false"
							style={portraitFocusStyle(draft)}
						/>
					</div>
				</div>
			{:else}
				<Spinner size="md" />
			{/if}

			<div class="framing-lenses">
				{#each LENSES as l (l.id)}
					<button
						type="button"
						class="framing-lens"
						class:on={l.id === lensId}
						aria-label="{l.label} preview"
						aria-pressed={l.id === lensId}
						onpointerdown={(e) => e.stopPropagation()}
						onclick={() => pickLens(l.id)}
					>
						<span
							class="framing-lens-glyph"
							style="width: {l.id === 'tall' ? '0.65rem' : '0.9rem'}; height: 0.9rem;
							       border-radius: {l.id === 'circle' ? '50%' : '3px'};"
						></span>
					</button>
				{/each}
			</div>
		</div>

		<p class="text-xs font-ui text-text-muted">
			Drag to aim. Each shape previews the same framing in a different frame.
		</p>

		<div class="flex items-center gap-3">
			<span class="text-xs font-ui text-text-secondary shrink-0">Zoom</span>
			<Slider
				value={draft.zoom}
				min={1}
				max={MAX_PORTRAIT_ZOOM}
				step={0.01}
				defaultValue={1}
				label="Zoom"
				format={(v) => `${v.toFixed(2)}×`}
				oninput={setZoom}
			/>
			{#if !isDefault}
				<button
					type="button"
					class="shrink-0 text-xs font-ui text-text-secondary hover:text-text-primary transition-colors"
					onclick={() => (draft = { ...DEFAULT_PORTRAIT_FOCUS })}
				>
					Reset
				</button>
			{/if}
		</div>

		<div class="flex gap-3 justify-end pt-1">
			<Button variant="ghost" onclick={onClose} disabled={saving}>Cancel</Button>
			<Button variant="primary" onclick={handleSave} disabled={saving || !natural}>
				Save framing
			</Button>
		</div>
	</div>
</Dialog>

<style>
	.framing-stage {
		--morph: 280ms cubic-bezier(0.2, 0.8, 0.2, 1);
		position: relative;
		display: grid;
		place-items: center;
		overflow: hidden;
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border-subtle);
		background: var(--color-bg-tertiary);
		cursor: grab;
		/* The stage owns every pointer gesture on it, so a drag never scrolls the dialog. */
		touch-action: none;
		user-select: none;
	}

	/* Without this the browser's own picture drag wins the moment the press lands on the
	   picture, which is the whole surface: the pointer leaves with a drag ghost and the
	   frame never moves. */
	.framing-stage img {
		-webkit-user-drag: none;
		user-select: none;
	}

	.framing-stage.dragging {
		cursor: grabbing;
	}

	.framing-stage:focus-visible {
		outline: 0;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent-muted) 70%, transparent);
	}

	.framing-frame {
		position: relative;
		flex: none;
	}

	/* The surroundings and the frame animate on the same curve, so the picture stays put
	   while the shape changes around it. */
	.framing-frame.morph {
		transition:
			width var(--morph),
			height var(--morph);
	}

	.framing-ghost {
		position: absolute;
		/* Preflight caps images at their container's width; the whole point of this one is
		   to reach past it. */
		max-width: none;
		pointer-events: none;
	}

	.framing-ghost.morph {
		transition:
			left var(--morph),
			top var(--morph),
			width var(--morph),
			height var(--morph);
	}

	/* Mutes everything outside the window toward the stage itself, so the picture stays
	   readable as context in a light theme and a dark one alike. */
	.framing-scrim {
		position: absolute;
		inset: -100vmax;
		background: color-mix(in srgb, var(--color-bg-tertiary) 84%, transparent);
		pointer-events: none;
	}

	.framing-window {
		position: absolute;
		inset: 0;
		overflow: hidden;
		box-shadow:
			0 0 0 1px rgba(255, 255, 255, 0.85),
			0 10px 30px rgba(0, 0, 0, 0.35);
	}

	.framing-window.morph {
		transition: border-radius var(--morph);
	}

	.framing-window img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.framing-lenses {
		position: absolute;
		top: 0.55rem;
		right: 0.55rem;
		display: flex;
		gap: 2px;
		padding: 3px;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-primary) 72%, transparent);
		backdrop-filter: var(--backdrop-blur);
	}

	.framing-lens {
		width: 1.7rem;
		height: 1.55rem;
		display: grid;
		place-items: center;
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		transition:
			background 120ms ease,
			color 120ms ease;
	}

	.framing-lens:hover,
	.framing-lens.on {
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
	}

	.framing-lens-glyph {
		display: block;
		border: 1.5px solid currentColor;
	}
</style>
