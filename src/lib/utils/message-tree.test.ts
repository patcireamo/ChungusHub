/**
 * Tests for the pure tree helpers behind destructive-action UX and branch navigation:
 * FK-safe subtree capture order, the blast radius every delete/regenerate confirmation
 * displays, and the role-agnostic sibling walk that keeps every branch reachable from
 * the chat. Run with `bun test`.
 */

import { describe, expect, test } from 'bun:test';

import type { Message } from '$lib/types/chat';
import {
	canSpliceMessage,
	collectSubtree,
	findActivePath,
	findDeepestLeafFromNode,
	findSiblings,
	subtreeBlastRadius
} from './message-tree';

/** Minimal message rows for a tree given as [id, parentId] pairs. */
function tree(pairs: [string, string | null][]): Message[] {
	return pairs.map(([id, parentId], i) => ({
		id,
		chatId: 'c',
		parentId,
		role: i % 2 === 0 ? 'user' : 'assistant',
		content: id,
		personaId: null,
		branchLabel: null,
		thinking: null,
		createdAt: i,
		editedAt: null,
		model: null,
		provider: null,
		tokensPrompt: null,
		tokensCompletion: null,
		finishReason: null,
		siblingIndex: 0
	}));
}

//  r ─ a ─ b ─ c
//        └ d ─ e
const FORKED = tree([
	['r', null],
	['a', 'r'],
	['b', 'a'],
	['d', 'a'],
	['c', 'b'],
	['e', 'd']
]);

describe('collectSubtree', () => {
	test('returns the whole subtree parent-first (FK-safe insert order)', () => {
		const ids = collectSubtree(FORKED, 'a').map((m) => m.id);
		expect(ids).toHaveLength(5);
		expect(ids[0]).toBe('a');
		// Every message appears after its parent, the property a parent-first insert needs.
		for (let i = 1; i < ids.length; i++) {
			const m = FORKED.find((x) => x.id === ids[i])!;
			expect(ids.indexOf(m.parentId!)).toBeLessThan(i);
		}
	});

	test('unknown root yields an empty list', () => {
		expect(collectSubtree(FORKED, 'ghost')).toEqual([]);
	});
});

describe('subtreeBlastRadius', () => {
	test('counts messages and distinct timelines, with and without self', () => {
		expect(subtreeBlastRadius(FORKED, 'a')).toEqual({ messages: 5, branches: 2 });
		expect(subtreeBlastRadius(FORKED, 'a', { includeSelf: false })).toEqual({ messages: 4, branches: 2 });
		expect(subtreeBlastRadius(FORKED, 'c')).toEqual({ messages: 1, branches: 1 });
	});

	test('a leaf with nothing below reports zero for the regenerate case', () => {
		expect(subtreeBlastRadius(FORKED, 'c', { includeSelf: false })).toEqual({ messages: 0, branches: 0 });
	});
});

describe('canSpliceMessage', () => {
	test('a branch head with anything below it can only go whole', () => {
		// b and d are the two branches off a: splicing either would hand its reply to a,
		// next to the other branch, and the swipe there would alternate roles.
		expect(canSpliceMessage(FORKED, 'b')).toBe(false);
		expect(canSpliceMessage(FORKED, 'd')).toBe(false);
	});

	test('a turn with no branch beside it splices, whatever hangs below', () => {
		expect(canSpliceMessage(FORKED, 'a')).toBe(true);
		expect(canSpliceMessage(FORKED, 'r')).toBe(true);
	});

	test('a leaf always splices: there is nothing to re-parent', () => {
		expect(canSpliceMessage(FORKED, 'c')).toBe(true);
		expect(canSpliceMessage(FORKED, 'e')).toBe(true);
		// Including a branch head: two greetings, neither played yet.
		const greetings = tree([
			['g1', null],
			['g2', null]
		]);
		expect(canSpliceMessage(greetings, 'g1')).toBe(true);
	});

	test('an unknown id cannot be spliced', () => {
		expect(canSpliceMessage(FORKED, 'ghost')).toBe(false);
	});
});

describe('findSiblings', () => {
	test('walks every branch at a point, forks included (mixed roles after a splice)', () => {
		// The shape a this_only delete leaves behind: two user turns plus the deleted
		// turn's reply, re-parented next to them. All three are alternative continuations
		// and every one must be reachable from every other: role never hides a branch.
		const msgs = tree([
			['p', null],
			['u1', 'p'],
			['u2', 'p'],
			['r', 'p']
		]);
		const shape = (id: string, role: Message['role'], siblingIndex: number) => {
			const m = msgs.find((x) => x.id === id)!;
			m.role = role;
			m.siblingIndex = siblingIndex;
		};
		shape('u1', 'user', 0);
		shape('u2', 'user', 1);
		shape('r', 'assistant', 2);
		for (const id of ['u1', 'u2', 'r']) {
			expect(findSiblings(msgs, id).map((m) => m.id)).toEqual(['u1', 'u2', 'r']);
		}
	});

	test('an unknown id yields an empty list', () => {
		expect(findSiblings(FORKED, 'ghost')).toEqual([]);
	});
});

describe('findActivePath', () => {
	test('reads root first, whichever branch the leaf sits on', () => {
		expect(findActivePath(FORKED, 'c').map((m) => m.id)).toEqual(['r', 'a', 'b', 'c']);
		expect(findActivePath(FORKED, 'e').map((m) => m.id)).toEqual(['r', 'a', 'd', 'e']);
	});

	test('a leaf nobody has stops at what it can reach', () => {
		expect(findActivePath(FORKED, 'ghost')).toEqual([]);
		// A chain hanging off a deleted parent yields the surviving stretch, not nothing.
		expect(findActivePath(tree([['orphan', 'gone']]), 'orphan').map((m) => m.id)).toEqual(['orphan']);
	});
});

/**
 * A chat is a parent-chain, so its depth is the length of the conversation and grows without
 * bound. Two shapes of code turn that length into a failure and both are silent in the file
 * that writes them: a walk that recurses makes stack depth user data (a long enough story
 * throws RangeError, and the engine's ceiling moves with JIT state, so the same chat opens on
 * one page load and not the next), and a per-turn `unshift`/`splice` makes opening a chat cost
 * the square of its length.
 *
 * The size below is far past what any engine allows a recursive walk, so no recursive
 * implementation of these helpers can pass it on any runtime. It runs in well under a second,
 * which is itself the second half of the claim.
 */
describe('depth is user data, so no walk may recurse or re-seat', () => {
	const DEPTH = 100_000;
	const CHAIN: Message[] = tree(
		Array.from({ length: DEPTH }, (_, i) => [`m${i}`, i === 0 ? null : `m${i - 1}`] as [string, string | null])
	);
	const LEAF = `m${DEPTH - 1}`;

	test('the whole branch resolves, root first', () => {
		const path = findActivePath(CHAIN, LEAF);
		expect(path).toHaveLength(DEPTH);
		expect(path[0].id).toBe('m0');
		expect(path[DEPTH - 1].id).toBe(LEAF);
	});

	test('the subtree helpers behind every delete confirmation resolve', () => {
		expect(collectSubtree(CHAIN, 'm0')).toHaveLength(DEPTH);
		expect(subtreeBlastRadius(CHAIN, 'm0')).toEqual({ messages: DEPTH, branches: 1 });
	});

	test('navigation reaches the end of the branch', () => {
		expect(findDeepestLeafFromNode(CHAIN, 'm0')).toBe(LEAF);
	});
});
