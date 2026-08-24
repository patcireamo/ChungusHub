<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import type { ProviderMeta } from '$lib/services/llm/provider';
	import type { ProviderAccount, ProviderName } from '$lib/types/llm';
	import { formatUsd } from '$lib/utils/modelFormat';

	type Status = 'idle' | 'binding' | 'valid' | 'invalid';

	interface Props {
		providers: ProviderMeta[];
		selectedProvider: ProviderName;
		meta: ProviderMeta;
		apiKey: string;
		baseUrl: string;
		/** The URL that proved it serves the API, when it differs from the typed one. */
		resolvedBaseUrl: string | null;
		status: Status;
		account: ProviderAccount | null;
		error: string;
		/** The endpoint served no model list, rather than rejecting the key. Requests still
		 *  go to the URL as typed, so the model can be named by hand. */
		apiNotFound: boolean;
		modelCount: number;
		onSelectProvider: (name: ProviderName) => void;
		onKeyChange: (value: string) => void;
		onBaseUrlChange: (value: string) => void;
		onRefresh: () => void;
	}

	let {
		providers,
		selectedProvider,
		meta,
		apiKey,
		baseUrl,
		resolvedBaseUrl,
		status,
		account,
		error,
		apiNotFound,
		modelCount,
		onSelectProvider,
		onKeyChange,
		onBaseUrlChange,
		onRefresh
	}: Props = $props();

	let showKey = $state(false);
	let menuOpen = $state(false);
	let chipEl = $state<HTMLButtonElement | null>(null);
	let menuEl = $state<HTMLDivElement | null>(null);

	// Health lamp colour: green when connected & funded, amber on a soft warning
	// (wrong key type / free tier), red on rejection, dim while idle.
	const health = $derived.by<'ok' | 'warn' | 'error' | 'idle'>(() => {
		if (status === 'invalid') return 'error';
		if (status === 'binding' || status === 'idle') return 'idle';
		if (account?.isManagementKey) return 'warn';
		return 'ok';
	});

	const budgetPct = $derived(
		account && account.limit && account.limit > 0 && account.limitRemaining != null
			? Math.max(0, Math.min(100, (account.limitRemaining / account.limit) * 100))
			: 0
	);
	const budgetLow = $derived(
		!!account && !!account.limit && account.limit > 0 && account.limitRemaining != null && account.limitRemaining / account.limit < 0.1
	);

	const showRefresh = $derived(status === 'valid' || status === 'invalid');

	const FREE_TIER_HINT =
		'Free-tier keys are rate-limited and capped on free models. Adding credit lifts the caps.';

	function pickProvider(name: ProviderName): void {
		menuOpen = false;
		if (name !== selectedProvider) onSelectProvider(name);
	}

	function expiryLabel(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime())
			? iso
			: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	$effect(() => {
		function onClick(e: MouseEvent): void {
			const t = e.target as Node;
			if (menuOpen && menuEl && chipEl && !menuEl.contains(t) && !chipEl.contains(t)) menuOpen = false;
		}
		document.addEventListener('mousedown', onClick);
		return () => document.removeEventListener('mousedown', onClick);
	});
</script>

<div class="hero">
	<!-- Provider chip + refresh -->
	<div class="hero-head">
		<div class="chip-wrap" data-setting="provider">
			<button
				bind:this={chipEl}
				type="button"
				class="provider-chip"
				class:open={menuOpen}
				onclick={() => (menuOpen = !menuOpen)}
				aria-haspopup="listbox"
				aria-expanded={menuOpen}
			>
				{#if selectedProvider === 'openrouter'}
					<Icon name="sparkles" class="w-4 h-4" strokeWidth={1.75} />
				{:else}
					<Icon name="globe" class="w-4 h-4" strokeWidth={1.75} />
				{/if}
				<span>{meta.displayName}</span>
				<Icon name="chevronDown" class="w-3.5 h-3.5 chip-caret" strokeWidth={2} />
			</button>

			{#if menuOpen}
				<div bind:this={menuEl} class="provider-menu surface-float" role="listbox">
					{#each providers as p (p.name)}
						<button
							type="button"
							class="provider-opt"
							class:active={p.name === selectedProvider}
							role="option"
							aria-selected={p.name === selectedProvider}
							onclick={() => pickProvider(p.name)}
						>
							<span>{p.displayName}</span>
							{#if p.name === selectedProvider}
								<Icon name="check" class="w-3.5 h-3.5 text-accent" />
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		{#if showRefresh}
			<button type="button" class="refresh-btn" onclick={onRefresh} title="Refresh connection">
				<Icon name="refresh" class="w-4 h-4" strokeWidth={1.75} />
			</button>
		{/if}
	</div>

	<!-- Base URL (editable providers only) -->
	{#if meta.baseUrlEditable}
		<input
			type="text"
			value={baseUrl}
			oninput={(e) => onBaseUrlChange((e.currentTarget as HTMLInputElement).value)}
			placeholder={meta.defaultBaseUrl || 'http://localhost:1234/v1'}
			spellcheck="false"
			autocomplete="off"
			class="input-base field base-url"
			aria-label="Server URL"
		/>
		<!-- The typed URL didn't serve the API but a probed sibling (its /v1 twin, the stem
		     of a pasted endpoint URL, a redirect target) proved it does. Shown rather than
		     applied silently: the correction is a fact discovered from the server, and the
		     field keeps exactly what was typed. -->
		{#if resolvedBaseUrl}
			<p class="resolved-note">Requests go to <code>{resolvedBaseUrl}</code></p>
		{/if}
	{/if}

	<!-- Key field -->
	<div class="key-row" data-setting="api-key">
		<div class="key-wrap" class:binding={status === 'binding'}>
			<Icon name="lock" class="key-icon" strokeWidth={1.75} />
			<input
				type={showKey ? 'text' : 'password'}
				value={apiKey}
				oninput={(e) => onKeyChange((e.currentTarget as HTMLInputElement).value)}
				placeholder={meta.requiresApiKey ? `Paste your ${meta.displayName} API key` : 'API key (optional for this server)'}
				autocomplete="off"
				data-1p-ignore
				data-lpignore="true"
				class="input-base field key-input"
			/>
			<button
				type="button"
				class="eye-btn"
				onclick={() => (showKey = !showKey)}
				aria-label={showKey ? 'Hide API key' : 'Show API key'}
			>
				<Icon name={showKey ? 'eyeOff' : 'eye'} class="w-5 h-5" strokeWidth={1.75} />
			</button>
			{#if status === 'binding'}
				<span class="shimmer" aria-hidden="true"></span>
			{/if}
		</div>
	</div>

	{#if status === 'binding'}
		<p class="status-line muted"><Icon name="radar" class="w-3.5 h-3.5" strokeWidth={1.75} /> Reading your key…</p>
	{:else if error}
		<p class="status-line err"><Icon name="warning" class="w-3.5 h-3.5" strokeWidth={1.75} /> {error}</p>
		<!-- The verdict stays red: a mistyped URL is by far the likeliest cause and must keep
		     shouting. But a server that only answers /chat/completions is a real setup, and it
		     still gets its request, so the way out is stated instead of left to be discovered. -->
		{#if apiNotFound}
			<p class="status-hint">Requests still go to this URL as typed, so you can name the model yourself below.</p>
		{/if}
	{/if}

	<!-- The ledger wakes up once a key is bound -->
	{#if account}
		<div class="ledger fade-in">
			<div class="identity">
				<span class="dot dot-{health}"></span>
				{#if account.label}
					<span class="fingerprint">{account.label}</span>
				{:else}
					<span class="fingerprint muted">Connected</span>
				{/if}
				{#if account.isFreeTier}
					<span class="pill">Free tier <InfoTip text={FREE_TIER_HINT} /></span>
				{/if}
			</div>

			{#if account.limit != null}
				<div class="budget">
					<div class="budget-head">
						<span class="budget-left">{formatUsd(account.limitRemaining)} left</span>
						<span class="budget-cap">of {formatUsd(account.limit)}</span>
					</div>
					<div class="meter"><div class="meter-fill" class:low={budgetLow} style="width:{budgetPct}%"></div></div>
					{#if account.limitReset}<span class="budget-note">resets {account.limitReset}</span>{/if}
				</div>
			{:else}
				<div class="budget-flat">
					<span class="nocap">No spend cap</span>
					{#if account.balance != null}<span class="balance">Balance {formatUsd(account.balance)}</span>{/if}
				</div>
			{/if}

			{#if account.usageDaily || account.usageWeekly || account.usageMonthly}
				<div class="spend">
					<span class="spend-chip"><b>Today</b> {formatUsd(account.usageDaily)}</span>
					<span class="spend-chip"><b>Week</b> {formatUsd(account.usageWeekly)}</span>
					<span class="spend-chip"><b>Month</b> {formatUsd(account.usageMonthly)}</span>
				</div>
			{/if}

			{#if account.isManagementKey}
				<p class="ledger-warn">
					This looks like a management/provisioning key, not an inference key, so generation will fail. Paste a key that starts with <code>sk-or-v1</code>.
				</p>
			{/if}
			{#if account.expiresAt}
				<p class="ledger-warn soft">Key expires {expiryLabel(account.expiresAt)}.</p>
			{/if}
		</div>
	{:else if status === 'valid'}
		<div class="connected fade-in">
			<span class="dot dot-ok"></span>
			Connected{modelCount ? ` · ${modelCount} models` : ''}
		</div>
	{/if}
</div>

<style>
	.hero {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 1rem 1rem 0.85rem;
		border-radius: var(--radius-xl);
		border: 1px solid var(--glass-border);
		/* In-flow card inside the frosted settings panel: the panel already blurs
		   the backdrop, so the hero only paints the glass-aware card tint. */
		background: var(--color-card-bg);
		box-shadow: var(--shadow-md);
	}

	.hero-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.chip-wrap {
		position: relative;
	}

	.provider-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		height: 1.95rem;
		padding: 0 0.5rem 0 0.7rem;
		border-radius: var(--radius-full);
		border: 1px solid color-mix(in srgb, var(--color-accent) 33%, transparent);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.82rem;
		font-weight: 650;
		cursor: pointer;
		transition: background 120ms ease, border-color 120ms ease;
	}

	.provider-chip:hover,
	.provider-chip.open {
		background: color-mix(in srgb, var(--color-accent) 20%, transparent);
	}

	.provider-chip :global(.chip-caret) {
		opacity: 0.7;
		transition: transform 140ms ease;
	}

	.provider-chip.open :global(.chip-caret) {
		transform: rotate(180deg);
	}

	.provider-menu {
		position: absolute;
		top: calc(100% + 5px);
		left: 0;
		z-index: 60;
		min-width: 13rem;
		max-height: 17rem;
		overflow-y: auto;
		padding: 0.25rem;
		/* Floating menu over panel content, carrying .surface-float in markup. */
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
	}

	.provider-opt {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		width: 100%;
		padding: 0.42rem 0.6rem;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
		transition: background 90ms ease, color 90ms ease;
	}

	.provider-opt:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 75%, transparent);
		color: var(--color-text-primary);
	}

	.provider-opt.active {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		font-weight: 650;
	}

	.refresh-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.95rem;
		height: 1.95rem;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease, background 120ms ease;
	}

	.refresh-btn:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
	}

	.field {
		width: 100%;
		font-family: var(--font-ui);
		font-size: 0.84rem;
		color: var(--color-text-primary);
	}

	.base-url {
		padding: 0.6rem 0.8rem;
		font-family: var(--font-mono);
		font-size: 0.78rem;
	}

	/* Sits under the field it annotates, quieter than the value it reports. */
	.resolved-note {
		margin: -0.15rem 0 0;
		padding: 0 0.2rem;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--color-text-muted);
	}

	.resolved-note code {
		font-family: var(--font-mono);
		word-break: break-all;
	}

	.key-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	.key-wrap :global(.key-icon) {
		position: absolute;
		left: 0.8rem;
		width: 1rem;
		height: 1rem;
		color: var(--color-text-muted);
		pointer-events: none;
		z-index: 1;
	}

	.key-input {
		padding: 0.68rem 2.6rem 0.68rem 2.4rem;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		letter-spacing: 0.01em;
	}

	.eye-btn {
		position: absolute;
		right: 0.5rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.85rem;
		height: 1.85rem;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease;
	}

	.eye-btn:hover {
		color: var(--color-text-primary);
	}

	/* "Reading your key" sweep along the field's bottom edge, calmer than a spinner. */
	.shimmer {
		position: absolute;
		left: 0.6rem;
		right: 0.6rem;
		bottom: 0;
		height: 2px;
		overflow: hidden;
		border-radius: var(--radius-full);
		pointer-events: none;
	}

	.shimmer::before {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(90deg, transparent, var(--color-accent), transparent);
		transform: translateX(-100%);
		animation: key-sweep 1.15s ease-in-out infinite;
	}

	@keyframes key-sweep {
		to {
			transform: translateX(100%);
		}
	}

	.status-line {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-ui);
		font-size: 0.76rem;
		margin: -0.15rem 0 0;
	}

	.status-line.muted {
		color: var(--color-text-muted);
	}

	.status-line.err {
		color: var(--color-error);
	}

	/* Follows the red verdict without competing with it: the diagnosis is the loud half,
	   this is only what to do next. Indented under the warning icon it answers. */
	.status-hint {
		margin: -0.25rem 0 0;
		padding-left: 1.15rem;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		color: var(--color-text-muted);
	}

	/* ===== Ledger ===== */
	.ledger {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.75rem 0.8rem;
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 65%, transparent);
		background: color-mix(in srgb, var(--color-bg-secondary) 60%, transparent);
	}

	.identity {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex-wrap: wrap;
	}

	.dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: var(--radius-full);
		flex-shrink: 0;
	}

	.dot-ok {
		background: var(--color-success);
		box-shadow: 0 0 10px color-mix(in srgb, var(--color-success) 60%, transparent);
	}

	.dot-warn {
		background: var(--color-warning);
		box-shadow: 0 0 10px color-mix(in srgb, var(--color-warning) 60%, transparent);
	}

	.dot-error {
		background: var(--color-error);
		box-shadow: 0 0 10px color-mix(in srgb, var(--color-error) 60%, transparent);
	}

	.dot-idle {
		background: var(--color-text-muted);
	}

	.fingerprint {
		font-family: var(--font-mono);
		font-size: 0.76rem;
		color: var(--color-text-secondary);
		padding: 0.12rem 0.45rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 55%, transparent);
	}

	.fingerprint.muted {
		color: var(--color-text-muted);
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: auto;
		padding: 0.12rem 0.5rem;
		border-radius: var(--radius-full);
		background: var(--color-accent-muted);
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 650;
	}

	.budget {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.budget-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.budget-left {
		font-family: var(--font-mono);
		font-size: 0.92rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.budget-cap {
		font-family: var(--font-mono);
		font-size: 0.74rem;
		color: var(--color-text-muted);
	}

	.meter {
		height: 0.4rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-bg-tertiary) 90%, transparent);
		overflow: hidden;
	}

	.meter-fill {
		height: 100%;
		border-radius: var(--radius-full);
		background: var(--color-accent);
		box-shadow: 0 0 8px color-mix(in srgb, var(--color-accent) 45%, transparent);
		transition: width 600ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.meter-fill.low {
		background: var(--color-warning);
		box-shadow: 0 0 8px color-mix(in srgb, var(--color-warning) 45%, transparent);
	}

	.budget-note {
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.budget-flat {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.nocap {
		font-family: var(--font-ui);
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.balance {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-text-primary);
	}

	.spend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.spend-chip {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		padding: 0.15rem 0.45rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
	}

	.spend-chip b {
		color: var(--color-text-muted);
		font-weight: 600;
		margin-right: 0.2rem;
	}

	.ledger-warn {
		font-family: var(--font-ui);
		font-size: 0.74rem;
		line-height: 1.45;
		color: var(--color-warning);
		margin: 0;
	}

	.ledger-warn.soft {
		color: var(--color-text-muted);
	}

	.ledger-warn code {
		font-family: var(--font-mono);
		font-size: 0.92em;
		padding: 0.02rem 0.25rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
	}

	.connected {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-text-secondary);
	}
</style>
