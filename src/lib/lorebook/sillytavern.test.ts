/**
 * SillyTavern interchange tests. Run with `bun test`.
 *
 * Locks the two import shapes (native World Info + character_book) onto our model and proves
 * the export round-trips: modelled fields keep SillyTavern's native names verbatim, and the
 * fields we don't surface (position, depth, recursion, groups, characterFilter, …) survive
 * untouched in `rest` so a book is lossless through SillyTavern.
 */

import { describe, expect, test } from 'bun:test';

import { parseLorebook, toNativeWorldInfo, toCharacterBook } from './sillytavern';

/** A real SillyTavern export shape (trimmed from an actual World Info file). */
const NATIVE = {
	entries: {
		'0': {
			uid: 0,
			key: ['dragon', 'wyrm'],
			keysecondary: ['fire'],
			comment: 'The Dragon',
			content: 'A great red wyrm.',
			constant: false,
			selective: true,
			selectiveLogic: 3, // AND_ALL
			order: 50,
			position: 4,
			disable: false,
			displayIndex: 2,
			addMemo: true,
			depth: 7,
			role: null,
			probability: 80,
			useProbability: true,
			caseSensitive: null,
			matchWholeWords: null,
			group: 'beasts',
			sticky: 3,
			cooldown: 2,
			ignoreBudget: false,
			triggers: [],
			characterFilter: { isExclude: false, names: ['Seraphina'], tags: [] }
		}
	}
};

const CHARACTER_BOOK = {
	name: 'Embedded',
	description: 'From a card.',
	scan_depth: 5,
	entries: [
		{
			keys: ['tower'],
			secondary_keys: [],
			comment: 'The Tower',
			content: 'An arcane spire.',
			constant: true,
			enabled: true,
			insertion_order: 20,
			case_sensitive: false,
			position: 'after_char',
			extensions: { position: 1, depth: 3, selectiveLogic: 0, match_whole_words: true, probability: 100 }
		}
	]
};

describe('parseLorebook: native World Info', () => {
	const book = parseLorebook(NATIVE, 'Fallback');

	test('maps modelled fields under their native names', () => {
		expect(book.entries).toHaveLength(1);
		const e = book.entries[0];
		expect(e.comment).toBe('The Dragon');
		expect(e.key).toEqual(['dragon', 'wyrm']);
		expect(e.keysecondary).toEqual(['fire']);
		expect(e.selectiveLogic).toBe(3);
		expect(e.content).toBe('A great red wyrm.');
		expect(e.constant).toBe(false);
		expect(e.disable).toBe(false);
		expect(e.order).toBe(50);
		expect(e.probability).toBe(80);
		expect(e.useProbability).toBe(true);
		expect(e.caseSensitive).toBeNull(); // "use global" stays null, not coerced
		expect(e.matchWholeWords).toBeNull();
	});

	test('preserves every unmapped field verbatim in rest', () => {
		const rest = book.entries[0].rest;
		expect(rest.ignoreBudget).toBe(false);
		expect(rest.addMemo).toBe(true);
		expect(rest.characterFilter).toEqual({ isExclude: false, names: ['Seraphina'], tags: [] });
		expect(rest.displayIndex).toBe(2);
		expect('uid' in rest).toBe(false); // positional, regenerated on export
		expect('selectiveLogic' in rest).toBe(false); // modelled, not duplicated
	});
});

describe('parseLorebook: character_book', () => {
	const book = parseLorebook(CHARACTER_BOOK, 'Fallback');

	test('maps book + entry fields onto native names', () => {
		expect(book.name).toBe('Embedded');
		expect(book.scanDepth).toBe(5);
		const e = book.entries[0];
		expect(e.comment).toBe('The Tower');
		expect(e.key).toEqual(['tower']);
		expect(e.constant).toBe(true);
		expect(e.disable).toBe(false);
		expect(e.order).toBe(20);
		expect(e.selectiveLogic).toBe(0); // lifted from extensions
		expect(e.matchWholeWords).toBe(true); // lifted from extensions.match_whole_words
		expect(e.caseSensitive).toBe(false);
		expect(e.position).toBe(1); // lifted from extensions, where the real enum lives
		expect(e.depth).toBe(3);
		expect('selectiveLogic' in e.rest).toBe(false);
	});
});

describe('detects an embedded character card book', () => {
	test('reads data.character_book', () => {
		const card = { spec: 'chara_card_v2', data: { name: 'Hero', character_book: CHARACTER_BOOK } };
		const book = parseLorebook(card, 'Fallback');
		expect(book.entries[0].comment).toBe('The Tower');
	});
});

describe('throws on unrecognised input', () => {
	test('no entries', () => {
		expect(() => parseLorebook({ foo: 1 }, 'x')).toThrow();
	});
});

describe('round-trip: native export re-imports stably', () => {
	test('exported entry carries the original fields verbatim, ST names intact', () => {
		const exported = toNativeWorldInfo(parseLorebook(NATIVE, 'x')) as { entries: Record<string, any> };
		const e = exported.entries['0'];
		const orig = NATIVE.entries['0'];
		// Modelled fields, native names.
		expect(e.key).toEqual(orig.key);
		expect(e.keysecondary).toEqual(orig.keysecondary);
		expect(e.selectiveLogic).toBe(orig.selectiveLogic);
		expect(e.selective).toBe(true);
		expect(e.disable).toBe(false);
		expect(e.order).toBe(orig.order);
		expect(e.probability).toBe(orig.probability);
		expect(e.caseSensitive).toBeNull(); // tri-state round-trips as null
		expect(e.matchWholeWords).toBeNull();
		// Placement is modelled now, and comes back exactly as it went in.
		expect(e.position).toBe(orig.position);
		expect(e.depth).toBe(orig.depth);
		// Passthrough fields, untouched.
		expect(e.group).toBe(orig.group);
		expect(e.sticky).toBe(orig.sticky);
		expect(e.cooldown).toBe(orig.cooldown);
		expect(e.characterFilter).toEqual(orig.characterFilter);
		expect(e.displayIndex).toBe(orig.displayIndex);
	});

	test('export → parse reaches a fixed point after one pass', () => {
		// The first export may COMPLETE a sparse entry with ST defaults; after that the
		// cycle must be perfectly stable.
		const once = parseLorebook(toNativeWorldInfo(parseLorebook(NATIVE, 'x')), 'x');
		const twice = parseLorebook(toNativeWorldInfo(once), 'x');
		expect({ ...twice.entries[0], id: '' }).toEqual({ ...once.entries[0], id: '' });
	});

	test('a Chungus-authored entry exports as a complete ST-idiomatic record', () => {
		const book = parseLorebook({ entries: { '0': { key: ['x'], content: 'y' } } }, 'x');
		const e = (toNativeWorldInfo(book) as { entries: Record<string, any> }).entries['0'];
		// ST defaults fill the fields we never touched.
		expect(e.addMemo).toBe(true);
		expect(e.position).toBe(0);
		expect(e.depth).toBe(4);
		expect(e.uid).toBe(0);
		// Timing is modelled now, and SillyTavern's own default for all three is null, not 0.
		expect(e.group).toBe('');
		expect(e.sticky).toBeNull();
		expect(e.groupWeight).toBe(100);
	});

	test('book-level fields survive our own export → import', () => {
		const book = parseLorebook(CHARACTER_BOOK, 'x'); // has name, description, scan_depth
		book.extensions.token_budget = 512;
		const again = parseLorebook(toNativeWorldInfo(book), 'x');
		expect(again.name).toBe('Embedded');
		expect(again.scanDepth).toBe(5);
		expect(again.extensions.token_budget).toBe(512);
		// Description is not a modelled field: it rides in extensions both ways.
		expect(again.extensions.description).toBe('From a card.');
	});
});

describe('toCharacterBook', () => {
	test('emits spec names with ST-specific fields inside entry extensions', () => {
		const book = parseLorebook(NATIVE, 'x');
		const cb = toCharacterBook(book) as { entries: any[] };
		const e = cb.entries[0];
		expect(e.keys).toEqual(['dragon', 'wyrm']);
		expect(e.insertion_order).toBe(50);
		expect(e.enabled).toBe(true);
		expect(e.extensions.selectiveLogic).toBe(3);
		expect(e.extensions.probability).toBe(80);
		expect(e.extensions.depth).toBe(7); // preserved through
	});
});

describe('matching fields cross the boundary', () => {
	/** A SillyTavern entry using every match field we now model. */
	const MATCHING = {
		entries: {
			'0': {
				key: ['citadel'],
				content: 'lore',
				scanDepth: 3,
				triggers: ['impersonate', 'quiet'],
				matchScenario: true,
				matchCreatorNotes: false,
				chungus_key_rules: { citadel: { mode: 'start', caseSensitive: true } }
			}
		}
	};

	test('native import reads the scan window, the source flags and the trigger list', () => {
		const e = parseLorebook(MATCHING, 'x').entries[0];
		expect(e.scanDepth).toBe(3);
		expect(e.scanFields).toEqual(['scenario']);
		// Every trigger token rides, including the kinds this app never generates.
		expect(e.triggers).toEqual(['impersonate', 'quiet']);
		expect(e.keyRules).toEqual({ citadel: { mode: 'start', caseSensitive: true } });
		// Modelled now, so they are not duplicated into rest.
		expect('scanDepth' in e.rest).toBe(false);
		expect('matchScenario' in e.rest).toBe(false);
	});

	test('native export writes them back under SillyTavern names', () => {
		const e = (toNativeWorldInfo(parseLorebook(MATCHING, 'x')) as { entries: Record<string, any> })
			.entries['0'];
		expect(e.scanDepth).toBe(3);
		expect(e.matchScenario).toBe(true);
		expect(e.matchCharacterDescription).toBe(false);
		expect(e.triggers).toEqual(['impersonate', 'quiet']);
		expect(e.chungus_key_rules).toEqual({ citadel: { mode: 'start', caseSensitive: true } });
	});

	test('an entry that overrides nothing exports without our own key', () => {
		const book = parseLorebook({ entries: { '0': { key: ['x'], content: 'y' } } }, 'x');
		const e = (toNativeWorldInfo(book) as { entries: Record<string, any> }).entries['0'];
		expect('chungus_key_rules' in e).toBe(false);
		expect(e.scanDepth).toBeNull();
		expect(e.triggers).toEqual([]);
	});

	test('the card shape carries the same fields under its snake_case names', () => {
		const cb = toCharacterBook(parseLorebook(MATCHING, 'x')) as { entries: any[] };
		const ext = cb.entries[0].extensions;
		expect(ext.scan_depth).toBe(3);
		expect(ext.match_scenario).toBe(true);
		expect(ext.triggers).toEqual(['impersonate', 'quiet']);
		// …and reads them back off a card without duplicating them into rest.
		const again = parseLorebook({ name: 'c', entries: cb.entries }, 'x').entries[0];
		expect(again.scanDepth).toBe(3);
		expect(again.scanFields).toEqual(['scenario']);
		expect(again.keyRules).toEqual({ citadel: { mode: 'start', caseSensitive: true } });
		expect('match_scenario' in again.rest).toBe(false);
	});

	test('a regex key needs no side channel: it round-trips as its own text', () => {
		const book = parseLorebook({ entries: { '0': { key: ['/dr[ae]gon/i'], content: 'y' } } }, 'x');
		expect(book.entries[0].key).toEqual(['/dr[ae]gon/i']);
		const e = (toNativeWorldInfo(book) as { entries: Record<string, any> }).entries['0'];
		expect(e.key).toEqual(['/dr[ae]gon/i']);
	});
});

describe('recursion settings cross the boundary under both spellings', () => {
	/** A native World Info entry with every recursion flag set. */
	const NATIVE = {
		entries: {
			'0': {
				key: ['citadel'],
				content: 'lore',
				excludeRecursion: true,
				preventRecursion: true,
				delayUntilRecursion: 3
			}
		}
	};

	/** The same entry as a character card carries it: snake_case, inside extensions. */
	const CARD = {
		name: 'c',
		entries: [
			{
				keys: ['citadel'],
				content: 'lore',
				extensions: {
					exclude_recursion: true,
					prevent_recursion: true,
					delay_until_recursion: 3
				}
			}
		]
	};

	const nativeEntry = (book: ReturnType<typeof parseLorebook>) =>
		(toNativeWorldInfo(book) as { entries: Record<string, any> }).entries['0'];
	const cardExtensions = (book: ReturnType<typeof parseLorebook>) =>
		(toCharacterBook(book) as { entries: any[] }).entries[0].extensions;

	test('native import models the flags instead of parking them in rest', () => {
		const e = parseLorebook(NATIVE, 'x').entries[0];
		expect(e.excludeRecursion).toBe(true);
		expect(e.preventRecursion).toBe(true);
		expect(e.delayUntilRecursion).toBe(3);
		expect('excludeRecursion' in e.rest).toBe(false);
	});

	test('a card-embedded book reads the same flags off its snake_case names', () => {
		const e = parseLorebook(CARD, 'x').entries[0];
		expect(e.excludeRecursion).toBe(true);
		expect(e.preventRecursion).toBe(true);
		expect(e.delayUntilRecursion).toBe(3);
		expect('exclude_recursion' in e.rest).toBe(false);
	});

	test('a card-imported book exports to native World Info with its flags intact', () => {
		const e = nativeEntry(parseLorebook(CARD, 'x'));
		expect(e.excludeRecursion).toBe(true);
		expect(e.preventRecursion).toBe(true);
		expect(e.delayUntilRecursion).toBe(3);
		// The spelling the other shape reads must not ship beside the one this shape reads.
		expect('exclude_recursion' in e).toBe(false);
	});

	test('a native-imported book exports to a card with its flags intact', () => {
		const ext = cardExtensions(parseLorebook(NATIVE, 'x'));
		expect(ext.exclude_recursion).toBe(true);
		expect(ext.prevent_recursion).toBe(true);
		expect(ext.delay_until_recursion).toBe(3);
		expect('excludeRecursion' in ext).toBe(false);
	});

	test('an entry that names none exports them all as off', () => {
		const e = nativeEntry(parseLorebook({ entries: { '0': { key: ['x'], content: 'y' } } }, 'x'));
		expect(e.excludeRecursion).toBe(false);
		expect(e.preventRecursion).toBe(false);
		expect(e.delayUntilRecursion).toBe(false);
	});

	test('the first recursion level exports as `true`, the way SillyTavern writes it', () => {
		const book = parseLorebook({ entries: { '0': { content: 'y', delayUntilRecursion: 1 } } }, 'x');
		expect(nativeEntry(book).delayUntilRecursion).toBe(true);
	});

	test('a copy an older row left in rest is exported once, from the resolved value', () => {
		const book = parseLorebook({ entries: { '0': { content: 'y' } } }, 'x');
		// The shape a row stored before these fields were modelled still carries.
		book.entries[0].rest.preventRecursion = true;
		const e = nativeEntry(book);
		expect(e.preventRecursion).toBe(true);
		expect(cardExtensions(book).prevent_recursion).toBe(true);
	});
});
