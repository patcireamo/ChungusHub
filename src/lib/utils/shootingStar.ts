/**
 * A star that flies from one element to another along an arc, trailing a tail, and resolves
 * when it has landed. Body-level and fixed, so no panel clips it and no scroller carries it.
 * Callers skip it under `prefers-reduced-motion`.
 */

const SAMPLES = 28;

interface Point {
	x: number;
	y: number;
}

const centre = (el: Element): Point => {
	const box = el.getBoundingClientRect();
	return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
};

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** The arc bows off the straight line by a quarter of its length, never downward. */
export function arcPoints(from: Point, to: Point, samples = SAMPLES): { x: number; y: number; angle: number }[] {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy) || 1;
	let nx = -dy / length;
	let ny = dx / length;
	if (ny > 0) {
		nx = -nx;
		ny = -ny;
	}
	const bow = length / 4;
	const c = { x: (from.x + to.x) / 2 + nx * bow, y: (from.y + to.y) / 2 + ny * bow };
	const points = [];
	for (let i = 0; i <= samples; i++) {
		const t = easeInOut(i / samples);
		const u = 1 - t;
		const x = u * u * from.x + 2 * u * t * c.x + t * t * to.x;
		const y = u * u * from.y + 2 * u * t * c.y + t * t * to.y;
		const tx = 2 * u * (c.x - from.x) + 2 * t * (to.x - c.x);
		const ty = 2 * u * (c.y - from.y) + 2 * t * (to.y - c.y);
		points.push({ x, y, angle: Math.atan2(ty, tx) });
	}
	return points;
}

export async function shootStar(from: Element, to: Element): Promise<void> {
	const start = centre(from);
	const end = centre(to);
	const duration = Math.min(700, Math.max(420, Math.hypot(end.x - start.x, end.y - start.y) * 0.55));

	const flight = document.createElement('div');
	flight.className = 'shooting-star';
	flight.setAttribute('aria-hidden', 'true');
	flight.innerHTML = '<span class="shooting-star-tail"></span><span class="shooting-star-head"><span></span></span>';
	document.body.appendChild(flight);

	const path = arcPoints(start, end).map(({ x, y, angle }) => ({
		transform: `translate(${x}px, ${y}px) rotate(${angle}rad)`
	}));
	const tail = flight.querySelector<HTMLElement>('.shooting-star-tail')!;
	const head = flight.querySelector<HTMLElement>('.shooting-star-head')!;
	const animations = [
		flight.animate(path, { duration, easing: 'linear', fill: 'forwards' }),
		tail.animate(
			[
				{ transform: 'scaleX(0.15)', opacity: 0 },
				{ transform: 'scaleX(1)', opacity: 1, offset: 0.3 },
				{ transform: 'scaleX(1)', opacity: 1, offset: 0.75 },
				{ transform: 'scaleX(0)', opacity: 0 }
			],
			{ duration, fill: 'forwards' }
		),
		head.animate(
			[
				{ transform: 'scale(0.6) rotate(0deg)', opacity: 0.4 },
				{ transform: 'scale(1) rotate(120deg)', opacity: 1, offset: 0.2 },
				{ transform: 'scale(1) rotate(300deg)', opacity: 1, offset: 0.86 },
				{ transform: 'scale(1.9) rotate(360deg)', opacity: 0 }
			],
			{ duration, fill: 'forwards' }
		)
	];
	try {
		await Promise.all(animations.map((a) => a.finished));
	} catch {
		// Cancelled (the element went away mid-flight): the landing still happens.
	} finally {
		flight.remove();
	}
}
