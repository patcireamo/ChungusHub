<script lang="ts">
	/**
	 * What a picked SillyTavern profile holds, and which of it is coming over.
	 *
	 * **This is the found list, not a second screen.** The card already had to say what was in
	 * the folder before anything was written, so the counts were on screen either way; each one
	 * gains a box and a way to open it. Everything starts on, every group starts closed, and a
	 * reader who wants the whole profile presses Import without touching this at all. That
	 * ordering is the feature: narrowing is free to reach and free to ignore.
	 *
	 * **A group's own box always means the whole group**, filtered view or not. Making it mean
	 * "the rows I can currently see" is what every file manager does and it is exactly why those
	 * checkboxes are untrustworthy: the same click means different things depending on what is
	 * typed in a box somewhere else. The filter finds a row; the box decides one.
	 *
	 * **Unticking never removes a row.** The card draws everything on offer and says off with a
	 * box, since a row that vanished under the pointer would take its own way back with it.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import TriTick from './TriTick.svelte';
	import { importRun } from '$lib/stores/import-run.svelte';
	import type { PlanGroup, PlanGroupId, PlanItem } from '$lib/services/sillyTavernFolderScan';

	interface Props {
		/** The picked folder's own name, so the heading says which library this is. */
		root: string;
	}

	let { root }: Props = $props();

	/** Below this a list is short enough to read whole, and a filter is a control that costs
	 *  more attention than the scrolling it saves. */
	const FILTER_FROM = 8;

	let open = $state<Set<PlanGroupId>>(new Set());
	let filters = $state<Partial<Record<PlanGroupId, string>>>({});

	let groups = $derived(importRun.groups);

	function toggleOpen(id: PlanGroupId): void {
		const next = new Set(open);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		open = next;
	}

	/**
	 * How many files each group holds, and which group each key belongs to. Both are read off
	 * the rows once per pick rather than per render: a real profile is thousands of files, and
	 * the counts below have to be right after every single tick.
	 */
	let sizes = $derived.by(() => {
		const total = new Map<PlanGroupId, number>();
		const groupOfKey = new Map<string, PlanGroupId>();
		for (const group of groups) {
			let count = 0;
			for (const item of group.items) {
				for (const key of item.keys) {
					groupOfKey.set(key, group.id);
					count++;
				}
			}
			total.set(group.id, count);
		}
		return { total, groupOfKey };
	});

	/** Counted by walking what is switched OFF, which is almost always the short list, instead
	 *  of asking every file in the folder whether it still counts. */
	let offPerGroup = $derived.by(() => {
		const off = new Map<PlanGroupId, number>();
		for (const key of importRun.excluded) {
			const id = sizes.groupOfKey.get(key);
			if (id) off.set(id, (off.get(id) ?? 0) + 1);
		}
		return off;
	});

	function totalIn(group: PlanGroup): number {
		return sizes.total.get(group.id) ?? 0;
	}

	function chosenIn(group: PlanGroup): number {
		return totalIn(group) - (offPerGroup.get(group.id) ?? 0);
	}

	/** One key answers for the row: `setKeys` and `setAll` are the only writers and both move a
	 *  row's whole key list, so a sprite pack half switched off cannot exist. */
	function itemOn(item: PlanItem): boolean {
		return !importRun.excluded.has(item.keys[0]);
	}

	function visibleItems(group: PlanGroup): PlanItem[] {
		const query = (filters[group.id] ?? '').trim().toLowerCase();
		if (!query) return group.items;
		return group.items.filter((item) => item.label.toLowerCase().includes(query));
	}

	/**
	 * The one thing this card can say while it is still worth acting on: something ticked needs
	 * a character that is not. Every word of it has to survive a glance, so it names the cause
	 * and the fix and stops. Its counterpart, a chat folder whose character is nowhere in the
	 * profile, is deliberately silent here: nothing on this card would switch it on, and a
	 * warning nobody can answer is the noise that teaches people to skip warnings.
	 */
	let stranded = $derived(importRun.stranded);
	let strandedNote = $derived.by(() => {
		const { chats, sprites } = stranded;
		if (chats === 0 && sprites === 0) return '';
		const parts: string[] = [];
		if (chats > 0) parts.push(`${chats} chat${chats === 1 ? '' : 's'}`);
		if (sprites > 0) parts.push(`${sprites} sprite pack${sprites === 1 ? '' : 's'}`);
		return `${parts.join(' and ')} belong to characters you switched off. They are skipped unless you switch those characters back on.`;
	});
</script>

<div class="plan">
	<div class="plan-head">
		<span class="section-label">Found in {root || 'the folder you picked'}</span>
		{#if groups.length > 0}
			<div class="plan-bulk font-ui">
				<button type="button" onclick={() => importRun.setAll(true)}>Select all</button>
				<button type="button" onclick={() => importRun.setAll(false)}>Select none</button>
			</div>
		{/if}
	</div>

	{#if groups.length === 0}
		<p class="empty font-ui">Every file in there has come over already</p>
	{/if}

	<ul class="groups">
		{#each groups as group (group.id)}
			{@const total = totalIn(group)}
			{@const chosen = chosenIn(group)}
			{@const isOpen = open.has(group.id)}
			{@const shown = visibleItems(group)}
			<li class="group">
				<div class="group-row">
					<TriTick
						{chosen}
						{total}
						label="Import {group.label.toLowerCase()}"
						onchange={(on) => {
							for (const item of group.items) importRun.setKeys(item.keys, on);
						}}
					/>
					<button
						type="button"
						class="group-open font-ui"
						aria-expanded={isOpen}
						onclick={() => toggleOpen(group.id)}
					>
						<Icon name="chevronDown" class="w-3.5 h-3.5 chev {isOpen ? 'is-open' : ''}" />
						<span class="group-label">{group.label}</span>
						<!-- The full count stays put and the chosen one leads, so a group half
						     switched off reads as a fraction of something rather than as a number
						     that shrank while nobody was looking. -->
						<span class="group-count">{chosen === total ? total : `${chosen} of ${total}`}</span>
					</button>
				</div>

				{#if isOpen}
					<div class="group-body">
						{#if group.items.length >= FILTER_FROM}
							<input
								type="search"
								class="input-base item-filter font-ui"
								placeholder="Filter {group.label.toLowerCase()}…"
								bind:value={
									() => filters[group.id] ?? '',
									(v) => (filters = { ...filters, [group.id]: v })
								}
							/>
						{/if}

						{#if shown.length === 0}
							<p class="empty font-ui">Nothing matches that</p>
						{:else}
							<ul class="items">
								{#each shown as item (item.id)}
									<li>
										<label class="item font-ui">
											<input
												type="checkbox"
												class="tick"
												checked={itemOn(item)}
												onchange={(e) => importRun.setKeys(item.keys, e.currentTarget.checked)}
											/>
											<span class="item-label">{item.label}</span>
											{#if item.keys.length > 1}
												<span class="item-count">{item.keys.length}</span>
											{/if}
										</label>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	{#if strandedNote}
		<p class="stranded font-ui">{strandedNote}</p>
	{/if}
</div>

<style>
	.plan {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 100%;
	}

	.plan-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.plan-bulk {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.72rem;
	}

	.plan-bulk button {
		padding: 0.2rem 0.5rem;
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
		border-radius: var(--radius-sm);
		background: none;
		color: var(--color-text-secondary);
		font: inherit;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.plan-bulk button:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.groups,
	.items {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.groups {
		gap: 0.15rem;
	}

	.group-row {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.1rem 0.15rem;
		border-radius: var(--radius-md);
	}

	.group-row:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
	}

	/* The whole label is the disclosure, so opening a group is the same easy target as reading
	   its name. The box beside it is the only thing that decides anything. */
	.group-open {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
		padding: 0.3rem 0.15rem;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.group-open :global(.chev) {
		flex-shrink: 0;
		color: var(--color-text-muted);
		transform: rotate(-90deg);
		transition: transform 140ms ease;
	}

	.group-open :global(.chev.is-open) {
		transform: rotate(0deg);
	}

	.group-label {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.group-count {
		margin-left: auto;
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* Indented under the chevron so the nesting is read off the same edge the arrow points
	   down, and railed so a long list keeps its parent in view. */
	.group-body {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0.2rem 0 0.5rem 0.75rem;
		padding-left: 0.85rem;
		border-left: 1px solid color-mix(in srgb, var(--color-border-subtle) 60%, transparent);
	}

	.item-filter {
		width: 100%;
		padding: 0.3rem 0.55rem;
		font-size: 0.75rem;
	}

	.items {
		gap: 0.05rem;
		max-height: 15rem;
		overflow-y: auto;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.25rem 0.3rem 0.25rem 0.15rem;
		border-radius: var(--radius-sm);
		font-size: 0.78rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.item:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
	}

	.item-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.item-count {
		margin-left: auto;
		flex-shrink: 0;
		font-size: 0.72rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.tick {
		flex-shrink: 0;
		accent-color: var(--color-accent);
		cursor: pointer;
	}

	.empty {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.stranded {
		margin: 0.15rem 0 0;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--color-warning);
	}
</style>
