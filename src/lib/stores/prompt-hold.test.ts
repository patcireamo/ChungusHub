/**
 * The prompt hold gate: what a disarmed gate costs, what an armed one parks, and what the
 * two answers do to the caller. Run with `bun test`.
 *
 * Runes are compile-time macros and nothing compiles the store under bun test, so `$state`
 * is shimmed to identity BEFORE the store module loads (dynamic import below), exactly as
 * `new-chat-flow.test.ts` does. Only `$state` is shimmed on purpose: the store deliberately
 * uses a getter rather than `$derived`, so growing one would fail here loudly.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';

(globalThis as unknown as { $state: <T>(v?: T) => T | undefined }).$state = (v) => v;

// Arming a gate persists it over the settings spine, which is a real HTTP call. Answer it
// here rather than let every switch flip log a failed request: what is under test is which
// gate is armed, not that the write left the browser. Restored after, since bun runs the
// suite's files in one process.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
	new Response('{"result":null}', {
		status: 200,
		headers: { 'content-type': 'application/json' }
	})) as typeof globalThis.fetch;
afterAll(() => {
	globalThis.fetch = realFetch;
});

const { promptHoldStore } = await import('./promptHold.svelte');
const { HOLD_GATES } = await import('$lib/config/prompt-hold');

const MESSAGES = [
	{ role: 'system' as const, content: 'You are a narrator.' },
	{ role: 'user' as const, content: 'Hello' }
];

beforeEach(() => {
	promptHoldStore.cancel();
	for (const gate of HOLD_GATES) promptHoldStore.setGate(gate.id, false);
});

describe('a disarmed gate', () => {
	test('hands the request straight back, unparked', async () => {
		const sent = await promptHoldStore.review('send', MESSAGES, 'primary');
		expect(sent).toBe(MESSAGES);
		expect(promptHoldStore.pending).toBe(null);
		expect(promptHoldStore.holding).toBe(false);
	});

	test('is decided per gate, not app-wide', async () => {
		promptHoldStore.setGate('continue', true);
		expect(await promptHoldStore.review('send', MESSAGES, 'primary')).toBe(MESSAGES);
		expect(promptHoldStore.holding).toBe(false);
	});
});

describe('an armed gate', () => {
	beforeEach(() => promptHoldStore.setGate('send', true));

	test('parks the request with the gate it came from and the target that serves it', async () => {
		const pending = promptHoldStore.review('send', MESSAGES, 'primary');
		expect(promptHoldStore.holding).toBe(true);
		expect(promptHoldStore.pending?.gate.id).toBe('send');
		expect(promptHoldStore.pending?.target).toBe('primary');
		expect(promptHoldStore.pending?.messages).toBe(MESSAGES);
		promptHoldStore.cancel();
		await pending;
	});

	test('sends exactly what was approved, edits and all', async () => {
		const pending = promptHoldStore.review('send', MESSAGES, 'primary');
		const edited = [{ role: 'user' as const, content: 'edited' }];
		promptHoldStore.approve(edited);
		expect(await pending).toBe(edited);
		expect(promptHoldStore.pending).toBe(null);
	});

	// Null is the caller's instruction to leave the chat exactly as it was: nothing inserted,
	// nothing deleted, no stream opened.
	test('resolves to null when cancelled', async () => {
		const pending = promptHoldStore.review('send', MESSAGES, 'primary');
		promptHoldStore.cancel();
		expect(await pending).toBe(null);
		expect(promptHoldStore.holding).toBe(false);
	});

	test('refuses a second request rather than stranding the first', async () => {
		const pending = promptHoldStore.review('send', MESSAGES, 'primary');
		await expect(promptHoldStore.review('send', MESSAGES, 'primary')).rejects.toThrow(
			'already waiting for review'
		);
		promptHoldStore.cancel();
		expect(await pending).toBe(null);
	});

	test('a cancel with nothing parked is inert', () => {
		expect(() => promptHoldStore.cancel()).not.toThrow();
		expect(promptHoldStore.holding).toBe(false);
	});
});
