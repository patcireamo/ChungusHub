/**
 * The clock macros. Run with `bun test`.
 *
 * These replicate SillyTavern's, which read the clock at substitution time, so there is no
 * instant to inject and no exact string to pin. What is worth pinning is the SHAPE: a preset
 * written in SillyTavern says "the current real time is {{time}}, {{weekday}} {{date}}" and
 * expects moment's `LT`, `dddd` and `LL` back. A format that drifts from those is what this
 * catches, along with the off-by-one that `Date`'s 0-based months invite.
 */

import { describe, expect, test } from 'bun:test';

import { expandMacros } from './macros';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

describe('date and time macros', () => {
	test("{{time}} prints moment's LT, e.g. 6:02 PM", () => {
		expect(expandMacros('{{time}}', {})).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
	});

	test("{{date}} prints moment's LL, e.g. August 22, 2026", () => {
		const out = expandMacros('{{date}}', {});
		expect(out).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
		expect(MONTHS).toContain(out.split(' ')[0]);
	});

	test("{{weekday}} prints moment's dddd, e.g. Saturday", () => {
		expect(WEEKDAYS).toContain(expandMacros('{{weekday}}', {}));
	});

	test('the ISO pair is fixed-width and not localised', () => {
		// HH:mm, matching SillyTavern. Seconds are deliberately not part of it.
		expect(expandMacros('{{isotime}}', {})).toMatch(/^\d{2}:\d{2}$/);
		expect(expandMacros('{{isodate}}', {})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test('the ISO pair carries real calendar and clock values', () => {
		// `Date` counts months from 0, so a missing +1 prints 2026-00-22 every January and
		// reads as well-formed to the shape check above.
		const [, month, day] = expandMacros('{{isodate}}', {}).split('-').map(Number);
		expect(month).toBeGreaterThanOrEqual(1);
		expect(month).toBeLessThanOrEqual(12);
		expect(day).toBeGreaterThanOrEqual(1);
		expect(day).toBeLessThanOrEqual(31);

		const [hours, minutes] = expandMacros('{{isotime}}', {}).split(':').map(Number);
		expect(hours).toBeLessThanOrEqual(23);
		expect(minutes).toBeLessThanOrEqual(59);
	});

	test('the SillyTavern preset line reads as one string', () => {
		expect(expandMacros('The current real time is {{time}}, {{weekday}} {{date}}', {})).toMatch(
			/^The current real time is \d{1,2}:\d{2} (AM|PM), [A-Z][a-z]+ [A-Z][a-z]+ \d{1,2}, \d{4}$/
		);
	});
});
