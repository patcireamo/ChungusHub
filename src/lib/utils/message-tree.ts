import type { Message, MessageNode } from '$lib/types/chat';

/**
 * Build a tree structure from flat message array.
 * Marks which nodes are on the active path from root to activeLeafId.
 */
export function buildMessageTree(
	messages: Message[],
	activeLeafId: string | null
): MessageNode | null {
	if (messages.length === 0) return null;

	// Build lookup maps
	const messageMap = new Map<string, Message>();
	const childrenMap = new Map<string | null, Message[]>();

	for (const msg of messages) {
		messageMap.set(msg.id, msg);

		const siblings = childrenMap.get(msg.parentId) ?? [];
		siblings.push(msg);
		childrenMap.set(msg.parentId, siblings);
	}

	// Sort siblings by sibling_index
	for (const siblings of childrenMap.values()) {
		siblings.sort((a, b) => a.siblingIndex - b.siblingIndex);
	}

	// Find active path (walk up from leaf to root)
	const activePathIds = new Set<string>();
	if (activeLeafId) {
		let currentId: string | null = activeLeafId;
		while (currentId) {
			activePathIds.add(currentId);
			const msg = messageMap.get(currentId);
			currentId = msg?.parentId ?? null;
		}
	}

	// Build tree recursively
	function buildNode(message: Message, depth: number): MessageNode {
		const children = childrenMap.get(message.id) ?? [];
		const parentChildren = childrenMap.get(message.parentId) ?? [];

		return {
			...message,
			children: children.map((child) => buildNode(child, depth + 1)),
			siblingCount: parentChildren.length,
			isOnActivePath: activePathIds.has(message.id),
			depth
		};
	}

	// Find root messages (no parent)
	const roots = childrenMap.get(null) ?? [];
	if (roots.length === 0) return null;

	// Return the root that's on the active path, or first root
	const activeRoot = roots.find((r) => activePathIds.has(r.id)) ?? roots[0];
	return buildNode(activeRoot, 0);
}

/**
 * Extract the linear path from root to a specific leaf.
 * This is what gets displayed in the chat view.
 */
export function findActivePath(messages: Message[], leafId: string): Message[] {
	const messageMap = new Map<string, Message>();
	for (const msg of messages) {
		messageMap.set(msg.id, msg);
	}

	const path: Message[] = [];
	let currentId: string | null = leafId;

	while (currentId) {
		const message = messageMap.get(currentId);
		if (!message) break;
		path.unshift(message);
		currentId = message.parentId;
	}

	return path;
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
