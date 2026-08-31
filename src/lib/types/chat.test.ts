/**
 * Tests for the chat feature-state normalizer (the steering reuse history +
 * impersonate). Run with `bun test`. Pure logic only (no store, no Svelte runtime)
 * since both the chatStore reactive path and the (db-sourced) generation path call this
 * same function and must agree on what a corrupt or missing value degrades to.
 * The steering notes themselves live in their own table; see steering.test.ts.
 */

import { describe, expect, test } from 'bun:test';

import { effectSetting } from './ambient';
import {
	DEFAULT_CHAT_FEATURE_STATE,
	normalizeChatFeatureState,
	pushSteeringHistoryEntry,
	withLorebookClaim
} from './chat';

describe('normalizeChatFeatureState: degrading to defaults', () => {
	test('null degrades to the defaults', () => {
		expect(normalizeChatFeatureState(null)).toEqual(DEFAULT_CHAT_FEATURE_STATE);
	});

	test('undefined degrades to the defaults', () => {
		expect(normalizeChatFeatureState(undefined)).toEqual(DEFAULT_CHAT_FEATURE_STATE);
	});

	test('malformed JSON string degrades to the defaults', () => {
		expect(normalizeChatFeatureState('{not json')).toEqual(DEFAULT_CHAT_FEATURE_STATE);
	});

	test('a non-object value (e.g. a bare number) degrades to the defaults', () => {
		expect(normalizeChatFeatureState(42)).toEqual(DEFAULT_CHAT_FEATURE_STATE);
	});

	test('an empty object degrades every field to its default', () => {
		expect(normalizeChatFeatureState({})).toEqual(DEFAULT_CHAT_FEATURE_STATE);
	});
});

describe('normalizeChatFeatureState: the JSON column value', () => {
	test('parses a JSON string (the normal wire shape)', () => {
		const raw = JSON.stringify({
			steeringHistory: ['earlier note'],
			impersonatePerspective: 'third'
		});
		expect(normalizeChatFeatureState(raw)).toEqual({
			steeringHistory: ['earlier note'],
			impersonatePerspective: 'third',
			scene: null,
			connection: null,
			persona: null,
			preset: null,
			lorebooks: [],
			mutedLorebooks: []
		});
	});

	test('accepts an already-parsed object directly', () => {
		const value = {
			steeringHistory: ['x'],
			impersonatePerspective: 'second' as const,
			scene: null,
			connection: null,
			persona: null,
			preset: null,
			lorebooks: [],
			mutedLorebooks: []
		};
		expect(normalizeChatFeatureState(value)).toEqual(value);
	});

	test('a legacy blob\'s `steering` object is ignored, not carried', () => {
		// Steering notes are their own rows (types/steering.ts). A blob still carrying the
		// single-steering key must simply stop being parsed: nothing migrates it, and it
		// drops on that chat's next feature-state write.
		const result = normalizeChatFeatureState({
			steering: { text: 'be terse', mode: 'pinned', depth: 3, role: 'system' },
			steeringHistory: ['earlier note'],
			impersonatePerspective: 'third'
		});
		expect(result).toEqual({
			steeringHistory: ['earlier note'],
			impersonatePerspective: 'third',
			scene: null,
			connection: null,
			persona: null,
			preset: null,
			lorebooks: [],
			mutedLorebooks: []
		});
		expect('steering' in result).toBe(false);
	});
});

describe('normalizeChatFeatureState: scene', () => {
	test('a chat that has never had one reads as null', () => {
		expect(normalizeChatFeatureState({}).scene).toBeNull();
		expect(normalizeChatFeatureState({ scene: null }).scene).toBeNull();
		expect(normalizeChatFeatureState({ scene: 'winter' }).scene).toBeNull();
	});

	test('a stored scene comes back through both config normalizers', () => {
		const scene = normalizeChatFeatureState({
			scene: {
				enabled: true,
				background: { path: 'backgrounds/snow.jpg', dim: 5, blur: -2 },
				ambient: { types: ['snow', 'nonsense'], effectSettings: { snow: { density: 99 } } }
			}
		}).scene;
		expect(scene?.enabled).toBe(true);
		// Clamped, not trusted: the blob is the same data any device may have written.
		expect(scene?.background).toEqual({ path: 'backgrounds/snow.jpg', dim: 0.9, blur: 0 });
		expect(scene?.ambient.types).toEqual(['snow']);
		expect(effectSetting(scene!.ambient, 'snow', 'density')).toBe(2);
	});

	test('a scene survives the trip through the column it is stored in', () => {
		// The wire shape is a JSON string on chats.feature_state, and the server never
		// parses it, so what comes back has to be exactly what went in: a field JSON
		// drops on the way out is a chat that quietly loses half its scene.
		const state = normalizeChatFeatureState({
			steeringHistory: ['a note'],
			impersonatePerspective: 'second',
			scene: {
				enabled: true,
				background: { path: 'images/backgrounds/dusk.png', dim: 0.5, blur: 6 },
				ambient: {
					types: ['rain', 'fog'],
					enabled: true,
					effectSettings: { rain: { density: 1.25, splashes: 0 }, fog: { overMessages: 0 } }
				}
			}
		});
		expect(normalizeChatFeatureState(JSON.stringify(state))).toEqual(state);
	});

	test('a scene missing its enabled flag is kept but not in force', () => {
		// Anything but an explicit true: a chat must never end up wearing a scene
		// because a half-written blob was read generously.
		const scene = normalizeChatFeatureState({ scene: { background: {}, ambient: {} } }).scene;
		expect(scene?.enabled).toBe(false);
	});
});

describe('normalizeChatFeatureState: connection', () => {
	test('a chat that has claimed nothing reads as null', () => {
		// The whole reason this needs no migration: every blob written before a chat could
		// claim a connection simply has no key, and a missing key is "follow the app".
		expect(normalizeChatFeatureState({}).connection).toBeNull();
		expect(normalizeChatFeatureState('{"steeringHistory":[]}').connection).toBeNull();
	});

	test('a claimed id survives the trip through the column it is stored in', () => {
		const state = normalizeChatFeatureState({ connection: 'conn-1' });
		expect(state.connection).toBe('conn-1');
		expect(normalizeChatFeatureState(JSON.stringify(state))).toEqual(state);
	});

	test('anything that is not a non-empty string is no claim at all', () => {
		expect(normalizeChatFeatureState({ connection: '' }).connection).toBeNull();
		expect(normalizeChatFeatureState({ connection: 7 }).connection).toBeNull();
		expect(normalizeChatFeatureState({ connection: { id: 'conn-1' } }).connection).toBeNull();
	});
});

describe('normalizeChatFeatureState: persona', () => {
	test('a chat that has claimed nobody reads as null', () => {
		expect(normalizeChatFeatureState({}).persona).toBeNull();
		expect(normalizeChatFeatureState({ connection: 'conn-1' }).persona).toBeNull();
	});

	test('a claimed persona survives the trip through the column it is stored in', () => {
		const state = normalizeChatFeatureState({ persona: 'persona-1', connection: 'conn-1' });
		expect(state.persona).toBe('persona-1');
		expect(normalizeChatFeatureState(JSON.stringify(state))).toEqual(state);
	});

	test('anything that is not a non-empty string is no claim at all', () => {
		expect(normalizeChatFeatureState({ persona: '' }).persona).toBeNull();
		expect(normalizeChatFeatureState({ persona: false }).persona).toBeNull();
	});
});

describe('normalizeChatFeatureState: lorebooks', () => {
	// The same reason the claims above need no migration: a blob written before a chat could
	// attach books has no key, and an absent list is a chat that adds nothing of its own.
	test('a chat that has attached nothing reads as an empty list', () => {
		expect(normalizeChatFeatureState({}).lorebooks).toEqual([]);
		expect(normalizeChatFeatureState({ lorebooks: null }).lorebooks).toEqual([]);
		expect(normalizeChatFeatureState('{"steeringHistory":[]}').lorebooks).toEqual([]);
	});

	test('attached books survive the trip through the column they are stored in', () => {
		const state = normalizeChatFeatureState({ lorebooks: ['book-1', 'book-2'] });
		expect(state.lorebooks).toEqual(['book-1', 'book-2']);
		expect(normalizeChatFeatureState(JSON.stringify(state))).toEqual(state);
	});

	test('drops entries that are not non-empty strings, and keeps the order of the rest', () => {
		expect(normalizeChatFeatureState({ lorebooks: ['a', '', 7, null, 'b'] }).lorebooks).toEqual([
			'a',
			'b'
		]);
		expect(normalizeChatFeatureState({ lorebooks: 'book-1' }).lorebooks).toEqual([]);
	});

	// The other half of the claim, read the same way and needing a migration just as little:
	// a blob written before a chat could mute anything has no key, and no key is no mute.
	test('a chat that has muted nothing reads as an empty list', () => {
		expect(normalizeChatFeatureState({}).mutedLorebooks).toEqual([]);
		expect(normalizeChatFeatureState({ mutedLorebooks: 'book-1' }).mutedLorebooks).toEqual([]);
	});

	test('mutes survive the trip through the column they are stored in', () => {
		const state = normalizeChatFeatureState({ lorebooks: ['a'], mutedLorebooks: ['b', 'c'] });
		expect(state.mutedLorebooks).toEqual(['b', 'c']);
		expect(normalizeChatFeatureState(JSON.stringify(state))).toEqual(state);
	});
});

describe('withLorebookClaim', () => {
	const state = (lorebooks: string[], mutedLorebooks: string[] = []) =>
		normalizeChatFeatureState({ lorebooks, mutedLorebooks });

	test('attaching appends without duplicating what is already there', () => {
		expect(withLorebookClaim(state(['a']), 'b', true).lorebooks).toEqual(['a', 'b']);
		expect(withLorebookClaim(state(['a']), 'a', true).lorebooks).toEqual(['a']);
	});

	test('detaching takes it off and leaves the rest in order', () => {
		expect(withLorebookClaim(state(['a', 'b', 'c']), 'b', false).lorebooks).toEqual(['a', 'c']);
	});

	// The two lists answer one question from opposite ends. A book sitting in both would read on
	// screen as attached while the resolver, which subtracts last, kept it out of every prompt.
	test('attaching a muted book clears the mute', () => {
		const next = withLorebookClaim(state([], ['a']), 'a', true);
		expect(next.lorebooks).toEqual(['a']);
		expect(next.mutedLorebooks).toEqual([]);
	});

	test('detaching leaves the mutes alone', () => {
		expect(withLorebookClaim(state(['a'], ['b']), 'a', false).mutedLorebooks).toEqual(['b']);
	});
});

describe('normalizeChatFeatureState: steeringHistory', () => {
	test('drops non-string and empty-string entries', () => {
		const result = normalizeChatFeatureState({
			steeringHistory: ['keep me', '', 7, null, 'also keep']
		});
		expect(result.steeringHistory).toEqual(['keep me', 'also keep']);
	});

	test('caps at 10 entries', () => {
		const history = Array.from({ length: 15 }, (_, i) => `entry ${i}`);
		const result = normalizeChatFeatureState({ steeringHistory: history });
		expect(result.steeringHistory).toHaveLength(10);
		expect(result.steeringHistory).toEqual(history.slice(0, 10));
	});

	test('a non-array value degrades to an empty history', () => {
		const result = normalizeChatFeatureState({ steeringHistory: 'not an array' });
		expect(result.steeringHistory).toEqual([]);
	});
});

describe('normalizeChatFeatureState: impersonatePerspective', () => {
	test('passes through a valid perspective', () => {
		expect(normalizeChatFeatureState({ impersonatePerspective: 'second' }).impersonatePerspective).toBe('second');
	});

	test('an invalid perspective whitelists down to first', () => {
		expect(normalizeChatFeatureState({ impersonatePerspective: 'omniscient' }).impersonatePerspective).toBe(
			'first'
		);
	});
});

describe('pushSteeringHistoryEntry', () => {
	test('pushes onto an empty history', () => {
		expect(pushSteeringHistoryEntry([], 'first note')).toEqual(['first note']);
	});

	test('adds a new entry to the front, keeping older ones behind it', () => {
		expect(pushSteeringHistoryEntry(['older'], 'newer')).toEqual(['newer', 'older']);
	});

	test('an exact duplicate moves to the front instead of duplicating', () => {
		expect(pushSteeringHistoryEntry(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
	});

	test('caps the result at 10 entries', () => {
		const history = Array.from({ length: 10 }, (_, i) => `entry ${i}`);
		const result = pushSteeringHistoryEntry(history, 'new entry');
		expect(result).toHaveLength(10);
		expect(result[0]).toBe('new entry');
		expect(result[result.length - 1]).toBe('entry 8');
	});
});
