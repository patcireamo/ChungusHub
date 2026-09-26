<script lang="ts">
	/**
	 * Picking entries by the settings they hold: the body of the dialog the selection bar's
	 * Select by… raises. Every knob Edit… sets is read here as the answers the list's entries
	 * give it, each counted, and a press picks an answer (lorebook/select.ts). The entries giving
	 * a picked answer for every knob picked from are what the footer hands the selection, added
	 * to it or in place of it.
	 *
	 * It reads the rows the list shows, the ones All would take, so a search or the Show filter
	 * narrows what it can pick and nothing off screen is ever picked.
	 */
	import Button from '$lib/components/ui/Button.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import { LOREBOOK_ENTRY_NATURE_OPTIONS } from '$lib/stores/lorebookEntryPrefs.svelte';
	import {
		LOREBOOK_ENTRY_TIPS,
		LOREBOOK_LOGICS,
		LOREBOOK_PLACEMENTS,
		LOREBOOK_POSITION_AT_DEPTH,
		LOREBOOK_POSITION_BLOCK,
		LOREBOOK_SCAN_FIELDS,
		LOREBOOK_TIMED_FIELDS,
		LOREBOOK_TRIGGERS,
		ST_POSITION_NAMES,
		WOKEN_BY_LABELS,
		resolveBookActivation,
		type LorebookEntry,
		type LorebookWokenBy
	} from '$lib/lorebook/types';
	import { LOREBOOK_KNOBS, LOREBOOK_KNOB_NAMES, type LorebookBulkKnob } from '$lib/lorebook/bulk';
	import {
		NONE,
		facetsOf,
		isPicking,
		orderSpan,
		pickedEntries,
		type LorebookFacet,
		type LorebookFacetCounts,
		type LorebookPicks
	} from '$lib/lorebook/select';

	interface Props {
		bookId: string;
		/** The rows the list shows. */
		entries: LorebookEntry[];
		/** A search or the Show filter is holding rows out of the list. */
		narrowed: boolean;
		selectedIds: ReadonlySet<string>;
		/** Hand the picked entries to the selection, on top of it or in place of it. */
		onPick: (ids: string[], replace: boolean) => void;
	}

	let { bookId, entries, narrowed, selectedIds, onPick }: Props = $props();

	let book = $derived(lorebookStore.getBook(bookId));
	let globals = $derived(lorebookSettingsStore.settings);
	let defaults = $derived.by(() => {
		const resolved = book ? resolveBookActivation(book, globals) : null;
		return {
			caseSensitive: resolved?.caseSensitive ?? globals.caseSensitive,
			matchWholeWords: resolved?.matchWholeWords ?? globals.matchWholeWords,
			scanDepth: resolved?.scanDepth ?? globals.scanDepth
		};
	});

	const TIPS: Partial<Record<LorebookBulkKnob, string>> = LOREBOOK_ENTRY_TIPS;

	/** Edit…'s own rule: the knobs from Scan depth on sit under Advanced. */
	const ADVANCED_FROM = LOREBOOK_KNOBS.indexOf('scanDepth');

	let facets = $derived(new Map(facetsOf(entries, defaults).map((f) => [f.facet, f])));
	let span = $derived(orderSpan(entries));
	let drawn = $derived(
		LOREBOOK_KNOBS.filter((knob) =>
			knob === 'order' ? !!span && span.min < span.max : facets.has(knob)
		)
	);
	let firstAdvanced = $derived(
		drawn.find((knob) => LOREBOOK_KNOBS.indexOf(knob) >= ADVANCED_FROM)
	);

	// ===== what is picked =====

	let answers = $state<Partial<Record<LorebookFacet, string[]>>>({});
	let orderFrom = $state('');
	let orderTo = $state('');

	function bound(raw: string): number | undefined {
		return /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : undefined;
	}

	let picks = $derived<LorebookPicks>({
		answers,
		order: { from: bound(orderFrom), to: bound(orderTo) }
	});
	let picking = $derived(isPicking(picks));
	let matched = $derived(picking ? pickedEntries(entries, picks, defaults) : []);
	let unselected = $derived(matched.filter((e) => !selectedIds.has(e.id)).length);

	function toggle(facet: LorebookFacet, answer: string) {
		const now = answers[facet] ?? [];
		answers = {
			...answers,
			[facet]: now.includes(answer) ? now.filter((a) => a !== answer) : [...now, answer]
		};
	}

	function picked(knob: LorebookBulkKnob): boolean {
		if (knob === 'order') return picks.order.from !== undefined || picks.order.to !== undefined;
		return (answers[knob] ?? []).length > 0;
	}

	let line = $derived.by(() => {
		if (!picking) return '';
		const of = narrowed ? `the ${entries.length} shown` : String(entries.length);
		if (matched.length === 0) return `None of ${of} match`;
		const already = matched.length - unselected;
		return `${matched.length} of ${of} match${already > 0 ? `, ${already} already selected` : ''}`;
	});

	function hand(replace: boolean) {
		onPick(matched.map((e) => e.id), replace);
	}

	// ===== how an answer reads =====

	/** An answer worded as its knob's own control words it; `none` is what the answer of an
	 *  entry setting none of the knob reads as. */
	function named<T>(
		table: readonly T[],
		id: (row: T) => string,
		label: (row: T) => string,
		none?: string
	): (answer: string) => string {
		return (answer) => {
			if (answer === NONE && none) return none;
			const row = table.find((r) => id(r) === answer);
			return row ? label(row) : answer;
		};
	}

	const onOff = (answer: string) => (answer === 'on' ? 'On' : 'Off');
	const byNumber = (a: string, b: string) => Number(a) - Number(b);
	/** Ours first, the two places this app has, then SillyTavern's by number. */
	const placeRank = (answer: string) =>
		answer === String(LOREBOOK_POSITION_BLOCK)
			? -2
			: answer === String(LOREBOOK_POSITION_AT_DEPTH)
				? -1
				: Number(answer);

	/** Each facet's answers in the order its own control offers them, and their words. */
	const WORDING: Record<
		LorebookFacet,
		{
			order: readonly string[] | ((a: string, b: string) => number);
			label: (answer: string) => string;
		}
	> = {
		nature: {
			order: LOREBOOK_ENTRY_NATURE_OPTIONS.map((o) => o.id),
			label: named(LOREBOOK_ENTRY_NATURE_OPTIONS, (o) => o.id, (o) => o.label)
		},
		filter: {
			order: [NONE, ...LOREBOOK_LOGICS.map((l) => String(l.id))],
			label: named(LOREBOOK_LOGICS, (l) => String(l.id), (l) => l.glyph, 'No filter')
		},
		probability: { order: byNumber, label: (answer) => `${answer}%` },
		caseSensitive: { order: ['on', 'off'], label: onOff },
		matchWholeWords: { order: ['on', 'off'], label: onOff },
		scanDepth: { order: byNumber, label: (answer) => answer },
		scanFields: {
			order: [NONE, ...LOREBOOK_SCAN_FIELDS.map((f) => f.id)],
			label: named(LOREBOOK_SCAN_FIELDS, (f) => f.id, (f) => f.label, 'The chat alone')
		},
		wokenBy: {
			order: Object.keys(WOKEN_BY_LABELS),
			label: (answer) => WOKEN_BY_LABELS[answer as LorebookWokenBy] ?? answer
		},
		wakesOthers: { order: ['on', 'off'], label: onOff },
		triggers: {
			order: [NONE, ...LOREBOOK_TRIGGERS.map((t) => t.id)],
			label: named(LOREBOOK_TRIGGERS, (t) => t.id, (t) => t.label, 'All kinds')
		},
		timing: {
			order: [NONE, ...LOREBOOK_TIMED_FIELDS.map((t) => t.field)],
			label: named(LOREBOOK_TIMED_FIELDS, (t) => t.field, (t) => t.label, 'None')
		},
		group: {
			// No group first, then the labels in the order a reader scans them.
			order: (a, b) => (a === NONE ? -1 : b === NONE ? 1 : a.localeCompare(b)),
			label: (answer) => (answer === NONE ? 'No group' : answer)
		},
		placement: {
			order: (a, b) => placeRank(a) - placeRank(b),
			label: (answer) =>
				LOREBOOK_PLACEMENTS.find((p) => String(p.id) === answer)?.label ??
				ST_POSITION_NAMES[Number(answer)] ??
				`Position ${answer}`
		}
	};

	/** A value no control offers (an import's stray number) still gets its pill, last. */
	function ordered({ facet, counts }: LorebookFacetCounts): string[] {
		const held = [...counts.keys()];
		const order = WORDING[facet].order;
		if (typeof order === 'function') return held.sort(order);
		return [
			...order.filter((answer) => counts.has(answer)),
			...held.filter((answer) => !order.includes(answer))
		];
	}
</script>

{#snippet head(knob: LorebookBulkKnob)}
	<div class="sb-head">
		<span class="section-label sb-name" class:is-picked={picked(knob)}>
			{LOREBOOK_KNOB_NAMES[knob]}
		</span>
		{#if TIPS[knob]}<InfoTip text={TIPS[knob]} />{/if}
	</div>
{/snippet}

<div class="sb">
	<div class="sb-body panel-scroll">
		{#each drawn as knob (knob)}
			{#if knob === firstAdvanced}
				<div class="sb-part">
					<span class="section-label">Advanced</span>
					<span class="sb-rule"></span>
				</div>
			{/if}
			{#if knob === 'order' && span}
				<div>
					{@render head('order')}
					<div class="sb-span">
						<label class="sb-sub">
							<span class="sb-sub-name">From</span>
							<input
								type="text"
								inputmode="numeric"
								class="input-base w-20 px-2 py-1.5 text-center font-mono text-sm text-text-primary"
								bind:value={orderFrom}
								placeholder={String(span.min)}
								aria-label="Lowest order"
							/>
						</label>
						<label class="sb-sub">
							<span class="sb-sub-name">To</span>
							<input
								type="text"
								inputmode="numeric"
								class="input-base w-20 px-2 py-1.5 text-center font-mono text-sm text-text-primary"
								bind:value={orderTo}
								placeholder={String(span.max)}
								aria-label="Highest order"
							/>
						</label>
					</div>
				</div>
			{:else if knob !== 'order'}
				{@const facet = facets.get(knob)}
				{#if facet}
					<div>
						{@render head(knob)}
						<div class="sb-pills">
							{#each ordered(facet) as answer (answer)}
								{@const on = (answers[facet.facet] ?? []).includes(answer)}
								<button
									type="button"
									class="sb-pill"
									class:is-on={on}
									aria-pressed={on}
									onclick={() => toggle(facet.facet, answer)}
								>
									<span class="sb-label">{WORDING[facet.facet].label(answer)}</span>{' '}<span
										class="sb-count">{facet.counts.get(answer)}</span
									>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		{:else}
			<p class="sb-none">
				{narrowed ? 'Every entry shown' : 'Every entry here'} holds the same settings, so there is nothing
				to tell them apart by.
			</p>
		{/each}
	</div>

	<footer class="sb-foot">
		<p class="sb-sum" class:is-empty={!line} aria-live="polite">{line}</p>
		<div class="sb-acts">
			{#if selectedIds.size === 0}
				<Button variant="primary" disabled={matched.length === 0} onclick={() => hand(true)}>
					Select these
				</Button>
			{:else}
				<Button variant="secondary" disabled={matched.length === 0} onclick={() => hand(true)}>
					Replace selection
				</Button>
				<Button variant="primary" disabled={unselected === 0} onclick={() => hand(false)}>
					Add to selection
				</Button>
			{/if}
		</div>
	</footer>
</div>

<style>
	/* Edit…'s frame: head and foot stand still, the middle scrolls, so the two buttons stay in
	   reach from the last knob on a phone. */
	.sb {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.sb-body {
		flex: 1;
		min-height: 0;
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		padding: 1rem 1.25rem 1.25rem;
	}

	.sb-foot {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		padding: 0.75rem 1.25rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	/* Its own line on a phone rather than squeezing the buttons, and no line while nothing is
	   picked. */
	.sb-sum {
		flex: 1 1 10rem;
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.sb-sum.is-empty {
		flex-basis: 0;
	}

	.sb-acts {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-left: auto;
	}

	/* A knob's name and its tip, Edit…'s own head: the name lights while something in it is
	   picked, so a pick scrolled past still shows. */
	.sb-head {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 1.5rem;
		margin-bottom: 0.4rem;
	}

	.sb-name {
		transition: color 130ms ease;
	}

	.sb-name.is-picked {
		color: var(--color-accent);
	}

	.sb-name.is-picked::before {
		content: '';
		display: inline-block;
		width: 0.35rem;
		height: 0.35rem;
		margin-right: 0.35rem;
		border-radius: var(--radius-full);
		background: var(--color-accent);
		vertical-align: 0.1em;
	}

	.sb-pills {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	/* Edit…'s membership pill, carrying how many entries give the answer. */
	.sb-pill {
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
		max-width: 100%;
		padding: 0.28rem 0.65rem;
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 550;
		cursor: pointer;
		transition: color 90ms ease, border-color 90ms ease, background 90ms ease;
	}

	.sb-pill:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-border) 90%, transparent);
	}

	.sb-pill.is-on {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
	}

	/* A group label is the reader's own text, and may be a sentence. */
	.sb-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sb-count {
		flex-shrink: 0;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-muted);
	}

	.sb-pill.is-on .sb-count {
		color: color-mix(in srgb, var(--color-accent) 70%, var(--color-text-muted));
	}

	.sb-span {
		display: flex;
		align-items: flex-end;
		gap: 0.75rem;
	}

	.sb-sub {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.sb-sub-name {
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--color-text-muted);
	}

	.sb-part {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.sb-rule {
		flex: 1;
		height: 1px;
		background: var(--color-border-subtle);
	}

	.sb-none {
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	@media (max-width: 480px) {
		.sb-body {
			padding: 0.85rem 0.9rem 1rem;
		}

		.sb-foot {
			padding: 0.65rem 0.9rem;
		}
	}
</style>
