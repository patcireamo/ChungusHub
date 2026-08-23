/**
 * `getNextSiblingIndex`, against the REAL server database (bun:sqlite).
 *
 * The case with no other home is the one every chat's roots share: they all carry
 * `parent_id = NULL`, so an unscoped query answers a brand new chat with the highest root
 * index anywhere in the install. Nothing on screen shows it (an index is read as an ordering
 * within its own sibling set), which is exactly why it needs a test rather than an eye.
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
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-siblingindex-'));
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

let clock = 1_700_000_000_000;

function makeChat(title: string): string {
	const id = crypto.randomUUID();
	serverDb.insertChat({
		id,
		title,
		createdAt: clock,
		updatedAt: clock,
		rootMessageId: null,
		activeLeafId: null,
		canonLeafId: null,
		settings: null,
		characterId: null,
		characterVersionId: null
	});
	return id;
}

function addMessage(chatId: string, parentId: string | null, role: string, siblingIndex = 0): string {
	const id = crypto.randomUUID();
	serverDb.insertMessage({
		id,
		chatId,
		parentId,
		role,
		content: 'a line',
		personaId: null,
		branchLabel: null,
		thinking: null,
		attachments: null,
		createdAt: (clock += 1000),
		editedAt: null,
		model: null,
		provider: null,
		tokensPrompt: null,
		tokensCompletion: null,
		finishReason: null,
		generationMs: null,
		siblingIndex
	});
	return id;
}

describe('getNextSiblingIndex', () => {
	test('another chat’s roots never number this one’s', () => {
		const older = makeChat('An old story');
		addMessage(older, null, 'assistant', 12);

		const fresh = makeChat('A greetingless chat');
		expect(serverDb.getNextSiblingIndex(fresh, null)).toBe(0);

		// And the older chat still numbers off its own roots.
		expect(serverDb.getNextSiblingIndex(older, null)).toBe(13);
	});

	test('a new root lands after this chat’s seeded greetings', () => {
		const chatId = makeChat('Two greetings');
		addMessage(chatId, null, 'assistant', 0);
		addMessage(chatId, null, 'assistant', 1);

		expect(serverDb.getNextSiblingIndex(chatId, null)).toBe(2);
	});

	test('counts the highest index, not how many rows there are', () => {
		// A deleted greeting leaves a gap, and reusing an index would put the new row on
		// top of one that is still there.
		const chatId = makeChat('A gap in the roots');
		addMessage(chatId, null, 'assistant', 0);
		addMessage(chatId, null, 'assistant', 4);

		expect(serverDb.getNextSiblingIndex(chatId, null)).toBe(5);
	});

	test('a root query ignores everything below the roots', () => {
		const chatId = makeChat('Deep chat');
		const greeting = addMessage(chatId, null, 'assistant', 0);
		addMessage(chatId, greeting, 'user', 9);

		expect(serverDb.getNextSiblingIndex(chatId, null)).toBe(1);
	});

	test('swipes number off their own parent', () => {
		const chatId = makeChat('A swiped reply');
		const greeting = addMessage(chatId, null, 'assistant', 0);
		const user = addMessage(chatId, greeting, 'user', 0);
		addMessage(chatId, user, 'assistant', 0);
		addMessage(chatId, user, 'assistant', 1);

		expect(serverDb.getNextSiblingIndex(chatId, user)).toBe(2);
		expect(serverDb.getNextSiblingIndex(chatId, greeting)).toBe(1);
	});
});

describe('a splice delete re-parents inside its own chat', () => {
	test('children of a deleted root take indexes after this chat’s roots', () => {
		const loud = makeChat('A chat with a high root');
		addMessage(loud, null, 'assistant', 30);

		const chatId = makeChat('A spliced greeting');
		const greeting = addMessage(chatId, null, 'assistant', 0);
		const reply = addMessage(chatId, greeting, 'user', 0);

		serverDb.deleteMessageOnly(greeting);

		const rows = serverDb.getMessagesByChat(chatId) as any[];
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(reply);
		expect(rows[0].parentId).toBeNull();
		// The base is read before the greeting goes, so the child lands one past it: never 31.
		expect(rows[0].siblingIndex).toBe(1);
	});
});
