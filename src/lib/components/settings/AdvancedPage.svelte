<script lang="ts">
	import { advancedSettingsStore, type DeleteConfirmRung } from '$lib/stores/advanced-settings.svelte';
	import { deleteGuard, WINDOW_CHOICES, QUICK_WINDOW_MS } from '$lib/stores/delete-guard.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { promptLogStore } from '$lib/debug/promptLog.svelte';
	import { promptHoldStore } from '$lib/stores/promptHold.svelte';
	import { HOLD_GATES } from '$lib/config/prompt-hold';
	import Icon from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import PillRow from '$lib/components/ui/PillRow.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import { toggleRow } from '$lib/actions/toggleRow';
	import { imageService } from '$lib/services/imageService';
	import { failureText } from '$lib/stores/toast.svelte';

	let promptDebugPanel = $derived(advancedSettingsStore.promptDebugPanel);
	let logCount = $derived(promptLogStore.entries.length);

	const RUNGS = [
		{ value: 'hold', label: 'Ask and hold', title: 'A big loss needs a press and hold' },
		{ value: 'ask', label: 'Ask once', title: 'Every delete asks, nothing needs holding' },
		{ value: 'off', label: 'Do not ask', title: 'Deletes happen immediately' }
	];

	const LENGTHS = [
		...WINDOW_CHOICES.map((c) => ({ value: String(c.ms), label: c.label })),
		{ value: 'kept', label: 'Until I turn it back on' }
	];

	let rung = $derived(deleteGuard.rung);
	let length = $derived(deleteGuard.timed ? String(deleteGuard.windowMs) : 'kept');

	// Lowering from the default starts a window rather than a kept setting, so the safe shape
	// is the one click and permanence is the second one. Moving between two lowered rungs keeps
	// whichever shape is already running.
	function pickRung(next: string): void {
		const value = next as DeleteConfirmRung;
		if (value === 'hold') {
			deleteGuard.restore();
			return;
		}
		if (deleteGuard.timed) deleteGuard.openWindow(value, deleteGuard.windowMs);
		else if (rung === 'hold') deleteGuard.openWindow(value, QUICK_WINDOW_MS);
		else deleteGuard.keep(value);
	}

	function pickLength(next: string): void {
		if (rung === 'hold') return;
		if (next === 'kept') deleteGuard.keep(rung);
		else deleteGuard.openWindow(rung, Number(next));
	}

	let rebuilding = $state(false);
	/** Pictures reached, failures included, so the count on screen never stalls on one. */
	let rebuildReached = $state(0);
	let rebuildTotal = $state(0);
	let rebuildSummary = $state('');
	let rebuildFailure = $state('');

	function pictures(n: number): string {
		return `${n} picture${n === 1 ? '' : 's'}`;
	}

	/**
	 * Re-encode every stored picture's thumbnail, one at a time, from this browser: it holds
	 * the app's only image encoder, so there is no server-side job that could do this.
	 *
	 * Every picture, not only the ones missing a thumbnail, because that is the question this
	 * button answers: one already on disk can still be the wrong format or the wrong size, and
	 * a run that skipped those would leave the reader unable to tell a finished rebuild from a
	 * rebuild that decided there was nothing to do.
	 */
	async function rebuildThumbnails(): Promise<void> {
		rebuilding = true;
		rebuildSummary = '';
		rebuildFailure = '';
		rebuildReached = 0;
		rebuildTotal = 0;
		let failed = 0;
		let firstCause: unknown = null;
		try {
			const paths = await imageService.listStoredImages();
			rebuildTotal = paths.length;
			for (const path of paths) {
				try {
					await imageService.rebuildThumbnail(path);
				} catch (error) {
					failed++;
					if (firstCause === null) firstCause = error;
					console.error(`Failed to rebuild the thumbnail for ${path}:`, error);
				}
				rebuildReached++;
			}
			if (failed > 0) {
				rebuildFailure = failureText(`rebuild ${failed} of ${pictures(rebuildTotal)}`, firstCause);
			}
			const rebuilt = rebuildTotal - failed;
			if (rebuilt > 0) {
				rebuildSummary = `Rebuilt ${pictures(rebuilt)}. Reload the app to draw them.`;
			} else if (rebuildTotal === 0) {
				rebuildSummary = 'There are no stored pictures.';
			}
		} catch (error) {
			rebuildFailure = failureText('rebuild the thumbnails', error);
		} finally {
			rebuilding = false;
		}
	}
</script>

<div class="adv">
	<section class="card" data-setting="delete-confirmations">
		<div class="card-head">
			<span class="card-title">Delete confirmations</span>
			<InfoTip
				text="How hard a delete is to fire. Nothing in this app can be undone once it is gone, so the default asks before every delete and makes a big one wait for a press and hold. Lowering this starts as a window that puts itself back, since most reasons to lower it last a few minutes. While it is lowered a row at the top of the app says so."
			/>
		</div>
		<div class="card-body">
			<PillRow options={RUNGS} current={rung} onpick={pickRung} label="Delete confirmations" />
			{#if rung !== 'hold'}
				<div class="len">
					<span class="section-label">For how long</span>
					<PillRow options={LENGTHS} current={length} onpick={pickLength} label="How long" />
				</div>
			{/if}
		</div>
	</section>

	<section class="card" data-setting="prompt-debug-panel">
		<div class="card-head">
			<span class="card-title">Prompt Debug Panel</span>
			<InfoTip
				text="Logs every prompt the app sends into a panel you open from a handle on the right edge of the chat. Logs survive a refresh and only the panel's Clear button wipes them."
			/>
		</div>
		<div class="toggle-row" use:toggleRow>
			<span class="toggle-label">Enable prompt logging &amp; debug panel</span>
			<Toggle
				checked={promptDebugPanel}
				onchange={(v) => advancedSettingsStore.setPromptDebugPanel(v)}
				label="Enable prompt logging & debug panel"
			/>
		</div>
		{#if promptDebugPanel}
			<button type="button" class="card-btn" onclick={() => uiStore.openDebugPanel()}>
				<Icon name="wrench" class="w-3.5 h-3.5" strokeWidth={1.75} />
				Open debug panel
				{#if logCount > 0}
					<span class="open-panel-count">{logCount > 999 ? '999+' : logCount}</span>
				{/if}
			</button>
		{/if}
	</section>

	<!-- Sits beside the debug panel because the two answer the same question at opposite ends
	     of a request: that one shows what was sent, this one shows what is about to be. -->
	<section class="card" data-setting="prompt-review">
		<div class="card-head">
			<span class="card-title">Prompt Review</span>
			<InfoTip
				text="Holds the chosen requests and shows you the whole prompt before it goes out, to read or to edit. Edits apply to that one request; nothing in your chat, your preset or your lorebook changes."
			/>
		</div>
		<div class="card-body">
			{#each HOLD_GATES as gate (gate.id)}
				<div class="toggle-row" use:toggleRow>
					<span class="gate-label">
						<Icon name={gate.icon} class="w-3.5 h-3.5 shrink-0 text-text-muted" strokeWidth={1.75} />
						{gate.name}
					</span>
					<Toggle
						checked={promptHoldStore.armed(gate.id)}
						onchange={(v) => promptHoldStore.setGate(gate.id, v)}
						label={`Hold ${gate.name} for review`}
					/>
				</div>
			{/each}
		</div>
	</section>

	<!-- The thumbnail is what nearly every picture in the app actually draws, so one that is
	     stale or was never written is invisible until a gallery is slow or blank. Nothing else
	     puts them right: the encoder is the browser's, and this is the only control that
	     reaches it without re-uploading each picture by hand. -->
	<section class="card" data-setting="thumbnails">
		<div class="card-head">
			<span class="card-title">Thumbnails</span>
			<InfoTip
				text="Re-encodes the small copy of every stored picture. Reload the app afterwards to see them."
			/>
		</div>
		<div class="card-body">
			{#if rebuilding}
				<p class="rebuild-progress">
					<Spinner size="sm" />
					Rebuilding, {rebuildReached} of {rebuildTotal}…
				</p>
			{:else}
				<button type="button" class="card-btn" onclick={rebuildThumbnails}>
					<Icon name="refresh" class="w-3.5 h-3.5" strokeWidth={1.75} />
					Rebuild thumbnails
				</button>
			{/if}
			{#if rebuildSummary}
				<p class="rebuild-note">{rebuildSummary}</p>
			{/if}
			{#if rebuildFailure}
				<p class="rebuild-note rebuild-note--failed">{rebuildFailure}</p>
			{/if}
		</div>
	</section>
</div>

<style>
	.adv {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.len {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 0.8rem;
	}

	.toggle-label {
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-text-primary);
	}

	/* The glyph each action already wears, so a row reads as the press it holds. */
	.gate-label {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-text-primary);
	}

	/* The page's own button: it stands under a card's controls and never beside them, so it
	   is sized and spaced by the card rather than by the row it follows. */
	.card-btn {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.5rem 0.8rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-weight: 600;
		font-size: 0.8rem;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
	}

	.card-btn:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-accent) 50%, var(--color-border));
	}

	/* The one button standing outside a card body brings the gap that body would have
	   given it. */
	.toggle-row + .card-btn {
		margin-top: 0.7rem;
	}

	/* Stands where the button stands, so a run in progress reads as a state the card is in
	   rather than as a control that went missing. */
	.rebuild-progress {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		color: var(--color-accent);
	}

	/* What the run did, then what it could not do: both under the control that produced
	   them, in the order they are asked about. */
	.rebuild-note {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		line-height: 1.5;
		color: var(--color-text-muted);
	}

	.rebuild-note--failed {
		color: var(--color-error);
	}

	.open-panel-count {
		min-width: 1.1rem;
		padding: 0.05rem 0.28rem;
		border-radius: 999px;
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-family: var(--font-mono, monospace);
		font-size: 0.62rem;
		font-weight: 700;
		line-height: 1.3;
		text-align: center;
	}
</style>
