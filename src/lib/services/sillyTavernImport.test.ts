/**
 * What the card reader takes off a SillyTavern card besides the character. Run with `bun test`.
 *
 * A card carries its lorebook two ways and they are not the same claim: an embedded
 * `character_book` is a copy of the book, while `extensions.world` is a LINK to a file in the
 * same profile. Reading only the copy is how one shared book lands once per card that uses it.
 *
 * The Character's Note is the other thing read out here rather than onto a trait: it is
 * guidance at a depth, so it leaves as a steering note and carries the placement the card chose.
 */
import { describe, expect, test } from 'bun:test';

import { importSillyTavernCard } from './sillyTavernImport';

function jsonCard(body: Record<string, unknown>): File {
	return new File([JSON.stringify(body)], 'card.json', { type: 'application/json' });
}

const BOOK = { name: 'Kingdom', entries: [{ keys: ['dragon'], content: 'A great red wyrm.', enabled: true }] };

describe('the world a card links to', () => {
	test('is read from a V2 card, where SillyTavern writes it', async () => {
		const result = await importSillyTavernCard(
			jsonCard({ spec: 'chara_card_v2', data: { name: 'Alice', extensions: { world: 'Kingdom' } } })
		);
		expect(result.worldName).toBe('Kingdom');
	});

	// A V1 card has no `data` block; the same field sits at the top level.
	test('is read from a V1 card too', async () => {
		const result = await importSillyTavernCard(jsonCard({ name: 'Alice', extensions: { world: ' Kingdom ' } }));
		expect(result.worldName).toBe('Kingdom');
	});

	test('is null where the card names none, rather than an empty name nothing can resolve', async () => {
		expect((await importSillyTavernCard(jsonCard({ name: 'Alice' }))).worldName).toBeNull();
		const blank = jsonCard({ name: 'Alice', data: { extensions: { world: '   ' } } });
		expect((await importSillyTavernCard(blank)).worldName).toBeNull();
	});

	test('rides beside the embedded copy, since a card can carry both', async () => {
		const result = await importSillyTavernCard(
			jsonCard({ spec: 'chara_card_v2', data: { name: 'Alice', extensions: { world: 'Kingdom' }, character_book: BOOK } })
		);
		expect(result.worldName).toBe('Kingdom');
		expect(result.lorebook?.entries).toHaveLength(1);
	});
});

describe("the card's Character's Note", () => {
	const noteCard = (depth_prompt: unknown, nested = true) =>
		jsonCard(
			nested
				? { spec: 'chara_card_v2', data: { name: 'Alice', extensions: { depth_prompt } } }
				: { name: 'Alice', extensions: { depth_prompt } }
		);

	test('is read from a V2 card with the placement the card chose', async () => {
		const result = await importSillyTavernCard(
			noteCard({ prompt: 'Alice never lies.', depth: 4, role: 'system' })
		);
		expect(result.depthPrompt).toEqual({ text: 'Alice never lies.', depth: 4, role: 'system' });
	});

	test('is read from a V1 card too', async () => {
		const result = await importSillyTavernCard(
			noteCard({ prompt: '  Alice never lies.  ', depth: 2, role: 'assistant' }, false)
		);
		expect(result.depthPrompt).toEqual({ text: 'Alice never lies.', depth: 2, role: 'assistant' });
	});

	test('is null where the card names none', async () => {
		expect((await importSillyTavernCard(jsonCard({ name: 'Alice' }))).depthPrompt).toBeNull();
	});

	// SillyTavern writes this block on every card whether or not the author filled it in, so a
	// reader that took it at face value would shelve a blank note on every character imported.
	test('an empty prompt is no note, not a blank one', async () => {
		expect((await importSillyTavernCard(noteCard({ prompt: '', depth: 4, role: 'system' }))).depthPrompt).toBeNull();
		expect((await importSillyTavernCard(noteCard({ prompt: '   ' }))).depthPrompt).toBeNull();
	});

	// The guidance is the note; a placement field spelled wrong reads as absent, which is this
	// app's "inherit the app-wide placement" rather than a reason to drop the text.
	test('a role the card spells wrong inherits instead of refusing the note', async () => {
		const result = await importSillyTavernCard(noteCard({ prompt: 'Stay in scene.', role: 'narrator' }));
		expect(result.depthPrompt).toEqual({ text: 'Stay in scene.', depth: null, role: null });
	});

	test('a depth out of range is clamped, and an unnamed one inherits', async () => {
		const deep = await importSillyTavernCard(noteCard({ prompt: 'Stay in scene.', depth: 9999 }));
		expect(deep.depthPrompt?.depth).toBe(100);
		const none = await importSillyTavernCard(noteCard({ prompt: 'Stay in scene.' }));
		expect(none.depthPrompt?.depth).toBeNull();
	});
});
