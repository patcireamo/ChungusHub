/**
 * Tests for the steering-note model. Run with `bun test`. Pure logic only (no store,
 * no Svelte runtime) because the generation path (db rows) and the chat meter
 * (reactive store) resolve through these very functions and must agree exactly; a
 * divergence here is a meter that prices something the send doesn't inject.
 */

import { describe, expect, test } from 'bun:test';

import {
	activeSteeringNotes,
	clampSteeringDepth,
	createSteeringNote,
	noteApplies,
	noteLabel,
	resolvePlacement,
	resolveSteeringForPrompt,
	sortSteeringNotes,
	steeringScanText,
	type SteeringDefaults,
	type SteeringNote,
	type SteeringScope,
	type SteeringTarget
} from './steering';

const DEFAULTS: SteeringDefaults = { depth: 0, role: 'system' };

const TARGET: SteeringTarget = {
	chatId: 'chat-1',
	characterId: 'char-1',
	characterVersionId: 'ver-2'
};

/** A note with everything explicit, so a test only states what it's about. */
function note(over: Partial<SteeringNote> = {}): SteeringNote {
	return {
		id: over.id ?? crypto.randomUUID(),
		title: over.title ?? '',
		text: over.text ?? 'guidance',
		scope: over.scope ?? 'global',
		scopeId: over.scopeId ?? null,
		enabled: over.enabled ?? true,
		mode: over.mode ?? 'pinned',
		depth: over.depth ?? null,
		role: over.role ?? null,
		createdAt: over.createdAt ?? 1000,
		updatedAt: over.updatedAt ?? 1000
	};
}

describe('noteApplies: the scope ladder', () => {
	test('a global note applies to any target', () => {
		expect(noteApplies(note({ scope: 'global' }), TARGET)).toBe(true);
		expect(
			noteApplies(note({ scope: 'global' }), { chatId: null, characterId: null, characterVersionId: null })
		).toBe(true);
	});

	test('a character note applies only to its own character', () => {
		expect(noteApplies(note({ scope: 'character', scopeId: 'char-1' }), TARGET)).toBe(true);
		expect(noteApplies(note({ scope: 'character', scopeId: 'char-9' }), TARGET)).toBe(false);
	});

	test('a version note applies only while the chat is pinned to that version', () => {
		expect(noteApplies(note({ scope: 'version', scopeId: 'ver-2' }), TARGET)).toBe(true);
		expect(noteApplies(note({ scope: 'version', scopeId: 'ver-1' }), TARGET)).toBe(false);
	});

	test('a version note is inert for an unversioned chat', () => {
		expect(noteApplies(note({ scope: 'version', scopeId: 'ver-2' }), { ...TARGET, characterVersionId: null })).toBe(
			false
		);
	});

	test('a chat note applies only to its own chat', () => {
		expect(noteApplies(note({ scope: 'chat', scopeId: 'chat-1' }), TARGET)).toBe(true);
		expect(noteApplies(note({ scope: 'chat', scopeId: 'chat-2' }), TARGET)).toBe(false);
	});

	test('a null scopeId never matches a bound scope: it is not a wildcard', () => {
		for (const scope of ['character', 'version', 'chat'] as SteeringScope[]) {
			expect(noteApplies(note({ scope, scopeId: null }), TARGET)).toBe(false);
		}
	});

	test('a dangling scopeId is inert rather than an error', () => {
		expect(noteApplies(note({ scope: 'character', scopeId: 'deleted-character' }), TARGET)).toBe(false);
	});
});

describe('sortSteeringNotes: injection order', () => {
	test('orders scopes broad to narrow so the most specific guidance lands last', () => {
		const notes = [
			note({ scope: 'chat', scopeId: 'chat-1', text: 'd' }),
			note({ scope: 'version', scopeId: 'ver-2', text: 'c' }),
			note({ scope: 'global', text: 'a' }),
			note({ scope: 'character', scopeId: 'char-1', text: 'b' })
		];
		expect(sortSteeringNotes(notes).map((n) => n.text)).toEqual(['a', 'b', 'c', 'd']);
	});

	test('within one scope, oldest first', () => {
		const notes = [
			note({ scope: 'global', text: 'later', createdAt: 3000 }),
			note({ scope: 'global', text: 'earlier', createdAt: 1000 })
		];
		expect(sortSteeringNotes(notes).map((n) => n.text)).toEqual(['earlier', 'later']);
	});

	test('does not mutate its input', () => {
		const notes = [note({ scope: 'chat', scopeId: 'chat-1' }), note({ scope: 'global' })];
		const before = [...notes];
		sortSteeringNotes(notes);
		expect(notes).toEqual(before);
	});
});

describe('activeSteeringNotes: what actually injects', () => {
	test('drops disabled notes', () => {
		const notes = [note({ text: 'on' }), note({ text: 'off', enabled: false })];
		expect(activeSteeringNotes(notes, TARGET).map((n) => n.text)).toEqual(['on']);
	});

	test('drops blank and whitespace-only notes', () => {
		const notes = [note({ text: 'real' }), note({ text: '' }), note({ text: '   \n  ' })];
		expect(activeSteeringNotes(notes, TARGET).map((n) => n.text)).toEqual(['real']);
	});

	test('drops notes whose scope does not match the target', () => {
		const notes = [note({ text: 'here', scope: 'chat', scopeId: 'chat-1' }), note({ text: 'elsewhere', scope: 'chat', scopeId: 'chat-2' })];
		expect(activeSteeringNotes(notes, TARGET).map((n) => n.text)).toEqual(['here']);
	});

	test('with no chat open, only global notes survive', () => {
		const notes = [
			note({ text: 'global' }),
			note({ text: 'char', scope: 'character', scopeId: 'char-1' }),
			note({ text: 'chat', scope: 'chat', scopeId: 'chat-1' })
		];
		const empty: SteeringTarget = { chatId: null, characterId: null, characterVersionId: null };
		expect(activeSteeringNotes(notes, empty).map((n) => n.text)).toEqual(['global']);
	});

	test('returns the surviving notes in injection order', () => {
		const notes = [
			note({ text: 'chat', scope: 'chat', scopeId: 'chat-1' }),
			note({ text: 'disabled', scope: 'global', enabled: false }),
			note({ text: 'global', scope: 'global' })
		];
		expect(activeSteeringNotes(notes, TARGET).map((n) => n.text)).toEqual(['global', 'chat']);
	});
});

describe('resolvePlacement: the inherit tri-state', () => {
	test('null depth and role inherit the app-wide defaults', () => {
		expect(resolvePlacement(note(), { depth: 4, role: 'user' })).toEqual({ depth: 4, role: 'user' });
	});

	test('an explicit depth of 0 overrides a non-zero default rather than reading as unset', () => {
		expect(resolvePlacement(note({ depth: 0 }), { depth: 7, role: 'system' }).depth).toBe(0);
	});

	test('an explicit role overrides the default', () => {
		expect(resolvePlacement(note({ role: 'assistant' }), DEFAULTS).role).toBe('assistant');
	});

	test('an out-of-range stored depth is clamped on read', () => {
		expect(resolvePlacement(note({ depth: 999 }), DEFAULTS).depth).toBe(100);
		expect(resolvePlacement(note({ depth: -5 }), DEFAULTS).depth).toBe(0);
	});
});

describe('clampSteeringDepth', () => {
	test('clamps, rounds, and degrades a non-finite value to 0', () => {
		expect(clampSteeringDepth(4.6)).toBe(5);
		expect(clampSteeringDepth(-3)).toBe(0);
		expect(clampSteeringDepth(500)).toBe(100);
		expect(clampSteeringDepth(Number.NaN)).toBe(0);
	});
});

describe('resolveSteeringForPrompt', () => {
	test('hands assembly the active notes in order, inheritance already resolved', () => {
		const notes = [
			note({ text: 'narrow', scope: 'chat', scopeId: 'chat-1', depth: 2, role: 'user' }),
			note({ text: 'broad', scope: 'global' }),
			note({ text: 'muted', scope: 'global', enabled: false })
		];
		expect(resolveSteeringForPrompt(notes, TARGET, { depth: 1, role: 'system' })).toEqual([
			{ text: 'broad', depth: 1, role: 'system' },
			{ text: 'narrow', depth: 2, role: 'user' }
		]);
	});

	test('nothing active resolves to an empty list, not a blank note', () => {
		expect(resolveSteeringForPrompt([note({ text: '  ' })], TARGET, DEFAULTS)).toEqual([]);
	});
});

describe('noteLabel', () => {
	test('prefers the given title', () => {
		expect(noteLabel(note({ title: 'Prose discipline', text: 'no purple prose' }))).toBe('Prose discipline');
	});

	test('falls back to the first line of the text', () => {
		expect(noteLabel(note({ text: 'Bring the storm in.\nBefore the scene ends.' }))).toBe('Bring the storm in.');
	});

	test('truncates a long first line', () => {
		const label = noteLabel(note({ text: 'x'.repeat(80) }));
		expect(label).toHaveLength(48);
		expect(label.endsWith('…')).toBe(true);
	});

	test('an empty note still gets a label', () => {
		expect(noteLabel(note({ text: '   ' }))).toBe('Empty steering');
	});
});

describe('createSteeringNote', () => {
	test('defaults to an enabled, pinned, fully-inheriting note', () => {
		const fresh = createSteeringNote({ text: 'be terse', scope: 'global', scopeId: null });
		expect(fresh.enabled).toBe(true);
		expect(fresh.mode).toBe('pinned');
		expect(fresh.depth).toBeNull();
		expect(fresh.role).toBeNull();
		expect(fresh.title).toBe('');
		expect(fresh.createdAt).toBe(fresh.updatedAt);
	});

	test('mints a distinct id per note', () => {
		const a = createSteeringNote({ text: 'a', scope: 'global', scopeId: null });
		const b = createSteeringNote({ text: 'b', scope: 'global', scopeId: null });
		expect(a.id).not.toBe(b.id);
	});
});

describe('steeringScanText', () => {
	const resolved = (text: string) => ({ text, depth: 0, role: 'system' as const });

	test('joins every note, one per line', () => {
		expect(steeringScanText([resolved('head north'), resolved('it is raining')])).toBe(
			'head north\nit is raining'
		);
	});

	test('no notes is no source', () => {
		expect(steeringScanText([])).toBe('');
		expect(steeringScanText(undefined)).toBe('');
	});

	test('a blank note contributes no line of its own', () => {
		expect(steeringScanText([resolved('  '), resolved('head north')])).toBe('head north');
	});
});
