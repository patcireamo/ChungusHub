<script lang="ts">
	import SoundscapeMixer from '$lib/components/audio/SoundscapeMixer.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
</script>

<section class="card" data-setting="soundscape">
	<div class="card-head">
		<span class="card-title">Soundscape</span>
		<InfoTip
			text="A bed of ambient recordings played underneath the story: rain on a window, a crowded bar, a fire. Any number can play at once, each at its own level."
		/>
	</div>
	<SoundscapeMixer />
</section>
