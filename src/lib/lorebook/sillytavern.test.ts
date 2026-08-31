/**
 * SillyTavern interchange tests. Run with `bun test`.
 *
 * Locks the two import shapes (native World Info + character_book) onto our model and proves
 * the export round-trips: modelled fields keep SillyTavern's native names verbatim, and the
 * fields we don't surface (position, depth, recursion, groups, characterFilter, …) survive
 * untouched in `rest` so a book is lossless through SillyTavern.
 *
 * The blocks at the foot drive the same claim from the other end: a book with every modelled
 * field off its default, so nothing can hide behind a coincidence; the BOOK level, whose
 * unmodelled keys ride in `extensions` the way an entry's ride in `rest`; the two things an
 * export must never carry (the every-chat switch and the cover), since either would rewrite
 * what a stranger's install does with the book; and a file that is wrong in every way, because
 * an import reads a stranger's tool's output and has to land rather than throw.
 */

import { describe, expect, test } from 'bun:test';

import { parseLorebook, toNativeWorldInfo, toCharacterBook } from './sillytavern';
import { createEmptyLorebook, createEmptyLorebookEntry, resolveEntryRecursion } from './types';

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

// ===========================================================================================
// A book leaving and coming back whole, and a stranger's file landing at all
// ===========================================================================================

/** Through JSON, the way a file really travels, so nothing can pass on a shared reference. */
const throughFile = (value: unknown): any => JSON.parse(JSON.stringify(value));

/** Every modelled entry field set to something that is NOT its default, so a round trip that
 *  drops one shows as a difference rather than as a coincidence. */
function loadedEntry(): any {
	return {
		...createEmptyLorebookEntry(),
		comment: 'Dragons of Eldoria',
		key: ['dragon', 'ejderha', '/wyv[e]rn/i'],
		keysecondary: ['fire', 'scale'],
		selectiveLogic: 3,
		content: 'They hoard {{char}} gold.',
		constant: true,
		disable: true,
		order: 42,
		probability: 37,
		useProbability: false,
		caseSensitive: true,
		matchWholeWords: false,
		keyRules: { dragon: { mode: 'start', caseSensitive: true }, fire: { mode: 'word' } },
		scanDepth: 7,
		scanFields: ['scenario', 'personaDescription'],
		triggers: ['swipe', 'continue'],
		sticky: 3,
		cooldown: 5,
		delay: 9,
		group: 'weather, season',
		groupOverride: true,
		groupWeight: 250,
		useGroupScoring: true,
		position: 4,
		depth: 11,
		role: 2,
		excludeRecursion: true,
		preventRecursion: true,
		delayUntilRecursion: 3,
		rest: { characterFilter: { names: ['Aria'] }, automationId: 'qr-7', vectorized: true, displayIndex: 5 }
	};
}

/** Everything a round trip must carry, minus the ids that are deliberately regenerated. */
const ENTRY_FIELDS = [
	'comment', 'key', 'keysecondary', 'selectiveLogic', 'content', 'constant', 'disable',
	'order', 'probability', 'useProbability', 'caseSensitive', 'matchWholeWords', 'keyRules',
	'scanDepth', 'scanFields', 'triggers', 'sticky', 'cooldown', 'delay', 'group',
	'groupOverride', 'groupWeight', 'useGroupScoring', 'position', 'depth', 'role',
	'excludeRecursion', 'preventRecursion', 'delayUntilRecursion'
] as const;

const pick = (e: any) => Object.fromEntries(ENTRY_FIELDS.map((f) => [f, e[f]]));

const withEntries = (over: Record<string, unknown>, entries: any[]) =>
	({ ...createEmptyLorebook('Eldoria'), ...over, entries }) as any;

describe('a fully loaded entry through both shapes', () => {
	// The blocks above check a real ST export field by field; this one checks the OTHER
	// direction with every modelled field off its default at once, so a field the mapping
	// forgets cannot hide behind one that happens to equal its default.
	test('every modelled field survives native export → import', () => {
		const book = withEntries({}, [loadedEntry()]);
		const back = parseLorebook(throughFile(toNativeWorldInfo(book)), 'fallback');
		expect(pick(back.entries[0])).toEqual(pick(book.entries[0]));
	});

	test('every modelled field survives book → character_book → book', () => {
		const book = withEntries({}, [loadedEntry()]);
		const card = { spec: 'chara_card_v2', data: { character_book: toCharacterBook(book) } };
		const back = parseLorebook(throughFile(card), 'fallback');
		expect(pick(back.entries[0])).toEqual(pick(book.entries[0]));
	});
});

describe('the book level round-trips too', () => {
	test('the activation overrides survive, zeros included', () => {
		// 0 and null are two different answers at every level (whole chat versus inherit), so a
		// coercion that folded them together would quietly change what the book scans.
		const book = withEntries(
			{
				scanDepth: 0,
				recursiveScanning: false,
				maxRecursionSteps: 0,
				caseSensitive: true,
				matchWholeWords: false,
				extensions: { description: 'a world', token_budget: 512, someVendorKey: [1, 2] }
			},
			[createEmptyLorebookEntry()]
		);
		const back = parseLorebook(throughFile(toNativeWorldInfo(book)), 'fallback');
		expect(back.name).toBe('Eldoria');
		expect(back.scanDepth).toBe(0);
		expect(back.recursiveScanning).toBe(false);
		expect(back.maxRecursionSteps).toBe(0);
		expect(back.caseSensitive).toBe(true);
		expect(back.matchWholeWords).toBe(false);
		expect(back.extensions).toEqual({ description: 'a world', token_budget: 512, someVendorKey: [1, 2] });
	});

	test('an inheriting book comes back inheriting, never on a concrete default', () => {
		const back = parseLorebook(
			throughFile(toNativeWorldInfo(withEntries({ name: 'Plain' }, [createEmptyLorebookEntry()]))),
			'fallback'
		);
		expect([back.scanDepth, back.recursiveScanning, back.maxRecursionSteps]).toEqual([null, null, null]);
		expect([back.caseSensitive, back.matchWholeWords]).toEqual([null, null]);
	});

	// The book-level twin of an entry's `rest`: a third-party tool writes its own keys at the
	// top level, and dropping them means importing a book and exporting it strips them.
	test('a top-level key the parser does not model rides in extensions', () => {
		const back = parseLorebook(
			{ name: 'X', mystery: 'kept', entries: { '0': { key: ['a'], content: 'c' } } },
			'f'
		);
		expect(back.extensions.mystery).toBe('kept');
		expect(throughFile(toNativeWorldInfo(back)).extensions.mystery).toBe('kept');
	});

	test("a card export carries the book's own extensions under the overrides", () => {
		const book = withEntries(
			{ extensions: { description: 'a world', token_budget: 512, someVendorKey: [1, 2] } },
			[createEmptyLorebookEntry()]
		);
		const back = parseLorebook(throughFile({ data: { character_book: toCharacterBook(book) } }), 'f');
		expect(back.extensions).toEqual({ description: 'a world', token_budget: 512, someVendorKey: [1, 2] });
	});

	test('a card book re-exported as native World Info keeps what it arrived with', () => {
		const card = {
			data: {
				character_book: {
					name: 'Embedded',
					description: 'from a card',
					scan_depth: 12,
					recursive_scanning: false,
					extensions: { vendorThing: 1 },
					entries: [
						{
							keys: ['gate'],
							secondary_keys: ['open'],
							content: 'The gate creaks.',
							comment: 'Gate',
							enabled: false,
							constant: true,
							insertion_order: 17,
							case_sensitive: true,
							extensions: { selectiveLogic: 2, probability: 40, useProbability: true, group: 'doors' }
						}
					]
				}
			}
		};
		const book = parseLorebook(card, 'f');
		const back = parseLorebook(throughFile(toNativeWorldInfo(book)), 'f');
		expect(back.name).toBe('Embedded');
		expect(back.scanDepth).toBe(12);
		expect(back.recursiveScanning).toBe(false);
		expect(back.extensions).toEqual({ vendorThing: 1, description: 'from a card' });
		// The recursion flags are compared through their ONE reader: a native export always
		// writes them, so a card that named none comes back with an explicit `false` that
		// resolves identically. Every other field is compared as stored.
		const without = (e: any) => {
			const { excludeRecursion, preventRecursion, delayUntilRecursion, ...rest } = pick(e);
			return rest;
		};
		expect(without(back.entries[0])).toEqual(without(book.entries[0]));
		expect(resolveEntryRecursion(back.entries[0])).toEqual(resolveEntryRecursion(book.entries[0]));
	});

	test('a book with no name of its own takes the one the file was called', () => {
		const back = parseLorebook(
			throughFile(toNativeWorldInfo(withEntries({ name: '' }, [createEmptyLorebookEntry()]))),
			'From the filename'
		);
		expect(back.name).toBe('From the filename');
	});
});

describe('what an export must never carry', () => {
	// This install's whole setup, not the book's: a shared book that switched itself into every
	// chat in a stranger's library would rewrite every prompt they send.
	test('the every-chat switch does not travel, and a hand-edited file cannot set it', () => {
		const file = throughFile(
			toNativeWorldInfo(withEntries({ name: 'World', global: true }, [createEmptyLorebookEntry()]))
		);
		expect('global' in file).toBe(false);
		expect(parseLorebook(file, 'f').global).toBeUndefined();
		expect(parseLorebook({ ...file, global: true }, 'f').global).toBeUndefined();
	});

	// A World Info file is JSON and a cover is a file on this install's disk, so the path would
	// name a picture the receiving library does not have.
	test('the cover and its framing do not travel either', () => {
		const book = withEntries(
			{ name: 'World', cover: 'images/lorebooks/x.png', coverFocus: { x: 0.2, y: 0.4, zoom: 1.5 } },
			[createEmptyLorebookEntry()]
		);
		const file = throughFile(toNativeWorldInfo(book));
		expect('cover' in file).toBe(false);
		expect('coverFocus' in file).toBe(false);
		const back = parseLorebook(file, 'f');
		expect(back.cover).toBeUndefined();
		expect(back.coverFocus).toBeUndefined();
	});
});

describe('a file that is wrong in every way still lands', () => {
	test('missing keys land on defaults instead of throwing', () => {
		const back = parseLorebook({ entries: { '0': {} } }, 'Fallback name');
		expect(back.name).toBe('Fallback name');
		expect(pick(back.entries[0])).toMatchObject({ key: [], content: '', order: 100, constant: false });
	});

	test('wrong types coerce instead of throwing', () => {
		const back = parseLorebook(
			{
				name: 42,
				scan_depth: 'deep',
				entries: { '0': { key: 'a, b , ,c', content: 99, order: 'high', constant: 'yes', probability: null } }
			},
			'f'
		);
		expect(back.name).toBe('f');
		expect(back.scanDepth).toBeNull();
		expect(pick(back.entries[0])).toMatchObject({
			key: ['a', 'b', 'c'],
			content: '',
			order: 100,
			constant: false,
			probability: 100
		});
	});

	test('both empty shapes are accepted, and anything with no entries throws', () => {
		expect(parseLorebook({ entries: {} }, 'f').entries).toEqual([]);
		expect(parseLorebook({ entries: [] }, 'f').entries).toEqual([]);
		for (const bad of [{ name: 'X' }, { entries: null }, 'not an object', null]) {
			expect(() => parseLorebook(bad, 'f')).toThrow();
		}
	});

	// `uid` is the file's own numbering and ours is a uuid, so a file that reuses one must not
	// collapse two entries into one: two entries sharing an id share one sticky window and one
	// record in every trace.
	test('duplicate uids become two entries with ids of their own', () => {
		const back = parseLorebook(
			{ entries: { '0': { uid: 5, key: ['a'], content: 'one' }, '1': { uid: 5, key: ['b'], content: 'two' } } },
			'f'
		);
		expect(back.entries).toHaveLength(2);
		expect(back.entries[0].id).not.toBe(back.entries[1].id);
	});

	// Entries are stored as an array and admitted in `order`, so the file's own sequence has to
	// survive as the array while `order` stays whatever each entry says.
	test('the stored sequence and the order field are two different things', () => {
		const book = withEntries({}, [
			{ ...createEmptyLorebookEntry(), comment: 'A', order: 300 },
			{ ...createEmptyLorebookEntry(), comment: 'B', order: 1 },
			{ ...createEmptyLorebookEntry(), comment: 'C', order: 50 }
		]);
		const back = parseLorebook(throughFile(toNativeWorldInfo(book)), 'f');
		expect(back.entries.map((e) => e.comment)).toEqual(['A', 'B', 'C']);
		expect(back.entries.map((e) => e.order)).toEqual([300, 1, 50]);
	});
});
