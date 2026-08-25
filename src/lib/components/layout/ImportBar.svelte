<script lang="ts">
	/**
	 * The standing channel's last condition (architecture/ui-shell-settings.md): a SillyTavern
	 * folder import is running.
	 *
	 * It earns a standing row for the reason the others do: it is a state, not an event. An
	 * import of a real library runs for minutes, the reader closes Settings and goes back to a
	 * chat while it does, and a readout that lived on the page it was started from would leave
	 * the app writing characters, chats and pictures behind an interface saying nothing at all.
	 *
	 * This row is the app's ONLY progress readout for that import, which is why the Import page
	 * draws none of its own: one fact stated in two places at once is the shape that teaches the
	 * eye to skip both. The page owns the summary afterwards.
	 *
	 * It also carries the only way to stop the run, for the same reason it carries the progress:
	 * the run outlives the page that started it, and work the reader cannot call off is the app
	 * taking the wheel. Stop is not on the destructive-act ladder and asks nothing: everything
	 * that landed is kept and claimed, so stopping costs nothing and running the folder again
	 * picks up what is left.
	 */
	import { slide } from 'svelte/transition';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { importRun } from '$lib/stores/import-run.svelte';

	let progress = $derived(importRun.progress);
</script>

{#if importRun.running}
	<div class="import-bar font-ui" role="status" transition:slide={{ duration: 180 }}>
		<Spinner size="sm" />
		<span class="import-message">Importing SillyTavern data</span>
		{#if progress}
			<span class="import-step">
				{progress.phase}{progress.total > 1 ? ` ${progress.done + 1} / ${progress.total}` : ''}
			</span>
		{/if}
		<button type="button" class="import-stop" onclick={() => importRun.stop()}>Stop</button>
	</div>
{/if}

<style>
	.import-bar {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.55rem;
		padding: 0.4rem 0.75rem;
		background: color-mix(in srgb, var(--color-accent) 14%, var(--color-bg-secondary));
		border-bottom: 1px solid color-mix(in srgb, var(--color-accent) 38%, transparent);
		color: var(--color-accent);
		font-size: 0.76rem;
		font-weight: 600;
		line-height: 1.3;
		text-align: center;
	}

	.import-step {
		flex-shrink: 0;
		color: color-mix(in srgb, var(--color-accent) 70%, var(--color-text-muted));
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	/* The same outlined chip the delete-guard row uses for its way out, so the one action a
	   standing row can carry looks the same wherever it appears. */
	.import-stop {
		flex-shrink: 0;
		padding: 0.1rem 0.45rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition: background-color 120ms ease;
	}
	.import-stop:hover {
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
	}
</style>
