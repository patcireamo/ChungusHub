/**
 * The message delta protocol, against the real database.
 *
 * The invariant under test: every write to a messages row advances its chat's
 * `messages_rev` and carries the new value (deletes record it on tombstones), so
 * `getMessagesDelta(chatId, sinceRev)` returns exactly what changed. A writer that
 * forgets leaves every other device silently holding the old row until something else
 * touches the chat, which no manual test ever catches. The behavioral half exercises
 * each write door; the scan at the bottom catches the writer nobody wrote a test for.
 *
 * Same env dance as chatList.test.ts: CHUNGUS_DATA_DIR pinned to a throwaway dir
 * before the first db call, so nothing here can touch real user-data.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

let dataDir: string;
let serverDb: any;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-messagerev-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('./db'));
	serverDb.closeForTests();
});

afterAll(() => {
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

let clock = 1_700_000_000_000;

function makeChat(): string {
	const id = crypto.randomUUID();
	serverDb.insertChat({
		id,
		title: 'Rev chat',
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

function addMessage(chatId: string, parentId: string | null, role: string, content: string, siblingIndex = 0): string {
	const id = crypto.randomUUID();
	serverDb.insertMessage({
		id,
		chatId,
		parentId,
		role,
		content,
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

type Delta =
	| { rev: number; full: true; messages: { id: string }[] }
	| { rev: number; full: false; upserts: { id: string }[]; deletedIds: string[] };

const delta = (chatId: string, since: number | null): Delta | null => serverDb.getMessagesDelta(chatId, since);

/** One chain: greeting -> user -> reply, chat pointers set. */
function seedChain(): { chatId: string; greeting: string; user: string; reply: string } {
	const chatId = makeChat();
	const greeting = addMessage(chatId, null, 'assistant', 'Hello.');
	const user = addMessage(chatId, greeting, 'user', 'Hi.');
	const reply = addMessage(chatId, user, 'assistant', 'The door opened.');
	serverDb.updateChat({ id: chatId, rootMessageId: greeting, activeLeafId: reply });
	return { chatId, greeting, user, reply };
}

describe('getMessagesDelta', () => {
	test('a fresh open reads full, and a later ask costs only what changed', () => {
		const { chatId, reply } = seedChain();
		const d0 = delta(chatId, null)!;
		expect(d0.full).toBe(true);
		if (!d0.full) throw new Error('unreachable');
		expect(d0.messages).toHaveLength(3);

		serverDb.updateMessageContent(reply, 'The door stayed shut.');
		const d1 = delta(chatId, d0.rev)!;
		expect(d1.full).toBe(false);
		if (d1.full) throw new Error('unreachable');
		expect(d1.upserts.map((m) => m.id)).toEqual([reply]);
		expect(d1.deletedIds).toEqual([]);

		const d2 = delta(chatId, d1.rev)!;
		if (d2.full) throw new Error('a caught-up client must not be handed the transcript');
		expect(d2.upserts).toEqual([]);
		expect(d2.deletedIds).toEqual([]);
	});

	test('a leaf move (the swipe shape) changes no message rows', () => {
		const { chatId, user } = seedChain();
		const base = delta(chatId, null)!.rev;
		serverDb.updateChatActiveLeaf(chatId, user, { touchUpdatedAt: false });
		const d = delta(chatId, base)!;
		if (d.full) throw new Error('unreachable');
		expect(d.upserts).toEqual([]);
		expect(d.deletedIds).toEqual([]);
	});

	test('a splice ships the re-parented children and tombstones the spliced row', () => {
		const { chatId, user, reply } = seedChain();
		const child = addMessage(chatId, reply, 'user', 'And then?');
		const base = delta(chatId, null)!.rev;

		serverDb.deleteMessageOnly(reply);
		const d = delta(chatId, base)!;
		if (d.full) throw new Error('unreachable');
		expect(d.upserts.map((m) => m.id)).toEqual([child]);
		expect(d.deletedIds).toEqual([reply]);
		// The shipped child already carries its new place in the tree.
		expect((d.upserts[0] as any).parentId).toBe(user);
	});

	test('a subtree delete tombstones every row it took', () => {
		const { chatId, user, reply } = seedChain();
		const child = addMessage(chatId, reply, 'user', 'More.');
		const base = delta(chatId, null)!.rev;

		serverDb.deleteMessageAndDescendants(user);
		const d = delta(chatId, base)!;
		if (d.full) throw new Error('unreachable');
		expect(d.upserts).toEqual([]);
		expect(new Set(d.deletedIds)).toEqual(new Set([user, reply, child]));
	});

	test('metadata writes move their row: branch label, sprite label, persona, continuation', () => {
		const { chatId, user, reply } = seedChain();
		let rev = delta(chatId, null)!.rev;
		const one = (expected: string) => {
			const d = delta(chatId, rev)!;
			if (d.full) throw new Error('unreachable');
			expect(d.upserts.map((m) => m.id)).toEqual([expected]);
			rev = d.rev;
		};

		serverDb.updateMessageBranchLabel(reply, { name: 'Fork', color: 'amber' });
		one(reply);
		serverDb.updateMessageSpriteLabel(reply, 'smug');
		one(reply);
		serverDb.updateMessagePersona(user, null);
		one(user);
		serverDb.applyMessageContinuation(reply, {
			content: 'The door opened. Wider.',
			thinking: null,
			tokensPrompt: 1,
			tokensCompletion: 2,
			finishReason: 'stop',
			generationMs: 3,
			reasoningMs: null
		});
		one(reply);
	});

	test('a bulk persona rebind ships exactly the user turns', () => {
		const { chatId, user } = seedChain();
		const base = delta(chatId, null)!.rev;
		serverDb.setChatUserPersona(chatId, 'persona-1');
		const d = delta(chatId, base)!;
		if (d.full) throw new Error('unreachable');
		expect(d.upserts.map((m) => m.id)).toEqual([user]);
	});

	test('a rev this database never issued answers full, not a guess', () => {
		const { chatId } = seedChain();
		const d = delta(chatId, 999_999)!;
		expect(d.full).toBe(true);
	});

	test('a missing chat answers null, and deleting one cascades its tombstones', () => {
		const { chatId, reply } = seedChain();
		serverDb.deleteMessageAndDescendants(reply);
		serverDb.deleteChat(chatId);
		expect(delta(chatId, null)).toBeNull();
		const probe = new Database(join(dataDir, 'chungushub.db'), { readonly: true });
		try {
			const left = probe
				.query('SELECT COUNT(*) AS n FROM message_tombstones WHERE chat_id = ?')
				.get(chatId) as { n: number };
			expect(left.n).toBe(0);
		} finally {
			probe.close();
		}
	});

	test('a duplicated chat rests at rev 0 and lives its own revision line', () => {
		const { chatId } = seedChain();
		const copyId = serverDb.duplicateChat({ chatId, title: 'Copy', includeMemory: false });
		const d0 = delta(copyId, null)!;
		expect(d0.full).toBe(true);
		expect(d0.rev).toBe(0);
		if (!d0.full) throw new Error('unreachable');
		const copiedRow = d0.messages[0].id;
		serverDb.updateMessageContent(copiedRow, 'Copy edit.');
		const d1 = delta(copyId, 0)!;
		if (d1.full) throw new Error('unreachable');
		expect(d1.upserts.map((m) => m.id)).toEqual([copiedRow]);
	});

	test('a message for a chat that does not exist is refused loudly', () => {
		expect(() => addMessage(crypto.randomUUID(), null, 'assistant', 'Orphan.')).toThrow(/no chat/);
	});
});

describe('every message writer stamps', () => {
	// The net for the writer nobody wrote a behavioral test for: each statement that
	// touches the messages table must carry the rev stamp (inserts/updates) or sit
	// beside its tombstone record (deletes). duplicateChat is the one exemption and
	// says so in place: a fresh chat id no device holds a rev for.
	const source = readFileSync(join(import.meta.dir, 'db.ts'), 'utf8');

	test('inserts and updates carry rev, deletes record tombstones', () => {
		const offenders: string[] = [];
		const statements = [...source.matchAll(/INSERT INTO messages|UPDATE messages|DELETE FROM messages/g)];
		expect(statements.length).toBeGreaterThan(0);
		for (const m of statements) {
			const before = source.slice(Math.max(0, m.index! - 700), m.index!);
			const after = source.slice(m.index!, m.index! + 700);
			const line = source.slice(0, m.index!).split('\n').length;
			if (m[0] === 'DELETE FROM messages') {
				if (!before.includes('recordMessageTombstones')) offenders.push(`db.ts:${line} delete without tombstones`);
			} else if (!/\brev\b/.test(after.slice(0, after.indexOf('WHERE') > 0 ? after.indexOf('WHERE') : 700))) {
				if (!before.includes('No rev stamp')) offenders.push(`db.ts:${line} write without rev`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
