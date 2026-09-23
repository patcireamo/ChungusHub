<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import { soundscapeStore } from '$lib/stores/soundscape.svelte';
	import { soundscapePlayer } from '$lib/services/soundscapePlayer.svelte';

	let playing = $derived(soundscapeStore.playing);
	let empty = $derived(soundscapeStore.activeIds.length === 0);
	// Lit by what is audible rather than by the press: a mix still starting, or held back by the
	// browser, is not playing yet, and this is the one mark on the list that says whether it is.
	let sounding = $derived(
		playing &&
			!soundscapePlayer.blocked &&
			soundscapeStore.activeIds.some((id) => soundscapePlayer.sounding.has(id))
	);
	let label = $derived(playing ? 'Pause the mix' : 'Play the mix');
</script>

<button
	type="button"
	class="play"
	class:is-sounding={sounding}
	disabled={empty}
	aria-label={label}
	title={empty ? undefined : label}
	onclick={() => soundscapeStore.setPlaying(!playing)}
>
	<Icon name={playing ? 'pause' : 'play'} class="play-glyph" />
</button>

<style>
	.play {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		aspect-ratio: 1;
		padding: 0;
		border-radius: var(--radius-full);
		border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition:
			background 120ms ease,
			border-color 120ms ease,
			color 120ms ease;
	}

	.play:hover:not(:disabled) {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
	}

	.play.is-sounding {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 35%, transparent);
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
	}

	.play.is-sounding:hover {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 22%, transparent);
	}

	.play:disabled {
		cursor: default;
		color: var(--color-text-muted);
		border-color: color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
	}

	.play :global(.play-glyph) {
		width: 0.85rem;
		height: 0.85rem;
	}
</style>
