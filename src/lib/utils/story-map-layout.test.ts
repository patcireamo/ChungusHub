/**
 * Layout invariants for the story map. Run with `bun test`.
 *
 * Locks the properties the map's rendering leans on: linear chats collapse to one column,
 * forks split into disjoint columns with the parent centered between them, a forest of roots
 * shares the top row, every message keeps a node of its own, and the active/canon path flags
 * follow parent links to the root.
 */

import { describe, expect, test } from 'bun:test';
import { layoutStoryTree, type StoryMapNode } from './story-map-layout';

/* eslint-disable @typescript-eslint/no-explicit-any */
function m(id: string, parentId: string | null, siblingIndex = 0, over: Record<string, unknown> = {}): any {
	return {
		id,
		parentId,
		role: 'assistant',
		content: id,
		siblingIndex,
		branchLabel: null,
		model: null,
		provider: null,
		tokensCompletion: null,
		createdAt: 0,
		...over
	};
}

const byId = (nodes: StoryMapNode[]) => new Map(nodes.map((n) => [n.id, n]));

describe('layoutStoryTree', () => {
	test('empty input yields an empty graph', () => {
		const g = layoutStoryTree([], null, null);
		expect(g.nodes).toHaveLength(0);
		expect(g.columns).toBe(0);
		expect(g.rows).toBe(0);
	});

	test('a linear chat is a single column with increasing depth', () => {
		const msgs = [m('a', null), m('b', 'a'), m('c', 'b')];
		const g = layoutStoryTree(msgs, 'c', null);
		expect(g.columns).toBe(1);
		expect(g.rows).toBe(3);
		const n = byId(g.nodes);
		expect(n.get('a')!.col).toBe(0);
		expect(n.get('b')!.col).toBe(0);
		expect(n.get('c')!.col).toBe(0);
		expect(n.get('a')!.depth).toBe(0);
		expect(n.get('c')!.depth).toBe(2);
		// Every node is on the active path to leaf c.
		expect(g.nodes.every((x) => x.onActivePath)).toBe(true);
	});

	test('a fork splits into two columns with the parent centered', () => {
		// a -> {b, c}
		const msgs = [m('a', null), m('b', 'a', 0), m('c', 'a', 1)];
		const g = layoutStoryTree(msgs, 'b', 'c');
		expect(g.columns).toBe(2);
		const n = byId(g.nodes);
		expect(n.get('b')!.col).toBe(0);
		expect(n.get('c')!.col).toBe(1);
		expect(n.get('a')!.col).toBe(0.5); // centered between its two children
		expect(n.get('a')!.isForkPoint).toBe(true);
		expect(n.get('b')!.isBranchStart).toBe(true);
		expect(n.get('c')!.isBranchStart).toBe(true);
		// Active path is a->b, canon path is a->c; the shared root belongs to both.
		expect(n.get('a')!.onActivePath).toBe(true);
		expect(n.get('a')!.onCanonPath).toBe(true);
		expect(n.get('b')!.onActivePath).toBe(true);
		expect(n.get('b')!.onCanonPath).toBe(false);
		expect(n.get('c')!.onCanonPath).toBe(true);
		expect(n.get('c')!.isCanonLeaf).toBe(true);
		expect(n.get('b')!.isActiveLeaf).toBe(true);
	});

	test('a forest of roots shares the top row across columns', () => {
		// two roots (greeting siblings), each with a child
		const msgs = [m('r0', null, 0), m('r1', null, 1), m('r0a', 'r0'), m('r1a', 'r1')];
		const g = layoutStoryTree(msgs, 'r0a', null);
		const n = byId(g.nodes);
		expect(n.get('r0')!.depth).toBe(0);
		expect(n.get('r1')!.depth).toBe(0);
		expect(n.get('r0')!.col).not.toBe(n.get('r1')!.col);
		expect(g.columns).toBe(2);
	});

	test('a deep, bushy sibling does not shove a shallow leaf sibling far away', () => {
		// F -> {c1, c2, c3, c4, c5}; c4 forks into {d1, d2, d3} one row down.
		// The naive "leaf gets the next column" layout would push c5 out past d1..d3 (col ~6),
		// leaving a big gap on F's row. Contour packing keeps c1..c5 consecutive because d1..d3
		// live on a different row and can share columns.
		const msgs = [
			m('F', null),
			m('c1', 'F', 0),
			m('c2', 'F', 1),
			m('c3', 'F', 2),
			m('c4', 'F', 3),
			m('c5', 'F', 4),
			m('d1', 'c4', 0),
			m('d2', 'c4', 1),
			m('d3', 'c4', 2)
		];
		const g = layoutStoryTree(msgs, 'c5', null);
		const n = byId(g.nodes);
		// F's five children are consecutive, no gap.
		expect(n.get('c1')!.col).toBe(0);
		expect(n.get('c2')!.col).toBe(1);
		expect(n.get('c3')!.col).toBe(2);
		expect(n.get('c4')!.col).toBe(3);
		expect(n.get('c5')!.col).toBe(4);
		// The bushy subtree sits a row below, sharing columns, never pushing c5 out.
		expect(n.get('d1')!.depth).toBe(2);
		expect(n.get('c5')!.col - n.get('c4')!.col).toBe(1);
	});

	test('a swipe nobody continued from still gets a node of its own', () => {
		// a -> {b, c, d}; only b was continued. c and d are one-turn branches, not noise:
		// either can be edited into something the story says nowhere else.
		const msgs = [m('a', null), m('b', 'a', 0), m('c', 'a', 1), m('d', 'a', 2), m('b1', 'b')];
		const g = layoutStoryTree(msgs, 'b1', null);
		const n = byId(g.nodes);
		expect(g.nodes.map((x) => x.id).sort()).toEqual(['a', 'b', 'b1', 'c', 'd']);
		expect(n.get('a')!.childCount).toBe(3);
		expect(n.get('a')!.isForkPoint).toBe(true);
		expect(n.get('c')!.siblingCount).toBe(3);
		expect(g.edges.filter((e) => e.from === 'a')).toHaveLength(3);
	});

	test('unread alternate greetings each keep a root of their own', () => {
		const msgs = [m('g0', null, 0), m('g1', null, 1), m('g2', null, 2), m('t', 'g0')];
		const g = layoutStoryTree(msgs, 't', null);
		expect(g.nodes.map((x) => x.id).sort()).toEqual(['g0', 'g1', 'g2', 't']);
		expect(g.columns).toBe(3);
	});

	test('an orphan (deleted parent) is promoted to a root instead of vanishing', () => {
		const msgs = [m('a', null), m('orphan', 'ghost')];
		const g = layoutStoryTree(msgs, 'a', null);
		const n = byId(g.nodes);
		expect(n.has('orphan')).toBe(true);
		expect(n.get('orphan')!.depth).toBe(0);
		// No edge is drawn to a missing parent.
		expect(g.edges.some((e) => e.to === 'orphan')).toBe(false);
	});
});

/**
 * A chat is a parent-chain, so its depth is the length of the conversation and grows without
 * bound. A walk that recurses therefore turns story length into stack depth, and a long enough
 * story takes the map down with a RangeError instead of drawing. Worse, the engine's ceiling
 * moves with JIT state, so the same chat draws on one page load and not the next.
 *
 * The size below is far past what any engine allows a recursive walk: the deepest recursion
 * measured here survived ~24,000 frames on JSC and ~4,000 on V8 cold. So this cannot be passed
 * by a recursive implementation of `build`, `firstWalk` or `secondWalk` on any runtime, which
 * is the point: it fails loudly the moment one comes back.
 */
describe('depth is user data, so no walk may recurse', () => {
	const DEPTH = 100_000;
	const chain = (i: number) => m(`m${i}`, i === 0 ? null : `m${i - 1}`);

	test('a chat far deeper than any call stack still lays out', () => {
		const msgs = Array.from({ length: DEPTH }, (_, i) => chain(i));
		const g = layoutStoryTree(msgs, `m${DEPTH - 1}`, null);
		expect(g.nodes).toHaveLength(DEPTH);
		expect(g.rows).toBe(DEPTH);
		expect(g.columns).toBe(1);
		expect(g.nodes.every((n) => n.onActivePath)).toBe(true);
	});

	test('the same depth with swipes along it, which is what reaches the packing pass', () => {
		// A pure chain never has a left sibling, so it never reaches `apportion`. Forking every
		// hundredth turn puts the contour packing deep inside the walk as well.
		const msgs = [];
		for (let i = 0; i < DEPTH; i++) {
			msgs.push(chain(i));
			if (i > 0 && i % 100 === 0) msgs.push(m(`s${i}`, `m${i - 1}`, 1));
		}
		const g = layoutStoryTree(msgs, `m${DEPTH - 1}`, null);
		expect(g.nodes).toHaveLength(msgs.length);
		expect(g.rows).toBe(DEPTH);
		expect(g.nodes.filter((n) => n.onActivePath)).toHaveLength(DEPTH);
	});
});
