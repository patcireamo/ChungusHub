/**
 * The clock macros. Run with `bun test`.
 *
 * Two things are worth pinning: the SHAPE, because a preset written against SillyTavern says
 * "the current real time is {{time}}, {{weekday}} {{date}}" and expects one string back, and
 * the STABILITY, because macros are re-resolved several times while a prompt is assembled and
 * a clock read per resolve could print two different minutes in one prompt.
 */

import { describe, expect, test } from 'bun:test';

import { substitute, type MacroContext } from './macros';

// A fixed instant, read in local time: 6:02 PM on Saturday 22 August 2026.
const NOW = new Date(2026, 7, 22, 18, 2, 30).getTime();
const ctx: MacroContext = { now: NOW };

describe('date and time macros', () => {
	test('print the shape SillyTavern presets are written against', () => {
		expect(substitute('{{time}}', ctx)).toBe('6:02 PM');
		expect(substitute('{{weekday}}', ctx)).toBe('Saturday');
		expect(substitute('{{date}}', ctx)).toBe('August 22, 2026');
	});

	test('read as one line together', () => {
		expect(substitute('The current real time is {{time}}, {{weekday}} {{date}}', ctx)).toBe(
			'The current real time is 6:02 PM, Saturday August 22, 2026'
		);
	});

	test('the ISO pair is fixed-width and not localised', () => {
		expect(substitute('{{isotime}}', ctx)).toBe('18:02:30');
		expect(substitute('{{isodate}}', ctx)).toBe('2026-08-22');
	});

	test('every resolve inside one assembly agrees', () => {
		// What the stamped `now` buys: without it the budget trim's re-resolves could roll the
		// minute over mid-prompt.
		expect(substitute('{{time}}', ctx)).toBe(substitute('{{time}}', ctx));
	});

	test('a context with no stamp still prints a time', () => {
		// Preview surfaces build no context; a literal {{time}} on the page would read as broken.
		expect(substitute('{{time}}', {})).toMatch(/\d/);
	});
});
