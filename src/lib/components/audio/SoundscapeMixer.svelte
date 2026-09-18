<script lang="ts">
	/**
	 * The whole Soundscape settings surface: catalog, mix, and the three switches over it.
	 *
	 * Zone order is load-bearing and the same rule the ambient mixer follows: the rows the
	 * selection adds append BELOW the catalog, so a tapped pill never moves out from under
	 * the finger that tapped it.
	 *
	 * A mix row gives the slider the row's whole width at every screen size rather than
	 * squeezing it beside the name. Setting a level IS the work here, and a slider sharing a
	 * line with a label and a button is the one that cannot be placed on a phone.
	 *
	 * The hosting card and its `data-setting` anchor live in settings/AudioPage.svelte.
	 */
	import { SOUND_CATEGORIES, soundById, soundsIn } from '$lib/config/soundscape';
	import { soundscapeStore } from '$lib/stores/soundscape.svelte';
	import { soundscapePlayer } from '$lib/services/soundscapePlayer.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Slider from '$lib/components/ui/Slider.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import { toggleRow } from '$lib/actions/toggleRow';

	let config = $derived(soundscapeStore.config);
	let activeIds = $derived(soundscapeStore.activeIds);

	// Drift happens in the audio graph, where nothing on screen would ever see it. Sampling
	// runs only while this surface is mounted, and stops with it.
	$effect(() => soundscapePlayer.watchDrift());

	const pct = (v: number) => `${Math.round(v * 100)}%`;
</script>

<div class="mixer">
	<div class="row-block">
		<span class="field-label">Volume</span>
		<Slider
			value={config.volume}
			min={0}
			max={1}
			step={0.01}
			defaultValue={0.5}
			format={(v) => (Math.round(v * 100) === 0 ? 'Muted' : pct(v))}
			oninput={(v) => soundscapeStore.setVolume(v)}
			label="Soundscape volume"
		/>
	</div>

	{#if soundscapePlayer.blocked && activeIds.length > 0}
		<p class="note note-warn">
			Your browser will not play sound until you have touched the page. Tap anywhere and the
			mix starts on its own.
		</p>
	{/if}

	<!-- Catalog: every recording, one tap to add or remove. Shelves stack on a phone and sit
	     side by side once there is room, with no breakpoint of their own. -->
	<div class="catalog">
		{#each SOUND_CATEGORIES as category (category.id)}
			<div class="shelf">
				<span class="section-label">{category.label}</span>
				<div class="shelf-pills" role="group" aria-label="{category.label} sounds">
					{#each soundsIn(category.id) as sound (sound.id)}
						{@const on = soundscapeStore.isActive(sound.id)}
						<button
							type="button"
							class="sound-pill"
							class:is-active-tint={on}
							aria-pressed={on}
							onclick={() => soundscapeStore.toggleSound(sound.id)}
						>
							{sound.label}
						</button>
					{/each}
				</div>
			</div>
		{/each}
	</div>

	{#if activeIds.length > 0}
		<div class="mix">
			<div class="mix-head">
				<span class="section-label">In the mix</span>
				<button type="button" class="clear" onclick={() => soundscapeStore.clear()}>
					Clear
				</button>
			</div>

			{#each activeIds as id (id)}
				{@const sound = soundById(id)}
				{@const drift = soundscapePlayer.liveDrift.get(id)}
				{#if sound}
					<div class="track">
						<div class="track-head">
							<span class="track-name">{sound.label}</span>
							{#if soundscapePlayer.failed.has(id)}
								<span class="track-state track-state-failed">Could not load</span>
							{:else if soundscapePlayer.loading.has(id)}
								<span class="track-state">Loading…</span>
							{/if}
							<button
								type="button"
								class="track-remove"
								aria-label="Remove {sound.label}"
								title="Remove from the mix"
								onclick={() => soundscapeStore.toggleSound(id)}
							>
								<Icon name="x" class="w-3.5 h-3.5" />
							</button>
						</div>
						<!-- The fill follows what this recording is actually playing at while the
						     thumb stays where it was set, so a drifting level is visible without
						     the control ever disagreeing with the stored mix. -->
						<Slider
							value={soundscapeStore.levelOf(id)}
							liveValue={drift === undefined ? undefined : soundscapeStore.levelOf(id) * drift}
							min={0}
							max={1}
							step={0.01}
							defaultValue={0.5}
							format={pct}
							oninput={(v) => soundscapeStore.setLevel(id, v)}
							label="{sound.label} level"
						/>
					</div>
				{/if}
			{/each}
		</div>
	{/if}

	<div class="switches">
		<div class="toggle-row switch-row" use:toggleRow>
			<span class="switch-text">
				<span class="switch-label">Loop without an audible seam</span>
				<span class="switch-hint">
					Joins each recording's end to its own beginning. Off, a recording wraps wherever it
					happens to end, which on most of them is a click you hear every time around.
				</span>
			</span>
			<Toggle
				checked={config.seamless}
				onchange={(v) => soundscapeStore.setSeamless(v)}
				label="Loop without an audible seam"
			/>
		</div>

		<div class="toggle-row switch-row" use:toggleRow>
			<span class="switch-text">
				<span class="switch-label">Match every recording's loudness</span>
				<span class="switch-hint">
					The recordings were made by different people and span 29 dB as published, so without
					this one slider position is painful on one and inaudible on the next.
				</span>
			</span>
			<Toggle
				checked={config.normalize}
				onchange={(v) => soundscapeStore.setNormalize(v)}
				label="Match every recording's loudness"
			/>
		</div>

		<div class="toggle-row switch-row" use:toggleRow>
			<span class="switch-text">
				<span class="switch-label">Let levels drift on their own</span>
				<span class="switch-hint">
					Each level wanders slowly around where you set it, a few decibels either way and
					never in step with the others, so a long scene stops sounding like a loop.
				</span>
			</span>
			<Toggle
				checked={config.drift}
				onchange={(v) => soundscapeStore.setDrift(v)}
				label="Let levels drift on their own"
			/>
		</div>
	</div>
</div>

<style>
	.mixer {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.row-block {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.field-label {
		font-family: var(--font-ui);
		font-size: 0.78rem;
		color: var(--color-text-secondary);
	}

	.note {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	.note-warn {
		color: var(--color-text-secondary);
	}

	/* --- Catalog --- */

	.catalog {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.8rem 1.1rem;
	}

	.shelf {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.shelf-pills {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	/* Multi-select twin of ui/PillRow's pill: same body, aria-pressed instead of radio
	   semantics, since any number can be on at once. */
	.sound-pill {
		padding: 0.28rem 0.65rem;
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 550;
		cursor: pointer;
		transition:
			color 90ms ease,
			border-color 90ms ease,
			background 90ms ease;
	}

	.sound-pill:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-border) 90%, transparent);
	}

	/* Scoped active tint: the canonical .is-active-tint recipe sits in a cascade layer, so
	   this unlayered scoped base would otherwise win against it. After :hover, so an active
	   pill stays tinted while hovered. */
	.sound-pill.is-active-tint {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 33%, transparent);
	}

	/* --- The mix --- */

	.mix {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.mix-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.clear {
		padding: 0.1rem 0.25rem;
		background: none;
		border: none;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 550;
		color: var(--color-text-muted);
		cursor: pointer;
		border-radius: var(--radius-sm);
		transition: color 120ms ease;
	}

	.clear:hover {
		color: var(--color-text-primary);
	}

	.track {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.5rem 0.6rem 0.6rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-tertiary) 35%, transparent);
	}

	.track-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.track-name {
		flex: 1;
		min-width: 0;
		font-family: var(--font-ui);
		font-size: 0.76rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.track-state {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.track-state-failed {
		color: var(--color-error);
	}

	.track-remove {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* A comfortable tap target on a phone, where this sits beside a slider that must not
		   be grabbed by mistake. */
		width: 1.9rem;
		height: 1.9rem;
		margin: -0.35rem -0.25rem -0.35rem 0;
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		cursor: pointer;
		transition:
			color 120ms ease,
			background-color 120ms ease;
	}

	.track-remove:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
	}

	/* --- The three switches --- */

	.switches {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding-top: 0.8rem;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 45%, transparent);
	}

	/* `.toggle-row` carries the hover band, the bleed to the card edge and the pointer
	   affordance. Only the alignment departs: these rows are two lines of text, and centring
	   one against a switch leaves the switch floating in the middle of the explanation. */
	.switch-row {
		align-items: flex-start;
	}

	.switch-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}

	.switch-label {
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 550;
		color: var(--color-text-primary);
	}

	.switch-hint {
		font-family: var(--font-ui);
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}
</style>
