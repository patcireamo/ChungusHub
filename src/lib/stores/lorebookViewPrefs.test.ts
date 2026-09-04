/**
 * How the lorebook shelf's stored view preference is read back. Run with `bun test`.
 *
 * The settings key is still `lorebookSort`, the name it had when the order was all it held, so
 * the value sitting on every install that predates the layout, card size and per-page choices
 * is a BARE STRING. Reading one back as the order it names is the only thing between those
 * installs and a shelf that silently reverts to A → Z on the next load, and nothing else
 * exercises it: the store is a rune class, so `normalizeLorebookViewState` is the whole of what
 * a test can reach and the whole of what decides this.
 *
 * Runes are compile-time macros and nothing compiles a store under `bun test`, so `$state` is
 * shimmed BEFORE the module loads, the way transfer.test.ts does. Nothing here reads state, so
 * identity is enough.
 */
import { describe, test, expect } from 'bun:test';

const identity = <T>(value?: T): T | undefined => value;
(globalThis as unknown as { $state: unknown }).$state = Object.assign(identity, { raw: identity });

const { LOREBOOK_SORT_OPTIONS, LOREBOOK_VIEW_DEFAULTS, normalizeLorebookViewState } = await import(
	'./lorebookViewPrefs.svelte'
);

describe('normalizeLorebookViewState: the bare string every old install holds', () => {
	test('each offered order stored on its own reads back as that order', () => {
		for (const option of LOREBOOK_SORT_OPTIONS) {
			expect(normalizeLorebookViewState(option.id).order).toBe(option.id);
		}
	});

	test('a bare string leaves the four choices it predates on their defaults', () => {
		expect(normalizeLorebookViewState('updated')).toEqual({
			...LOREBOOK_VIEW_DEFAULTS,
			order: 'updated'
		});
	});

	// An order that has since been retired cannot leave a device stranded on it.
	test('a bare string naming no offered order falls back to the default', () => {
		expect(normalizeLorebookViewState('most-linked').order).toBe(LOREBOOK_VIEW_DEFAULTS.order);
		expect(normalizeLorebookViewState('').order).toBe(LOREBOOK_VIEW_DEFAULTS.order);
	});
});

describe('normalizeLorebookViewState: everything else the key can hold', () => {
	test('nothing stored, and every shape that is not a blob, reads as the defaults', () => {
		for (const raw of [null, undefined, 7, true, ['a-z'], 'not an order']) {
			expect(normalizeLorebookViewState(raw)).toEqual(LOREBOOK_VIEW_DEFAULTS);
		}
	});

	test('a blob is read key by key, so one bad value cannot cost the others', () => {
		expect(
			normalizeLorebookViewState({
				order: 'z-a',
				viewMode: 'carousel',
				cardSize: 99,
				perPage: 7,
				listCovers: 'yes'
			})
		).toEqual({ ...LOREBOOK_VIEW_DEFAULTS, order: 'z-a' });
	});

	// Covers stay on until somebody turns them off: an install that hid its art on upgrade
	// would read as a shelf of pictures that failed to load.
	test('a blob that predates the covers switch reads back with covers on', () => {
		expect(normalizeLorebookViewState({ order: 'z-a', viewMode: 'list' }).listCovers).toBe(true);
	});

	test('a whole blob survives the trip it is written and read through', () => {
		const stored = {
			order: 'oldest',
			viewMode: 'gallery',
			cardSize: 5,
			perPage: 25,
			listCovers: false
		} as const;
		expect(normalizeLorebookViewState(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
	});
});
