/**
 * Shared list-pipeline pieces for the Library browse views (Characters & Personas):
 * sort options, search matching, and the view-mode/card-size constants. Keeps the two
 * views speaking the same language without parameterizing them into one component.
 */
import type { LibraryEntry } from '$lib/types/library';

export type ViewMode = 'grid' | 'list' | 'gallery';

export type SortOption =
	| 'a-z'
	| 'z-a'
	| 'newest'
	| 'oldest'
	| 'most-content'
	| 'least-content'
	| 'recent'
	| 'most-chats'
	| 'least-chats'
	| 'most-messages'
	| 'least-messages'
	| 'random';

export const SORT_OPTIONS: { id: SortOption; label: string }[] = [
	{ id: 'a-z', label: 'A → Z' },
	{ id: 'z-a', label: 'Z → A' },
	{ id: 'newest', label: 'Newest' },
	{ id: 'oldest', label: 'Oldest' },
	{ id: 'most-content', label: 'Most Content' },
	{ id: 'least-content', label: 'Least Content' }
];

/** Characters get chat-aware sorts on top of the shared set: chats are bound to
 *  characters, so these mean nothing on the Personas tab. */
export const CHARACTER_SORT_OPTIONS: { id: SortOption; label: string }[] = [
	...SORT_OPTIONS,
	{ id: 'most-chats', label: 'Most Chats' },
	{ id: 'least-chats', label: 'Least Chats' },
	{ id: 'most-messages', label: 'Most Messages' },
	{ id: 'least-messages', label: 'Least Messages' },
	{ id: 'recent', label: 'Recent' },
	{ id: 'random', label: 'Random' }
];

export const PER_PAGE_OPTIONS = [25, 50, 100, 200, 500, 1000];

/** Grid card size preference (1-5, where 3 is default) → min column width in px. */
export const CARD_SIZE_MAP: Record<number, number> = {
	1: 100, // Extra small - most columns
	2: 130, // Small
	3: 160, // Medium (default)
	4: 200, // Large
	5: 250 // Extra large - fewest columns
};

export function entryContentSize(entry: LibraryEntry): number {
	let total = (entry.identity.name || '').length;
	for (const val of Object.values(entry.data.traits)) {
		total += (val || '').length;
	}
	return total;
}

export interface ChatStats {
	chats: number;
	messages: number;
	/** Timestamp of the entry's last real user message: 0 when never talked to,
	 *  so freshly created (or greeting-only) chats don't inflate Recent. */
	lastActivity: number;
}

export interface SortContext {
	/** entryId → chat stats; drives the recent / chats / messages sorts. */
	chatStats?: Map<string, ChatStats>;
	/** Seed for the random sort: same seed keeps the order stable across filtering
	 *  and pagination; reroll it to reshuffle. */
	randomSeed?: number;
}

/** Deterministic per-entry rank for the random sort (FNV-1a over id, seeded). */
function seededRank(id: string, seed: number): number {
	let h = (0x811c9dc5 ^ seed) >>> 0;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

export function sortEntries(
	entries: LibraryEntry[],
	sort: SortOption,
	ctx?: SortContext
): LibraryEntry[] {
	const sorted = [...entries];
	const stats = (e: LibraryEntry): ChatStats =>
		ctx?.chatStats?.get(e.id) ?? { chats: 0, messages: 0, lastActivity: 0 };
	switch (sort) {
		case 'a-z':
			return sorted.sort((a, b) => (a.identity.name || '').localeCompare(b.identity.name || ''));
		case 'z-a':
			return sorted.sort((a, b) => (b.identity.name || '').localeCompare(a.identity.name || ''));
		case 'newest':
			return sorted.sort((a, b) => b.createdAt - a.createdAt);
		case 'oldest':
			return sorted.sort((a, b) => a.createdAt - b.createdAt);
		case 'most-content':
			return sorted.sort((a, b) => entryContentSize(b) - entryContentSize(a));
		case 'least-content':
			return sorted.sort((a, b) => entryContentSize(a) - entryContentSize(b));
		case 'recent':
			return sorted.sort((a, b) => stats(b).lastActivity - stats(a).lastActivity);
		case 'most-chats':
			return sorted.sort((a, b) => stats(b).chats - stats(a).chats);
		case 'least-chats':
			return sorted.sort((a, b) => stats(a).chats - stats(b).chats);
		case 'most-messages':
			return sorted.sort((a, b) => stats(b).messages - stats(a).messages);
		case 'least-messages':
			return sorted.sort((a, b) => stats(a).messages - stats(b).messages);
		case 'random': {
			const seed = ctx?.randomSeed ?? 0;
			return sorted.sort((a, b) => seededRank(a.id, seed) - seededRank(b.id, seed));
		}
		default:
			return sorted;
	}
}

/**
 * Case fold for search comparison. Plain toLowerCase() breaks the dotted/dotless I family:
 * "İ" lowercases to "i" + a combining dot (so "irem" could never find "İrem"), and
 * "I"/"ı" land on different letters depending on the original casing. Folding the
 * whole family to "i" before lowercasing makes any casing of a name match any casing
 * of the query. Letters like ö/ü/ş/ç/ğ are distinct letters, not accents. They are
 * deliberately NOT folded, so "göl" does not match "gol".
 *
 * Exported because the lorebook shelf and the two pickers over it search names too, and a
 * second casing rule would make the same query find a book in one list and miss it in the next.
 */
export function foldForSearch(s: string): string {
	return s.normalize('NFC').replace(/[İI]/g, 'i').toLowerCase().replace(/ı/g, 'i');
}

function tokenize(query: string): string[] {
	return foldForSearch(query).split(/\s+/).filter(Boolean);
}

/**
 * Where the query matched, best first: 0 = start of a word in the name ("lia" → "Lian"),
 * 1 = anywhere in the name ("lia" → "Julia"), 2 = tags, 3 = description, -1 = no match.
 */
function searchTier(entry: LibraryEntry, tokens: string[]): number {
	const name = foldForSearch(entry.identity.name || '');
	const words = name.split(/[^\p{L}\p{N}]+/u);
	if (tokens.every((t) => words.some((w) => w.startsWith(t)))) return 0;
	if (tokens.every((t) => name.includes(t))) return 1;
	const withTags = name + '\n' + foldForSearch((entry.identity.tags ?? []).join('\n'));
	if (tokens.every((t) => withTags.includes(t))) return 2;
	const all = withTags + '\n' + foldForSearch(entry.data.traits.description || '');
	if (tokens.every((t) => all.includes(t))) return 3;
	return -1;
}

/**
 * Free-text search over name, tags, and description. Every whitespace-separated word
 * in the query must appear somewhere in the entry, in any order, so "elf knight"
 * finds "Knight of the Elves". An empty query matches everything.
 */
export function matchesSearch(entry: LibraryEntry, query: string): boolean {
	const tokens = tokenize(query);
	return tokens.length === 0 || searchTier(entry, tokens) >= 0;
}

/**
 * Stable re-rank applied after sorting while a query is active, in searchTier order:
 * word-start name matches, then name substrings, tags, and description-only matches.
 * Within each band the incoming (user-chosen) sort order is preserved. A no-op when
 * the query is empty.
 */
export function rankSearchResults(entries: LibraryEntry[], query: string): LibraryEntry[] {
	const tokens = tokenize(query);
	if (tokens.length === 0) return entries;
	return entries
		.map((entry) => ({ entry, tier: searchTier(entry, tokens) }))
		.sort((a, b) => a.tier - b.tier)
		.map((x) => x.entry);
}
