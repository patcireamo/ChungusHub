<script lang="ts">
	/**
	 * Suggested Prompts: the tappable lines the assistant's empty screen offers, in the order
	 * it offers them. Content only; the view chrome lives in AssistantSettingsView.
	 *
	 * The list itself belongs to assistantSessionStore, which the empty screen reads too, so a
	 * save shows there at once. The whole list is one settings row, so every save writes all of
	 * it: a text edit commits on blur and a structural one (add, delete, move) commits at once,
	 * which keeps the window in which another device's write could land on a draft short.
	 */
	import { onMount, tick, untrack } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import {
		DEFAULT_SUGGESTED_PROMPTS,
		SUGGESTED_PROMPTS_COLLAPSED,
		SUGGESTED_PROMPT_MAX_LENGTH
	} from '$lib/config/assistant-suggestions';
	import { assistantSessionStore } from '$lib/stores/assistantSessions.svelte';

	/** Rows carry an id of their own so reordering one never re-keys the rest under a cursor. */
	interface Row {
		id: string;
		text: string;
	}

	let rows = $state<Row[]>([]);
	/** The list the rows were built from, and the only thing a save compares against: measure
	 *  against the live store instead and another device's write reads as something typed here. */
	let saved = $state<string[]>([]);
	let listEl = $state<HTMLDivElement | null>(null);

	function toRows(list: string[]): Row[] {
		return list.map((text) => ({ id: crypto.randomUUID(), text }));
	}

	function same(a: string[], b: string[]): boolean {
		return a.length === b.length && a.every((t, i) => t === b[i]);
	}

	/** What a save would store: trimmed, with the blank rows dropped. */
	function payload(): string[] {
		return rows.map((r) => r.text.trim()).filter((t) => t.length > 0);
	}

	/** A blank row counts as a change, which is what keeps a refresh from clearing one away. */
	function dirty(): boolean {
		return !same(
			rows.map((r) => r.text.trim()),
			saved
		);
	}

	// The stored list: the first read when this page opens, and any later write from another
	// device. Untracked inside, so writing the rows cannot re-run it; skipped when the change
	// is the one just made here, and while anything on the page is half-typed.
	$effect(() => {
		const stored = assistantSessionStore.suggestedPrompts;
		untrack(() => {
			if (same(stored, saved) || dirty()) return;
			rows = toRows(stored);
			saved = [...stored];
		});
	});

	async function commit(): Promise<void> {
		const next = payload();
		if (same(next, saved)) return;
		saved = next;
		await assistantSessionStore.saveSuggestedPrompts(next);
	}

	function move(index: number, delta: number): void {
		const target = index + delta;
		if (target < 0 || target >= rows.length) return;
		const next = [...rows];
		[next[index], next[target]] = [next[target], next[index]];
		rows = next;
		void commit();
	}

	function remove(index: number): void {
		rows = rows.filter((_, i) => i !== index);
		void commit();
	}

	async function add(): Promise<void> {
		rows = [...rows, { id: crypto.randomUUID(), text: '' }];
		await tick();
		const inputs = listEl?.querySelectorAll('input');
		inputs?.[inputs.length - 1]?.focus();
	}

	/** The shipped set is always one press away, and it only ever ADDS: a list the user has
	 *  rewritten is never overwritten to hand back a default they can already read here. */
	let missingDefaults = $derived(
		DEFAULT_SUGGESTED_PROMPTS.filter((d) => !rows.some((r) => r.text.trim() === d))
	);

	function addDefaults(): void {
		rows = [...rows, ...toRows(missingDefaults)];
		void commit();
	}

	// Escape, Back and minimizing the widget all take the view away without the focused input
	// ever blurring, and a removed element fires no blur: without this the edit being typed at
	// that moment is the one edit that never reaches disk.
	onMount(() => () => void commit());
</script>

<div class="sug-list" bind:this={listEl}>
	{#each rows as row, i (row.id)}
		<div class="sug-row">
			<input
				class="sug-input"
				bind:value={row.text}
				onblur={() => void commit()}
				maxlength={SUGGESTED_PROMPT_MAX_LENGTH}
				placeholder="What should this one ask for?"
				aria-label="Suggested prompt {i + 1}"
			/>
			<div class="sug-actions">
				<button
					type="button"
					class="sug-icon-btn"
					onclick={() => move(i, -1)}
					disabled={i === 0}
					aria-label="Move up"
				>
					<Icon name="chevronUp" class="w-3.5 h-3.5" />
				</button>
				<button
					type="button"
					class="sug-icon-btn"
					onclick={() => move(i, 1)}
					disabled={i === rows.length - 1}
					aria-label="Move down"
				>
					<Icon name="chevronDown" class="w-3.5 h-3.5" />
				</button>
				<button
					type="button"
					class="sug-icon-btn sug-icon-btn--danger"
					onclick={() => remove(i)}
					aria-label="Delete prompt"
				>
					<Icon name="trash" class="w-3.5 h-3.5" />
				</button>
			</div>
		</div>
		{#if i === SUGGESTED_PROMPTS_COLLAPSED - 1 && rows.length > SUGGESTED_PROMPTS_COLLAPSED}
			<!-- Where the empty screen's own fold falls, wearing the chevron of the button that
			     opens it. Named rather than hidden from readers: it is the only thing on the page
			     that says which of these rows are the ones met without a press. -->
			<div class="sug-fold">
				<span class="sug-fold-chip">
					<Icon name="chevronDown" class="w-3 h-3" />
					Behind Show more
				</span>
			</div>
		{/if}
	{/each}
</div>

{#if rows.length === 0}
	<p class="sug-note">No suggestions, so the assistant's empty screen offers none.</p>
{/if}

<div class="sug-toolbar">
	<button type="button" class="sug-ghost-btn" onclick={add}>
		<Icon name="plus" class="w-3.5 h-3.5" />
		Add prompt
	</button>
	<button
		type="button"
		class="sug-ghost-btn"
		onclick={addDefaults}
		disabled={missingDefaults.length === 0}
	>
		<Icon name="restore" class="w-3.5 h-3.5" />
		Add defaults
	</button>
</div>

<style>
	.sug-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.sug-row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}

	.sug-input {
		flex: 1;
		min-width: 0;
		padding: 0.45rem 0.6rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		font-family: var(--font-ui);
		font-size: 0.78rem;
	}

	.sug-input:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
	}

	.sug-input:disabled {
		opacity: 0.6;
	}

	.sug-actions {
		display: flex;
		flex-shrink: 0;
		gap: 0.1rem;
	}

	/* Set apart from the arrows it sits beside: at this size a thumb aiming for Move down
	   lands on whatever is next to it, and only one of these is a deletion. */
	.sug-actions .sug-icon-btn--danger {
		margin-left: 0.25rem;
	}

	.sug-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		border-radius: var(--radius-sm);
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.sug-icon-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
		color: var(--color-text-primary);
	}

	.sug-icon-btn--danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-error) 14%, transparent);
		color: var(--color-error);
	}

	.sug-icon-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.sug-fold {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.25rem 0;
		color: var(--color-text-muted);
	}

	.sug-fold::before,
	.sug-fold::after {
		content: '';
		flex: 1;
		border-top: 1px dashed var(--color-border-subtle);
	}

	.sug-fold-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-ui);
		font-size: 0.66rem;
	}

	.sug-note {
		margin: 0.5rem 0 0;
		font-family: var(--font-ui);
		font-size: 0.76rem;
		color: var(--color-text-muted);
	}

	.sug-toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: 0.5rem;
	}

	/* The Skills toolbar's button, so the one page carries one action shape. */
	.sug-ghost-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.65rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-weight: 600;
		font-size: 0.74rem;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.sug-ghost-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
		color: var(--color-text-primary);
	}

	.sug-ghost-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
