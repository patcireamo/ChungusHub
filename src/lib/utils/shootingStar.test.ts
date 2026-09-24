/**
 * The path the opening scene's star flies. Run with `bun test`.
 *
 * It has to start on the door and end on the composer's button exactly, or the box turns
 * with the star still short of it or past it.
 */

import { describe, expect, test } from 'bun:test';

import { arcPoints } from './shootingStar';

describe('arcPoints', () => {
	const door = { x: 422, y: 120 };
	const send = { x: 900, y: 760 };

	test('starts on the door and lands on the target', () => {
		const path = arcPoints(door, send);
		expect(path[0].x).toBeCloseTo(door.x);
		expect(path[0].y).toBeCloseTo(door.y);
		expect(path.at(-1)!.x).toBeCloseTo(send.x);
		expect(path.at(-1)!.y).toBeCloseTo(send.y);
	});

	test('never bows below the straight line, whichever way it flies', () => {
		for (const [from, to] of [
			[door, send],
			[send, door],
			[{ x: 100, y: 400 }, { x: 700, y: 400 }],
			[{ x: 700, y: 400 }, { x: 100, y: 400 }]
		]) {
			const mid = arcPoints(from, to, 2)[1];
			const lineY = from.y + ((to.y - from.y) * (mid.x - from.x)) / (to.x - from.x);
			expect(mid.y).toBeLessThan(lineY);
		}
	});

	test('the head points the way it is travelling at the landing', () => {
		const flat = arcPoints({ x: 0, y: 0 }, { x: 100, y: 0 });
		// Coming down onto a target level with the door, the last leg heads right and downward.
		expect(Math.cos(flat.at(-1)!.angle)).toBeGreaterThan(0);
		expect(Math.sin(flat.at(-1)!.angle)).toBeGreaterThan(0);
	});
});
