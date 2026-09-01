/**
 * Smoke tests for the pure prompt assembler. Run with `bun test`.
 *
 * These lock the token-attribution invariants that drove the recent bugs: ghosted (memory-
 * folded) turns must leave the Chat bucket, the {{memory}} recall must land in Context, the
 * archived-drop must be gated on the preset actually referencing {{memory}}, and the buckets
 * must always sum to the total. No db, no stores, no Svelte runes: just the pure assembler.
 */

import { describe, expect, test } from 'bun:test';

import {
	applyPostProcessing,
	assemblePrompt,
	DEFAULT_CONTINUE_PROMPT,
	DEFAULT_SYSTEM_PROMPT,
	type AssembleInput
} from './prompt-assembly';
import { countTokens } from '$lib/tokenizer/count';
import type { LLMMessage } from '$lib/types/llm';
import {
	createEmptyLorebook,
	createEmptyLorebookEntry,
	DEFAULT_LOREBOOK_GLOBAL_SETTINGS,
	type Lorebook,
	type LorebookEntry
} from '$lib/lorebook/types';

const MODEL = 'gpt-4o';

/* eslint-disable @typescript-eslint/no-explicit-any */
function item(content: string, opts: { id?: string; role?: string; enabled?: boolean } = {}): any {
	return { id: opts.id ?? content, role: opts.role ?? 'system', content, enabled: opts.enabled ?? true };
}

function preset(items: any[], extra: Record<string, unknown> = {}): any {
	return { id: 'p', name: 'p', items, controls: [], ...extra };
}

function msg(id: string, role: string, content: string): any {
	return { id, role, content, parentId: null };
}

function input(p: any, over: Partial<AssembleInput> = {}): AssembleInput {
	return {
		preset: p,
		resolvedCharacters: [],
		resolvedPersona: null,
		lorebooks: [],
		controls: [],
		customFields: {},
		chatMessages: [],
		recall: { text: null, archivedIds: new Set<string>() },
		model: MODEL,
		...over
	} as AssembleInput;
}

const CHAT = [
	msg('m1', 'user', 'First user message about the old castle.'),
	msg('m2', 'assistant', 'A long assistant reply describing the castle halls in great detail.'),
	msg('m3', 'user', 'Second user message.'),
	msg('m4', 'assistant', 'Second assistant reply.'),
	msg('m5', 'user', 'Latest user turn.')
];

describe('assemblePrompt: basic attribution', () => {
	test('plain preset item lands entirely in the preset bucket', () => {
		const a = assemblePrompt(input(preset([item('You are a helpful assistant.')])));
		expect(a.breakdown.preset).toBeGreaterThan(0);
		expect(a.breakdown.context).toBe(0);
		expect(a.breakdown.chat).toBe(0);
		expect(a.breakdown.total).toBe(a.breakdown.preset);
		expect(a.messages).toEqual([{ role: 'system', content: 'You are a helpful assistant.' }]);
	});

	test('buckets always sum to the total', () => {
		const a = assemblePrompt(
			input(preset([item('Intro {{memory}}'), item('{{chatHistory}}')]), {
				chatMessages: CHAT,
				recall: { text: 'FACTS: a thing happened.', archivedIds: new Set(['m1']) }
			})
		);
		expect(a.breakdown.total).toBe(
			a.breakdown.preset + a.breakdown.context + a.breakdown.memory + a.breakdown.chat
		);
	});

	test('disabled items contribute nothing', () => {
		const withDisabled = assemblePrompt(
			input(preset([item('Base instructions here.'), item('A long extra block that is disabled.', { enabled: false })]))
		);
		const baseOnly = assemblePrompt(input(preset([item('Base instructions here.')])));
		expect(withDisabled.breakdown.total).toBe(baseOnly.breakdown.total);
	});

	test('empty preset falls back to a single system message', () => {
		const a = assemblePrompt(input(preset([])));
		expect(a.messages.length).toBe(1);
		expect(a.messages[0].role).toBe('system');
		expect(a.breakdown.chat).toBe(0);
		expect(a.breakdown.total).toBe(a.breakdown.preset);
	});
});

describe('assemblePrompt: memory recall is its own bucket', () => {
	test('{{memory}} recall lands in Memory, not Context or Chat', () => {
		const recallText = 'Established facts: Kael owes the Iron Cartel 4000 marks by midwinter. Mara distrusts Kael.';
		const withRecall = assemblePrompt(
			input(preset([item('Memory:\n{{memory}}')]), { recall: { text: recallText, archivedIds: new Set() } })
		);
		const withoutRecall = assemblePrompt(input(preset([item('Memory:\n{{memory}}')])));
		expect(withRecall.breakdown.memory).toBeGreaterThan(0);
		expect(withRecall.breakdown.chat).toBe(0);
		// The recall text is attributed to Memory only: Context is unchanged vs no recall.
		expect(withRecall.breakdown.context).toBe(withoutRecall.breakdown.context);
		expect(withRecall.breakdown.total - withoutRecall.breakdown.total).toBe(withRecall.breakdown.memory);
	});
});

describe('assemblePrompt: ghosted turns leave the Chat bucket', () => {
	test('archived turns are dropped from {{chatHistory}} when the preset recalls them', () => {
		const archived = new Set(['m1', 'm2']);
		const withMemory = assemblePrompt(
			input(preset([item('{{memory}}'), item('{{chatHistory}}')]), {
				chatMessages: CHAT,
				recall: { text: 'FACTS: stuff happened.', archivedIds: archived }
			})
		);
		// Filtered history is [m3, m4, m5], and with no {{last_message}} in the preset
		// {{chatHistory}} carries all three.
		const expected =
			countTokens('Second user message.', MODEL) +
			countTokens('Second assistant reply.', MODEL) +
			countTokens('Latest user turn.', MODEL);
		expect(withMemory.breakdown.chat).toBe(expected);
	});

	test('archived turns are NOT dropped when the preset never injects {{memory}}', () => {
		const archived = new Set(['m1', 'm2']);
		const gated = assemblePrompt(
			input(preset([item('{{chatHistory}}')]), {
				chatMessages: CHAT,
				recall: { text: 'FACTS: stuff happened.', archivedIds: archived }
			})
		);
		const recalled = assemblePrompt(
			input(preset([item('{{memory}}'), item('{{chatHistory}}')]), {
				chatMessages: CHAT,
				recall: { text: 'FACTS: stuff happened.', archivedIds: archived }
			})
		);
		// Without {{memory}} the ghosts are still sent in full, so Chat is larger.
		expect(gated.breakdown.chat).toBeGreaterThan(recalled.breakdown.chat);
	});
});

describe('assemblePrompt: context budget trim', () => {
	const HISTORY_PRESET = preset([item('You are a narrator.'), item('{{chatHistory}}')]);

	test('no budget means no trimming', () => {
		const a = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT }));
		expect(a.trimmedMessages).toBe(0);
		expect(a.overBudget).toBe(false);
	});

	test('a budget larger than the prompt trims nothing', () => {
		const full = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT }));
		const a = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT, contextBudget: full.breakdown.total + 100 }));
		expect(a.trimmedMessages).toBe(0);
		expect(a.breakdown.total).toBe(full.breakdown.total);
	});

	test('overflow drops the oldest history turns first and the total fits the budget', () => {
		const full = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT }));
		// Budget that forces at least the oldest turn out but leaves room for newer ones.
		const budget = full.breakdown.total - countTokens('First user message about the old castle.', MODEL);
		const a = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT, contextBudget: budget }));
		expect(a.trimmedMessages).toBeGreaterThan(0);
		expect(a.breakdown.total).toBeLessThanOrEqual(budget);
		expect(a.overBudget).toBe(false);
		// The oldest turn is gone, the last user message survives.
		expect(a.messages.some((m) => m.content.includes('First user message'))).toBe(false);
		expect(a.messages.some((m) => m.content.includes('Latest user turn.'))).toBe(true);
	});

	test('kept history is the newest contiguous run', () => {
		const full = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT }));
		const budget =
			full.breakdown.total -
			countTokens('First user message about the old castle.', MODEL) -
			countTokens('A long assistant reply describing the castle halls in great detail.', MODEL);
		const a = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT, contextBudget: budget }));
		expect(a.trimmedMessages).toBe(2);
		expect(a.messages.some((m) => m.content.includes('Second user message.'))).toBe(true);
		expect(a.messages.some((m) => m.content.includes('Second assistant reply.'))).toBe(true);
	});

	test('preset blocks are never trimmed: a tiny budget empties the history and flags overBudget', () => {
		const a = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT, contextBudget: 1 }));
		// The preset survives; every history turn goes, the newest one included. It used to be
		// exempt by riding a structural {{last_message}} the trim couldn't touch. Now nothing
		// takes it out of {{chatHistory}}, so nothing shields it either. overBudget is the loud
		// half of that: a budget this small cannot carry the story, and says so.
		expect(a.overBudget).toBe(true);
		expect(a.messages.some((m) => m.content.includes('You are a narrator.'))).toBe(true);
		expect(a.messages.some((m) => m.content.includes('Latest user turn.'))).toBe(false);
		expect(a.messages.some((m) => m.content.includes('Second assistant reply.'))).toBe(false);
	});

	test('memory-archived turns and budget-trimmed turns compose', () => {
		const archived = new Set(['m1']);
		const full = assemblePrompt(
			input(preset([item('{{memory}}'), item('{{chatHistory}}')]), {
				chatMessages: CHAT,
				recall: { text: 'FACTS: stuff happened.', archivedIds: archived }
			})
		);
		// Squeeze out m2 (the oldest remaining turn) on top of the archived m1.
		const budget = full.breakdown.total - countTokens('A long assistant reply describing the castle halls in great detail.', MODEL);
		const a = assemblePrompt(
			input(preset([item('{{memory}}'), item('{{chatHistory}}')]), {
				chatMessages: CHAT,
				recall: { text: 'FACTS: stuff happened.', archivedIds: archived },
				contextBudget: budget
			})
		);
		expect(a.trimmedMessages).toBe(1);
		expect(a.breakdown.chat).toBe(
			countTokens('Second user message.', MODEL) +
				countTokens('Second assistant reply.', MODEL) +
				countTokens('Latest user turn.', MODEL)
		);
	});
});

describe('assemblePrompt: the last-turn macros are inline text, not injection', () => {
	// SillyTavern semantics: they QUOTE a turn, they never take it away from the history.
	// The old {{last_message}} was structural and split the chat path in two, which is what
	// let turns fall between the two macros and vanish. Nothing splits the path now.
	test('{{lastMessage}} expands to the newest turn as text, in the item\'s own role', () => {
		const a = assemblePrompt(input(preset([item('Latest: {{lastMessage}}')]), { chatMessages: CHAT }));
		expect(a.messages).toEqual([{ role: 'system', content: 'Latest: Latest user turn.' }]);
		// Inline text is preset/context, never the Chat bucket: nothing was injected.
		expect(a.breakdown.chat).toBe(0);
	});

	test('{{lastUserMessage}} and {{lastCharMessage}} pick the newest turn of their role', () => {
		const chat = [...CHAT, msg('m6', 'assistant', 'A dummy turn to steer from.')];
		const a = assemblePrompt(
			input(preset([item('U: {{lastUserMessage}} | C: {{lastCharMessage}} | L: {{lastMessage}}')]), {
				chatMessages: chat
			})
		);
		expect(a.messages[0].content).toBe(
			'U: Latest user turn. | C: A dummy turn to steer from. | L: A dummy turn to steer from.'
		);
	});

	test('quoting a turn does not remove it from {{chatHistory}}', () => {
		const a = assemblePrompt(
			input(preset([item('{{chatHistory}}'), item('Latest: {{lastMessage}}')]), { chatMessages: CHAT })
		);
		// Every turn still injected, in order, and the newest one also appears as the quote.
		expect(a.messages.slice(0, CHAT.length).map((m) => m.content)).toEqual(CHAT.map((m) => m.content));
		expect(a.messages[CHAT.length].content).toBe('Latest: Latest user turn.');
	});

	test('all three resolve empty on an empty chat', () => {
		const a = assemblePrompt(
			input(preset([item('[{{lastMessage}}][{{lastUserMessage}}][{{lastCharMessage}}]')]), {
				chatMessages: []
			})
		);
		expect(a.messages[0].content).toBe('[][][]');
	});
});

describe('assemblePrompt: {{chatHistory}} carries the whole path', () => {
	test('the newest turn is injected like any other', () => {
		const a = assemblePrompt(input(preset([item('{{chatHistory}}')]), { chatMessages: CHAT }));
		expect(a.messages.map((m) => m.content)).toEqual(CHAT.map((m) => m.content));
		expect(a.messages.filter((m) => m.content === 'Latest user turn.').length).toBe(1);
	});

	test('turns after the last user turn survive', () => {
		// The composer's dummy assistant turn, and every path Continue builds.
		const chat = [...CHAT, msg('m6', 'assistant', 'A dummy turn to steer from.')];
		const a = assemblePrompt(input(preset([item('{{chatHistory}}')]), { chatMessages: chat }));
		expect(a.messages.map((m) => m.content)).toEqual(chat.map((m) => m.content));
	});

	test('the newest turn keeps its image attachments', () => {
		const chat = [
			...CHAT.slice(0, 4),
			{ ...msg('m5', 'user', 'What is in this picture?'), attachments: [{ kind: 'image', path: 'images/chat/a.png' }] }
		];
		const a = assemblePrompt(input(preset([item('{{chatHistory}}')]), { chatMessages: chat }));
		expect(a.messages[4]).toEqual({
			role: 'user',
			content: 'What is in this picture?',
			images: ['images/chat/a.png']
		});
	});

	test('an image-only turn (empty content) is still injected', () => {
		const chat = [
			...CHAT.slice(0, 4),
			{ ...msg('m5', 'user', ''), attachments: [{ kind: 'image', path: 'images/chat/a.png' }] }
		];
		const a = assemblePrompt(input(preset([item('{{chatHistory}}')]), { chatMessages: chat }));
		expect(a.messages[4]).toEqual({ role: 'user', content: '', images: ['images/chat/a.png'] });
	});
});

describe('assemblePrompt: regex rules', () => {
	const HISTORY_PRESET = preset([item('You are a castle narrator.'), item('{{chatHistory}}')]);

	function regexRule(over: Record<string, unknown> = {}): any {
		return {
			id: 'r1',
			name: 'rule',
			enabled: true,
			pattern: 'castle',
			flags: 'g',
			replacement: 'fortress',
			targets: ['user', 'assistant'],
			scopes: ['prompt'],
			...over
		};
	}

	test('prompt-scope rules rewrite injected chat turns but never the preset text', () => {
		const a = assemblePrompt(
			input(HISTORY_PRESET, { chatMessages: CHAT, regexRules: [regexRule()], postProcessing: { mode: 'none' } })
		);
		// The preset item also contains "castle": rules only touch chat messages.
		expect(a.messages[0].content).toBe('You are a castle narrator.');
		expect(a.messages.some((m) => m.content.includes('old fortress'))).toBe(true);
		expect(a.messages.some((m) => m.content.includes('old castle'))).toBe(false);
		// Chat bucket prices the transformed text, so meters match what is sent.
		const historyChat = a.messages.filter((m, i) => i > 0);
		const expected = historyChat.reduce((sum, m) => sum + countTokens(m.content, MODEL), 0);
		expect(a.breakdown.chat).toBe(expected);
	});

	test('role targeting holds through assembly', () => {
		const a = assemblePrompt(
			input(HISTORY_PRESET, {
				chatMessages: CHAT,
				regexRules: [regexRule({ targets: ['assistant'] })],
				postProcessing: { mode: 'none' }
			})
		);
		expect(a.messages.some((m) => m.role === 'user' && m.content.includes('old castle'))).toBe(true);
		expect(a.messages.some((m) => m.role === 'assistant' && m.content.includes('fortress halls'))).toBe(true);
	});

	test('display-only and disabled rules leave the prompt untouched', () => {
		const bare = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT }));
		const displayOnly = assemblePrompt(
			input(HISTORY_PRESET, { chatMessages: CHAT, regexRules: [regexRule({ scopes: ['display'] })] })
		);
		const disabled = assemblePrompt(
			input(HISTORY_PRESET, { chatMessages: CHAT, regexRules: [regexRule({ enabled: false })] })
		);
		expect(displayOnly.messages).toEqual(bare.messages);
		expect(disabled.messages).toEqual(bare.messages);
	});

	test('the budget trim counts the transformed turns', () => {
		// Inflate every chat turn so the transformed history is what must fit.
		const inflate = regexRule({ pattern: 'castle', replacement: 'castle of the endless winding stair' });
		const full = assemblePrompt(input(HISTORY_PRESET, { chatMessages: CHAT, regexRules: [inflate] }));
		const budget = full.breakdown.total - 1;
		const a = assemblePrompt(
			input(HISTORY_PRESET, { chatMessages: CHAT, regexRules: [inflate], contextBudget: budget })
		);
		expect(a.trimmedMessages).toBeGreaterThan(0);
		expect(a.breakdown.total).toBeLessThanOrEqual(budget);
	});
});

describe('assemblePrompt: example dialogue (mes_example)', () => {
	// Two example blocks separated by <START>, with self-refs the macro must expand.
	const EXAMPLES =
		'{{user}}: Hi.\n{{char}}: Hello there, traveller.\n<START>\n{{user}}: Who are you?\n{{char}}: None of your business.';
	const ARIA = (over: Record<string, unknown> = {}): any => ({
		name: 'Aria',
		traits: { exampleDialogue: EXAMPLES, ...over }
	});
	const EX_PRESET = preset([item('Examples:\n{{mesExamples}}'), item('{{chatHistory}}')]);

	test('blocks are separator-headed and self-refs resolve', () => {
		const a = assemblePrompt(input(EX_PRESET, { resolvedCharacters: [ARIA()], chatMessages: CHAT }));
		const examples = a.messages.find((m) => m.content.includes('Hello there'))!;
		expect(examples.content).not.toContain('<START>');
		expect(examples.content).not.toContain('{{char}}');
		expect(examples.content).toContain('Aria: Hello there, traveller.');
		// Default separator '***' heads each of the two blocks.
		expect(examples.content.match(/\*\*\*/g)?.length).toBe(2);
		expect(a.trimmedExampleBlocks).toBe(0);
	});

	test('the preset separator replaces <START>', () => {
		const a = assemblePrompt(
			input(preset([item('{{mesExamples}}')], { exampleSeparator: '[Example Chat]' }), {
				resolvedCharacters: [ARIA()]
			})
		);
		expect(a.messages[0].content).toContain('[Example Chat]');
		expect(a.messages[0].content).not.toContain('***');
	});

	test('buckets still sum to the total with examples present', () => {
		const a = assemblePrompt(input(EX_PRESET, { resolvedCharacters: [ARIA()], chatMessages: CHAT }));
		expect(a.breakdown.total).toBe(
			a.breakdown.preset + a.breakdown.context + a.breakdown.memory + a.breakdown.chat
		);
	});

	test('examples are pushed out oldest-block-first, before any history is trimmed', () => {
		const full = assemblePrompt(input(EX_PRESET, { resolvedCharacters: [ARIA()], chatMessages: CHAT }));
		// Just barely over budget: dropping the oldest example block alone must bring it under,
		// so history stays intact, proving examples yield before chat history.
		const a = assemblePrompt(
			input(EX_PRESET, { resolvedCharacters: [ARIA()], chatMessages: CHAT, contextBudget: full.breakdown.total - 1 })
		);
		expect(a.trimmedExampleBlocks).toBe(1);
		expect(a.trimmedMessages).toBe(0);
		expect(a.overBudget).toBe(false);
		expect(a.breakdown.total).toBeLessThanOrEqual(full.breakdown.total - 1);
		// Oldest block gone, newest example block kept, chat history untouched.
		expect(a.messages.some((m) => m.content.includes('Hello there'))).toBe(false);
		expect(a.messages.some((m) => m.content.includes('None of your business.'))).toBe(true);
		expect(a.messages.some((m) => m.content.includes('Latest user turn.'))).toBe(true);
	});

	test('all example blocks drop before history trimming begins', () => {
		const full = assemblePrompt(input(EX_PRESET, { resolvedCharacters: [ARIA()], chatMessages: CHAT }));
		const examplesTokens = full.breakdown.context; // examples are the only context contributor here
		// Squeeze past every example block into the history: budget below the examples' weight.
		const budget = full.breakdown.total - examplesTokens - countTokens('First user message about the old castle.', MODEL);
		const a = assemblePrompt(
			input(EX_PRESET, { resolvedCharacters: [ARIA()], chatMessages: CHAT, contextBudget: budget })
		);
		expect(a.trimmedExampleBlocks).toBe(2);
		expect(a.messages.some((m) => m.content.includes('Hello there'))).toBe(false);
		expect(a.messages.some((m) => m.content.includes('None of your business.'))).toBe(false);
		expect(a.trimmedMessages).toBeGreaterThan(0);
	});
});

/**
 * The prompt converter (per-connection post-processing). Fixture mirrors a real RP
 * prompt: two leading system blocks, an assistant opening scene, a user turn, a
 * depth-injected system note, and an assistant reply.
 */
const RAW: LLMMessage[] = [
	{ role: 'system', content: 'Rules.' },
	{ role: 'system', content: 'World info.' },
	{ role: 'assistant', content: 'Greeting scene.' },
	{ role: 'user', content: 'Hello.' },
	{ role: 'system', content: 'Depth injection.' },
	{ role: 'assistant', content: 'Reply.' }
];

describe('applyPostProcessing: converter modes', () => {
	test('none leaves messages untouched', () => {
		expect(applyPostProcessing(RAW, 'none')).toEqual(RAW);
	});

	test('merge folds consecutive same-role messages with a blank-line seam', () => {
		expect(applyPostProcessing(RAW, 'merge')).toEqual([
			{ role: 'system', content: 'Rules.\n\nWorld info.' },
			{ role: 'assistant', content: 'Greeting scene.' },
			{ role: 'user', content: 'Hello.' },
			{ role: 'system', content: 'Depth injection.' },
			{ role: 'assistant', content: 'Reply.' }
		]);
	});

	test('semi-strict keeps one system message at the top and demotes later ones to user', () => {
		expect(applyPostProcessing(RAW, 'semi-strict')).toEqual([
			{ role: 'system', content: 'Rules.\n\nWorld info.' },
			{ role: 'assistant', content: 'Greeting scene.' },
			{ role: 'user', content: 'Hello.\n\nDepth injection.' },
			{ role: 'assistant', content: 'Reply.' }
		]);
	});

	test('strict inserts the placeholder when the prompt opens with the assistant', () => {
		const out = applyPostProcessing(RAW, 'strict');
		expect(out[0]).toEqual({ role: 'system', content: 'Rules.\n\nWorld info.' });
		expect(out[1]).toEqual({ role: 'user', content: '[Start a new chat]' });
		expect(out[2].role).toBe('assistant');
	});

	test('strict honors a custom placeholder', () => {
		const out = applyPostProcessing(RAW, 'strict', '[Begin]');
		expect(out[1]).toEqual({ role: 'user', content: '[Begin]' });
	});

	test('strict does not insert when a user turn already opens the chat', () => {
		const msgs: LLMMessage[] = [
			{ role: 'system', content: 'Rules.' },
			{ role: 'user', content: 'Hello.' },
			{ role: 'assistant', content: 'Reply.' }
		];
		expect(applyPostProcessing(msgs, 'strict')).toEqual(msgs);
	});

	test('strict appends a user turn to a system-only prompt', () => {
		expect(applyPostProcessing([{ role: 'system', content: 'Rules.' }], 'strict')).toEqual([
			{ role: 'system', content: 'Rules.' },
			{ role: 'user', content: '[Start a new chat]' }
		]);
	});

	test('single-user collapses the entire prompt into one user message, order preserved', () => {
		expect(applyPostProcessing(RAW, 'single-user')).toEqual([
			{ role: 'user', content: 'Rules.\n\nWorld info.\n\nGreeting scene.\n\nHello.\n\nDepth injection.\n\nReply.' }
		]);
	});
});

describe('assemblePrompt: post-processing input', () => {
	test('defaults to merging consecutive roles', () => {
		const a = assemblePrompt(input(preset([item('A.'), item('B.')])));
		expect(a.messages).toEqual([{ role: 'system', content: 'A.\n\nB.' }]);
	});

	test("mode 'none' keeps assembled messages separate", () => {
		const a = assemblePrompt(input(preset([item('A.'), item('B.')]), { postProcessing: { mode: 'none' } }));
		expect(a.messages).toEqual([
			{ role: 'system', content: 'A.' },
			{ role: 'system', content: 'B.' }
		]);
	});

	test('post-processing does not change the token breakdown', () => {
		const none = assemblePrompt(input(preset([item('A.'), item('B.')]), { postProcessing: { mode: 'none' } }));
		const single = assemblePrompt(input(preset([item('A.'), item('B.')]), { postProcessing: { mode: 'single-user' } }));
		expect(single.breakdown).toEqual(none.breakdown);
	});

	test('the fallback prompt is post-processed too', () => {
		const a = assemblePrompt(input(preset([]), { postProcessing: { mode: 'single-user' } }));
		expect(a.messages).toEqual([{ role: 'user', content: DEFAULT_SYSTEM_PROMPT }]);
	});
});

describe('assemblePrompt: continue-in-place', () => {
	const TARGET = msg('a9', 'assistant', 'The knight drew his blade and');
	/** The nudge is preset text now, so every case that wants one sets it on the preset. */
	const nudging = (items: any[], nudge = 'Continue now.') => preset(items, { continuePrompt: nudge });

	test('the extended turn and the nudge close the prompt, in that order', () => {
		const a = assemblePrompt(
			input(nudging([item('Rules.'), item('{{chatHistory}}'), item('Post-history.')]), {
				chatMessages: CHAT,
				postProcessing: { mode: 'none' },
				continuation: TARGET
			})
		);
		expect(a.messages[a.messages.length - 2]).toEqual({ role: 'assistant', content: TARGET.content });
		expect(a.messages[a.messages.length - 1]).toEqual({ role: 'user', content: 'Continue now.' });
	});

	test('a preset with no continuePrompt falls back to the shipped default', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.')]), { postProcessing: { mode: 'none' }, continuation: TARGET })
		);
		expect(a.messages[a.messages.length - 1]).toEqual({ role: 'user', content: DEFAULT_CONTINUE_PROMPT });
	});

	test('an empty or blank continuePrompt leaves the assistant turn last (prefill-style)', () => {
		for (const nudge of ['', '   ']) {
			const a = assemblePrompt(
				input(nudging([item('Rules.')], nudge), { postProcessing: { mode: 'none' }, continuation: TARGET })
			);
			expect(a.messages[a.messages.length - 1]).toEqual({ role: 'assistant', content: TARGET.content });
		}
	});

	test('macros in the continuePrompt resolve against the same context as the prompt', () => {
		const a = assemblePrompt(
			input(nudging([item('Rules.')], 'Keep writing as {{char}}, for {{user}}.'), {
				resolvedCharacters: [{ name: 'Kael', traits: {} } as any],
				resolvedPersona: { name: 'Mara', traits: {} } as any,
				postProcessing: { mode: 'none' },
				continuation: TARGET
			})
		);
		expect(a.messages[a.messages.length - 1]).toEqual({
			role: 'user',
			content: 'Keep writing as Kael, for Mara.'
		});
	});

	test('tail tokens land in the Chat bucket and the buckets still sum', () => {
		const withTail = assemblePrompt(input(nudging([item('Rules.')], 'Go on.'), { continuation: TARGET }));
		const without = assemblePrompt(input(nudging([item('Rules.')], 'Go on.')));
		const expected = countTokens(TARGET.content, MODEL) + countTokens('Go on.', MODEL);
		expect(withTail.breakdown.chat - without.breakdown.chat).toBe(expected);
		expect(withTail.breakdown.total).toBe(
			withTail.breakdown.preset + withTail.breakdown.context + withTail.breakdown.memory + withTail.breakdown.chat
		);
	});

	test('self-refs in the extended turn resolve live, like injected history', () => {
		const a = assemblePrompt(
			input(nudging([item('Rules.')], ''), {
				resolvedCharacters: [{ name: 'Kael', traits: {} } as any],
				resolvedPersona: { name: 'Mara', traits: {} } as any,
				postProcessing: { mode: 'none' },
				continuation: msg('a9', 'assistant', '{{char}} looked at {{user}} and')
			})
		);
		expect(a.messages[a.messages.length - 1].content).toBe('Kael looked at Mara and');
	});

	test('the tail survives the empty-preset fallback', () => {
		const a = assemblePrompt(
			input(nudging([], 'Go on.'), { postProcessing: { mode: 'none' }, continuation: TARGET })
		);
		expect(a.messages).toEqual([
			{ role: 'system', content: DEFAULT_SYSTEM_PROMPT },
			{ role: 'assistant', content: TARGET.content },
			{ role: 'user', content: 'Go on.' }
		]);
		expect(a.breakdown.chat).toBeGreaterThan(0);
	});

	test('the budget trim prices the tail: history drops to make room for it', () => {
		const p = nudging([item('{{chatHistory}}')], '');
		const noTail = assemblePrompt(input(p, { chatMessages: CHAT }));
		// The budget fits the plain prompt exactly, so the tail alone forces the trim.
		const budget = noTail.breakdown.total;
		const withTail = assemblePrompt(
			input(p, { chatMessages: CHAT, contextBudget: budget, continuation: TARGET })
		);
		expect(withTail.trimmedMessages).toBeGreaterThan(0);
		expect(withTail.breakdown.total).toBeLessThanOrEqual(budget);
		expect(withTail.overBudget).toBe(false);
	});

	test('single-user post-processing folds the tail in', () => {
		const a = assemblePrompt(
			input(nudging([item('Rules.')], 'Go on.'), {
				postProcessing: { mode: 'single-user' },
				continuation: TARGET
			})
		);
		expect(a.messages.length).toBe(1);
		expect(a.messages[0].role).toBe('user');
		expect(a.messages[0].content).toContain(TARGET.content);
		expect(a.messages[0].content).toContain('Go on.');
	});

	test('no continuation input leaves the assembly byte-identical', () => {
		const p = preset([item('Rules.'), item('{{chatHistory}}')]);
		const a = assemblePrompt(input(p, { chatMessages: CHAT }));
		const b = assemblePrompt(input(p, { chatMessages: CHAT, continuation: undefined }));
		expect(a).toEqual(b);
	});
});

describe('assemblePrompt: corrections', () => {
	const SUBJECT = msg('a9', 'assistant', 'The knight drew his blade and waited.');
	const DIRECTION = 'Make him hesitate instead.';
	const correcting = (instruction = DIRECTION, message: any = SUBJECT) => ({ message, instruction });

	/** A prompt-scope rule that hides text from the model without touching storage: the exact
	 *  shape a correction must not round-trip through, or the hidden half is deleted for good. */
	const STRIPPER: any = {
		id: 'r1',
		name: 'strip',
		description: '',
		enabled: true,
		pattern: '<hidden>.*?</hidden>',
		flags: 'g',
		replacement: '',
		targets: ['assistant'],
		scopes: ['prompt']
	};

	test('the reply and the direction close the prompt, in that order', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.'), item('{{chatHistory}}'), item('Post-history.')]), {
				chatMessages: CHAT,
				postProcessing: { mode: 'none' },
				correction: correcting()
			})
		);
		expect(a.messages[a.messages.length - 2]).toEqual({ role: 'assistant', content: SUBJECT.content });
		expect(a.messages[a.messages.length - 1]).toEqual({ role: 'user', content: DIRECTION });
	});

	test('the reply is sent as stored bytes: a prompt-scope rule never rewrites it', () => {
		const hiding = msg('a9', 'assistant', 'He drew his blade.<hidden>ooc note</hidden>');
		const a = assemblePrompt(
			input(preset([item('Rules.')]), {
				postProcessing: { mode: 'none' },
				regexRules: [STRIPPER],
				correction: correcting(DIRECTION, hiding)
			})
		);
		// Sent whole, because the rewrite that comes back REPLACES this row: sending the
		// stripped form would delete what the rule was only hiding.
		expect(a.messages[a.messages.length - 2]).toEqual({ role: 'assistant', content: hiding.content });
	});

	test('continue still applies that same rule, which is the difference being kept', () => {
		const hiding = msg('a9', 'assistant', 'He drew his blade.<hidden>ooc note</hidden>');
		const a = assemblePrompt(
			input(preset([item('Rules.')], { continuePrompt: 'Go on.' }), {
				postProcessing: { mode: 'none' },
				regexRules: [STRIPPER],
				continuation: hiding
			})
		);
		expect(a.messages[a.messages.length - 2]).toEqual({
			role: 'assistant',
			content: 'He drew his blade.'
		});
	});

	test('self-refs in the reply are left alone too, for the same reason', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.')]), {
				resolvedCharacters: [{ name: 'Kael', traits: {} } as any],
				resolvedPersona: { name: 'Mara', traits: {} } as any,
				postProcessing: { mode: 'none' },
				correction: correcting(DIRECTION, msg('a9', 'assistant', '{{char}} looked at {{user}}.'))
			})
		);
		expect(a.messages[a.messages.length - 2].content).toBe('{{char}} looked at {{user}}.');
	});

	test('macros in the direction resolve against the same context as the prompt', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.')]), {
				resolvedCharacters: [{ name: 'Kael', traits: {} } as any],
				resolvedPersona: { name: 'Mara', traits: {} } as any,
				postProcessing: { mode: 'none' },
				correction: correcting('Rewrite as {{char}}, speaking to {{user}}.')
			})
		);
		expect(a.messages[a.messages.length - 1]).toEqual({
			role: 'user',
			content: 'Rewrite as Kael, speaking to Mara.'
		});
	});

	test('a correction yields no join anchor: it replaces its turn rather than joining onto it', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.')]), { postProcessing: { mode: 'none' }, correction: correcting() })
		);
		expect(a.continuationSent).toBeUndefined();
	});

	test('tail tokens land in the Chat bucket and the buckets still sum', () => {
		const withTail = assemblePrompt(input(preset([item('Rules.')]), { correction: correcting() }));
		const without = assemblePrompt(input(preset([item('Rules.')])));
		const expected = countTokens(SUBJECT.content, MODEL) + countTokens(DIRECTION, MODEL);
		expect(withTail.breakdown.chat - without.breakdown.chat).toBe(expected);
		expect(withTail.breakdown.total).toBe(
			withTail.breakdown.preset +
				withTail.breakdown.context +
				withTail.breakdown.memory +
				withTail.breakdown.chat
		);
	});

	test('the tail survives the empty-preset fallback', () => {
		const a = assemblePrompt(
			input(preset([]), { postProcessing: { mode: 'none' }, correction: correcting() })
		);
		expect(a.messages).toEqual([
			{ role: 'system', content: DEFAULT_SYSTEM_PROMPT },
			{ role: 'assistant', content: SUBJECT.content },
			{ role: 'user', content: DIRECTION }
		]);
		expect(a.continuationSent).toBeUndefined();
	});

	test('the budget trim prices the tail: history drops rather than the reply being fixed', () => {
		const p = preset([item('{{chatHistory}}')]);
		const noTail = assemblePrompt(input(p, { chatMessages: CHAT }));
		// The budget fits the plain prompt exactly, so the tail alone forces the trim.
		const budget = noTail.breakdown.total;
		const withTail = assemblePrompt(
			input(p, { chatMessages: CHAT, contextBudget: budget, correction: correcting() })
		);
		expect(withTail.trimmedMessages).toBeGreaterThan(0);
		expect(withTail.breakdown.total).toBeLessThanOrEqual(budget);
		// The whole point: whatever else went, the reply being corrected is still in the prompt.
		expect(withTail.messages[withTail.messages.length - 2]).toEqual({
			role: 'assistant',
			content: SUBJECT.content
		});
	});

	test('no correction input leaves the assembly byte-identical', () => {
		const p = preset([item('Rules.'), item('{{chatHistory}}')]);
		const a = assemblePrompt(input(p, { chatMessages: CHAT }));
		const b = assemblePrompt(input(p, { chatMessages: CHAT, correction: undefined }));
		expect(a).toEqual(b);
	});
});

describe('assemblePrompt: steering', () => {
	const WRAPPER = '[Guidance: {{steering}}]';
	/** One note: the shape every guarantee below was written against, kept so the
	 *  single-note path is provably unchanged by the multi-note model. */
	function steeringInput(
		over: Partial<{ text: string; depth: number; role: 'system' | 'user' | 'assistant'; wrapper: string }> = {}
	): AssembleInput['steering'] {
		return {
			notes: [
				{
					text: over.text ?? 'Focus on the sword fight.',
					depth: over.depth ?? 0,
					role: over.role ?? 'system'
				}
			],
			wrapper: over.wrapper ?? WRAPPER
		};
	}
	const TARGET = msg('a9', 'assistant', 'The knight drew his blade and');

	test('depth 0 lands right after the newest turn, ahead of the post-history items and the tail', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.'), item('{{chatHistory}}'), item('Post-history.')], { continuePrompt: 'Continue now.' }), {
				chatMessages: CHAT,
				postProcessing: { mode: 'none' },
				steering: steeringInput(),
				continuation: TARGET
			})
		);
		const i = a.messages.findIndex((m) => m.content.includes('Focus on the sword fight'));
		expect(a.messages[i - 1].content).toBe('Latest user turn.'); // m5, the newest history turn
		expect(a.messages[i + 1].content).toBe('Post-history.');
		expect(a.messages.slice(-2)).toEqual([
			{ role: 'assistant', content: TARGET.content },
			{ role: 'user', content: 'Continue now.' }
		]);
	});

	test('the steering role is honored', () => {
		for (const role of ['system', 'user', 'assistant'] as const) {
			const a = assemblePrompt(
				input(preset([item('Rules.')]), { postProcessing: { mode: 'none' }, steering: steeringInput({ role }) })
			);
			expect(a.messages[a.messages.length - 1].role).toBe(role);
		}
	});

	test('the wrapper fills {{steering}} and both the wrapper and the steering text expand {{char}}/{{user}}', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.')]), {
				resolvedCharacters: [{ name: 'Kael', traits: {} } as any],
				resolvedPersona: { name: 'Mara', traits: {} } as any,
				postProcessing: { mode: 'none' },
				steering: steeringInput({
					text: '{{char}} should notice {{user}}.',
					wrapper: '[Guidance for {{char}}: {{steering}}]'
				})
			})
		);
		expect(a.messages[a.messages.length - 1]).toEqual({
			role: 'system',
			content: '[Guidance for Kael: Kael should notice Mara.]'
		});
	});

	test('depth 1 lands one turn back', () => {
		const p = preset([item('Rules.'), item('{{chatHistory}}')]);
		const a = assemblePrompt(
			input(p, { chatMessages: CHAT, postProcessing: { mode: 'none' }, steering: steeringInput({ depth: 1 }) })
		);
		const i = a.messages.findIndex((m) => m.content.includes('Focus on the sword fight'));
		expect(a.messages[i - 1].content).toBe('Second assistant reply.'); // m4, the newest history turn
		expect(a.messages[i + 1].content).toBe('Latest user turn.'); // m5, the newest turn
	});

	test('depth N counts back from the newest injected turn', () => {
		const p = preset([item('{{chatHistory}}')]);
		const a = assemblePrompt(
			input(p, { chatMessages: CHAT, postProcessing: { mode: 'none' }, steering: steeringInput({ depth: 2 }) })
		);
		const i = a.messages.findIndex((m) => m.content.includes('Focus on the sword fight'));
		expect(a.messages[i - 1].content).toBe('Second user message.'); // m3
		expect(a.messages[i + 1].content).toBe('Second assistant reply.'); // m4
	});

	test('depth 0 lands after the newest turn, inside the history', () => {
		const p = preset([item('{{chatHistory}}'), item('Post-history.')]);
		const a = assemblePrompt(
			input(p, { chatMessages: CHAT, postProcessing: { mode: 'none' }, steering: steeringInput({ depth: 0 }) })
		);
		const i = a.messages.findIndex((m) => m.content.includes('Focus on the sword fight'));
		expect(a.messages[i - 1].content).toBe('Latest user turn.'); // m5, now a history turn
		expect(a.messages[i + 1].content).toBe('Post-history.');
	});

	test('a depth deeper than the kept history clamps to before the oldest turn', () => {
		const p = preset([item('{{chatHistory}}')]);
		const a = assemblePrompt(
			input(p, { chatMessages: CHAT, postProcessing: { mode: 'none' }, steering: steeringInput({ depth: 50 }) })
		);
		expect(a.messages[0].content).toContain('Focus on the sword fight');
		expect(a.messages[1].content).toBe('First user message about the old castle.'); // m1, oldest kept turn
	});

	test('an empty chat history still carries the steering message', () => {
		const p = preset([item('{{chatHistory}}')]);
		const a = assemblePrompt(
			input(p, { chatMessages: [], postProcessing: { mode: 'none' }, steering: steeringInput({ depth: 1 }) })
		);
		expect(a.messages).toEqual([{ role: 'system', content: '[Guidance: Focus on the sword fight.]' }]);
	});

	test('a preset with no chat macro at all falls back to the end of the assembly', () => {
		const p = preset([item('Just a system prompt, no history macro.')]);
		const a = assemblePrompt(
			input(p, { chatMessages: CHAT, postProcessing: { mode: 'none' }, steering: steeringInput({ depth: 3 }) })
		);
		expect(a.messages).toEqual([
			{ role: 'system', content: 'Just a system prompt, no history macro.' },
			{ role: 'system', content: '[Guidance: Focus on the sword fight.]' }
		]);
	});

	test('blank steering text injects nothing', () => {
		const p = preset([item('Rules.')]);
		const withBlank = assemblePrompt(
			input(p, { postProcessing: { mode: 'none' }, steering: steeringInput({ text: '   ' }) })
		);
		const without = assemblePrompt(input(p, { postProcessing: { mode: 'none' } }));
		expect(withBlank).toEqual(without);
	});

	test('a wrapper that expands to nothing also injects nothing', () => {
		const p = preset([item('Rules.')]);
		const a = assemblePrompt(input(p, { postProcessing: { mode: 'none' }, steering: steeringInput({ wrapper: '   ' }) }));
		expect(a.messages).toEqual([{ role: 'system', content: 'Rules.' }]);
	});

	test('the empty-preset fallback carries steering, after the system prompt and before the tail', () => {
		const a = assemblePrompt(
			input(preset([], { continuePrompt: 'Go on.' }), {
				postProcessing: { mode: 'none' },
				steering: steeringInput(),
				continuation: TARGET
			})
		);
		expect(a.messages).toEqual([
			{ role: 'system', content: DEFAULT_SYSTEM_PROMPT },
			{ role: 'system', content: '[Guidance: Focus on the sword fight.]' },
			{ role: 'assistant', content: TARGET.content },
			{ role: 'user', content: 'Go on.' }
		]);
		expect(a.breakdown.context).toBeGreaterThan(0);
		expect(a.breakdown.total).toBe(a.breakdown.preset + a.breakdown.context + a.breakdown.memory + a.breakdown.chat);
	});

	test('the budget trim prices steering: history drops to make room for it', () => {
		const p = preset([item('{{chatHistory}}')]);
		const noSteering = assemblePrompt(input(p, { chatMessages: CHAT }));
		const budget = noSteering.breakdown.total;
		const withSteering = assemblePrompt(
			input(p, { chatMessages: CHAT, contextBudget: budget, steering: steeringInput() })
		);
		expect(withSteering.trimmedMessages).toBeGreaterThan(0);
		expect(withSteering.breakdown.total).toBeLessThanOrEqual(budget);
		expect(withSteering.overBudget).toBe(false);
		expect(withSteering.messages.some((m) => m.content.includes('Focus on the sword fight'))).toBe(true);
	});

	test('steering survives even when the budget forces every history turn out', () => {
		const p = preset([item('You are a narrator.'), item('{{chatHistory}}')]);
		const a = assemblePrompt(input(p, { chatMessages: CHAT, contextBudget: 1, steering: steeringInput() }));
		expect(a.overBudget).toBe(true);
		expect(a.messages.some((m) => m.content.includes('Focus on the sword fight'))).toBe(true);
		expect(a.messages.some((m) => m.content.includes('Second assistant reply.'))).toBe(false);
	});

	test('buckets still sum to the total with steering present (depth 0 and spliced)', () => {
		const p = preset([item('Intro {{memory}}'), item('{{chatHistory}}')]);
		const recall = { text: 'FACTS: a thing happened.', archivedIds: new Set(['m1']) };
		const depth0 = assemblePrompt(input(p, { chatMessages: CHAT, recall, steering: steeringInput({ depth: 0 }) }));
		const depth1 = assemblePrompt(input(p, { chatMessages: CHAT, recall, steering: steeringInput({ depth: 1 }) }));
		for (const a of [depth0, depth1]) {
			expect(a.breakdown.total).toBe(a.breakdown.preset + a.breakdown.context + a.breakdown.memory + a.breakdown.chat);
		}
	});

	test('steering tokens land in Context, never Chat, whether appended at depth 0 or spliced at depth N', () => {
		const p = preset([item('{{chatHistory}}')]);
		const base = assemblePrompt(input(p, { chatMessages: CHAT }));
		const steeringTokens = countTokens('[Guidance: Focus on the sword fight.]', MODEL);

		const depth0 = assemblePrompt(input(p, { chatMessages: CHAT, steering: steeringInput({ depth: 0 }) }));
		expect(depth0.breakdown.context - base.breakdown.context).toBe(steeringTokens);
		expect(depth0.breakdown.chat).toBe(base.breakdown.chat);

		const depth2 = assemblePrompt(input(p, { chatMessages: CHAT, steering: steeringInput({ depth: 2 }) }));
		expect(depth2.breakdown.context - base.breakdown.context).toBe(steeringTokens);
		expect(depth2.breakdown.chat).toBe(base.breakdown.chat);
	});

	test('no steering input leaves the assembly byte-identical', () => {
		const p = preset([item('Rules.'), item('{{chatHistory}}')]);
		const a = assemblePrompt(input(p, { chatMessages: CHAT }));
		const b = assemblePrompt(input(p, { chatMessages: CHAT, steering: undefined }));
		expect(a).toEqual(b);
	});

	test('an empty note list injects nothing', () => {
		const p = preset([item('Rules.'), item('{{chatHistory}}')]);
		const a = assemblePrompt(input(p, { chatMessages: CHAT }));
		const b = assemblePrompt(input(p, { chatMessages: CHAT, steering: { notes: [], wrapper: WRAPPER } }));
		expect(a).toEqual(b);
	});
});

describe('assemblePrompt: several steering notes at once', () => {
	const WRAPPER = '[Guidance: {{steering}}]';
	function notes(
		list: { text: string; depth?: number; role?: 'system' | 'user' | 'assistant' }[]
	): AssembleInput['steering'] {
		return {
			notes: list.map((n) => ({ text: n.text, depth: n.depth ?? 0, role: n.role ?? 'system' })),
			wrapper: WRAPPER
		};
	}

	test('notes sharing a role and depth are joined into ONE wrapped message, in order', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.')]), {
				postProcessing: { mode: 'none' },
				steering: notes([{ text: 'Be terse.' }, { text: 'No purple prose.' }])
			})
		);
		expect(a.messages).toEqual([
			{ role: 'system', content: 'Rules.' },
			{ role: 'system', content: '[Guidance: Be terse.\n\nNo purple prose.]' }
		]);
	});

	test('a differing role splits the group', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.')]), {
				postProcessing: { mode: 'none' },
				steering: notes([{ text: 'As system.' }, { text: 'As user.', role: 'user' }])
			})
		);
		expect(a.messages.slice(1)).toEqual([
			{ role: 'system', content: '[Guidance: As system.]' },
			{ role: 'user', content: '[Guidance: As user.]' }
		]);
	});

	test('a differing depth splits the group and each half lands at its own position', () => {
		const p = preset([item('{{chatHistory}}')]);
		const a = assemblePrompt(
			input(p, {
				chatMessages: CHAT,
				postProcessing: { mode: 'none' },
				steering: notes([{ text: 'Deep.', depth: 2 }, { text: 'Shallow.' }])
			})
		);
		const deep = a.messages.findIndex((m) => m.content.includes('Deep.'));
		const shallow = a.messages.findIndex((m) => m.content.includes('Shallow.'));
		// One sits two turns back inside the history; the other right after the newest turn.
		expect(a.messages[deep - 1].content).toBe('Second user message.'); // m3
		expect(a.messages[deep + 1].content).toBe('Second assistant reply.'); // m4
		expect(a.messages[shallow - 1].content).toBe('Latest user turn.'); // m5
	});

	test('two groups spliced at different depths keep their own positions', () => {
		const p = preset([item('{{chatHistory}}')]);
		const a = assemblePrompt(
			input(p, {
				chatMessages: CHAT,
				postProcessing: { mode: 'none' },
				steering: notes([{ text: 'At three.', depth: 3 }, { text: 'At one.', depth: 1 }])
			})
		);
		const three = a.messages.findIndex((m) => m.content.includes('At three.'));
		const one = a.messages.findIndex((m) => m.content.includes('At one.'));
		expect(three).toBeLessThan(one);
		// Neither displaced the other's target: the newest turn (m5) is in the history like
		// every other, and depth 1 sits in front of it.
		expect(a.messages[three + 1].content).toBe('Second user message.'); // m3
		expect(a.messages[one + 1].content).toBe('Latest user turn.'); // m5
	});

	test('groups landing on the same splice slot keep their injection order', () => {
		const p = preset([item('{{chatHistory}}')]);
		const a = assemblePrompt(
			input(p, {
				chatMessages: CHAT,
				postProcessing: { mode: 'none' },
				steering: notes([
					{ text: 'First here.', depth: 2, role: 'system' },
					{ text: 'Then here.', depth: 2, role: 'user' }
				])
			})
		);
		const first = a.messages.findIndex((m) => m.content.includes('First here.'));
		const then = a.messages.findIndex((m) => m.content.includes('Then here.'));
		expect(then).toBe(first + 1);
	});

	test('every group is priced into Context exactly once, whatever its placement', () => {
		const p = preset([item('{{chatHistory}}')]);
		const base = assemblePrompt(input(p, { chatMessages: CHAT }));
		const a = assemblePrompt(
			input(p, {
				chatMessages: CHAT,
				steering: notes([{ text: 'Shallow.' }, { text: 'Deep.', depth: 2 }])
			})
		);
		const expected =
			countTokens('[Guidance: Shallow.]', MODEL) + countTokens('[Guidance: Deep.]', MODEL);
		expect(a.breakdown.context - base.breakdown.context).toBe(expected);
		expect(a.breakdown.chat).toBe(base.breakdown.chat);
		expect(a.breakdown.total).toBe(
			a.breakdown.preset + a.breakdown.context + a.breakdown.memory + a.breakdown.chat
		);
	});

	test('a blank note is dropped without collapsing the group it shared', () => {
		const a = assemblePrompt(
			input(preset([item('Rules.')]), {
				postProcessing: { mode: 'none' },
				steering: notes([{ text: '   ' }, { text: 'Real guidance.' }])
			})
		);
		expect(a.messages.slice(1)).toEqual([{ role: 'system', content: '[Guidance: Real guidance.]' }]);
	});

	test('the budget trim weighs every group, and none of them is ever trimmed away', () => {
		const p = preset([item('{{chatHistory}}')]);
		const noSteering = assemblePrompt(input(p, { chatMessages: CHAT }));
		const a = assemblePrompt(
			input(p, {
				chatMessages: CHAT,
				contextBudget: noSteering.breakdown.total,
				steering: notes([{ text: 'One.' }, { text: 'Two.', depth: 2 }, { text: 'Three.', role: 'user' }])
			})
		);
		expect(a.trimmedMessages).toBeGreaterThan(0);
		expect(a.breakdown.total).toBeLessThanOrEqual(noSteering.breakdown.total);
		for (const text of ['One.', 'Two.', 'Three.']) {
			expect(a.messages.some((m) => m.content.includes(text))).toBe(true);
		}
	});

	test('the empty-preset fallback carries every group', () => {
		const a = assemblePrompt(
			input(preset([]), {
				postProcessing: { mode: 'none' },
				steering: notes([{ text: 'Broad.' }, { text: 'Narrow.', role: 'user', depth: 4 }])
			})
		);
		expect(a.messages).toEqual([
			{ role: 'system', content: DEFAULT_SYSTEM_PROMPT },
			{ role: 'system', content: '[Guidance: Broad.]' },
			{ role: 'user', content: '[Guidance: Narrow.]' }
		]);
	});
});

describe('the lorebook trace assembly hands back', () => {
	function lorebook(entries: Partial<LorebookEntry>[]): Lorebook {
		const b = createEmptyLorebook('Eldoria');
		b.entries = entries.map((e) => ({ ...createEmptyLorebookEntry(), ...e }));
		return b;
	}

	test('names the entries whose text is in the prompt', () => {
		const a = assemblePrompt(
			input(preset([item('<world>{{lorebook}}</world>')]), {
				lorebooks: [
					lorebook([
						{ comment: 'Wolves', content: 'wolves hunt at night', key: ['wolf'] },
						{ comment: 'Town', content: 'town lore', key: ['town'] }
					])
				],
				chatMessages: [msg('m1', 'user', 'a wolf howls')]
			})
		);
		expect(a.messages[0].content).toContain('wolves hunt at night');
		expect(a.lorebook.records.map((r) => r.title)).toEqual(['Wolves']);
		expect(a.lorebook.silent).toBe(1);
	});

	test('is empty when no book was consulted', () => {
		const a = assemblePrompt(input(preset([item('{{lorebook}}')])));
		expect(a.lorebook).toEqual({ records: [], silent: 0 });
	});

	test('an at-depth entry rides inside the chat, not in the block', () => {
		const p = preset([item('<world>{{lorebook}}</world>'), item('{{chatHistory}}'), item('Post-history.')]);
		const a = assemblePrompt(
			input(p, {
				lorebooks: [
					lorebook([
						{ comment: 'Deep', content: 'the wolves circle', constant: true, position: 4, depth: 1, role: 1 }
					])
				],
				chatMessages: CHAT,
				postProcessing: { mode: 'none' }
			})
		);
		// The block came back empty (its framing is authored text and stays, as always), and
		// the lore is a user turn one step back from the newest.
		expect(a.messages[0].content).toBe('<world></world>');
		const i = a.messages.findIndex((m) => m.content === 'the wolves circle');
		expect(a.messages[i].role).toBe('user');
		expect(a.messages[i - 1].content).toBe('Second assistant reply.');
		expect(a.messages[i + 1].content).toBe('Latest user turn.');
	});

	test('it is priced once, in Context, never as a chat turn', () => {
		const p = preset([item('{{chatHistory}}')]);
		const text = 'the wolves circle';
		const a = assemblePrompt(
			input(p, {
				lorebooks: [lorebook([{ comment: 'Deep', content: text, constant: true, position: 4 }])],
				chatMessages: CHAT,
				postProcessing: { mode: 'none' }
			})
		);
		const bare = assemblePrompt(input(p, { chatMessages: CHAT, postProcessing: { mode: 'none' } }));
		expect(a.breakdown.chat).toBe(bare.breakdown.chat);
		expect(a.breakdown.context).toBe(bare.breakdown.context + countTokens(text, MODEL));
		expect(a.breakdown.total).toBe(a.breakdown.preset + a.breakdown.context + a.breakdown.memory + a.breakdown.chat);
	});

	test('with no chat to sit in, it falls back into the block instead of vanishing', () => {
		const a = assemblePrompt(
			input(preset([item('<world>{{lorebook}}</world>')]), {
				lorebooks: [
					lorebook([{ comment: 'Deep', content: 'the wolves circle', constant: true, position: 4 }])
				],
				postProcessing: { mode: 'none' }
			})
		);
		expect(a.messages[0].content).toContain('the wolves circle');
	});

	// The scan reads the whole path and the trim shortens what is SENT, so lore is admitted on
	// evidence the model never sees. Deliberate (the scan window is its own setting), and the
	// reason a stored trace can name a turn that is not in the prompt: narrow the scan to what
	// survived the trim and a long chat quietly stops firing the entries it was written for.
	test('an entry fires on a turn the trim then drops from the request', () => {
		const p = preset([item('<world>{{lorebook}}</world>'), item('{{chatHistory}}')]);
		const long = [
			msg('m0', 'user', 'the sigil glows'),
			...Array.from({ length: 30 }, (_, i) => msg(`m${i + 1}`, i % 2 ? 'assistant' : 'user', `turn ${i} of many words here`))
		];
		const book = lorebook([{ comment: 'Sigil', content: 'The sigil burns.', key: ['sigil'] }]);
		book.scanDepth = 0;
		const a = assemblePrompt(
			input(p, { lorebooks: [book], chatMessages: long, contextBudget: 120, postProcessing: { mode: 'none' } })
		);
		expect(a.messages[0].content).toContain('The sigil burns.');
		expect(a.trimmedMessages).toBeGreaterThan(0);
		expect(a.messages.some((m) => m.content === 'the sigil glows')).toBe(false);
	});

	// The lore allowance is a share of the prompt budget, so a small one has to drop whole
	// entries rather than cut them, keep the lowest `order` (which is what priority means here)
	// and say which ones it dropped, or a book silently shrinks with nothing on screen.
	test('a small lore budget drops entries whole, lowest order first, and says so', () => {
		const fat = lorebook(
			Array.from({ length: 8 }, (_, i) => ({
				comment: `P${i}`,
				content: `Paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(12)}`,
				constant: true,
				order: i
			}))
		);
		const p = preset([item('{{lorebook}}')]);
		const uncapped = assemblePrompt(input(p, { lorebooks: [fat], postProcessing: { mode: 'none' } }));
		expect(uncapped.lorebook.records.filter((r) => r.status === 'trimmed')).toHaveLength(0);
		expect(uncapped.messages[0].content.split('\n\n')).toHaveLength(8);

		const capped = assemblePrompt(
			input(p, {
				lorebooks: [fat],
				contextBudget: 4000,
				lorebookSettings: { ...DEFAULT_LOREBOOK_GLOBAL_SETTINGS, budgetPercent: 2 },
				postProcessing: { mode: 'none' }
			})
		);
		const kept = capped.messages[0].content.split('\n\n').filter(Boolean);
		expect(capped.lorebook.records.filter((r) => r.status === 'trimmed').length).toBeGreaterThan(0);
		expect(kept[0]).toContain('Paragraph 0');
		// Separators priced in, so the block cannot outgrow its allowance by its own glue.
		expect(countTokens(capped.messages[0].content, MODEL)).toBeLessThanOrEqual(Math.floor((4000 * 2) / 100));
	});

	test('one assembly resolves the lorebook once, however many times the tag appears', () => {
		// Selection happens at context build, not per resolve, so two occurrences of the tag
		// always print the same block. A Trigger % below 100 is the probe: resolved per tag,
		// the two would disagree about half the time, so the run is repeated. The literal
		// framing keeps both items producing a message even on the rounds the roll loses.
		const p = preset([
			item('<world>{{lorebook}}</world>', { id: 'a' }),
			item('<world>{{lorebook}}</world>', { id: 'b' })
		]);
		for (let round = 0; round < 25; round++) {
			const a = assemblePrompt(
				input(p, {
					lorebooks: [
						lorebook([{ comment: 'Coin', content: 'heads or tails', constant: true, probability: 50 }])
					],
					postProcessing: { mode: 'none' }
				})
			);
			expect(a.messages[0].content).toBe(a.messages[1].content);
		}
	});
});
