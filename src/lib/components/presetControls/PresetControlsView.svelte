<!--
  Preset Controls: the reader-facing half of the preset system. The Prompt Builder authors
  the form; this page fills it in.

  The page opens with the preset's own face (cover, name, byline, and the paragraph its
  author wrote) because a preset is somebody's work and arriving at a bare list of eleven
  switches tells you nothing about whose or what for. Below that: the baseline picker (the
  author's setups plus their defaults, exactly one lit), then their sections in their order,
  each with its heading note and its own fold. Everything on this page is the author
  speaking except the values and the chosen baseline, which are the reader's.

  The page holds exactly one idea of "unchanged": the lit baseline. Every modified dot,
  the status line, per-card Reset and Reset-all measure against it and return to it, so a
  reader who adopted a setup is never told they have drifted from something they did not
  choose, and "reset" never walks them off the configuration they picked.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import ChatOverrideNotice from '$lib/components/ui/ChatOverrideNotice.svelte';
	import { isSectionIcon } from '$lib/config/section-icons';
	import PresetManager from '$lib/components/presets/PresetManager.svelte';
	import CustomControlField from './CustomControlField.svelte';
	import { presetService } from '$lib/services/presets.svelte';
	import { presetControlsStore } from '$lib/stores/presetControls.svelte';
	import { imageService } from '$lib/services/imageService';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { chatPreset } from '$lib/utils/chat-setup';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { countTokens } from '$lib/tokenizer';
	import { llmService } from '$lib/services/llm/provider';
	import { formatControlForPrompt, getControlValue } from '$lib/utils/prompt-controls';
	import type { PromptControl, PromptPresetBundle } from '$lib/types/database';

	// Make sure presets are loaded; the guard inside initialize() makes re-runs free.
	$effect(() => {
		presetService.initialize();
	});

	// Derived straight from the service's reactive maps, so the page tracks live:
	// switching the active preset, editing controls in the builder while this
	// overlay is open, sync reloads, with no snapshot to go stale.
	let activePreset = $derived(presetService.getActiveEffectivePreset());
	let activeControls = $derived(activePreset?.controls ?? []);
	// This preset's values, which is the only set this page may read or write: another
	// preset's knobs are not this page's business even where they share a macro name.
	let values = $derived(presetControlsStore.valuesFor(activePreset?.id ?? null));
	let meta = $derived(activePreset?.meta);
	let coverUrl = $derived(meta?.cover ? imageService.thumbnailUrl(meta.cover) : null);

	/**
	 * Controls grouped into the author's declared sections, in the author's order. A group a
	 * control names but the preset never declared still renders (under its own name, after
	 * the declared ones), which is what lets a preset that predates sections, or one hand-
	 * written without them, keep working exactly as it did.
	 */
	let sections = $derived.by(() => {
		const byGroup = new Map<string, PromptControl[]>();
		for (const control of activeControls) {
			const key = control.group?.trim() ?? '';
			if (!byGroup.has(key)) byGroup.set(key, []);
			byGroup.get(key)!.push(control);
		}

		const out: {
			id: string;
			title: string;
			description?: string;
			icon?: string;
			collapsed: boolean;
			controls: PromptControl[];
		}[] = [];

		for (const declared of activePreset?.sections ?? []) {
			const controls = byGroup.get(declared.id);
			if (!controls) continue; // a section whose controls all went away is not a heading
			byGroup.delete(declared.id);
			out.push({ ...declared, collapsed: declared.collapsed === true, controls });
		}
		// Whatever the preset never spoke for, in first-appearance order.
		for (const [id, controls] of byGroup) {
			out.push({ id, title: id, collapsed: false, controls });
		}
		return out;
	});

	/**
	 * Rendered card heights, keyed by control id (stable, unlike item ids).
	 *
	 * This is what lets the two columns balance. Both are the same width, so a card's
	 * height does not depend on which one it lands in: the split reads these heights, and
	 * moving a card between columns cannot change them. Measurement feeds the split and
	 * the split never feeds back, so it settles in one pass instead of oscillating.
	 */
	let cardHeights = $state<Record<string, number>>({});
	let cardSizes: ResizeObserver | undefined;

	function measureCard(node: HTMLElement, id: string) {
		node.dataset.controlId = id;
		cardSizes?.observe(node);
		return {
			destroy() {
				cardSizes?.unobserve(node);
			}
		};
	}

	onMount(() => {
		cardSizes = new ResizeObserver((entries) => {
			const next = { ...cardHeights };
			let moved = false;
			for (const entry of entries) {
				const id = (entry.target as HTMLElement).dataset.controlId;
				if (!id) continue;
				const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
				// Sub-pixel noise must not write state, or the observer answers its own write.
				if (Math.abs((next[id] ?? 0) - height) < 0.5) continue;
				next[id] = height;
				moved = true;
			}
			if (moved) cardHeights = next;
		});
		return () => cardSizes?.disconnect();
	});

	/**
	 * Where to cut a run into two columns: the contiguous split whose halves come closest
	 * to the same height. Until every card in the run has been measured (a section that
	 * has never been opened renders nothing to measure), it halves by count instead, which
	 * is what the first paint uses before the observer answers.
	 */
	function balancedSplit(run: PromptControl[]): number {
		const heights = run.map((control) => cardHeights[control.id]);
		if (heights.some((height) => height === undefined)) return Math.ceil(run.length / 2);
		const total = heights.reduce((sum, height) => sum + height, 0);
		let best = 1;
		let closest = Infinity;
		let above = 0;
		for (let cut = 1; cut < run.length; cut++) {
			above += heights[cut - 1];
			const gap = Math.abs(above - (total - above));
			if (gap < closest) {
				closest = gap;
				best = cut;
			}
		}
		return best;
	}

	/**
	 * One section's cards as the rows they are laid out in: a full-width card is its own
	 * row, and every run between two of them is a pair of real columns.
	 *
	 * The two columns hold CONTIGUOUS halves rather than alternating cards, which is what
	 * lets the pair collapse to one column below the breakpoint and still read in the
	 * author's order: the first column's cards simply stack on top of the second's.
	 */
	function rowsFor(controls: PromptControl[]): { wide?: PromptControl; columns?: PromptControl[][] }[] {
		const rows: { wide?: PromptControl; columns?: PromptControl[][] }[] = [];
		let run: PromptControl[] = [];
		const closeRun = () => {
			if (!run.length) return;
			const cut = balancedSplit(run);
			rows.push({ columns: [run.slice(0, cut), run.slice(cut)] });
			run = [];
		};
		for (const control of controls) {
			if (control.type === 'textarea') {
				closeRun();
				rows.push({ wide: control });
			} else {
				run.push(control);
			}
		}
		closeRun();
		return rows;
	}

	// Fold state is the reader's, not the preset's: the author's `collapsed` seeds it, and
	// from the first click it belongs to whoever is reading. Keyed by section id, and reset
	// when the preset changes so a fold never carries across to a different document.
	let openSections = $state<Set<string>>(new Set());
	let seededFor = $state<string | null>(null);

	$effect(() => {
		const id = activePreset?.id ?? null;
		if (id === seededFor) return;
		seededFor = id;
		openSections = new Set(sections.filter((s) => !s.collapsed).map((s) => s.id));
		descriptionExpanded = false;
	});

	// The description opens clamped to roughly the cover's own height (the line counts live
	// in the CSS, one per container step) and unfolds on request: a preset whose author
	// wrote three paragraphs should not push its controls off the screen on arrival.
	let descriptionEl = $state<HTMLParagraphElement | null>(null);
	let descriptionOverflows = $state(false);
	let descriptionExpanded = $state(false);

	$effect(() => {
		meta?.description; // re-measure when the text itself changes
		const el = descriptionEl;
		// Only ever measured while clamped: expanded, the box fits by definition, and
		// re-reading it there would hide the control that got the reader out of the fold.
		if (!el || descriptionExpanded) return;
		const measure = () => (descriptionOverflows = el.scrollHeight - el.clientHeight > 1);
		measure();
		// Width decides how many lines the text takes, so a resized panel re-measures.
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	});

	function toggleSection(id: string): void {
		const next = new Set(openSections);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		openSections = next;
	}

	// --- the baseline: the one configuration this page measures against -----------------

	let bundles = $derived(activePreset?.bundles ?? []);

	// The adopted setup is read by stored id, never by value-matching, which would flip the
	// row to "nothing applied" the moment one knob moves and leave reset meaning two
	// different things at once. An id naming no bundle (the author deleted the kit, possibly
	// only in a draft) derives to null: the defaults baseline takes over on screen while the
	// stored selection waits for the kit to come back.
	let selectedSetup = $derived(
		bundles.find((b) => b.id === presetControlsStore.appliedSetups[activePreset?.id ?? '']) ?? null
	);

	/** The raw baseline value for one control: the adopted setup's, where it names the
	 *  macro, else undefined, which `getControlValue` resolves to the author's default.
	 *  A captured value is never undefined itself, so the sentinel is unambiguous.
	 *  hasOwnProperty rather than `in`: "constructor" is a legal macro name. */
	function baselineRaw(control: PromptControl): unknown {
		if (selectedSetup && Object.prototype.hasOwnProperty.call(selectedSetup.values, control.macro)) {
			return selectedSetup.values[control.macro];
		}
		return undefined;
	}

	function isModified(control: PromptControl): boolean {
		return (
			JSON.stringify(getControlValue(control, values[control.macro])) !==
			JSON.stringify(getControlValue(control, baselineRaw(control)))
		);
	}

	let modifiedCount = $derived(activeControls.filter(isModified).length);

	function setControlValue(control: PromptControl, value: unknown): void {
		if (!activePreset) return;
		presetControlsStore.setValue(activePreset.id, control.macro, value);
	}

	/** Put one control back on the baseline: re-write the setup's value where it names the
	 *  macro, otherwise forget the stored value so the author's default takes over live. */
	function resetControl(control: PromptControl): void {
		if (!activePreset) return;
		const raw = baselineRaw(control);
		if (raw === undefined) presetControlsStore.clearValue(activePreset.id, control.macro);
		else presetControlsStore.setValue(activePreset.id, control.macro, raw);
	}

	// --- adopting a configuration --------------------------------------------------------
	// Clicking any chip means "become exactly this", so adopting always lands with zero
	// drift. Only this preset's macros are touched, and the write lands in this preset's
	// own bucket, so no other preset's knob moves because two authors picked one name.

	function adoptSetup(bundle: PromptPresetBundle): void {
		if (!activePreset) return;
		const writes: Record<string, unknown> = {};
		const clears: string[] = [];
		for (const control of activeControls) {
			if (Object.prototype.hasOwnProperty.call(bundle.values, control.macro)) {
				writes[control.macro] = bundle.values[control.macro];
			} else {
				// A control the setup predates: the configuration being adopted is "the
				// setup over the author's defaults", so the stray value goes too.
				clears.push(control.macro);
			}
		}
		presetControlsStore.applyValues(activePreset.id, writes, clears);
		presetControlsStore.setAppliedSetup(activePreset.id, bundle.id);
	}

	function adoptDefaults(): void {
		if (!activePreset) return;
		presetControlsStore.applyValues(activePreset.id, {}, activeControls.map((c) => c.macro));
		presetControlsStore.setAppliedSetup(activePreset.id, null);
	}

	function applyBundle(bundle: PromptPresetBundle): void {
		adoptSetup(bundle);
		toastStore.success(`Applied “${bundle.name}”`);
	}

	function applyDefaults(): void {
		adoptDefaults();
		toastStore.success("Back to the author's defaults");
	}

	/** Reset-all re-adopts whichever baseline is lit. It never changes what is lit. */
	function resetAll(): void {
		if (selectedSetup) {
			adoptSetup(selectedSetup);
			toastStore.success(`Back to “${selectedSetup.name}”`);
		} else {
			adoptDefaults();
			toastStore.success("Back to the author's defaults");
		}
	}

	// --- what the whole form costs -----------------------------------------------------

	let totalTokens = $derived(
		activeControls.reduce(
			(sum, c) => sum + countTokens(formatControlForPrompt(c, values[c.macro]), llmService.getPrimaryModel()),
			0
		)
	);

	function openPromptBuilder(): void {
		uiStore.settingsPage = 'prompt-builder';
		uiStore.openSettings();
	}

	// --- what else the preset installs ---------------------------------------------------
	// A preset can carry find & replace rules that rewrite the transcript and the outgoing
	// prompt, and until you open Settings → Regex nothing anywhere says so. This page is the
	// preset's face, so it is where that belongs, as a fact about the document, counted as
	// shipped rather than as running, because a reader who switched them all off already
	// knows and a reader who never looked would otherwise be told there is nothing here.
	let carriedRules = $derived(activePreset?.regexRules ?? []);
	let carriedToPrompt = $derived(carriedRules.filter((r) => r.scopes.includes('prompt')).length);

	let carriedLine = $derived.by(() => {
		const n = carriedRules.length;
		const opening = `This preset ships ${n} find & replace rule${n === 1 ? '' : 's'}`;
		if (carriedToPrompt === 0) return `${opening}. None of them change what is sent to the model.`;
		if (n === 1) return `${opening}, and it rewrites what is sent to the model.`;
		if (carriedToPrompt === n) return `${opening}, and all of them rewrite what is sent to the model.`;
		const some =
			carriedToPrompt === 1 ? 'one of them rewrites' : `${carriedToPrompt} of them rewrite`;
		return `${opening}, and ${some} what is sent to the model.`;
	});

	// The preset the open chat is built from, when that is not the one this panel names. Every
	// knob below then tunes a document that story is not built from, so the reader would be
	// shaping one preset while watching the replies of another, with nothing on screen to
	// say which one they are looking at.
	let storyPreset = $derived.by(() => {
		const running = chatPreset(chatStore.activeChat);
		return running && running.id !== activePreset?.id ? running : null;
	});

	function openRegexRules(): void {
		uiStore.gotoSettingsPage('regex');
		uiStore.openSettings();
	}

	// ===== preset switcher (the subtitle dropdown, mirroring Lorebook's book switcher) =====
	// Selection rides an inline switcher here so the header reads like the other overlays;
	// PresetManager (in the header's trailing slot) still owns every lifecycle action.
	let allPresets = $derived(presetService.getAllPresets());
	let activeId = $derived(presetService.getActivePresetId() ?? '');

	let presetMenuOpen = $state(false);
	let presetMenuRef = $state<HTMLDivElement | null>(null);

	async function pickPreset(presetId: string): Promise<void> {
		presetMenuOpen = false;
		if (!presetId || presetId === activeId) return;
		try {
			await presetService.activatePreset(presetId);
		} catch (err) {
			toastStore.failed('switch the preset', err);
		}
	}

	$effect(() => {
		if (!presetMenuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (presetMenuRef && !presetMenuRef.contains(e.target as Node)) presetMenuOpen = false;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				// Consume the press so it doesn't cascade into the workspace's global Escape.
				e.stopPropagation();
				presetMenuOpen = false;
			}
		};
		document.addEventListener('mousedown', onDown, true);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown, true);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<!-- One card, wherever a row puts it. The props are the same in both places, so they
     live here rather than twice in the row loop. -->
{#snippet field(control: PromptControl)}
	<div use:measureCard={control.id}>
		<CustomControlField
			{control}
			raw={values[control.macro]}
			baseline={baselineRaw(control)}
			onChange={(value) => setControlValue(control, value)}
			onReset={() => resetControl(control)}
		/>
	</div>
{/snippet}

<div class="pcv">
	<header class="overlay-header overlay-header--stacked">
		<h2 class="overlay-title">Preset Controls</h2>
		<div class="overlay-crumb">
			<!-- The switcher and the actions menu sit together on the subject line: the
			     menu acts on the preset the switcher names. -->
			{#if activePreset}
				<div class="pcv-switcher" bind:this={presetMenuRef}>
					<button
						type="button"
						class="overlay-switch"
						onclick={() => (presetMenuOpen = !presetMenuOpen)}
						aria-haspopup="menu"
						aria-expanded={presetMenuOpen}
						title="Switch preset"
					>
						<span class="overlay-subject">{activePreset.name}</span>
						<Icon name="chevronDown" class="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
					</button>
					{#if presetMenuOpen}
						<div class="pcv-switch-pop" role="menu">
							{#each allPresets as preset (preset.id)}
								<button
									type="button"
									role="menuitemradio"
									aria-checked={preset.id === activeId}
									class="pcv-switch-item"
									class:is-open={preset.id === activeId}
									onclick={() => pickPreset(preset.id)}
								>
									<span class="pcv-switch-item-name">{preset.name}</span>
									{#if presetService.hasDraft(preset.id)}<span class="pcv-switch-draft">Draft</span>{/if}
									{#if preset.id === activeId}<Icon name="check" class="w-3.5 h-3.5 flex-shrink-0" />{/if}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{:else}
				<span class="overlay-facts">No preset active</span>
			{/if}
			<PresetManager
				id="controls-preset-select"
				compact
				showSelect={false}
				showEdit
				onEdit={openPromptBuilder}
			/>
		</div>
	</header>

	<main class="pcv-body panel-scroll">
		{#if !activePreset}
			<div class="pcv-blank">
				<EmptyState icon="sliders" size="sm" title="No presets yet">
					A preset carries the prompt this chat is built from, and the controls its
					author exposed. Import one from the actions menu in this panel's header.
				</EmptyState>
			</div>
		{:else}
			<div class="pcv-sheet">
				{#if storyPreset}
					<ChatOverrideNotice
						subject="the active preset"
						using={storyPreset.name}
						instead={activePreset.name}
					/>
				{/if}

				<!-- The preset's own face. Shown whenever it has one; a preset that says
				     nothing about itself skips straight to its controls. -->
				{#if coverUrl || meta?.author || meta?.version || meta?.description || meta?.writtenFor}
					<!-- Cover at full height on the left, everything the preset says about
					     itself in one column beside it: title line, then the one-liner, then
					     the author's paragraph. -->
					<section class="pcv-identity">
						{#if coverUrl}
							<img class="pcv-cover" src={coverUrl} alt="" />
						{/if}
						<div class="pcv-identity-text">
							<h3 class="pcv-name">
								{activePreset.name}{#if meta?.version}<span class="pcv-version">v{meta.version}</span>{/if}{#if meta?.author}<span class="pcv-author">by {meta.author}</span>{/if}
							</h3>
							{#if meta?.description}
								<p
									class="pcv-description"
									class:is-open={descriptionExpanded}
									bind:this={descriptionEl}
								>{meta.description}</p>
								{#if descriptionOverflows}
									<button
										type="button"
										class="pcv-more"
										aria-expanded={descriptionExpanded}
										onclick={() => (descriptionExpanded = !descriptionExpanded)}
									>
										{descriptionExpanded ? 'Show less' : 'Read more'}
									</button>
								{/if}
							{/if}
							{#if meta?.writtenFor}
								<p class="pcv-written-for">
									<Icon name="info" class="w-3.5 h-3.5 flex-shrink-0" strokeWidth={1.5} />
									<span>{meta.writtenFor}</span>
								</p>
							{/if}
						</div>
					</section>
				{/if}

				<!-- Above the controls, not among them: this is something the preset does to
				     every chat whether or not it exposes a single knob. -->
				{#if carriedRules.length > 0}
					<div class="pcv-carried">
						<Icon name="filter" class="w-3.5 h-3.5 flex-shrink-0" strokeWidth={1.5} />
						<span class="pcv-carried-text">{carriedLine}</span>
						<button type="button" class="pcv-carried-link" onclick={openRegexRules}>See them</button>
					</div>
				{/if}

				{#if activeControls.length === 0}
					<!-- Empty state: say what the feature is and where controls come from. -->
					<div class="pcv-intro">
						<EmptyState icon="sliders" size="sm" title="“{activePreset.name}” has no controls yet">
							Controls are knobs a preset author wires to macros inside the prompt. Once they
							exist, you shape generation from here with a flick, no prompt editing needed.
						</EmptyState>
						<p class="pcv-intro-note">
							Craft them in the Prompt Builder under “Preset controls”, then watch this page become a form.
						</p>
					</div>
				{:else}
					<!-- The baseline picker: the author's configurations, exactly one lit. Which
					     one is lit is the reader's stored choice, not a value-match: a chip
					     with drift below it stays lit, because it is still what Reset returns
					     to. Clicking any chip adopts that configuration wholesale. -->
					{#if bundles.length > 0}
						<section class="pcv-kits">
							<div class="pcv-kits-head">
								<Icon name="sparkles" class="w-3.5 h-3.5 flex-shrink-0" strokeWidth={1.5} />
								<span class="pcv-kits-title">The author's setups</span>
							</div>
							<!-- Equal cells, not content-sized chips: a row that sizes itself to its
							     text puts a stubby box beside a wide one and wraps into a ragged
							     grid the moment there are three. Every card carries the same
							     anatomy (mark, name, one line of why), so the only thing that
							     varies between them is what they say. -->
							<div class="pcv-kits-grid" role="radiogroup" aria-label="Starting configuration">
								<!-- The defaults are a configuration the author built too, so they
								     take a card like the rest and the picker is complete: there is
								     always a way back out of a setup. -->
								<button
									type="button"
									role="radio"
									class="pcv-kit"
									class:is-applied={!selectedSetup}
									aria-checked={!selectedSetup}
									onclick={applyDefaults}
								>
									<span class="pcv-kit-mark">
										{#if !selectedSetup}<Icon name="check" class="w-3 h-3" strokeWidth={2.5} />{/if}
									</span>
									<span class="pcv-kit-name">Defaults</span>
									<span class="pcv-kit-note">Every control exactly as the author made it.</span>
								</button>
								{#each bundles as bundle (bundle.id)}
									{@const applied = selectedSetup?.id === bundle.id}
									<button
										type="button"
										role="radio"
										class="pcv-kit"
										class:is-applied={applied}
										aria-checked={applied}
										onclick={() => applyBundle(bundle)}
									>
										<span class="pcv-kit-mark">
											{#if applied}<Icon name="check" class="w-3 h-3" strokeWidth={2.5} />{/if}
										</span>
										<span class="pcv-kit-name">{bundle.name}</span>
										{#if bundle.description}<span class="pcv-kit-note">{bundle.description}</span>{/if}
									</button>
								{/each}
							</div>
						</section>
					{/if}

					<!-- The reader's own status line: how far from the lit baseline they have
					     wandered, what the whole form costs, and the one way back. -->
					<div class="pcv-status">
						{#if modifiedCount > 0}
							<span class="pcv-status-dot"></span>
							<span class="pcv-status-text">
								{modifiedCount} control{modifiedCount === 1 ? '' : 's'} changed from {selectedSetup ? `“${selectedSetup.name}”` : "the author's defaults"}
							</span>
							<button type="button" class="pcv-status-reset" onclick={resetAll}>Reset all</button>
						{:else}
							<span class="pcv-status-text pcv-status-text--calm">
								{selectedSetup ? `Every control matches “${selectedSetup.name}”` : "Every control is on the author's defaults"}
							</span>
						{/if}
						<span class="pcv-status-spacer"></span>
						{#if totalTokens > 0}
							<span class="pcv-status-cost" title="What the whole form adds to every prompt">
								{totalTokens.toLocaleString()} tokens
							</span>
						{/if}
					</div>

					{#each sections as section (section.id)}
						{@const open = openSections.has(section.id)}
						<section class="pcv-group">
							{#if section.title}
								<button
									type="button"
									class="pcv-group-head"
									aria-expanded={open}
									onclick={() => toggleSection(section.id)}
								>
									<Icon name="chevronRight" class="w-3.5 h-3.5 pcv-group-chevron {open ? 'is-open' : ''}" />
									{#if isSectionIcon(section.icon)}
										<Icon name={section.icon} class="w-3.5 h-3.5 flex-shrink-0" strokeWidth={1.5} />
									{/if}
									<span class="pcv-group-title">{section.title}</span>
									<span class="pcv-group-rule"></span>
									{#if !open}
										<span class="pcv-group-count">{section.controls.length}</span>
									{/if}
								</button>
								{#if section.description && open}
									<p class="pcv-group-note">{section.description}</p>
								{/if}
							{/if}
							{#if open || !section.title}
								<div class="pcv-grid">
									{#each rowsFor(section.controls) as row, index (index)}
										{#if row.wide}
											{@render field(row.wide)}
										{:else}
											<div class="pcv-columns">
												{#each row.columns ?? [] as column, side (side)}
													<div class="pcv-column">
														{#each column as control (control.id)}
															{@render field(control)}
														{/each}
													</div>
												{/each}
											</div>
										{/if}
									{/each}
								</div>
							{/if}
						</section>
					{/each}

				{/if}
			</div>
		{/if}
	</main>
</div>

<style>
	/* The page measures its own column (chat-width overlay, or a phone screen). */
	.pcv {
		container-type: inline-size;
		container-name: pcv;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}

	/* Preset switcher: the subject dropdown (mirrors the Lorebook book switcher).
	   The button itself is the shared .overlay-switch recipe. */
	.pcv-switcher {
		position: relative;
		min-width: 0;
	}

	/* Anchored to the switch's own left edge. */
	.pcv-switch-pop {
		position: absolute;
		top: calc(100% + 0.375rem);
		left: 0;
		z-index: 45;
		width: min(17rem, calc(100cqw - 1.5rem));
		max-height: 18rem;
		overflow-y: auto;
		padding: 0.25rem;
		background: var(--color-float-bg);
		backdrop-filter: var(--backdrop-blur) saturate(140%);
		-webkit-backdrop-filter: var(--backdrop-blur) saturate(140%);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
	}

	.pcv-switch-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.45rem 0.65rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-primary);
		text-align: left;
		cursor: pointer;
		transition: background-color 140ms ease;
	}

	.pcv-switch-item:hover {
		background: var(--color-bg-tertiary);
	}

	.pcv-switch-item.is-open {
		background: color-mix(in srgb, var(--color-accent) 11%, transparent);
		color: var(--color-accent);
	}

	.pcv-switch-item-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 500;
	}

	.pcv-switch-draft {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
	}

	/* ---- Body ---- */
	.pcv-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.pcv-sheet {
		width: 100%;
		max-width: 68rem;
		margin: 0 auto;
		padding: 1rem 0.9rem 2.5rem;
		display: flex;
		flex-direction: column;
		gap: 1.6rem;
	}

	@container pcv (min-width: 640px) {
		.pcv-sheet {
			padding: 1.75rem 2rem 3rem;
		}
	}

	@container pcv (min-width: 960px) {
		.pcv-sheet {
			padding: 2.25rem 2.75rem 3.5rem;
		}
	}

	/* ---- The preset's face ----
	   One row: cover, then a single column holding everything the preset says about itself.
	   Aligned to the top rather than centred: the column is the thing that grows, and a
	   centred cover would drift away from the title it belongs to as the paragraph runs on. */
	.pcv-identity {
		display: flex;
		align-items: flex-start;
		gap: 1.15rem;
		min-width: 0;
	}

	/* A book cover, not an avatar: 3:4 portrait, and big enough to be the first thing the
	   eye lands on. The ratio is fixed here and matched by the card writer (presetCard.ts
	   COVER_WIDTH/HEIGHT), so what a reader sees is what a reader gets when they export. */
	/* A book cover, not an avatar: 3:4 portrait, and big enough to be the first thing the
	   eye lands on. The ratio is fixed here and matched by the card writer (presetCard.ts
	   COVER_WIDTH/HEIGHT), so what a reader sees is what a reader gets when they export. */
	.pcv-cover {
		flex-shrink: 0;
		width: 6rem;
		aspect-ratio: 3 / 4;
		object-fit: cover;
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border-subtle);
		box-shadow: var(--shadow-md);
	}

	@container pcv (min-width: 640px) {
		.pcv-cover {
			width: 8.5rem;
		}
	}

	@container pcv (min-width: 960px) {
		.pcv-cover {
			width: 10rem;
		}
	}

	.pcv-identity-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	/* Name, version and byline are one title line: they are all answers to "what am I
	   holding", so they read as a run rather than three stacked labels. */
	.pcv-name {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 1.25rem;
		font-weight: 700;
		line-height: 1.25;
		color: var(--color-text-primary);
		text-wrap: balance;
	}

	.pcv-version,
	.pcv-author {
		margin-left: 0.55rem;
		font-size: 0.74rem;
		font-weight: 500;
		white-space: nowrap;
		color: var(--color-text-muted);
	}

	.pcv-version {
		font-variant-numeric: tabular-nums;
	}

	/* Clamped to about where the cover ends, so the page opens on the controls rather than
	   on somebody's three paragraphs. The line counts are tuned per container step against
	   the cover's own height (width × 4/3) minus the title line and this toggle. */
	.pcv-description {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.85rem;
		line-height: 1.6;
		white-space: pre-line;
		color: var(--color-text-secondary);
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		overflow: hidden;
	}

	.pcv-description.is-open {
		display: block;
		overflow: visible;
	}

	.pcv-more {
		align-self: flex-start;
		margin-top: -0.15rem;
		padding: 0;
		border: 0;
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		color: var(--color-text-muted);
		text-decoration: underline;
		text-underline-offset: 0.18em;
		cursor: pointer;
		transition: color 140ms ease;
	}

	.pcv-more:hover {
		color: var(--color-accent);
	}

	.pcv-written-for {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		margin: 0.1rem 0 0;
		padding: 0.5rem 0.7rem;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	/* The title has to hold its own beside a full-height cover. */
	@container pcv (min-width: 640px) {
		.pcv-name {
			font-size: 1.5rem;
		}

		.pcv-version,
		.pcv-author {
			font-size: 0.78rem;
		}

		.pcv-description {
			font-size: 0.9rem;
			-webkit-line-clamp: 5;
			line-clamp: 5;
		}
	}

	@container pcv (min-width: 960px) {
		.pcv-description {
			-webkit-line-clamp: 6;
			line-clamp: 6;
		}
	}

	/* ---- What else the preset installs ---- */
	.pcv-carried {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.55rem 0.75rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-secondary) 55%, transparent);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-muted);
	}

	.pcv-carried-text {
		flex: 1;
		min-width: 0;
		line-height: 1.45;
	}

	.pcv-carried-link {
		flex-shrink: 0;
		padding: 0;
		border: 0;
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		color: var(--color-text-muted);
		text-decoration: underline;
		text-underline-offset: 0.18em;
		cursor: pointer;
		transition: color 140ms ease;
	}

	.pcv-carried-link:hover {
		color: var(--color-accent);
	}

	/* ---- Kits ---- */
	.pcv-kits {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.pcv-kits-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--color-text-muted);
	}

	.pcv-kits-title {
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	/* Equal columns that reflow by their own width, and stretched rows, so three setups of
	   very different name and blurb lengths still read as one set of siblings. */
	.pcv-kits-grid {
		display: grid;
		/* min() guards the narrow end: a bare 15rem floor would overflow a panel narrower
		   than one card instead of collapsing to a single full-width column. */
		grid-template-columns: repeat(auto-fit, minmax(min(15rem, 100%), 1fr));
		align-items: stretch;
		gap: 0.6rem;
	}

	/* Mark in its own fixed column, name and blurb in the second: the mark's slot is held
	   whether or not it is filled, so picking a card never shifts a word of its text. */
	.pcv-kit {
		display: grid;
		grid-template-columns: auto 1fr;
		align-content: start;
		gap: 0.2rem 0.6rem;
		min-width: 0;
		padding: 0.75rem 0.9rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 80%, transparent);
		color: var(--color-text-primary);
		text-align: left;
		cursor: pointer;
		transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
	}

	.pcv-kit:hover {
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
	}

	.pcv-kit.is-applied {
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		color: var(--color-accent);
	}

	/* A single choice, so the mark is a radio that happens to fill with a tick. */
	.pcv-kit-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.05rem;
		height: 1.05rem;
		margin-top: 0.05rem;
		border: 1px solid var(--color-border);
		border-radius: 9999px;
		color: var(--color-on-accent);
		transition: background-color 140ms ease, border-color 140ms ease;
	}

	.pcv-kit.is-applied .pcv-kit-mark {
		border-color: var(--color-accent);
		background: var(--color-accent);
	}

	.pcv-kit-name {
		min-width: 0;
		font-family: var(--font-ui);
		font-size: 0.85rem;
		font-weight: 600;
		line-height: 1.3;
	}

	/* Second column, second row: the blurb hangs under the name rather than under the
	   mark, so a wrapped line stays inside the same text block. */
	.pcv-kit-note {
		grid-column: 2;
		min-width: 0;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	/* ---- Reader status ---- */
	.pcv-status {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-secondary) 55%, transparent);
		font-family: var(--font-ui);
		font-size: 0.72rem;
	}

	.pcv-status-dot {
		flex-shrink: 0;
		width: 0.38rem;
		height: 0.38rem;
		border-radius: 9999px;
		background: var(--color-accent);
	}

	.pcv-status-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-secondary);
	}

	.pcv-status-text--calm {
		color: var(--color-text-muted);
	}

	.pcv-status-reset {
		flex-shrink: 0;
		padding: 0;
		border: 0;
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-muted);
		text-decoration: underline;
		text-underline-offset: 0.18em;
		cursor: pointer;
		transition: color 140ms ease;
	}

	.pcv-status-reset:hover {
		color: var(--color-accent);
	}

	.pcv-status-spacer {
		flex: 1 1 0;
		min-width: 0.25rem;
	}

	.pcv-status-cost {
		flex-shrink: 0;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		cursor: help;
	}

	/* ---- Sections ---- */
	.pcv-group {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.pcv-group-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: color 140ms ease;
	}

	.pcv-group-head:hover {
		color: var(--color-text-primary);
	}

	/* Global: the class rides on the Icon component's own root, out of this scope. */
	.pcv-group-head :global(.pcv-group-chevron) {
		flex-shrink: 0;
		transition: transform 160ms ease;
	}

	.pcv-group-head :global(.pcv-group-chevron.is-open) {
		transform: rotate(90deg);
	}

	.pcv-group-title {
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		white-space: nowrap;
	}

	.pcv-group-rule {
		flex: 1;
		border-top: 1px solid var(--color-border-subtle);
	}

	.pcv-group-count {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.pcv-group-note {
		margin: -0.4rem 0 0;
		padding-left: 1.4rem;
		font-family: var(--font-ui);
		font-size: 0.76rem;
		line-height: 1.5;
		color: var(--color-text-muted);
	}

	/* A stack of rows: a full-width card, or a pair of columns. Two REAL columns rather
	   than CSS multi-column, which this was and which Firefox lays out wrong here: it
	   measures a flex box inside a fragmented column against the wrong width and never
	   re-measures, so a card at a column's head reports a height that leaves out its own
	   help text and everything below it lands on top of that text. `break-inside` cannot
	   help, since nothing is being split; the box is simply measured once, wrongly.
	   Real columns cannot be fragmented at all, so there is no measure pass to get wrong. */
	.pcv-grid {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	/* Below the breakpoint this is one grid column and the two halves stack. That is why
	   `rowsFor` splits them contiguously rather than alternating: stacked, they read back
	   in the author's order. */
	.pcv-columns {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.9rem 1rem;
	}

	.pcv-column {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		/* Or a long unbroken option label stretches its column past its share. */
		min-width: 0;
	}

	@container pcv (min-width: 700px) {
		.pcv-grid,
		.pcv-columns,
		.pcv-column {
			gap: 1rem;
		}

		.pcv-columns {
			grid-template-columns: 1fr 1fr;
		}
	}

	/* ---- Empty states ---- */
	.pcv-blank,
	.pcv-intro {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.6rem;
		margin: auto;
		max-width: 30rem;
		padding: 2rem 1.25rem;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
	}

	.pcv-blank {
		color: var(--color-text-muted);
	}


	.pcv-intro p {
		margin: 0;
		font-size: 0.88rem;
		line-height: 1.5;
	}

	.pcv-intro-note {
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}
</style>
