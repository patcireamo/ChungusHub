<!--
  Setups, authored.

  A kit is a named snapshot of every control value ("Slow burn romance", "Fast and mean")
  that a reader applies with one click. It exists so an author who has three good
  configurations ships one preset with three kits instead of three near-identical files that
  drift apart the moment one of them is improved.

  Capturing is the only way to make one, and deliberately so: a kit built by hand from a
  form would let it name macros no control owns, and a reader clicking it would then be
  writing values nothing reads.

  On the reader's page a kit is a baseline: adopting one writes everything it names and
  returns every control it does not name to the author's default. A control added after
  capture is therefore a hole in what the kit vouches for, which is why the row flags it
  and why "Current" also demands full coverage: a recapture must change nothing.
-->
<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import { getControlValue } from '$lib/utils/prompt-controls';
	import type { PromptControl, PromptPresetBundle } from '$lib/types/database';

	interface Props {
		bundles: PromptPresetBundle[];
		/** The preset's controls: what a capture reads, and what a kit is checked against. */
		controls: PromptControl[];
		/** THIS preset's reader values, handed in rather than reached for: values belong to a
		 *  preset, and an editor that fetched them itself would need to know which one. */
		values: Record<string, unknown>;
		onChange: (bundles: PromptPresetBundle[]) => void;
	}

	let { bundles, controls, values, onChange }: Props = $props();

	/** Controls this kit predates: macros the preset owns now that the kit never captured.
	 *  A reader adopting such a kit gets those controls at the author's defaults, so the
	 *  author should recapture unless the defaults are what they mean to vouch for. */
	function missingCount(bundle: PromptPresetBundle): number {
		return controls.filter(
			(c) => c.macro.trim() && !Object.prototype.hasOwnProperty.call(bundle.values, c.macro)
		).length;
	}

	/** A kit is "live" when recapturing it now would change nothing: every value in it
	 *  matches what the page is showing, and no control postdates the capture. */
	function isLive(bundle: PromptPresetBundle): boolean {
		return (
			missingCount(bundle) === 0 &&
			Object.entries(bundle.values).every(
				([macro, value]) => JSON.stringify(values[macro]) === JSON.stringify(value)
			)
		);
	}

	/** Snapshot every control at its effective value, so a kit is complete rather than
	 *  partial: a kit that only names what the author had touched would leave the rest
	 *  wherever the reader had them, which is not the configuration being vouched for. */
	function capture(): Record<string, unknown> {
		const captured: Record<string, unknown> = {};
		for (const control of controls) {
			if (!control.macro.trim()) continue;
			captured[control.macro] = getControlValue(control, values[control.macro]);
		}
		return captured;
	}

	function add(): void {
		let id = 'kit';
		for (let n = 2; bundles.some((b) => b.id === id); n++) id = `kit-${n}`;
		onChange([...bundles, { id, name: '', values: capture() }]);
	}

	function update(id: string, patch: Partial<PromptPresetBundle>): void {
		onChange(bundles.map((b) => (b.id === id ? { ...b, ...patch } : b)));
	}

	function recapture(id: string): void {
		update(id, { values: capture() });
	}

	function remove(id: string): void {
		onChange(bundles.filter((b) => b.id !== id));
	}
</script>

<div class="bl">
	{#if bundles.length > 0}
		<div class="bl-list">
			{#each bundles as bundle (bundle.id)}
				{@const live = isLive(bundle)}
				{@const missing = missingCount(bundle)}
				<div class="bl-kit">
					<div class="bl-kit-head">
						<input
							type="text"
							value={bundle.name}
							oninput={(e) => update(bundle.id, { name: (e.target as HTMLInputElement).value })}
							placeholder="Setup name"
							aria-label="Setup name"
							class="input-base flex-1 min-w-0 px-2.5 py-1.5 text-text-primary font-ui text-sm"
						/>
						<button
							type="button"
							class="bl-action"
							class:is-live={live}
							title={live
								? 'This setup matches the current values.'
								: 'Overwrite this setup with the values currently set in Preset Controls.'}
							onclick={() => recapture(bundle.id)}
						>
							<Icon name={live ? 'check' : 'refresh'} class="w-3.5 h-3.5" strokeWidth={1.5} />
							<span>{live ? 'Current' : 'Recapture'}</span>
						</button>
						<button
							type="button"
							class="bl-del"
							title="Delete setup"
							aria-label="Delete setup"
							onclick={() => remove(bundle.id)}
						>
							<Icon name="trash" class="w-4 h-4" strokeWidth={1.5} />
						</button>
					</div>
					<input
						type="text"
						value={bundle.description ?? ''}
						oninput={(e) =>
							update(bundle.id, { description: (e.target as HTMLInputElement).value || undefined })}
						placeholder="What this setup is for (optional)"
						aria-label="Setup description"
						class="input-base w-full px-2.5 py-1.5 text-text-primary font-ui text-sm"
					/>
					<p class="bl-kit-meta">
						{Object.keys(bundle.values).length} value{Object.keys(bundle.values).length === 1 ? '' : 's'}{#if missing > 0}<span class="bl-kit-warn"> · {missing} newer control{missing === 1 ? '' : 's'} not covered, recapture to include {missing === 1 ? 'it' : 'them'}</span>{/if}
					</p>
				</div>
			{/each}
		</div>
	{:else}
		<div class="bl-empty">
			<p>
				No setups yet. Set the controls the way you'd recommend them on the Preset Controls page,
				then capture that as a setup readers can apply in one click.
			</p>
		</div>
	{/if}

	<button type="button" class="bl-add" onclick={add} disabled={controls.length === 0}>
		<Icon name="plus" class="w-3.5 h-3.5" strokeWidth={2} />
		Capture current values as a setup
	</button>
</div>

<style>
	.bl {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.bl-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.bl-empty {
		padding: 1.1rem 1rem;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-lg);
		text-align: center;
	}

	.bl-empty p {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.76rem;
		line-height: 1.5;
		color: var(--color-text-muted);
	}

	.bl-kit {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.6rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-secondary) 84%, transparent);
	}

	.bl-kit-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}

	.bl-action {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.3rem 0.55rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-muted);
		white-space: nowrap;
		cursor: pointer;
		transition: color 120ms ease, border-color 120ms ease;
	}

	.bl-action:hover {
		color: var(--color-text-primary);
		border-color: var(--color-border);
	}

	.bl-action.is-live {
		color: var(--color-success);
		border-color: color-mix(in srgb, var(--color-success) 32%, transparent);
	}

	.bl-del {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.7rem;
		height: 1.7rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease, background-color 120ms ease;
	}

	.bl-del:hover {
		color: var(--color-error);
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
	}

	.bl-kit-meta {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--color-text-muted);
	}

	.bl-kit-warn {
		color: var(--color-warning);
	}

	.bl-add {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.3rem 0.6rem;
		border: 1px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-accent);
		cursor: pointer;
		transition: background-color 140ms ease;
	}

	.bl-add:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-accent) 17%, transparent);
	}

	.bl-add:disabled {
		opacity: 0.45;
		cursor: default;
	}
</style>
