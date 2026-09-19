<script lang="ts">
	/**
	 * The Chungus Assistant title-bar button's own standing. It only exists once the floating
	 * launcher is switched off (Settings → General, `generalSettings.assistantLauncher`); with
	 * the corner mascot gone, this is the one place outside the panel itself where a running
	 * turn or a card waiting on an answer can still be seen. It reads the same global
	 * `assistantSessionStore` getters the floating launcher's own busy/waiting marks use
	 * (`AssistantFloatingWidget.svelte`), so the two surfaces never disagree about whether the
	 * assistant is working.
 *
 * Two rows drive the one field. Settings > General asks it directly (show the floating
 * launcher), and the assistant's own settings page asks the opposite question, "on top
 * bar instead of floating icon", which is the way somebody hunting for this arrives at
 * it. Neither row holds state of its own, so they cannot drift apart.
	 *
	 * The launcher's third mark, the "just finished" bounce, does NOT ride this button. That
	 * badge latches on a busy-to-idle transition tracked by a `$state` local to the launcher
	 * component, armed only while the launcher itself is shown; duplicating that latch here
	 * would need a second copy of the same transition that could drift from the first for no
	 * real gain, since opening the panel says the same thing immediately.
	 */
	import AssistantMascot from './AssistantMascot.svelte';
	import { assistantSessionStore } from '$lib/stores/assistantSessions.svelte';

	let busy = $derived(assistantSessionStore.anyBusy);
	let waiting = $derived(assistantSessionStore.anyPendingAsk);
</script>

<span class="assistant-glyph" class:is-busy={busy && !waiting}>
	<AssistantMascot size={16} />
</span>
<!-- Fills the button, takes part in none of its layout: same recipe as MemoryNavStatus. -->
<span class="assistant-status" aria-hidden="true">
	{#if waiting || busy}
		<span class="assistant-mark"></span>
	{/if}
</span>

<style>
	.assistant-glyph {
		display: inline-flex;
		flex: 0 0 auto;
		color: inherit;
	}

	/* Busy pulses; waiting holds it still (mirrors the floating launcher: a still badge says
	   "look here", a pulsing one says "leave it alone"). */
	.assistant-glyph.is-busy {
		color: var(--color-accent);
		filter: drop-shadow(0 0 4px color-mix(in srgb, var(--color-accent) 55%, transparent));
		animation: assistant-glyph-pulse 1.2s ease-in-out infinite alternate;
	}

	@keyframes assistant-glyph-pulse {
		from {
			opacity: 0.6;
		}
		to {
			opacity: 1;
		}
	}

	.assistant-status {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.assistant-mark {
		position: absolute;
		top: 0.2rem;
		right: 0.24rem;
		width: 5px;
		height: 5px;
		border-radius: var(--radius-full);
		background: var(--color-accent);
	}

	@media (prefers-reduced-motion: reduce) {
		.assistant-glyph.is-busy {
			animation: none;
		}
	}
</style>
