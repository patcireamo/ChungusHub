/**
 * Deleting a turn from the transcript, driven through the real message store against the
 * real server database, so the server's own pointer repair and deltas are what the store
 * meets. Run with `bun test`.
 *
 * What is under test is what the reader sees: the transcript moves from the story before
 * the delete to the story after it in ONE change. Every server call the delete makes is a
 * point where the page can paint, and a path left empty at any of them draws the whole chat
 * as a new one, opening-scene card included, until the next load puts it back.
 *
 * Same env dance as server/messageRev.test.ts: CHUNGUS_DATA_DIR is pinned to a throwaway
 * dir before the first db call, so nothing here can touch real user-data. Runes are shimmed
 * as in transcript-refresh.test.ts.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const identity = <T>(value?: T): T | undefined => value;
(globalThis as unknown as { $state: unknown }).$state = Object.assign(identity, { raw: identity });
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(identity, {
	by: <T>(fn: () => T): T => fn()
});

let dataDir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverDb: any;

const realDatabase = { ...(await import('$lib/services/database')) };
const realTransport = { ...(await import('$lib/services/transport')) };
const realMemory = { ...(await import('$lib/memory/store.svelte')) };

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-message-delete-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('../../../server/db'));
	serverDb.closeForTests();
});

afterAll(() => {
	mock.module('$lib/services/database', () => realDatabase);
	mock.module('$lib/services/transport', () => realTransport);
	mock.module('$lib/memory/store.svelte', () => realMemory);
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

/** The path on screen at every server call, and once more when the delete returns. */
let frames: string[] = [];
const frame = () => {
	const ids = chatStore.currentChatState?.activePath.map((m) => labelOf.get(m.id) ?? m.id) ?? [];
	const drawn = ids.join('>') || '(empty)';
	if (frames.at(-1) !== drawn) frames.push(drawn);
};

// Every RPC lands on the real server method, through a clone, as the wire would carry it.
mock.module('$lib/services/database', () => ({
	...realDatabase,
	db: new Proxy(
		{},
		{
			get: (_, name: string) =>
				async (...args: unknown[]) => {
					frame();
					return structuredClone(serverDb[name](...args));
				}
		}
	)
}));
mock.module('$lib/services/transport', () => ({ ...realTransport, llmStatus: async () => [], stopGeneration: () => {} }));
mock.module('$lib/memory/store.svelte', () => ({
	...realMemory,
	memoryStore: {
		activeChatId: null,
		loadForChat: async () => {},
		syncForPath: async () => {},
		clear: () => {},
		invalidateMessage: async () => false
	}
}));

const { chatStore } = await import('./chat.svelte');
const { messageStore } = await import('./messages.svelte');

let clock = 1_700_000_000_000;
let chatId = '';
const idOf = new Map<string, string>();
const labelOf = new Map<string, string>();

function add(label: string, parent: string | null, role: string, siblingIndex = 0): void {
	const id = crypto.randomUUID();
	idOf.set(label, id);
	labelOf.set(id, label);
	serverDb.insertMessage({
		id,
		chatId,
		parentId: parent === null ? null : idOf.get(parent),
		role,
		content: `${label} text`,
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
}

/** Open the chat with `leaf` as the branch being read. */
async function open(leaf: string): Promise<void> {
	serverDb.updateChat({ id: chatId, rootMessageId: idOf.get('greeting'), activeLeafId: idOf.get(leaf) });
	chatStore.chats = [serverDb.getChat(chatId)];
	chatStore.activeChatId = chatId;
	chatStore.currentChatState = null;
	await chatStore.loadChatState(chatId);
	frames = [];
	frame();
}

beforeEach(() => {
	chatId = crypto.randomUUID();
	idOf.clear();
	labelOf.clear();
	serverDb.insertChat({
		id: chatId,
		title: 'Delete chat',
		createdAt: clock,
		updatedAt: clock,
		rootMessageId: null,
		activeLeafId: null,
		canonLeafId: null,
		settings: null,
		characterId: null,
		characterVersionId: null
	});
	add('greeting', null, 'assistant');
	add('user', 'greeting', 'user');
	add('reply', 'user', 'assistant');
});

describe('deleting from the transcript', () => {
	test('the newest turn goes in one change', async () => {
		await open('reply');
		await messageStore.deleteMessage(idOf.get('reply')!, 'this_only');
		frame();
		expect(frames).toEqual(['greeting>user>reply', 'greeting>user']);
	});

	test('a swipe hands over to the one beside it in one change', async () => {
		add('swipe', 'user', 'assistant', 1);
		await open('reply');
		await messageStore.deleteMessage(idOf.get('reply')!, 'this_only');
		frame();
		expect(frames).toEqual(['greeting>user>reply', 'greeting>user>swipe']);
	});

	test('a whole branch hands over to the fork beside it in one change', async () => {
		add('other', 'greeting', 'user', 1);
		add('other-reply', 'other', 'assistant');
		await open('reply');
		await messageStore.deleteMessage(idOf.get('user')!, 'with_descendants');
		frame();
		expect(frames).toEqual(['greeting>user>reply', 'greeting>other>other-reply']);
	});
});
