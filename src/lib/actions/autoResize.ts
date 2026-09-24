/**
 * Svelte action for prompt-authoring textareas: auto-grows with content up to
 * maxHeight, and shows the native bottom-right resize handle. The moment the
 * user drags that handle, their chosen height wins: auto-sizing stops for
 * this element, so a field can be shortened as well as stretched. Every field
 * using this action gets the exact same behavior.
 *
 * Pass a number for the max height, or `{ maxHeight, value }` when the textarea's value
 * is driven externally (e.g. streamed in). Passing the current value makes the action
 * re-measure on every value change, not just on user `input`.
 *
 * `grip: false` drops the handle: the height then follows the content and nothing else.
 * That is the only correct setting inside a surface anchored to its BOTTOM edge (the
 * composer's steering popover), where the browser's own grip maths is inverted: extra
 * height is absorbed upward, so the handle sits still while the pointer walks away from
 * it. The composer's own textarea has never offered one, for exactly this reason.
 */
type AutoResizeParam = number | { maxHeight?: number; value?: unknown; grip?: boolean };

function resolveMaxHeight(param: AutoResizeParam | undefined): number {
	if (typeof param === 'number') return param;
	return param?.maxHeight ?? 300;
}

function resolveValue(param: AutoResizeParam | undefined): unknown {
	return typeof param === 'number' ? undefined : param?.value;
}

/** The nearest ancestor that scrolls, or null if nothing above this element does. */
function findScroller(node: HTMLElement): HTMLElement | null {
	for (let el = node.parentElement; el; el = el.parentElement) {
		const overflowY = getComputedStyle(el).overflowY;
		if (overflowY === 'auto' || overflowY === 'scroll') return el;
	}
	return null;
}

export function autoResize(node: HTMLTextAreaElement, param: AutoResizeParam = 300) {
	let maxHeight = resolveMaxHeight(param);
	// Read once: a field does not change which edge its surface is anchored to.
	const grip = typeof param === 'number' ? true : param?.grip ?? true;
	// Once the user grabs the corner handle their height is law until the element
	// remounts; content that no longer fits scrolls instead of re-growing the box.
	let manual = false;
	// The height we last wrote ourselves. It lets the observer tell our own writes
	// apart from a user drag (which changes the height without going through us).
	let lastSetHeight = -1;
	// The text this element was last measured against. A form rebuilds every field's
	// parameter object on every render, so `update` fires on all of them for one
	// character typed into one of them; without this, a ten-field editor pays ten
	// measurements (and ten forced layouts) per keystroke instead of one.
	let measuredValue = resolveValue(param);
	// Resolved on the first measurement that happens with the field in the document, and
	// kept from then on: walking computed styles per keystroke would cost more than the
	// clamp it prevents, and resolving against a detached element would answer null and
	// cache the protection away.
	let scroller: HTMLElement | null | undefined;

	function resize() {
		if (manual) return;
		if (scroller === undefined && node.isConnected) scroller = findScroller(node);
		// Measuring means collapsing the box to its content height for an instant. While
		// it is short the scroll container's own content is short too, so a container
		// scrolled near its end has its scrollTop clamped, and the clamp is not undone
		// when the height comes back. Left alone, the view creeps away from the caret on
		// every keystroke, which is the whole story of typing in a long form on a phone.
		const scrollTop = scroller?.scrollTop;
		node.style.height = 'auto';
		node.style.height = Math.min(node.scrollHeight, maxHeight) + 'px';
		node.style.overflowY = node.scrollHeight > maxHeight ? 'auto' : 'hidden';
		lastSetHeight = node.offsetHeight;
		if (scroller && scrollTop !== undefined && scroller.scrollTop !== scrollTop) {
			scroller.scrollTop = scrollTop;
		}
	}

	function handleInput() {
		measuredValue = node.value;
		resize();
	}

	// Inline style so it outranks any `resize-none` utility class the markup
	// carries: the handle is the point, no field gets to opt out silently.
	node.style.resize = grip ? 'vertical' : 'none';

	resize();
	node.addEventListener('input', handleInput);

	// Width-only reflows and our own writes land on lastSetHeight; anything else
	// changing the height is the user dragging the handle. With no handle there is
	// no drag to tell apart, so the observer isn't needed at all.
	const observer = grip
		? new ResizeObserver(() => {
				if (manual) return;
				if (lastSetHeight >= 0 && Math.abs(node.offsetHeight - lastSetHeight) > 1) {
					manual = true;
					node.style.overflowY = 'auto';
				}
			})
		: null;
	observer?.observe(node);

	return {
		update(next: AutoResizeParam) {
			const previousMaxHeight = maxHeight;
			maxHeight = resolveMaxHeight(next);
			const value = resolveValue(next);
			// Only this field's own text (or its ceiling) changing can change its height. A
			// call site that passes no value keeps the old behaviour: re-measure on every
			// update.
			if (value !== undefined && value === measuredValue && maxHeight === previousMaxHeight) {
				return;
			}
			measuredValue = value;
			// Re-measure after the DOM value has been updated for this change.
			resize();
		},
		destroy() {
			observer?.disconnect();
			node.removeEventListener('input', handleInput);
		}
	};
}
