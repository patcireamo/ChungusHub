/**
 * The story-turn placement that rides an `llm` request, so the SERVER can write the reply
 * when the generation ends (architecture/server-core.md).
 *
 * It lives here rather than in a copy per side because it is a wire shape with two consumers
 * and no compiler between them: `handleLlm` types its message structurally, so a field
 * renamed on one side alone would vanish through `JSON.stringify` with nothing failing to
 * build. Same reasoning as `SyncScope` in ./sync.ts.
 */
export interface GenerationCommit {
	chatId: string;
	/** The row the turn hangs under; null lands a root sibling (an opening scene). */
	parentId: string | null;
	/** The chat's leaf as the request leaves. The commit moves the leaf only if it still
	 *  reads that, so a reader who walked to another branch meanwhile is left where they are. */
	expectedLeafId: string | null;
	/** Claim `rootMessageId` when the chat holds none. Opening scene only. */
	claimsRoot: boolean;
	/** The lorebook scan that shaped this turn, stored on the row it produces. */
	lorebook: unknown;
	/** Ids of the 'once' steering notes this prompt resolved, spent inside the commit. */
	spendSteeringIds: string[];
}

/** Whether an inbound placement is shaped like one. Every field is checked, `spendSteeringIds`
 *  down to its elements: an id that is not a string reaches a SQL bind inside the commit
 *  transaction and throws there, which discards a reply that has already been paid for. */
export function isGenerationCommit(value: unknown): value is GenerationCommit {
	const c = value as GenerationCommit | null;
	return (
		!!c &&
		typeof c === 'object' &&
		typeof c.chatId === 'string' &&
		!!c.chatId &&
		(c.parentId === null || typeof c.parentId === 'string') &&
		(c.expectedLeafId === null || typeof c.expectedLeafId === 'string') &&
		typeof c.claimsRoot === 'boolean' &&
		Array.isArray(c.spendSteeringIds) &&
		c.spendSteeringIds.every((id) => typeof id === 'string')
	);
}
