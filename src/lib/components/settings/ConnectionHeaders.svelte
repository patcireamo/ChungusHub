<script lang="ts">
	import { tick, untrack } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import { readHeaderRows, type ConnectionHeaders, type HeaderRow } from '$shared/connection-headers';

	interface Props {
		/** What is stored. Read once at mount: from then on the rows are the draft. */
		headers: ConnectionHeaders;
		onsave: (headers: ConnectionHeaders) => Promise<void>;
	}

	let { headers, onsave }: Props = $props();

	let rows = $state<HeaderRow[]>(untrack(() => Object.entries(headers).map(([name, value]) => ({ name, value }))));
	let lastSaved = untrack(() => JSON.stringify(headers));
	let showValues = $state(false);
	let saveError = $state('');
	let listEl = $state<HTMLDivElement | null>(null);

	const read = $derived(readHeaderRows(rows));
	const problem = $derived('error' in read ? read.error : saveError);
	const hasValues = $derived(rows.some((r) => r.value));

	let saving = Promise.resolve();

	// Saved on commit (blur, Enter, remove), never per keystroke, and only whole: while any
	// row is wrong nothing is written, so the last good set keeps going out. Chained so two
	// quick commits cannot land on the server in the wrong order.
	function commit(): void {
		saving = saving.then(save);
	}

	async function save(): Promise<void> {
		if ('error' in read) return;
		const next = JSON.stringify(read.headers);
		if (next === lastSaved) return;
		saveError = '';
		try {
			await onsave(read.headers);
			lastSaved = next;
		} catch (e) {
			saveError = e instanceof Error ? e.message : String(e);
		}
	}

	async function addRow(): Promise<void> {
		rows.push({ name: '', value: '' });
		await tick();
		listEl?.querySelector<HTMLInputElement>('.header-row:last-child .header-name')?.focus();
	}

	function removeRow(index: number): void {
		rows.splice(index, 1);
		commit();
	}
</script>

<div class="head">
	<span class="section-label">Headers</span>
	<InfoTip
		text="Sent with every request to this server, the model list included. A header named like one the app sends itself, such as Authorization, replaces it."
	/>
	{#if hasValues}
		<button type="button" class="micro-btn" onclick={() => (showValues = !showValues)}>
			{showValues ? 'Hide values' : 'Show values'}
		</button>
	{/if}
</div>

{#if rows.length}
	<div class="rows" bind:this={listEl}>
		{#each rows as row, i}
			<div class="header-row">
				<input
					type="text"
					class="input-base header-name"
					bind:value={row.name}
					onchange={commit}
					placeholder="Name"
					aria-label="Header name"
					spellcheck="false"
					autocomplete="off"
				/>
				<input
					type={showValues ? 'text' : 'password'}
					class="input-base header-value"
					bind:value={row.value}
					onchange={commit}
					placeholder="Value"
					aria-label={row.name.trim() ? `Value of ${row.name.trim()}` : 'Header value'}
					spellcheck="false"
					autocomplete="off"
					data-1p-ignore
					data-lpignore="true"
				/>
				<button
					type="button"
					class="remove-btn"
					onclick={() => removeRow(i)}
					aria-label={row.name.trim() ? `Remove ${row.name.trim()}` : 'Remove header'}
				>
					<Icon name="close" class="w-3.5 h-3.5" strokeWidth={2} />
				</button>
			</div>
		{/each}
	</div>
{/if}

{#if problem}
	<p class="problem">Not saved: {problem}</p>
{/if}

<button type="button" class="add-btn" onclick={addRow}>
	<Icon name="plus" class="w-3.5 h-3.5" strokeWidth={2} />
	Add header
</button>

<style>
	.head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.micro-btn {
		margin-left: auto;
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

	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	/* Name narrower than value: a name is a short token, a value is often a key. minmax(0, …)
	   lets both shrink below their intrinsic input width on a phone instead of overflowing. */
	.header-row {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto;
		align-items: center;
		gap: 0.35rem;
	}

	.header-name,
	.header-value {
		width: 100%;
		min-width: 0;
		padding: 0.45rem 0.6rem;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		color: var(--color-text-primary);
	}

	.remove-btn {
		display: inline-grid;
		place-items: center;
		width: 1.8rem;
		height: 1.8rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.remove-btn:hover {
		background: color-mix(in srgb, var(--color-error) 14%, transparent);
		color: var(--color-error);
	}

	.problem {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		color: var(--color-warning);
	}

	.add-btn {
		display: inline-flex;
		align-items: center;
		align-self: flex-start;
		gap: 0.4rem;
		padding: 0.2rem 0;
		border: 0;
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: color 120ms ease;
	}

	.add-btn:hover {
		color: var(--color-accent);
	}
</style>
