/**
 * What a chat runs on: the persona it plays as, the preset its prompt is built from, and the
 * connection that prompt is priced, shaped and sent in. Run with `bun test`.
 *
 * What is under test is the agreement: the composer's meter, the Prompt Builder breakdown,
 * the transcript and the send all resolve here, so one chat can only ever have one answer.
 * A second resolution anywhere is what lets a story be metered against a 32k window and sent
 * to a 200k model with nothing on screen saying so.
 *
 * Runes are compile-time macros and nothing compiles a store under `bun test`, so `$state`
 * is shimmed to identity BEFORE the modules load (dynamic imports below). Only `$state`:
 * a `$derived` appearing anywhere in this chain fails loudly rather than testing a stale
 * value.
 */
import { describe, expect, test, beforeEach, afterAll, mock } from 'bun:test';

import type { Chat } from '$lib/types/chat';
import type { PromptPreset } from '$lib/types/database';
import type { LibraryEntry } from '$lib/types/library';
import { DEFAULT_GENERATION_SETTINGS, type Connection } from '$lib/types/llm';

(globalThis as unknown as { $state: <T>(v?: T) => T | undefined }).$state = (v) => v;

/** The preset library this file resolves against, and which of it the app is on. */
const presets: Record<string, PromptPreset> = {};
let appPresetId: string | null = null;

/**
 * Bun's module registry is process-wide and one run loads every test file into it, so a stub
 * left behind here is served to every file that loads after this one. The real module is
 * captured and the restore registered BEFORE the stub goes in, so a throw in between cannot
 * leave one standing. Stubbed rather than seeded through the real service because the only
 * public door onto its library writes to the server.
 */
const realPresets = { ...(await import('$lib/services/presets.svelte')) };

afterAll(() => {
	mock.module('$lib/services/presets.svelte', () => realPresets);
});

mock.module('$lib/services/presets.svelte', () => ({
	...realPresets,
	presetService: {
		getEffective: (id: string) => presets[id] ?? null,
		getActiveEffectivePreset: () => (appPresetId ? presets[appPresetId] ?? null : null)
	}
}));

const { connectionStore } = await import('$lib/stores/connections.svelte');
const {
	chatConnectionId,
	chatPersonaClaim,
	chatPreset,
	chatPresetClaim,
	chatPresetId,
	presetForClaim,
	resolvePersonaId,
	resolvePromptTarget
} = await import('./chat-setup');

function connection(id: string, model: string, contextSize: number): Connection {
	return {
		id,
		name: id,
		provider: 'openrouter',
		model,
		contextSize,
		postProcessing: 'strict',
		promptPlaceholder: `[${id}]`,
		routing: null,
		samplingParams: [],
		reasoningDialect: 'none',
		generation: { ...DEFAULT_GENERATION_SETTINGS }
	};
}

function persona(id: string): LibraryEntry {
	return {
		id,
		type: 'persona',
		identity: { name: id },
		data: { traits: {} },
		isFavorite: false,
		createdAt: 0,
		updatedAt: 0
	} as LibraryEntry;
}

function chat(
	claimed: string | null,
	claimedPersona: string | null = null,
	claimedPreset: string | null = null
): Chat {
	return {
		id: 'chat-1',
		title: 'A story',
		createdAt: 0,
		updatedAt: 0,
		rootMessageId: null,
		activeLeafId: null,
		canonLeafId: null,
		settings: null,
		characterId: 'char-1',
		characterVersionId: null,
		isFavorite: false,
		featureState: JSON.stringify({
			connection: claimed,
			persona: claimedPersona,
			preset: claimedPreset
		})
	};
}

const APP = connection('app', 'openai/app-model', 32_000);
const OWN = connection('own', 'anthropic/own-model', 200_000);

beforeEach(() => {
	connectionStore.connections = [APP, OWN];
	connectionStore.assignments = { primary: APP.id, assistant: APP.id };
});

describe('chatConnectionId', () => {
	test('no chat and no claim both read as following the app', () => {
		expect(chatConnectionId(null)).toBeNull();
		expect(chatConnectionId(chat(null))).toBeNull();
	});

	test('a live claim resolves to the connection the chat named', () => {
		expect(chatConnectionId(chat(OWN.id))).toBe(OWN.id);
	});

	test('a claim naming a deleted connection reads as no claim', () => {
		// Never a throw and never a sweep: the story keeps sending, on the app's connection,
		// and the stored id stays put so restoring the connection restores the claim.
		connectionStore.connections = [APP];
		expect(chatConnectionId(chat(OWN.id))).toBeNull();
	});
});

describe('resolvePromptTarget', () => {
	test('an unclaimed chat is assembled in the routed connection terms', () => {
		const resolved = resolvePromptTarget(chat(null));
		expect(resolved.target).toBe('primary');
		expect(resolved.model).toBe(APP.model);
		expect(resolved.postProcessing.placeholder).toBe(APP.promptPlaceholder);
	});

	test('a claimed chat carries its own model and its own budget together', () => {
		const own = resolvePromptTarget(chat(OWN.id));
		const app = resolvePromptTarget(chat(null));
		expect(own.target).toEqual({ connection: OWN.id });
		expect(own.model).toBe(OWN.model);
		expect(own.postProcessing.placeholder).toBe(OWN.promptPlaceholder);
		// The pair that has to move together: a budget counted against one context window
		// while the model is another connection's is the whole failure this prevents.
		expect(own.contextBudget).toBeGreaterThan(app.contextBudget);
	});

	test('two surfaces asking about one chat get the same answer', () => {
		expect(resolvePromptTarget(chat(OWN.id))).toEqual(resolvePromptTarget(chat(OWN.id)));
	});

	test('a dangling claim is assembled in the app terms, not left broken', () => {
		connectionStore.connections = [APP];
		const resolved = resolvePromptTarget(chat(OWN.id));
		expect(resolved.target).toBe('primary');
		expect(resolved.model).toBe(APP.model);
	});

	test('only the story can be claimed: an engine target ignores the chat', () => {
		const resolved = resolvePromptTarget(chat(OWN.id), { engine: 'opening-scene' });
		expect(resolved.target).toEqual({ engine: 'opening-scene' });
	});
});

describe('the preset a chat is built from', () => {
	const APP_PRESET = 'app-preset';
	const OWN_PRESET = 'own-preset';

	beforeEach(() => {
		for (const key of Object.keys(presets)) delete presets[key];
		for (const id of [APP_PRESET, OWN_PRESET]) {
			presets[id] = { id, name: id, items: [], controls: [] };
		}
		appPresetId = APP_PRESET;
	});

	test('a chat that claimed nothing is built from the app preset', () => {
		expect(chatPreset(null)?.id).toBe(APP_PRESET);
		expect(chatPreset(chat(null))?.id).toBe(APP_PRESET);
		expect(chatPresetId(chat(null))).toBeNull();
	});

	test('a live claim outranks the app preset', () => {
		const claimed = chat(null, null, OWN_PRESET);
		expect(chatPresetClaim(claimed)).toBe(OWN_PRESET);
		expect(chatPresetId(claimed)).toBe(OWN_PRESET);
		expect(chatPreset(claimed)?.id).toBe(OWN_PRESET);
	});

	test('a claim naming a deleted preset is built from the app one, and the id stays put', () => {
		// Never a throw and never a sweep, exactly like a dead connection claim: the story keeps
		// generating, and re-importing the preset restores the claim rather than losing it.
		delete presets[OWN_PRESET];
		const claimed = chat(null, null, OWN_PRESET);
		expect(chatPresetId(claimed)).toBeNull();
		expect(chatPreset(claimed)?.id).toBe(APP_PRESET);
		expect(chatPresetClaim(claimed)).toBe(OWN_PRESET);
	});

	test('the claim-sourced and chat-sourced resolvers give one answer', () => {
		// The memory store holds only the id and everything else holds the chat. Two answers
		// here and a chat extracts memory against a preset it never sends.
		for (const claim of [null, OWN_PRESET, 'gone']) {
			expect(presetForClaim(claim)?.id).toBe(chatPreset(chat(null, null, claim))?.id);
		}
	});

	test('with no preset anywhere, a chat is built from none rather than throwing', () => {
		for (const key of Object.keys(presets)) delete presets[key];
		appPresetId = null;
		expect(chatPreset(chat(null, null, OWN_PRESET))).toBeNull();
	});
});

describe('the three claims are resolved apart', () => {
	// One chat holds all three in one blob and each names a different library. A resolution
	// that folded them together (one liveness check, one fallback) would read plausibly and be
	// wrong in the only case that matters: the reader deletes a preset and the story silently
	// stops playing as its own persona too.
	test('a dead claim in one category leaves the live ones in the other two alone', () => {
		presets['house'] = { id: 'house', name: 'house', items: [], controls: [] };
		appPresetId = 'house';
		const claimed = chat(OWN.id, 'own-persona', 'gone-preset');

		expect(chatPresetId(claimed)).toBeNull();
		expect(chatConnectionId(claimed)).toBe(OWN.id);
		expect(chatPersonaClaim(claimed)).toBe('own-persona');

		connectionStore.connections = [APP];
		expect(chatConnectionId(claimed)).toBeNull();
		expect(chatPersonaClaim(claimed)).toBe('own-persona');
		expect(chatPresetClaim(claimed)).toBe('gone-preset');
	});
});

describe('resolvePersonaId', () => {
	const APP_PERSONA = 'app-persona';
	const OWN_PERSONA = 'own-persona';
	const LIBRARY = [persona(APP_PERSONA), persona(OWN_PERSONA)];

	test('a chat that claimed nobody plays as the app persona', () => {
		expect(resolvePersonaId(chatPersonaClaim(chat(null)), LIBRARY, APP_PERSONA)).toBe(APP_PERSONA);
		expect(resolvePersonaId(null, LIBRARY, APP_PERSONA)).toBe(APP_PERSONA);
	});

	test('a live claim outranks the app persona', () => {
		const claim = chatPersonaClaim(chat(null, OWN_PERSONA));
		expect(claim).toBe(OWN_PERSONA);
		expect(resolvePersonaId(claim, LIBRARY, APP_PERSONA)).toBe(OWN_PERSONA);
	});

	test('a claim naming a deleted persona falls back to the app persona', () => {
		expect(resolvePersonaId('gone', LIBRARY, APP_PERSONA)).toBe(APP_PERSONA);
	});

	test('an id belonging to a character is not a persona claim', () => {
		// The store holds both kinds in one list, so the type check is the whole guard.
		const characters = [{ ...persona(OWN_PERSONA), type: 'character' } as LibraryEntry];
		expect(resolvePersonaId(OWN_PERSONA, characters, APP_PERSONA)).toBe(APP_PERSONA);
	});

	test('with no app persona either, a dead claim resolves to nobody', () => {
		expect(resolvePersonaId('gone', LIBRARY, null)).toBeNull();
	});
});
