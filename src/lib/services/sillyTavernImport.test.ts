/**
 * What the card reader takes off a SillyTavern card besides the character. Run with `bun test`.
 *
 * A card carries its lorebook two ways and they are not the same claim: an embedded
 * `character_book` is a copy of the book, while `extensions.world` is a LINK to a file in the
 * same profile. Reading only the copy is how one shared book lands once per card that uses it.
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
