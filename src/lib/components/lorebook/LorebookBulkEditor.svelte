<script lang="ts">
	/**
	 * Every setting of a selection of entries, edited at once: the body of the dialog the open
	 * book's selection bar raises (Edit…). Each knob shows what the selection holds, its shared
	 * value or Mixed, and a change is staged until Apply, which writes every entry exactly what
	 * its own row writes for the same press (lorebook/bulk.ts).
	 *
	 * Staged rather than live because a live press would flatten a mixed setting across the
	 * whole selection on the spot, and nothing in the app could hand each entry its own value
	 * back. The staging lives in this instance, so the caller mounts a fresh one per opening
	 * (LorebookView keys it) and nothing staged outlives a Cancel.
	 */
	import { tick } from 'svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import OverrideMark from '$lib/components/ui/OverrideMark.svelte';
	import PillRow from '$lib/components/ui/PillRow.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import { LOREBOOK_ENTRY_NATURE_OPTIONS } from '$lib/stores/lorebookEntryPrefs.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import {
		DEFAULT_GROUP_WEIGHT,
		DEFAULT_LOREBOOK_DEPTH,
		LOREBOOK_ENTRY_TIPS,
		LOREBOOK_LOGICS,
		LOREBOOK_PLACEMENTS,
		LOREBOOK_POSITION_BLOCK,
		LOREBOOK_ROLES,
		LOREBOOK_SCAN_FIELDS,
		LOREBOOK_TIMED_FIELDS,
		LOREBOOK_TRIGGERS,
		ST_POSITION_NAMES,
		TRIGGER_ALIASES,
		lorebookWokenBy,
		lorebookWokenByOptions,
		natureOf,
		resolveBookActivation,
		resolveEntryRecursion,
		type LorebookEntry,
		type LorebookEntryNature,
		type LorebookScanField,
		type LorebookTrigger,
		type LorebookWokenBy
	} from '$lib/lorebook/types';
	import {
		LOREBOOK_KNOB_NAMES,
		MIXED,
		bulkEntryPatch,
		bulkOffers,
		changedKnobs,
		offeredEdit,
		sharedValue,
		withoutKnob,
		type LorebookBulkEdit,
		type LorebookBulkKnob,
		type Shared
	} from '$lib/lorebook/bulk';

	interface Props {
		bookId: string;
		entryIds: ReadonlySet<string>;
		onClose: () => void;
		/** Something is staged, for the dialog's `held`: while it is, Escape is answered here. */
		held?: boolean;
	}

	let { bookId, entryIds, onClose, held = $bindable(false) }: Props = $props();

	let book = $derived(lorebookStore.getBook(bookId));
	let entries = $derived(book ? book.entries.filter((e) => entryIds.has(e.id)) : []);

	// The book's resolved defaults, through the resolver the scan uses, so a follow-the-book
	// knob shows the value the scan will actually apply.
	let globals = $derived(lorebookSettingsStore.settings);
	let defaults = $derived(book ? resolveBookActivation(book, globals) : null);
	let caseDefault = $derived(defaults?.caseSensitive ?? globals.caseSensitive);
	let wholeDefault = $derived(defaults?.matchWholeWords ?? globals.matchWholeWords);
	let depthDefault = $derived(defaults?.scanDepth ?? globals.scanDepth);

	let edit = $state<LorebookBulkEdit>({});
	let offers = $derived(bulkOffers(entries, edit));
	let changed = $derived(changedKnobs(offeredEdit(entries, edit)));
	let summary = $derived(
		changed.size === 0
			? ''
			: `${changed.size} ${changed.size === 1 ? 'setting' : 'settings'} will change`
	);

	function shared<T>(read: (e: LorebookEntry) => T): Shared<T> {
		return sharedValue(entries, read);
	}

	/** Stage a value, or drop it when every entry already shows it: a change that changes
	 *  nothing would still be counted, and the reader would go looking for it. */
	function stage<K extends keyof LorebookBulkEdit>(
		key: K,
		value: LorebookBulkEdit[K],
		unchanged: boolean
	) {
		if (unchanged) return unstage(key);
		edit = { ...edit, [key]: value };
	}

	function unstage(key: keyof LorebookBulkEdit) {
		const next = { ...edit };
		delete next[key];
		edit = next;
	}

	const TIPS: Partial<Record<LorebookBulkKnob, string>> = LOREBOOK_ENTRY_TIPS;

	const ON_OFF = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];

	function onOff(value: Shared<boolean>): Shared<string> {
		return value === MIXED ? MIXED : value ? 'on' : 'off';
	}

	/** A star's way back in words, naming the value the book hands back. */
	function followLabel(bookValue: string): string {
		return `Follow the book (${bookValue})`;
	}

	// ===== what the selection holds, and what each knob shows =====

	let natureNow = $derived(shared(natureOf));
	let natureShown = $derived(edit.nature ?? natureNow);

	let logicNow = $derived(shared((e) => e.selectiveLogic));
	let logicShown = $derived(edit.selectiveLogic ?? logicNow);

	let caseNow = $derived(shared((e) => e.caseSensitive ?? caseDefault));
	let caseShown = $derived(
		edit.caseSensitive !== undefined ? (edit.caseSensitive ?? caseDefault) : caseNow
	);
	let wholeNow = $derived(shared((e) => e.matchWholeWords ?? wholeDefault));
	let wholeShown = $derived(
		edit.matchWholeWords !== undefined ? (edit.matchWholeWords ?? wholeDefault) : wholeNow
	);

	let wokenNow = $derived(shared((e) => lorebookWokenBy(resolveEntryRecursion(e))));
	let wokenShown = $derived<Shared<LorebookWokenBy>>(edit.wokenBy ?? wokenNow);
	let wokenOptions = $derived(
		lorebookWokenByOptions(offers.allAlways, wokenShown === MIXED ? undefined : wokenShown)
	);

	let wakesNow = $derived(shared((e) => !resolveEntryRecursion(e).preventRecursion));
	let wakesShown = $derived(edit.wakesOthers ?? wakesNow);

	let groupNow = $derived(shared((e) => e.group ?? ''));
	let groupShown = $derived(edit.group ?? groupNow);
	let overrideNow = $derived(shared((e) => e.groupOverride ?? false));
	let scoringNow = $derived(shared((e) => e.useGroupScoring ?? false));

	let positionNow = $derived(shared((e) => e.position ?? LOREBOOK_POSITION_BLOCK));
	let positionShown = $derived(edit.position ?? positionNow);
	/** A SillyTavern position the whole selection shares, named as the row names it. */
	let foreignPosition = $derived(
		positionShown === MIXED ? '' : (ST_POSITION_NAMES[positionShown] ?? '')
	);
	let roleNow = $derived(shared((e) => e.role ?? 0));
	let roleShown = $derived(edit.role ?? roleNow);

	// ===== the two membership lists =====

	/** How many entries hold a member. A partial one says so on its pill, since the dashed
	 *  outline alone is a state only a hover explains. */
	function holding(has: (e: LorebookEntry) => boolean): number {
		return entries.filter(has).length;
	}

	function sourceCount(id: LorebookScanField): number {
		return holding((e) => (e.scanFields ?? []).includes(id));
	}

	/** Reads the aliases too, as the row's pill does, so an imported `regenerate` lights
	 *  Regenerate exactly as it fires the engine. */
	function kindCount(id: LorebookTrigger): number {
		return holding((e) => (e.triggers ?? []).some((t) => TRIGGER_ALIASES[id].includes(t)));
	}

	/** What a member's count reads as across the selection. */
	function memberNow(count: number): Shared<boolean> {
		if (entries.length === 0 || (count > 0 && count < entries.length)) return MIXED;
		return count > 0;
	}

	function memberShown(
		key: 'scanFields' | 'triggers',
		id: string,
		now: Shared<boolean>
	): Shared<boolean> {
		return (edit[key] as Record<string, boolean> | undefined)?.[id] ?? now;
	}

	/** A mixed member turns on first: the press that makes a partial state whole. */
	function toggleMember(key: 'scanFields' | 'triggers', id: string, now: Shared<boolean>) {
		const on = memberShown(key, id, now) !== true;
		const members: Record<string, boolean> = { ...(edit[key] ?? {}) };
		if (now === on) delete members[id];
		else members[id] = on;
		stage(key, members, Object.keys(members).length === 0);
	}

	// ===== numbers =====

	type NumberKey =
		| 'order'
		| 'probability'
		| 'scanDepth'
		| 'delayLevel'
		| 'groupWeight'
		| 'depth'
		| 'sticky'
		| 'cooldown'
		| 'delay';

	/** A whole number as typed, or undefined while the text is not one yet. */
	function whole(raw: string): number | undefined {
		return /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : undefined;
	}

	/** Zero is off, which the row reads the same as a window never set. */
	function offOrWhole(raw: string): number | null | undefined {
		const n = whole(raw);
		return n === undefined ? undefined : n || null;
	}

	/** Each numeric knob: what one entry holds as its row reads it (null is off), and how a
	 *  typed string becomes a value (undefined while it is not one yet). */
	const NUMBERS: Record<
		NumberKey,
		{ read: (e: LorebookEntry) => number | null; parse: (raw: string) => number | null | undefined }
	> = {
		order: { read: (e) => e.order, parse: whole },
		probability: {
			read: (e) => (e.useProbability ? e.probability : 100),
			parse: (raw) => {
				const n = whole(raw);
				return n === undefined ? undefined : Math.min(100, n);
			}
		},
		scanDepth: { read: (e) => e.scanDepth ?? depthDefault, parse: whole },
		delayLevel: {
			read: (e) => Math.max(1, resolveEntryRecursion(e).delayLevel),
			parse: (raw) => {
				const n = whole(raw);
				return n === undefined ? undefined : Math.max(1, n);
			}
		},
		groupWeight: { read: (e) => e.groupWeight ?? DEFAULT_GROUP_WEIGHT, parse: whole },
		depth: { read: (e) => e.depth ?? DEFAULT_LOREBOOK_DEPTH, parse: whole },
		sticky: { read: (e) => e.sticky || null, parse: offOrWhole },
		cooldown: { read: (e) => e.cooldown || null, parse: offOrWhole },
		delay: { read: (e) => e.delay || null, parse: offOrWhole }
	};

	let scanNow = $derived(shared(NUMBERS.scanDepth.read));

	function numberShown(key: NumberKey): Shared<number | null> {
		const staged = edit[key];
		// A scan depth staged as null follows the book, so it shows the book's window.
		if (staged !== undefined) return key === 'scanDepth' && staged === null ? depthDefault : staged;
		return shared(NUMBERS[key].read);
	}

	function numberText(key: NumberKey): string {
		const value = numberShown(key);
		return value === MIXED || value === null ? '' : String(value);
	}

	function numberPlaceholder(key: NumberKey): string {
		const value = numberShown(key);
		return value === MIXED ? 'Mixed' : value === null ? 'off' : '';
	}

	// The field being typed into keeps its own text, so a draft that does not parse yet is
	// never overwritten by the value it will become.
	let typing = $state<NumberKey | 'group' | null>(null);
	let draft = $state('');

	// An emptied field goes back to how it opened, whatever it held: emptying is how a reader
	// takes back what they typed, so it cannot also stage off or no group for the whole
	// selection. Those are a 0 and the No group press.
	function typeNumber(key: NumberKey, raw: string) {
		draft = raw;
		if (raw.trim() === '') return unstage(key);
		const value = NUMBERS[key].parse(raw);
		if (value !== undefined) stage(key, value, shared(NUMBERS[key].read) === value);
	}

	function typeGroup(raw: string) {
		draft = raw;
		if (raw.trim() === '') unstage('group');
		else stage('group', raw, groupNow === raw);
	}

	function toggleNoGroup() {
		if (edit.group === '') unstage('group');
		else stage('group', '', false);
	}

	// ===== leaving with something staged =====

	$effect(() => {
		held = changed.size > 0;
	});

	/** Escape asks before it throws the staging away: a reflex, often only meant to leave a
	 *  field, should not cost what was set. A second Escape, or going back into the knobs,
	 *  answers keep editing. Cancel and the close X still leave at once. */
	let asking = $state(false);
	let askedFrom: HTMLElement | null = null;
	let footEl = $state<HTMLElement | null>(null);

	$effect(() => {
		if (changed.size === 0) asking = false;
	});

	function onKeydown(e: KeyboardEvent) {
		// While nothing is staged the dialog answers Escape itself, by closing.
		if (e.key !== 'Escape' || changed.size === 0) return;
		e.preventDefault();
		if (asking) return keepEditing();
		askedFrom = document.activeElement as HTMLElement | null;
		asking = true;
		void tick().then(() => footEl?.querySelector('button')?.focus());
	}

	function keepEditing() {
		asking = false;
		askedFrom?.focus();
		askedFrom = null;
	}

	let footLine = $derived(
		asking
			? `Discard ${changed.size} ${changed.size === 1 ? 'change' : 'changes'}?`
			: summary
	);

	// ===== apply =====

	function apply() {
		const write = offeredEdit(entries, $state.snapshot(edit) as LorebookBulkEdit);
		if (changedKnobs(write).size === 0) return;
		const updated = lorebookStore.updateEntries(bookId, entryIds, (entry) =>
			bulkEntryPatch(entry, write)
		);
		onClose();
		// Most of what changed is not on a collapsed row, so the count is the only sign it landed.
		if (updated > 0) toastStore.success(`Updated ${updated} ${updated === 1 ? 'entry' : 'entries'}`);
	}
</script>

{#snippet head(knob: LorebookBulkKnob)}
	<div class="bk-head">
		<span class="section-label bk-name" class:is-changed={changed.has(knob)}>
			{LOREBOOK_KNOB_NAMES[knob]}
		</span>
		{#if TIPS[knob]}<InfoTip text={TIPS[knob]} />{/if}
		{#if changed.has(knob)}
			<button type="button" class="bk-keep" onclick={() => (edit = withoutKnob(edit, knob))}>
				Leave as is
			</button>
		{/if}
	</div>
{/snippet}

{#snippet pills(
	options: { value: string; label: string }[],
	current: Shared<string>,
	onpick: (value: string) => void,
	label: string
)}
	<div class="bk-pills">
		<PillRow {options} current={current === MIXED ? '' : current} {onpick} {label} />
		{#if current === MIXED}<span class="bk-mixed">Mixed</span>{/if}
	</div>
{/snippet}

{#snippet numberField(key: NumberKey, label: string, wide: boolean)}
	<input
		type="text"
		inputmode="numeric"
		class="input-base bk-field {wide
			? 'w-full px-3 py-2'
			: 'w-16 px-2 py-1.5 text-center'} font-mono text-sm text-text-primary"
		value={typing === key ? draft : numberText(key)}
		placeholder={numberPlaceholder(key)}
		aria-label={label}
		onfocus={() => {
			typing = key;
			draft = numberText(key);
		}}
		oninput={(e) => typeNumber(key, (e.target as HTMLInputElement).value)}
		onblur={() => (typing = null)}
	/>
{/snippet}

{#snippet member(key: 'scanFields' | 'triggers', id: string, label: string, count: number)}
	{@const now = memberNow(count)}
	{@const lit = memberShown(key, id, now)}
	<button
		type="button"
		class="bk-pill"
		class:is-on={lit === true}
		class:is-mixed={lit === MIXED}
		aria-pressed={lit === MIXED ? 'mixed' : lit}
		onclick={() => toggleMember(key, id, now)}
	>
		{label}{#if lit === MIXED}{' '}<span class="bk-count">{count}/{entries.length}</span>{/if}
	</button>
{/snippet}

<svelte:window onkeydown={onKeydown} />

<div class="bk">
	<!-- Not a control: a press anywhere among the knobs only answers the footer's question. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bk-body panel-scroll"
		onpointerdown={() => (asking = false)}
		onfocusin={() => (asking = false)}
	>
		<div>
			{@render head('nature')}
			{@render pills(
				LOREBOOK_ENTRY_NATURE_OPTIONS.map((o) => ({ value: o.id, label: o.label })),
				natureShown,
				(v) => stage('nature', v as LorebookEntryNature, natureNow === v),
				'Entry behavior'
			)}
		</div>

		<!-- Read only beside secondary keys, and never by an always-active entry, so it is drawn
		     only while a keyword entry here has some (bulkOffers). -->
		{#if offers.filter}
			<div>
				{@render head('filter')}
				<Select
					value={logicShown === MIXED ? '' : String(logicShown)}
					onchange={(e) => {
						const v = parseInt((e.target as HTMLSelectElement).value, 10);
						stage('selectiveLogic', v, logicNow === v);
					}}
					variant="compact"
					class="!w-auto max-w-full"
					aria-label="Secondary key logic"
				>
					{#if logicShown === MIXED}<option value="" disabled>Mixed</option>{/if}
					{#each LOREBOOK_LOGICS as l (l.id)}
						<option value={String(l.id)}>{l.glyph}</option>
					{/each}
				</Select>
				{#if logicShown !== MIXED}
					<p class="bk-note">{LOREBOOK_LOGICS.find((l) => l.id === logicShown)?.hint}</p>
				{/if}
			</div>
		{/if}

		<div class="bk-pair">
			<div>
				{@render head('order')}
				{@render numberField('order', 'Order', true)}
			</div>
			<div>
				{@render head('probability')}
				{@render numberField('probability', 'Trigger percent', true)}
			</div>
		</div>

		<div class="bk-pair">
			<div>
				{@render head('caseSensitive')}
				<div class="bk-row">
					{@render pills(
						ON_OFF,
						onOff(caseShown),
						(v) => stage('caseSensitive', v === 'on', caseNow === (v === 'on')),
						'Case-sensitive'
					)}
					<!-- The star's way back hands the whole selection to the book again, which is a
					     change only while some entry does not already behave that way. -->
					<OverrideMark
						overridden={caseShown !== caseDefault}
						onRevert={() => stage('caseSensitive', null, caseNow === caseDefault)}
						revertLabel={followLabel(caseDefault ? 'On' : 'Off')}
					/>
				</div>
			</div>
			<div>
				{@render head('matchWholeWords')}
				<div class="bk-row">
					{@render pills(
						ON_OFF,
						onOff(wholeShown),
						(v) => stage('matchWholeWords', v === 'on', wholeNow === (v === 'on')),
						'Match whole words'
					)}
					<OverrideMark
						overridden={wholeShown !== wholeDefault}
						onRevert={() => stage('matchWholeWords', null, wholeNow === wholeDefault)}
						revertLabel={followLabel(wholeDefault ? 'On' : 'Off')}
					/>
				</div>
			</div>
		</div>

		<!-- The row folds these under Advanced; here they are the reason the dialog exists, so
		     they stay open, in the row's order, under the row's own word for them. -->
		<div class="bk-part">
			<span class="section-label">Advanced</span>
			<span class="bk-rule"></span>
		</div>

		<div>
			{@render head('scanDepth')}
			<div class="bk-row">
				{@render numberField('scanDepth', 'Scan depth', false)}
				<OverrideMark
					overridden={numberShown('scanDepth') !== depthDefault}
					onRevert={() => stage('scanDepth', null, scanNow === depthDefault)}
					revertLabel={followLabel(String(depthDefault))}
				/>
			</div>
		</div>

		<div>
			{@render head('scanFields')}
			<div class="bk-members">
				{#each LOREBOOK_SCAN_FIELDS as field (field.id)}
					{@render member('scanFields', field.id, field.label, sourceCount(field.id))}
				{/each}
			</div>
		</div>

		<div>
			{@render head('wokenBy')}
			<div class="bk-row">
				<Select
					value={wokenShown === MIXED ? '' : wokenShown}
					onchange={(e) => {
						const v = (e.target as HTMLSelectElement).value as LorebookWokenBy;
						// `never` is only ever read off an import; it is not a state to write.
						if (v !== 'never') stage('wokenBy', v, wokenNow === v);
					}}
					variant="compact"
					class="!w-auto max-w-full"
					aria-label="Woken by"
				>
					{#if wokenShown === MIXED}<option value="" disabled>Mixed</option>{/if}
					{#each wokenOptions as option (option.id)}
						<option value={option.id}>{option.label}</option>
					{/each}
				</Select>
				{#if offers.level}
					<label class="bk-sub">
						<span class="bk-sub-name">Level</span>
						{@render numberField('delayLevel', 'Level', false)}
					</label>
				{/if}
			</div>
		</div>

		<div>
			{@render head('wakesOthers')}
			{@render pills(
				ON_OFF,
				onOff(wakesShown),
				(v) => stage('wakesOthers', v === 'on', wakesNow === (v === 'on')),
				'Wakes others'
			)}
		</div>

		<div>
			{@render head('triggers')}
			<div class="bk-members">
				{#each LOREBOOK_TRIGGERS as t (t.id)}
					{@render member('triggers', t.id, t.label, kindCount(t.id))}
				{/each}
			</div>
		</div>

		<div>
			{@render head('timing')}
			<div class="bk-row">
				{#each LOREBOOK_TIMED_FIELDS as t (t.field)}
					<label class="bk-sub">
						<span class="bk-sub-name">{t.label}</span>
						{@render numberField(t.field, t.label, false)}
					</label>
				{/each}
			</div>
		</div>

		<div>
			{@render head('group')}
			<div class="bk-group">
				<input
					type="text"
					class="input-base bk-field bk-group-field px-3 py-2 font-ui text-sm text-text-primary"
					value={typing === 'group' ? draft : groupShown === MIXED ? '' : groupShown}
					placeholder={groupShown === MIXED ? 'Mixed' : 'weather, mood…'}
					aria-label="Inclusion group"
					onfocus={() => {
						typing = 'group';
						draft = groupShown === MIXED ? '' : groupShown;
					}}
					oninput={(e) => typeGroup((e.target as HTMLInputElement).value)}
					onblur={() => (typing = null)}
				/>
				<!-- Drawn while some entry is in a group, since it takes every entry out of one. -->
				{#if groupNow !== ''}
					<button
						type="button"
						class="bk-pill"
						class:is-on={edit.group === ''}
						aria-pressed={edit.group === ''}
						onclick={toggleNoGroup}
					>
						No group
					</button>
				{/if}
			</div>
			{#if offers.groupRules}
				<div class="bk-row mt-2.5">
					<label class="bk-sub">
						<span class="bk-sub-name">Weight</span>
						{@render numberField('groupWeight', 'Weight', false)}
					</label>
					<div class="bk-sub">
						<span class="bk-sub-name">Prioritize</span>
						{@render pills(
							ON_OFF,
							onOff(edit.groupOverride ?? overrideNow),
							(v) => stage('groupOverride', v === 'on', overrideNow === (v === 'on')),
							'Prioritize'
						)}
					</div>
					<div class="bk-sub">
						<span class="bk-sub-name">Decide by matches</span>
						{@render pills(
							ON_OFF,
							onOff(edit.useGroupScoring ?? scoringNow),
							(v) => stage('useGroupScoring', v === 'on', scoringNow === (v === 'on')),
							'Decide by matches'
						)}
					</div>
				</div>
			{/if}
		</div>

		<div>
			{@render head('placement')}
			<div class="bk-row">
				<Select
					value={positionShown === MIXED ? '' : String(positionShown)}
					onchange={(e) => {
						const v = parseInt((e.target as HTMLSelectElement).value, 10);
						stage('position', v, positionNow === v);
					}}
					variant="compact"
					class="!w-auto max-w-full"
					aria-label="Placement"
				>
					{#if positionShown === MIXED}<option value="" disabled>Mixed</option>{/if}
					{#each LOREBOOK_PLACEMENTS as p (p.id)}
						<option value={String(p.id)}>{p.label}</option>
					{/each}
					{#if foreignPosition && positionShown !== MIXED}
						<option value={String(positionShown)}>{foreignPosition}</option>
					{/if}
				</Select>
				{#if offers.depthRules}
					<label class="bk-sub">
						<span class="bk-sub-name">Depth</span>
						{@render numberField('depth', 'Depth', false)}
					</label>
					<label class="bk-sub">
						<span class="bk-sub-name">As</span>
						<Select
							value={roleShown === MIXED ? '' : String(roleShown)}
							onchange={(e) => {
								const v = parseInt((e.target as HTMLSelectElement).value, 10);
								stage('role', v, roleNow === v);
							}}
							variant="compact"
							class="!w-auto max-w-full"
							aria-label="Injected turn role"
						>
							{#if roleShown === MIXED}<option value="" disabled>Mixed</option>{/if}
							{#each LOREBOOK_ROLES as r (r.id)}
								<option value={String(r.id)}>{r.label}</option>
							{/each}
						</Select>
					</label>
				{/if}
			</div>
		</div>
	</div>

	<footer class="bk-foot" bind:this={footEl}>
		<p class="bk-sum" class:is-empty={!footLine} aria-live="polite">{footLine}</p>
		<div class="bk-acts">
			{#if asking}
				<Button variant="ghost" onclick={keepEditing}>Keep editing</Button>
				<Button variant="danger" onclick={onClose}>Discard</Button>
			{:else}
				<Button variant="ghost" onclick={onClose}>Cancel</Button>
				<Button
					variant="primary"
					disabled={changed.size === 0 || entries.length === 0}
					onclick={apply}
				>
					Apply to {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
				</Button>
			{/if}
		</div>
	</footer>
</div>

<style>
	/* Head and foot stand still, the middle scrolls: Apply has to stay in reach from the last
	   knob on a phone, and the dialog is taller than one. */
	.bk {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.bk-body {
		flex: 1;
		min-height: 0;
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		padding: 1rem 1.25rem 1.25rem;
		container-type: inline-size;
		container-name: bkbody;
	}

	.bk-foot {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		padding: 0.75rem 1.25rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	/* Takes its own line on a phone rather than squeezing the two buttons, and no line at all
	   while there is nothing to say. */
	.bk-sum {
		flex: 1 1 10rem;
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.bk-sum.is-empty {
		flex-basis: 0;
	}

	.bk-acts {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}

	/* A knob's name, its tip, and while it is staged the way back to leaving it alone. The
	   entry row's own .ed-adv-label, so the two editors label a knob alike. */
	.bk-head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.3rem;
		min-height: 1.5rem;
		margin-bottom: 0.4rem;
	}

	.bk-name {
		transition: color 130ms ease;
	}

	/* A staged knob wears the accent and a dot, so a change scrolled past still shows. */
	.bk-name.is-changed {
		color: var(--color-accent);
	}

	.bk-name.is-changed::before {
		content: '';
		display: inline-block;
		width: 0.35rem;
		height: 0.35rem;
		margin-right: 0.35rem;
		border-radius: var(--radius-full);
		background: var(--color-accent);
		vertical-align: 0.1em;
	}

	/* Appears on the press that stages its knob, so it may not add a pixel to the head: the
	   negative margin hands its padding back, which keeps a thumb-sized target without moving
	   the control below. The line height is its own, since a button inherits the story's. */
	.bk-keep {
		margin: -0.25rem -0.4rem -0.25rem auto;
		padding: 0.25rem 0.4rem;
		border-radius: var(--radius-sm);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		line-height: 1rem;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 130ms ease, background-color 130ms ease;
	}

	.bk-keep:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
	}

	@media (pointer: coarse) {
		.bk-keep {
			margin: -0.45rem -0.55rem -0.45rem auto;
			padding: 0.45rem 0.55rem;
		}
	}

	.bk-pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1.1rem 1.25rem;
	}

	/* Below this a column cannot hold a knob's name and its Leave as is on one line, and a
	   head that wraps on the press that stages it moves the control out from under the finger. */
	@container bkbody (max-width: 25rem) {
		.bk-pair {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	/* A control and what sits beside it: a star, a level, a depth. Anything in it may shrink to
	   the row, so a long SillyTavern placement name cannot push the dialog sideways. */
	.bk-row {
		display: flex;
		align-items: flex-end;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
	}

	.bk-row > :global(*) {
		max-width: 100%;
	}

	.bk-pills {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.3rem 0.5rem;
	}

	.bk-mixed {
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-style: italic;
		color: var(--color-text-muted);
	}

	/* Typed "Mixed" and "off" are states, not values, so they read in the UI face. */
	.bk-field::placeholder {
		font-family: var(--font-ui);
		font-style: italic;
		color: var(--color-text-muted);
	}

	.bk-group {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.bk-group-field {
		flex: 1 1 10rem;
		min-width: 0;
		max-width: 16rem;
	}

	.bk-note {
		margin-top: 0.4rem;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	/* A small field wearing its own name, the row's .ed-timed. */
	.bk-sub {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.bk-sub-name {
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--color-text-muted);
	}

	.bk-part {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.bk-rule {
		flex: 1;
		height: 1px;
		background: var(--color-border-subtle);
	}

	.bk-members {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	/* The row's .ed-pill to the value, plus the one state a selection adds: dashed where only
	   some of it has the member. */
	.bk-pill {
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

	.bk-pill:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-border) 90%, transparent);
	}

	.bk-pill.is-on {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
	}

	.bk-pill.is-mixed {
		color: var(--color-text-primary);
		border-style: dashed;
		border-color: color-mix(in srgb, var(--color-accent) 60%, transparent);
	}

	.bk-count {
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-muted);
	}

	@media (max-width: 480px) {
		.bk-body {
			padding: 0.85rem 0.9rem 1rem;
		}

		.bk-foot {
			padding: 0.65rem 0.9rem;
		}
	}
</style>
