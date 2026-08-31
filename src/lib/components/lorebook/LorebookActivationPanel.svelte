<script lang="ts">
	/**
	 * The activation cascade, one panel for both of its layers.
	 *
	 * The rows are written once and the caller decides which layer they write to: hand it a book
	 * and they edit that book's overrides, hand it none and they edit the defaults every book
	 * falls back to. Two panels carrying the same six settings under two headings is how a
	 * change meant for one book lands on all of them.
	 *
	 * In book scope every row shows the value the scan will actually use and says where it came
	 * from, so the panel and the engine can't tell different stories (both resolve through
	 * `resolveBookActivation`).
	 */
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import OverrideMark from '$lib/components/ui/OverrideMark.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import {
		resolveBookActivation,
		type Lorebook,
		type LorebookGlobalSettings
	} from '$lib/lorebook/types';
	import { toggleRow } from '$lib/actions/toggleRow';

	interface Props {
		/** The open book, whose own overrides these rows edit. Omitted on the shelf's defaults
		 *  page, where the same rows edit the layer every book falls back to. */
		book?: Lorebook;
	}

	let { book }: Props = $props();

	/** Which layer of the cascade the rows below write to. */
	let scope = $derived<'book' | 'global'>(book ? 'book' : 'global');

	let globals = $derived(lorebookSettingsStore.settings);
	/** What this book runs with: its own overrides over the globals. In global scope the
	 *  defaults ARE the resolved values, which is what leaves every row unmarked there. */
	let resolved = $derived(book ? resolveBookActivation(book, globals) : globals);

	// Each row reads the value of the layer on screen and writes to that same layer.
	let scanValue = $derived(scope === 'book' ? resolved.scanDepth : globals.scanDepth);
	let stepsValue = $derived(scope === 'book' ? resolved.maxRecursionSteps : globals.maxRecursionSteps);
	let recursion = $derived(scope === 'book' ? resolved.recursiveScanning : globals.recursiveScanning);
	/** A book's own pass cap has nothing to cap while one shared loop crosses every book. */
	let stepsInert = $derived(scope === 'book' && globals.crossBookRecursion);
	let caseValue = $derived(scope === 'book' ? resolved.caseSensitive : globals.caseSensitive);
	let wholeValue = $derived(scope === 'book' ? resolved.matchWholeWords : globals.matchWholeWords);

	function setBook(patch: Parameters<typeof lorebookStore.updateBookMeta>[1]) {
		if (!book) throw new Error('LorebookActivationPanel: book-scope write with no book');
		lorebookStore.updateBookMeta(book.id, patch);
	}

	function setGlobal(patch: Partial<LorebookGlobalSettings>) {
		void lorebookSettingsStore.update(patch);
	}

	// Tolerant number editing: a draft the user can half-type without the field snapping to a
	// forced 0. Digits commit as they land, the effect re-syncs whenever the shown layer or its
	// value changes, and blur throws away anything that never parsed.
	let scanDraft = $state('');
	$effect(() => {
		scanDraft = String(scanValue);
	});

	let stepsDraft = $state('');
	$effect(() => {
		stepsDraft = String(stepsValue);
	});

	let budgetDraft = $state('');
	$effect(() => {
		budgetDraft = String(globals.budgetPercent);
	});

	function commitNumber(raw: string, apply: (n: number) => void) {
		const trimmed = raw.trim();
		if (/^\d+$/.test(trimmed)) apply(parseInt(trimmed, 10));
	}
</script>

<!-- A row is marked when this book's value differs from the one it would inherit, so typing
     the default back in clears the mark. Global scope carries none: it is the root. -->
{#snippet mark(differs: boolean, revert: () => void)}
	{#if scope === 'book'}
		<OverrideMark overridden={differs} onRevert={revert} />
	{/if}
{/snippet}

<!-- Strip content: the page scrolls as one, so this panel brings no scroll of its own. -->
<div class="px-4 py-4 space-y-5">
	<!-- Which layer is being edited, said once and in a sentence: the surface a reader is
	     standing on is the only thing that decides it. -->
	<p class="act-note">
		{scope === 'book'
			? 'This book only. What it does not set follows the defaults.'
			: 'What every book follows where it sets nothing of its own.'}
	</p>

	<!-- Scanning -->
	<div>
		<span class="act-label section-label">Scanning</span>
		<div class="act-card">
			<div class="act-row">
				<label for="lb-scan-{scope}" class="act-row-text">
					<span class="act-row-name">Scan depth</span>
					<span class="act-row-help">
						How many recent messages are searched for keywords · 0 = the whole context
					</span>
				</label>
				{@render mark(resolved.scanDepth !== globals.scanDepth, () => setBook({ scanDepth: null }))}
				<input
					id="lb-scan-{scope}"
					type="text"
					inputmode="numeric"
					value={scanDraft}
					oninput={(e) => {
						scanDraft = (e.target as HTMLInputElement).value;
						commitNumber(scanDraft, (n) =>
							scope === 'book' ? setBook({ scanDepth: n }) : setGlobal({ scanDepth: n })
						);
					}}
					onblur={() => (scanDraft = String(scanValue))}
					class="input-base w-16 px-2 py-1.5 font-mono text-sm text-text-primary text-center flex-shrink-0"
				/>
			</div>
			<div class="act-row" use:toggleRow>
				<span class="act-row-text">
					<span class="act-row-name">Recursive scan</span>
					<span class="act-row-help">
						An activated entry can activate others by mentioning their keywords
					</span>
				</span>
				{@render mark(
					resolved.recursiveScanning !== globals.recursiveScanning,
					() => setBook({ recursiveScanning: null })
				)}
				<Toggle
					checked={recursion}
					label="Recursive scan"
					onchange={(next) =>
						scope === 'book'
							? setBook({ recursiveScanning: next })
							: setGlobal({ recursiveScanning: next })}
				/>
			</div>
			{#if recursion}
				<div class="act-row" class:is-inert={stepsInert}>
					<label for="lb-steps-{scope}" class="act-row-text">
						<span class="act-row-name">Max recursion passes</span>
						<span class="act-row-help">
							{stepsInert
								? 'Books recurse together, so the one shared loop is capped in the defaults'
								: 'How many times activated content is re-scanned · 0 = until nothing new fires'}
						</span>
					</label>
					{@render mark(
						resolved.maxRecursionSteps !== globals.maxRecursionSteps,
						() => setBook({ maxRecursionSteps: null })
					)}
					<input
						id="lb-steps-{scope}"
						type="text"
						inputmode="numeric"
						value={stepsDraft}
						disabled={stepsInert}
						oninput={(e) => {
							stepsDraft = (e.target as HTMLInputElement).value;
							commitNumber(stepsDraft, (n) =>
								scope === 'book'
									? setBook({ maxRecursionSteps: n })
									: setGlobal({ maxRecursionSteps: n })
							);
						}}
						onblur={() => (stepsDraft = String(stepsValue))}
						class="input-base w-16 px-2 py-1.5 font-mono text-sm text-text-primary text-center flex-shrink-0"
					/>
				</div>
			{/if}
			<!-- No book layer: two books cannot disagree about whether they read each other. -->
			{#if recursion && scope === 'global'}
				<div class="act-row" use:toggleRow>
					<span class="act-row-text">
						<span class="act-row-name">Books recurse together</span>
						<span class="act-row-help">
							An entry can wake entries in any other book in play, not only in its own
						</span>
					</span>
					<Toggle
						checked={globals.crossBookRecursion}
						label="Books recurse together"
						onchange={(next) => setGlobal({ crossBookRecursion: next })}
					/>
				</div>
			{/if}
		</div>
		{#if scope === 'book'}
			<p class="act-foot">
				Whether books recurse together is one property of the whole scan, so it is set in
				Global Settings, on the Lorebooks shelf.
			</p>
		{/if}
	</div>

	<!-- Keyword matching -->
	<div>
		<span class="act-label section-label">Keyword matching</span>
		<div class="act-card">
			<div class="act-row" use:toggleRow>
				<span class="act-row-text">
					<span class="act-row-name">Case-sensitive</span>
					<span class="act-row-help">Keys must match case as written</span>
				</span>
				{@render mark(
					resolved.caseSensitive !== globals.caseSensitive,
					() => setBook({ caseSensitive: null })
				)}
				<Toggle
					checked={caseValue}
					label="Case-sensitive"
					onchange={(next) =>
						scope === 'book' ? setBook({ caseSensitive: next }) : setGlobal({ caseSensitive: next })}
				/>
			</div>
			<div class="act-row" use:toggleRow>
				<span class="act-row-text">
					<span class="act-row-name">Match whole words</span>
					<span class="act-row-help">
						Single-word keys only match as whole words, so “art” won’t fire on “cartography”
					</span>
				</span>
				{@render mark(
					resolved.matchWholeWords !== globals.matchWholeWords,
					() => setBook({ matchWholeWords: null })
				)}
				<Toggle
					checked={wholeValue}
					label="Match whole words"
					onchange={(next) =>
						scope === 'book'
							? setBook({ matchWholeWords: next })
							: setGlobal({ matchWholeWords: next })}
				/>
			</div>
		</div>
		<p class="act-foot">An entry falls back to these two unless it sets its own.</p>
	</div>

	<!-- Budget: one share of the prompt for all lore at once, so it has no book layer. -->
	{#if scope === 'global'}
		<div>
			<span class="act-label section-label">Prompt budget</span>
			<div class="act-card">
				<div class="act-row">
					<label for="lb-budget" class="act-row-text">
						<span class="act-row-name">Lore budget</span>
						<span class="act-row-help">
							Largest share of the context lore may take, in % · 0 = no limit. When exceeded,
							the lowest-priority entries (highest order) are dropped first.
						</span>
					</label>
					<div class="flex items-center gap-1.5 flex-shrink-0">
						<input
							id="lb-budget"
							type="text"
							inputmode="numeric"
							value={budgetDraft}
							oninput={(e) => {
								budgetDraft = (e.target as HTMLInputElement).value;
								commitNumber(budgetDraft, (n) => setGlobal({ budgetPercent: Math.min(100, n) }));
							}}
							onblur={() => (budgetDraft = String(globals.budgetPercent))}
							class="input-base w-16 px-2 py-1.5 font-mono text-sm text-text-primary text-center"
						/>
						<span class="font-mono text-xs text-text-muted">%</span>
					</div>
				</div>
			</div>
		</div>
	{:else}
		<div>
			<span class="act-label section-label">Prompt budget</span>
			<p class="act-foot act-foot--flush">
				Lore budget is one share of the prompt for everything lore injects at once, so it is set
				in Global Settings, on the Lorebooks shelf.
			</p>
		</div>
	{/if}
</div>

<style>
	.act-note {
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	/* ===== setting rows ===== */

	/* Typography comes from the global .section-label; only the margin is local. */
	.act-label {
		margin-bottom: 0.4rem;
	}

	.act-card {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 0.75rem 0.85rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: var(--color-card-bg);
	}

	.act-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	/* A row whose value is real but has nothing to act on right now. Dimmed rather than hidden,
	   so the reader can still see what it will do again once it applies. */
	.act-row.is-inert {
		opacity: 0.5;
	}

	.act-row-text {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		flex: 1;
		min-width: 0;
		font-family: var(--font-ui);
	}

	.act-row-name {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.act-row-help {
		font-size: 0.7188rem;
		line-height: 1.4;
		color: var(--color-text-muted);
	}

	.act-foot {
		margin-top: 0.375rem;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	/* Standing in for a card rather than trailing one. */
	.act-foot--flush {
		margin-top: 0;
	}
</style>
