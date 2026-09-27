/**
 * The pure half of the text pop-out: which fields may be popped out, how an edit made in the
 * pop-out reaches the field it came from, and where the pop-out button sits on the field.
 *
 * The pop-out is global rather than wired into each editor. It watches focus, so any
 * `<textarea>` in the app gets it without the component that owns the field knowing. That
 * only works because the write-back goes through the field's own DOM events: an `input`
 * event is exactly what `bind:value` and every `oninput={...}` handler already listen for,
 * so the owner's state updates as if the text had been typed into the field itself.
 */

/** Marks a textarea, or any ancestor of one, as not offering the pop-out. */
export const TEXT_POPOUT_OPT_OUT = 'data-no-popout';

/**
 * Fields left out without an attribute on them, matched by a class their owner, or the
 * owner's parent, already gives them, so no upstream markup has to change. All are
 * conversation text: the chat composer, a message being edited in place (either
 * speaker's), and the Chungus Assistant's composer. A turn is short and sent with Enter,
 * and an edit sits in the widest column the app has, so a button over them is only in
 * the way.
 */
export const TEXT_POPOUT_EXCLUDED = [
	'.composer-textarea',
	'.message-content-editing',
	'.assistant-textarea'
];

const EXCLUDED_SELECTOR = [`[${TEXT_POPOUT_OPT_OUT}]`, ...TEXT_POPOUT_EXCLUDED].join(', ');

/** The slice of a textarea this module reads and writes. A seam for the tests, which pass
 *  plain `EventTarget`s rather than build a DOM. */
export interface PopoutField {
	value: string;
	readonly disabled: boolean;
	closest(selector: string): unknown;
	dispatchEvent(event: Event): boolean;
}

/** Whether a focused field offers the pop-out. Disabled fields do not: there is nothing to
 *  edit and nothing to read that the field is not already showing. Read-only fields do, as a
 *  larger view of the same text. */
export function isPopoutEligible(field: PopoutField): boolean {
	if (field.disabled) return false;
	return field.closest(EXCLUDED_SELECTOR) === null;
}

/**
 * Put `value` into the field and announce it the way typing would. Returns whether anything
 * was written: an unchanged value dispatches nothing, so an owner that saves on every input
 * is not asked to save the same text again.
 */
export function writeBack(field: PopoutField, value: string): boolean {
	if (field.value === value) return false;
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	return true;
}

/**
 * Tell the field's owner the editing is over, the way a native field would. Some owners
 * commit on `change` or on `blur` rather than on `input`, and the pop-out took focus away
 * from the field before any of its edits happened: the field's real blur fired with the old
 * text, so without this those owners would never hear of the new one.
 *
 * `refocused` says whether focus is going back to the field. If it is, the real blur comes
 * later on its own; if not (a phone, where refocusing would raise the keyboard again), this
 * stands in for it. Returns the events dispatched, in order; none when the text is unchanged.
 */
export function finishEdit(field: PopoutField, initial: string, refocused: boolean): string[] {
	if (field.value === initial) return [];
	const fired = ['change'];
	field.dispatchEvent(new Event('change', { bubbles: true }));
	if (!refocused) {
		fired.push('blur');
		field.dispatchEvent(new Event('blur'));
	}
	return fired;
}

/** The pop-out's heading: the field's label, else its accessible name, else its placeholder. */
export function popoutTitle(candidates: {
	label?: string | null;
	ariaLabel?: string | null;
	placeholder?: string | null;
}): string {
	for (const raw of [candidates.label, candidates.ariaLabel, candidates.placeholder]) {
		const text = raw?.replace(/\s+/g, ' ').trim();
		if (text) return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
	}
	return 'Edit text';
}

export interface FieldRect {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export interface ButtonPlacement {
	/** Edge length of the square button, in px. */
	size: number;
	/** Gap between the button and the field's edges, in px. */
	inset: number;
	/** Width of the field's own vertical scrollbar, which the button stays clear of. */
	scrollbar: number;
	/** Height of the viewport the button is positioned in. */
	viewportHeight: number;
}

/** Narrower than this, the button would cover most of what the field is showing. */
export const MIN_FIELD_WIDTH = 120;

/**
 * Where the button goes: the field's top-right corner, held inside the viewport while the
 * field is scrolled partly out of it, so a tall field keeps its button in reach. `null` when
 * the field is too narrow to share, or not on screen at all.
 */
export function placeButton(
	rect: FieldRect,
	p: ButtonPlacement
): { top: number; left: number } | null {
	const width = rect.right - rect.left;
	const height = rect.bottom - rect.top;
	if (width < MIN_FIELD_WIDTH) return null;
	if (rect.bottom <= 0 || rect.top >= p.viewportHeight) return null;

	const left = rect.right - p.scrollbar - p.inset - p.size;
	// A field shorter than the button plus its insets centres it rather than overhang an edge.
	if (height < p.size + 2 * p.inset) return { top: rect.top + (height - p.size) / 2, left };

	const highest = rect.top + p.inset;
	const lowest = rect.bottom - p.inset - p.size;
	const top = Math.min(Math.max(highest, p.inset), lowest);
	if (top + p.size <= 0 || top >= p.viewportHeight) return null;
	return { top, left };
}
