import { describe, it, expect } from 'bun:test';
import { convertSillyTavernChat, readChatCharacterName } from './sillyTavernChatImport';

// A trimmed but faithful slice of a real SillyTavern chat export: metadata header,
// a greeting (single swipe), a user turn, then an assistant turn with two swipes
// where swipe_id points at the SECOND one (the active timeline).
const LINES = [
	JSON.stringify({ chat_metadata: { integrity: 'x' }, user_name: 'unused', character_name: 'unused' }),
	JSON.stringify({
		name: 'Seraphina',
		is_user: false,
		is_system: false,
		send_date: 'October 24, 2025 6:15pm',
		mes: 'Ah, you are awake at last.',
		extra: { reasoning: '' },
		swipes: ['Ah, you are awake at last.'],
		swipe_id: 0
	}),
	JSON.stringify({
		name: 'Anon',
		is_user: true,
		is_system: false,
		send_date: '2026-07-21T23:12:46.640Z',
		mes: '"Who are you?"',
		extra: { token_count: 6 }
	}),
	JSON.stringify({
		name: 'Seraphina',
		is_user: false,
		is_system: false,
		send_date: '2026-07-21T23:13:13.904Z',
		mes: 'I am the guardian of this glade.',
		extra: {
			api: 'custom',
			model: 'google/gemma-4-31b-qat',
			reasoning: 'active-reasoning',
			token_count: 903,
			time_to_first_token: 900,
			reasoning_duration: 4100
		},
		gen_started: '2026-07-21T23:13:08.904Z',
		gen_finished: '2026-07-21T23:13:13.904Z',
		swipes: ['I am Seraphina, keeper of Eldoria.', 'I am the guardian of this glade.'],
		swipe_id: 1,
		swipe_info: [
			{
				send_date: '2026-07-21T23:12:49.243Z',
				gen_started: '2026-07-21T23:12:45.000Z',
				gen_finished: '2026-07-21T23:12:49.243Z',
				extra: {
					api: 'custom',
					model: 'google/gemma-4-31b-qat',
					reasoning: 'swipe0-reasoning',
					token_count: 791,
					time_to_first_token: 1200,
					reasoning_duration: 3000
				}
			},
			{
				send_date: '2026-07-21T23:13:13.904Z',
				gen_started: '2026-07-21T23:13:08.904Z',
				gen_finished: '2026-07-21T23:13:13.904Z',
				extra: {
					api: 'custom',
					model: 'google/gemma-4-31b-qat',
					reasoning: 'swipe1-reasoning',
					token_count: 903,
					time_to_first_token: 900,
					reasoning_duration: 4100
				}
			}
		]
	})
];

describe('convertSillyTavernChat', () => {
	let counter = 0;
	const seededId = () => `id-${counter++}`;

	const result = convertSillyTavernChat(LINES, { chatId: 'chat-1', baseTime: 1000 }, seededId);

	it('emits one node per swipe and skips the metadata header', () => {
		// greeting(1) + user(1) + assistant(2) = 4 nodes
		expect(result.messages).toHaveLength(4);
	});

	it('makes the first message the root and the last active swipe the leaf', () => {
		const root = result.messages.find((m) => m.id === result.rootMessageId)!;
		expect(root.parentId).toBeNull();
		expect(root.content).toBe('Ah, you are awake at last.');

		const leaf = result.messages.find((m) => m.id === result.activeLeafId)!;
		expect(leaf.content).toBe('I am the guardian of this glade.');
		expect(leaf.siblingIndex).toBe(1);
	});

	it('parents every message onto the previous ACTIVE swipe', () => {
		const greeting = result.messages.find((m) => m.content.startsWith('Ah, you'))!;
		const user = result.messages.find((m) => m.role === 'user')!;
		expect(user.parentId).toBe(greeting.id);

		// Both assistant swipes hang off the user turn as siblings.
		const swipes = result.messages.filter((m) => m.role === 'assistant' && m.parentId === user.id);
		expect(swipes).toHaveLength(2);
		expect(swipes.map((s) => s.siblingIndex).sort()).toEqual([0, 1]);
	});

	it('routes the visible timeline through the chosen swipe only', () => {
		const inactive = result.messages.find((m) => m.content.startsWith('I am Seraphina'))!;
		// The unpicked swipe is a dead-end leaf: nothing parents onto it.
		expect(result.messages.some((m) => m.parentId === inactive.id)).toBe(false);
	});

	it('maps per-swipe reasoning, model and token counts', () => {
		const swipe0 = result.messages.find((m) => m.content.startsWith('I am Seraphina'))!;
		const swipe1 = result.messages.find((m) => m.content === 'I am the guardian of this glade.')!;
		expect(swipe0.thinking).toBe('swipe0-reasoning');
		expect(swipe1.thinking).toBe('swipe1-reasoning');
		expect(swipe1.model).toBe('google/gemma-4-31b-qat');
		expect(swipe1.provider).toBe('custom');
		expect(swipe1.tokensCompletion).toBe(903);
	});

	it('never carries reasoning onto user turns', () => {
		const user = result.messages.find((m) => m.role === 'user')!;
		expect(user.thinking).toBeNull();
	});

	it('parses ISO dates and falls back for unparseable ones', () => {
		const user = result.messages.find((m) => m.role === 'user')!;
		expect(user.createdAt).toBe(Date.parse('2026-07-21T23:12:46.640Z'));
	});

	it('times every swipe off its OWN generation, not the message-level stamps', () => {
		const swipe0 = result.messages.find((m) => m.content.startsWith('I am Seraphina'))!;
		const swipe1 = result.messages.find((m) => m.content === 'I am the guardian of this glade.')!;
		expect(swipe0.generationMs).toBe(4243);
		expect(swipe0.firstTokenMs).toBe(1200);
		expect(swipe0.reasoningMs).toBe(3000);
		expect(swipe1.generationMs).toBe(5000);
		expect(swipe1.firstTokenMs).toBe(900);
		expect(swipe1.reasoningMs).toBe(4100);
	});

	it('leaves a turn nobody generated untimed', () => {
		// The greeting came off the card and the user typed their own line: neither is a
		// generation, and the file carries no stamps for either.
		const greeting = result.messages.find((m) => m.content.startsWith('Ah, you'))!;
		const user = result.messages.find((m) => m.role === 'user')!;
		for (const m of [greeting, user]) {
			expect(m.generationMs).toBeNull();
			expect(m.firstTokenMs).toBeNull();
			expect(m.reasoningMs).toBeNull();
		}
	});
});

describe('convertSillyTavernChat: generation timings', () => {
	function convert(message: Record<string, unknown>) {
		let n = 0;
		const lines = [JSON.stringify({ chat_metadata: {} }), JSON.stringify(message)];
		return convertSillyTavernChat(lines, { chatId: 'c', baseTime: 1000 }, () => `id-${n++}`).messages[0];
	}

	it('falls back to the message-level stamps for the active swipe', () => {
		// The common shape: one swipe, so SillyTavern writes the stamps at the top level only.
		const m = convert({
			is_user: false,
			mes: 'hi',
			gen_started: '2026-08-13T14:30:44.156Z',
			gen_finished: '2026-08-13T14:30:51.143Z',
			extra: { time_to_first_token: 3857, reasoning_duration: 6988 }
		});
		expect(m.generationMs).toBe(6987);
		expect(m.firstTokenMs).toBe(3857);
		expect(m.reasoningMs).toBe(6988);
	});

	it('refuses a half pair, an unreadable stamp and a span that runs backwards', () => {
		// Each would produce a number, and every one of those numbers would be a lie.
		expect(convert({ is_user: false, mes: 'a', gen_started: '2026-08-13T14:30:44.156Z' }).generationMs).toBeNull();
		expect(
			convert({ is_user: false, mes: 'a', gen_started: 'sometime tuesday', gen_finished: '2026-08-13T14:30:51.143Z' })
				.generationMs
		).toBeNull();
		expect(
			convert({ is_user: false, mes: 'a', gen_started: '2026-08-13T14:30:51.143Z', gen_finished: '2026-08-13T14:30:44.156Z' })
				.generationMs
		).toBeNull();
	});

	it('refuses a negative or non-numeric duration', () => {
		const m = convert({
			is_user: false,
			mes: 'a',
			extra: { time_to_first_token: -1, reasoning_duration: 'ages' }
		});
		expect(m.firstTokenMs).toBeNull();
		expect(m.reasoningMs).toBeNull();
	});

	it('keeps a measured zero, which is not the same as unmeasured', () => {
		const m = convert({ is_user: false, mes: 'a', extra: { time_to_first_token: 0, reasoning_duration: 0 } });
		expect(m.firstTokenMs).toBe(0);
		expect(m.reasoningMs).toBe(0);
	});

	it('never times a user turn, whatever the file claims', () => {
		const m = convert({
			is_user: true,
			mes: 'typed by hand',
			gen_started: '2026-08-13T14:30:44.156Z',
			gen_finished: '2026-08-13T14:30:51.143Z',
			extra: { time_to_first_token: 3857, reasoning_duration: 6988 }
		});
		expect(m.generationMs).toBeNull();
		expect(m.firstTokenMs).toBeNull();
		expect(m.reasoningMs).toBeNull();
	});
});

describe('convertSillyTavernChat: hidden/ghosted messages', () => {
	it('imports is_system (ghosted) messages, keeping role from is_user', () => {
		// SillyTavern flips is_system to true when a message is hidden from the prompt.
		// Those are still real turns: dropping them would delete history.
		const lines = [
			JSON.stringify({ chat_metadata: {} }),
			JSON.stringify({ name: 'X', is_user: false, is_system: true, mes: 'hi', swipes: ['hi'], swipe_id: 0 }),
			JSON.stringify({ name: 'U', is_user: true, is_system: true, mes: 'hidden question' }),
			JSON.stringify({ name: 'X', is_user: false, mes: 'visible reply' })
		];
		const result = convertSillyTavernChat(lines, { chatId: 'c', baseTime: 0 });
		// Nothing dropped: all three turns land.
		expect(result.messages).toHaveLength(3);
		const [greeting, user, reply] = result.messages;
		// The ghosted user turn keeps its user role (from is_user, not is_system).
		expect(user.role).toBe('user');
		expect(user.content).toBe('hidden question');
		// The chain stays intact through the hidden turns.
		expect(user.parentId).toBe(greeting.id);
		expect(reply.parentId).toBe(user.id);
	});
});

describe('readChatCharacterName', () => {
	it('reads the name off the header line', () => {
		expect(
			readChatCharacterName([JSON.stringify({ chat_metadata: {}, character_name: ' Seraphina ' })])
		).toBe('Seraphina');
	});

	it('skips blank lines before the header', () => {
		expect(
			readChatCharacterName(['', '  ', JSON.stringify({ chat_metadata: {}, character_name: 'Aria' })])
		).toBe('Aria');
	});

	it('is null when the header names nobody', () => {
		expect(readChatCharacterName([JSON.stringify({ chat_metadata: {} })])).toBeNull();
		expect(
			readChatCharacterName([JSON.stringify({ chat_metadata: {}, character_name: '   ' })])
		).toBeNull();
	});

	it('is null when the first line is not a header', () => {
		// A message's own `name` is whoever spoke that turn, so it must not stand in.
		expect(readChatCharacterName([JSON.stringify({ name: 'Seraphina', mes: 'hi' })])).toBeNull();
		expect(readChatCharacterName(['not json'])).toBeNull();
		expect(readChatCharacterName([])).toBeNull();
	});
});
