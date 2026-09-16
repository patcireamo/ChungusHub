/**
 * Smoke tests for the token-accounting core. Run with `bun test`.
 *
 * Pure pieces only (encoding resolution, counting, calibration math), with no Svelte runes,
 * no db, no network. These catch the regressions that would otherwise rot silently: a family
 * regex that misroutes a model to the wrong encoder, a broken encoding import, or a
 * calibration update that drifts, divides by zero, or fails to clamp a freak sample.
 */

import { describe, expect, test } from 'bun:test';

import { resolveEncoding, encodingCount, COUNT_CACHE_MAX_CHARS } from './encodings';
import { countTokens, countMessages } from './count';
import { blendRatio, clampRatio, sampleRatio, MIN_ESTIMATE, RATIO_MAX, RATIO_MIN } from './calibration-core';

describe('resolveEncoding (family map, not per-model)', () => {
	test('modern OpenAI families use o200k', () => {
		for (const id of ['gpt-4o', 'gpt-4o-mini', 'openai/gpt-4o', 'gpt-4.1', 'gpt-5', 'chatgpt-4o-latest']) {
			expect(resolveEncoding(id)).toBe('o200k_base');
		}
	});

	test('legacy OpenAI families use cl100k', () => {
		for (const id of ['gpt-4', 'gpt-4-turbo', 'gpt-4-0613', 'gpt-3.5-turbo', 'openai/gpt-3.5-turbo', 'gpt-35-turbo']) {
			expect(resolveEncoding(id)).toBe('cl100k_base');
		}
	});

	test('non-OpenAI and unknown models fall back to the o200k base estimate', () => {
		for (const id of ['anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.1-70b', 'deepseek/deepseek-chat', '', undefined]) {
			expect(resolveEncoding(id)).toBe('o200k_base');
		}
	});
});

describe('counting', () => {
	test('empty is zero, real text is positive', () => {
		expect(countTokens('')).toBe(0);
		expect(countTokens('the quick brown fox')).toBeGreaterThan(0);
	});

	test('the two encoders are genuinely different (not the same import twice)', () => {
		// CJK tokenizes very differently between cl100k and o200k (o200k added many CJK merges),
		// so this reliably proves the two encoders are wired to distinct vocabularies.
		const s = '这是一段用来测试分词器的中文文本，包含若干汉字与标点符号。';
		expect(encodingCount(s, 'cl100k_base')).toBeGreaterThan(0);
		expect(encodingCount(s, 'o200k_base')).toBeGreaterThan(0);
		expect(encodingCount(s, 'cl100k_base')).not.toBe(encodingCount(s, 'o200k_base'));
	});

	test('countMessages sums its parts under the same model', () => {
		const msgs = [{ content: 'alpha beta gamma' }, { content: 'delta epsilon' }];
		const expected = countTokens('alpha beta gamma', 'gpt-4o') + countTokens('delta epsilon', 'gpt-4o');
		expect(countMessages(msgs, 'gpt-4o')).toBe(expected);
	});
});

describe('the count cache', () => {
	// Counting is memoized per encoding (encodings.ts). BPE is pure, so the only ways a cache
	// here can be wrong are mixing the two encodings up and handing back a value it did not
	// compute for that text. Neither would fail a test anywhere else: a meter reading quietly
	// wrong looks exactly like a meter reading right.
	test('an equal string assembled at runtime counts the same as the literal', () => {
		const literal = 'the quick brown fox jumps over the lazy dog';
		const first = countTokens(literal, 'gpt-4o');
		expect(countTokens(literal, 'gpt-4o')).toBe(first);
		expect(countTokens(['the quick brown fox', ' jumps over the lazy dog'].join(''), 'gpt-4o')).toBe(first);
	});

	test('the same text keeps its own answer under each encoding', () => {
		// The one way a shared map breaks: whichever encoding asked first wins and the other
		// silently inherits its number.
		const s = '这是一段用来测试分词器的中文文本，包含若干汉字与标点符号。';
		const cl = encodingCount(s, 'cl100k_base');
		const o2 = encodingCount(s, 'o200k_base');
		expect(cl).not.toBe(o2);
		expect(encodingCount(s, 'cl100k_base')).toBe(cl);
		expect(encodingCount(s, 'o200k_base')).toBe(o2);
	});

	test('a count is still right after the cache overflows and is dropped', () => {
		const s = 'a sentence that outlives the cache it was stored in';
		const before = countTokens(s, 'gpt-4o');
		const filler = 'lorem ipsum dolor sit amet '.repeat(4000);
		for (let held = 0; held <= COUNT_CACHE_MAX_CHARS; held += filler.length) {
			encodingCount(`${held} ${filler}`, 'o200k_base');
		}
		expect(countTokens(s, 'gpt-4o')).toBe(before);
	});

	test('empty text is zero under either encoding', () => {
		expect(encodingCount('', 'o200k_base')).toBe(0);
		expect(encodingCount('', 'cl100k_base')).toBe(0);
	});
});

describe('calibration math', () => {
	test('clampRatio keeps samples inside the trusted band', () => {
		expect(clampRatio(0.01)).toBe(RATIO_MIN);
		expect(clampRatio(99)).toBe(RATIO_MAX);
		expect(clampRatio(1.2)).toBe(1.2);
	});

	test('sampleRatio rejects untrustworthy samples', () => {
		expect(sampleRatio(MIN_ESTIMATE - 1, 1000)).toBeNull(); // prompt too small
		expect(sampleRatio(1000, 0)).toBeNull(); // no usage reported
		expect(sampleRatio(0, 1000)).toBeNull(); // divide-by-zero guard
	});

	test('sampleRatio is clamped actual/estimate', () => {
		expect(sampleRatio(1000, 1200)).toBeCloseTo(1.2, 5);
		expect(sampleRatio(1000, 100000)).toBe(RATIO_MAX);
	});

	test('blendRatio seeds on the first sample, then EMA-folds', () => {
		expect(blendRatio(undefined, 1.4)).toBe(1.4);
		expect(blendRatio(1.0, 1.4)).toBeCloseTo(1.1, 5); // 1.0 + 0.25*(1.4 - 1.0)
	});

	test('repeated folding converges toward the observed ratio', () => {
		let ratio = 1.0;
		for (let i = 0; i < 50; i++) ratio = blendRatio(ratio, 1.5);
		expect(ratio).toBeCloseTo(1.5, 2);
	});
});
