/**
 * The press-twice gesture for the heavy rung: when a press arms the button, when it confirms,
 * and when it is ignored. Run with `bun test`.
 */
import { describe, test, expect } from 'bun:test';
import { TWICE_ARM_MS, TWICE_GUARD_MS, twiceStep } from './delete-confirm';

describe('twiceStep', () => {
	test('a first press arms rather than confirms', () => {
		expect(twiceStep(null, 1_000)).toBe('arm');
	});

	test('a second press inside the armed window confirms', () => {
		expect(twiceStep(1_000, 1_000 + TWICE_GUARD_MS)).toBe('confirm');
		expect(twiceStep(1_000, 1_000 + TWICE_ARM_MS - 1)).toBe('confirm');
	});

	// A double-click lands both presses inside the guard, so one reflexive motion cannot fire it.
	test('a second press inside the guard is ignored, not confirmed', () => {
		expect(twiceStep(1_000, 1_000)).toBe('ignore');
		expect(twiceStep(1_000, 1_000 + TWICE_GUARD_MS - 1)).toBe('ignore');
	});

	test('a press after the arm has lapsed arms again', () => {
		expect(twiceStep(1_000, 1_000 + TWICE_ARM_MS)).toBe('arm');
	});
});
