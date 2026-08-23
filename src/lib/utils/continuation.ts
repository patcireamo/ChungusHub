/**
 * Continuation joining: the pure text rules for extending an assistant turn in place.
 *
 * A continuation arrives as free text from the model. Two hazards stand between it and a
 * clean append: the model may restate part (or all) of the original message despite being
 * told not to, and the seam may need a space neither side carries. The rules are split so
 * the live stream preview and the persisted result can share the seam logic:
 *   - glueContinuation(base, next): seam rule only; safe on a partial, still-streaming tail
 *     (overlap detection on a partial tail would false-positive and eat legitimate text).
 *   - previewContinuation(base, tail, anchor): glue, plus one partial-safe guard: while the
 *     streamed tail is still a verbatim fragment of the message, nothing is shown, so a
 *     restating model never paints the message duplicating itself on screen.
 *   - joinContinuation(base, next, anchor): restatement trim + glue; what actually gets saved.
 *
 * Restatement is detected in a NORMALIZED space, not byte-for-byte: a model re-typing text
 * through its own tokenizer habits swaps quote styles, dash styles, ellipses and whitespace
 * runs, and an exact comparison waves those copies through to be appended twice. Cuts are
 * then applied at the mapped RAW offset, so the text that survives is exactly the model's.
 *
 * `anchor` is the extended text as the model actually received it (self-refs expanded,
 * prompt regex applied); it defaults to `base`. A stored turn holding literal {{user}} is
 * restated by the model in its expanded form, so comparing against the stored bytes misses
 * the copy: callers that know the as-sent text pass it here.
 *
 * Covered by continuation.test.ts.
 */

/** Leading characters that glue directly onto the preceding word with no inserted space:
 *  whitespace, sentence punctuation, closers, and the curly ellipsis/dash/quote family. */
const GLUING_START = /^[\s.,!?;:)\]}"'…—’”]/; // em-dash: data

/** Longest tail overlap worth scanning for; a restatement longer than this is caught by
 *  the whole-message check instead, and the bound keeps the scan cheap on huge turns.
 *  Counted in normalized characters, like MIN_OVERLAP. */
const OVERLAP_WINDOW = 4000;

/** Overlaps shorter than this are treated as coincidence (a name, "the ") and kept. */
const MIN_OVERLAP = 16;

/** Seam rule alone: concatenate raw when either side already carries the boundary
 *  (whitespace or gluing punctuation), otherwise insert a single space. */
export function glueContinuation(base: string, next: string): string {
	if (!next) return base;
	if (!base) return next.trimStart();
	if (/\s$/.test(base) || GLUING_START.test(next)) return base + next;
	return base + ' ' + next;
}

const DASH = /[-–—]/; // en-dash + em-dash: data

/** `text` is the comparison form; `end[i]` is the source index just past the raw run that
 *  produced normalized character i (runs never overlap and nothing is dropped, so a cut
 *  after normalized prefix k lands at `end[k - 1]`). */
interface NormalizedText {
	text: string;
	end: number[];
}

/** Fold the variants a model swaps freely when re-typing text into one comparison form:
 *  whitespace runs to one space, dash runs (hyphen/en/em) to one hyphen, "..." to an
 *  ellipsis, curly quotes to straight. Case is left alone: a copy that changes case is a
 *  rewrite, and trimming rewrites would eat deliberate new text. */
function normalizeForMatch(source: string): NormalizedText {
	let text = '';
	const end: number[] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (/\s/.test(ch)) {
			let j = i + 1;
			while (j < source.length && /\s/.test(source[j])) j++;
			text += ' ';
			end.push(j);
			i = j;
		} else if (DASH.test(ch)) {
			let j = i + 1;
			while (j < source.length && DASH.test(source[j])) j++;
			text += '-';
			end.push(j);
			i = j;
		} else if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
			text += '…';
			end.push(i + 3);
			i += 3;
		} else if (ch === '“' || ch === '”') {
			text += '"';
			end.push(i + 1);
			i += 1;
		} else if (ch === '‘' || ch === '’') {
			text += "'";
			end.push(i + 1);
			i += 1;
		} else {
			text += ch;
			end.push(i + 1);
			i += 1;
		}
	}
	return { text, end };
}

/** Strip the longest prefix of `next` that restates the tail (or the whole) of `anchor`. */
function trimRestatement(anchor: string, next: string): string {
	const a = normalizeForMatch(anchor.trimEnd());
	if (!a.text) return next;
	const n = normalizeForMatch(next);
	// Whole-message restatement: the model rewrote everything from the top. Leading
	// whitespace on the copy normalizes to one space, skipped before comparing.
	const skip = n.text.startsWith(' ') ? 1 : 0;
	if (n.text.length - skip >= a.text.length && n.text.startsWith(a.text, skip)) {
		return next.slice(n.end[skip + a.text.length - 1]);
	}
	// Tail overlap, longest match first, inside a bounded window. The first-char probe
	// skips the substring build for the overwhelming majority of candidate lengths.
	const window = a.text.slice(-OVERLAP_WINDOW);
	const first = n.text.charCodeAt(0);
	for (let k = Math.min(window.length, n.text.length); k >= MIN_OVERLAP; k--) {
		if (window.charCodeAt(window.length - k) !== first) continue;
		if (window.endsWith(n.text.slice(0, k))) return next.slice(n.end[k - 1]);
	}
	return next;
}

/** Stream preview: the seam rule, plus a hold on tails that are still pure restatement.
 *  While the streamed text (normalized) still appears verbatim inside the anchor, showing
 *  it would paint the message eating itself, so the base stands alone until the first
 *  genuinely new text arrives. Recomputed per render and never persisted, so a held
 *  fragment that turns out to be legitimate (a phrase the message really contains) appears
 *  whole the moment the stream diverges; joinContinuation makes the final call. */
export function previewContinuation(base: string, tail: string, anchor: string = base): string {
	if (!tail) return base;
	const t = normalizeForMatch(tail).text.trim();
	if (!t || normalizeForMatch(anchor).text.includes(t)) return base;
	return glueContinuation(base, tail);
}

/** The persisted join: drop restated text, then glue. Returns `base` unchanged when the
 *  continuation contained nothing new, which callers treat as "nothing to append". */
export function joinContinuation(base: string, next: string, anchor: string = base): string {
	const fresh = trimRestatement(anchor, next);
	if (!fresh.trim()) return base;
	return glueContinuation(base, fresh);
}
