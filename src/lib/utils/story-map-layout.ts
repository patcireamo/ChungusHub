/**
 * Pure tidy-tree layout for the story map.
 *
 * Positions the message forest as a compact, non-overlapping node graph using the
 * Buchheim–Jünger–Leipert linear-time tidy-tree algorithm (a refinement of Reingold–Tilford).
 * The key property over a naive "each leaf gets the next column" scheme: sibling subtrees are
 * packed against each other's *contours*, so a deep, bushy branch never shoves a shallow leaf
 * sibling far to the side: nodes on different rows can share a column without conflict.
 *
 * The chat can be a FOREST, not a single tree: seeded greetings are multiple root-level
 * siblings (parentId === null). A virtual super-root ties them together for the algorithm, then
 * the real roots spread across the top row.
 *
 * **Every message gets a node.** A sibling nobody continued from is not noise to be folded into
 * the turn beside it: a swipe can be edited into something the story never said anywhere else,
 * and even an untouched one is the start of a branch that simply hasn't been written yet. The
 * map draws what is there.
 *
 * Coordinates come out in grid units (integer `depth` rows, `col` columns where leaves land on
 * integers and parents on the midpoint of their children). The view multiplies by its own
 * spacing to get pixels, keeping this module free of any rendering concern (and unit-testable).
 *
 * **All three walks are explicit-stack, and must stay that way.** The tree is as deep as the
 * conversation is long, so a recursive walk makes recursion depth user data: a long story
 * overflows the call stack and the map goes blank. The browser's ceiling also moves with JIT
 * state, so the same chat can draw on one page load and not the next. Same rule, same reason,
 * in `message-tree.ts`.
 */

import type { Message, BranchLabel } from '$lib/types/chat';

export interface StoryMapNode {
	id: string;
	parentId: string | null;
	role: 'user' | 'assistant' | 'system';
	content: string;
	/** Row: distance from a root (roots at 0). */
	depth: number;
	/** Column in grid space (fractional for internal nodes centered over their children). */
	col: number;
	/** Total children, a fork when > 1. */
	childCount: number;
	/** True when this node is one of several children of its parent (a divergent path start). */
	isBranchStart: boolean;
	/** True when this node forks below it (childCount > 1). */
	isForkPoint: boolean;
	/** Position among this node's parent's children. */
	siblingIndex: number;
	siblingCount: number;
	onActivePath: boolean;
	onCanonPath: boolean;
	isActiveLeaf: boolean;
	isCanonLeaf: boolean;
	isLeaf: boolean;
	label: BranchLabel | null;
	model: string | null;
	provider: string | null;
	tokensCompletion: number | null;
	/** Images sent with this turn. Named in the inspector, never drawn on the canvas: a
	 *  fourth marker on a 30px dot is clutter. */
	attachmentCount: number;
	createdAt: number;
}

export interface StoryMapEdge {
	from: string;
	to: string;
	onActivePath: boolean;
	onCanonPath: boolean;
}

export interface StoryMapGraph {
	nodes: StoryMapNode[];
	edges: StoryMapEdge[];
	/** Total columns the graph spans (col ∈ [0, columns-1]). */
	columns: number;
	/** Total rows (max depth + 1). */
	rows: number;
}

/** Minimum horizontal separation between adjacent subtrees, in grid units. */
const DISTANCE = 1;

/** Internal layout node: carries the Buchheim bookkeeping fields. */
interface LNode {
	id: string;
	children: LNode[];
	parent: LNode | null;
	depth: number;
	/** 1-based index among siblings. */
	number: number;
	prelim: number;
	mod: number;
	thread: LNode | null;
	ancestor: LNode;
	change: number;
	shift: number;
	x: number;
}

/** Walk parent links from a leaf to the root, returning the set of ids on that path.
 *  Guards against a malformed cyclic chain so a bad row can't hang the UI. */
function pathIds(byId: Map<string, Message>, leafId: string | null): Set<string> {
	const ids = new Set<string>();
	let cur: string | null = leafId;
	while (cur && !ids.has(cur)) {
		ids.add(cur);
		cur = byId.get(cur)?.parentId ?? null;
	}
	return ids;
}

const leftSibling = (v: LNode): LNode | null =>
	v.parent && v.number > 1 ? v.parent.children[v.number - 2] : null;

const nextLeft = (v: LNode): LNode | null => (v.children.length ? v.children[0] : v.thread);
const nextRight = (v: LNode): LNode | null =>
	v.children.length ? v.children[v.children.length - 1] : v.thread;

function moveSubtree(wm: LNode, wp: LNode, shift: number): void {
	const subtrees = wp.number - wm.number;
	if (subtrees === 0) return;
	wp.change -= shift / subtrees;
	wp.shift += shift;
	wm.change += shift / subtrees;
	wp.prelim += shift;
	wp.mod += shift;
}

function executeShifts(v: LNode): void {
	let shift = 0;
	let change = 0;
	for (let i = v.children.length - 1; i >= 0; i--) {
		const w = v.children[i];
		w.prelim += shift;
		w.mod += shift;
		change += w.change;
		shift += w.shift + change;
	}
}

function nodeAncestor(vim: LNode, v: LNode, defaultAncestor: LNode): LNode {
	return vim.ancestor.parent === v.parent ? vim.ancestor : defaultAncestor;
}

function apportion(v: LNode, defaultAncestor: LNode): LNode {
	const w = leftSibling(v);
	if (!w) return defaultAncestor;

	let vip: LNode = v; // inner right
	let vop: LNode = v; // outer right
	let vim: LNode = w; // inner left
	let vom: LNode = v.parent!.children[0]; // outer left (leftmost sibling)

	let sip = vip.mod;
	let sop = vop.mod;
	let sim = vim.mod;
	let som = vom.mod;

	let nr = nextRight(vim);
	let nl = nextLeft(vip);
	while (nr && nl) {
		vim = nr;
		vip = nl;
		vom = nextLeft(vom)!;
		vop = nextRight(vop)!;
		vop.ancestor = v;
		const shift = vim.prelim + sim - (vip.prelim + sip) + DISTANCE;
		if (shift > 0) {
			moveSubtree(nodeAncestor(vim, v, defaultAncestor), v, shift);
			sip += shift;
			sop += shift;
		}
		sim += vim.mod;
		sip += vip.mod;
		som += vom.mod;
		sop += vop.mod;
		nr = nextRight(vim);
		nl = nextLeft(vip);
	}

	if (nr && !nextRight(vop)) {
		vop.thread = nr;
		vop.mod += sim - sop;
	}
	if (nl && !nextLeft(vom)) {
		vom.thread = nl;
		vom.mod += sip - som;
		defaultAncestor = v;
	}
	return defaultAncestor;
}

function firstWalk(root: LNode): void {
	const stack: { v: LNode; next: number; defaultAncestor: LNode }[] = [
		{ v: root, next: 0, defaultAncestor: root }
	];

	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		const kids = frame.v.children;

		if (kids.length === 0) {
			const w = leftSibling(frame.v);
			frame.v.prelim = w ? w.prelim + DISTANCE : 0;
			stack.pop();
			continue;
		}

		// Re-entering a frame means the child before `next` has just finished its own walk,
		// and apportioning it belongs HERE, before the next child starts: it can shift that
		// child's subtree, which the next one then measures itself against. Hoisting the
		// apportion pass out of the descent would silently change the packing.
		frame.defaultAncestor =
			frame.next === 0 ? kids[0] : apportion(kids[frame.next - 1], frame.defaultAncestor);

		if (frame.next < kids.length) {
			const child = kids[frame.next++];
			stack.push({ v: child, next: 0, defaultAncestor: child });
			continue;
		}

		executeShifts(frame.v);
		const midpoint = (kids[0].prelim + kids[kids.length - 1].prelim) / 2;
		const w = leftSibling(frame.v);
		if (w) {
			frame.v.prelim = w.prelim + DISTANCE;
			frame.v.mod = frame.v.prelim - midpoint;
		} else {
			frame.v.prelim = midpoint;
		}
		stack.pop();
	}
}

function secondWalk(root: LNode): void {
	const stack: { v: LNode; m: number }[] = [{ v: root, m: 0 }];
	while (stack.length > 0) {
		const { v, m } = stack.pop()!;
		v.x = v.prelim + m;
		for (const child of v.children) stack.push({ v: child, m: m + v.mod });
	}
}

export function layoutStoryTree(
	messages: Message[],
	activeLeafId: string | null,
	canonLeafId: string | null
): StoryMapGraph {
	if (messages.length === 0) return { nodes: [], edges: [], columns: 0, rows: 0 };

	const byId = new Map<string, Message>();
	const childrenOf = new Map<string | null, Message[]>();
	for (const m of messages) {
		byId.set(m.id, m);
		const siblings = childrenOf.get(m.parentId) ?? [];
		siblings.push(m);
		childrenOf.set(m.parentId, siblings);
	}
	for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.siblingIndex - b.siblingIndex);

	// A message whose parent no longer exists (deleted parent) is treated as a root, so nothing
	// gets orphaned off the canvas.
	const roots = messages
		.filter((m) => m.parentId === null || !byId.has(m.parentId))
		.sort((a, b) => a.siblingIndex - b.siblingIndex);

	const activeIds = pathIds(byId, activeLeafId);
	const canonIds = pathIds(byId, canonLeafId);

	// Build the layout tree under a virtual super-root, cycle-guarded.
	const lnodes = new Map<string, LNode>();
	const makeL = (id: string): LNode => {
		const l: LNode = {
			id,
			children: [],
			parent: null,
			depth: 0,
			number: 1,
			prelim: 0,
			mod: 0,
			thread: null,
			ancestor: null as unknown as LNode,
			change: 0,
			shift: 0,
			x: 0
		};
		l.ancestor = l;
		return l;
	};

	const virtual = makeL('__virtual__');
	virtual.depth = -1;

	const seen = new Set<string>();
	const pending: { msg: Message; parent: LNode; depth: number }[] = [];
	for (let i = roots.length - 1; i >= 0; i--) {
		pending.push({ msg: roots[i], parent: virtual, depth: 0 });
	}
	// Children are pushed in reverse so they pop in sibling order, which is the order they
	// then take in their parent's child list.
	while (pending.length > 0) {
		const { msg, parent, depth } = pending.pop()!;
		if (seen.has(msg.id)) continue;
		seen.add(msg.id);
		const l = makeL(msg.id);
		l.parent = parent;
		l.depth = depth;
		lnodes.set(msg.id, l);
		parent.children.push(l);
		const kids = childrenOf.get(msg.id) ?? [];
		for (let i = kids.length - 1; i >= 0; i--) {
			pending.push({ msg: kids[i], parent: l, depth: depth + 1 });
		}
	}
	virtual.children.forEach((c, i) => (c.number = i + 1));
	for (const l of lnodes.values()) l.children.forEach((c, i) => (c.number = i + 1));

	if (virtual.children.length === 0) return { nodes: [], edges: [], columns: 0, rows: 0 };

	firstWalk(virtual);
	secondWalk(virtual);

	// Normalize so the leftmost real node sits at column 0.
	let minX = Infinity;
	let maxX = -Infinity;
	let maxDepth = 0;
	for (const l of lnodes.values()) {
		if (l.x < minX) minX = l.x;
		if (l.x > maxX) maxX = l.x;
		if (l.depth > maxDepth) maxDepth = l.depth;
	}

	const nodes: StoryMapNode[] = [];
	const edges: StoryMapEdge[] = [];
	for (const m of messages) {
		const l = lnodes.get(m.id);
		if (!l) continue; // unreachable (cycle guard dropped it)
		const kids = childrenOf.get(m.id) ?? [];
		const siblings = childrenOf.get(m.parentId) ?? [];
		nodes.push({
			id: m.id,
			parentId: m.parentId,
			role: m.role,
			content: m.content,
			depth: l.depth,
			col: l.x - minX,
			childCount: kids.length,
			isBranchStart: siblings.length > 1,
			isForkPoint: kids.length > 1,
			siblingIndex: siblings.findIndex((s) => s.id === m.id),
			siblingCount: siblings.length,
			onActivePath: activeIds.has(m.id),
			onCanonPath: canonIds.has(m.id),
			isActiveLeaf: m.id === activeLeafId,
			isCanonLeaf: m.id === canonLeafId,
			isLeaf: kids.length === 0,
			label: m.branchLabel,
			model: m.model,
			provider: m.provider,
			tokensCompletion: m.tokensCompletion,
			attachmentCount: m.attachments?.length ?? 0,
			createdAt: m.createdAt
		});
		if (m.parentId && byId.has(m.parentId) && lnodes.has(m.parentId)) {
			edges.push({
				from: m.parentId,
				to: m.id,
				onActivePath: activeIds.has(m.parentId) && activeIds.has(m.id),
				onCanonPath: canonIds.has(m.parentId) && canonIds.has(m.id)
			});
		}
	}

	return { nodes, edges, columns: Math.max(1, maxX - minX + 1), rows: maxDepth + 1 };
}
