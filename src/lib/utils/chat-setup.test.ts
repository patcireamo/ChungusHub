/**
 * What a chat runs on: the persona it plays as, and the connection its prompt is priced,
 * shaped and sent in. Run with `bun test`.
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
import { describe, expect, test, beforeEach } from 'bun:test';

import type { Chat } from '$lib/types/chat';
import type { LibraryEntry } from '$lib/types/library';
import { DEFAULT_GENERATION_SETTINGS, type Connection } from '$lib/types/llm';

(globalThis as unknown as { $state: <T>(v?: T) => T | undefined }).$state = (v) => v;

const { connectionStore } = await import('$lib/stores/connections.svelte');
const { chatConnectionId, chatPersonaClaim, resolvePersonaId, resolvePromptTarget } =
	await import('./chat-setup');

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

function chat(claimed: string | null, claimedPersona: string | null = null): Chat {
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
		featureState: JSON.stringify({ connection: claimed, persona: claimedPersona })
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
