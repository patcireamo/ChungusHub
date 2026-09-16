/**
 * Local BPE encodings. We only ship the two OpenAI families gpt-tokenizer provides; every
 * other model (Claude, Llama, Gemini, DeepSeek, Qwen…) has no faithful local tokenizer, so
 * it rides o200k as a base estimate and the calibration layer corrects the per-model offset
 * from real usage. This is a small FAMILY map resolved from the model id (never a per-model
 * table), so new models work without any code change.
 */

import { countTokens as countCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { countTokens as countO200k } from 'gpt-tokenizer/encoding/o200k_base';

export type EncodingName = 'o200k_base' | 'cl100k_base';

/** Pick the closest local encoding for a model id. */
export function resolveEncoding(model?: string): EncodingName {
	const id = (model ?? '').toLowerCase();
	// Modern OpenAI uses o200k even though the id still contains "gpt-4"; rule it out first so
	// the legacy test below can't steal gpt-4o / gpt-4.1.
	const isModernGpt = /gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o/.test(id);
	if (!isModernGpt && /gpt-4|gpt-3\.5|gpt-35/.test(id)) return 'cl100k_base';
	// o200k for modern OpenAI and as the base estimate for everything else.
	return 'o200k_base';
}

/**
 * Counted strings, per encoding.
 *
 * BPE encoding is pure: the same text under the same encoding is the same number forever, with
 * no clock, config or state behind it, so there is nothing here to invalidate. An edited message
 * is a different string, so a different key, so a miss that computes the right answer. That is
 * the whole safety argument for caching here.
 *
 * It earns its place because the live meters re-assemble the ENTIRE prompt whenever any store
 * they read changes, and most of those changes have nothing to do with the chat: one character
 * typed into a lorebook entry reassigns the lorebook store's books, which invalidates the
 * composer's assembly, which re-prices every turn the prompt would inject. Twice, since the
 * budget trim sums the whole history before deciding most of it will not fit. On a long chat
 * whose memory is behind, those turns are sent verbatim and priced on every pass, which is
 * hundreds of thousands of tokens of BPE between one keystroke and the next.
 *
 * One map per encoding rather than one keyed by encoding + text: the same text genuinely counts
 * differently under cl100k and o200k, and a shared map would hand back the wrong number with
 * nothing in the app able to notice, since a meter that is quietly wrong looks exactly like a
 * meter that is right.
 *
 * Bounded by the characters held, not by the number of entries, and dropped wholesale when it
 * overflows (the shape the prompt-debug panel's estimate cache uses). Characters because the
 * single-use callers are the ones that grow without limit: the composer's draft and the live
 * streaming estimate both count a fresh, longer string on every keystroke and every streamed
 * chunk, so an entry cap would let a session retain every prefix of every reply. Wholesale
 * because the callers that DO repeat sweep a chat's history in order, and evicting one key at a
 * time under that pattern discards exactly what the next pass asks for first. The cap sits well
 * above the live history of a very long chat, so an ordinary assembly never trips it.
 */
export const COUNT_CACHE_MAX_CHARS = 8_000_000;
const caches: Record<EncodingName, { counts: Map<string, number>; chars: number }> = {
	o200k_base: { counts: new Map(), chars: 0 },
	cl100k_base: { counts: new Map(), chars: 0 }
};

/** Token count of `text` under the given encoding. */
export function encodingCount(text: string, encoding: EncodingName): number {
	if (!text) return 0;
	const cache = caches[encoding];
	const hit = cache.counts.get(text);
	if (hit !== undefined) return hit;
	const count = encoding === 'cl100k_base' ? countCl100k(text) : countO200k(text);
	if (cache.chars >= COUNT_CACHE_MAX_CHARS) {
		cache.counts.clear();
		cache.chars = 0;
	}
	cache.counts.set(text, count);
	cache.chars += text.length;
	return count;
}
