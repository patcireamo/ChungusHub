/**
 * The prompt hold's JSON boundary: what an edited request is allowed to be before it may
 * reach a provider. Run with `bun test`.
 */
import { describe, test, expect } from 'bun:test';
import { parsePromptJson, promptToJson, samePrompt } from './prompt-review';
import type { LLMMessage } from '$lib/types/llm';

const SAMPLE: LLMMessage[] = [
	{ role: 'system', content: 'You are a narrator.' },
	{ role: 'user', content: 'Hello', images: ['images/chat/a.png'] }
];

function parse(value: unknown) {
	return parsePromptJson(JSON.stringify(value));
}

describe('promptToJson', () => {
	test('round trips a request unchanged', () => {
		const parsed = parsePromptJson(promptToJson(SAMPLE));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.messages).toEqual(SAMPLE);
	});

	test('serializes the array itself, not a wrapper', () => {
		expect(promptToJson(SAMPLE).trimStart().startsWith('[')).toBe(true);
	});
});

describe('parsePromptJson', () => {
	test('names the parse failure instead of swallowing it', () => {
		const parsed = parsePromptJson('[{');
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toStartWith('Invalid JSON:');
	});

	test('refuses anything that is not a list of messages', () => {
		expect(parse({ messages: SAMPLE })).toEqual({ ok: false, error: 'The request must be a list of messages.' });
	});

	test('refuses an emptied request', () => {
		expect(parse([])).toEqual({ ok: false, error: 'The request has no messages left.' });
	});

	test('names the message a fault is in', () => {
		expect(parse([{ role: 'user', content: 'a' }, 'nope'])).toEqual({
			ok: false,
			error: 'Message 2 is not an object.'
		});
		expect(parse([{ role: 'narrator', content: 'a' }])).toEqual({
			ok: false,
			error: 'Message 1 needs a role of "system", "user" or "assistant".'
		});
		expect(parse([{ role: 'user' }])).toEqual({ ok: false, error: 'Message 1 needs its content to be text.' });
		expect(parse([{ role: 'user', content: 'a', images: 'one.png' }])).toEqual({
			ok: false,
			error: 'Message 1 needs its images to be a list of file paths.'
		});
	});

	// A field nothing reads would ride along doing nothing, which reads as an edit that
	// worked. Refusing it is the whole reason unknown keys are checked at all.
	test('refuses a field the wire has no place for', () => {
		expect(parse([{ role: 'user', content: 'a', name: 'tool' }])).toEqual({
			ok: false,
			error: 'Message 1 has a field the request has no place for: "name".'
		});
	});

	test('carries only the declared fields, in order', () => {
		const parsed = parse([{ content: 'a', role: 'user' }]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(Object.keys(parsed.messages[0])).toEqual(['role', 'content']);
	});

	test('drops an empty image list, since that is what carrying no attachment looks like', () => {
		const parsed = parse([{ role: 'user', content: 'a', images: [] }]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.messages[0]).toEqual({ role: 'user', content: 'a' });
	});
});

describe('samePrompt', () => {
	test('key order is not an edit', () => {
		expect(samePrompt(SAMPLE, [{ content: 'You are a narrator.', role: 'system' } as LLMMessage, SAMPLE[1]])).toBe(
			true
		);
	});

	test('a missing image list and an empty one are the same request', () => {
		expect(samePrompt([{ role: 'user', content: 'a' }], [{ role: 'user', content: 'a', images: [] }])).toBe(true);
	});

	test('catches every kind of change', () => {
		expect(samePrompt(SAMPLE, [SAMPLE[0]])).toBe(false);
		expect(samePrompt(SAMPLE, [{ ...SAMPLE[0], content: 'edited' }, SAMPLE[1]])).toBe(false);
		expect(samePrompt(SAMPLE, [{ ...SAMPLE[0], role: 'user' }, SAMPLE[1]])).toBe(false);
		expect(samePrompt(SAMPLE, [SAMPLE[0], { ...SAMPLE[1], images: ['images/chat/b.png'] }])).toBe(false);
	});
});
