<script lang="ts">
	/**
	 * The standing channel's third condition (architecture/ui-shell-settings.md): the reader
	 * has lowered the destructive-act ladder, and it is still lowered.
	 *
	 * It earns a standing row rather than a toast for the same reason the connection one does:
	 * it is a state, not an event, and a line that leaves while it is still true teaches the
	 * eye to trust an absence. Deletion is final everywhere in this app, so the gap between
	 * "I chose this" and "why did that just vanish" is exactly one visible row.
	 *
	 * It can be dismissed, and the dismissal is scoped to the activation that raised it, so
	 * lowering the rung again, or opening another window, says so again. A kept rung whose row
	 * was dismissed comes back on the next boot, since dismissal is session state: "not now" is
	 * a reasonable thing to tell a warning, "never again" is not.
	 */
	import { slide } from 'svelte/transition';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { deleteGuard } from '$lib/stores/delete-guard.svelte';

	let open = $derived(deleteGuard.barOpen);

	let message = $derived(
		deleteGuard.asks
			? 'Deletes ask once and never wait for a press and hold.'
			: 'Deletes happen immediately, with nothing asked.'
	);

	// Rounded up, so the last stretch reads as a minute rather than counting itself down to a
	// zero that is still unlocked.
	let left = $derived.by(() => {
		if (!deleteGuard.timed) return null;
		const mins = Math.ceil(deleteGuard.remaining / 60_000);
		return mins <= 1 ? 'under a minute left' : `${mins} minutes left`;
	});
</script>

{#if open}
	<div class="guard-bar font-ui" role="status" transition:slide={{ duration: 180 }}>
		<Icon name="warning" class="w-4 h-4 shrink-0" strokeWidth={1.75} />
		<span class="guard-message">{message}</span>
		{#if left}
			<span class="guard-left">{left}</span>
		{/if}
		<button type="button" class="guard-action" onclick={() => deleteGuard.restore()}>
			Turn back on
		</button>
		<button
			type="button"
			class="guard-dismiss"
			onclick={() => deleteGuard.dismissBar()}
			aria-label="Dismiss"
			title="Dismiss until this is turned on again"
		>
			<Icon name="close" class="w-3.5 h-3.5" />
		</button>
	</div>
{/if}

<style>
	.guard-bar {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.55rem;
		padding: 0.4rem 0.75rem;
		background: color-mix(in srgb, var(--color-warning) 16%, var(--color-bg-secondary));
		border-bottom: 1px solid color-mix(in srgb, var(--color-warning) 40%, transparent);
		color: var(--color-warning);
		font-size: 0.76rem;
		font-weight: 600;
		line-height: 1.3;
		text-align: center;
	}

	.guard-left {
		flex-shrink: 0;
		color: color-mix(in srgb, var(--color-warning) 70%, var(--color-text-muted));
		font-weight: 500;
	}

	.guard-action {
		flex-shrink: 0;
		padding: 0.1rem 0.45rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--color-warning) 45%, transparent);
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition: background-color 120ms ease;
	}
	.guard-action:hover {
		background: color-mix(in srgb, var(--color-warning) 18%, transparent);
	}

	.guard-dismiss {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.15rem;
		border-radius: var(--radius-sm);
		color: color-mix(in srgb, var(--color-warning) 70%, var(--color-text-muted));
		cursor: pointer;
		transition: color 120ms ease, background-color 120ms ease;
	}
	.guard-dismiss:hover {
		color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 18%, transparent);
	}

	/* Narrow screens keep the sentence and the way out, and drop the clock beside them. */
	@media (max-width: 560px) {
		.guard-left {
			display: none;
		}
	}
</style>
