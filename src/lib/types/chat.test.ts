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
	chatDefersToCharacter,
	DEFAULT_CHAT_FEATURE_STATE,
	normalizeChatFeatureState,
	pushSteeringHistoryEntry
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
			persona: null
		});
	});

	test('accepts an already-parsed object directly', () => {
		const value = {
			steeringHistory: ['x'],
			impersonatePerspective: 'second' as const,
			scene: null,
			persona: null
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
			persona: null
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

describe('normalizeChatFeatureState: persona', () => {
	const read = (raw: unknown) => normalizeChatFeatureState({ persona: raw }).persona;

	test('a chat that has decided nothing reads as null', () => {
		expect(normalizeChatFeatureState({}).persona).toBeNull();
		expect(read(null)).toBeNull();
	});

	test('a chat can say it follows the app, which is NOT the same as saying nothing', () => {
		// The state the whole shape exists for: it has to survive the column, because the
		// difference between it and null is whether the character's default reaches this chat.
		expect(read({ follows: 'app' })).toEqual({ follows: 'app' });
	});

	test('a chat can name a persona', () => {
		expect(read({ follows: 'persona', id: 'persona-mai' })).toEqual({
			follows: 'persona',
			id: 'persona-mai'
		});
	});

	test('the id-only shape this field shipped with still reads as the pin it was', () => {
		// Written by the build before "follows the app" existed. A chat given a persona then
		// must not lose it, and there is no migration to do that: the column is opaque.
		expect(read('persona-mai')).toEqual({ follows: 'persona', id: 'persona-mai' });
		expect(read('')).toBeNull();
	});

	test('anything else is no decision at all', () => {
		// The blob is the same data any device may have written, so a decision is only ever
		// accepted in a shape that can actually be acted on.
		expect(read(7)).toBeNull();
		expect(read(['persona-mai'])).toBeNull();
		expect(read({})).toBeNull();
		expect(read({ follows: 'nonsense' })).toBeNull();
		expect(read({ follows: 'persona' })).toBeNull();
		expect(read({ follows: 'persona', id: '' })).toBeNull();
		expect(read({ follows: 'persona', id: 42 })).toBeNull();
	});

	test('an id is kept verbatim, whether or not it still names a persona', () => {
		// Deliberate: this file is pure and store-free, so it cannot ask the library whether
		// the id resolves. A dangling pin falls one layer down at RESOLVE time
		// (stores/chatPersona.svelte.ts) rather than being scrubbed on read, which is what
		// keeps a persona deleted on one device from silently rewriting chats on another.
		expect(read({ follows: 'persona', id: 'deleted-long-ago' })).toEqual({
			follows: 'persona',
			id: 'deleted-long-ago'
		});
	});

	test('a decision survives the trip through the column it is stored in', () => {
		for (const decision of [{ follows: 'app' }, { follows: 'persona', id: 'persona-mai' }]) {
			const state = normalizeChatFeatureState({
				steeringHistory: ['a note'],
				impersonatePerspective: 'second',
				persona: decision
			});
			expect(normalizeChatFeatureState(JSON.stringify(state))).toEqual(state);
			expect(normalizeChatFeatureState(JSON.stringify(state)).persona).toEqual(decision);
		}
	});

	test('a blob written before this field existed reads as no decision, not as corrupt', () => {
		// Every chat row already on disk carries a blob with no persona key at all, and each
		// has to come back as "inherits" rather than degrading the whole feature state.
		const legacy = JSON.stringify({ steeringHistory: ['kept'], impersonatePerspective: 'third' });
		const state = normalizeChatFeatureState(legacy);
		expect(state.persona).toBeNull();
		expect(state.steeringHistory).toEqual(['kept']);
		expect(state.impersonatePerspective).toBe('third');
	});
});

describe('chatDefersToCharacter', () => {
	// The predicate the Overrides page counts with. It has to give the same answer resolution
	// does, or the "how many other chats does this reach" line is a confident wrong number.
	const live = (id: string) => id === 'persona-alive';

	test('a chat that has decided nothing reads the character default', () => {
		expect(chatDefersToCharacter(null, live)).toBe(true);
	});

	test('a chat explicitly on the app does not', () => {
		// This is the case the three-state shape was added for: without it, this chat would be
		// indistinguishable from one that had never chosen, and a manual persona switch in one
		// chat would have to strip the default off the card to take effect here.
		expect(chatDefersToCharacter({ follows: 'app' }, live)).toBe(false);
	});

	test('a chat pinned to a live persona does not', () => {
		expect(chatDefersToCharacter({ follows: 'persona', id: 'persona-alive' }, live)).toBe(false);
	});

	test('a chat pinned to a DELETED persona does, because that pin falls through', () => {
		expect(chatDefersToCharacter({ follows: 'persona', id: 'persona-gone' }, live)).toBe(true);
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
