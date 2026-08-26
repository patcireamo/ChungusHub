<script lang="ts">
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import {
		DEFAULT_GROUP_WEIGHT,
		DEFAULT_LOREBOOK_DEPTH,
		firesOnTrigger,
		LOREBOOK_LOGICS,
		LOREBOOK_POSITION_AT_DEPTH,
		LOREBOOK_POSITION_BLOCK,
		LOREBOOK_ROLES,
		LOREBOOK_SCAN_FIELDS,
		LOREBOOK_TRIGGERS,
		delayValue,
		lorebookWokenBy,
		pruneKeyRules,
		resolveBookActivation,
		natureOf,
		resolveEntryRecursion,
		ST_POSITION_NAMES,
		TRIGGER_ALIASES,
		withoutStoredRecursion,
		type LorebookEntryNature,
		type LorebookKeyRules,
		type LorebookScanField,
		type LorebookTrigger,
		type LorebookWokenBy,
		type ResolvedRecursion
	} from '$lib/lorebook/types';
	import { autoResize } from '$lib/actions/autoResize';
	import { countTokens } from '$lib/tokenizer';
	import Icon from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import KeyChipInput from './KeyChipInput.svelte';
	import OverrideMark from '$lib/components/ui/OverrideMark.svelte';

	type Nature = LorebookEntryNature;

	interface Props {
		lorebookId: string;
		entryId: string;
		/** The row's full editor is unfolded in place. */
		expanded: boolean;
		onToggle: () => void;
		/** Ask the parent to confirm and remove this entry. */
		onDelete: () => void;
		/** Copy this entry (parent expands the copy). */
		onDuplicate: () => void;
		/** Bulk-selection mode: the row selects instead of expanding. */
		selectMode: boolean;
		selected: boolean;
		onSelectToggle: () => void;
	}

	let { lorebookId, entryId, expanded, onToggle, onDelete, onDuplicate, selectMode, selected, onSelectToggle }: Props =
		$props();

	let entry = $derived(lorebookStore.getBook(lorebookId)?.entries.find((e) => e.id === entryId) ?? null);

	let titleEl = $state<HTMLInputElement | null>(null);

	let nature = $derived<Nature>(entry ? natureOf(entry) : 'keyword');
	let contentTokens = $derived(entry ? countTokens(entry.content) : 0);
	/** What actually applies at generation: useProbability off means the roll is skipped. */
	let effectiveProbability = $derived(entry ? (entry.useProbability ? entry.probability : 100) : 100);

	// What this entry inherits when it sets nothing: the book's resolved match defaults, read
	// through the same resolver the scan uses, so the switch can't show a state the engine
	// won't apply. The `??` is only the guard for a row without a book.
	let book = $derived(lorebookStore.getBook(lorebookId));
	let globals = $derived(lorebookSettingsStore.settings);
	let bookDefaults = $derived(book ? resolveBookActivation(book, globals) : null);
	let caseDefault = $derived(bookDefaults?.caseSensitive ?? globals.caseSensitive);
	let wholeDefault = $derived(bookDefaults?.matchWholeWords ?? globals.matchWholeWords);
	let depthDefault = $derived(bookDefaults?.scanDepth ?? globals.scanDepth);
	/** What a chip falls back to: the entry's own two switches over the book's. */
	let keyDefaults = $derived({
		caseSensitive: entry?.caseSensitive ?? caseDefault,
		matchWholeWords: entry?.matchWholeWords ?? wholeDefault
	});

	const NATURE_HINTS: Record<Nature, string> = {
		always: 'Injected every turn, ignoring keywords.',
		keyword: 'Fires when its keywords appear in recent messages.',
		off: 'Dormant: never scanned, never injected.'
	};

	const logicGlyph: Record<number, string> = {
		0: '＋ any of',
		3: '＋ all of',
		2: '－ none of',
		1: '－ not all of'
	};

	function update(patch: Parameters<typeof lorebookStore.updateEntry>[2]) {
		lorebookStore.updateEntry(lorebookId, entryId, patch);
	}

	/** Rewrite one key list, dropping the per-key rules the removed chips leave behind. */
	function setKeys(field: 'key' | 'keysecondary', next: string[]) {
		if (!entry) return;
		const other = field === 'key' ? entry.keysecondary : entry.key;
		update({ [field]: next, keyRules: pruneKeyRules(entry.keyRules, [...next, ...other]) });
	}

	function setKeyRules(next: LorebookKeyRules) {
		update({ keyRules: Object.keys(next).length > 0 ? next : undefined });
	}

	/** Membership toggles: an empty list is the open state (every field off, every kind on). */
	function toggleScanField(field: LorebookScanField) {
		const current = entry?.scanFields ?? [];
		const next = current.includes(field) ? current.filter((f) => f !== field) : [...current, field];
		update({ scanFields: next });
	}

	/** Whether a kind's pill is on. Reads the aliases too, so an imported `regenerate` token
	 *  lights the Regenerate pill exactly as it fires the engine. */
	function triggerOn(id: LorebookTrigger): boolean {
		return !!entry?.triggers?.some((t) => TRIGGER_ALIASES[id].includes(t));
	}

	function toggleTrigger(id: LorebookTrigger) {
		const current = entry?.triggers ?? [];
		const next = triggerOn(id)
			? current.filter((t) => !TRIGGER_ALIASES[id].includes(t))
			: [...current, id];
		update({ triggers: next });
	}

	// ===== recursion: what may wake this entry, and what it wakes =====

	let recursion = $derived(entry ? resolveEntryRecursion(entry) : null);
	let wokenBy = $derived<LorebookWokenBy>(recursion ? lorebookWokenBy(recursion) : 'both');

	/** What each reading is called. An always-active entry has no keys to place, so its own
	 *  wording for the default says what being always active already means. */
	const WOKEN_BY_LABELS: Record<LorebookWokenBy, string> = {
		both: 'The chat and other entries',
		chatOnly: 'The chat only',
		entriesOnly: 'Other entries only',
		never: 'Never (SillyTavern)'
	};

	let wokenByOptions = $derived.by(() => {
		const offered: LorebookWokenBy[] = entry?.constant
			? ['both', 'entriesOnly']
			: ['both', 'chatOnly', 'entriesOnly'];
		// A reading this entry's nature has no option for arrived with an import. Naming it beats
		// showing an empty control, the same way a foreign placement is named rather than hidden.
		if (!offered.includes(wokenBy)) offered.push(wokenBy);
		return offered.map((id) => ({
			id,
			label: id === 'both' && entry?.constant ? 'Nothing, it is always in' : WOKEN_BY_LABELS[id]
		}));
	});

	/**
	 * Writing one of the three settles all three onto the entry and clears the copies an import
	 * left in `rest`. Clearing them without writing all three would drop a setting the reader
	 * never touched, since `rest` is where an older row still keeps it.
	 */
	function setRecursion(patch: Partial<ResolvedRecursion>) {
		if (!entry || !recursion) return;
		const next = { ...recursion, ...patch };
		update({
			excludeRecursion: next.excludeRecursion,
			preventRecursion: next.preventRecursion,
			delayUntilRecursion: delayValue(next.delayLevel),
			rest: withoutStoredRecursion(entry.rest)
		});
	}

	// The wave an entry waits for. Only ever shown while it waits for one, so the field's own
	// floor is the first level rather than "off"; not waiting is a choice made on the Select.
	let levelDraft = $state('');
	$effect(() => {
		levelDraft = String(Math.max(1, recursion?.delayLevel ?? 1));
	});
	function commitLevel(raw: string) {
		levelDraft = raw;
		if (/^\d+$/.test(raw.trim())) setRecursion({ delayLevel: Math.max(1, parseInt(raw, 10)) });
	}

	function setWokenBy(choice: LorebookWokenBy) {
		// `never` is only ever read off an import; picking it back is not a state to write.
		if (choice === 'never') return;
		setRecursion({
			excludeRecursion: choice === 'chatOnly',
			// An imported level is kept, so choosing this again does not flatten it to the first.
			delayLevel: choice === 'entriesOnly' ? Math.max(1, recursion?.delayLevel ?? 1) : 0
		});
	}

	function setNature(next: Nature) {
		if (next === 'off') update({ disable: true });
		else update({ disable: false, constant: next === 'always' });
	}

	/** The leading dot flips the entry on/off without opening it. */
	function toggleDisable() {
		if (entry) update({ disable: !entry.disable });
	}

	// Tolerant numeric editing: drafts the user can empty out without the field snapping to a
	// forced value mid-keystroke. Shared by the collapsed row's quick fields and the unfolded
	// form (they can't drift: both read the same draft, both write the same entry).
	let orderDraft = $state('');
	$effect(() => {
		orderDraft = entry ? String(entry.order) : '';
	});
	function commitOrder(raw: string) {
		orderDraft = raw;
		if (/^\d+$/.test(raw.trim())) update({ order: parseInt(raw, 10) });
	}
	function nudgeOrder(delta: number) {
		if (entry) update({ order: Math.max(0, entry.order + delta) });
	}

	let probabilityDraft = $state('');
	$effect(() => {
		probabilityDraft = String(effectiveProbability);
	});

	// Scan depth reads the book's value while the entry sets none, so the field always shows the
	// window the scan will actually use; the star beside it is what says whose value it is.
	let effectiveDepth = $derived(entry?.scanDepth ?? depthDefault);
	let depthDraft = $state('');
	$effect(() => {
		depthDraft = String(effectiveDepth);
	});
	function commitDepth(raw: string) {
		depthDraft = raw;
		if (/^\d+$/.test(raw.trim())) update({ scanDepth: parseInt(raw, 10) });
	}

	// The three timed fields say nothing when empty, which is also how they are stored, so an
	// emptied box is a real edit rather than a draft waiting to parse.
	type TimedField = 'sticky' | 'cooldown' | 'delay';
	const TIMED: { field: TimedField; label: string }[] = [
		{ field: 'sticky', label: 'Sticky' },
		{ field: 'cooldown', label: 'Cooldown' },
		{ field: 'delay', label: 'Delay' }
	];
	function timedValue(field: TimedField): string {
		const v = entry?.[field];
		return v == null || v === 0 ? '' : String(v);
	}
	function commitTimed(field: TimedField, raw: string) {
		const trimmed = raw.trim();
		if (trimmed === '') update({ [field]: null });
		else if (/^\d+$/.test(trimmed)) update({ [field]: parseInt(trimmed, 10) });
	}

	let weightDraft = $state('');
	$effect(() => {
		weightDraft = String(entry?.groupWeight ?? DEFAULT_GROUP_WEIGHT);
	});

	let placeDepthDraft = $state('');
	$effect(() => {
		placeDepthDraft = String(entry?.depth ?? DEFAULT_LOREBOOK_DEPTH);
	});
	function commitPlaceDepth(raw: string) {
		placeDepthDraft = raw;
		if (/^\d+$/.test(raw.trim())) update({ depth: parseInt(raw, 10) });
	}
	function commitProbability(raw: string) {
		probabilityDraft = raw;
		if (/^\d+$/.test(raw.trim())) {
			const n = Math.min(100, Math.max(0, parseInt(raw, 10)));
			update({ probability: n, useProbability: true });
		}
	}

	// Advanced folds away, but a folded knob that is doing something must still say so, or an
	// entry silently limited to one field reads as broken.
	let showAdvanced = $state(false);
	let atDepth = $derived((entry?.position ?? LOREBOOK_POSITION_BLOCK) === LOREBOOK_POSITION_AT_DEPTH);
	/** A SillyTavern position this app has no place for: named rather than quietly read as ours. */
	let foreignPosition = $derived(
		entry?.position == null ? '' : (ST_POSITION_NAMES[entry.position] ?? '')
	);

	// One part per knob that is set, in the order the fold's blocks appear in.
	let advancedSummary = $derived.by(() => {
		if (!entry) return '';
		const parts: string[] = [];
		if (entry.scanDepth != null && entry.scanDepth !== depthDefault) {
			parts.push(entry.scanDepth === 0 ? 'scans the whole chat' : `scans ${entry.scanDepth} back`);
		}
		if (entry.scanFields?.length) parts.push(`${entry.scanFields.length} extra source${entry.scanFields.length === 1 ? '' : 's'}`);
		if (wokenBy === 'chatOnly') parts.push('woken by the chat only');
		else if (wokenBy === 'entriesOnly') {
			const level = recursion?.delayLevel ?? 1;
			parts.push(level > 1 ? `woken by other entries, level ${level}` : 'woken by other entries');
		}
		else if (wokenBy === 'never') parts.push('never fires');
		if (recursion?.preventRecursion) parts.push('wakes nobody');
		if (entry.triggers?.length) {
			// Counted through the engine's own reader, so an imported alias token counts once and
			// an unknown one (a kind this app never generates) honestly counts as nothing.
			const kinds = LOREBOOK_TRIGGERS.filter((t) => firesOnTrigger(entry!.triggers, t.id)).length;
			if (kinds < LOREBOOK_TRIGGERS.length) parts.push(`fires on ${kinds} of ${LOREBOOK_TRIGGERS.length}`);
		}
		for (const { field, label } of TIMED) {
			const v = entry[field];
			if (v) parts.push(`${label.toLowerCase()} ${v}`);
		}
		if (entry.group?.trim()) parts.push(`group ${entry.group.trim()}`);
		if (atDepth) {
			const d = entry.depth ?? DEFAULT_LOREBOOK_DEPTH;
			parts.push(d === 0 ? 'in the chat after the last turn' : `in the chat, ${d} back`);
		} else if (foreignPosition) {
			parts.push('SillyTavern placement');
		}
		return parts.join(' · ');
	});

	// Focus the title once, and only for a freshly created blank entry. Never steal focus
	// (or pop a mobile keyboard) when merely unfolding existing entries.
	let didAutoFocus = false;
	$effect(() => {
		if (!expanded || didAutoFocus || !entry) return;
		if (!entry.comment && !entry.content && entry.key.length === 0) {
			didAutoFocus = true;
			titleEl?.focus({ preventScroll: true });
		}
	});
</script>

{#if entry}
	<div class="lbr" class:is-open={expanded} class:is-off={entry.disable} id="lb-row-{entry.id}">
		<!-- Compact head: always visible, collapses/expands the editor beneath it -->
		<div class="lbr-head">
			{#if selectMode}
				<button
					type="button"
					class="lbr-glyph"
					onclick={onSelectToggle}
					aria-pressed={selected}
					aria-label={selected ? 'Deselect entry' : 'Select entry'}
				>
					<span class="lbr-check" class:is-checked={selected}>
						{#if selected}
							<Icon name="check" class="w-3 h-3" strokeWidth={3} />
						{/if}
					</span>
				</button>
			{:else}
				<button
					type="button"
					class="lbr-glyph"
					role="switch"
					aria-checked={!entry.disable}
					aria-label={entry.disable ? 'Enable entry' : 'Disable entry'}
					title={entry.disable
						? 'Off, click to enable'
						: entry.constant
							? 'Always active, click to disable'
							: 'Keyword-triggered, click to disable'}
					onclick={toggleDisable}
				>
					<span class="lbr-dot lbr-dot-{nature}"></span>
				</button>
			{/if}

			<button
				type="button"
				class="lbr-main"
				onclick={() => (selectMode ? onSelectToggle() : onToggle())}
				aria-expanded={expanded}
			>
				<span class="lbr-title" class:is-untitled={!entry.comment}>
					{entry.comment || 'Untitled entry'}
				</span>
				{#if entry.constant}
					<span class="lbr-sub lbr-sub-always">Always active</span>
				{:else if entry.key.length > 0}
					<span class="lbr-sub">{entry.key.join(' · ')}</span>
				{:else}
					<span class="lbr-sub lbr-sub-warn">
						<Icon name="warning" class="w-3 h-3" />No keywords, never fires
					</span>
				{/if}
			</button>

			{#if !selectMode && !expanded}
				{#if entry.content && !entry.disable}
					<span
						class="lbr-weight"
						title="≈ prompt tokens when this entry fires"
					>~{contentTokens}</span>
				{/if}
				<!-- Quick fields: edit priority and trigger chance without unfolding the row. -->
				<label class="lbr-mini" title="Order, lower is injected first">
					<span class="lbr-mini-key">ord</span>
					<input
						type="text"
						inputmode="numeric"
						value={orderDraft}
						oninput={(e) => commitOrder((e.target as HTMLInputElement).value)}
						onblur={() => (orderDraft = entry ? String(entry.order) : '')}
						aria-label="Order"
					/>
				</label>
				<label class="lbr-mini" title="Trigger chance, 100 = always">
					<input
						type="text"
						inputmode="numeric"
						value={probabilityDraft}
						oninput={(e) => commitProbability((e.target as HTMLInputElement).value)}
						onblur={() => (probabilityDraft = String(effectiveProbability))}
						aria-label="Trigger percent"
					/>
					<span class="lbr-mini-key">%</span>
				</label>
			{/if}

			{#if !selectMode}
				<button
					type="button"
					class="lbr-chev"
					class:is-open={expanded}
					onclick={onToggle}
					aria-label={expanded ? 'Collapse entry' : 'Expand entry'}
				>
					<Icon name="chevronDown" class="w-4 h-4" />
				</button>
			{/if}
		</div>

		<!-- Unfolded editor -->
		{#if expanded}
			<div class="lbr-body">
				<!-- Title + behavior -->
				<div>
					<input
						bind:this={titleEl}
						type="text"
						value={entry.comment}
						oninput={(e) => update({ comment: (e.target as HTMLInputElement).value })}
						placeholder="Untitled entry"
						aria-label="Entry title"
						class="ed-title"
					/>
					<div class="mt-2.5 flex items-center gap-3 flex-wrap">
						<div class="ed-seg" role="radiogroup" aria-label="Entry behavior">
							<button
								type="button"
								class="ed-seg-btn"
								class:is-active={nature === 'always'}
								role="radio"
								aria-checked={nature === 'always'}
								onclick={() => setNature('always')}
							>
								<Icon name="pin" class="w-3.5 h-3.5" />Always
							</button>
							<button
								type="button"
								class="ed-seg-btn"
								class:is-active={nature === 'keyword'}
								role="radio"
								aria-checked={nature === 'keyword'}
								onclick={() => setNature('keyword')}
							>
								Keyword
							</button>
							<button
								type="button"
								class="ed-seg-btn"
								class:is-active={nature === 'off'}
								role="radio"
								aria-checked={nature === 'off'}
								onclick={() => setNature('off')}
							>
								Off
							</button>
						</div>
						<p class="text-xs font-ui text-text-muted">{NATURE_HINTS[nature]}</p>
					</div>
				</div>

				{#if !entry.constant}
					<!-- Triggers -->
					<div>
						<span class="ed-label section-label">Keywords</span>
						<KeyChipInput
							keys={entry.key}
							onChange={(next) => setKeys('key', next)}
							rules={entry.keyRules}
							onRulesChange={setKeyRules}
							defaults={keyDefaults}
							placeholder="dragon, wyrm, fire beast…"
							ariaLabel="Primary keywords"
						/>
						{#if entry.key.length === 0 && !entry.disable}
							<p class="mt-1.5 text-xs text-warning inline-flex items-center gap-1 font-ui">
								<Icon name="warning" class="w-3.5 h-3.5" />No keywords, so this entry never fires.
							</p>
						{:else}
							<p class="mt-1.5 text-xs font-ui text-text-muted">
								Click a keyword to change how it matches. <code class="ed-macro">/pattern/i</code> is a
								regular expression.
							</p>
						{/if}
					</div>

					<div>
						<div class="flex items-center justify-between gap-2 mb-1.5">
							<span class="ed-label section-label !mb-0">Filter</span>
							<Select
								value={String(entry.selectiveLogic)}
								onchange={(e) =>
									update({ selectiveLogic: parseInt((e.target as HTMLSelectElement).value, 10) })}
								disabled={entry.keysecondary.length === 0}
								variant="compact"
								class="!w-auto"
								aria-label="Secondary key logic"
							>
								{#each LOREBOOK_LOGICS as l (l.id)}
									<option value={String(l.id)}>{logicGlyph[l.id]}</option>
								{/each}
							</Select>
						</div>
						<KeyChipInput
							keys={entry.keysecondary}
							onChange={(next) => setKeys('keysecondary', next)}
							rules={entry.keyRules}
							onRulesChange={setKeyRules}
							defaults={keyDefaults}
							placeholder="optional, leave empty to ignore"
							ariaLabel="Secondary keywords"
						/>
						{#if entry.keysecondary.length > 0}
							<p class="mt-1.5 text-xs font-ui text-text-muted">
								{LOREBOOK_LOGICS.find((l) => l.id === entry!.selectiveLogic)?.hint}
							</p>
						{/if}
					</div>
				{/if}

				<!-- Content -->
				<div>
					<div class="flex items-baseline justify-between gap-2 mb-1.5">
						<label for="entry-content-{entryId}" class="ed-label section-label !mb-0">Content</label>
						<span class="font-mono text-[0.65rem] text-text-muted tabular-nums">~{contentTokens} tokens</span>
					</div>
					<textarea
						id="entry-content-{entryId}"
						use:autoResize={{ maxHeight: 560, value: entry.content }}
						value={entry.content}
						oninput={(e) => update({ content: (e.target as HTMLTextAreaElement).value })}
						placeholder="The text woven into context when this entry fires…"
						class="input-base w-full px-3.5 py-2.5 font-body text-[0.95rem] leading-relaxed text-text-primary placeholder:text-text-muted placeholder:italic resize-none min-h-[9rem]"
					></textarea>
					<p class="mt-1.5 text-xs font-ui text-text-muted">
						Macros like <code class="ed-macro">{'{{char}}'}</code> and
						<code class="ed-macro">{'{{user}}'}</code> are expanded here.
					</p>
				</div>

				<!-- Fine print -->
				<div class="grid grid-cols-2 gap-x-5 gap-y-4 max-w-[26rem]">
					<div>
						<label for="entry-order-{entryId}" class="ed-label section-label">Order</label>
						<div class="flex items-stretch gap-1.5">
							<input
								id="entry-order-{entryId}"
								type="text"
								inputmode="numeric"
								value={orderDraft}
								oninput={(e) => commitOrder((e.target as HTMLInputElement).value)}
								onblur={() => (orderDraft = entry ? String(entry.order) : '')}
								class="input-base w-full px-3 py-2 font-mono text-sm text-text-primary"
							/>
							<div class="flex flex-col gap-0.5">
								<button type="button" class="ed-step" onclick={() => nudgeOrder(-1)} aria-label="Decrease order">
									<Icon name="chevronUp" class="w-3.5 h-3.5" />
								</button>
								<button type="button" class="ed-step" onclick={() => nudgeOrder(1)} aria-label="Increase order">
									<Icon name="chevronDown" class="w-3.5 h-3.5" />
								</button>
							</div>
						</div>
						<p class="mt-1 text-xs font-ui text-text-muted">Lower is injected first.</p>
					</div>
					<div>
						<label for="entry-prob-{entryId}" class="ed-label section-label">Trigger %</label>
						<input
							id="entry-prob-{entryId}"
							type="text"
							inputmode="numeric"
							value={probabilityDraft}
							oninput={(e) => commitProbability((e.target as HTMLInputElement).value)}
							onblur={() => (probabilityDraft = String(effectiveProbability))}
							class="input-base w-full px-3 py-2 font-mono text-sm text-text-primary"
						/>
						<p class="mt-1 text-xs font-ui text-text-muted">Chance to fire · 100 = always.</p>
					</div>
					<div>
						<span class="ed-label section-label">Case-sensitive</span>
						<div class="ed-cascade">
							<Toggle
								checked={entry.caseSensitive ?? caseDefault}
								label="Case-sensitive"
								onchange={(next) => update({ caseSensitive: next })}
							/>
							<OverrideMark
								overridden={(entry.caseSensitive ?? caseDefault) !== caseDefault}
								onRevert={() => update({ caseSensitive: null })}
							/>
						</div>
					</div>
					<div>
						<span class="ed-label section-label">Whole words</span>
						<div class="ed-cascade">
							<Toggle
								checked={entry.matchWholeWords ?? wholeDefault}
								label="Match whole words"
								onchange={(next) => update({ matchWholeWords: next })}
							/>
							<OverrideMark
								overridden={(entry.matchWholeWords ?? wholeDefault) !== wholeDefault}
								onRevert={() => update({ matchWholeWords: null })}
							/>
						</div>
					</div>
				</div>

				<!-- Advanced: the knobs most entries never touch, folded away so the row stays calm -->
				<div>
					<button
						type="button"
						class="ed-adv-head"
						onclick={() => (showAdvanced = !showAdvanced)}
						aria-expanded={showAdvanced}
					>
						<Icon name="chevronDown" class="w-3.5 h-3.5 ed-adv-chev" />
						Advanced
						{#if advancedSummary}<span class="ed-adv-sum">{advancedSummary}</span>{/if}
					</button>
					{#if showAdvanced}
						<div class="ed-adv-body">
							<div>
								<div class="ed-adv-label">
									<label for="entry-depth-{entryId}" class="ed-label section-label !mb-0">Scan depth</label>
									<InfoTip text="Recent messages this entry searches · 0 = the whole chat." />
								</div>
								<div class="ed-cascade">
									<input
										id="entry-depth-{entryId}"
										type="text"
										inputmode="numeric"
										value={depthDraft}
										oninput={(e) => commitDepth((e.target as HTMLInputElement).value)}
										onblur={() => (depthDraft = String(effectiveDepth))}
										class="input-base w-16 px-2 py-1.5 font-mono text-sm text-text-primary text-center"
									/>
									<OverrideMark
										overridden={effectiveDepth !== depthDefault}
										onRevert={() => update({ scanDepth: null })}
									/>
								</div>
							</div>

							<div>
								<div class="ed-adv-label">
									<span class="ed-label section-label !mb-0">Also scan</span>
									<InfoTip text="Card text searched besides the chat. Nothing picked = the chat alone." />
								</div>
								<div class="ed-pills">
									{#each LOREBOOK_SCAN_FIELDS as field (field.id)}
										<button
											type="button"
											class="ed-pill"
											class:is-on={entry.scanFields?.includes(field.id)}
											aria-pressed={entry.scanFields?.includes(field.id) ?? false}
											onclick={() => toggleScanField(field.id)}
										>
											{field.label}
										</button>
									{/each}
								</div>
							</div>

							<div>
								<div class="ed-adv-label">
									<label for="entry-woken-{entryId}" class="ed-label section-label !mb-0">Woken by</label>
									<InfoTip
										text="What may wake this entry: the story text, or the content of entries that already fired. A level stages that: the next one opens only once the level below it wakes nothing new."
									/>
								</div>
								<div class="flex items-end gap-3 flex-wrap">
									<Select
										id="entry-woken-{entryId}"
										value={wokenBy}
										onchange={(e) => setWokenBy((e.target as HTMLSelectElement).value as LorebookWokenBy)}
										variant="compact"
										class="!w-auto"
									>
										{#each wokenByOptions as option (option.id)}
											<option value={option.id}>{option.label}</option>
										{/each}
									</Select>
									{#if wokenBy === 'entriesOnly'}
										<label class="ed-timed">
											<span class="ed-timed-name">Level</span>
											<input
												type="text"
												inputmode="numeric"
												value={levelDraft}
												oninput={(e) => commitLevel((e.target as HTMLInputElement).value)}
												onblur={() => (levelDraft = String(Math.max(1, recursion?.delayLevel ?? 1)))}
												class="input-base w-14 px-2 py-1.5 font-mono text-sm text-text-primary text-center"
											/>
										</label>
									{/if}
								</div>
								<!-- Not the knob's own help. Both lines are facts about THIS entry, and both name
								     an entry that cannot fire, which is the absence hardest to explain. -->
								{#if wokenBy === 'never'}
									<p class="mt-1.5 text-xs font-ui text-text-muted">
										SillyTavern has this entry waiting for another one to wake it while also refusing
										to be woken, so nothing can fire it. Picking a source is a real change.
									</p>
								{:else if wokenBy === 'entriesOnly' && bookDefaults && !bookDefaults.recursiveScanning}
									<p class="mt-1.5 text-xs font-ui text-text-muted">
										This book never re-reads what fires, so nothing can wake this entry.
									</p>
								{/if}
							</div>

							<div>
								<div class="ed-adv-label">
									<span class="ed-label section-label !mb-0">Wakes others</span>
									<InfoTip
										text="When off, this entry's own content is never re-read, so it cannot pull other entries in."
									/>
								</div>
								<div class="ed-cascade">
									<Toggle
										checked={!recursion?.preventRecursion}
										label="Wakes others"
										onchange={(next) => setRecursion({ preventRecursion: !next })}
									/>
								</div>
							</div>

							<div>
								<div class="ed-adv-label">
									<span class="ed-label section-label !mb-0">Fires on</span>
									<InfoTip text="Which generations this entry may join. Nothing picked = all of them." />
								</div>
								<div class="ed-pills">
									{#each LOREBOOK_TRIGGERS as t (t.id)}
										<button
											type="button"
											class="ed-pill"
											class:is-on={triggerOn(t.id)}
											aria-pressed={triggerOn(t.id)}
											onclick={() => toggleTrigger(t.id)}
										>
											{t.label}
										</button>
									{/each}
								</div>
							</div>

							<div>
								<div class="ed-adv-label">
									<span class="ed-label section-label !mb-0">Timing</span>
									<InfoTip
										text="After it fires it stays in for Sticky more replies, then sits out Cooldown of them. Delay holds it back until the chat has that many messages."
									/>
								</div>
								<div class="flex items-start gap-3">
									{#each TIMED as t (t.field)}
										<label class="ed-timed">
											<span class="ed-timed-name">{t.label}</span>
											<input
												type="text"
												inputmode="numeric"
												value={timedValue(t.field)}
												oninput={(e) => commitTimed(t.field, (e.target as HTMLInputElement).value)}
												placeholder="off"
												class="input-base w-14 px-2 py-1.5 font-mono text-sm text-text-primary text-center"
											/>
										</label>
									{/each}
								</div>
							</div>

							<div>
								<div class="ed-adv-label">
									<label for="entry-group-{entryId}" class="ed-label section-label !mb-0">Inclusion group</label>
									<InfoTip
										text="Only one entry per label reaches a prompt, and several labels are comma-separated. A prioritized entry takes the slot first, Decide by matches narrows it to whichever matched most keys, and whatever is left goes to a weighted roll."
									/>
								</div>
								<input
									id="entry-group-{entryId}"
									type="text"
									value={entry.group ?? ''}
									oninput={(e) => update({ group: (e.target as HTMLInputElement).value })}
									placeholder="weather, mood…"
									class="input-base w-full max-w-[16rem] px-3 py-2 font-ui text-sm text-text-primary"
								/>
								{#if entry.group?.trim()}
									<div class="mt-2.5 flex items-center gap-4 flex-wrap">
										<label class="ed-timed">
											<span class="ed-timed-name">Weight</span>
											<input
												type="text"
												inputmode="numeric"
												value={weightDraft}
												oninput={(e) => {
													weightDraft = (e.target as HTMLInputElement).value;
													if (/^\d+$/.test(weightDraft.trim()))
														update({ groupWeight: parseInt(weightDraft, 10) });
												}}
												onblur={() => (weightDraft = String(entry?.groupWeight ?? DEFAULT_GROUP_WEIGHT))}
												class="input-base w-14 px-2 py-1.5 font-mono text-sm text-text-primary text-center"
											/>
										</label>
										<div class="ed-cascade">
											<Toggle
												checked={entry.groupOverride ?? false}
												label="Prioritize"
												onchange={(next) => update({ groupOverride: next })}
											/>
											<span class="text-xs font-ui text-text-secondary">Prioritize</span>
										</div>
										<div class="ed-cascade">
											<Toggle
												checked={entry.useGroupScoring ?? false}
												label="Decide by matches"
												onchange={(next) => update({ useGroupScoring: next })}
											/>
											<span class="text-xs font-ui text-text-secondary">Decide by matches</span>
										</div>
									</div>
								{/if}
							</div>

							<div>
								<div class="ed-adv-label">
									<label for="entry-place-{entryId}" class="ed-label section-label !mb-0">Placement</label>
									<InfoTip
										text="It joins the block the preset placed at {'{{lorebook}}'}, or rides inside the story as its own turn, that many turns back from the newest. Without {'{{chatHistory}}'} in the preset an at-depth entry falls back to the block."
									/>
								</div>
								<div class="flex items-end gap-3 flex-wrap">
									<Select
										id="entry-place-{entryId}"
										value={String(entry.position ?? LOREBOOK_POSITION_BLOCK)}
										onchange={(e) =>
											update({ position: parseInt((e.target as HTMLSelectElement).value, 10) })}
										variant="compact"
										class="!w-auto"
									>
										<option value={String(LOREBOOK_POSITION_BLOCK)}>In the lorebook block</option>
										<option value={String(LOREBOOK_POSITION_AT_DEPTH)}>At a depth in the chat</option>
										{#if foreignPosition}
											<option value={String(entry.position)}>{foreignPosition}</option>
										{/if}
									</Select>
									{#if atDepth}
										<label class="ed-timed">
											<span class="ed-timed-name">Depth</span>
											<input
												type="text"
												inputmode="numeric"
												value={placeDepthDraft}
												oninput={(e) => commitPlaceDepth((e.target as HTMLInputElement).value)}
												onblur={() => (placeDepthDraft = String(entry?.depth ?? DEFAULT_LOREBOOK_DEPTH))}
												class="input-base w-14 px-2 py-1.5 font-mono text-sm text-text-primary text-center"
											/>
										</label>
										<label class="ed-timed">
											<span class="ed-timed-name">As</span>
											<Select
												value={String(entry.role ?? 0)}
												onchange={(e) => update({ role: parseInt((e.target as HTMLSelectElement).value, 10) })}
												variant="compact"
												class="!w-auto"
												aria-label="Injected turn role"
											>
												{#each LOREBOOK_ROLES as r (r.id)}
													<option value={String(r.id)}>{r.label}</option>
												{/each}
											</Select>
										</label>
									{/if}
								</div>
								<!-- Not the knob's own help: an imported entry sitting somewhere this app has no
								     place for is a fact about THIS entry, so it stays on screen. -->
								{#if foreignPosition}
									<p class="mt-1.5 text-xs font-ui text-text-muted">
										SillyTavern puts this entry somewhere this app has no place for, so it goes into
										the block here and leaves as it arrived. Picking another place is a real change.
									</p>
								{/if}
							</div>
						</div>
					{/if}
				</div>

				<!-- Entry actions -->
				<div class="flex items-center justify-end gap-1 pt-1 border-t border-border-subtle">
					<button
						type="button"
						class="icon-btn !w-8 !h-8"
						onclick={onDuplicate}
						aria-label="Duplicate entry"
						title="Duplicate"
					>
						<Icon name="copy" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="icon-btn !w-8 !h-8 hover:!text-error hover:!bg-error/10"
						onclick={onDelete}
						aria-label="Delete entry"
						title="Delete"
					>
						<Icon name="trash" class="w-4 h-4" />
					</button>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	/* ===== the card: a flat row that unfolds in place ===== */

	.lbr {
		border-radius: var(--radius-md);
		transition: background-color 130ms ease, opacity 130ms ease;
	}

	.lbr:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
	}

	.lbr.is-off {
		opacity: 0.55;
	}

	.lbr.is-open {
		opacity: 1;
		margin-block: 0.375rem;
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
	}

	.lbr-head {
		display: flex;
		align-items: stretch;
	}

	.lbr-glyph {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		align-self: stretch;
		flex-shrink: 0;
		cursor: pointer;
	}

	.lbr-glyph:hover .lbr-dot {
		transform: scale(1.25);
	}

	/* Colour carries the status: accent = always active, green = keyword, dashed = off. */
	.lbr-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: var(--radius-full);
		flex-shrink: 0;
		transition: transform 140ms ease, background-color 140ms ease, border-color 140ms ease;
	}

	.lbr-dot-always {
		background: var(--color-accent);
		box-shadow: 0 0 8px color-mix(in srgb, var(--color-accent) 60%, transparent);
	}

	.lbr-dot-keyword {
		background: var(--color-success);
		box-shadow: 0 0 8px color-mix(in srgb, var(--color-success) 45%, transparent);
	}

	.lbr-dot-off {
		background: transparent;
		border: 1px dashed var(--color-text-muted);
		opacity: 0.7;
	}

	.lbr-check {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border-radius: 4px;
		border: 1px solid var(--color-border);
		color: transparent;
		transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
	}

	.lbr-check.is-checked {
		background: var(--color-accent);
		border-color: var(--color-accent);
		color: var(--color-on-accent);
	}

	.lbr-main {
		flex: 1;
		min-width: 0;
		text-align: left;
		padding: 0.4rem 0.5rem 0.45rem 0;
		cursor: pointer;
	}

	.lbr-main:focus-visible {
		outline: 2px solid var(--color-accent);
		border-radius: var(--radius-md);
	}

	.lbr-title {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.8125rem;
		font-weight: 500;
		line-height: 1.35;
		color: var(--color-text-primary);
	}

	.lbr-title.is-untitled {
		font-style: italic;
		font-weight: 400;
		color: var(--color-text-muted);
	}

	.lbr-sub {
		display: block;
		margin-top: 0.05rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.lbr-sub-always {
		color: color-mix(in srgb, var(--color-accent) 75%, var(--color-text-muted));
	}

	.lbr-sub-warn {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		color: var(--color-warning);
	}

	/* ===== quick fields (collapsed rows only) ===== */

	/* The per-row order/% editors sit in their boxes at rest, so both values can be
	   read off a collapsed list without hovering. Row hover and focus only lift
	   their contrast. */
	.lbr-mini {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		align-self: center;
		flex-shrink: 0;
		padding: 0 0.35rem;
	}

	/* Collapsed row's token weight: how much prompt this entry costs when it fires. */
	.lbr-weight {
		align-self: center;
		flex-shrink: 0;
		padding: 0 0.35rem;
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.lbr-mini input {
		width: 2.4rem;
		padding: 0.2rem 0.25rem;
		text-align: center;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-secondary);
		background: transparent;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
		outline: none;
		transition: border-color 130ms ease, background-color 130ms ease, color 130ms ease;
	}

	.lbr:hover .lbr-mini input,
	.lbr-mini input:focus {
		background: color-mix(in srgb, var(--color-bg-primary) 55%, transparent);
		color: var(--color-text-primary);
	}

	.lbr-mini input:focus {
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	.lbr-mini-key {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
		user-select: none;
	}

	.lbr-chev {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		align-self: stretch;
		flex-shrink: 0;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 140ms ease;
	}

	.lbr-chev:hover {
		color: var(--color-text-primary);
	}

	.lbr-chev :global(svg) {
		transition: transform 160ms ease;
	}

	.lbr-chev.is-open :global(svg) {
		transform: rotate(180deg);
	}

	/* ===== unfolded editor ===== */

	.lbr-body {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 0.5rem 1rem 0.85rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.ed-title {
		width: 100%;
		background: transparent;
		border: 0;
		/* Editability affordance: an underline that only exists while the field has
		   the pointer or the caret, so the resting state still reads as a heading. */
		border-bottom: 1px solid transparent;
		outline: none;
		padding: 0 0 0.15rem;
		font-family: var(--font-ui);
		font-size: 1.05rem;
		line-height: 1.3;
		font-weight: 650;
		color: var(--color-text-primary);
		transition: border-color 140ms ease;
	}

	.ed-title:hover {
		border-bottom-color: var(--color-border-subtle);
	}

	.ed-title:focus {
		border-bottom-color: color-mix(in srgb, var(--color-accent) 65%, transparent);
	}

	.ed-title::placeholder {
		font-style: italic;
		font-weight: 400;
		color: var(--color-text-muted);
	}

	/* Typography comes from the global .section-label; only the margin is local. */
	.ed-label {
		margin-bottom: 0.4rem;
	}

	.ed-macro {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--color-accent);
	}

	/* Behavior segmented control, speaking the app's toolbar-segment language. */
	.ed-seg {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 3px;
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
	}

	.ed-seg-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.3rem 0.7rem;
		border-radius: calc(var(--radius-md) - 4px);
		font-family: var(--font-ui);
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 140ms ease, color 140ms ease;
	}

	.ed-seg-btn:hover {
		color: var(--color-text-primary);
	}

	.ed-seg-btn.is-active {
		background: var(--color-bg-primary);
		color: var(--color-accent);
		font-weight: 600;
		box-shadow: var(--shadow-sm);
	}

	/* A cascading field: the switch, then where its state came from. */
	.ed-cascade {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.25rem;
	}

	/* ===== advanced ===== */

	.ed-adv-head {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 130ms ease;
	}

	.ed-adv-head:hover {
		color: var(--color-text-primary);
	}

	.ed-adv-head :global(.ed-adv-chev) {
		transition: transform 160ms ease;
	}

	.ed-adv-head[aria-expanded='true'] :global(.ed-adv-chev) {
		transform: rotate(180deg);
	}

	/* What the fold is hiding, in the reader's terms, so nothing works invisibly. */
	.ed-adv-sum {
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
		color: color-mix(in srgb, var(--color-accent) 80%, var(--color-text-muted));
	}

	.ed-adv-body {
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		margin-top: 0.8rem;
	}

	/* A knob's name with its explanation on the ⓘ beside it, so the fold stays scannable. */
	.ed-adv-label {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-bottom: 0.4rem;
	}

	.ed-pills {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	/* A small numeric field wearing its own name, for the rows that hold several. */
	.ed-timed {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.ed-timed-name {
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--color-text-muted);
	}

	.ed-pill {
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

	.ed-pill:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-border) 90%, transparent);
	}

	.ed-pill.is-on {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
	}

	.ed-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.9rem;
		flex: 1;
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
		cursor: pointer;
		transition: background-color 140ms ease, color 140ms ease;
	}

	.ed-step:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 92%, transparent);
	}
</style>
