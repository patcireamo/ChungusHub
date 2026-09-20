<script lang="ts">
	import { audioSettingsStore, type SoundTiming } from '$lib/stores/audio-settings.svelte';
	import {
		SOUND_EVENTS,
		TONES,
		toneLabel,
		type SoundEventId,
		type ToneId
	} from '$lib/config/sound-events';
	import { previewTone } from '$lib/services/notificationSound';
	import SoundscapeMixer from '$lib/components/audio/SoundscapeMixer.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import PillRow from '$lib/components/ui/PillRow.svelte';
	import Slider from '$lib/components/ui/Slider.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { toggleRow } from '$lib/actions/toggleRow';

	const TIMING_OPTIONS: { value: SoundTiming; label: string; title: string }[] = [
		{ value: 'away', label: 'Only when away', title: 'Nothing plays while this window has focus.' },
		{ value: 'always', label: 'Always', title: 'Plays even while you are looking at the app.' }
	];

	const DEFAULT_VOLUME = 0.6;

	let enabled = $derived(audioSettingsStore.enabled);
	let timing = $derived(audioSettingsStore.timing);
	let volume = $derived(audioSettingsStore.volume);

	let openEvent = $state<SoundEventId | null>(null);
	let lastHeard = $state<ToneId | null>(null);
	let probeTimer: ReturnType<typeof setTimeout> | null = null;

	/** What the volume slider plays while it moves: the tone last heard, so adjusting the
	 *  level right after picking one judges that one. Before anything has been heard it is
	 *  whatever the first event that still makes a sound is set to, never a tone the reader
	 *  has already moved off. */
	let volumeTone = $derived(
		lastHeard ??
			SOUND_EVENTS.map((e) => audioSettingsStore.toneFor(e.id)).find((t) => t !== null) ??
			TONES[0].id
	);

	let allSilent = $derived(SOUND_EVENTS.every((e) => audioSettingsStore.toneFor(e.id) === null));

	function toggleOpen(id: SoundEventId): void {
		openEvent = openEvent === id ? null : id;
	}

	function pickTone(event: SoundEventId, tone: ToneId | null): void {
		audioSettingsStore.setTone(event, tone);
		if (!tone) return;
		lastHeard = tone;
		previewTone(tone, audioSettingsStore.volume);
	}

	// Playing on every frame of a drag would be a machine gun, so the tone lands once the
	// slider settles, at the level it settled on.
	function handleVolume(value: number): void {
		audioSettingsStore.setVolume(value);
		if (probeTimer) clearTimeout(probeTimer);
		probeTimer = setTimeout(() => {
			probeTimer = null;
			previewTone(volumeTone, audioSettingsStore.volume);
		}, 220);
	}
</script>

<div class="audio">
	<section class="card" data-setting="notification-sounds">
		<div class="card-head">
			<span class="card-title">Notification Sounds</span>
			<InfoTip
				text="A short tone when the app stops waiting for something: a reply written, an assistant turn ended, a question it needs answered. Each event picks its own tone below."
			/>
		</div>
		<div class="toggle-row" use:toggleRow>
			<span class="slider-label">Play a sound when it's your turn again</span>
			<Toggle
				checked={enabled}
				onchange={(v) => audioSettingsStore.setEnabled(v)}
				label="Play a sound when it's your turn again"
			/>
		</div>

		{#if enabled}
			<div class="sub">
				<div class="row-block">
					<span class="slider-label">When to play</span>
					<PillRow
						options={TIMING_OPTIONS}
						current={timing}
						onpick={(v) => audioSettingsStore.setTiming(v as SoundTiming)}
						label="When to play"
					/>
				</div>
				<div class="row-block">
					<span class="slider-label">Volume</span>
					<Slider
						value={volume}
						min={0}
						max={1}
						step={0.01}
						defaultValue={DEFAULT_VOLUME}
						format={(v) => (Math.round(v * 100) === 0 ? 'Muted' : `${Math.round(v * 100)}%`)}
						oninput={handleVolume}
						label="Volume"
					/>
				</div>
				<!-- Said on the page rather than hidden in a tooltip: it decides whether the
				     feature is worth turning on for someone who reads on a phone. -->
				<p class="note">
					Sounds reach you while ChungusHub is open behind another window or in another tab.
					Leaving the browser entirely on a phone puts the page to sleep, and a sleeping page
					cannot make a sound.
				</p>
			</div>
		{/if}
	</section>

	{#if enabled}
		<section class="card" data-setting="sound-events">
			<div class="card-head">
				<span class="card-title">Events</span>
				<InfoTip text="Open an event to hear the tones. Tapping one plays it and assigns it." />
			</div>

			{#each SOUND_EVENTS as event (event.id)}
				{@const current = audioSettingsStore.toneFor(event.id)}
				{@const open = openEvent === event.id}
				<div class="event" class:is-open={open}>
					<button
						type="button"
						class="event-head"
						onclick={() => toggleOpen(event.id)}
						aria-expanded={open}
					>
						<span class="event-text">
							<span class="event-label">{event.label}</span>
							<span class="event-desc">{event.description}</span>
						</span>
						<span class="event-tone" class:is-silent={current === null}>
							{current ? toneLabel(current) : 'None'}
						</span>
						<Icon name="chevronDown" class="event-chev" />
					</button>

					{#if open}
						<div class="tones" role="radiogroup" aria-label="{event.label}: tone">
							<button
								type="button"
								class="tone"
								class:is-active-tint={current === null}
								role="radio"
								aria-checked={current === null}
								onclick={() => pickTone(event.id, null)}
							>
								None
							</button>
							{#each TONES as tone (tone.id)}
								<button
									type="button"
									class="tone"
									class:is-active-tint={current === tone.id}
									role="radio"
									aria-checked={current === tone.id}
									onclick={() => pickTone(event.id, tone.id)}
								>
									{tone.label}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/each}

			<!-- The switch above says on while nothing can play, which is the one state on this
			     page a reader could sit in wondering what is broken. -->
			{#if allSilent}
				<p class="note">Every event is set to None, so the app stays quiet.</p>
			{/if}
		</section>
	{/if}

	<section class="card" data-setting="soundscape">
		<div class="card-head">
			<span class="card-title">Soundscape</span>
			<InfoTip
				text="A bed of ambient recordings played underneath the story: rain on a window, a crowded bar, a fire. Any number can play at once, each at its own level."
			/>
		</div>
		<SoundscapeMixer />
	</section>
</div>

<style>
	.audio {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	/* Same quiet seam the other settings pages use under a card's own switch. */
	.sub {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 0.9rem;
		padding-top: 0.8rem;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 45%, transparent);
	}

	.row-block {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.note {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	.event + .event {
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 40%, transparent);
	}

	.event-head {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.7rem 0;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: inherit;
	}

	.event-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}

	.event-label {
		font-family: var(--font-ui);
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.event-desc {
		font-family: var(--font-ui);
		font-size: 0.72rem;
		line-height: 1.4;
		color: var(--color-text-muted);
	}

	.event-tone {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--color-accent);
	}

	.event-tone.is-silent {
		color: var(--color-text-muted);
		font-weight: 500;
	}

	.event-head :global(.event-chev) {
		flex-shrink: 0;
		width: 0.9rem;
		height: 0.9rem;
		color: var(--color-text-muted);
		transition: transform 140ms ease;
	}

	.event.is-open .event-head :global(.event-chev) {
		transform: rotate(180deg);
	}

	.tones {
		display: flex;
		flex-wrap: wrap;
		/* Wider than a pill row's own gap: this is ten targets that wrap onto several lines
		   and get tapped in a run, where a pill row is three that get tapped once. */
		gap: 0.4rem;
		padding: 0 0 0.85rem;
	}

	.tone {
		padding: 0.35rem 0.7rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.76rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			color 120ms ease,
			border-color 120ms ease,
			background-color 120ms ease;
	}

	.tone:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-border) 90%, transparent);
	}

	/* Scoped active tint, for the same reason PillRow carries one: the canonical
	   .is-active-tint recipe sits in a cascade layer that this unlayered scoped base
	   would otherwise win against. After :hover, so the picked tone stays tinted. */
	.tone.is-active-tint {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 33%, transparent);
	}
</style>
