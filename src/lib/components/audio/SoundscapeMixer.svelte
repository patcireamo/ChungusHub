<script lang="ts">
	/**
	 * The whole Soundscape settings surface: the master level, the catalog, and the three
	 * switches over the mix.
	 *
	 * **A recording is ONE row whether or not it is in the mix.** Tapping the row joins it and
	 * unfolds its level underneath; tapping again drops it. A separate list of the chosen ones
	 * would put every recording on screen twice, with the name in one place and the level it is
	 * playing at somewhere past forty other rows.
	 *
	 * Nothing above the catalog may change height with the selection, or the row just tapped
	 * slides out from under the finger mid-gesture. That is why the status line is always drawn,
	 * with the empty mix given a sentence of its own, and why the shelf filter is a fixed set of
	 * chips that does not grow one when something starts playing.
	 *
	 * A level takes the row's whole width rather than sharing a line with the name: setting one
	 * IS the work here, and a slider squeezed beside a label is the one that cannot be placed on
	 * a phone.
	 *
	 * The hosting card and its `data-setting` anchor live in settings/AudioPage.svelte.
	 */
	import { slide } from 'svelte/transition';
	import { SOUND_CATEGORIES, soundsIn, type SoundCategory } from '$lib/config/soundscape';
	import { soundscapeStore } from '$lib/stores/soundscape.svelte';
	import { soundscapePlayer } from '$lib/services/soundscapePlayer.svelte';
	import Icon, { type IconName } from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Slider from '$lib/components/ui/Slider.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import { toggleRow } from '$lib/actions/toggleRow';

	const CATEGORY_ICON: Record<SoundCategory, IconName> = {
		nature: 'leaf',
		rain: 'cloud',
		places: 'mapPin',
		transport: 'compass',
		urban: 'grid'
	};

	type Shelf = SoundCategory | 'all';

	let config = $derived(soundscapeStore.config);
	let count = $derived(soundscapeStore.activeIds.length);

	/** Which shelf is on screen. View state, not a preference: it says where the reader is
	 *  looking right now and means nothing on the next device. */
	let shelf = $state<Shelf>('all');

	let shown = $derived(
		SOUND_CATEGORIES.filter((c) => shelf === 'all' || c.id === shelf).map((c) => ({
			...c,
			sounds: soundsIn(c.id)
		}))
	);

	/** The mix is built and silent: a browser plays nothing until the page has been touched. */
	let held = $derived(soundscapePlayer.blocked && count > 0);

	// Drift happens in the audio graph, where nothing on screen would ever see it. Sampling
	// runs only while this surface is mounted, and stops with it.
	$effect(() => soundscapePlayer.watchDrift());
</script>

<div class="mixer">
	<div class="row-block">
		<span class="slider-label">Overall Level</span>
		<Slider
			value={config.volume}
			min={0}
			max={1}
			step={0.01}
			defaultValue={0.5}
			format={(v) => (Math.round(v * 100) === 0 ? 'Muted' : `${Math.round(v * 100)}%`)}
			oninput={(v) => soundscapeStore.setVolume(v)}
			label="Soundscape volume"
		/>
	</div>

	<!-- One line, always, whatever it has to say. Given to the mix only when there is one, it
	     would appear on the tap that started the mix and push the catalog down under the finger
	     that tapped it. -->
	<div class="status">
		<span class="status-text" class:is-held={held}>
			{#if held}
				Tap anywhere and the mix starts on its own
			{:else if count > 0}
				{count}
				{count === 1 ? 'sound' : 'sounds'} in the mix
			{:else}
				Nothing in the mix yet
			{/if}
		</span>
		{#if count > 0}
			<button type="button" class="clear" onclick={() => soundscapeStore.clear()}>
				Clear all
			</button>
		{/if}
	</div>

	<div class="shelves" role="radiogroup" aria-label="Which sounds to show">
		<button
			type="button"
			class="chip"
			class:is-active-tint={shelf === 'all'}
			role="radio"
			aria-checked={shelf === 'all'}
			onclick={() => (shelf = 'all')}
		>
			All
		</button>
		{#each SOUND_CATEGORIES as category (category.id)}
			<button
				type="button"
				class="chip"
				class:is-active-tint={shelf === category.id}
				role="radio"
				aria-checked={shelf === category.id}
				onclick={() => (shelf = category.id)}
			>
				<Icon name={CATEGORY_ICON[category.id]} class="chip-glyph" />
				{category.label}
			</button>
		{/each}
	</div>

	<div class="catalog">
		{#each shown as category (category.id)}
			<!-- Only while every shelf is on screen: filtered to one, the chip above already names
			     it and a heading under it would say the word twice. -->
			{#if shelf === 'all'}
				<div class="shelf-head">
					<Icon name={CATEGORY_ICON[category.id]} class="shelf-glyph" />
					<span>{category.label}</span>
				</div>
			{/if}

			{#each category.sounds as sound (sound.id)}
				{@const on = soundscapeStore.isActive(sound.id)}
				{@const failed = soundscapePlayer.failed.has(sound.id)}
				{@const loading = soundscapePlayer.loading.has(sound.id)}
				<div class="sound" class:is-on={on} class:is-failed={failed}>
					<button
						type="button"
						class="sound-head"
						aria-pressed={on}
						title={on ? 'Remove from the mix' : 'Add to the mix'}
						onclick={() => soundscapeStore.toggleSound(sound.id)}
					>
						<span class="dot"></span>
						<span class="sound-name">{sound.label}</span>
						{#if failed}
							<span class="sound-state is-failed-text">Could not load</span>
						{:else if loading}
							<span class="sound-state">Loading…</span>
						{/if}
					</button>

					{#if on}
						<!-- The fill follows what this recording is actually playing at while the thumb
						     stays where it was set, so a drifting level is visible without the control
						     ever disagreeing with the stored mix. -->
						{@const drift = soundscapePlayer.liveDrift.get(sound.id)}
						<div class="sound-level" transition:slide={{ duration: 160 }}>
							<Slider
								value={soundscapeStore.levelOf(sound.id)}
								liveValue={drift === undefined
									? undefined
									: soundscapeStore.levelOf(sound.id) * drift}
								min={0}
								max={1}
								step={0.01}
								defaultValue={0.5}
								format={(v) => `${Math.round(v * 100)}%`}
								oninput={(v) => soundscapeStore.setLevel(sound.id, v)}
								label="{sound.label} level"
							/>
						</div>
					{/if}
				</div>
			{/each}
		{/each}
	</div>

	<div class="switches">
		<div class="toggle-row switch-row" use:toggleRow>
			<span class="switch-text">
				<span class="switch-label">Loop without an audible seam</span>
				<InfoTip
					text="Joins each recording's end to its own beginning. Off, a recording wraps wherever it happens to end, which on most of them is a click you hear every time around."
				/>
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
				<InfoTip
					text="The recordings were made by different people and span 29 dB as published, so without this one slider position is painful on one and inaudible on the next."
				/>
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
				<InfoTip
					text="Each level wanders slowly around where you set it, a few decibels either way and never in step with the others, so a long scene stops sounding like a loop."
				/>
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

	/* --- The status line --- */

	.status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		/* Fixed, so the sentence it carries can change without the catalog moving. */
		min-height: 1.5rem;
		margin-top: -0.2rem;
	}

	.status-text {
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-muted);
	}

	.status-text.is-held {
		color: var(--color-text-secondary);
	}

	.clear {
		flex-shrink: 0;
		padding: 0.15rem 0.35rem;
		margin-right: -0.35rem;
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 550;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease;
	}

	.clear:hover {
		color: var(--color-text-primary);
	}

	/* --- The shelf filter --- */

	.shelves {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		/* Tall enough to be hit with a thumb, which the rows below it also hold to. */
		min-height: 2rem;
		padding: 0.3rem 0.7rem;
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

	.chip:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-border) 90%, transparent);
	}

	.chip :global(.chip-glyph) {
		width: 0.8rem;
		height: 0.8rem;
		opacity: 0.75;
	}

	/* Scoped active tint: the canonical .is-active-tint recipe sits in a cascade layer, so this
	   unlayered scoped base would otherwise win against it. After :hover, so a chosen chip stays
	   tinted while hovered. */
	.chip.is-active-tint {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 33%, transparent);
	}

	/* --- The catalog --- */

	.catalog {
		display: flex;
		flex-direction: column;
	}

	.shelf-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.85rem 0 0.35rem;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.shelf-head:first-child {
		padding-top: 0.15rem;
	}

	.shelf-head :global(.shelf-glyph) {
		width: 0.78rem;
		height: 0.78rem;
	}

	/* The row bleeds to the card's padding edge, so its press band and the rule under it reach
	   the same place the switches below do. The head's own padding then brings the name back to
	   the measure the shelf headings sit on. */
	.sound {
		margin-inline: -0.5rem;
	}

	.sound + .sound {
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 40%, transparent);
	}

	.sound-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		/* A finger's worth of row, and the whole width of it: the name, the gap beside it and
		   the state all belong to the one press. */
		min-height: 2.75rem;
		padding: 0.3rem 0.5rem;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		text-align: left;
		cursor: pointer;
		transition: background-color 120ms ease;
	}

	.sound-head:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
	}

	.dot {
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-full);
		border: 1.5px solid color-mix(in srgb, var(--color-border) 85%, transparent);
		transition:
			background-color 140ms ease,
			border-color 140ms ease;
	}

	.sound.is-on .dot {
		background: var(--color-accent);
		border-color: var(--color-accent);
	}

	.sound.is-failed .dot {
		background: var(--color-error);
		border-color: var(--color-error);
	}

	.sound-name {
		flex: 1;
		min-width: 0;
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		transition: color 140ms ease;
	}

	.sound.is-on .sound-name {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.sound-state {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.sound-state.is-failed-text {
		color: var(--color-error);
	}

	.sound-level {
		display: flex;
		padding: 0 0.5rem 0.7rem;
	}

	/* --- The three switches --- */

	.switches {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-top: 0.4rem;
		padding-top: 0.8rem;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 45%, transparent);
	}

	/* `.toggle-row` carries the hover band, the bleed to the card edge and the pointer
	   affordance. Only the height departs: a switch is a small target at the far end of a wide
	   row, and these three sit where a thumb has just been working down a list of tall ones. */
	.switch-row {
		min-height: 2.75rem;
	}

	.switch-text {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		flex: 1;
	}

	.switch-label {
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 550;
		color: var(--color-text-primary);
	}
</style>
