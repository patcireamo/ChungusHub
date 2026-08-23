/**
 * Pure helpers over the flat message rows of a chat.
 *
 * **Nothing here may recurse over the tree.** A chat's depth is the length of the
 * conversation, so recursion depth becomes user data: a story long enough overflows the
 * call stack, and the browser's ceiling moves with JIT state, so the same chat can work
 * on one page load and not the next. Every walk below is an explicit loop, and any new
 * one is too. Same rule, same reason, in `story-map-layout.ts`.
 */
import type { Message } from '$lib/types/chat';

/**
 * Extract the linear path from root to a specific leaf.
 * This is what gets displayed in the chat view.
 */
export function findActivePath(messages: Message[], leafId: string): Message[] {
	const messageMap = new Map<string, Message>();
	for (const msg of messages) {
		messageMap.set(msg.id, msg);
	}

	// The walk runs leaf→root and the caller wants root→leaf. Collected by appending and
	// reversed once, rather than unshifted per turn: unshift re-seats the whole array on
	// every step, which makes opening a chat cost the square of its length.
	const path: Message[] = [];
	let currentId: string | null = leafId;

	while (currentId) {
		const message = messageMap.get(currentId);
		if (!message) break;
		path.push(message);
		currentId = message.parentId;
	}

	return path.reverse();
}

/**
 * Find all sibling messages at a given node: every child of the same parent,
 * regardless of role. Siblings are the alternative continuations of the story from
 * that point: same-role ones are variants (swipes/regenerations), different-role ones
 * are forks (e.g. a reply re-parented next to user turns by a splice delete). The chat
 * arrows navigate ALL of them, deliberately matching the story map's numbering: a
 * role-filtered count made spliced branches invisible outside the map.
 */
export function findSiblings(messages: Message[], messageId: string): Message[] {
	const message = messages.find((m) => m.id === messageId);
	if (!message) return [];

	return messages
		.filter((m) => m.parentId === message.parentId)
		.sort((a, b) => a.siblingIndex - b.siblingIndex);
}

/**
 * Get the index of a message among its siblings.
 */
export function getSiblingIndex(messages: Message[], messageId: string): number {
	const siblings = findSiblings(messages, messageId);
	return siblings.findIndex((m) => m.id === messageId);
}

/**
 * Find the next sibling in navigation.
 */
export function findNextSibling(messages: Message[], messageId: string): Message | null {
	const siblings = findSiblings(messages, messageId);
	const currentIndex = siblings.findIndex((m) => m.id === messageId);
	return siblings[currentIndex + 1] ?? null;
}

/**
 * Find the previous sibling in navigation.
 */
export function findPrevSibling(messages: Message[], messageId: string): Message | null {
	const siblings = findSiblings(messages, messageId);
	const currentIndex = siblings.findIndex((m) => m.id === messageId);
	return currentIndex > 0 ? siblings[currentIndex - 1] : null;
}

/**
 * The whole subtree rooted at `rootId` (the message itself + every descendant), in
 * BFS parent-first order, the order that makes re-inserting the rows FK-safe.
 */
export function collectSubtree(messages: Message[], rootId: string): Message[] {
	const root = messages.find((m) => m.id === rootId);
	if (!root) return [];

	const childrenMap = new Map<string | null, Message[]>();
	for (const msg of messages) {
		const siblings = childrenMap.get(msg.parentId) ?? [];
		siblings.push(msg);
		childrenMap.set(msg.parentId, siblings);
	}
	for (const siblings of childrenMap.values()) {
		siblings.sort((a, b) => a.siblingIndex - b.siblingIndex);
	}

	const out: Message[] = [];
	const queue: Message[] = [root];
	while (queue.length > 0) {
		const m = queue.shift()!;
		out.push(m);
		queue.push(...(childrenMap.get(m.id) ?? []));
	}
	return out;
}

/**
 * What a destructive operation on `id`'s subtree would take with it: how many messages,
 * and how many distinct timelines (subtree leaves) they span. `includeSelf: false`
 * measures only what's *below* (regenerate-below / replace); default includes the
 * message itself (delete-with-descendants). Drives the confirmation copy.
 */
export function subtreeBlastRadius(
	messages: Message[],
	id: string,
	opts: { includeSelf?: boolean } = {}
): { messages: number; branches: number } {
	const sub = collectSubtree(messages, id);
	const set = opts.includeSelf === false ? sub.slice(1) : sub;
	if (set.length === 0) return { messages: 0, branches: 0 };
	const parentsInSet = new Set<string>();
	const ids = new Set(set.map((m) => m.id));
	for (const m of set) {
		if (m.parentId && ids.has(m.parentId)) parentsInSet.add(m.parentId);
	}
	const branches = set.filter((m) => !parentsInSet.has(m.id)).length;
	return { messages: set.length, branches };
}

/**
 * Whether this message may be deleted on its own (`this_only`), or a delete has to take its
 * whole subtree. A splice merges the message's children into its PARENT's child set, and at a
 * fork those two sets hold opposite roles: the branches beside it answer the same turn it
 * answers, while its own children answer IT. Merged, they leave a swipe position where one
 * variant is a user turn and the next is a reply, a sequence no reader can make sense of.
 * So a message that heads a branch may only be spliced while nothing hangs below it: with no
 * children there is nothing to re-parent, and the delete is a single row.
 *
 * Note this closes the direct route only. A lone child spliced away hands its own children
 * to a parent of the same role, and a later regenerate there can still fork a mixed set,
 * which is why sibling navigation stays role-agnostic (findSiblings).
 */
export function canSpliceMessage(messages: Message[], id: string): boolean {
	const message = messages.find((m) => m.id === id);
	if (!message) return false;
	if (!messages.some((m) => m.parentId === id)) return true;
	return !messages.some((m) => m.parentId === message.parentId && m.id !== id);
}

/**
 * Given a message, find the deepest leaf by following first children.
 */
export function findDeepestLeafFromNode(messages: Message[], startId: string): string {
	const childrenMap = new Map<string | null, Message[]>();

	for (const msg of messages) {
		const siblings = childrenMap.get(msg.parentId) ?? [];
		siblings.push(msg);
		childrenMap.set(msg.parentId, siblings);
	}

	// Sort siblings by index
	for (const siblings of childrenMap.values()) {
		siblings.sort((a, b) => a.siblingIndex - b.siblingIndex);
	}

	let currentId = startId;
	while (true) {
		const children = childrenMap.get(currentId);
		if (!children || children.length === 0) break;
		currentId = children[0].id;
	}

	return currentId;
}
