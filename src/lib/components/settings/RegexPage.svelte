<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { holdMsForBlast } from '$lib/components/ui/HoldToConfirmButton.svelte';
	import RegexRuleEditor from '$lib/components/regex/RegexRuleEditor.svelte';
	import RegexRoutingIcons from '$lib/components/regex/RegexRoutingIcons.svelte';
	import { dragHandleZone, dragHandle, type DndEvent } from 'svelte-dnd-action';
	import { regexRulesStore } from '$lib/stores/regex-rules.svelte';
	import { presetService } from '$lib/services/presets.svelte';
	import { chatPresetStore } from '$lib/stores/chatPreset.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import {
		isRuleInert,
		parseRegexRulesImport,
		regexRuleError,
		routingSentence,
		serializeRegexRules,
		REGEX_TESTER_SEED,
		type RegexRule
	} from '$lib/utils/regex-rules';

	const flipDurationMs = 160;

	// Local list the drag zone reorders; synced with the store between drags.
	// Seeded synchronously (the store loads during boot) so the empty state
	// never flashes before the first $effect run.
	let list = $state<RegexRule[]>([...regexRulesStore.rules]);
	$effect(() => {
		list = [...regexRulesStore.rules];
	});

	let activeCount = $derived(regexRulesStore.rules.filter((r) => r.enabled).length);

	// The active preset's own rules, listed but never edited (see the markup's note). The
	// count reads switches, exactly like the own list's above it; a rule that is on but
	// broken or inert says so on its own row rather than being quietly subtracted here.
	let carried = $derived(regexRulesStore.carried);
	let carriedFrom = $derived(chatPresetStore.resolvedPreset?.name ?? 'the active preset');
	let carriedActive = $derived(carried.filter((r) => regexRulesStore.carriedEnabled(r)).length);

	// One rule's editor open at a time, so the tab reads as a list, not a wall of forms. The
	// two groups keep their own, so opening a preset's rule to read it doesn't close the
	// one you were writing.
	let expandedId = $state<string | null>(null);
	let expandedCarriedId = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | undefined>(undefined);
	let confirmRestore = $state(false);

	// The live tester's sample, shared across rules so a phrase you're tuning
	// against survives switching between them. Seeded so every shipped default
	// rule has something to light up out of the box.
	let sampleText = $state(REGEX_TESTER_SEED);

	// The story's own last reply, offered to the tester as a one-click sample: a synthetic
	// seed proves a pattern compiles, real output proves it does what was meant. Undefined
	// with no chat open, which is what hides the button rather than showing a dead one.
	let lastReply = $derived(
		[...(chatStore.currentChatState?.activePath ?? [])]
			.reverse()
			.find((m) => m.role === 'assistant' && m.content.trim())?.content
	);

	/** Take a carried rule into the reader's own list, and stand the preset's copy down so
	 *  the same rewrite cannot run twice. The copy is a new row: fresh id, and it starts at
	 *  the state the reader had it in rather than the state the author shipped. */
	function copyCarried(rule: RegexRule): void {
		const { id: _presetId, ...source } = rule;
		const copy = regexRulesStore.addRule({
			...source,
			enabled: regexRulesStore.carriedEnabled(rule),
			targets: [...rule.targets],
			scopes: [...rule.scopes]
		});
		regexRulesStore.setCarriedEnabled(rule, false);
		expandedCarriedId = null;
		expandedId = copy.id;
		toastStore.success(`Copied “${rule.name}” to your rules`);
	}

	function handleAdd(): void {
		const rule = regexRulesStore.addRule();
		expandedId = rule.id;
	}

	function handleDuplicate(rule: RegexRule): void {
		const copy = regexRulesStore.duplicateRule(rule.id);
		if (copy) expandedId = copy.id;
	}

	// The gate: a rule is a crafted pattern, not a line to retype, so deleting one asks
	// once in a dialog naming it (the destructive-act ladder,
	// architecture/ui-shell-settings.md). Deletion is immediate and final once confirmed.
	let deleteTarget = $state<RegexRule | null>(null);

	function confirmDelete(): void {
		const rule = deleteTarget;
		deleteTarget = null;
		if (!rule) return;
		if (expandedId === rule.id) expandedId = null;
		regexRulesStore.removeRule(rule.id);
	}

	// Restoring over an existing list wipes it, so confirm first. From an empty
	// list there's nothing to lose, so the starter pack comes straight back.
	function handleRestore(): void {
		if (regexRulesStore.rules.length === 0) restoreDefaults();
		else confirmRestore = true;
	}

	function restoreDefaults(): void {
		confirmRestore = false;
		expandedId = null;
		regexRulesStore.restoreDefaults();
	}

	function consider(e: CustomEvent<DndEvent<RegexRule>>): void {
		list = e.detail.items;
	}

	function finalize(e: CustomEvent<DndEvent<RegexRule>>): void {
		list = e.detail.items;
		regexRulesStore.reorder(list.map((r) => r.id));
	}

	function openImport(): void {
		fileInput?.click();
	}

	function download(json: string, filename: string): void {
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	function safeFilename(name: string): string {
		return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'regex-rule';
	}

	function exportAll(): void {
		download(serializeRegexRules(regexRulesStore.rules), 'regex-rules.json');
	}

	function exportOne(rule: RegexRule): void {
		download(serializeRegexRules([rule]), `${safeFilename(rule.name)}.json`);
	}

	async function importFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		try {
			if (file.size > 2 * 1024 * 1024) throw new Error('Rule files must be smaller than 2 MB.');
			const imported = parseRegexRulesImport(await file.text());
			regexRulesStore.importRules(imported);
			toastStore.success(`Imported ${imported.length} rule${imported.length === 1 ? '' : 's'}`);
		} catch (e) {
			toastStore.failed('import those rules', e);
		}
	}
</script>

<input
	bind:this={fileInput}
	type="file"
	accept=".json,application/json"
	class="hidden"
	onchange={importFile}
/>

<section class="card rx-card space-y-3" data-setting="regex-rules">
	<header class="rx-header">
		<div class="rx-title">
			<span class="card-title">Regex Rules</span>
			<InfoTip
				text="The saved messages are never modified, so switching a rule off restores the original text instantly. SillyTavern regex scripts import directly."
			/>
			{#if list.length > 0}
				<span class="rx-count" title="Enabled rules">{activeCount}/{list.length} on</span>
			{/if}
		</div>
		<div class="rx-tools">
			<button type="button" class="rx-btn" onclick={handleRestore} title="Replace the current rules with the shipped starter pack">
				<Icon name="refresh" class="w-3.5 h-3.5" />
				<span class="rx-btn-label">Restore defaults</span>
			</button>
			<button type="button" class="rx-btn" onclick={openImport} title="Import rules or SillyTavern regex scripts">
				<Icon name="upload" class="w-3.5 h-3.5" />
				<span class="rx-btn-label">Import</span>
			</button>
			<button type="button" class="rx-btn" onclick={exportAll} disabled={list.length === 0} title="Download every rule as JSON">
				<Icon name="download" class="w-3.5 h-3.5" />
				<span class="rx-btn-label">Export</span>
			</button>
			<button type="button" class="rx-btn rx-btn-primary" onclick={handleAdd}>
				<Icon name="plus" class="w-3.5 h-3.5" />
				<span class="rx-btn-label">New rule</span>
			</button>
		</div>
	</header>

	{#if list.length === 0}
		<div class="rx-empty">
			<EmptyState icon="filter" size="sm" title="No rules yet">
				Find & replace over chat text as it flows: what you read, what the model reads, or both.
				The saved messages are never touched.
				{#snippet actions()}
					<button type="button" class="rx-btn rx-btn-primary" onclick={handleAdd}>
						<Icon name="plus" class="w-3.5 h-3.5" />
						New rule
					</button>
					<button type="button" class="rx-btn" onclick={openImport}>
						<Icon name="upload" class="w-3.5 h-3.5" />
						Import
					</button>
					<button type="button" class="rx-btn" onclick={handleRestore}>
						<Icon name="refresh" class="w-3.5 h-3.5" />
						Restore defaults
					</button>
				{/snippet}
			</EmptyState>
			<p class="rx-empty-hint">SillyTavern regex scripts import as-is.</p>
		</div>
	{:else}
		<div
			class="rx-list"
			use:dragHandleZone={{ items: list, type: 'regex-rules', flipDurationMs, dropTargetStyle: {} }}
			onconsider={consider}
			onfinalize={finalize}
		>
			{#each list as rule (rule.id)}
				{@const error = regexRuleError(rule)}
				{@const inert = isRuleInert(rule)}
				{@const expanded = expandedId === rule.id}
				<div class="rx-rule" class:rx-rule-open={expanded} class:rx-rule-off={!rule.enabled}>
					<div class="rx-row">
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span class="rx-grip" use:dragHandle aria-label="Drag to reorder" title="Drag to reorder">
							<Icon name="menu" class="w-4 h-4" strokeWidth={1.5} />
						</span>
						<Toggle
							checked={rule.enabled}
							label="Enable {rule.name}"
							onchange={(on) => regexRulesStore.updateRule(rule.id, { enabled: on })}
						/>
						<button
							type="button"
							class="rx-rule-main"
							onclick={() => (expandedId = expanded ? null : rule.id)}
							aria-expanded={expanded}
						>
							<span class="rx-rule-text">
								<span class="rx-rule-name">
									<span class="rx-name-text">{rule.name}</span>
									{#if error}
										<span class="rx-pill rx-pill-error" title={error}>
											<Icon name="warning" class="w-3 h-3" />
											invalid
										</span>
									{:else if inert}
										<span class="rx-pill rx-pill-warn" title={routingSentence(rule)}>
											inert
										</span>
									{/if}
								</span>
								{#if rule.description}
									<span class="rx-rule-desc" title={rule.description}>{rule.description}</span>
								{/if}
							</span>
							{#if !inert}
								<RegexRoutingIcons {rule} />
							{/if}
							<Icon name="chevronDown" class="w-4 h-4 rx-chevron" />
						</button>
					</div>

					{#if expanded}
						<div class="rx-editor-shell">
							<RegexRuleEditor
								{rule}
								onPatch={(patch) => regexRulesStore.updateRule(rule.id, patch)}
								bind:sampleText
								{lastReply}
							>
								{#snippet footer()}
									<div class="rx-foot-group">
										<button type="button" class="rx-btn" onclick={() => handleDuplicate(rule)}>
											<Icon name="copy" class="w-3.5 h-3.5" />
											Duplicate
										</button>
										<button type="button" class="rx-btn" onclick={() => exportOne(rule)} title="Download this rule as JSON">
											<Icon name="download" class="w-3.5 h-3.5" />
											Export
										</button>
									</div>
									<button type="button" class="rx-btn rx-btn-danger" onclick={() => (deleteTarget = rule)}>
										<Icon name="trash" class="w-3.5 h-3.5" />
										Delete
									</button>
								{/snippet}
							</RegexRuleEditor>
						</div>
					{/if}
				</div>
			{/each}
		</div>
		{#if list.length > 1}
			<p class="rx-order-note">
				Rules run top to bottom, and each one sees the previous one's output.
			</p>
		{/if}
	{/if}

	<!-- Rules the active preset brought with it. They run after everything above and the
	     rules themselves stay the author's: an edited copy would no longer be the preset's,
	     and the next preset update would silently disagree with it. The switch is the
	     reader's, and it is stored as a deviation from what the author shipped, so a rule
	     nobody touched keeps following the preset. -->
	{#if carried.length > 0}
		<div class="rx-carried">
			<div class="rx-carried-head">
				<Icon name="sliders" class="w-3.5 h-3.5 flex-shrink-0" strokeWidth={1.5} />
				<span class="rx-carried-title">From “{carriedFrom}”</span>
				<InfoTip
					text="These belong to the active preset, not to you. They run after your own rules and leave when you switch presets. Switch one off and it stays off for you; the rule itself is the author's, so copy it to change it."
				/>
				<span class="rx-carried-count">{carriedActive}/{carried.length} on</span>
			</div>
			<div class="rx-carried-list">
				{#each carried as rule (rule.id)}
					{@const on = regexRulesStore.carriedEnabled(rule)}
					{@const error = regexRuleError(rule)}
					{@const open = expandedCarriedId === rule.id}
					<div class="rx-carried-rule" class:is-off={!on} class:is-open={open}>
						<div class="rx-carried-row">
							<Toggle
								checked={on}
								label="Enable {rule.name}"
								onchange={(next) => regexRulesStore.setCarriedEnabled(rule, next)}
							/>
							<button
								type="button"
								class="rx-carried-main"
								onclick={() => (expandedCarriedId = open ? null : rule.id)}
								aria-expanded={open}
							>
								<span class="rx-carried-text">
									<span class="rx-carried-name">{rule.name}</span>
									{#if rule.description}
										<span class="rx-rule-desc">{rule.description}</span>
									{/if}
								</span>
								{#if error}
									<span class="rx-pill rx-pill-error" title={error}>
										<Icon name="warning" class="w-3 h-3" />
										invalid
									</span>
								{:else if isRuleInert(rule)}
									<span class="rx-pill rx-pill-warn" title={routingSentence(rule)}>
										inert
									</span>
								{:else}
									<RegexRoutingIcons {rule} />
								{/if}
								<Icon name="chevronDown" class="w-4 h-4 rx-chevron" />
							</button>
						</div>

						<!-- Read, don't edit. The fields are frozen because the rule is the
						     author's, but the tester runs, which is the half that answers what a
						     stranger's find & replace actually does to your story. -->
						{#if open}
							<div class="rx-editor-shell">
								<RegexRuleEditor {rule} bind:sampleText {lastReply}>
									{#snippet footer()}
										<p class="rx-carried-note">
											This rule is the author's. A copy becomes yours to edit, and the
											preset's own switches off so the two cannot both run.
										</p>
										<button type="button" class="rx-btn" onclick={() => copyCarried(rule)}>
											<Icon name="copy" class="w-3.5 h-3.5" />
											Copy to my rules
										</button>
									{/snippet}
								</RegexRuleEditor>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</section>

<ConfirmDialog
	open={confirmRestore}
	title="Restore default rules"
	message={`Replace all ${list.length} rule${list.length === 1 ? '' : 's'} with the shipped starter pack? Every one goes, including rules you created. Export first if you might want them back.`}
	confirmLabel="Restore defaults"
	variant="danger"
	destructive
	holdMs={holdMsForBlast(list.length)}
	onConfirm={restoreDefaults}
	onCancel={() => (confirmRestore = false)}
/>

<ConfirmDialog
	open={deleteTarget !== null}
	title="Delete rule"
	message={`Delete "${deleteTarget?.name}"? This cannot be undone. Export it first if you might want it back.`}
	confirmLabel="Delete"
	variant="danger"
	destructive
	onConfirm={confirmDelete}
	onCancel={() => (deleteTarget = null)}
/>

<style>
	/* The panel hosting this tab ranges from a ~220px dock margin to a ~1250px
	   overlay independent of the viewport, so every layout switch below queries
	   the card's own width. */
	.rx-card {
		container-type: inline-size;
	}

	/* --- Rules the active preset carries --- */

	.rx-carried {
		margin-top: 0.25rem;
		padding-top: 0.75rem;
		border-top: 1px dashed var(--color-border-subtle);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.rx-carried-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
		color: var(--color-text-muted);
	}

	.rx-carried-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.rx-carried-count {
		margin-left: auto;
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-variant-numeric: tabular-nums;
	}

	.rx-carried-list {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.rx-carried-rule {
		border-radius: var(--radius-md);
		transition: background-color 120ms ease;
	}

	.rx-carried-rule:hover:not(.is-open) {
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
	}

	.rx-carried-rule.is-open {
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, var(--color-border-subtle));
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
	}

	.rx-carried-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.35rem 0.5rem;
	}

	/* Only the row dims, never the panel under it: a switched-off rule is still one you
	   opened to read. */
	.rx-carried-rule.is-off .rx-carried-row {
		opacity: 0.5;
	}

	.rx-carried-main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
	}

	.rx-carried-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.14rem;
	}

	.rx-carried-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-text-secondary);
	}

	.rx-carried-main :global(.rx-chevron) {
		flex-shrink: 0;
		color: var(--color-text-muted);
		transition: transform 160ms ease;
	}

	.rx-carried-rule.is-open .rx-carried-main :global(.rx-chevron) {
		transform: rotate(180deg);
	}

	/* Sits opposite the copy button in the read-only footer, so the one action there arrives
	   with the sentence that says what it costs. */
	.rx-carried-note {
		flex: 1;
		min-width: 12rem;
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	/* --- Header --- */

	.rx-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.rx-title {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
	}

	.rx-title .card-title {
		white-space: nowrap;
	}

	.rx-count {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.6rem;
		font-weight: 650;
		letter-spacing: 0.02em;
		color: var(--color-text-muted);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-full);
		padding: 0.08rem 0.42rem;
	}

	.rx-tools {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.rx-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.38rem 0.7rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-bg-tertiary) 52%, transparent);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
	}

	.rx-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
		color: var(--color-text-primary);
	}

	.rx-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.rx-btn-primary {
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
	}

	.rx-btn-primary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-accent) 20%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 60%, transparent);
		color: var(--color-accent);
	}

	.rx-btn-danger:hover:not(:disabled) {
		color: var(--color-error);
		border-color: color-mix(in srgb, var(--color-error) 45%, transparent);
		background: color-mix(in srgb, var(--color-error) 8%, transparent);
	}

	/* --- Empty state --- */

	/* Positioning shell only: ui/EmptyState owns the orb, the heading, the copy
	   measure and the action row. */
	.rx-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 1.6rem 1rem;
		text-align: center;
	}

	.rx-empty-hint {
		font-family: var(--font-ui);
		font-size: 0.66rem;
		color: var(--color-text-muted);
		opacity: 0.8;
		margin: 0;
	}

	/* --- Rule list --- */

	.rx-list {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-height: 0.5rem;
	}

	.rx-rule {
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-tertiary) 52%, transparent);
		transition: border-color 140ms ease, background-color 140ms ease;
	}

	.rx-rule:hover {
		border-color: var(--color-border);
	}

	.rx-rule-open {
		border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-border-subtle));
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
	}

	.rx-row {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.5rem 0.6rem;
		min-height: 2.9rem;
	}

	.rx-grip {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--color-text-muted);
		cursor: grab;
		opacity: 0.6;
		transition: opacity 120ms ease, color 120ms ease;
	}

	.rx-grip:hover {
		opacity: 1;
		color: var(--color-text-secondary);
	}

	.rx-rule-main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
	}

	.rx-rule-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.14rem;
		transition: opacity 140ms ease;
	}

	.rx-rule-off .rx-rule-text,
	.rx-rule-off :global(.rx-routing) {
		opacity: 0.55;
	}

	.rx-rule-name {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}

	.rx-rule-desc {
		font-family: var(--font-ui);
		font-size: 0.68rem;
		line-height: 1.35;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rx-name-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.rx-pill {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.22rem;
		padding: 0.05rem 0.4rem;
		border-radius: var(--radius-full);
		font-family: var(--font-ui);
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.rx-pill-error {
		background: color-mix(in srgb, var(--color-error) 14%, transparent);
		color: var(--color-error);
	}

	.rx-pill-warn {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.rx-rule-main :global(.rx-chevron) {
		flex-shrink: 0;
		color: var(--color-text-muted);
		transition: transform 160ms ease;
	}

	.rx-rule-open .rx-rule-main :global(.rx-chevron) {
		transform: rotate(180deg);
	}

	/* --- Inline editor --- */

	/* The frame is the host's; regex/RegexRuleEditor owns everything inside it. */
	.rx-editor-shell {
		padding: 0.65rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	/* --- Editor footer --- */

	.rx-foot-group {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.rx-order-note {
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--color-text-muted);
		margin: 0;
		text-align: center;
	}

	/* --- Width tiers (the card's width, not the viewport's) --- */

	@container (max-width: 26rem) {
		.rx-tools .rx-btn:not(.rx-btn-primary) .rx-btn-label {
			display: none;
		}

		.rx-tools .rx-btn:not(.rx-btn-primary) {
			padding: 0.38rem 0.5rem;
		}

		.rx-row {
			gap: 0.45rem;
			padding: 0.5rem 0.55rem;
		}

		.rx-editor-shell {
			padding: 0.55rem;
		}
	}
</style>
