/**
 * Tests for the text pop-out's pure half. Run with `bun test`.
 *
 * The component around it (focus tracking, the portal, the button's live position) is DOM
 * glue and is exercised by hand in the app. What is covered here is every rule that decides
 * an outcome: which fields qualify, that a write-back looks like typing to the field's owner,
 * and where the button lands.
 */

import { describe, expect, test } from 'bun:test';

import {
	finishEdit,
	isPopoutEligible,
	placeButton,
	popoutTitle,
	TEXT_POPOUT_OPT_OUT,
	writeBack,
	type ButtonPlacement,
	type PopoutField
} from './text-popout';

/** A field that records the events dispatched on it, in order. */
class FakeField extends EventTarget implements PopoutField {
	value: string;
	disabled: boolean;
	events: string[] = [];
	/** The selectors this field, or an ancestor of it, would match. */
	private matches: string[];

	constructor(value = '', opts: { disabled?: boolean; matches?: string[] } = {}) {
		super();
		this.value = value;
		this.disabled = opts.disabled ?? false;
		this.matches = opts.matches ?? [];
	}

	/** Answers like `Element.closest` for a selector list: a hit if any listed part matches. */
	closest(selector: string): unknown {
		const parts = selector.split(',').map((s) => s.trim());
		return parts.some((s) => this.matches.includes(s)) ? this : null;
	}

	override dispatchEvent(event: Event): boolean {
		this.events.push(event.type);
		return super.dispatchEvent(event);
	}
}

describe('isPopoutEligible', () => {
	test('an ordinary field qualifies', () => {
		expect(isPopoutEligible(new FakeField())).toBe(true);
	});

	test('a disabled field does not', () => {
		expect(isPopoutEligible(new FakeField('', { disabled: true }))).toBe(false);
	});

	test('a field inside an opted-out subtree does not', () => {
		expect(isPopoutEligible(new FakeField('', { matches: [`[${TEXT_POPOUT_OPT_OUT}]`] }))).toBe(false);
	});

	test('the chat composer does not', () => {
		expect(isPopoutEligible(new FakeField('', { matches: ['.composer-textarea'] }))).toBe(false);
	});

	test('a message being edited in place does not', () => {
		expect(isPopoutEligible(new FakeField('', { matches: ['.message-content-editing'] }))).toBe(false);
	});

	test('the Chungus Assistant composer does not', () => {
		expect(isPopoutEligible(new FakeField('', { matches: ['.assistant-textarea'] }))).toBe(false);
	});

	test('an unrelated class does not exclude a field', () => {
		expect(isPopoutEligible(new FakeField('', { matches: ['.input-base'] }))).toBe(true);
	});
});

describe('writeBack', () => {
	test('sets the value and fires a bubbling input event', () => {
		const field = new FakeField('before');
		let seen: { value: string; bubbles: boolean } | null = null;
		field.addEventListener('input', (e) => {
			seen = { value: field.value, bubbles: e.bubbles };
		});

		expect(writeBack(field, 'after')).toBe(true);
		expect(field.value).toBe('after');
		// The owner reads the field during the event, so the value must already be in place.
		expect(seen).toEqual({ value: 'after', bubbles: true });
	});

	test('an unchanged value dispatches nothing', () => {
		const field = new FakeField('same');
		expect(writeBack(field, 'same')).toBe(false);
		expect(field.events).toEqual([]);
	});
});

describe('finishEdit', () => {
	test('fires change, and leaves blur to the field, when focus goes back to it', () => {
		const field = new FakeField('opened');
		writeBack(field, 'edited');
		expect(finishEdit(field, 'opened', true)).toEqual(['change']);
		expect(field.events).toEqual(['input', 'change']);
	});

	test('stands in for the blur when focus does not go back to the field', () => {
		const field = new FakeField('opened');
		writeBack(field, 'edited');
		expect(finishEdit(field, 'opened', false)).toEqual(['change', 'blur']);
		expect(field.events).toEqual(['input', 'change', 'blur']);
	});

	test('the blur does not bubble, as a real one does not', () => {
		const field = new FakeField('opened');
		let bubbles: boolean | null = null;
		field.addEventListener('blur', (e) => (bubbles = e.bubbles));
		writeBack(field, 'edited');
		finishEdit(field, 'opened', false);
		expect(bubbles).toBe(false);
	});

	test('fires nothing when the edits came back to the original text', () => {
		const field = new FakeField('opened');
		writeBack(field, 'edited');
		writeBack(field, 'opened');
		expect(finishEdit(field, 'opened', false)).toEqual([]);
		expect(field.events).toEqual(['input', 'input']);
	});
});

describe('popoutTitle', () => {
	test('prefers the label', () => {
		expect(popoutTitle({ label: 'Scenario', ariaLabel: 'x', placeholder: 'y' })).toBe('Scenario');
	});

	test('falls back through the accessible name to the placeholder', () => {
		expect(popoutTitle({ label: '  ', ariaLabel: null, placeholder: 'Say something…' })).toBe(
			'Say something…'
		);
	});

	test('collapses whitespace from a label that wraps other markup', () => {
		expect(popoutTitle({ label: "Author's note\n\t\tnever sent" })).toBe("Author's note never sent");
	});

	test('shortens a long placeholder', () => {
		const title = popoutTitle({ placeholder: 'a'.repeat(100) });
		expect(title.length).toBe(58);
		expect(title.endsWith('…')).toBe(true);
	});

	test('has a heading even with nothing to go on', () => {
		expect(popoutTitle({})).toBe('Edit text');
	});
});

describe('placeButton', () => {
	const p: ButtonPlacement = { size: 30, inset: 6, scrollbar: 0, viewportHeight: 800 };

	test('sits in the top-right corner of a field that is fully on screen', () => {
		expect(placeButton({ top: 100, right: 500, bottom: 300, left: 100 }, p)).toEqual({
			top: 106,
			left: 464
		});
	});

	test('stays clear of the field scrollbar', () => {
		expect(placeButton({ top: 100, right: 500, bottom: 300, left: 100 }, { ...p, scrollbar: 12 })?.left).toBe(
			452
		);
	});

	test('follows the viewport top while the field is scrolled partly above it', () => {
		expect(placeButton({ top: -400, right: 500, bottom: 300, left: 100 }, p)?.top).toBe(6);
	});

	test('never leaves the field through its bottom edge', () => {
		expect(placeButton({ top: -400, right: 500, bottom: 20, left: 100 }, p)?.top).toBe(-16);
	});

	test('centres on a field shorter than the button and its insets', () => {
		expect(placeButton({ top: 100, right: 500, bottom: 134, left: 100 }, p)?.top).toBe(102);
	});

	test('offers nothing on a field too narrow to share', () => {
		expect(placeButton({ top: 100, right: 200, bottom: 300, left: 100 }, p)).toBeNull();
	});

	test('offers nothing for a field off screen', () => {
		expect(placeButton({ top: -300, right: 500, bottom: -10, left: 100 }, p)).toBeNull();
		expect(placeButton({ top: 900, right: 500, bottom: 1000, left: 100 }, p)).toBeNull();
	});
});
