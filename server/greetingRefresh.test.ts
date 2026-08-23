/**
 * A card edit reaching the chats that are still nothing but that card's opening
 * (`refreshSeededGreetings`, called by every `updateLibraryEntry`), against the REAL server
 * database (bun:sqlite).
 *
 * The rule this file exists to pin is the one with no flag behind it: a chat qualifies by
 * exact match against the greetings the save is replacing, so what matters is the set of
 * chats it must REFUSE to rewrite. Every case below that expects "untouched" is protecting
 * text the user put there.
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
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-greetings-'));
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

/** A character whose card carries `first` plus `alternates`, exactly as the library stores it. */
function makeCharacter(first: string, alternates: string[] = [], activeVersionId?: string): string {
	const id = crypto.randomUUID();
	const entry: Record<string, unknown> = {
		id,
		type: 'character',
		identity: { name: 'Aria', tags: [] },
		data: { traits: { description: 'A sharp-tongued sorceress.', firstMessage: first }, ...(alternates.length ? { alternateGreetings: alternates } : {}) },
		isFavorite: false,
		createdAt: (clock += 1000),
		updatedAt: clock
	};
	if (activeVersionId) entry.activeVersionId = activeVersionId;
	serverDb.insertLibraryEntry(entry);
	return id;
}

/** Rewrite a character's opening the way the library editor and the assistant both do. */
function setGreetings(
	characterId: string,
	first: string,
	alternates: string[] = [],
	overrides: { activeVersionId?: string | null } = {}
): string[] {
	const entry = serverDb.getLibraryEntry(characterId) as Record<string, any>;
	entry.data.traits.firstMessage = first;
	if (alternates.length) entry.data.alternateGreetings = alternates;
	else delete entry.data.alternateGreetings;
	if ('activeVersionId' in overrides) entry.activeVersionId = overrides.activeVersionId ?? undefined;
	entry.updatedAt = (clock += 1000);
	return serverDb.updateLibraryEntry(entry);
}

/** The chat a character pick produces: greetings as root-level swipeable siblings, plus the
 *  chat's record of what the card handed it. `claim: false` skips that record (an imported
 *  chat, or any chat older than the column, which must never follow the card). */
function seedChat(
	characterId: string,
	greetings: string[],
	characterVersionId: string | null = null,
	options: { claim?: boolean } = {}
): string {
	const chatId = crypto.randomUUID();
	serverDb.insertChat({
		id: chatId,
		title: 'Aria - 2026.08.01',
		createdAt: (clock += 1000),
		updatedAt: clock,
		rootMessageId: null,
		activeLeafId: null,
		canonLeafId: null,
		settings: null,
		characterId,
		characterVersionId
	});
	if (options.claim !== false) serverDb.setChatSeededGreetings(chatId, greetings);
	const ids = greetings.map((content, i) => addMessage(chatId, null, 'assistant', content, i));
	if (ids.length) serverDb.updateChat({ id: chatId, rootMessageId: ids[0], activeLeafId: ids[0] });
	return chatId;
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
		minorEditedAt: null,
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

/** The chat's rows in swipe order. */
function contentsOf(chatId: string): string[] {
	return (serverDb.getMessagesByChat(chatId) as any[])
		.sort((a, b) => a.siblingIndex - b.siblingIndex)
		.map((m) => m.content);
}

function chatRow(chatId: string): any {
	return (serverDb.getAllChats() as any[]).find((c) => c.id === chatId);
}

describe('a chat that is still only the card follows the card', () => {
	test('a rewritten First Message reaches it', () => {
		const characterId = makeCharacter('You again.');
		const chatId = seedChat(characterId, ['You again.']);

		const touched = setGreetings(characterId, 'You, again. Of course.');

		expect(touched).toEqual([chatId]);
		expect(contentsOf(chatId)).toEqual(['You, again. Of course.']);
	});

	test('an added alternate greeting becomes a new swipe, a removed one goes', () => {
		const characterId = makeCharacter('You again.', ['The tower is quiet.']);
		const chatId = seedChat(characterId, ['You again.', 'The tower is quiet.']);

		setGreetings(characterId, 'You again.', ['The tower is quiet.', 'Rain on the stairs.']);
		expect(contentsOf(chatId)).toEqual(['You again.', 'The tower is quiet.', 'Rain on the stairs.']);

		setGreetings(characterId, 'You again.', ['Rain on the stairs.']);
		expect(contentsOf(chatId)).toEqual(['You again.', 'Rain on the stairs.']);
	});

	test('the reader keeps the greeting they were parked on', () => {
		const characterId = makeCharacter('One.', ['Two.', 'Three.']);
		const chatId = seedChat(characterId, ['One.', 'Two.', 'Three.']);
		const second = (serverDb.getMessagesByChat(chatId) as any[]).find((m) => m.siblingIndex === 1).id;
		serverDb.updateChat({ id: chatId, activeLeafId: second });

		setGreetings(characterId, 'One.', ['Two, rewritten.', 'Three.']);

		const chat = chatRow(chatId);
		expect(chat.activeLeafId).toBe(second);
		expect((serverDb.getMessage(second) as any).content).toBe('Two, rewritten.');
	});

	test('a card that gains its first opening seeds the empty chat and points at it', () => {
		const characterId = makeCharacter('');
		const chatId = seedChat(characterId, []);
		expect(chatRow(chatId).rootMessageId).toBeNull();

		setGreetings(characterId, 'You again.');

		const chat = chatRow(chatId);
		expect(contentsOf(chatId)).toEqual(['You again.']);
		expect(chat.rootMessageId).not.toBeNull();
		expect(chat.activeLeafId).toBe(chat.rootMessageId);
	});

	test('a card that loses every opening empties the chat and clears its pointers', () => {
		const characterId = makeCharacter('You again.', ['The tower is quiet.']);
		const chatId = seedChat(characterId, ['You again.', 'The tower is quiet.']);

		setGreetings(characterId, '');

		const chat = chatRow(chatId);
		expect(contentsOf(chatId)).toEqual([]);
		expect(chat.rootMessageId).toBeNull();
		expect(chat.activeLeafId).toBeNull();
	});

	test('a reader parked on a greeting the card dropped retreats to the First Message', () => {
		const characterId = makeCharacter('One.', ['Two.']);
		const chatId = seedChat(characterId, ['One.', 'Two.']);
		const rows = serverDb.getMessagesByChat(chatId) as any[];
		const first = rows.find((m) => m.siblingIndex === 0).id;
		const second = rows.find((m) => m.siblingIndex === 1).id;
		serverDb.updateChat({ id: chatId, activeLeafId: second, canonLeafId: second });

		setGreetings(characterId, 'One.');

		const chat = chatRow(chatId);
		expect(chat.activeLeafId).toBe(first);
		expect(chat.canonLeafId).toBeNull();
		expect(serverDb.getMessage(second)).toBeNull();
	});

	test('the refresh does not bump the chat, so the list does not reshuffle', () => {
		const characterId = makeCharacter('You again.');
		const chatId = seedChat(characterId, ['You again.']);
		const before = chatRow(chatId).updatedAt;

		setGreetings(characterId, 'Something else entirely.');

		expect(chatRow(chatId).updatedAt).toBe(before);
	});
});

describe('a chat that holds anything the user put there is left alone', () => {
	test('one sent turn stops it', () => {
		const characterId = makeCharacter('You again.');
		const chatId = seedChat(characterId, ['You again.']);
		const greeting = (serverDb.getMessagesByChat(chatId) as any[])[0].id;
		const turn = addMessage(chatId, greeting, 'user', 'I sit down.', 0);
		serverDb.updateChat({ id: chatId, activeLeafId: turn });

		expect(setGreetings(characterId, 'Rewritten.')).toEqual([]);
		expect(contentsOf(chatId)).toEqual(['You again.', 'I sit down.']);
	});

	test('deleting that turn hands the chat back to the card', () => {
		const characterId = makeCharacter('You again.');
		const chatId = seedChat(characterId, ['You again.']);
		const greeting = (serverDb.getMessagesByChat(chatId) as any[])[0].id;
		const turn = addMessage(chatId, greeting, 'user', 'I sit down.', 0);
		serverDb.updateChat({ id: chatId, activeLeafId: turn });
		serverDb.deleteMessageAndDescendants(turn);

		// Nothing left in it is the user's, so it is a mirror again: the deliberate answer
		// to "has this chat been used", which is a question about the past, not about what
		// the chat holds now.
		expect(setGreetings(characterId, 'Rewritten.')).toEqual([chatId]);
		expect(contentsOf(chatId)).toEqual(['Rewritten.']);
	});

	test('it still comes back when the card moved on while the chat was a story', () => {
		const characterId = makeCharacter('You again.');
		const chatId = seedChat(characterId, ['You again.']);
		const greeting = (serverDb.getMessagesByChat(chatId) as any[])[0].id;
		const turn = addMessage(chatId, greeting, 'user', 'I sit down.', 0);
		serverDb.updateChat({ id: chatId, activeLeafId: turn });

		// Two card edits land while the chat is out of reach, so its greeting is a text the
		// CARD no longer knows anything about. Recognition asks the chat what it was handed,
		// not the card what it used to say, which is the whole reason this still works.
		setGreetings(characterId, 'Rewritten once.');
		setGreetings(characterId, 'Rewritten twice.');
		serverDb.deleteMessageAndDescendants(turn);

		expect(setGreetings(characterId, 'Rewritten three times.')).toEqual([chatId]);
		expect(contentsOf(chatId)).toEqual(['Rewritten three times.']);
	});

	test('a chat that was never handed an opening stays out for good', () => {
		// What an imported chat looks like, and every chat older than the claim: the rows read
		// exactly like a seeded greeting, but nothing ever said the card put them there.
		const characterId = makeCharacter('You again.');
		const chatId = seedChat(characterId, ['You again.'], null, { claim: false });

		expect(setGreetings(characterId, 'Rewritten.')).toEqual([]);
		expect(contentsOf(chatId)).toEqual(['You again.']);
	});

	test('a hand-edited greeting is never overwritten', () => {
		const characterId = makeCharacter('You again.');
		const chatId = seedChat(characterId, ['You again.']);
		const greeting = (serverDb.getMessagesByChat(chatId) as any[])[0].id;
		serverDb.updateMessageContent(greeting, 'You again, my dear.');

		expect(setGreetings(characterId, 'Rewritten.')).toEqual([]);
		expect(contentsOf(chatId)).toEqual(['You again, my dear.']);
	});

	test('a greeting saved quietly is protected too', () => {
		const characterId = makeCharacter('You again.');
		const chatId = seedChat(characterId, ['You again.']);
		const greeting = (serverDb.getMessagesByChat(chatId) as any[])[0].id;
		serverDb.updateMessageContent(greeting, 'You again.', { minor: true });

		expect(setGreetings(characterId, 'Rewritten.')).toEqual([]);
		expect(contentsOf(chatId)).toEqual(['You again.']);
	});

	test('an opening the user wrote by hand stops the whole chat', () => {
		const characterId = makeCharacter('You again.');
		const chatId = seedChat(characterId, ['You again.']);
		addMessage(chatId, null, 'assistant', 'A branch I wrote myself.', 1);

		expect(setGreetings(characterId, 'Rewritten.')).toEqual([]);
		expect(contentsOf(chatId)).toEqual(['You again.', 'A branch I wrote myself.']);
	});

	test('a generated opening scene stops it, and deleting it hands the chat back', () => {
		const characterId = makeCharacter('You again.', ['The tower is quiet.']);
		const chatId = seedChat(characterId, ['You again.', 'The tower is quiet.']);
		// Exactly what the Opening Scene engine writes: one more root sibling, appended after
		// the greetings. The card must not reach a chat holding a beginning the reader asked
		// for and paid for, and the row count alone is what says so.
		const opening = addMessage(chatId, null, 'assistant', 'Rain on the stairs.', 2);
		serverDb.updateChat({ id: chatId, activeLeafId: opening });

		expect(setGreetings(characterId, 'Rewritten.', ['The tower is quiet.'])).toEqual([]);
		expect(contentsOf(chatId)).toEqual(['You again.', 'The tower is quiet.', 'Rain on the stairs.']);

		// Throw the generated opening away and the rows are the claim again, so the mirror
		// resumes on its own: nothing has to be rewritten to hand the chat back.
		serverDb.deleteMessageAndDescendants(opening);
		expect(setGreetings(characterId, 'Rewritten again.', ['The tower is quiet.'])).toEqual([chatId]);
		expect(contentsOf(chatId)).toEqual(['Rewritten again.', 'The tower is quiet.']);
	});
});

describe('scope: only the variant that actually changed', () => {
	test('a chat pinned to another version keeps what it was pinned to', () => {
		const active = crypto.randomUUID();
		const parked = crypto.randomUUID();
		const characterId = makeCharacter('You again.', [], active);
		const onActive = seedChat(characterId, ['You again.'], active);
		const onParked = seedChat(characterId, ['You again.'], parked);

		const touched = setGreetings(characterId, 'Rewritten.', [], { activeVersionId: active });

		expect(touched).toEqual([onActive]);
		expect(contentsOf(onActive)).toEqual(['Rewritten.']);
		expect(contentsOf(onParked)).toEqual(['You again.']);
	});

	test('a save that moves the active pointer is a switch, not a content edit', () => {
		const first = crypto.randomUUID();
		const characterId = makeCharacter('You again.', [], first);
		const chatId = seedChat(characterId, ['You again.'], first);

		// A switch swaps in another variant's whole data AND moves the pointer; the chat
		// stays pinned where it was, so its opening must not move with the card.
		const touched = setGreetings(characterId, 'A different variant.', [], { activeVersionId: crypto.randomUUID() });

		expect(touched).toEqual([]);
		expect(contentsOf(chatId)).toEqual(['You again.']);
	});

	test('a second character is not in scope, and a persona save reconciles nothing', () => {
		const aria = makeCharacter('You again.');
		const other = makeCharacter('You again.');
		const ariaChat = seedChat(aria, ['You again.']);
		const otherChat = seedChat(other, ['You again.']);

		expect(setGreetings(aria, 'Rewritten.')).toEqual([ariaChat]);
		expect(contentsOf(otherChat)).toEqual(['You again.']);

		const personaId = crypto.randomUUID();
		serverDb.insertLibraryEntry({
			id: personaId,
			type: 'persona',
			identity: { name: 'Moe', tags: [] },
			data: { traits: { description: 'Me.' } },
			isFavorite: false,
			createdAt: (clock += 1000),
			updatedAt: clock
		});
		const persona = serverDb.getLibraryEntry(personaId) as any;
		persona.data.traits.description = 'Me, revised.';
		expect(serverDb.updateLibraryEntry(persona)).toEqual([]);
	});

	test('a save that leaves the opening alone touches no chat at all', () => {
		const characterId = makeCharacter('You again.');
		seedChat(characterId, ['You again.']);

		const entry = serverDb.getLibraryEntry(characterId) as any;
		entry.identity.tags = ['mage'];
		expect(serverDb.updateLibraryEntry(entry)).toEqual([]);
	});
});
