/**
 * Svelte action: lines a turn's dropdown up under the button that opened it.
 *
 * Unlike `anchorTo` the panel stays in the layout, so it scrolls with the story and the caller
 * keeps deciding whether it opens up or down; only `left` is written (architecture/chat-sessions.md).
 */

/** Panel → scroller edge, the margin `anchorTo` keeps off the viewport. */
const EDGE = 8;

export interface Span {
	left: number;
	right: number;
}

export interface HangTarget {
	trigger: HTMLElement | undefined;
	column: HTMLElement | undefined;
}

const middle = (span: Span): number => (span.left + span.right) / 2;

/**
 * Where a `width`-wide panel starts. It grows over its trigger's own row (toward the column's
 * middle from mid-row), flips edge when only the other one stays in the column, then stays inside `bounds`.
 */
export function hangLeft(
	at: { trigger: Span; row: Span; column: Span; bounds: Span },
	width: number
): number {
	const offCentre = middle(at.trigger) - middle(at.row);
	// Sub-pixel layout puts the middle of five equal buttons a hair off the row's middle.
	const rightward = Math.abs(offCentre) > 1 ? offCentre < 0 : middle(at.trigger) < middle(at.column);
	const fromLeft = at.trigger.left;
	const fromRight = at.trigger.right - width;
	const inColumn = (x: number): boolean => x >= at.column.left && x + width <= at.column.right;
	let x = rightward ? fromLeft : fromRight;
	const other = rightward ? fromRight : fromLeft;
	if (!inColumn(x) && inColumn(other)) x = other;
	return Math.max(at.bounds.left + EDGE, Math.min(x, at.bounds.right - EDGE - width));
}

/** Nearest box that clips or scrolls: past its edge a panel is cut off or drags the transcript sideways. */
function clipBox(node: HTMLElement): Span {
	for (let el = node.parentElement; el; el = el.parentElement) {
		if (getComputedStyle(el).overflowX === 'visible') continue;
		const left = el.getBoundingClientRect().left + el.clientLeft;
		return { left, right: left + el.clientWidth };
	}
	return { left: 0, right: document.documentElement.clientWidth };
}

export function hangUnder(node: HTMLElement, target: HangTarget) {
	let current = target;

	function place(): void {
		const { trigger, column } = current;
		const parent = node.offsetParent;
		if (!trigger?.parentElement || !column || !parent) return;
		const left = hangLeft(
			{
				trigger: trigger.getBoundingClientRect(),
				row: trigger.parentElement.getBoundingClientRect(),
				column: column.getBoundingClientRect(),
				bounds: clipBox(node)
			},
			// Layout width, not the rendered one: the entry animation scales the panel.
			node.offsetWidth
		);
		node.style.left = `${left - parent.getBoundingClientRect().left - parent.clientLeft}px`;
		node.style.right = 'auto';
	}

	place();
	window.addEventListener('resize', place);

	return {
		update(next: HangTarget): void {
			current = next;
			place();
		},
		destroy(): void {
			window.removeEventListener('resize', place);
		}
	};
}
