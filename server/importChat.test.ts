/**
 * `importChat`, against the REAL server database (bun:sqlite).
 *
 * An imported story is the one write in this app whose size is set by a stranger's file rather
 * than by anything the app did, so both halves of it need a test rather than an eye.
 *
 * The size half: the rows must land in ONE call. Row by row over the RPC bridge, a long chat
 * is thousands of round trips, thousands of autocommits and thousands of sync broadcasts.
 *
 * The atomicity half is the one nothing on screen would reveal. `chats.root_message_id` and
 * `active_leaf_id` are foreign keys into `messages`, so the pointers can only be written after
 * the rows exist. A non-atomic import that stops partway therefore leaves the messages behind
 * under a chat pointing nowhere: it lists with a message count and opens empty, which reads
 * exactly like a bug in the transcript, and no later run cleans it up. Rolled back, an
 * interrupted import leaves nothing, which is the only state a retry can act on.
 *
 * Same env dance as chatList.test.ts: CHUNGUS_DATA_DIR is pinned to a throwaway dir before
 * the first db call, so no test can silently write into the real user-data.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let serverDb: any;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-importchat-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('./db'));
	// One handle per process, bound on first use (see server/db.ts). Release whatever an
	// earlier file left open so this file's first db call binds to the dir above.
	serverDb.closeForTests();
});

afterAll(() => {
	// Release before deleting: statements against an unlinked file fail for the rest of the run.
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

const CLOCK = 1_700_000_000_000;

function chatRow(id: string, rootMessageId: string | null, activeLeafId: string | null) {
	return {
		id,
		title: 'An imported story',
		createdAt: CLOCK,
		updatedAt: CLOCK,
		rootMessageId,
		activeLeafId,
		canonLeafId: null,
		settings: null,
		characterId: null,
		characterVersionId: null,
		isFavorite: false
	};
}

function messageRow(chatId: string, id: string, parentId: string | null, siblingIndex = 0) {
	return {
		id,
		chatId,
		parentId,
		role: parentId === null || siblingIndex > 0 ? 'assistant' : 'user',
		content: `turn ${id}`,
		personaId: null,
		branchLabel: null,
		thinking: null,
		attachments: null,
		createdAt: CLOCK + Number(id.replace(/\D/g, '') || 0),
		editedAt: null,
		minorEditedAt: null,
		spriteLabel: null,
		model: null,
		provider: null,
		tokensPrompt: null,
		tokensCompletion: null,
		finishReason: null,
		generationMs: null,
		firstTokenMs: null,
		reasoningMs: null,
		lorebook: null,
		siblingIndex
	};
}

/**
 * A parent-chain of `depth` turns with a swipe hanging off every `swipeEvery`-th one, ready
 * to import. Message ids are unique across the whole table, not per chat, so they carry the
 * chat's own id the way real UUIDs would.
 */
function story(depth: number, swipeEvery = 0) {
	const chatId = crypto.randomUUID();
	const turn = (i: number) => `${chatId}-m${i}`;
	const rows = [];
	for (let i = 0; i < depth; i++) {
		rows.push(messageRow(chatId, turn(i), i === 0 ? null : turn(i - 1)));
		if (swipeEvery > 0 && i > 0 && i % swipeEvery === 0) {
			rows.push(messageRow(chatId, `${chatId}-s${i}`, turn(i - 1), 1));
		}
	}
	return { chatId, rows, turn, rootId: turn(0), leafId: turn(depth - 1) };
}

describe('importChat', () => {
	test('one call lands the chat, every row, and the pointers into them', () => {
		const { chatId, rows, rootId, leafId } = story(40, 10);

		serverDb.importChat(chatRow(chatId, rootId, leafId), rows);

		const chat = serverDb.getChat(chatId) as any;
		expect(chat).not.toBeNull();
		expect(chat.rootMessageId).toBe(rootId);
		expect(chat.activeLeafId).toBe(leafId);
		expect(serverDb.getMessagesByChat(chatId)).toHaveLength(rows.length);
	});

	test('a story far longer than anyone plays lands in one transaction', () => {
		const { chatId, rows, rootId, leafId } = story(20_000, 100);

		serverDb.importChat(chatRow(chatId, rootId, leafId), rows);

		expect(serverDb.getMessagesByChat(chatId)).toHaveLength(rows.length);
		expect((serverDb.getChat(chatId) as any).activeLeafId).toBe(leafId);
		// The chat list's own count agrees, so the row cannot read as empty while holding rows.
		expect((serverDb.getMessageCounts() as Record<string, number>)[chatId]).toBe(rows.length);
	});

	test('a row that cannot land takes the whole import with it', () => {
		const { chatId, rows, rootId, leafId } = story(30);
		// parent_id is a foreign key, so a turn naming a parent that is not in the file (and
		// never will be) fails the insert. This is the shape a truncated or hand-edited export
		// arrives in, and it must not leave half a story behind.
		rows.splice(15, 0, messageRow(chatId, `${chatId}-stray`, 'a-turn-that-does-not-exist'));

		expect(() => serverDb.importChat(chatRow(chatId, rootId, leafId), rows)).toThrow();

		expect(serverDb.getChat(chatId)).toBeNull();
		expect(serverDb.getMessagesByChat(chatId)).toHaveLength(0);
	});

	test('rolling one import back leaves every other chat standing', () => {
		const keeper = story(5);
		serverDb.importChat(chatRow(keeper.chatId, keeper.rootId, keeper.leafId), keeper.rows);

		const doomed = story(5);
		// A second row claiming an id already used in this same file: the insert cannot land.
		doomed.rows.push(messageRow(doomed.chatId, doomed.rootId, doomed.leafId));
		expect(() =>
			serverDb.importChat(chatRow(doomed.chatId, doomed.rootId, doomed.leafId), doomed.rows)
		).toThrow();

		expect(serverDb.getChat(doomed.chatId)).toBeNull();
		expect(serverDb.getMessagesByChat(doomed.chatId)).toHaveLength(0);
		expect(serverDb.getMessagesByChat(keeper.chatId)).toHaveLength(5);
		expect((serverDb.getChat(keeper.chatId) as any).activeLeafId).toBe(keeper.leafId);
	});
});
