/**
 * Transcript loads that overlap: the answer that comes back last is not the one that read
 * last, and the older one must never publish over the newer. Run with `bun test`.
 *
 * Two loads are in flight constantly in ordinary use, because a mutation awaits its own
 * refresh while the sync replay `endStream` fires runs unawaited beside it. Publishing the
 * older answer puts a deleted turn back, reverts an edit and moves the branch being read,
 * and nothing corrects it until the next refresh, so each half gets its own case here.
 *
 * Runes are compile-time macros and nothing compiles the store under bun test, so `$state`
 * and `$derived` are shimmed to identity BEFORE the store module loads, exactly as
 * new-chat-flow.test.ts does. Ordering is under test; reactivity is not.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';

const identity = <T>(value?: T): T | undefined => value;
(globalThis as unknown as { $state: unknown }).$state = Object.assign(identity, { raw: identity });
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(identity, {
	by: <T>(fn: () => T): T => fn()
});

type Delta =
	| { rev: number; full: true; messages: unknown[] }
	| { rev: number; full: false; upserts: unknown[]; deletedIds: string[] };

/** Deltas the fake server owes, one entry per call, each settled by hand so the test
 *  decides which read comes back first. */
let owed: { resolve: (delta: Delta) => void }[] = [];

const CHAT = { id: 'chat-1', title: 'Overlap', activeLeafId: 'reply', rootMessageId: 'greeting' };
/** The chat row as the server currently holds it. Moved between reads to model a swipe,
 *  which changes this row and no message row at all. */
let serverChat = { ...CHAT };

/**
 * Bun's module registry is process-wide and one run loads every test file into it, so a stub
 * left behind here is served to every file that loads after this one, in whatever order the
 * platform happens to walk the directory. Each mock is therefore a SPREAD of the real module,
 * so nothing an importer expects can go missing, and every one is put back in `afterAll`.
 * Only the three the load path actually reaches are stubbed; the rest of the store's imports
 * are left real, since none of them runs at import and none is called from here.
 *
 * The restore is registered BEFORE the first stub goes in, so a throw anywhere in the setup
 * below cannot leave one standing.
 */
const realDatabase = { ...(await import('$lib/services/database')) };
const realTransport = { ...(await import('$lib/services/transport')) };
const realMemory = { ...(await import('$lib/memory/store.svelte')) };

afterAll(() => {
	mock.module('$lib/services/database', () => realDatabase);
	mock.module('$lib/services/transport', () => realTransport);
	mock.module('$lib/memory/store.svelte', () => realMemory);
});

mock.module('$lib/services/database', () => ({
	...realDatabase,
	db: {
		getChat: async () => ({ ...serverChat }),
		getMessagesDelta: () => new Promise<Delta>((resolve) => owed.push({ resolve })),
		getAllChats: async () => [{ ...serverChat }]
	}
}));
mock.module('$lib/services/transport', () => ({
	...realTransport,
	llmStatus: async () => [],
	stopGeneration: () => {}
}));
mock.module('$lib/memory/store.svelte', () => ({
	...realMemory,
	memoryStore: { activeChatId: null, loadForChat: async () => {}, syncForPath: async () => {}, clear: () => {} }
}));

const { chatStore } = await import('./chat.svelte');

const row = (id: string, parentId: string | null, role: string, content = `${id} text`) => ({
	id,
	chatId: CHAT.id,
	parentId,
	role,
	content,
	siblingIndex: 0
});

const BASE = [row('greeting', null, 'assistant'), row('user', 'greeting', 'user'), row('reply', 'user', 'assistant')];
const EDITED_USER = row('user', 'greeting', 'user', 'rewritten');

beforeEach(() => {
	owed = [];
	serverChat = { ...CHAT };
	chatStore.activeChatId = CHAT.id;
	chatStore.currentChatState = {
		chat: { ...CHAT },
		activePath: [...BASE],
		allMessages: [...BASE],
		messagesRev: 5
	} as never;
});

/** Let the store's own awaits drain, so the load has reached its delta and parked there. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Two overlapping loads, both parked on their delta: `stale` read first, `current` second. */
async function overlap(): Promise<{ stale: Promise<void>; current: Promise<void> }> {
	const stale = chatStore.loadChatState(CHAT.id);
	await settle();
	const current = chatStore.loadChatState(CHAT.id);
	await settle();
	expect(owed).toHaveLength(2);
	return { stale, current };
}

/** What the older read answers: the moment before the mutation, so nothing changed. */
const NOTHING_CHANGED: Delta = { rev: 5, full: false, upserts: [], deletedIds: [] };

const ids = () => chatStore.currentChatState!.allMessages.map((m) => m.id);
const userTurn = () => chatStore.currentChatState!.allMessages.find((m) => m.id === 'user')!.content;

describe('overlapping transcript loads', () => {
	test('a delete that landed is not undone by a read that started before it', async () => {
		const { stale, current } = await overlap();

		owed[1].resolve({ rev: 6, full: false, upserts: [], deletedIds: ['reply'] });
		await current;
		expect(ids()).toEqual(['greeting', 'user']);

		owed[0].resolve(NOTHING_CHANGED);
		await stale;

		expect(chatStore.currentChatState!.messagesRev).toBe(6);
		expect(ids()).toEqual(['greeting', 'user']);
	});

	test('an edit that landed is not undone by a read that started before it', async () => {
		const { stale, current } = await overlap();

		owed[1].resolve({ rev: 6, full: false, upserts: [EDITED_USER], deletedIds: [] });
		await current;
		expect(userTurn()).toBe('rewritten');

		owed[0].resolve(NOTHING_CHANGED);
		await stale;

		expect(userTurn()).toBe('rewritten');
	});

	test('the branch being read is not moved back, though no message row changed', async () => {
		const stale = chatStore.loadChatState(CHAT.id);
		await settle();
		// A swipe: the chat row moves to another sibling and the rev does not move at all,
		// so nothing about the messages can tell these two reads apart.
		serverChat = { ...CHAT, activeLeafId: 'reply-2' };
		const current = chatStore.loadChatState(CHAT.id);
		await settle();

		owed[1].resolve({ rev: 5, full: false, upserts: [row('reply-2', 'user', 'assistant')], deletedIds: [] });
		await current;
		expect(chatStore.currentChatState!.chat.activeLeafId).toBe('reply-2');

		owed[0].resolve(NOTHING_CHANGED);
		await stale;

		expect(chatStore.currentChatState!.chat.activeLeafId).toBe('reply-2');
	});

	test('a read for a chat the reader has left publishes nothing', async () => {
		const stale = chatStore.loadChatState(CHAT.id);
		await settle();
		// goHome, or the chat deleted under a sync: both null the pair together.
		chatStore.activeChatId = null;
		chatStore.currentChatState = null;

		owed[0].resolve(NOTHING_CHANGED);
		await stale;

		expect(chatStore.currentChatState).toBeNull();
	});

	test('a load that stood down leaves the next read current, not stale', async () => {
		// The rows a prompt is built from are re-read per build, and that read is asked
		// against the rev the store holds, so standing down must not strand it behind.
		const { stale, current } = await overlap();
		owed[1].resolve({ rev: 6, full: false, upserts: [EDITED_USER], deletedIds: [] });
		await current;
		owed[0].resolve(NOTHING_CHANGED);
		await stale;

		const fresh = chatStore.freshMessages(CHAT.id);
		await settle();
		owed[2].resolve({ rev: 7, full: false, upserts: [], deletedIds: ['reply'] });

		expect((await fresh).find((m) => m.id === 'user')!.content).toBe('rewritten');
		expect(ids()).toEqual(['greeting', 'user']);
	});
});
