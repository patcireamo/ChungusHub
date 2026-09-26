/**
 * Svelte action: a finger held still on a node does what Shift does to a click.
 *
 * Touch has no modifier keys, so a gesture that stretches a pick across rows needs a press of
 * its own there. It fires once the finger has rested `HOLD_MS` without travelling (travel is a
 * scroll, which the browser owns), or as soon as the browser itself calls the press a long one
 * by raising its context menu, which Android does and iOS does not. The click the lift sends
 * afterwards is swallowed, or the held row would be toggled a second time. Mouse and pen are
 * left alone: they have Shift.
 *
 * Usage: <div use:longPress={{ enabled: selectMode, onPress: () => … }}>
 * The node should also refuse text selection and the touch callout while enabled, or a held
 * finger starts selecting text on the way to the press.
 */

/** Near the platforms' own long press, so the gesture lands when a reader expects it to. */
const HOLD_MS = 500;
/** Travel past which the finger was scrolling rather than resting. */
const SLOP = 10;

interface LongPressParam {
	enabled: boolean;
	onPress: () => void;
}

export function longPress(node: HTMLElement, param: LongPressParam) {
	let current = param;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let start: { x: number; y: number } | null = null;
	/** The hold fired, so the click its lift sends is not a press of its own. Reset by the next
	 *  finger down, since a lift after the browser's context menu sends no click at all. */
	let fired = false;

	function cancel() {
		if (timer) clearTimeout(timer);
		timer = null;
		start = null;
	}

	function fire() {
		cancel();
		fired = true;
		current.onPress();
	}

	function onDown(e: PointerEvent) {
		fired = false;
		if (!current.enabled || e.pointerType !== 'touch') return;
		start = { x: e.clientX, y: e.clientY };
		timer = setTimeout(fire, HOLD_MS);
	}

	function onMove(e: PointerEvent) {
		if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) cancel();
	}

	function onContextMenu(e: Event) {
		if (!current.enabled || (!timer && !fired)) return;
		e.preventDefault();
		if (timer) fire();
	}

	function onClick(e: MouseEvent) {
		if (!fired) return;
		fired = false;
		e.preventDefault();
		e.stopPropagation();
	}

	node.addEventListener('pointerdown', onDown);
	node.addEventListener('pointermove', onMove);
	node.addEventListener('pointerup', cancel);
	node.addEventListener('pointercancel', cancel);
	node.addEventListener('contextmenu', onContextMenu);
	// Capture, so the swallowed click never reaches the button it landed on.
	node.addEventListener('click', onClick, true);

	return {
		update(next: LongPressParam) {
			current = next;
			if (!next.enabled) cancel();
		},
		destroy() {
			cancel();
			node.removeEventListener('pointerdown', onDown);
			node.removeEventListener('pointermove', onMove);
			node.removeEventListener('pointerup', cancel);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('contextmenu', onContextMenu);
			node.removeEventListener('click', onClick, true);
		}
	};
}
