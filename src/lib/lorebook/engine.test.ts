/**
 * Lorebook activation engine tests. Run with `bun test`.
 *
 * Locks two contracts. The matching one: constant entries always fire, keyword entries fire
 * only on a real match (honouring case-sensitivity, whole-word, and primary/secondary logic),
 * Trigger % gates fired entries, and the rendered block joins content in `order` without
 * leaking titles. And the trace: every entry gets a record saying what happened to it, naming
 * the key that matched and the turn it matched in, because an entry that quietly fails to fire
 * is the hardest thing about a lorebook to debug.
 */

import { describe, expect, test } from 'bun:test';

import {
	messageScanSources,
	renderLorebookBlock,
	resolveLorebooks,
	scanLorebooks,
	type LorebookSelection
} from './engine';
import {
	buildLorebookTrace,
	createEmptyLorebook,
	createEmptyLorebookEntry,
	DEFAULT_LOREBOOK_GLOBAL_SETTINGS,
	LOREBOOK_POSITION_AT_DEPTH,
	lorebookHistory,
	type Lorebook,
	type LorebookEntry,
	type LorebookEntryRecord,
	type LorebookGlobalSettings,
	type LorebookPastScan,
	type LorebookScanField,
	type LorebookTrace
} from './types';

function book(entries: Partial<LorebookEntry>[], name = 'Test'): Lorebook {
	const b = createEmptyLorebook(name);
	b.entries = entries.map((e) => ({ ...createEmptyLorebookEntry(), ...e }));
	return b;
}

/** Scan and return the injected entries by content, the shape most assertions read. */
function fired(
	books: Lorebook[],
	messages: string[],
	rng: () => number = () => 0,
	settings: LorebookGlobalSettings = DEFAULT_LOREBOOK_GLOBAL_SETTINGS
): string[] {
	return scanLorebooks({ books, sources: messageScanSources(messages), rng, settings }).entries.map((e) => e.content);
}

/** The record for one entry, found by its title. */
function recordFor(
	books: Lorebook[],
	messages: string[],
	title: string,
	rng: () => number = () => 0
): LorebookEntryRecord {
	const { records } = scanLorebooks({ books, sources: messageScanSources(messages), rng });
	const found = records.find((r) => r.title === title);
	if (!found) throw new Error(`no record for "${title}"`);
	return found;
}

/** A selection with matching records, for the render tests. */
function selectionOf(entries: LorebookEntry[]): LorebookSelection {
	return {
		entries,
		records: entries.map((e) => ({
			bookId: 'b',
			bookName: 'Test',
			entryId: e.id,
			title: e.comment,
			status: 'keyword' as const,
			matches: []
		}))
	};
}

describe('scanLorebooks', () => {
	test('constant entries fire regardless of keywords', () => {
		const b = book([{ content: 'always', constant: true, key: [] }]);
		expect(fired([b], [])).toEqual(['always']);
	});

	test('keyword entries fire only on a match', () => {
		const b = book([{ content: 'dragon lore', key: ['dragon'] }]);
		expect(fired([b], ['a quiet town'])).toHaveLength(0);
		expect(fired([b], ['the DRAGON roars'])).toEqual(['dragon lore']);
	});

	test('disabled and empty-content entries never fire', () => {
		const b = book([
			{ content: 'off', constant: true, disable: true },
			{ content: '   ', constant: true }
		]);
		expect(fired([b], [])).toHaveLength(0);
	});

	test('case-sensitive keys respect case', () => {
		const b = book([{ content: 'c', key: ['Aria'], caseSensitive: true }]);
		expect(fired([b], ['aria waves'])).toHaveLength(0);
		expect(fired([b], ['Aria waves'])).toEqual(['c']);
	});

	test('whole-word matching for single-word keys (and null = default on)', () => {
		const b = book([{ content: 'c', key: ['art'], matchWholeWords: null }]);
		expect(fired([b], ['a work of cartography'])).toHaveLength(0);
		expect(fired([b], ['the art of war'])).toEqual(['c']);
	});

	test('whole words can be explicitly disabled', () => {
		const b = book([{ content: 'c', key: ['art'], matchWholeWords: false }]);
		expect(fired([b], ['a work of cartography'])).toEqual(['c']);
	});

	test('multi-word keys match as substrings even with whole-word on', () => {
		const b = book([{ content: 'c', key: ['arcane spire'], matchWholeWords: true }]);
		expect(fired([b], ['the arcane spires loom'])).toEqual(['c']);
	});

	test('secondary-key logic: AND_ANY=0 / NOT_ALL=1 / NOT_ANY=2 / AND_ALL=3', () => {
		const mk = (selectiveLogic: number) =>
			book([{ content: 'c', key: ['king'], keysecondary: ['war', 'peace'], selectiveLogic }]);
		// 0 AND ANY: at least one secondary present
		expect(fired([mk(0)], ['the king at war'])).toHaveLength(1);
		expect(fired([mk(0)], ['the king alone'])).toHaveLength(0);
		// 3 AND ALL: every secondary present
		expect(fired([mk(3)], ['king war peace'])).toHaveLength(1);
		expect(fired([mk(3)], ['king war'])).toHaveLength(0);
		// 2 NOT ANY: no secondary present
		expect(fired([mk(2)], ['the king alone'])).toHaveLength(1);
		expect(fired([mk(2)], ['the king at war'])).toHaveLength(0);
		// 1 NOT ALL: not every secondary present
		expect(fired([mk(1)], ['king war'])).toHaveLength(1);
		expect(fired([mk(1)], ['king war peace'])).toHaveLength(0);
	});

	test('trigger % gates fired entries through the rng', () => {
		const b = book([
			{ content: 'maybe', constant: true, probability: 50, useProbability: true },
			{ content: 'sure', constant: true, probability: 100, useProbability: true }
		]);
		// rng at 0.99 → 99 ≥ 50: the 50% entry loses its roll, the 100% one always passes.
		expect(fired([b], [], () => 0.99)).toEqual(['sure']);
		// rng at 0.01 → 1 < 50: both fire.
		expect(fired([b], [], () => 0.01)).toEqual(['maybe', 'sure']);
	});

	test('useProbability=false skips the roll entirely', () => {
		const b = book([{ content: 'c', constant: true, probability: 0, useProbability: false }]);
		expect(fired([b], [], () => 0.99)).toEqual(['c']);
	});

	test('results are sorted by order ascending', () => {
		const b = book([
			{ content: 'third', constant: true, order: 300 },
			{ content: 'first', constant: true, order: 100 },
			{ content: 'second', constant: true, order: 200 }
		]);
		expect(fired([b], [])).toEqual(['first', 'second', 'third']);
	});

	test('scanDepth clamps the scanned window', () => {
		const b = book([{ content: 'c', key: ['intro'] }]);
		b.scanDepth = 1; // only the most recent message is scanned
		expect(fired([b], ['intro line', 'recent line'])).toHaveLength(0);
		expect(fired([b], ['old line', 'intro line'])).toEqual(['c']);
	});
});

describe('the trace', () => {
	test('a fired entry records the key that matched and how far back', () => {
		const b = book([{ comment: 'Wolves', content: 'lore', key: ['wolf'] }]);
		const record = recordFor([b], ['a wolf howls in the dark', 'nothing here'], 'Wolves');
		expect(record.status).toBe('keyword');
		expect(record.matches).toHaveLength(1);
		expect(record.matches[0].key).toBe('wolf');
		expect(record.matches[0].role).toBe('primary');
		// The hit sits one turn behind the newest.
		expect(record.matches[0].source).toEqual({ kind: 'message', depth: 1 });
		expect(record.matches[0].excerpt).toContain('wolf howls');
	});

	test('a key present in several turns is reported against the most recent one', () => {
		const b = book([{ comment: 'Wolves', content: 'lore', key: ['wolf'] }]);
		const record = recordFor([b], ['a wolf', 'no beasts', 'another wolf'], 'Wolves');
		expect(record.matches[0].source).toEqual({ kind: 'message', depth: 0 });
	});

	test('an entry that nothing matched says so, and stays out of the stored trace', () => {
		const b = book([{ comment: 'Wolves', content: 'lore', key: ['wolf'] }]);
		const scan = scanLorebooks({
			books: [book([{ comment: 'Wolves', content: 'lore', key: ['wolf'] }])],
			sources: messageScanSources(['a quiet town'])
		});
		expect(scan.records[0].status).toBe('noMatch');
		expect(scan.records[0].matches).toEqual([]);
		const trace = buildLorebookTrace(scan.records);
		expect(trace.records).toHaveLength(0);
		expect(trace.silent).toBe(1);
		expect(b.entries).toHaveLength(1);
	});

	test('a filtered entry keeps the evidence of both halves', () => {
		const b = book([
			{ comment: 'Court', content: 'lore', key: ['king'], keysecondary: ['war'], selectiveLogic: 2 } // NOT ANY
		]);
		const record = recordFor([b], ['the king at war'], 'Court');
		expect(record.status).toBe('filtered');
		expect(record.matches.map((m) => m.role)).toEqual(['primary', 'secondary']);
	});

	test('a lost roll records the chance it failed', () => {
		const b = book([{ comment: 'Maybe', content: 'lore', constant: true, probability: 25 }]);
		const record = recordFor([b], [], 'Maybe', () => 0.99);
		expect(record.status).toBe('rolledOut');
		expect(record.probability).toBe(25);
	});

	test('a recursion match names the entry that pulled it in', () => {
		const b = book([
			{ comment: 'Seed', content: 'the pack roams', constant: true, order: 100 },
			{ comment: 'Pack', content: 'pack lore', key: ['pack'], order: 200 }
		]);
		const record = recordFor([b], [], 'Pack');
		expect(record.status).toBe('keyword');
		expect(record.matches[0].source).toEqual({
			kind: 'entry',
			entryId: b.entries[0].id,
			title: 'Seed',
			bookName: 'Test'
		});
	});

	test('records name the book they came from', () => {
		const one = book([{ comment: 'A', content: 'a', constant: true }], 'Eldoria');
		const two = book([{ comment: 'B', content: 'b', constant: true }], 'Cast');
		const { records } = scanLorebooks({ books: [one, two], sources: messageScanSources([]) });
		expect(records.map((r) => r.bookName)).toEqual(['Eldoria', 'Cast']);
	});

	test('an entry still waiting on recursion is recorded as delayed', () => {
		const b = book([{ comment: 'Late', content: 'c', key: ['delta'], rest: { delayUntilRecursion: true } }]);
		const record = recordFor([b], ['a delta appears'], 'Late');
		expect(record.status).toBe('delayed');
	});

	test('buildLorebookTrace keeps what happened and counts what did not', () => {
		const b = book([
			{ comment: 'In', content: 'a', constant: true },
			{ comment: 'Out', content: 'b', key: ['nothing here'] },
			{ comment: 'Off', content: 'c', constant: true, disable: true }
		]);
		const { records } = scanLorebooks({ books: [b], sources: messageScanSources(['plain text']) });
		const trace = buildLorebookTrace(records);
		expect(trace.records.map((r) => r.title)).toEqual(['In']);
		expect(trace.silent).toBe(2);
	});
});

describe('per-key matching', () => {
	test('word start matches a suffixed form without matching mid-word', () => {
		const b = book([{ content: 'c', key: ['ejderha'], keyRules: { ejderha: { mode: 'start' } } }]);
		expect(fired([b], ['ejderhanın kanadı'])).toEqual(['c']);
		expect(fired([b], ['bir ejderhalar sürüsü'])).toEqual(['c']);
		expect(fired([b], ['kanatlıejderha yok'])).toHaveLength(0);
	});

	test('a key can be matched anywhere while the entry asks for whole words', () => {
		const b = book([
			{ content: 'c', key: ['art'], matchWholeWords: true, keyRules: { art: { mode: 'substring' } } }
		]);
		expect(fired([b], ['a work of cartography'])).toEqual(['c']);
	});

	test('one key is case-sensitive while its neighbour is not', () => {
		const b = book([
			{ content: 'c', key: ['IT', 'network'], keyRules: { IT: { caseSensitive: true } } }
		]);
		// The acronym alone no longer fires on every "it"…
		expect(fired([b], ['it was quiet'])).toHaveLength(0);
		expect(fired([b], ['the IT crowd'])).toEqual(['c']);
		// …and the key beside it keeps matching case-insensitively.
		expect(fired([b], ['the Network hums'])).toEqual(['c']);
	});

	test('a key written /pattern/flags is a regex and carries its own case flag', () => {
		const b = book([{ content: 'c', key: ['/dr[ae]gon/i'] }]);
		expect(fired([b], ['the DRAGON roars'])).toEqual(['c']);
		expect(fired([b], ['the dregon roars'])).toEqual(['c']);
		expect(fired([b], ['a wyrm roars'])).toHaveLength(0);
		// No `i`: the pattern says what it says, whatever the entry's own switch is set to.
		const cased = book([{ content: 'c', key: ['/Dragon/'], caseSensitive: false }]);
		expect(fired([cased], ['the dragon roars'])).toHaveLength(0);
		expect(fired([cased], ['the Dragon roars'])).toEqual(['c']);
	});

	test('a regex key matches across a whole turn, not only at word boundaries', () => {
		const b = book([{ content: 'c', key: ['/wyrm/'], matchWholeWords: true }]);
		expect(fired([b], ['the wyrmling flees'])).toEqual(['c']);
	});

	test('a pattern that does not compile matches nothing instead of throwing', () => {
		const b = book([{ content: 'c', key: ['/[unclosed/'] }]);
		expect(() => fired([b], ['[unclosed'])).not.toThrow();
		expect(fired([b], ['[unclosed'])).toHaveLength(0);
	});

	test('a rule for a key the entry no longer has changes nothing', () => {
		const b = book([{ content: 'c', key: ['wolf'], keyRules: { gone: { mode: 'start' } } }]);
		expect(fired([b], ['a wolf howls'])).toEqual(['c']);
	});
});

describe('scan sources beyond the chat', () => {
	const scenarioBook = (scanFields?: LorebookScanField[]) =>
		book([{ comment: 'Keep', content: 'c', key: ['citadel'], scanFields }]);

	test('a card field is read only by the entries that opted into it', () => {
		const fields = { scenario: 'they meet inside the citadel' };
		expect(resolveLorebooks({ books: [scenarioBook()], messages: ['hello'], fields }).text).toBe('');
		expect(
			resolveLorebooks({ books: [scenarioBook(['scenario'])], messages: ['hello'], fields }).text
		).toBe('c');
	});

	test('a field match names the field it was found in', () => {
		const out = resolveLorebooks({
			books: [scenarioBook(['scenario'])],
			messages: ['hello'],
			fields: { scenario: 'they meet inside the citadel' }
		});
		expect(out.trace.records[0].matches[0].source).toEqual({ kind: 'field', field: 'scenario' });
	});

	test('the chat wins the report when a key is in both', () => {
		const out = resolveLorebooks({
			books: [scenarioBook(['scenario'])],
			messages: ['the citadel gates open'],
			fields: { scenario: 'they meet inside the citadel' }
		});
		expect(out.trace.records[0].matches[0].source).toEqual({ kind: 'message', depth: 0 });
	});

	test('field text is macro-expanded before it is scanned', () => {
		const out = resolveLorebooks({
			books: [scenarioBook(['characterDescription'])],
			messages: ['hello'],
			fields: { characterDescription: 'keeper of the {{place}}' },
			expand: (t) => t.replace('{{place}}', 'citadel')
		});
		expect(out.text).toBe('c');
	});

	test('a blank field is no source at all', () => {
		const out = resolveLorebooks({
			books: [scenarioBook(['scenario'])],
			messages: ['hello'],
			fields: { scenario: '   ' }
		});
		expect(out.text).toBe('');
	});
});

describe('per-entry scan depth', () => {
	test('an entry reaches further back than its book when it says so', () => {
		const b = book([{ content: 'c', key: ['intro'], scanDepth: 3 }]);
		b.scanDepth = 1;
		expect(fired([b], ['intro line', 'a', 'b'])).toEqual(['c']);
	});

	test('an entry can narrow the window its book opened', () => {
		const b = book([{ content: 'c', key: ['intro'], scanDepth: 1 }]);
		b.scanDepth = 10;
		expect(fired([b], ['intro line', 'recent line'])).toHaveLength(0);
	});

	test('0 on the entry means the whole chat, whatever the book says', () => {
		const b = book([{ content: 'c', key: ['intro'], scanDepth: 0 }]);
		b.scanDepth = 1;
		expect(fired([b], ['intro line', 'a', 'b', 'c'])).toEqual(['c']);
	});
});

describe('the generation-type filter', () => {
	const limited = (triggers: string[]) => book([{ comment: 'Only', content: 'c', constant: true, triggers }]);

	test('an entry naming its kinds sits every other one out', () => {
		const b = limited(['impersonate']);
		expect(resolveLorebooks({ books: [b], messages: [], trigger: 'impersonate' }).text).toBe('c');
		expect(resolveLorebooks({ books: [b], messages: [], trigger: 'normal' }).text).toBe('');
	});

	test('an empty list fires on everything', () => {
		const b = limited([]);
		expect(resolveLorebooks({ books: [b], messages: [], trigger: 'continue' }).text).toBe('c');
	});

	test("SillyTavern's regenerate answers our Regenerate too", () => {
		const b = limited(['regenerate']);
		expect(resolveLorebooks({ books: [b], messages: [], trigger: 'swipe' }).text).toBe('c');
		expect(resolveLorebooks({ books: [b], messages: [], trigger: 'normal' }).text).toBe('');
	});

	test('the reason is recorded, and counted rather than stored', () => {
		const { records } = scanLorebooks({ books: [limited(['continue'])], sources: messageScanSources([]) });
		expect(records[0].status).toBe('offTrigger');
		expect(buildLorebookTrace(records)).toEqual({ records: [], silent: 1 });
	});
});

describe('timed effects', () => {
	/** A path where `entryId` last earned its place `n` generations back (1 = the turn before). */
	function firedAgo(entryId: string, n: number): LorebookPastScan[] {
		return Array.from({ length: n }, (_, i) => ({
			fired: i === n - 1 ? new Set([entryId]) : new Set<string>()
		}));
	}

	const held = (b: Lorebook, history: LorebookPastScan[], messages: string[] = ['a quiet town']) =>
		scanLorebooks({ books: [b], sources: messageScanSources(messages), rng: () => 0, history });

	test('sticky holds an entry in for its window, without its keys matching', () => {
		const b = book([{ comment: 'Wolves', content: 'c', key: ['wolf'], sticky: 2 }]);
		const id = b.entries[0].id;
		expect(held(b, firedAgo(id, 1)).entries.map((e) => e.content)).toEqual(['c']);
		expect(held(b, firedAgo(id, 2)).entries.map((e) => e.content)).toEqual(['c']);
		// Past the window, it is back to needing a match.
		expect(held(b, firedAgo(id, 3)).entries).toHaveLength(0);
	});

	test('a sticky turn is recorded as sticky, not as a keyword match', () => {
		const b = book([{ comment: 'Wolves', content: 'c', key: ['wolf'], sticky: 2 }]);
		const { records } = held(b, firedAgo(b.entries[0].id, 1));
		expect(records[0].status).toBe('sticky');
	});

	test('a sticky window is never renewed by its own stickiness', () => {
		// The window is measured from the last NATURAL firing, which is what `lorebookHistory`
		// collects, so a sticky-only history cannot extend it.
		const b = book([{ comment: 'Wolves', content: 'c', key: ['wolf'], sticky: 1 }]);
		const id = b.entries[0].id;
		const sticky: LorebookTrace = {
			records: [{ bookId: 'b', bookName: 'B', entryId: id, title: 'Wolves', status: 'sticky', matches: [] }],
			silent: 0
		};
		expect(lorebookHistory([{ lorebook: sticky }])).toEqual([{ fired: new Set() }]);
	});

	test('cooldown blocks the generations right after a firing', () => {
		const b = book([{ comment: 'Wolves', content: 'c', key: ['wolf'], cooldown: 2 }]);
		const id = b.entries[0].id;
		const text = ['a wolf howls'];
		expect(held(b, firedAgo(id, 1), text).entries).toHaveLength(0);
		expect(held(b, firedAgo(id, 2), text).entries).toHaveLength(0);
		expect(held(b, firedAgo(id, 3), text).entries).toHaveLength(1);
		expect(held(b, firedAgo(id, 1), text).records[0].status).toBe('cooldown');
	});

	test('cooldown starts only once the sticky window has closed', () => {
		const b = book([{ comment: 'Wolves', content: 'c', key: ['wolf'], sticky: 2, cooldown: 2 }]);
		const id = b.entries[0].id;
		const text = ['a wolf howls'];
		const status = (n: number) => held(b, firedAgo(id, n), text).records[0].status;
		expect(status(1)).toBe('sticky');
		expect(status(2)).toBe('sticky');
		expect(status(3)).toBe('cooldown');
		expect(status(4)).toBe('cooldown');
		expect(status(5)).toBe('keyword');
	});

	test('an entry that never fired on this path is free, which is what makes a swipe correct', () => {
		const b = book([{ comment: 'Wolves', content: 'c', key: ['wolf'], cooldown: 5 }]);
		// The discarded attempt is not on this path, so its history is not here either.
		expect(held(b, [], ['a wolf howls']).entries).toHaveLength(1);
	});

	test('a sticky entry skips its trigger roll too', () => {
		const b = book([{ comment: 'Wolves', content: 'c', key: ['wolf'], sticky: 1, probability: 1 }]);
		expect(held(b, firedAgo(b.entries[0].id, 1)).entries).toHaveLength(1);
	});

	test('delay keeps an entry out until the chat is long enough', () => {
		const b = book([{ comment: 'Late', content: 'c', constant: true, delay: 3 }]);
		expect(fired([b], ['one', 'two'])).toHaveLength(0);
		expect(fired([b], ['one', 'two', 'three'])).toEqual(['c']);
	});

	test('delay counts the whole chat, not the entry’s own scan window', () => {
		const b = book([{ comment: 'Late', content: 'c', constant: true, delay: 3, scanDepth: 1 }]);
		expect(fired([b], ['one', 'two', 'three'])).toEqual(['c']);
	});

	test('lorebookHistory reads the path’s own traces, newest first', () => {
		const trace = (entryId: string): LorebookTrace => ({
			records: [{ bookId: 'b', bookName: 'B', entryId, title: 't', status: 'keyword', matches: [] }],
			silent: 0
		});
		const history = lorebookHistory([
			{ lorebook: trace('old') },
			{ lorebook: null },
			{ lorebook: trace('new') }
		]);
		expect(history.map((h) => [...h.fired])).toEqual([['new'], ['old']]);
	});
});

describe('inclusion groups', () => {
	const rivals = (extra: Partial<LorebookEntry>[] = [{}, {}]) =>
		book([
			{ comment: 'A', content: 'a', constant: true, group: 'weather', order: 100, ...extra[0] },
			{ comment: 'B', content: 'b', constant: true, group: 'weather', order: 200, ...extra[1] }
		]);

	const scan = (b: Lorebook, rng = () => 0) =>
		scanLorebooks({ books: [b], sources: messageScanSources([]), rng });

	test('only one entry per label reaches the prompt', () => {
		expect(scan(rivals()).entries.map((e) => e.content)).toEqual(['a']);
	});

	test('the loser says which group it lost and to whom', () => {
		const { records } = scan(rivals());
		const loser = records.find((r) => r.title === 'B')!;
		expect(loser.status).toBe('groupLost');
		expect(loser.lostTo).toEqual({ group: 'weather', title: 'A' });
	});

	test('the roll is weighted, so a heavier entry takes more of the picks', () => {
		const b = rivals([{ groupWeight: 25 }, { groupWeight: 75 }]);
		// The roll lands in the first quarter of the total, which is A's share.
		expect(scan(b, () => 0.1).entries.map((e) => e.content)).toEqual(['a']);
		// …and past it, which is B's.
		expect(scan(b, () => 0.9).entries.map((e) => e.content)).toEqual(['b']);
	});

	test('a weight of zero is never picked while anything else stands', () => {
		const b = rivals([{ groupWeight: 0 }, { groupWeight: 100 }]);
		expect(scan(b, () => 0).entries.map((e) => e.content)).toEqual(['b']);
	});

	test('prioritize wins over every candidate that does not set it', () => {
		const b = rivals([{ groupWeight: 999 }, { groupOverride: true }]);
		expect(scan(b).entries.map((e) => e.content)).toEqual(['b']);
	});

	test('scoring picks the entry whose keys matched most', () => {
		const b = book([
			{ comment: 'A', content: 'a', key: ['rain'], group: 'weather', useGroupScoring: true, order: 100 },
			{ comment: 'B', content: 'b', key: ['rain', 'storm'], group: 'weather', order: 200 }
		]);
		expect(
			scanLorebooks({ books: [b], sources: messageScanSources(['rain and storm']), rng: () => 0 })
				.entries.map((e) => e.content)
		).toEqual(['b']);
	});

	test('a sticky candidate keeps its slot, so a window cannot flicker', () => {
		const b = rivals([{ sticky: 2, key: ['nothing'], constant: false }, {}]);
		const history: LorebookPastScan[] = [{ fired: new Set([b.entries[0].id]) }];
		const out = scanLorebooks({ books: [b], sources: messageScanSources([]), rng: () => 0, history });
		expect(out.entries.map((e) => e.content)).toEqual(['a']);
	});

	test('groups are resolved across books, since a label names one idea', () => {
		const one = book([{ comment: 'A', content: 'a', constant: true, group: 'weather' }], 'One');
		const two = book([{ comment: 'B', content: 'b', constant: true, group: 'weather' }], 'Two');
		const out = scanLorebooks({ books: [one, two], sources: messageScanSources([]), rng: () => 0 });
		expect(out.entries).toHaveLength(1);
		expect(out.records).toHaveLength(2);
	});

	test('an entry naming two groups has to survive both', () => {
		const b = book([
			{ comment: 'A', content: 'a', constant: true, group: 'weather, mood', order: 100 },
			{ comment: 'B', content: 'b', constant: true, group: 'mood', order: 200, groupOverride: true }
		]);
		// A takes 'weather' unopposed, then loses 'mood' to a prioritized rival, and is out.
		expect(scan(b).entries.map((e) => e.content)).toEqual(['b']);
	});

	test('an ungrouped book never touches any of it', () => {
		const b = book([
			{ content: 'a', constant: true, order: 100 },
			{ content: 'b', constant: true, order: 200 }
		]);
		expect(scan(b).entries.map((e) => e.content)).toEqual(['a', 'b']);
	});
});

describe('recursive scanning', () => {
	test('explicitly off: an entry never activates another via its content', () => {
		const b = book([
			{ content: 'mentions beta', constant: true, order: 100 },
			{ content: 'beta fact', key: ['beta'], order: 200 }
		]);
		b.recursiveScanning = false;
		expect(fired([b], [])).toEqual(['mentions beta']);
	});

	test('on by default: a fresh book recurses without being told to', () => {
		// createEmptyLorebook leaves recursiveScanning at null → inherits the global default (on).
		const b = book([
			{ content: 'mentions beta', constant: true, order: 100 },
			{ content: 'beta fact', key: ['beta'], order: 200 }
		]);
		expect(fired([b], [])).toEqual(['mentions beta', 'beta fact']);
	});

	test('a book predating the field (undefined) still recurses', () => {
		const b = book([
			{ content: 'mentions beta', constant: true, order: 100 },
			{ content: 'beta fact', key: ['beta'], order: 200 }
		]);
		// Simulate an old stored row that never had the field.
		(b as { recursiveScanning?: boolean }).recursiveScanning = undefined;
		expect(fired([b], [])).toEqual(['mentions beta', 'beta fact']);
	});

	test('on: activated content activates keyword entries, chaining until dry', () => {
		const b = book([
			{ content: 'mentions beta', constant: true, order: 100 },
			{ content: 'beta leads to gamma', key: ['beta'], order: 200 },
			{ content: 'gamma fact', key: ['gamma'], order: 300 }
		]);
		expect(fired([b], [])).toEqual(['mentions beta', 'beta leads to gamma', 'gamma fact']);
	});

	test('wakes nobody: the entry fires but its content triggers no one', () => {
		const b = book([
			{ content: 'mentions beta', constant: true, order: 100, preventRecursion: true },
			{ content: 'beta fact', key: ['beta'], order: 200 }
		]);
		b.recursiveScanning = true;
		expect(fired([b], [])).toEqual(['mentions beta']);
	});

	test('woken by the chat only: it can fire from chat but never from another entry', () => {
		const b = book([
			{ content: 'mentions beta', constant: true, order: 100 },
			{ content: 'beta fact', key: ['beta'], order: 200, excludeRecursion: true }
		]);
		b.recursiveScanning = true;
		expect(fired([b], [])).toEqual(['mentions beta']);
		expect(fired([b], ['a beta appears'])).toEqual(['mentions beta', 'beta fact']);
	});

	test('woken by other entries only: the chat cannot wake it, another entry can', () => {
		const delayed = { content: 'delta fact', key: ['delta'], order: 200, delayUntilRecursion: true };
		// Nothing fired in pass 1, so recursion never runs and the delayed entry stays silent.
		const solo = book([{ ...delayed }]);
		solo.recursiveScanning = true;
		expect(fired([solo], ['a delta appears'])).toHaveLength(0);
		// Recursion runs, but the key is only in the chat, which this entry no longer reads.
		const unrelated = book([{ content: 'seed', constant: true, order: 100 }, { ...delayed }]);
		unrelated.recursiveScanning = true;
		expect(fired([unrelated], ['a delta appears'])).toEqual(['seed']);
		// The key is in another entry's content, which is what it asked to be woken by.
		const seeded = book([{ content: 'seed names delta', constant: true, order: 100 }, { ...delayed }]);
		seeded.recursiveScanning = true;
		expect(fired([seeded], [])).toEqual(['seed names delta', 'delta fact']);
	});

	test('a recursion level (a number) delays exactly like `true`', () => {
		const delayed = { content: 'delta fact', key: ['delta'], order: 200, delayUntilRecursion: 2 };
		const solo = book([{ ...delayed }]);
		solo.recursiveScanning = false;
		expect(fired([solo], ['a delta appears'])).toHaveLength(0);
		const seeded = book([{ content: 'seed names delta', constant: true, order: 100 }, { ...delayed }]);
		seeded.recursiveScanning = true;
		expect(fired([seeded], [])).toEqual(['seed names delta', 'delta fact']);
	});

	test('the settings are read from either spelling an older row left in `rest`', () => {
		// Native World Info spelling, the shape a pre-modelled import stored.
		const native = book([
			{ comment: 'Seed', content: 'mentions beta', constant: true, order: 100, rest: { preventRecursion: true } },
			{ content: 'beta fact', key: ['beta'], order: 200 }
		]);
		expect(fired([native], [])).toEqual(['mentions beta']);
		// The snake_case spelling a character card carries.
		const card = book([
			{ comment: 'Seed', content: 'mentions beta', constant: true, order: 100, rest: { prevent_recursion: true } },
			{ content: 'beta fact', key: ['beta'], order: 200 }
		]);
		expect(fired([card], [])).toEqual(['mentions beta']);
	});

	test('a modelled `false` wins over a copy left in `rest`', () => {
		const b = book([
			{
				content: 'mentions beta',
				constant: true,
				order: 100,
				preventRecursion: false,
				rest: { preventRecursion: true }
			},
			{ content: 'beta fact', key: ['beta'], order: 200 }
		]);
		expect(fired([b], [])).toEqual(['mentions beta', 'beta fact']);
	});

	test('waiting for recursion while refusing it leaves nothing that can fire it', () => {
		const b = book([
			{ content: 'seed names delta', constant: true, order: 100 },
			{
				comment: 'Dead',
				content: 'delta fact',
				key: ['delta'],
				order: 200,
				delayUntilRecursion: true,
				excludeRecursion: true
			}
		]);
		expect(fired([b], ['a delta appears'])).toEqual(['seed names delta']);
		expect(recordFor([b], ['a delta appears'], 'Dead').status).toBe('neverFires');
	});

	test('an open sticky window overrules every recursion setting', () => {
		const history: LorebookPastScan[] = [{ fired: new Set<string>() }];
		const b = book([
			{
				comment: 'Held',
				content: 'held fact',
				key: ['nothing here'],
				order: 100,
				sticky: 2,
				delayUntilRecursion: true,
				excludeRecursion: true
			}
		]);
		history[0].fired.add(b.entries[0].id);
		const { records, entries } = scanLorebooks({ books: [b], sources: messageScanSources(['x']), history });
		expect(entries.map((e) => e.content)).toEqual(['held fact']);
		expect(records[0].status).toBe('sticky');
	});

	test('an always-active entry can wait for recursion, then fires without keys', () => {
		const b = book([
			{ content: 'preamble', constant: true, order: 50, delayUntilRecursion: true },
			{ content: 'beta fact', key: ['beta'], order: 200 }
		]);
		// Nothing fires in pass 1, so recursion never starts and the preamble waits.
		expect(fired([b], ['quiet turn'])).toHaveLength(0);
		// Some lore fires, so the preamble joins it.
		expect(fired([b], ['a beta appears'])).toEqual(['preamble', 'beta fact']);
	});

	test('a higher level waits for the ones below it to run dry, then still arrives', () => {
		const b = book([
			{ content: 'seed names alpha', constant: true, order: 100 },
			{ content: 'alpha names beta', key: ['alpha'], order: 200, delayUntilRecursion: 1 },
			{ content: 'beta fact', key: ['beta'], order: 300, delayUntilRecursion: 2 }
		]);
		expect(fired([b], [])).toEqual(['seed names alpha', 'alpha names beta', 'beta fact']);
	});

	test('a level the pass cap never reaches stays waiting', () => {
		const entries = [
			{ content: 'seed names alpha', constant: true, order: 100 },
			{ content: 'alpha names beta', key: ['alpha'], order: 200, delayUntilRecursion: 1 },
			{ comment: 'Wave two', content: 'beta fact', key: ['beta'], order: 300, delayUntilRecursion: 2 }
		];
		// Two passes: one lets the first wave in, the second finds nothing new. The second wave
		// would have opened on a third pass, which the cap never allows.
		const capped = book(entries);
		capped.maxRecursionSteps = 2;
		expect(fired([capped], [])).toEqual(['seed names alpha', 'alpha names beta']);
		expect(recordFor([capped], [], 'Wave two').status).toBe('delayed');
		// The same book without waves spends those two passes on both entries.
		const flat = book(entries.map((e) => ({ ...e, delayUntilRecursion: e.delayUntilRecursion ? true : undefined })));
		flat.maxRecursionSteps = 2;
		expect(fired([flat], [])).toEqual(['seed names alpha', 'alpha names beta', 'beta fact']);
	});

	test('recursion reads entry content with its macros expanded', () => {
		const b = book([
			{ content: 'the {{char}} rules here', constant: true, order: 100 },
			{ content: 'dragon fact', key: ['dragon'], order: 200 }
		]);
		const expand = (t: string) => t.replaceAll('{{char}}', 'dragon');
		const raw = scanLorebooks({ books: [b], sources: messageScanSources([]) });
		expect(raw.entries.map((e) => e.content)).toEqual(['the {{char}} rules here']);
		const expanded = scanLorebooks({ books: [b], sources: messageScanSources([]), expand });
		expect(expanded.entries.map((e) => e.content)).toEqual(['the {{char}} rules here', 'dragon fact']);
	});

	test('a lost roll is never re-rolled by a later recursion pass', () => {
		const b = book([
			{ content: 'mentions beta', constant: true, order: 100 },
			{ content: 'beta fact', key: ['beta'], order: 200, probability: 50 }
		]);
		// The roll loses once and stays lost, however many passes the chain runs.
		expect(fired([b], [], () => 0.99)).toEqual(['mentions beta']);
	});

	test('mutual references terminate and both fire', () => {
		const b = book([
			{ content: 'contains bword', key: ['aword'], order: 100 },
			{ content: 'contains aword', key: ['bword'], order: 200 }
		]);
		b.recursiveScanning = true;
		expect(fired([b], ['an aword here'])).toEqual(['contains bword', 'contains aword']);
	});
});

describe('renderLorebookBlock', () => {
	test('joins content, drops comments, returns empty for no entries', () => {
		expect(renderLorebookBlock({ entries: [], records: [] }).text).toBe('');
		const entries = [
			{ ...createEmptyLorebookEntry(), comment: 'Title A', content: 'fact a' },
			{ ...createEmptyLorebookEntry(), comment: 'Title B', content: 'fact b' }
		];
		const out = renderLorebookBlock(selectionOf(entries)).text;
		expect(out).toContain('fact a');
		expect(out).toContain('fact b');
		expect(out).not.toContain('Title A'); // comments are organizational, never injected
	});

	test('applies the macro expander to content', () => {
		const entries = [{ ...createEmptyLorebookEntry(), content: 'Hello {{name}}' }];
		const out = renderLorebookBlock(selectionOf(entries), (t) => t.replace('{{name}}', 'Aria')).text;
		expect(out).toContain('Hello Aria');
	});

	test('budget admits entries greedily in priority order and drops what does not fit', () => {
		const entries = ['aaaa', 'bbbbbbbb', 'cc'].map((content) => ({
			...createEmptyLorebookEntry(),
			content
		}));
		// Count = characters, separator included for every entry that joins a non-empty block.
		// Budget 8: 'aaaa' fits (4), 'bbbbbbbb' would overflow (4 + 10) and is dropped, the
		// later-but-smaller 'cc' still fits (4 + 4).
		const out = renderLorebookBlock(selectionOf(entries), undefined, { maxTokens: 8, count: (t) => t.length });
		expect(out.text).toBe('aaaa\n\ncc');
		expect(out.records.map((r) => r.status)).toEqual(['keyword', 'trimmed', 'keyword']);
	});

	test('budget prices the joining separator, so the rendered block never outgrows it', () => {
		const entries = ['aaaa', 'bb'].map((content) => ({ ...createEmptyLorebookEntry(), content }));
		// 'bb' alone would fit a budget of 7 (4 + 2), but the block it joins costs '\n\nbb' (4).
		const out = renderLorebookBlock(selectionOf(entries), undefined, { maxTokens: 7, count: (t) => t.length });
		expect(out.text).toBe('aaaa');
		expect(out.records.map((r) => r.status)).toEqual(['keyword', 'trimmed']);
		expect(out.text.length).toBeLessThanOrEqual(7);
	});

	test('budget prices the EXPANDED content, not the raw template', () => {
		const entries = [{ ...createEmptyLorebookEntry(), content: '{{x}}' }];
		const out = renderLorebookBlock(selectionOf(entries), (t) => t.replace('{{x}}', 'a very long expansion'), {
			maxTokens: 5,
			count: (t) => t.length
		});
		expect(out.text).toBe('');
		expect(out.records[0].status).toBe('trimmed');
	});

	test('content that expands to nothing is recorded as empty', () => {
		const entries = [{ ...createEmptyLorebookEntry(), content: '{{x}}' }];
		const out = renderLorebookBlock(selectionOf(entries), () => '');
		expect(out.text).toBe('');
		expect(out.records[0].status).toBe('empty');
	});
});

describe('placement', () => {
	const atDepth = (over: Partial<LorebookEntry> = {}) =>
		book([{ comment: 'Deep', content: 'lore', constant: true, position: LOREBOOK_POSITION_AT_DEPTH, ...over }]);

	test('an at-depth entry leaves the block and becomes its own turn', () => {
		const out = resolveLorebooks({ books: [atDepth()], messages: [], placeAtDepth: true });
		expect(out.text).toBe('');
		expect(out.placed).toEqual([{ role: 'system', depth: 4, text: 'lore' }]);
	});

	test('its depth and role are its own', () => {
		const out = resolveLorebooks({ books: [atDepth({ depth: 0, role: 2 })], messages: [], placeAtDepth: true });
		expect(out.placed).toEqual([{ role: 'assistant', depth: 0, text: 'lore' }]);
	});

	test('entries sharing a role and a depth become ONE turn, in order', () => {
		const b = book([
			{ content: 'second', constant: true, position: LOREBOOK_POSITION_AT_DEPTH, order: 200 },
			{ content: 'first', constant: true, position: LOREBOOK_POSITION_AT_DEPTH, order: 100 },
			{ content: 'user side', constant: true, position: LOREBOOK_POSITION_AT_DEPTH, role: 1, order: 300 }
		]);
		const out = resolveLorebooks({ books: [b], messages: [], placeAtDepth: true });
		expect(out.placed).toEqual([
			{ role: 'system', depth: 4, text: 'first\n\nsecond' },
			{ role: 'user', depth: 4, text: 'user side' }
		]);
	});

	test('a caller that cannot splice folds them into the block instead of losing them', () => {
		const out = resolveLorebooks({ books: [atDepth()], messages: [] });
		expect(out.text).toBe('lore');
		expect(out.placed).toEqual([]);
	});

	test('SillyTavern’s other positions read as the block and are never placed', () => {
		for (const position of [0, 1, 2, 3, 5, 6, 7]) {
			const out = resolveLorebooks({ books: [atDepth({ position })], messages: [], placeAtDepth: true });
			expect(out.text).toBe('lore');
			expect(out.placed).toEqual([]);
		}
	});

	test('the record says where it landed', () => {
		const out = resolveLorebooks({ books: [atDepth({ depth: 2 })], messages: [], placeAtDepth: true });
		expect(out.trace.records[0].placedAt).toEqual({ role: 'system', depth: 2 });
	});

	test('block and at-depth share one budget, spent in order', () => {
		const b = book([
			{ content: 'aaaa', constant: true, order: 100 },
			{ content: 'bbbbbb', comment: 'Deep', constant: true, position: LOREBOOK_POSITION_AT_DEPTH, order: 200 },
			{ content: 'cc', constant: true, order: 300 }
		]);
		const out = resolveLorebooks({
			books: [b],
			messages: [],
			placeAtDepth: true,
			budget: { maxTokens: 8, count: (t) => t.length }
		});
		// The block entry spends 4, the at-depth one would take it to 10 and is dropped, and the
		// smaller entry after it (4 with its separator) still fits: one allowance, whichever
		// side an entry lands on.
		expect(out.text).toBe('aaaa\n\ncc');
		expect(out.placed).toEqual([]);
		expect(out.trace.records.find((r) => r.title === 'Deep')?.status).toBe('trimmed');
	});
});

describe('resolveLorebooks', () => {
	test('returns the injected block and the trace that produced it', () => {
		const b = book([
			{ comment: 'Wolves', content: 'wolves hunt at night', key: ['wolf'] },
			{ comment: 'Town', content: 'town lore', key: ['town'] }
		]);
		const out = resolveLorebooks({ books: [b], messages: ['a wolf howls'], rng: () => 0 });
		expect(out.text).toBe('wolves hunt at night');
		expect(out.trace.records.map((r) => r.title)).toEqual(['Wolves']);
		expect(out.trace.silent).toBe(1);
	});

	test('no books means no block and an empty trace', () => {
		const out = resolveLorebooks({ books: [], messages: ['anything'] });
		expect(out.text).toBe('');
		expect(out.trace).toEqual({ records: [], silent: 0 });
	});
});

describe('recursion across books', () => {
	const crossing: LorebookGlobalSettings = { ...DEFAULT_LOREBOOK_GLOBAL_SETTINGS, crossBookRecursion: true };
	const seed = () => book([{ comment: 'Seed', content: 'the seed names beta', constant: true, order: 100 }], 'Seeds');
	const target = () => book([{ comment: 'Beta', content: 'beta fact', key: ['beta'], order: 200 }], 'Lore');

	test('off by default: an entry cannot wake one in another book', () => {
		expect(fired([seed(), target()], [])).toEqual(['the seed names beta']);
	});

	test('on: it can, and the match names the book it was woken from', () => {
		const books = [seed(), target()];
		expect(fired(books, [], () => 0, crossing)).toEqual(['the seed names beta', 'beta fact']);
		const { records } = scanLorebooks({ books, sources: messageScanSources([]), settings: crossing });
		expect(records.find((r) => r.title === 'Beta')?.matches[0].source).toEqual({
			kind: 'entry',
			entryId: books[0].entries[0].id,
			title: 'Seed',
			bookName: 'Seeds'
		});
	});

	test('a book that does not recurse neither wakes others nor is woken', () => {
		const deaf = target();
		deaf.recursiveScanning = false;
		expect(fired([seed(), deaf], [], () => 0, crossing)).toEqual(['the seed names beta']);
		const mute = seed();
		mute.recursiveScanning = false;
		expect(fired([mute, target()], [], () => 0, crossing)).toEqual(['the seed names beta']);
	});

	test('every entry still matches under the settings of its own book', () => {
		const strict = book([{ content: 'strict fact', key: ['Beta'], order: 200 }], 'Strict');
		strict.caseSensitive = true;
		const loose = book([{ content: 'loose fact', key: ['Beta'], order: 300 }], 'Loose');
		loose.caseSensitive = false;
		// The waking text spells it lowercase, so only the book that ignores case is woken.
		expect(fired([seed(), strict, loose], [], () => 0, crossing)).toEqual(['the seed names beta', 'loose fact']);
	});

	test('the global pass cap governs the shared loop', () => {
		const chain = book(
			[
				{ content: 'seed names alpha', constant: true, order: 100 },
				{ content: 'alpha names beta', key: ['alpha'], order: 200 }
			],
			'Chain'
		);
		// The book's own cap is inert while books recurse together: there is one loop to cap.
		chain.maxRecursionSteps = 1;
		expect(fired([chain, target()], [], () => 0, crossing)).toEqual([
			'seed names alpha',
			'alpha names beta',
			'beta fact'
		]);
		expect(fired([chain, target()], [], () => 0, { ...crossing, maxRecursionSteps: 1 })).toEqual([
			'seed names alpha',
			'alpha names beta'
		]);
	});
});
