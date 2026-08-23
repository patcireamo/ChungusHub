/**
 * Lorebook activation engine.
 *
 * Three pure steps, mirroring SillyTavern's world-info pass:
 *
 *   1. scanLorebooks: read the scan sources and decide, per entry, whether it fires. Constant
 *      entries always fire; the rest fire on keyword match (primary keys + optional secondary
 *      keys combined by `selectiveLogic`, each key matched in its own mode: anywhere, whole
 *      word, word start, or a `/pattern/flags` regex). Every fired entry then passes its
 *      Trigger % roll (`probability`). An entry reads its own slice of the sources: the chat
 *      clamped to its scan depth, plus the card fields it opted into. When a book has
 *      `recursiveScanning` on, activated content joins the sources so entries can activate
 *      other entries, honouring each entry's own recursion settings ({@link resolveEntryRecursion}):
 *      whether other entries may wake it, whether its content wakes them, and whether it waits
 *      for recursion before it fires at all. Before any of that, an
 *      entry's own past can speak: `delay` holds it back until the chat is long enough, a
 *      `sticky` window keeps it in for a few generations after it fires, and the `cooldown`
 *      after that window shuts it out again. Those are read off the traces earlier turns
 *      stored, never a counter, which is what makes them branch-correct. Last, inclusion
 *      groups cut the survivors down to one entry per label.
 *   2. renderLorebookBlock: turn the fired entries (sorted by `order`) into the text block
 *      injected at the `{{lorebook}}` macro, optionally under a token budget (lowest-priority
 *      entries that don't fit are dropped). Entry titles (`comment`) are organizational and
 *      never sent to the model, matching SillyTavern semantics.
 *   3. resolveLorebooks: both of the above in one call, returning the block and the trace.
 *      Every context builder goes through it, so no surface can select differently from the
 *      one that sends.
 *
 * **Every step records why.** A scan produces one {@link LorebookEntryRecord} per entry, naming
 * the key that matched, the turn it matched in, and the reason an entry that could have fired
 * did not. That record is the whole point: an entry that silently fails to fire is the single
 * hardest thing to debug about a lorebook, and a trace is what the reply carries so the reader
 * can ask afterwards.
 *
 * Activation knobs resolve key → entry → book → global settings; a book field left at null
 * inherits the LorebookGlobalSettings the caller passes (stock defaults when omitted).
 *
 * Pure (no db / stores / Svelte) so it stays unit-testable and shared by the real prompt and
 * the live token meters. Randomness is injectable (`rng`) for the same reason.
 */

import type {
	Lorebook,
	LorebookEntry,
	LorebookEntryRecord,
	LorebookGlobalSettings,
	LorebookKeyMatch,
	LorebookPastScan,
	LorebookPlacedGroup,
	LorebookRole,
	LorebookScanFieldText,
	LorebookScanSource,
	LorebookStatus,
	LorebookTrace,
	LorebookTrigger,
	ResolvedActivation,
	ResolvedKeyMatch
} from './types';
import {
	buildLorebookTrace,
	compileRegexKey,
	DEFAULT_GROUP_WEIGHT,
	DEFAULT_LOREBOOK_DEPTH,
	DEFAULT_LOREBOOK_GLOBAL_SETTINGS,
	firesOnTrigger,
	LOREBOOK_SCAN_FIELDS,
	lorebookGroupsOf,
	lorebookHistory,
	lorebookIsAtDepth,
	lorebookRoleOf,
	lorebookWasInjected,
	resolveBookActivation,
	resolveEntryRecursion,
	resolveKeyMatch
} from './types';

/** Matching defaults after the book has been resolved against the global settings. */
interface MatchDefaults {
	caseSensitive: boolean;
	matchWholeWords: boolean;
}

/** Characters of context kept on either side of a hit when quoting it back to the reader. */
const EXCERPT_RADIUS = 32;

/** Turn a chat path (oldest → newest) into scan sources, newest at depth 0. */
export function messageScanSources(messages: string[]): LorebookScanSource[] {
	const newest = messages.length - 1;
	return messages.map((text, i) => ({ kind: 'message', depth: newest - i, text }));
}

/**
 * The card text an entry can opt into, as scan sources. Blank fields produce none, so an entry
 * scanning a scenario nobody wrote simply reads nothing rather than matching an empty string.
 */
export function fieldScanSources(fields: LorebookScanFieldText | undefined): LorebookScanSource[] {
	if (!fields) return [];
	const out: LorebookScanSource[] = [];
	for (const { id } of LOREBOOK_SCAN_FIELDS) {
		const text = fields[id];
		if (text && text.trim()) out.push({ kind: 'field', field: id, text });
	}
	return out;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A key ready to run: text in, the hit's position out. */
type Matcher = (text: string) => { at: number; length: number } | null;

/** Word characters, the boundary every mode but `substring` is defined against. */
const WORD_CHAR = '[\\p{L}\\p{N}_]';

/**
 * Turn one key into the function that finds it, or null when the key can't be used at all
 * (blank, or a `/pattern/` that doesn't compile). An unusable key matches nothing rather than
 * throwing: the entry editor marks a broken pattern where it is written, and a scan running
 * mid-generation is not the place to take the prompt down with it.
 *
 * Compiled once per key per pass, so the `g`/`y` flags are stripped: they would carry
 * `lastIndex` from one source into the next and start losing matches.
 */
function compileKey(key: string, match: ResolvedKeyMatch): Matcher | null {
	const needle = key.trim();
	if (!needle) return null;

	if (match.mode === 'regex' && match.regex) {
		const re = compileRegexKey(match.regex);
		if (!re) return null;
		return (text) => {
			const hit = re.exec(text);
			return hit ? { at: hit.index, length: hit[0].length } : null;
		};
	}

	if (match.mode !== 'substring') {
		// Both close the left edge at a word boundary. `word` closes the right one too;
		// `start` eats the rest of the word instead, so the key matches "dragons" and
		// "ejderhanın" while staying out of "windragon", and the excerpt quotes the whole word.
		const tail = match.mode === 'start' ? `${WORD_CHAR}*` : `(?!${WORD_CHAR})`;
		try {
			const re = new RegExp(
				`(?<!${WORD_CHAR})${escapeRegExp(needle)}${tail}`,
				match.caseSensitive ? 'u' : 'iu'
			);
			return (text) => {
				const hit = re.exec(text);
				return hit ? { at: hit.index, length: hit[0].length } : null;
			};
		} catch {
			// Fall through to substring matching if the engine lacks lookbehind/unicode classes.
		}
	}

	const cased = match.caseSensitive;
	const wanted = cased ? needle : needle.toLowerCase();
	return (text) => {
		const at = (cased ? text : text.toLowerCase()).indexOf(wanted);
		return at >= 0 ? { at, length: needle.length } : null;
	};
}

/** The text around a hit, on one line, elided where it was cut. */
function excerptAround(text: string, at: number, length: number): string {
	const start = Math.max(0, at - EXCERPT_RADIUS);
	const end = Math.min(text.length, at + length + EXCERPT_RADIUS);
	const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
	return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** A source, minus its text: what a match reports back. */
function sourceOf(source: LorebookScanSource): LorebookKeyMatch['source'] {
	switch (source.kind) {
		case 'message':
			return { kind: 'message', depth: source.depth };
		case 'field':
			return { kind: 'field', field: source.field };
		case 'entry':
			return { kind: 'entry', entryId: source.entryId, title: source.title, bookName: source.bookName };
	}
}

/**
 * Find `key` in the sources, newest first: a key present in several turns is reported against
 * the most recent one, which is the one the reader is looking at.
 */
function findKey(
	key: string,
	sources: LorebookScanSource[],
	role: 'primary' | 'secondary',
	rules: LorebookEntry['keyRules'],
	defaults: MatchDefaults
): LorebookKeyMatch | null {
	const matcher = compileKey(key, resolveKeyMatch(key, rules, defaults));
	if (!matcher) return null;
	for (let i = sources.length - 1; i >= 0; i--) {
		const source = sources[i];
		const hit = matcher(source.text);
		if (!hit) continue;
		return { key, role, source: sourceOf(source), excerpt: excerptAround(source.text, hit.at, hit.length) };
	}
	return null;
}

/** What an entry's keys decided, and the evidence for it. */
interface KeyVerdict {
	fired: boolean;
	/** A primary key was found, whatever the secondary filter then decided. */
	primaryHit: boolean;
	matches: LorebookKeyMatch[];
}

const NO_MATCH: KeyVerdict = { fired: false, primaryHit: false, matches: [] };
/** A constant entry's verdict: it fires without being asked to match anything. */
const ALWAYS: KeyVerdict = { fired: true, primaryHit: true, matches: [] };

function found(
	keys: string[],
	sources: LorebookScanSource[],
	role: 'primary' | 'secondary',
	rules: LorebookEntry['keyRules'],
	defaults: MatchDefaults
): LorebookKeyMatch[] {
	const hits: LorebookKeyMatch[] = [];
	for (const key of keys) {
		const hit = findKey(key, sources, role, rules, defaults);
		if (hit) hits.push(hit);
	}
	return hits;
}

/**
 * Whether a keyword-triggered entry's keys fire against the sources, and what they matched.
 * The last two layers of the cascade land here: an entry's own tri-state match fields override
 * the book's resolved defaults (`null` inherits them), and each key's own rule overrides those
 * in turn (`resolveKeyMatch`).
 */
function evaluateKeys(
	entry: LorebookEntry,
	sources: LorebookScanSource[],
	bookDefaults: MatchDefaults
): KeyVerdict {
	const defaults: MatchDefaults = {
		caseSensitive: entry.caseSensitive ?? bookDefaults.caseSensitive,
		matchWholeWords: entry.matchWholeWords ?? bookDefaults.matchWholeWords
	};
	const primary = found(entry.key, sources, 'primary', entry.keyRules, defaults);
	if (primary.length === 0) return NO_MATCH;
	if (entry.keysecondary.length === 0) return { fired: true, primaryHit: true, matches: primary };

	const secondary = found(entry.keysecondary, sources, 'secondary', entry.keyRules, defaults);
	const hits = secondary.length;
	const total = entry.keysecondary.length;
	let fired: boolean;
	switch (entry.selectiveLogic) {
		case 0: // AND ANY
			fired = hits > 0;
			break;
		case 3: // AND ALL
			fired = hits === total;
			break;
		case 2: // NOT ANY
			fired = hits === 0;
			break;
		case 1: // NOT ALL
			fired = hits < total;
			break;
		default:
			fired = true;
	}
	return { fired, primaryHit: true, matches: [...primary, ...secondary] };
}

/** SillyTavern "Trigger %": a fired entry still has to pass its probability roll. */
function passesProbability(entry: LorebookEntry, rng: () => number): boolean {
	if (!entry.useProbability || entry.probability >= 100) return true;
	return rng() * 100 < entry.probability;
}

// ===== timed effects =====

/**
 * How many generations back this entry last EARNED its place, or null if it never did on this
 * path. Read off the traces earlier turns stored rather than a counter, which is the whole
 * reason the windows below survive a swipe: a branch is a path through turns, so walking the
 * path back is already branch-correct, where a per-chat counter would carry a discarded
 * attempt's activation into the reply that replaced it.
 */
function generationsSince(entryId: string, history: LorebookPastScan[]): number | null {
	for (let i = 0; i < history.length; i++) {
		if (history[i].fired.has(entryId)) return i + 1;
	}
	return null;
}

/** What an entry's own past says about this turn, before its keys are even read. */
type TimedVerdict = 'free' | 'sticky' | 'cooldown';

/**
 * Sticky first, then cooldown, on one timeline measured from the last natural firing: the
 * window holds the entry in for `sticky` generations, and the cooldown that follows shuts it
 * out for `cooldown` more. Both are zero by default, so an entry that sets neither is always
 * free and never touches this.
 */
function timedVerdict(entry: LorebookEntry, history: LorebookPastScan[]): TimedVerdict {
	const sticky = entry.sticky ?? 0;
	const cooldown = entry.cooldown ?? 0;
	if (sticky <= 0 && cooldown <= 0) return 'free';
	const since = generationsSince(entry.id, history);
	if (since === null) return 'free';
	if (since <= sticky) return 'sticky';
	if (since <= sticky + cooldown) return 'cooldown';
	return 'free';
}

/**
 * What one entry reads: the chat clamped to its own scan depth (its override, else the book's;
 * 0 = the whole chat), the card fields it opted into, and everything recursion has pulled in,
 * which is never windowed. Per entry rather than per book, because an entry's depth override
 * may reach further back than the book's.
 *
 * An entry that waits for recursion reads that last group alone: it asked to be woken by other
 * entries, so the story text it would otherwise have matched is not an answer to that.
 */
function sourcesFor(
	entry: LorebookEntry,
	sources: LorebookScanSource[],
	bookScanDepth: number,
	entriesOnly: boolean
): LorebookScanSource[] {
	const depth = entry.scanDepth ?? bookScanDepth;
	const fields = entry.scanFields;
	return sources.filter((s) => {
		if (s.kind === 'entry') return true;
		if (entriesOnly) return false;
		if (s.kind === 'message') return depth <= 0 || s.depth < depth;
		return !!fields?.includes(s.field);
	});
}

/** The verdicts a later recursion pass may overturn: the ones the keys themselves reached. */
const REVISITABLE: readonly LorebookStatus[] = ['noMatch', 'filtered', 'delayed'];

/** One entry with the book it came from, so a shared pass keeps every book's own settings. */
interface PooledEntry {
	book: Lorebook;
	entry: LorebookEntry;
	knobs: ResolvedActivation;
}

/**
 * The firing entries of one pool of books, in pool order, with a record for every entry.
 *
 * A pool is a single book, or every book at once when recursion crosses them. What the pool
 * shares is the sources and the loop; what it never shares is the settings, so an entry always
 * matches under the book it was authored in. A book that does not recurse stays out of the
 * recursion economy entirely: it is neither woken by another entry nor able to wake one.
 */
function selectFromBooks(
	books: Lorebook[],
	allSources: LorebookScanSource[],
	rng: () => number,
	settings: LorebookGlobalSettings,
	trigger: LorebookTrigger,
	history: LorebookPastScan[],
	chatLength: number,
	expand: (text: string) => string,
	maxSteps: number
): { entries: LorebookEntry[]; records: LorebookEntryRecord[] } {
	const pool: PooledEntry[] = books.flatMap((book) => {
		const knobs = resolveBookActivation(book, settings);
		return book.entries.map((entry) => ({ book, entry, knobs }));
	});
	const matchDefaults = ({ knobs }: PooledEntry): MatchDefaults => ({
		caseSensitive: knobs.caseSensitive,
		matchWholeWords: knobs.matchWholeWords
	});
	// Grows as recursion admits entries, so every later pass scans the chat AND everything
	// already pulled in. Each entry then reads its own slice of it (`sourcesFor`).
	const sources = [...allSources];

	const records = new Map<string, LorebookEntryRecord>();
	const write = (
		{ book, entry }: PooledEntry,
		status: LorebookStatus,
		matches: LorebookKeyMatch[] = [],
		probability?: number
	) => {
		records.set(entry.id, {
			bookId: book.id,
			bookName: book.name,
			entryId: entry.id,
			title: entry.comment,
			status,
			matches,
			...(probability === undefined ? {} : { probability })
		});
	};

	/** Everything an entry's own past and settings decide before its keys are read. */
	const gate = (entry: LorebookEntry): LorebookStatus | null => {
		if (entry.disable) return 'disabled';
		if (!entry.content.trim()) return 'empty';
		if (!firesOnTrigger(entry.triggers, trigger)) return 'offTrigger';
		// Delay counts the whole chat, not the entry's own scan window: it asks how far the
		// story has come, which a narrow window would answer with a number about itself.
		if ((entry.delay ?? 0) > 0 && chatLength < (entry.delay ?? 0)) return 'tooEarly';
		const timed = timedVerdict(entry, history);
		if (timed === 'cooldown') return 'cooldown';
		// A sticky entry skips its keys AND its Trigger % roll: it already earned both on the
		// turn that opened the window, and re-rolling would make the window fray at random.
		// It comes before the recursion settings for the same reason: an open window is a
		// decision an earlier turn already made, and none of them can overturn it.
		if (timed === 'sticky') return 'sticky';
		const recursion = resolveEntryRecursion(entry);
		if (recursion.excludeRecursion && recursion.delayLevel > 0) return 'neverFires';
		return null;
	};

	const active: LorebookEntry[] = [];

	// Pass 1 reads the chat window. Constant entries fire on sight; an entry waiting for
	// recursion sits this pass out whatever its nature, which is what lets an always-active
	// preamble arrive only once some lore has.
	const newly: PooledEntry[] = [];
	for (const pooled of pool) {
		const { entry, knobs } = pooled;
		const gated = gate(entry);
		if (gated === 'sticky') {
			write(pooled, 'sticky');
			active.push(entry);
			newly.push(pooled);
			continue;
		}
		if (gated) {
			write(pooled, gated);
			continue;
		}
		if (resolveEntryRecursion(entry).delayLevel > 0) {
			write(pooled, 'delayed');
			continue;
		}
		const verdict = entry.constant
			? ALWAYS
			: evaluateKeys(entry, sourcesFor(entry, sources, knobs.scanDepth, false), matchDefaults(pooled));
		if (!verdict.primaryHit) {
			write(pooled, 'noMatch');
			continue;
		}
		if (!verdict.fired) {
			write(pooled, 'filtered', verdict.matches);
			continue;
		}
		if (!passesProbability(entry, rng)) {
			write(pooled, 'rolledOut', verdict.matches, entry.probability);
			continue;
		}
		write(pooled, entry.constant ? 'constant' : 'keyword', verdict.matches);
		active.push(entry);
		newly.push(pooled);
	}

	// Only the books that recurse take part; every other entry was settled by the pass above.
	const recursing = pool.filter((p) => p.knobs.recursiveScanning);
	if (recursing.length > 0) {
		// The levels waiting above the first, lowest first. A level opens only once the ones
		// below it have run dry, so a book staged into waves arrives a wave at a time instead
		// of all at once on the first pass.
		const waves = [...new Set(recursing.map((p) => resolveEntryRecursion(p.entry).delayLevel))]
			.filter((level) => level > 1)
			.sort((a, b) => a - b);
		let level = 1;
		let steps = 0;
		// What this pass adds to the sources. An entry that wakes nobody still fires; only its
		// content stays out. When nothing is left to add, the next wave opens against everything
		// already gathered and gets one pass of its own.
		let feed = newly.filter(
			(p) => p.knobs.recursiveScanning && !resolveEntryRecursion(p.entry).preventRecursion
		);
		while (feed.length > 0 || waves.length > 0) {
			// 0 = no cap: keep going until nothing new fires and no wave is left.
			if (maxSteps > 0 && steps >= maxSteps) break;
			if (feed.length === 0) {
				const opened = waves.shift();
				if (opened === undefined) break;
				level = opened;
			}
			steps++;
			for (const { book, entry } of feed) {
				// Expanded like the card fields are, so an entry writing {{char}} is read as it
				// reaches the model rather than as its own braces.
				sources.push({
					kind: 'entry',
					entryId: entry.id,
					title: entry.comment,
					bookName: book.name,
					text: expand(entry.content)
				});
			}

			const next: PooledEntry[] = [];
			for (const pooled of recursing) {
				const { entry, knobs } = pooled;
				const decided = records.get(entry.id);
				if (!decided) continue;
				// Only a verdict the keys themselves reached can change when new text arrives.
				// Everything else is settled: it is already in, a lost roll is never re-rolled
				// (re-rolling every round would inflate the effective chance to 1-(1-p)^rounds),
				// and the gate's answers do not depend on the sources at all.
				if (!REVISITABLE.includes(decided.status)) continue;
				const recursion = resolveEntryRecursion(entry);
				if (recursion.excludeRecursion) continue;
				if (recursion.delayLevel > level) continue;

				if (entry.constant) {
					// The one constant that can still be undecided here is one held back by its
					// delay. Recursion has now run, so it fires, and it fires without keys.
					if (!passesProbability(entry, rng)) {
						write(pooled, 'rolledOut', [], entry.probability);
						continue;
					}
					write(pooled, 'constant');
					active.push(entry);
					next.push(pooled);
					continue;
				}

				const verdict = evaluateKeys(
					entry,
					sourcesFor(entry, sources, knobs.scanDepth, recursion.delayLevel > 0),
					matchDefaults(pooled)
				);
				if (!verdict.primaryHit) {
					write(pooled, 'noMatch');
					continue;
				}
				if (!verdict.fired) {
					write(pooled, 'filtered', verdict.matches);
					continue;
				}
				if (!passesProbability(entry, rng)) {
					write(pooled, 'rolledOut', verdict.matches, entry.probability);
					continue;
				}
				write(pooled, 'keyword', verdict.matches);
				active.push(entry);
				next.push(pooled);
			}
			feed = next.filter((p) => !resolveEntryRecursion(p.entry).preventRecursion);
		}
	}

	return { entries: active, records: [...records.values()] };
}

/** Token budget for the rendered block: a cap plus the counter to measure content with. */
export interface LorebookBudget {
	maxTokens: number;
	count: (text: string) => number;
}

/** What a scan produced: the entries to inject, in injection order, and why each entry fared. */
export interface LorebookSelection {
	entries: LorebookEntry[];
	records: LorebookEntryRecord[];
}

// ===== inclusion groups =====

/** One entry standing for a slot, with the record that will say so if it loses. */
interface GroupCandidate {
	entry: LorebookEntry;
	record: LorebookEntryRecord;
}

/**
 * Which candidate takes the group's one slot, in four narrowing steps.
 *
 * A sticky candidate wins outright: it is in because an earlier turn already decided, and
 * letting the group re-run against it every generation is exactly how a sticky window turns
 * into a flicker. Then Prioritize, then scoring (most keys matched), and whatever survives all
 * three goes to the weighted roll, which is the whole point of a group: variety across turns.
 */
function pickWinner(candidates: GroupCandidate[], rng: () => number): GroupCandidate {
	const sticky = candidates.filter((c) => c.record.status === 'sticky');
	let pool = sticky.length > 0 ? sticky : candidates;

	const prioritized = pool.filter((c) => c.entry.groupOverride);
	if (prioritized.length > 0) pool = prioritized;

	// Scoring is asked of the group, not of each entry: one candidate turning it on decides the
	// contest, or the same group would be judged two ways at once.
	if (pool.some((c) => c.entry.useGroupScoring)) {
		const best = Math.max(...pool.map((c) => c.record.matches.length));
		pool = pool.filter((c) => c.record.matches.length === best);
	}

	if (pool.length === 1) return pool[0];
	const weight = (c: GroupCandidate) => Math.max(0, c.entry.groupWeight ?? DEFAULT_GROUP_WEIGHT);
	const total = pool.reduce((sum, c) => sum + weight(c), 0);
	if (total <= 0) return pool[0];
	let roll = rng() * total;
	for (const c of pool) {
		roll -= weight(c);
		if (roll < 0) return c;
	}
	return pool[pool.length - 1];
}

/**
 * Keep one entry per inclusion group label, and tell every loser which entry took its slot.
 * A group is a set of alternatives for one idea, so a scan that admits three of them has
 * silently turned a choice into a pile.
 *
 * An entry may name several labels and has to survive all of them: losing one is losing.
 */
function resolveGroups(
	entries: LorebookEntry[],
	records: Map<string, LorebookEntryRecord>,
	rng: () => number
): LorebookEntry[] {
	const groups = new Map<string, GroupCandidate[]>();
	for (const entry of entries) {
		const record = records.get(entry.id);
		if (!record) continue;
		for (const label of lorebookGroupsOf(entry)) {
			const list = groups.get(label);
			if (list) list.push({ entry, record });
			else groups.set(label, [{ entry, record }]);
		}
	}
	if (groups.size === 0) return entries;

	const lost = new Set<string>();
	for (const [label, candidates] of groups) {
		const standing = candidates.filter((c) => !lost.has(c.entry.id));
		if (standing.length < 2) continue;
		const winner = pickWinner(standing, rng);
		for (const c of standing) {
			if (c.entry.id === winner.entry.id) continue;
			lost.add(c.entry.id);
			records.set(c.entry.id, {
				...c.record,
				status: 'groupLost',
				lostTo: { group: label, title: winner.entry.comment }
			});
		}
	}
	return entries.filter((e) => !lost.has(e.id));
}

/** Everything one scan needs. */
export interface LorebookScanInput {
	books: Lorebook[];
	/** Everything readable, from {@link messageScanSources} and {@link fieldScanSources}. */
	sources: LorebookScanSource[];
	/** Feeds the Trigger % rolls and the group picks; injectable so tests and meters can pin it. */
	rng?: () => number;
	/** The global defaults each book resolves against; omitted = stock. */
	settings?: LorebookGlobalSettings;
	/** The generation in progress, which entries naming their kinds sit out. */
	trigger?: LorebookTrigger;
	/** What earlier generations on this path decided, newest first ({@link lorebookHistory}). */
	history?: LorebookPastScan[];
	/** Macro expansion for the content recursion feeds back in; identity when the caller has
	 *  no context to expand against. */
	expand?: (text: string) => string;
}

/**
 * Scan every given book and pick the entries to inject, sorted by `order` ascending (lower is
 * injected first, which is where SillyTavern's own descending sort plus unshift lands too).
 * Each entry reads its own slice of the sources (scan depth, opted-in fields), the ONLY thing
 * that windows the scan; then the inclusion groups cut the survivors down to one entry per label.
 */
export function scanLorebooks(input: LorebookScanInput): LorebookSelection {
	const rng = input.rng ?? Math.random;
	const history = input.history ?? [];
	const settings = input.settings ?? DEFAULT_LOREBOOK_GLOBAL_SETTINGS;
	const chatLength = input.sources.filter((s) => s.kind === 'message').length;
	const entries: LorebookEntry[] = [];
	const records = new Map<string, LorebookEntryRecord>();
	const run = (pool: Lorebook[], maxSteps: number) => {
		const picked = selectFromBooks(
			pool,
			input.sources,
			rng,
			settings,
			input.trigger ?? 'normal',
			history,
			chatLength,
			input.expand ?? ((t: string) => t),
			maxSteps
		);
		entries.push(...picked.entries);
		for (const record of picked.records) records.set(record.entryId, record);
	};
	if (settings.crossBookRecursion) {
		// One loop over everything in play. A shared loop cannot honour a cap each book set for
		// itself, so the global one governs while books recurse together.
		run(input.books, settings.maxRecursionSteps);
	} else {
		for (const book of input.books) {
			run([book], resolveBookActivation(book, settings).maxRecursionSteps);
		}
	}
	// Groups are resolved across every book at once: a label names one idea, and two books
	// carrying alternatives for it are exactly the case the feature is for.
	const kept = resolveGroups(entries, records, rng);
	kept.sort((a, b) => a.order - b.order);
	return { entries: kept, records: [...records.values()] };
}

/** The injected block, the at-depth groups, and the records rendering itself updated. */
export interface LorebookRender {
	text: string;
	placed: LorebookPlacedGroup[];
	records: LorebookEntryRecord[];
}

/**
 * Render what the scan chose. `expand` runs macro expansion on each entry's content (so
 * `{{char}}` / `{{user}}` etc. work inside lore). It defaults to identity for tests. Titles are
 * never rendered (organizational only, per SillyTavern).
 *
 * Entries split by where they asked to land: most join the `{{lorebook}}` block, and the ones
 * asking for a depth are grouped by role and depth into one turn each. `placeAtDepth` is the
 * caller saying whether it CAN splice into the chat; when it can't (no `{{chatHistory}}` in the
 * preset, or a surface that assembles nothing), those entries join the block rather than
 * vanishing into a position nothing renders.
 *
 * With a `budget`, entries are admitted greedily in priority order (the selection's own sort)
 * against ONE shared allowance, block and at-depth together, because the budget caps all lore in
 * a prompt at once. An entry that doesn't fit is dropped and its record says so; a later,
 * smaller one may still fit. Deterministic given the same inputs, so the meters and the real
 * prompt agree on what survives.
 */
export function renderLorebookBlock(
	selection: LorebookSelection,
	expand: (text: string) => string = (t) => t,
	budget?: LorebookBudget,
	placeAtDepth = false
): LorebookRender {
	const parts: string[] = [];
	/** Keyed by role and depth, so entries sharing both become one turn. */
	const groups = new Map<string, LorebookPlacedGroup & { texts: string[] }>();
	const trimmed = new Set<string>();
	const blank = new Set<string>();
	const placedAt = new Map<string, { role: LorebookRole; depth: number }>();
	let spent = 0;
	for (const entry of selection.entries) {
		const content = expand(entry.content).trim();
		if (!content) {
			// Content that expanded to nothing: it fired, but there is nothing to inject.
			blank.add(entry.id);
			continue;
		}
		const atDepth = placeAtDepth && lorebookIsAtDepth(entry);
		const role = lorebookRoleOf(entry);
		const depth = entry.depth ?? DEFAULT_LOREBOOK_DEPTH;
		const group = atDepth ? groups.get(`${role} ${depth}`) : undefined;
		if (budget) {
			// The separator an entry brings into its container (the block, or its role+depth
			// group) is part of what lore injects, so it is priced with the entry.
			const joins = atDepth ? group !== undefined : parts.length > 0;
			const cost = budget.count(joins ? `\n\n${content}` : content);
			if (spent + cost > budget.maxTokens) {
				trimmed.add(entry.id);
				continue;
			}
			spent += cost;
		}
		if (atDepth) {
			if (group) group.texts.push(content);
			else groups.set(`${role} ${depth}`, { role, depth, text: '', texts: [content] });
			placedAt.set(entry.id, { role, depth });
			continue;
		}
		parts.push(content);
	}
	const records = selection.records.map((record) => {
		if (trimmed.has(record.entryId)) return { ...record, status: 'trimmed' as const };
		if (blank.has(record.entryId)) return { ...record, status: 'empty' as const };
		const at = placedAt.get(record.entryId);
		return at ? { ...record, placedAt: at } : record;
	});
	// Data only, no injected heading. The preset supplies the framing around
	// {{lorebook}} (tags, lead-in), so the block composes instead of asserting itself.
	return {
		text: parts.join('\n\n'),
		placed: [...groups.values()].map(({ role, depth, texts }) => ({ role, depth, text: texts.join('\n\n') })),
		records
	};
}

/** What a context injects: the block, the turns to splice into the chat, and why. */
export interface LorebookResolution {
	text: string;
	placed: LorebookPlacedGroup[];
	trace: LorebookTrace;
}

/**
 * Scan and render in one call: the ONE way a MacroContext gets its lorebook block. Every
 * context builder (the generation path, the live token meters, the store-sourced twins) goes
 * through this, so a surface can never select differently from the one that sends, and the
 * trace stored on a turn names exactly the entries that shaped it.
 */
export function resolveLorebooks(opts: {
	books: Lorebook[];
	/** The chat path macros read, oldest → newest, message contents only. */
	messages: string[];
	/** The cards' own text ({@link lorebookScanFields}); only entries that opted into a field see it. */
	fields?: LorebookScanFieldText;
	/** What is being generated; entries naming their kinds sit the others out. Default: a send. */
	trigger?: LorebookTrigger;
	/** The traces the path's earlier turns stored, newest first: what sticky and cooldown read. */
	history?: LorebookPastScan[];
	settings?: LorebookGlobalSettings;
	/** Macro expansion for entry content; identity when the caller has no context to expand against. */
	expand?: (text: string) => string;
	budget?: LorebookBudget;
	rng?: () => number;
	/** Whether this caller can splice turns into the chat. False (the default) folds every
	 *  at-depth entry into the block, so no entry lands in a position nothing renders. */
	placeAtDepth?: boolean;
}): LorebookResolution {
	const expand = opts.expand ?? ((t: string) => t);
	// Card fields go in FRONT of the chat: sources are searched from the back, so a key present
	// in both is reported against the turn the reader is looking at, not the description. They
	// are expanded like entry content, so a card writing {{char}} is scanned as it reads.
	const fields = fieldScanSources(opts.fields).map((s) => ({ ...s, text: expand(s.text) }));
	const selection = scanLorebooks({
		books: opts.books,
		sources: [...fields, ...messageScanSources(opts.messages)],
		rng: opts.rng,
		settings: opts.settings,
		trigger: opts.trigger,
		history: opts.history,
		expand
	});
	const rendered = renderLorebookBlock(selection, expand, opts.budget, opts.placeAtDepth);
	return {
		text: rendered.text,
		placed: rendered.placed,
		trace: buildLorebookTrace(rendered.records)
	};
}
