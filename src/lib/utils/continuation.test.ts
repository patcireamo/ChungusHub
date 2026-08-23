/**
 * Tests for the continuation joining rules (continue-in-place). Run with `bun test`.
 *
 * glueContinuation is the seam rule the live stream preview uses; joinContinuation is the
 * persisted result (restatement trim + glue). The trim thresholds matter: overlaps shorter
 * than the minimum are coincidence and must survive, longer ones are model restatement and
 * must not be appended twice.
 */

import { describe, expect, test } from 'bun:test';

import { glueContinuation, joinContinuation, previewContinuation } from './continuation';

describe('glueContinuation: seam rule', () => {
	test('empty base takes the continuation with leading whitespace dropped', () => {
		expect(glueContinuation('', '  The hall was dark.')).toBe('The hall was dark.');
	});

	test('empty continuation returns the base unchanged', () => {
		expect(glueContinuation('The hall was dark.', '')).toBe('The hall was dark.');
	});

	test('raw concat when the base ends with whitespace', () => {
		expect(glueContinuation('The hall was ', 'dark.')).toBe('The hall was dark.');
	});

	test('raw concat when the continuation starts with whitespace', () => {
		expect(glueContinuation('The hall was dark.', '\n\nBeyond it, silence.')).toBe(
			'The hall was dark.\n\nBeyond it, silence.'
		);
	});

	test('raw concat when the continuation opens with gluing punctuation', () => {
		expect(glueContinuation('She hesitated', ', then stepped forward.')).toBe('She hesitated, then stepped forward.');
		expect(glueContinuation('He said "run', '." and vanished.')).toBe('He said "run." and vanished.');
	});

	test('inserts a single space at a bare word boundary', () => {
		expect(glueContinuation('The knight drew his blade and', 'charged the gate.')).toBe(
			'The knight drew his blade and charged the gate.'
		);
	});
});

describe('joinContinuation: restatement trimming', () => {
	test('no overlap appends with the seam rule', () => {
		expect(joinContinuation('The knight drew his blade and', 'charged the gate.')).toBe(
			'The knight drew his blade and charged the gate.'
		);
	});

	test('a restated tail of the base is stripped before appending', () => {
		const base = 'They stopped before the ancient stone door.';
		const next = 'the ancient stone door. Beyond it lay darkness.';
		expect(joinContinuation(base, next)).toBe('They stopped before the ancient stone door. Beyond it lay darkness.');
	});

	test('short coincidental overlaps are kept', () => {
		// "Karak" is a real suffix of the base, but far below the minimum overlap length.
		expect(joinContinuation('The road led to Karak', 'Karak was silent that night.')).toBe(
			'The road led to Karak Karak was silent that night.'
		);
	});

	test('a whole-message restatement keeps only the new text', () => {
		const base = 'The knight rose from the table.';
		expect(joinContinuation(base, base + ' He walked into the rain.')).toBe(
			'The knight rose from the table. He walked into the rain.'
		);
	});

	test('a pure restatement returns the base unchanged', () => {
		const base = 'The knight rose from the table.';
		expect(joinContinuation(base, base)).toBe(base);
	});

	test('whitespace-only continuation returns the base unchanged', () => {
		expect(joinContinuation('The hall was dark.', '  \n ')).toBe('The hall was dark.');
	});

	test('trailing whitespace on the base does not defeat restatement detection', () => {
		const base = 'He paused mid-sentence and \n';
		const joined = joinContinuation(base, 'He paused mid-sentence and then spoke.');
		// The restated words are stripped; what remains (leading space included) rides
		// after the base's own trailing whitespace untouched.
		expect(joined).toBe(base + ' then spoke.');
	});
});

describe('joinContinuation: normalized restatement (the copies models actually produce)', () => {
	test('a copy that swaps curly quotes for straight ones is still a copy', () => {
		const base = 'He nodded. “We leave at dawn.”';
		const next = 'He nodded. "We leave at dawn." The horses were already saddled.';
		expect(joinContinuation(base, next)).toBe('He nodded. “We leave at dawn.” The horses were already saddled.');
	});

	test('a copy that collapses a paragraph break to one newline is still a copy', () => {
		const base = 'The gate held.\n\nBeyond it, the fires spread.';
		const next = 'The gate held.\nBeyond it, the fires spread. Nobody moved.';
		expect(joinContinuation(base, next)).toBe(base + ' Nobody moved.');
	});

	test('a copy that swaps an em dash for a double hyphen is still a copy', () => {
		const base = 'She reached for the handle — and froze in place.'; // em-dash: data
		const next = 'She reached for the handle -- and froze in place. The handle was warm.';
		expect(joinContinuation(base, next)).toBe(base + ' The handle was warm.');
	});

	test('a copy that swaps an ellipsis for three dots is still a copy', () => {
		const base = 'The recording hissed, then a voice… very faint, very close.';
		const next = 'then a voice... very faint, very close. It said her name.';
		expect(joinContinuation(base, next)).toBe(base + ' It said her name.');
	});

	test("a curly apostrophe against a straight one is still a copy", () => {
		const base = "It wasn’t the wind that moved the curtain aside.";
		const next = "It wasn't the wind that moved the curtain aside. Something was in the room.";
		expect(joinContinuation(base, next)).toBe(base + ' Something was in the room.');
	});

	test('a whole-message copy behind leading whitespace is still a copy', () => {
		const base = 'The knight rose from the table.';
		expect(joinContinuation(base, '\n\n' + base + ' He walked into the rain.')).toBe(
			'The knight rose from the table. He walked into the rain.'
		);
	});

	test('the cut lands at the raw offset, not the normalized one', () => {
		// The matched region ends inside text whose normalized form is shorter than the raw
		// form (the collapsed newline run): the fresh text must survive byte-for-byte.
		const base = 'A bell rang twice.\n\n\nThe hall emptied fast.';
		const next = 'A bell rang twice.\nThe hall emptied fast.\n\nOnly the clerk stayed.';
		expect(joinContinuation(base, next)).toBe(base + '\n\nOnly the clerk stayed.');
	});
});

describe('joinContinuation: the as-sent anchor', () => {
	test('a stored macro turn is compared against the text the model saw', () => {
		// A greeting stores literal {{user}}; the prompt carried it expanded, so the model
		// restates the expanded form. Anchoring on the as-sent text catches the copy that
		// comparing against the stored bytes would append twice.
		const base = 'The innkeeper waves {{user}} over to the counter.';
		const anchor = 'The innkeeper waves Alice over to the counter.';
		const next = 'waves Alice over to the counter. “Rough night?” she asks.';
		expect(joinContinuation(base, next, anchor)).toBe(base + ' “Rough night?” she asks.');
	});

	test('a pure restatement of the anchor returns the base unchanged', () => {
		const base = 'The innkeeper waves {{user}} over to the counter.';
		const anchor = 'The innkeeper waves Alice over to the counter.';
		expect(joinContinuation(base, anchor, anchor)).toBe(base);
	});
});

describe('previewContinuation: the stream-side hold', () => {
	const base = 'They stopped before the ancient stone door.';

	test('a tail still restating the message shows nothing yet', () => {
		expect(previewContinuation(base, 'the ancient stone')).toBe(base);
		expect(previewContinuation(base, 'They stopped before the ancient')).toBe(base);
	});

	test('a restating tail normalized differently is still held', () => {
		expect(previewContinuation('He said “run.”', 'He said "run.')).toBe('He said “run.”');
	});

	test('a tail that diverged from the message flows through the seam rule', () => {
		expect(previewContinuation(base, 'Beyond it lay darkness')).toBe(base + ' Beyond it lay darkness');
	});

	test('a whitespace-only tail shows nothing', () => {
		expect(previewContinuation(base, '  \n')).toBe(base);
	});

	test('the hold compares against the anchor when one is given', () => {
		const stored = 'The innkeeper waves {{user}} over.';
		const anchor = 'The innkeeper waves Alice over.';
		expect(previewContinuation(stored, 'waves Alice over', anchor)).toBe(stored);
	});
});
