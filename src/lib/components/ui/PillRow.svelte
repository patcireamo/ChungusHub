<script lang="ts">
	/**
	 * Short-enum pill row (verbosity, effort, cache TTL, recall scope, …): every
	 * option visible, one tap, radiogroup semantics. Labels stay terse: nuance
	 * rides each pill's `title` and whatever InfoTip the caller puts by the row.
	 */
	interface Props {
		options: { value: string; label: string; title?: string; disabled?: boolean }[];
		current: string;
		onpick: (value: string) => void;
		/** aria-label for the radiogroup. */
		label: string;
	}

	let { options, current, onpick, label }: Props = $props();
</script>

<div class="pill-row" role="radiogroup" aria-label={label}>
	{#each options as o (o.value)}
		<button
			type="button"
			class="pill"
			class:is-active-tint={o.value === current}
			role="radio"
			aria-checked={o.value === current}
			title={o.title}
			disabled={o.disabled}
			onclick={() => onpick(o.value)}
		>
			{o.label}
		</button>
	{/each}
</div>

<style>
	/* Short-enum pill rows; active state is the app-wide .is-active-tint recipe. */
	.pill-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	.pill {
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

	.pill:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-border) 90%, transparent);
	}

	/* Scoped active tint: the canonical .is-active-tint recipe is in a cascade layer,
	   so this unlayered scoped base would otherwise override it. Placed after :hover so
	   the active pill stays tinted while hovered. */
	.pill.is-active-tint {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 33%, transparent);
	}

	/* An option that cannot be taken here stays on screen and inert rather than dropping
	   out: a control that vanishes takes the reason with it, and the reader is left
	   hunting for a pill they remember. Its `title` is where that reason goes. Last, so
	   it wins over :hover and over the active tint. */
	.pill:disabled,
	.pill:disabled:hover {
		opacity: 0.45;
		cursor: not-allowed;
		color: var(--color-text-secondary);
		border-color: color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
	}
</style>
