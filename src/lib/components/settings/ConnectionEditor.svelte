<script lang="ts">
	import { onMount } from 'svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import PillRow from '$lib/components/ui/PillRow.svelte';
	import MockupTip from '$lib/components/mockups/MockupTip.svelte';
	import MergeRolesMockup from '$lib/components/mockups/MergeRolesMockup.svelte';
	import ModelPicker from './ModelPicker.svelte';
	import ProviderRoutingPanel from './ProviderRoutingPanel.svelte';
	import ConnectionHero from './ConnectionHero.svelte';
	import { llmService, computePromptBudget } from '$lib/services/llm/provider';
	import { connectionStore } from '$lib/stores/connections.svelte';
	import { db } from '$lib/services/database';
	import { uiStore } from '$lib/stores/ui.svelte';
	import {
		DEFAULT_CONTEXT_SIZE,
		DEFAULT_GENERATION_SETTINGS,
		DEFAULT_PROMPT_PLACEHOLDER,
		MAX_CONTEXT_SIZE,
		MAX_RESPONSE_TOKENS,
		isRoutingEmpty,
		type ProviderName,
		type GenerationSettings,
		type ModelInfo,
		type ProviderAccount,
		type ReasoningDialect,
		type ServiceTier,
		type PromptPostProcessingMode
	} from '$lib/types/llm';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import { formatPricePerMillion, formatContext, formatMonthYear } from '$lib/utils/modelFormat';
	import {
		SAMPLING_SLIDERS,
		SERVICE_TIERS,
		EFFORT_LABELS,
		DECLARABLE_PARAMS,
		REASONING_DIALECTS,
		resolveParamPolicy,
		resolveReasoningPolicy,
		sliderVisible,
		seedVisible,
		serviceTierEligible,
		effortOptions,
		effortVisible,
		showReasoningVisible,
		verbosityVisible,
		imagesEnabled,
		imageDetailVisible,
		cachingControl
	} from '$lib/config/sampling';
	import { rangeReset } from '$lib/actions/rangeReset';
	import { toggleRow } from '$lib/actions/toggleRow';

	type Status = 'idle' | 'binding' | 'valid' | 'invalid';

	interface Props {
		/** The connection being edited. Keyed by the parent, so this component
		 *  remounts (and reloads credentials) whenever the id changes. */
		id: string;
	}

	let { id }: Props = $props();

	const PROVIDERS = llmService.getProviderList();

	const conn = $derived(connectionStore.get(id));
	const meta = $derived(PROVIDERS.find((p) => p.name === conn?.provider));

	// Credentials live server-side (keyed by connection id); the rest is the connection object.
	let apiKey = $state('');
	let baseUrl = $state('');
	/** Set when the server had to try a different shape of the typed URL to find the API. */
	let resolvedBaseUrl = $state<string | null>(null);
	let status = $state<Status>('idle');
	let connectionError = $state('');
	/** The endpoint served no model list at all, as opposed to rejecting the key. A named
	 *  reason on a failed validation IS that distinction: the server throws for "no API
	 *  here" and returns a plain false for a credential rejection. */
	let apiNotFound = $state(false);
	let account = $state<ProviderAccount | null>(null);
	let models = $state<ModelInfo[]>([]);
	let loadingModels = $state(false);

	let bindTimer: ReturnType<typeof setTimeout> | null = null;
	let connectSeq = 0;

	const gen = $derived(conn?.generation ?? DEFAULT_GENERATION_SETTINGS);
	const routedModels = $derived(conn && !isRoutingEmpty(conn.routing) ? new Set([conn.model]) : new Set<string>());

	const POST_PROCESSING_OPTIONS: { value: PromptPostProcessingMode; label: string; hint?: string }[] = [
		{ value: 'none', label: 'None', hint: 'Send the prompt exactly as assembled, no reshaping.' },
		{ value: 'merge', label: 'Merge consecutive roles' },
		{ value: 'semi-strict', label: 'Semi-strict', hint: 'Merge roles and keep a single system message at the top; any later system message is sent as user.' },
		{ value: 'strict', label: 'Strict', hint: 'Semi-strict, plus the conversation must open with a user turn. The placeholder below fills in when it doesn’t.' },
		{ value: 'single-user', label: 'Single user message', hint: 'Collapse the entire prompt into one user message, for APIs that only accept a single turn.' }
	];

	const postProcessingHint = $derived(
		conn ? POST_PROCESSING_OPTIONS.find((o) => o.value === conn.postProcessing)!.hint : undefined
	);

	const modelInfo = $derived(models.find((m) => m.id === conn?.model));
	const maxTokensCeiling = $derived(modelInfo?.maxCompletionTokens);

	// A BYO endpoint's accepted params are unknowable from here, so that provider's
	// policy is 'declared' and the connection carries its owner's own list. Every
	// other provider's real policy is known and passes through untouched.
	const declaresParams = $derived(meta?.paramPolicy === 'declared');
	const declared = $derived(conn?.samplingParams ?? []);
	const samplingPolicy = $derived(resolveParamPolicy(meta?.paramPolicy ?? 'base-only', declared));

	// The slider list mirrors exactly what this connection sends ("visible === sent").
	const visibleSliders = $derived(SAMPLING_SLIDERS.filter((p) => sliderVisible(p, modelInfo, samplingPolicy)));

	// A BYO endpoint's reasoning dialect is unknowable from here, so that provider's
	// profile says 'declared' and the connection names it. Every other provider's real
	// policy passes through untouched.
	const declaresReasoning = $derived(meta?.reasoning === 'declared');
	const reasoningPolicy = $derived(
		resolveReasoningPolicy(meta?.reasoning ?? null, conn?.reasoningDialect ?? 'none')
	);
	const dialectHint = $derived(
		conn ? REASONING_DIALECTS.find((d) => d.value === conn.reasoningDialect)?.hint : undefined
	);

	const reasoningEffortOptions = $derived(effortOptions(reasoningPolicy));
	const showEffort = $derived(effortVisible(reasoningPolicy, modelInfo));
	const showShowReasoning = $derived(showReasoningVisible(reasoningPolicy, modelInfo));
	const showVerbosity = $derived(verbosityVisible(meta?.verbosity ?? false, modelInfo));
	const showSendImages = $derived(imagesEnabled(meta?.media ?? null, modelInfo));
	const showImageDetail = $derived(imageDetailVisible(meta?.media ?? null, modelInfo) && gen.sendImages);
	const cachingCtl = $derived(cachingControl(meta?.caching ?? null));

	const VERBOSITY_OPTIONS: { value: string; label: string; title?: string }[] = [
		{ value: 'auto', label: 'Auto', title: 'Provider default, nothing sent' },
		{ value: 'low', label: 'Low', title: 'Terse' },
		{ value: 'medium', label: 'Medium', title: 'Balanced' },
		{ value: 'high', label: 'High', title: 'Expansive' }
	];

	const IMAGE_DETAIL_OPTIONS: { value: string; label: string; title?: string }[] = [
		{ value: 'auto', label: 'Auto', title: 'Provider decides' },
		{ value: 'low', label: 'Low', title: 'Faster, cheaper' },
		{ value: 'high', label: 'High', title: 'Full fidelity, pricier' }
	];

	const CACHE_TTL_OPTIONS: { value: string; label: string; title?: string }[] = [
		{ value: '5m', label: '5 minutes', title: 'Cheapest writes' },
		{ value: '1h', label: '1 hour', title: 'Pricier writes, worth it in long chats' }
	];

	const TIER_OPTIONS: { value: string; label: string; title?: string }[] = SERVICE_TIERS.map((t) => ({
		value: t.value,
		label: t.label,
		title: t.hint
	}));

	const effortPills = $derived(reasoningEffortOptions.map((l) => ({ value: l as string, label: EFFORT_LABELS[l] })));
	const effortCurrent = $derived(reasoningEffortOptions.includes(gen.reasoningEffort) ? gen.reasoningEffort : 'auto');

	// Both token sliders ride a fixed ladder that splits every octave into 16 rungs, so
	// the step tracks the magnitude (1,024 around 16k, 65,536 around 1M) and every rung
	// lands on a round number. The ladder is the dragging instrument only: the readout
	// beside it is an input, so no exact figure depends on hitting a rung, and the range
	// ends at a sanity cap rather than at whatever the selected model happens to report.
	// Storage stays raw tokens: an off-ladder saved value keeps displaying exactly.
	const RUNGS_PER_OCTAVE = 16;

	function tokenLadder(min: number, max: number): number[] {
		const rungs: number[] = [];
		for (let base = min; base < max; base *= 2) {
			const step = base / RUNGS_PER_OCTAVE;
			for (let v = base; v < base * 2 && v < max; v += step) rungs.push(v);
		}
		rungs.push(max);
		return rungs;
	}

	function nearestRungIndex(rungs: number[], value: number): number {
		let best = 0;
		for (let i = 1; i < rungs.length; i++) {
			if (Math.abs(rungs[i] - value) < Math.abs(rungs[best] - value)) best = i;
		}
		return best;
	}

	/** A typed token count, capped; null while the field holds nothing usable. */
	function parseTokenField(raw: string, max: number): number | null {
		const n = parseInt(raw.replace(/[^0-9]/g, ''), 10);
		if (!Number.isFinite(n) || n < 1) return null;
		return Math.min(n, max);
	}

	// A focused readout shows raw digits (typing shouldn't fight thousands separators)
	// and renders from this draft rather than from the store, so a stripped character
	// can't move the caret mid-edit. Unfocused, both read formatted.
	let editingField = $state<'context' | 'response' | null>(null);
	let tokenDraft = $state('');

	function beginEdit(field: 'context' | 'response', value: number): void {
		editingField = field;
		tokenDraft = String(value);
	}

	const CONTEXT_LADDER = tokenLadder(1024, MAX_CONTEXT_SIZE);
	const RESPONSE_LADDER = tokenLadder(256, MAX_RESPONSE_TOKENS);
	const responseIdx = $derived(nearestRungIndex(RESPONSE_LADDER, gen.maxTokens));
	const responseDefaultIdx = nearestRungIndex(RESPONSE_LADDER, DEFAULT_GENERATION_SETTINGS.maxTokens);

	const emptyHint = $derived(
		connectionError
			? connectionError
			: meta?.baseUrlEditable
				? 'No models. Is the server running with a model loaded?'
				: status === 'valid'
					? 'No models returned by the provider.'
					: 'Add your API key to load models.'
	);

	onMount(() => {
		void loadCredentials();
	});

	async function loadCredentials(): Promise<void> {
		if (!conn || !meta) return;
		const creds = await db.getConnectionCredentials(id);
		apiKey = creds?.apiKey ?? '';
		baseUrl = creds?.baseUrl ?? (meta.baseUrlEditable ? meta.defaultBaseUrl : '');
		account = null;
		status = 'idle';
		connectionError = '';
		// Paint instantly from the last-fetched list (remounts happen); connect refreshes live.
		models = llmService.getCachedModels(id);
		resolvedBaseUrl = llmService.getResolvedBaseUrl(id);
		await connect();
	}

	async function selectProvider(name: ProviderName): Promise<void> {
		if (!conn || name === conn.provider) return;
		if (bindTimer) clearTimeout(bindTimer);
		const m = PROVIDERS.find((p) => p.name === name);
		// A provider switch is a fresh connection: clear the model + routing + everything the
		// user declared about the OLD endpoint (accepted params, reasoning dialect), and reset
		// the credential row to the new provider with no key (the old key was for the old one).
		connectionStore.update(id, {
			provider: name,
			model: '',
			routing: null,
			samplingParams: [],
			reasoningDialect: 'none'
		});
		apiKey = '';
		baseUrl = m?.baseUrlEditable ? m.defaultBaseUrl : '';
		await llmService.setConnectionCredentials(id, name, '', baseUrl || undefined);
		account = null;
		status = 'idle';
		connectionError = '';
		models = [];
		resolvedBaseUrl = null;
		await connect();
	}

	/**
	 * Validate + (OpenRouter) fetch the account, then load the model list. A sequence
	 * guard drops stale results so a fast re-type can't clobber the latest state.
	 */
	async function connect(): Promise<void> {
		if (!conn || !meta) return;
		if (meta.requiresApiKey && !apiKey.trim()) {
			++connectSeq;
			status = 'idle';
			account = null;
			models = [];
			loadingModels = false;
			connectionError = '';
			apiNotFound = false;
			return;
		}
		const seq = ++connectSeq;
		const provider = conn.provider;
		status = 'binding';
		connectionError = '';
		apiNotFound = false;
		account = null;
		loadingModels = true;
		try {
			if (meta.account) {
				const acc = await llmService.fetchAccount(id, provider);
				if (seq !== connectSeq) return;
				account = acc;
				status = 'valid';
			} else {
				const { valid, error: reason } = await llmService.validateConnection(id, provider);
				if (seq !== connectSeq) return;
				status = valid ? 'valid' : 'invalid';
				if (!valid) {
					connectionError = reason || 'The provider rejected these credentials.';
					apiNotFound = !!reason;
				}
			}
			if (status === 'valid') {
				const list = await llmService.fetchAvailableModels(id, provider);
				if (seq !== connectSeq) return;
				models = list;
				resolvedBaseUrl = llmService.getResolvedBaseUrl(id);
			} else {
				models = [];
			}
		} catch (e) {
			if (seq !== connectSeq) return;
			status = 'invalid';
			account = null;
			models = [];
			resolvedBaseUrl = null;
			connectionError = e instanceof Error ? e.message : String(e);
		} finally {
			if (seq === connectSeq) loadingModels = false;
		}
	}

	async function persistCredentials(): Promise<void> {
		if (!conn || !meta) return;
		const trimmedKey = apiKey.trim();
		const trimmedBaseUrl = baseUrl.trim();
		if (meta.requiresApiKey && !trimmedKey) return;
		await llmService.setConnectionCredentials(id, conn.provider, trimmedKey, trimmedBaseUrl || undefined);
	}

	function scheduleBind(): void {
		if (bindTimer) clearTimeout(bindTimer);
		bindTimer = setTimeout(async () => {
			await persistCredentials();
			await connect();
		}, 650);
	}

	function onKeyChange(value: string): void {
		apiKey = value;
		account = null;
		connectionError = '';
		status = value.trim() ? 'binding' : 'idle';
		scheduleBind();
	}

	function onBaseUrlChange(value: string): void {
		baseUrl = value;
		connectionError = '';
		status = 'binding';
		scheduleBind();
	}

	async function onRefresh(): Promise<void> {
		await connect();
	}

	// ===== Connection object edits =====

	function rename(value: string): void {
		connectionStore.update(id, { name: value });
	}

	function pickModel(model: string): void {
		connectionStore.update(id, { model });
	}

	function openRouting(model: string): void {
		uiStore.settingsRoutingModel = model;
	}

	function updatePostProcessing(mode: PromptPostProcessingMode): void {
		connectionStore.update(id, { postProcessing: mode });
	}

	function updateDialect(dialect: ReasoningDialect): void {
		connectionStore.update(id, { reasoningDialect: dialect });
	}

	function commitPlaceholder(text: string): void {
		connectionStore.update(id, { promptPlaceholder: text.trim() || DEFAULT_PROMPT_PLACEHOLDER });
	}

	function commitContextSize(size: number): void {
		if (!Number.isFinite(size) || size <= 0) return;
		connectionStore.update(id, { contextSize: size });
	}

	function updateGen<K extends keyof GenerationSettings>(key: K, value: GenerationSettings[K]): void {
		if (!conn) return;
		connectionStore.update(id, { generation: { ...conn.generation, [key]: value } });
	}

	/** Flip one declared param, keeping the stored list in card order. */
	function toggleDeclared(key: string): void {
		if (!conn) return;
		const on = new Set(conn.samplingParams);
		if (on.has(key)) on.delete(key);
		else on.add(key);
		connectionStore.update(id, { samplingParams: DECLARABLE_PARAMS.filter((p) => on.has(p.key)).map((p) => p.key) });
	}

	function declareAll(on: boolean): void {
		connectionStore.update(id, { samplingParams: on ? DECLARABLE_PARAMS.map((p) => p.key) : [] });
	}

	// ===== Context warnings =====
	const contextBudgetDead = $derived(conn ? computePromptBudget(conn.contextSize, gen.maxTokens) === 0 : false);
	const ctxOverModelWindow = $derived(!!modelInfo?.contextLength && (conn?.contextSize ?? 0) > modelInfo.contextLength);
	const ctxIdx = $derived(nearestRungIndex(CONTEXT_LADDER, conn?.contextSize ?? DEFAULT_CONTEXT_SIZE));
	const ctxDefaultIdx = nearestRungIndex(CONTEXT_LADDER, DEFAULT_CONTEXT_SIZE);
</script>

{#snippet specTag(label: string, tip: string, variant: string)}
	<InfoTip text={tip}>
		{#snippet trigger()}<span class="dm-tag {variant}">{label}</span>{/snippet}
	</InfoTip>
{/snippet}

{#if !conn || !meta}
	<p class="missing">This connection no longer exists.</p>
{:else if uiStore.settingsRoutingModel}
	<!-- In-place Provider Routing sub-view: replaces the editor body. The back
	     affordances (drill chip, split back/forward, Escape) step out of it. -->
	<ProviderRoutingPanel connectionId={id} />
{:else}
	<div class="conn">
		<!-- Name -->
		<section class="card" data-setting="connections">
			<div class="card-head">
				<span class="card-title">Name</span>
				<InfoTip text="How this connection shows up wherever you assign it." />
			</div>
			<input
				type="text"
				class="input-base name-input"
				value={conn.name}
				oninput={(e) => rename(e.currentTarget.value)}
				placeholder="Connection name"
			/>
		</section>

		<ConnectionHero
			providers={PROVIDERS}
			selectedProvider={conn.provider}
			{meta}
			{apiKey}
			{baseUrl}
			{resolvedBaseUrl}
			{status}
			{account}
			error={connectionError}
			{apiNotFound}
			modelCount={models.length}
			onSelectProvider={selectProvider}
			{onKeyChange}
			{onBaseUrlChange}
			{onRefresh}
		/>

		<!-- Model -->
		<section class="card" data-setting="primary-model">
			<div class="card-head">
				<span class="card-title">Model</span>
				<InfoTip text="The model this connection runs on, everywhere it's assigned." />
			</div>

			<ModelPicker
				{models}
				value={conn.model}
				loading={loadingModels}
				{emptyHint}
				{routedModels}
				onpick={pickModel}
				onConfigureRouting={meta.routing ? openRouting : undefined}
			/>

			<!-- Only worth saying when a list exists to contradict it: with no list at all
			     (a server that serves no /models) there is nothing this could mean. -->
			{#if conn.model && models.length > 0 && !modelInfo}
				<p class="mode-hint">Not in the loaded model list. Sent exactly as typed.</p>
			{/if}

			{#if modelInfo}
				{@const info = modelInfo}
				{@const ctx = formatContext(info.contextLength)}
				{@const inPrice = formatPricePerMillion(info.pricing?.prompt)}
				{@const outPrice = formatPricePerMillion(info.pricing?.completion)}
				{@const cutoff = formatMonthYear(info.knowledgeCutoff)}
				{@const vision = !!info.inputModalities?.includes('image')}
				{@const tools = !!info.supportedParameters?.includes('tools')}
				{@const hasStats = !!(ctx || inPrice || outPrice || cutoff)}
				{@const hasTags = vision || tools || !!info.isReasoning || info.isModerated !== undefined}
				{#if hasStats || hasTags}
					<div class="spec">
						{#if hasStats}
							<div class="spec-stats">
								{#if ctx}<div class="stat"><span class="stat-label">Context</span><span class="stat-value">{ctx}</span></div>{/if}
								{#if inPrice}<div class="stat"><span class="stat-label">Input</span><span class="stat-value">{inPrice}</span></div>{/if}
								{#if outPrice}<div class="stat"><span class="stat-label">Output</span><span class="stat-value">{outPrice}</span></div>{/if}
								{#if cutoff}<div class="stat"><span class="stat-label">Knowledge</span><span class="stat-value">{cutoff}</span></div>{/if}
							</div>
						{/if}
						{#if hasTags}
							<div class="spec-tags">
								{#if vision}{@render specTag('Vision', 'Reads images you attach to messages.', 'cap')}{/if}
								{#if tools}{@render specTag('Tools', 'Supports tool calling, which the Chungus Assistant needs.', 'cap')}{/if}
								{#if info.isReasoning}{@render specTag('Reasoning', 'Thinks before replying. Often better, usually slower and pricier.', 'accent')}{/if}
								{#if info.isModerated === true}
									{@render specTag('Moderated', 'The default provider runs a safety filter, so some prompts or replies get blocked.', 'warn')}
								{:else if info.isModerated === false}
									{@render specTag('Unmoderated', 'No safety filter on the default route, so fewer refusals.', 'ok')}
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			{/if}
		</section>

		<!-- Request: how the assembled prompt is shaped and delivered. -->
		<section class="card">
			<div class="card-head">
				<span class="card-title">Request</span>
				<InfoTip text="How the assembled prompt is shaped and delivered to this provider." />
			</div>

			<div class="req-sec" data-setting="prompt-post-processing">
				<div class="req-head">
					<span class="section-label">Prompt shape</span>
					<MockupTip
						text="Reshapes the prompt for APIs with strict message rules. Every mode but None starts with the merge shown here."
					>
						<MergeRolesMockup />
					</MockupTip>
				</div>
				<Select
					value={conn.postProcessing}
					onchange={(e) => updatePostProcessing((e.currentTarget as HTMLSelectElement).value as PromptPostProcessingMode)}
				>
					{#each POST_PROCESSING_OPTIONS as o (o.value)}
						<option value={o.value}>{o.label}</option>
					{/each}
				</Select>
				{#if postProcessingHint}<p class="mode-hint">{postProcessingHint}</p>{/if}
				{#if conn.postProcessing === 'strict'}
					<div class="placeholder-block">
						<div class="slider-label-wrap">
							<label for="prompt-placeholder" class="slider-label">Placeholder user message</label>
							<InfoTip
								text="Opens the conversation when the chat would otherwise start with the assistant. Blank restores the default."
							/>
						</div>
						<input
							id="prompt-placeholder"
							type="text"
							class="input-base placeholder-input"
							value={conn.promptPlaceholder}
							onchange={(e) => commitPlaceholder(e.currentTarget.value)}
						/>
					</div>
				{/if}
			</div>

			{#if cachingCtl}
				<div class="req-sec" data-setting="prompt-caching">
					<span class="section-label">Caching</span>
					<div class="toggle-row" use:toggleRow>
						<div class="slider-label-wrap">
							<span class="slider-label">Prompt caching</span>
							<InfoTip
								text="Reuses the unchanged start of the prompt across turns, so it bills as a cheap cache read instead of full price."
							/>
						</div>
						{#if cachingCtl.mode === 'explicit'}
							<Toggle checked={gen.promptCaching} onchange={(v) => updateGen('promptCaching', v)} label="Prompt caching" />
						{:else}
							<span class="caching-auto-note">Automatic, always on</span>
						{/if}
					</div>
					{#if cachingCtl.mode === 'explicit' && gen.promptCaching && cachingCtl.ttl}
						<div class="row-block">
							<div class="slider-label-wrap">
								<span class="slider-label">Lifetime</span>
								<InfoTip
									text="How long a cached prompt stays warm between turns."
								/>
							</div>
							<PillRow
								options={CACHE_TTL_OPTIONS}
								current={gen.cacheTtl}
								onpick={(v) => updateGen('cacheTtl', v as GenerationSettings['cacheTtl'])}
								label="Cache lifetime"
							/>
						</div>
					{/if}
				</div>
			{/if}

			{#if serviceTierEligible(meta.serviceTier, conn.model)}
				<div class="req-sec">
					<span class="section-label">Delivery</span>
					<div class="row-block">
						<div class="slider-label-wrap">
							<span class="slider-label">Service tier</span>
							<InfoTip
								text="How the provider prioritizes this request. An unavailable tier falls back to standard."
							/>
						</div>
						<PillRow
							options={TIER_OPTIONS}
							current={gen.serviceTier}
							onpick={(v) => updateGen('serviceTier', v as ServiceTier)}
							label="Service tier"
						/>
					</div>
				</div>
			{/if}
		</section>

		<!-- Context window -->
		<section class="card" data-setting="context-size">
			<div class="card-head">
				<span class="card-title">Context Window</span>
				<InfoTip
					text="How many tokens the whole prompt may use. Outgrow it and the oldest messages are trimmed first, never your preset, characters, lorebooks or memory."
				/>
			</div>
			<div class="slider-block">
				<div class="slider-top">
					<label for="context-size" class="slider-label">Tokens</label>
					<div class="value-row">
						{#if conn.contextSize !== DEFAULT_CONTEXT_SIZE}
							<button
								type="button"
								class="ctx-reset"
								title="Reset to {DEFAULT_CONTEXT_SIZE.toLocaleString()} (default)"
								onclick={() => commitContextSize(DEFAULT_CONTEXT_SIZE)}
							>
								reset
							</button>
						{/if}
						<input
							type="text"
							inputmode="numeric"
							class="slider-value value-input"
							class:engaged={conn.contextSize !== DEFAULT_CONTEXT_SIZE}
							aria-label="Context window in tokens"
							title="Type an exact token count"
							value={editingField === 'context' ? tokenDraft : conn.contextSize.toLocaleString()}
							onfocus={() => beginEdit('context', conn!.contextSize)}
							onblur={() => (editingField = null)}
							onkeydown={(e) => {
								if (e.key === 'Enter') e.currentTarget.blur();
							}}
							oninput={(e) => {
								tokenDraft = e.currentTarget.value;
								const n = parseTokenField(tokenDraft, MAX_CONTEXT_SIZE);
								if (n !== null) commitContextSize(n);
							}}
						/>
					</div>
				</div>
				<input
					id="context-size"
					type="range"
					class="slider"
					min="0"
					max={CONTEXT_LADDER.length - 1}
					step="1"
					value={ctxIdx}
					oninput={(e) => commitContextSize(CONTEXT_LADDER[parseInt(e.currentTarget.value)])}
					use:rangeReset={{ defaultValue: ctxDefaultIdx, apply: (i) => commitContextSize(CONTEXT_LADDER[i]) }}
				/>
				{#if modelInfo?.contextLength && !ctxOverModelWindow}
					<span class="slider-note">Model max: {modelInfo.contextLength.toLocaleString()} tokens.</span>
				{/if}
			</div>
			{#if contextBudgetDead}
				<p class="mode-hint warn">
					The {gen.maxTokens.toLocaleString()}-token response reserve eats this entire window, leaving nothing for
					the prompt. Lower the max tokens or raise the context window.
				</p>
			{/if}
			{#if ctxOverModelWindow}
				<p class="mode-hint warn">
					Larger than this model's {modelInfo!.contextLength!.toLocaleString()}-token window, so the provider may reject
					or silently truncate the prompt.
				</p>
			{/if}
		</section>

		<!-- Response -->
		<section class="card" data-setting="response-behavior">
			<div class="card-head">
				<span class="card-title">Response</span>
				<InfoTip
					text="Length, streaming, reasoning and images. Only what this provider and model support shows up here."
				/>
			</div>

			<div class="card-body">
				<div class="slider-block">
					<div class="slider-top">
						<label for="max-tokens" class="slider-label">Max tokens</label>
						<input
							type="text"
							inputmode="numeric"
							class="slider-value value-input"
							aria-label="Max response tokens"
							title="Type an exact token count"
							value={editingField === 'response' ? tokenDraft : gen.maxTokens.toLocaleString()}
							onfocus={() => beginEdit('response', gen.maxTokens)}
							onblur={() => (editingField = null)}
							onkeydown={(e) => {
								if (e.key === 'Enter') e.currentTarget.blur();
							}}
							oninput={(e) => {
								tokenDraft = e.currentTarget.value;
								const n = parseTokenField(tokenDraft, MAX_RESPONSE_TOKENS);
								if (n !== null) updateGen('maxTokens', n);
							}}
						/>
					</div>
					<input
						id="max-tokens"
						type="range"
						class="slider"
						min="0"
						max={RESPONSE_LADDER.length - 1}
						step="1"
						value={responseIdx}
						oninput={(e) => updateGen('maxTokens', RESPONSE_LADDER[parseInt(e.currentTarget.value)])}
						use:rangeReset={{ defaultValue: responseDefaultIdx, apply: (i) => updateGen('maxTokens', RESPONSE_LADDER[i]) }}
					/>
					{#if maxTokensCeiling && maxTokensCeiling < gen.maxTokens}
						<span class="slider-note warn">This model caps output at {maxTokensCeiling.toLocaleString()} tokens.</span>
					{:else if maxTokensCeiling}
						<span class="slider-note">Model max: {maxTokensCeiling.toLocaleString()} tokens.</span>
					{/if}
				</div>

				{#if showVerbosity}
					<div class="row-block">
						<div class="slider-label-wrap">
							<span class="slider-label">Verbosity</span>
							<InfoTip text="How expansive replies should be. Models that don't document verbosity may reject the request." />
						</div>
						<PillRow
							options={VERBOSITY_OPTIONS}
							current={gen.verbosity}
							onpick={(v) => updateGen('verbosity', v as GenerationSettings['verbosity'])}
							label="Verbosity"
						/>
					</div>
				{/if}

				<div class="toggle-row" use:toggleRow>
					<div class="slider-label-wrap">
						<span class="slider-label">Stream response</span>
						<InfoTip
							text="Show the reply as it's written, word by word. Off, every request this connection makes waits in silence for the whole answer, so a model that is merely slow cannot be told from an endpoint that has stopped answering. Turn it off only for an endpoint that cannot stream."
						/>
					</div>
					<Toggle checked={gen.streamResponses} onchange={(v) => updateGen('streamResponses', v)} label="Stream response" />
				</div>

				<div class="sub">
					<span class="section-label">Reasoning</span>
					<div class="toggle-row" use:toggleRow>
						<div class="slider-label-wrap">
							<span class="slider-label">Auto-parse reasoning from replies</span>
							<InfoTip
								text="Catches models that write their thinking into the message as plain text and moves it to the reasoning box."
							/>
						</div>
						<Toggle checked={gen.parseReasoning} onchange={(v) => updateGen('parseReasoning', v)} label="Auto-parse reasoning" />
					</div>
					{#if declaresReasoning}
						<!-- BYO endpoints: these stacks disagree on which field carries the
						     thinking settings and /models never says which, so its owner names
						     it and the Effort row below follows that exactly. -->
						<div class="row-block">
							<div class="slider-label-wrap">
								<span class="slider-label">Reasoning field</span>
								<InfoTip
									text="Nothing here can check that your server reads it: the field is simply added to the request."
								/>
							</div>
							<Select
								value={conn.reasoningDialect}
								onchange={(e) => updateDialect((e.currentTarget as HTMLSelectElement).value as ReasoningDialect)}
							>
								{#each REASONING_DIALECTS as d (d.value)}
									<option value={d.value}>{d.label}</option>
								{/each}
							</Select>
							{#if dialectHint}<p class="mode-hint">{dialectHint}</p>{/if}
						</div>
					{/if}
					{#if showEffort}
						<div class="row-block">
							<div class="slider-label-wrap">
								<span class="slider-label">Effort</span>
								<InfoTip
									text="How hard the model thinks before replying. Auto leaves it to the provider, Off disables thinking where the API allows it."
								/>
							</div>
							<PillRow
								options={effortPills}
								current={effortCurrent}
								onpick={(v) => updateGen('reasoningEffort', v as GenerationSettings['reasoningEffort'])}
								label="Reasoning effort"
							/>
						</div>
					{/if}
					{#if showShowReasoning}
						<div class="toggle-row" use:toggleRow>
							<div class="slider-label-wrap">
								<span class="slider-label">Show reasoning</span>
								<InfoTip
									text="Return the model's thinking alongside the reply. Off asks the provider not to send it, though the model still thinks."
								/>
							</div>
							<Toggle checked={gen.showReasoning} onchange={(v) => updateGen('showReasoning', v)} label="Show reasoning" />
						</div>
					{/if}
				</div>

				{#if showSendImages}
					<div class="sub">
						<span class="section-label">Images</span>
						<div class="toggle-row" use:toggleRow>
							<div class="slider-label-wrap">
								<span class="slider-label">Send images</span>
								<InfoTip
									text="Send images attached to chat messages along with the prompt. Off keeps them in the chat but out of the request."
								/>
							</div>
							<Toggle checked={gen.sendImages} onchange={(v) => updateGen('sendImages', v)} label="Send images" />
						</div>
						{#if showImageDetail}
							<div class="row-block">
								<div class="slider-label-wrap">
									<span class="slider-label">Detail</span>
									<InfoTip text="How much resolution the model gets from attached images." />
								</div>
								<PillRow
									options={IMAGE_DETAIL_OPTIONS}
									current={gen.imageDetail}
									onpick={(v) => updateGen('imageDetail', v as GenerationSettings['imageDetail'])}
									label="Image detail"
								/>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</section>

		<!-- Sampling parameters -->
		<section class="card" data-setting="generation">
			<div class="card-head">
				<span class="card-title">Sampling Parameters</span>
				<InfoTip
					text="The sampling values sent with every generation on this connection, and only what it actually sends appears here. Double-click a slider to reset it."
				/>
			</div>

			<div class="card-body">
				{#if declaresParams}
					<!-- BYO endpoints: nothing on our side can know what the endpoint takes,
					     so its owner declares it and the sliders below follow that exactly. -->
					<div class="declare">
						<div class="declare-head">
							<span class="section-label">Accepted by this endpoint</span>
							<InfoTip
								text="There is no way to ask your server what it accepts, so turn on what it takes. Those become the sliders below, and temperature is always sent."
							/>
							<div class="declare-actions">
								<button type="button" class="micro-btn" onclick={() => declareAll(true)}>all</button>
								<span class="micro-sep" aria-hidden="true"></span>
								<button type="button" class="micro-btn" onclick={() => declareAll(false)}>none</button>
							</div>
						</div>
						<div class="chips">
							{#each DECLARABLE_PARAMS as p (p.key)}
								<button
									type="button"
									class="chip"
									class:is-active-tint={declared.includes(p.key)}
									aria-pressed={declared.includes(p.key)}
									title={`${p.label}: ${p.info}`}
									onclick={() => toggleDeclared(p.key)}
								>
									{p.key}
								</button>
							{/each}
						</div>
						{#if declared.length === 0}
							<p class="declare-hint">Nothing declared: only temperature is sent.</p>
						{/if}
					</div>
				{/if}

				{#each visibleSliders as p (p.key)}
					<div class="slider-block">
						<div class="slider-top">
							<div class="slider-label-wrap">
								<label for={`gen-${p.key}`} class="slider-label">{p.label}</label>
								<InfoTip text={p.info} />
							</div>
							<span class="slider-value">{p.int ? gen[p.key] : gen[p.key].toFixed(2)}</span>
						</div>
						<input
							id={`gen-${p.key}`}
							type="range"
							class="slider"
							value={gen[p.key]}
							min={p.min}
							max={p.max}
							step={p.step}
							oninput={(e) => updateGen(p.key, p.int ? parseInt(e.currentTarget.value) : parseFloat(e.currentTarget.value))}
							use:rangeReset={{ defaultValue: DEFAULT_GENERATION_SETTINGS[p.key], apply: (v) => updateGen(p.key, v) }}
						/>
						{#if p.key === 'temperature' && modelInfo?.defaultTemperature != null}
							<span class="slider-note">This model suggests {modelInfo.defaultTemperature.toFixed(2)}.</span>
						{/if}
					</div>
				{/each}

				{#if seedVisible(modelInfo, samplingPolicy)}
					<div class="row-block">
						<div class="slider-top">
							<div class="slider-label-wrap">
								<label for="gen-seed" class="slider-label">Seed</label>
								<InfoTip text="A fixed seed makes the same prompt reproduce the same output. Blank = random each run." />
							</div>
							{#if gen.seed != null}
								<button type="button" class="link-btn" onclick={() => updateGen('seed', null)}>clear</button>
							{/if}
						</div>
						<input
							id="gen-seed"
							type="number"
							class="input-base seed-input"
							value={gen.seed ?? ''}
							placeholder="random"
							oninput={(e) => {
								const v = e.currentTarget.value.trim();
								const n = parseInt(v);
								updateGen('seed', v === '' || !Number.isFinite(n) ? null : n);
							}}
						/>
					</div>
				{/if}
			</div>
		</section>
	</div>
{/if}

<style>
	.conn {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.missing {
		font-family: var(--font-ui);
		font-size: 0.85rem;
		color: var(--color-text-muted);
	}

	.name-input {
		width: 100%;
		padding: 0.5rem 0.65rem;
		font-family: var(--font-ui);
		font-size: 0.9rem;
		color: var(--color-text-primary);
	}

	/* ===== Selected-model spec sheet ===== */
	.spec {
		margin-top: 0.65rem;
		padding-top: 0.65rem;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 55%, transparent);
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.spec-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem 1.3rem;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		min-width: 0;
	}

	.stat-label {
		font-family: var(--font-ui);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.stat-value {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-text-primary);
		white-space: nowrap;
	}

	.spec-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	.dm-tag {
		font-family: var(--font-ui);
		font-size: 0.66rem;
		font-weight: 650;
		padding: 0.1rem 0.45rem;
		border-radius: var(--radius-full);
	}

	.dm-tag.cap {
		color: var(--color-text-secondary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
	}

	.dm-tag.accent {
		color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.dm-tag.ok {
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
	}

	.dm-tag.warn {
		color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
	}

	/* ===== Context ===== */
	.value-row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	/* Quiet reset beside the context readout: micro type, muted, dotted until hovered.
	   It sits next to the number it resets and must never out-shout it. */
	.ctx-reset {
		border: none;
		background: none;
		padding: 0;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--color-text-muted);
		cursor: pointer;
		text-decoration: underline dotted;
		text-underline-offset: 0.2em;
	}

	.ctx-reset:hover {
		color: var(--color-text-secondary);
		text-decoration-style: solid;
	}

	/* The token readouts are fields, not labels: the sliders are for coarse dragging
	   and this is where an exact figure gets typed. Chromeless until hovered so the
	   card still reads as a row of values rather than a form. */
	.value-input {
		width: 5.9rem;
		padding: 0.12rem 0.3rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		font-variant-numeric: tabular-nums;
		transition: border-color 90ms ease, background 90ms ease;
	}

	.value-input:hover {
		border-color: color-mix(in srgb, var(--color-border-subtle) 75%, transparent);
	}

	.value-input:focus {
		outline: none;
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-accent) 8%, transparent);
	}

	/* ===== Request ===== */
	.req-sec {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.req-sec + .req-sec {
		margin-top: 0.85rem;
		padding-top: 0.85rem;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 55%, transparent);
	}

	.req-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	/* Labeled sub-groups inside a card (Reasoning, Images): a quiet seam + micro label. */
	.sub {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding-top: 0.8rem;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 45%, transparent);
	}

	.row-block {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.mode-hint {
		margin: 0.1rem 0 0;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		color: var(--color-text-muted);
	}

	.mode-hint.warn {
		margin-top: 0.5rem;
		color: var(--color-warning);
	}

	.placeholder-block {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 0.35rem;
	}

	.placeholder-input {
		width: 100%;
		padding: 0.45rem 0.6rem;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-text-primary);
	}

	/* Declared endpoint params (BYO connections only), seamed off above the sliders
	   it governs. The chips carry the WIRE names in mono: that is the vocabulary the
	   user is cross-checking against their own endpoint's docs, and it keeps them
	   reading as API fields rather than as a second set of controls competing with
	   the human-labeled sliders below. */
	.declare {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		padding-bottom: 0.8rem;
		border-bottom: 1px solid color-mix(in srgb, var(--color-border-subtle) 45%, transparent);
	}

	.declare-head {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	/* The all/none pair rides the section label's exact type scale, muted until
	   hovered: it is the quietest affordance in the card, not the loudest. (The
	   shared .link-btn is accent + underlined and inherits the body size, which put
	   two shouting orange links above a micro label.) */
	.declare-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
	}

	.micro-btn {
		padding: 0;
		border: none;
		background: none;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.6563rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition: color 90ms ease;
	}

	.micro-btn:hover {
		color: var(--color-accent);
	}

	.micro-sep {
		width: 1px;
		height: 0.62rem;
		background: color-mix(in srgb, var(--color-border-subtle) 85%, transparent);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	.chip {
		padding: 0.22rem 0.55rem;
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 65%, transparent);
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-mono);
		font-size: 0.7rem;
		line-height: 1.35;
		cursor: pointer;
		transition: color 90ms ease, border-color 90ms ease, background 90ms ease;
	}

	.chip:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-border) 90%, transparent);
	}

	/* Scoped active tint: the canonical .is-active-tint recipe lives in a cascade layer. */
	.chip.is-active-tint {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 33%, transparent);
	}

	.declare-hint {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	/* ===== Control rows: local additions; the shared recipes live in app.css ===== */
	.slider-value.engaged {
		color: var(--color-accent);
	}

	.seed-input {
		width: 100%;
		padding: 0.45rem 0.6rem;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-text-primary);
	}

	.slider-note {
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--color-text-muted);
	}

	.caching-auto-note {
		font-family: var(--font-ui);
		font-size: 0.72rem;
		color: var(--color-text-muted);
		font-style: italic;
	}

	.slider-note.warn {
		color: var(--color-warning);
	}
</style>
