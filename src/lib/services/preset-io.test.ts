import { describe, expect, test } from 'bun:test';
import { parsePresetJson, serializePresetJson } from './preset-io';
import { DEFAULT_EXAMPLE_SEPARATOR } from '$lib/macros';
import { DEFAULT_CONTINUE_PROMPT } from '$lib/utils/prompt-assembly';

const bare = (over: Record<string, unknown> = {}) => ({
	id: 'p',
	name: 'P',
	items: [],
	controls: [],
	...over
});

describe('preset JSON interchange', () => {
	test('round-trips controls and preset-level behavior without runtime item ids', () => {
		const json = serializePresetJson({
			id: 'source',
			name: 'Focused prose',
			items: [{ id: 'runtime-only', name: 'System', role: 'system', content: '{{tone}}', enabled: true }],
			controls: [
				{
					id: 'tone-control',
					macro: 'tone',
					label: 'Tone',
					type: 'select',
					options: [{ id: 'warm', label: 'Warm', injectedText: 'Write warmly.' }],
					defaultOptionId: 'warm'
				}
			],
			pruneEmptyBlocks: true
		});

		expect(json).not.toContain('runtime-only');
		const imported = parsePresetJson(json);
		expect(imported.name).toBe('Focused prose');
		expect(imported.items[0]?.content).toBe('{{tone}}');
		expect(imported.controls[0]?.options?.[0]?.injectedText).toBe('Write warmly.');
		expect(imported.pruneEmptyBlocks).toBe(true);
	});

	test('an export names every per-preset field, defaults included', () => {
		// The bug this guards: a preset riding the shipped defaults exported JSON with no
		// continuePrompt / exampleSeparator key at all, so the fields read as ones the
		// preset does not own, and nobody could learn they exist from the JSON.
		const parsed = JSON.parse(serializePresetJson(bare()));
		expect(parsed.continuePrompt).toBe(DEFAULT_CONTINUE_PROMPT);
		expect(parsed.exampleSeparator).toBe(DEFAULT_EXAMPLE_SEPARATOR);
		expect(parsed.pruneEmptyBlocks).toBe(false);
	});

	test('overridden values export verbatim, empty string included', () => {
		const parsed = JSON.parse(serializePresetJson(bare({ continuePrompt: '', exampleSeparator: '' })));
		expect(parsed.continuePrompt).toBe('');
		expect(parsed.exampleSeparator).toBe('');
		// Empty is a real choice (no instruction / no header line), so it must survive import.
		const imported = parsePresetJson(JSON.stringify(parsed));
		expect(imported.continuePrompt).toBe('');
		expect(imported.exampleSeparator).toBe('');
	});

	test('importing a shipped default stores no override, so the preset keeps tracking it', () => {
		const imported = parsePresetJson(serializePresetJson(bare()));
		expect(imported.continuePrompt).toBeUndefined();
		expect(imported.exampleSeparator).toBeUndefined();
	});

	test('a real continue override survives the round trip', () => {
		const imported = parsePresetJson(serializePresetJson(bare({ continuePrompt: 'Keep going, {{char}}.' })));
		expect(imported.continuePrompt).toBe('Keep going, {{char}}.');
	});

	test('rejects unknown roles instead of silently changing prompt semantics', () => {
		expect(() =>
			parsePresetJson(JSON.stringify({ name: 'Bad', items: [{ role: 'developer', content: 'x' }] }))
		).toThrow('unknown role');
	});

	test('names a SillyTavern preset in the refusal rather than reporting a broken file', () => {
		// The one wrong file people bring here on purpose. A parse error about "items" sends
		// them looking for a fault in a file that has none.
		expect(() => parsePresetJson(JSON.stringify({ name: 'ST', prompts: [], prompt_order: [] }))).toThrow(
			'SillyTavern preset'
		);
		expect(() => parsePresetJson(JSON.stringify({ name: 'Junk' }))).toThrow('not a ChungusHub preset');
	});
});
