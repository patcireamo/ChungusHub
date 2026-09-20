<script lang="ts">
	interface Props {
		value: number;
		min: number;
		max: number;
		step?: number;
		oninput?: (value: number) => void;
		/** Renders the readout next to the track (e.g. (v) => `${Math.round(v * 100)}%`). */
		format?: (value: number) => string;
		/** Double-clicking the track snaps back to this value. */
		defaultValue?: number;
		/**
		 * Where the value actually is right now, when something other than the reader is moving
		 * it. Drawn as a read-only bar of its own UNDER the track, marked with a tick at
		 * `value`, never as a second reading on the track itself: a fill that disagrees with its
		 * own thumb reads as a control that is broken rather than as a value that is moving.
		 * Omit unless something really is moving it.
		 */
		meter?: number;
		disabled?: boolean;
		label?: string;
	}

	let {
		value,
		min,
		max,
		step = 1,
		oninput,
		format = (v) => String(v),
		defaultValue,
		meter,
		disabled = false,
		label
	}: Props = $props();

	// Holding Shift while dragging gears the motion down: pointer travel maps to
	// FINE_FACTOR of the value change it normally would, so tiny adjustments land.
	// Driven off pointer movementX (not the native absolute mapping) so the value
	// keeps advancing even after the pointer runs past the end of the track.
	const FINE_FACTOR = 0.2;
	let dragging = false;
	// Non-null while a Shift-fine drag is active: the unsnapped accumulator we gear into.
	let fineValue: number | null = null;
	// After a fine drag ends the native input fires one last commit at the pointer's
	// absolute position. Swallow input/change events until the next frame so the
	// value stays where the fine drag left it instead of jumping.
	let suppress = false;
	let pinned = 0;

	function snap(v: number): number {
		const snapped = Math.round((v - min) / step) * step + min;
		return Math.min(max, Math.max(min, snapped));
	}

	function handleInput(event: Event) {
		const input = event.target as HTMLInputElement;
		if (suppress) {
			input.value = String(pinned);
			return;
		}
		// In fine mode the native input just jumped the thumb to the pointer: undo it,
		// pointermove owns the value. Otherwise map the pointer straight through.
		if (fineValue !== null) input.value = String(snap(fineValue));
		else oninput?.(Number(input.value));
	}

	function handleChange(event: Event) {
		if (suppress) (event.target as HTMLInputElement).value = String(pinned);
	}

	function handlePointerDown() {
		dragging = true;
		fineValue = null;
		suppress = false;
	}

	function handlePointerMove(event: PointerEvent) {
		if (!dragging) return;
		if (!event.shiftKey || disabled) {
			fineValue = null; // Shift released mid-drag → hand back to the native mapping.
			return;
		}
		event.preventDefault(); // stop the native absolute mapping; movementX drives it.
		if (fineValue === null) fineValue = value; // Enter fine mode from wherever we are.
		const track = (event.currentTarget as HTMLInputElement).clientWidth || 1;
		fineValue = Math.min(
			max,
			Math.max(min, fineValue + (event.movementX / track) * (max - min) * FINE_FACTOR)
		);
		const geared = snap(fineValue);
		if (geared !== value) oninput?.(geared);
	}

	function endDrag(event: PointerEvent) {
		if (fineValue !== null) {
			pinned = snap(fineValue);
			(event.currentTarget as HTMLInputElement).value = String(pinned);
			if (pinned !== value) oninput?.(pinned);
			suppress = true;
			requestAnimationFrame(() => (suppress = false));
		}
		dragging = false;
		fineValue = null;
	}

	function handleDblClick() {
		if (disabled || defaultValue === undefined || value === defaultValue) return;
		oninput?.(defaultValue);
	}

	let shown = $derived(Math.min(max, Math.max(min, value)));
	let fill = $derived(max > min ? (shown - min) / (max - min) : 0);
	let meterFill = $derived(
		meter === undefined || max <= min
			? 0
			: Math.min(1, Math.max(0, (Math.min(max, Math.max(min, meter)) - min) / (max - min)))
	);
</script>

<div class="slider" class:disabled>
	<div class="slider-body">
		<input
			type="range"
			{min}
			{max}
			{step}
			{value}
			{disabled}
			aria-label={label}
			title={defaultValue !== undefined ? 'Double-click to reset' : undefined}
			style="--fill: {fill}"
			oninput={handleInput}
			onchange={handleChange}
			onpointerdown={handlePointerDown}
			onpointermove={handlePointerMove}
			onpointerup={endDrag}
			onpointercancel={endDrag}
			ondblclick={handleDblClick}
		/>
		{#if meter !== undefined}
			<!-- A readout, not a control: the screen reader already has the value off the input,
			     and a second announcement of the same level moving on its own is noise. -->
			<div class="meter" style="--meter: {meterFill}; --set: {fill}" aria-hidden="true"></div>
		{/if}
	</div>
	<span class="readout">{format(value)}</span>
</div>

<style>
	.slider {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
		flex: 1;
	}

	.slider.disabled {
		opacity: 0.45;
	}

	/* The bar is 0.35rem of paint; the element around it is the grab. Sized to the box alone it
	   is a 5px tall target, which on a phone sits between rows many times its size and is the
	   one control on a settings page a thumb cannot reliably catch. The track is drawn by the
	   pseudo-elements instead, so the element can be tall enough to hit while the bar stays the
	   width of a hairline. */
	.slider-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	input[type='range'] {
		width: 100%;
		min-width: 0;
		height: 1.5rem;
		background: none;
		appearance: none;
		-webkit-appearance: none;
		cursor: pointer;
	}

	/* What the value is actually doing, as its own bar under the track. The thumb travels
	   between its own half-widths rather than edge to edge, so both the fill's end and the tick
	   are placed on that same span: a mark a few pixels off the thumb it is reporting against
	   reads as a rendering fault rather than as a level sitting where it was set. */
	.meter {
		position: relative;
		height: 0.2rem;
		margin-top: -0.15rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-bg-tertiary) 75%, transparent);
	}

	.meter::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: calc(var(--meter, 0) * (100% - 0.95rem) + 0.475rem);
		border-radius: inherit;
		background: color-mix(in srgb, var(--color-accent) 60%, transparent);
		transition: width 180ms linear;
	}

	.meter::after {
		content: '';
		position: absolute;
		top: -0.14rem;
		bottom: -0.14rem;
		left: calc(var(--set, 0) * (100% - 0.95rem) + 0.475rem);
		width: 1px;
		background: color-mix(in srgb, var(--color-text-secondary) 70%, transparent);
	}

	/* Sampled many times a second, so with transitions cut this steps rather than travels,
	   which is the opposite of what asking for less motion wanted. The level is still audible;
	   only the picture of it goes. */
	:global([data-motion='reduced']) .meter {
		display: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.meter {
			display: none;
		}
	}

	input[type='range']::-webkit-slider-runnable-track {
		height: 0.35rem;
		border-radius: var(--radius-full);
		background: linear-gradient(
			to right,
			var(--color-accent) calc((var(--fill, 0)) * 100%),
			var(--color-bg-tertiary) calc((var(--fill, 0)) * 100%)
		);
	}

	input[type='range']::-moz-range-track {
		height: 0.35rem;
		border-radius: var(--radius-full);
		background: linear-gradient(
			to right,
			var(--color-accent) calc((var(--fill, 0)) * 100%),
			var(--color-bg-tertiary) calc((var(--fill, 0)) * 100%)
		);
	}

	input[type='range']::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 0.95rem;
		height: 0.95rem;
		/* WebKit hangs the thumb off the track's top edge, so half the difference between the
		   two brings it back onto the bar's centre line. */
		margin-top: -0.3rem;
		border-radius: var(--radius-full);
		background: var(--color-accent);
		border: 2px solid var(--color-bg-primary);
		box-shadow: var(--shadow-sm);
		cursor: pointer;
		transition: transform 120ms ease;
	}

	input[type='range']::-webkit-slider-thumb:hover {
		transform: scale(1.12);
	}

	input[type='range']::-moz-range-thumb {
		width: 0.95rem;
		height: 0.95rem;
		border: 2px solid var(--color-bg-primary);
		border-radius: var(--radius-full);
		background: var(--color-accent);
		cursor: pointer;
	}

	.readout {
		flex-shrink: 0;
		min-width: 3.1rem;
		text-align: right;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}
</style>
