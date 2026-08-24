<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import type { ModelInfo } from '$lib/types/llm';
	import { formatPricePerMillion, formatContext, modelVendor, vendorLabel } from '$lib/utils/modelFormat';

	type SortMode = 'relevance' | 'name' | 'priceAsc' | 'contextDesc' | 'newest';

	interface Props {
		id?: string;
		models: ModelInfo[];
		value: string;
		loading?: boolean;
		emptyHint?: string;
		/** Model ids that have OpenRouter routing configured (drives the route badge). */
		routedModels?: Set<string>;
		onpick: (id: string) => void;
		/** When set, a "Routing" affordance is shown for the selected model. */
		onConfigureRouting?: (id: string) => void;
	}

	let {
		id,
		models,
		value,
		loading = false,
		emptyHint = 'No models available.',
		routedModels,
		onpick,
		onConfigureRouting
	}: Props = $props();

	let open = $state(false);
	let search = $state('');
	let highlighted = $state(-1);
	let sortMode = $state<SortMode>('relevance');
	let grouped = $state(false);

	let inputEl = $state<HTMLInputElement | null>(null);
	let dropdownEl = $state<HTMLDivElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);

	const SORTS: { mode: SortMode; label: string }[] = [
		{ mode: 'relevance', label: 'Default' },
		{ mode: 'name', label: 'Name' },
		{ mode: 'priceAsc', label: 'Price' },
		{ mode: 'contextDesc', label: 'Context' },
		{ mode: 'newest', label: 'New' }
	];

	function matchesSearch(m: ModelInfo, query: string): boolean {
		const haystack = `${m.id} ${m.name ?? ''}`.toLowerCase();
		const tokens = query.toLowerCase().split(/[\s\-\/]+/).filter(Boolean);
		return tokens.every((t) => haystack.includes(t));
	}

	const filtered = $derived(search.trim() ? models.filter((m) => matchesSearch(m, search)) : models);

	const sorted = $derived.by(() => {
		const list = [...filtered];
		switch (sortMode) {
			case 'name':
				return list.sort((a, b) => a.id.localeCompare(b.id));
			case 'priceAsc':
				return list.sort((a, b) => (a.pricing?.completion ?? Infinity) - (b.pricing?.completion ?? Infinity));
			case 'contextDesc':
				return list.sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
			case 'newest':
				return list.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
			default:
				return list;
		}
	});

	// Flat list (for keyboard nav) + interleaved rows (for rendering group headers).
	type Row = { kind: 'header'; label: string } | { kind: 'model'; model: ModelInfo; index: number };

	const view = $derived.by(() => {
		if (!grouped) {
			const rows: Row[] = sorted.map((model, index) => ({ kind: 'model', model, index }));
			return { visible: sorted, rows };
		}
		const groups = new Map<string, ModelInfo[]>();
		for (const m of sorted) {
			const v = modelVendor(m.id);
			(groups.get(v) ?? groups.set(v, []).get(v)!).push(m);
		}
		const visible: ModelInfo[] = [];
		const rows: Row[] = [];
		for (const [vendor, list] of groups) {
			rows.push({ kind: 'header', label: vendorLabel(vendor) });
			for (const m of list) {
				rows.push({ kind: 'model', model: m, index: visible.length });
				visible.push(m);
			}
		}
		return { visible, rows };
	});

	const selectedInfo = $derived(models.find((m) => m.id === value));
	const hasRouting = $derived(!!value && !!routedModels?.has(value));

	/**
	 * The typed text, offered verbatim as a model id. A list is not the whole truth
	 * anywhere: an endpoint can serve /chat/completions and no /models at all, a
	 * gateway can accept ids it never advertises, and OpenRouter's `:nitro`/`:floor`
	 * shortcuts work on any model without being listed. Null once the text matches a
	 * listed id exactly, since picking that row is the same act. Model ids are
	 * case-sensitive, so the comparison is too.
	 */
	const customId = $derived.by(() => {
		const typed = search.trim();
		return typed && !models.some((m) => m.id === typed) ? typed : null;
	});

	// The custom entry is keyboard-reachable as one more index past the listed models,
	// while rendering outside the scrolling list (see the pinned row below).
	const customIndex = $derived(view.visible.length);
	const navCount = $derived(view.visible.length + (customId ? 1 : 0));

	function pick(modelId: string): void {
		search = '';
		open = false;
		highlighted = -1;
		onpick(modelId);
	}

	function pickCustom(): void {
		if (customId) pick(customId);
	}

	function scrollHighlightedIntoView(): void {
		if (!listEl || highlighted < 0) return;
		const node = listEl.querySelector(`[data-index="${highlighted}"]`) as HTMLElement | null;
		node?.scrollIntoView({ block: 'nearest' });
	}

	function handleKeydown(e: KeyboardEvent): void {
		// Mid-composition Enter closes the IME candidate, it does not choose a model:
		// acting on it would commit a half-composed string as a model id.
		if (e.isComposing) return;
		if (!open) {
			if (e.key === 'ArrowDown' || e.key === 'Enter') {
				open = true;
				highlighted = 0;
				e.preventDefault();
			}
			return;
		}
		const last = navCount - 1;
		if (e.key === 'ArrowDown') {
			highlighted = Math.min(highlighted + 1, last);
			scrollHighlightedIntoView();
			e.preventDefault();
		} else if (e.key === 'ArrowUp') {
			highlighted = Math.max(highlighted - 1, 0);
			scrollHighlightedIntoView();
			e.preventDefault();
		} else if (e.key === 'Enter' && highlighted >= 0) {
			// Read the id before pick() clears the search the custom entry is derived from.
			const id = customId && highlighted === customIndex ? customId : view.visible[highlighted]?.id;
			if (id) {
				pick(id);
				inputEl?.blur();
				e.preventDefault();
			}
		} else if (e.key === 'Escape') {
			// Consume the press so the workspace's global Esc doesn't also close
			// the hosting Settings panel.
			e.preventDefault();
			e.stopPropagation();
			open = false;
			search = '';
			highlighted = -1;
			inputEl?.blur();
		}
	}

	function badges(m: ModelInfo): {
		price: string | null;
		ctx: string | null;
		vision: boolean;
		tools: boolean;
		reasoning: boolean;
		moderated: boolean;
	} {
		return {
			price: formatPricePerMillion(m.pricing?.completion),
			ctx: formatContext(m.contextLength),
			vision: !!m.inputModalities?.includes('image'),
			tools: !!m.supportedParameters?.includes('tools'),
			reasoning: !!m.isReasoning,
			moderated: m.isModerated === true
		};
	}

	// Close on outside click.
	$effect(() => {
		function onClick(e: MouseEvent): void {
			const target = e.target as Node;
			if (open && dropdownEl && inputEl && !dropdownEl.contains(target) && !inputEl.contains(target)) {
				open = false;
				search = '';
			}
		}
		document.addEventListener('mousedown', onClick);
		return () => document.removeEventListener('mousedown', onClick);
	});
</script>

<div class="picker">
	<div class="input-row">
		<div class="input-wrap">
			<Icon name="search" class="search-icon" />
			<input
				bind:this={inputEl}
				{id}
				type="text"
				class="input-base search-input"
				class:has-routing-btn={!!onConfigureRouting && !!value}
				placeholder={loading ? 'Loading models…' : value && !open ? '' : 'Search or type a model id…'}
				value={open ? search : ''}
				disabled={loading}
				onfocus={() => {
					open = true;
					highlighted = -1;
				}}
				oninput={(e) => {
					search = (e.target as HTMLInputElement).value;
					highlighted = 0;
				}}
				onkeydown={handleKeydown}
				autocomplete="off"
				autocapitalize="off"
				autocorrect="off"
				spellcheck="false"
			/>
			{#if !open && value}
				<span class="selected-label">
					{selectedInfo?.name ?? value}
					{#if hasRouting}
						<Icon name="pin" class="routing-dot" strokeWidth={2.25} />
					{/if}
				</span>
			{/if}
		</div>
		{#if onConfigureRouting && value}
			<button
				type="button"
				class="routing-btn"
				class:active={hasRouting}
				onclick={() => onConfigureRouting?.(value)}
				title="Configure provider routing for this model"
			>
				<Icon name="radar" class="w-4 h-4" strokeWidth={1.75} />
				<span>Routing</span>
			</button>
		{/if}
	</div>

	{#if open}
		<div bind:this={dropdownEl} class="dropdown surface-float" role="listbox">
			<div class="toolbar">
				<div class="sorts">
					{#each SORTS as s (s.mode)}
						<button
							type="button"
							class="sort-chip"
							class:active={sortMode === s.mode}
							onclick={() => (sortMode = s.mode)}
						>
							{s.label}
						</button>
					{/each}
				</div>
				<button
					type="button"
					class="group-toggle"
					class:active={grouped}
					onclick={() => (grouped = !grouped)}
					title="Group by vendor"
				>
					<Icon name="folder" class="w-3.5 h-3.5" strokeWidth={1.75} />
					Group
				</button>
			</div>

			<div bind:this={listEl} class="list">
				{#if view.visible.length === 0}
					<!-- The pinned row below already answers "nothing matched", so the message
					     stays out of its way and only speaks when there is nothing typed. -->
					{#if !customId}
						<div class="empty">
							{#if models.length === 0}
								{emptyHint}
							{:else}
								No models match "{search}"
							{/if}
						</div>
					{/if}
				{:else}
					{#each view.rows as row (row.kind === 'header' ? `h:${row.label}` : row.model.id)}
						{#if row.kind === 'header'}
							<div class="group-header surface-float">{row.label}</div>
						{:else}
							{@const b = badges(row.model)}
							<button
								type="button"
								class="option"
								class:highlighted={row.index === highlighted}
								class:selected={row.model.id === value}
								data-index={row.index}
								role="option"
								aria-selected={row.model.id === value}
								onmouseenter={() => (highlighted = row.index)}
								onclick={() => pick(row.model.id)}
							>
								<div class="option-main">
									<span class="option-name">{row.model.name ?? row.model.id}</span>
									{#if row.model.name}
										<span class="option-id">{row.model.id}</span>
									{/if}
								</div>
								<div class="option-meta">
									{#if routedModels?.has(row.model.id)}
										<Icon name="pin" class="meta-route" strokeWidth={2.25} />
									{/if}
									{#if b.vision}
										<span class="badge badge-icon" title="Vision"><Icon name="image" class="w-3 h-3" strokeWidth={2} /></span>
									{/if}
									{#if b.tools}
										<span class="badge badge-icon" title="Tools"><Icon name="wrench" class="w-3 h-3" strokeWidth={2} /></span>
									{/if}
									{#if b.reasoning}
										<span class="badge badge-icon badge-reason" title="Reasoning model"><Icon name="sparkles" class="w-3 h-3" strokeWidth={2} /></span>
									{/if}
									{#if b.moderated}
										<span class="badge badge-icon" title="Moderated by the default route"><Icon name="lock" class="w-3 h-3" strokeWidth={2} /></span>
									{/if}
									{#if b.ctx}
										<span class="badge">{b.ctx}</span>
									{/if}
									{#if b.price}
										<span class="badge badge-price" class:free={b.price === 'Free'}>{b.price}</span>
									{/if}
									{#if row.model.id === value}
										<Icon name="check" class="w-3.5 h-3.5 text-accent shrink-0" />
									{/if}
								</div>
							</button>
						{/if}
					{/each}
				{/if}
			</div>

			<!-- Pinned outside the scrolling list on purpose: at the bottom of a few hundred
			     matches nobody would ever meet an affordance they don't know exists. -->
			{#if customId}
				<button
					type="button"
					class="custom-row"
					class:highlighted={highlighted === customIndex}
					role="option"
					aria-selected={customId === value}
					onmouseenter={() => (highlighted = customIndex)}
					onclick={pickCustom}
				>
					<Icon name="plus" class="custom-icon" strokeWidth={2} />
					<span class="custom-text">Use <span class="custom-id">{customId}</span></span>
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.picker {
		position: relative;
	}

	.input-row {
		display: flex;
		align-items: stretch;
		gap: 0.5rem;
	}

	.input-wrap {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1;
		min-width: 0;
	}

	.input-wrap :global(.search-icon) {
		position: absolute;
		left: 0.75rem;
		width: 1rem;
		height: 1rem;
		color: var(--color-text-muted);
		pointer-events: none;
		z-index: 1;
	}

	.search-input {
		width: 100%;
		padding: 0.55rem 0.75rem 0.55rem 2.25rem;
		font-size: 0.8125rem;
		font-family: var(--font-ui);
		color: var(--color-text-primary);
	}

	.search-input.has-routing-btn {
		padding-right: 0.75rem;
	}

	.search-input::placeholder {
		color: var(--color-text-muted);
	}

	.selected-label {
		position: absolute;
		left: 2.25rem;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-family: var(--font-ui);
		font-size: 0.8125rem;
		color: var(--color-text-primary);
		pointer-events: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: calc(100% - 3rem);
	}

	.selected-label :global(.routing-dot) {
		width: 0.85rem;
		height: 0.85rem;
		color: var(--color-accent);
		flex-shrink: 0;
	}

	.routing-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0 0.7rem;
		border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-secondary) 80%, transparent);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.75rem;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition: all 100ms ease;
	}

	.routing-btn:hover {
		color: var(--color-text-primary);
		border-color: var(--color-border);
	}

	.routing-btn.active {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
	}

	/* Floating menu over panel content, carrying .surface-float in markup. */
	.dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		z-index: 50;
		overflow: hidden;
	}

	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid color-mix(in srgb, var(--color-border-subtle) 60%, transparent);
		background: color-mix(in srgb, var(--color-bg-secondary) 50%, transparent);
	}

	.sorts {
		display: flex;
		gap: 0.2rem;
		flex-wrap: wrap;
	}

	.sort-chip {
		padding: 0.2rem 0.5rem;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 90ms ease;
	}

	.sort-chip:hover {
		color: var(--color-text-secondary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
	}

	.sort-chip.active {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
	}

	.group-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.2rem 0.5rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 90ms ease;
	}

	.group-toggle:hover {
		color: var(--color-text-secondary);
	}

	.group-toggle.active {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
	}

	.list {
		max-height: 280px;
		overflow-y: auto;
		padding: 0.25rem;
	}

	.empty {
		padding: 0.75rem 0.6rem;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--color-text-muted);
		text-align: center;
	}

	.group-header {
		padding: 0.4rem 0.6rem 0.2rem;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
		position: sticky;
		top: 0;
		/* Options scroll beneath this sticky header: .surface-float in markup backs
		   it with the float tier + blur; the recipe's border is unwanted here. */
		border: 0;
	}

	.option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		width: 100%;
		padding: 0.4rem 0.6rem;
		border: none;
		border-radius: calc(var(--radius-md) - 2px);
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background 80ms ease;
	}

	.option:hover,
	.option.highlighted {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
	}

	.option.selected {
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	.option.selected.highlighted {
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
	}

	.option-main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 0.1rem;
	}

	.option-name {
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.option-id {
		font-family: var(--font-mono);
		font-size: 0.66rem;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.option-meta {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	/* Sits under the list rather than in it, so it survives any amount of scrolling.
	   Quieter than a match: this is the way out when the list has no answer, not a
	   result competing with the ones above it. */
	.custom-row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		width: 100%;
		padding: 0.5rem 0.7rem;
		border: none;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 60%, transparent);
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background 80ms ease;
	}

	.custom-row:hover,
	.custom-row.highlighted {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
	}

	.custom-row :global(.custom-icon) {
		width: 0.85rem;
		height: 0.85rem;
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	.custom-text {
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--color-text-muted);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.custom-id {
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--color-text-primary);
	}

	.option-meta :global(.meta-route) {
		width: 0.8rem;
		height: 0.8rem;
		color: var(--color-accent);
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		padding: 0.1rem 0.35rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
		color: var(--color-text-secondary);
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 500;
		white-space: nowrap;
	}

	.badge-icon {
		padding: 0.15rem;
		color: var(--color-text-muted);
	}

	.badge-reason {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
	}

	.badge-price {
		color: var(--color-text-secondary);
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
	}

	.badge-price.free {
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 16%, transparent);
	}
</style>
