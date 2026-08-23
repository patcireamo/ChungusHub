/**
 * Tests for the composer-transform message shaping (Spellcheck, Impersonate). Run with
 * `bun test`. The part that matters most is Impersonate's seat: the history's roles are
 * SWAPPED so the chat template itself conditions the model as the user, and the filled
 * template closes the prompt as the final user turn. Small models follow the pattern of
 * the seat they are completing, not a system line at the top, which is exactly the
 * "impersonate always writes as the character" failure this shape exists to prevent.
 */

import { describe, expect, test } from 'bun:test';

import { shapeComposerTransform } from './composer-transforms';

function msg(role: string, content: string): any {
	return { id: `m-${role}-${content.length}`, role, content, parentId: null };
}

function shape(kind: 'spellcheck' | 'impersonate', chatMessages: any[], over: Record<string, unknown> = {}) {
	return shapeComposerTransform({
		kind,
		filled: 'FILLED TEMPLATE',
		chatMessages,
		charName: 'Sephiroth',
		userName: 'Alice',
		postProcessing: { mode: 'none' },
		...over
	} as any);
}

const STORY = [
	msg('assistant', 'Sephiroth eyes {{user}} across the fire.'),
	msg('user', 'I hold his gaze without flinching.'),
	msg('assistant', 'He smiles, unreadable.')
];

describe('spellcheck shape', () => {
	test('a single user turn carrying the filled template', () => {
		expect(shape('spellcheck', STORY)).toEqual([{ role: 'user', content: 'FILLED TEMPLATE' }]);
	});
});

describe('impersonate shape: the swapped seat', () => {
	test('history roles are swapped and the template closes the prompt as a user turn', () => {
		const out = shape('impersonate', STORY);
		expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
		expect(out[1].content).toBe('I hold his gaze without flinching.');
		expect(out[3]).toEqual({ role: 'user', content: 'FILLED TEMPLATE' });
	});

	test('self-refs in history expand to the live names, like injected story turns', () => {
		const out = shape('impersonate', STORY);
		expect(out[0].content).toBe('Sephiroth eyes Alice across the fire.');
	});

	test('system turns are dropped from the history', () => {
		const out = shape('impersonate', [msg('system', 'A narrator aside.'), ...STORY]);
		expect(out).toHaveLength(4);
		expect(out.every((m) => m.role !== 'system')).toBe(true);
	});

	test('an empty chat is just the template turn', () => {
		expect(shape('impersonate', [])).toEqual([{ role: 'user', content: 'FILLED TEMPLATE' }]);
	});

	test("a trailing user-authored turn swaps to assistant, so the prompt still ends on the template's user turn", () => {
		const out = shape('impersonate', [...STORY, msg('user', 'And I lean closer.')]);
		expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
		expect(out[4].content).toBe('FILLED TEMPLATE');
	});
});

describe('impersonate shape: the connection post-processing applies', () => {
	test("merge folds the character's last line and the template into one user turn", () => {
		const out = shape('impersonate', STORY, { postProcessing: { mode: 'merge' } });
		expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
		expect(out[2].content).toBe('He smiles, unreadable.\n\nFILLED TEMPLATE');
	});

	test('strict inserts the placeholder when the swapped history opens with an assistant turn', () => {
		const userFirst = [msg('user', 'I push the door open.'), msg('assistant', 'It creaks.')];
		const out = shape('impersonate', userFirst, {
			postProcessing: { mode: 'strict', placeholder: '[Start]' }
		});
		expect(out[0]).toEqual({ role: 'user', content: '[Start]' });
		expect(out[1].content).toBe('I push the door open.');
	});

	test('single-user collapses everything into one user message', () => {
		const out = shape('impersonate', STORY, { postProcessing: { mode: 'single-user' } });
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe('user');
		expect(out[0].content).toContain('FILLED TEMPLATE');
	});
});
