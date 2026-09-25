/**
 * Rewriting a reply to a note, driven through the real message store against the real server
 * database, with the server's own commit landing the new turn. Run with `bun test`.
 *
 * The prompt builder and the model call are stubbed: assembly has its own tests, and what is
 * under test here is what the store hands the build, which connection the request rides, and
 * what the retry's commit does with the answer. Same env dance and rune shims as
 * message-delete.test.ts, so nothing here can touch real user-data.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuiltPrompt, PromptBuildContext } from '$lib/utils/prompt-builder';
import { EMPTY_LOREBOOK_TRACE } from '$lib/lorebook/types';

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
const realProvider = { ...(await import('$lib/services/llm/provider')) };
const realBuilder = { ...(await import('$lib/utils/prompt-builder')) };
const realSound = { ...(await import('$lib/services/notificationSound')) };
const realHold = { ...(await import('$lib/stores/promptHold.svelte')) };

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-message-rewrite-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('../../../server/db'));
	serverDb.closeForTests();
});

afterAll(() => {
	mock.module('$lib/services/database', () => realDatabase);
	mock.module('$lib/services/transport', () => realTransport);
	mock.module('$lib/memory/store.svelte', () => realMemory);
	mock.module('$lib/services/llm/provider', () => realProvider);
	mock.module('$lib/utils/prompt-builder', () => realBuilder);
	mock.module('$lib/services/notificationSound', () => realSound);
	mock.module('$lib/stores/promptHold.svelte', () => realHold);
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

let builds: PromptBuildContext[] = [];
let calls: { target: unknown; source: unknown }[] = [];
let reviewCancels = false;

mock.module('$lib/services/database', () => ({
	...realDatabase,
	db: new Proxy(
		{},
		{
			get: (_, name: string) =>
				async (...args: unknown[]) =>
					structuredClone(serverDb[name](...args))
		}
	)
}));
mock.module('$lib/services/transport', () => ({ ...realTransport, llmStatus: async () => [], stopGeneration: () => {} }));
mock.module('$lib/memory/store.svelte', () => ({
	...realMemory,
	memoryStore: {
		activeChatId: null,
		enabled: false,
		loadForChat: async () => {},
		syncForPath: async () => {},
		clear: () => {},
		invalidateMessage: async () => false,
		maintainAfterTurn: () => {}
	}
}));
mock.module('$lib/services/notificationSound', () => ({ ...realSound, notifySound: () => {} }));
mock.module('$lib/stores/promptHold.svelte', () => ({
	...realHold,
	promptHoldStore: { review: async (_gate: unknown, messages: unknown) => (reviewCancels ? null : messages) }
}));
mock.module('$lib/utils/prompt-builder', () => ({
	...realBuilder,
	buildPromptMessages: async (context: PromptBuildContext): Promise<BuiltPrompt> => {
		builds.push(context);
		return {
			messages: [{ role: 'user', content: 'the built prompt' }],
			target: 'primary',
			lorebook: EMPTY_LOREBOOK_TRACE,
			oneShotSteering: []
		};
	}
}));
// The server writes the turn from the placement the request carries, exactly as it does live.
mock.module('$lib/services/llm/provider', () => ({
	...realProvider,
	llmService: {
		complete: async (target: unknown, options: { source?: string; commit: Record<string, unknown> }) => {
			calls.push({ target, source: options.source });
			const landed = serverDb.commitGeneratedTurn({
				...options.commit,
				content: 'Rewritten.',
				thinking: null,
				model: 'scripted',
				provider: 'openrouter',
				tokensPrompt: 10,
				tokensCompletion: 5,
				finishReason: 'stop',
				generationMs: 1,
				firstTokenMs: null,
				reasoningMs: null
			});
			return {
				content: 'Rewritten.',
				thinking: null,
				model: 'scripted',
				finishReason: 'stop',
				usage: { promptTokens: 10, completionTokens: 5 },
				committedMessageId: landed?.messageId ?? null,
				spentSteeringIds: landed?.spentSteeringIds ?? []
			};
		}
	}
}));

const { chatStore } = await import('./chat.svelte');
const { messageStore } = await import('./messages.svelte');
const { toastStore } = await import('./toast.svelte');

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

async function open(leaf: string): Promise<void> {
	serverDb.updateChat({ id: chatId, rootMessageId: idOf.get('greeting'), activeLeafId: idOf.get(leaf) });
	chatStore.chats = [serverDb.getChat(chatId)];
	chatStore.activeChatId = chatId;
	chatStore.currentChatState = null;
	await chatStore.loadChatState(chatId);
}

const labels = (messages: { id: string }[]): string[] => messages.map((m) => labelOf.get(m.id) ?? 'new');
const onScreen = (): string[] => labels(chatStore.currentChatState?.activePath ?? []);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stored = (label: string): boolean => serverDb.getMessagesByChat(chatId).some((m: any) => m.id === idOf.get(label));
// The store toasts its own failures and returns normally, so a success has to say it saw none.
const failures = (): string[] => toastStore.toasts.filter((t) => t.tone === 'error').map((t) => t.message);

beforeEach(() => {
	builds = [];
	calls = [];
	reviewCancels = false;
	toastStore.toasts = [];
	chatId = crypto.randomUUID();
	idOf.clear();
	labelOf.clear();
	serverDb.insertChat({
		id: chatId,
		title: 'Rewrite chat',
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

describe('rewriting a reply to a note', () => {
	test('the build gets the reply and the trimmed note, and no connection of its own', async () => {
		await open('reply');
		await messageStore.retryMessageResponse(idOf.get('reply')!, 'branch', '  Make it rain.  ');

		expect(builds).toHaveLength(1);
		const [build] = builds;
		expect(build.rewrite?.message.id).toBe(idOf.get('reply'));
		expect(build.rewrite?.note).toBe('Make it rain.');
		// The retry's own prompt: the path up to the parent, scanned as a swipe.
		expect(labels(build.chatMessages)).toEqual(['greeting', 'user']);
		expect(build.lorebookTrigger).toBe('swipe');
		// No target of its own, so the build resolves the chat's connection like any retry.
		expect(build.target).toBeUndefined();
		expect(calls).toEqual([{ target: 'primary', source: 'rewrite' }]);
		expect(failures()).toEqual([]);
	});

	test('Keep both lands the rewrite beside the reply and reads it', async () => {
		await open('reply');
		await messageStore.retryMessageResponse(idOf.get('reply')!, 'branch', 'Make it rain.');

		expect(stored('reply')).toBe(true);
		expect(onScreen()).toEqual(['greeting', 'user', 'new']);
		expect(chatStore.currentChatState?.activePath.at(-1)?.content).toBe('Rewritten.');
		expect(failures()).toEqual([]);
	});

	test('Replace deletes the reply once the rewrite has landed', async () => {
		await open('reply');
		await messageStore.retryMessageResponse(idOf.get('reply')!, 'replace', 'Make it rain.');

		expect(stored('reply')).toBe(false);
		expect(onScreen()).toEqual(['greeting', 'user', 'new']);
		expect(failures()).toEqual([]);
	});

	test('the reply is read as it stands now, not as the transcript last loaded it', async () => {
		await open('reply');
		serverDb.updateMessageContent(idOf.get('reply')!, 'Edited on another device.');
		await messageStore.retryMessageResponse(idOf.get('reply')!, 'branch', 'Make it rain.');

		expect(builds[0].rewrite?.message.content).toBe('Edited on another device.');
		expect(failures()).toEqual([]);
	});

	test('a blank note is a plain retry', async () => {
		await open('reply');
		await messageStore.retryMessageResponse(idOf.get('reply')!, 'branch', '   ');

		expect(builds).toHaveLength(1);
		expect(builds[0].rewrite).toBeUndefined();
		expect(calls).toEqual([{ target: 'primary', source: 'chat' }]);
		expect(failures()).toEqual([]);
	});

	test('a note on a turn of the reader is refused before anything is built', async () => {
		await open('user');
		await messageStore.retryMessageResponse(idOf.get('user')!, 'branch', 'Make it rain.');

		expect(builds).toHaveLength(0);
		expect(calls).toHaveLength(0);
		expect(toastStore.toasts.map((t) => t.message)).toEqual([
			"Couldn't rewrite the reply: This turn is yours, and only a reply can be rewritten"
		]);
	});

	test('a cancelled review leaves the chat exactly as it was', async () => {
		reviewCancels = true;
		await open('reply');
		await messageStore.retryMessageResponse(idOf.get('reply')!, 'replace', 'Make it rain.');

		expect(builds).toHaveLength(1);
		expect(calls).toHaveLength(0);
		expect(stored('reply')).toBe(true);
		expect(onScreen()).toEqual(['greeting', 'user', 'reply']);
	});
});
