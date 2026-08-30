<script lang="ts">
	/**
	 * The open chat has taken this panel's subject for itself.
	 *
	 * Raised by the panels that speak for the app about something a chat can claim, and only
	 * while the open chat has actually broken away. Without it those screens fail silently in
	 * the worst way available: the control answers, the value saves, and the story the reader
	 * is looking at goes on ignoring every word of it.
	 *
	 * The sentence lives here rather than at the three call sites, and it names BOTH sides,
	 * because either one alone leaves the reader a question: what the chat runs without what
	 * this panel says is the same puzzle from the other end. The claim itself is made in the
	 * composer's setup chip and can never be made from here, which is what keeps this a notice
	 * and not a control.
	 *
	 * Warning, not error: a chat running its own setup is a thing somebody chose, and red would
	 * read as a fault to go and fix.
	 */
	import Icon from './Icon.svelte';

	interface Props {
		/** What this panel decides, named exactly as the panel names it. */
		subject: string;
		/** What the open chat uses instead. */
		using: string;
		/** This panel's own answer: what the chat is ignoring. */
		instead: string;
	}

	let { subject, using, instead }: Props = $props();
</script>

<p class="chat-override font-ui" role="status">
	<Icon name="warning" class="w-3.5 h-3.5 shrink-0 chat-override-icon" strokeWidth={1.75} />
	<span>The open chat overrides {subject}: it uses “{using}”, not “{instead}”.</span>
</p>

<style>
	/* A tinted band rather than bare text: this is a standing fact about the whole panel, not
	   one row's validation message. */
	.chat-override {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		margin: 0;
		padding: 0.5rem 0.65rem;
		border: 1px solid color-mix(in srgb, var(--color-warning) 34%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-warning) 10%, transparent);
		color: color-mix(in srgb, var(--color-warning) 72%, var(--color-text-primary));
		font-size: 0.75rem;
		line-height: 1.45;
	}

	/* The glyph holds the first line of a message that wraps, which on a phone it always does. */
	.chat-override :global(.chat-override-icon) {
		margin-top: 0.14rem;
		color: var(--color-warning);
	}
</style>
