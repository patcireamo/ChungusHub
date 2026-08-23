<script lang="ts">
	/**
	 * The one question an opening scene has: what should it be about.
	 *
	 * A popover rather than a modal, and one box rather than a Random/Custom pair, because
	 * leaving the box empty IS the random answer and a choice that answers itself does not
	 * deserve a step of its own. It closes the moment generation starts: the scene streams
	 * into the transcript behind it, and the composer's Stop has to be reachable while it does.
	 *
	 * Positioned against the caller's own `position: relative` wrapper, so the trigger stays
	 * where it belongs (the empty-state card, a root turn's pager cluster) and this owns only
	 * the panel and its click-away.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import { autoResize } from '$lib/actions/autoResize';
	import { viewport } from '$lib/stores/viewport.svelte';

	interface Props {
		open: boolean;
		/** Which edge the panel hangs from, so it never opens off the side of the screen. */
		align?: 'left' | 'right' | 'center';
		onClose: () => void;
		onGenerate: (direction: string) => void;
	}

	let { open, align = 'left', onClose, onGenerate }: Props = $props();

	let direction = $state('');
	let boxElement = $state<HTMLTextAreaElement | undefined>(undefined);

	$effect(() => {
		if (open) boxElement?.focus();
	});

	function submit() {
		onGenerate(direction);
		// Deliberately not cleared: rolling the same idea again is then one press. It is
		// component state and dies with the row, since a direction is not a draft.
		onClose();
	}

	/** Consumed per the shell Esc contract: closing this must not also close a panel behind it. */
	function handleEscape(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		e.stopPropagation();
		onClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			handleEscape(e);
			return;
		}
		// Enter submits on pointer devices only, the composer's own rule: on touch Enter is a
		// newline and the button is the way through.
		if (e.key === 'Enter' && !e.shiftKey && !viewport.isTouch) {
			e.preventDefault();
			submit();
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-10"
		onclick={onClose}
		onkeydown={handleEscape}
		role="button"
		tabindex="-1"
		aria-label="Close"
	></div>
	<div class="opening-panel surface-float slide-up align-{align}" style="box-shadow: var(--shadow-md);">
		<textarea
			class="opening-box"
			rows="2"
			bind:this={boxElement}
			bind:value={direction}
			use:autoResize={{ maxHeight: 140, value: direction, grip: false }}
			onkeydown={handleKeydown}
			aria-label="Direction for the opening scene"
			placeholder="Direction for the scene…"
		></textarea>
		<button type="button" class="opening-go" onclick={submit}>
			<Icon name="sparkles" class="w-3.5 h-3.5" strokeWidth={1.75} />
			{direction.trim() ? 'Generate' : 'Surprise me'}
		</button>
	</div>
{/if}

<style>
	.opening-panel {
		position: absolute;
		top: 100%;
		margin-top: 0.5rem;
		z-index: 20;
		width: 19rem;
		max-width: calc(100vw - 2rem);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.6rem;
		border-radius: var(--radius-lg);
	}

	.align-left {
		left: 0;
	}

	.align-right {
		right: 0;
	}

	/* Auto margins between pinned edges, never `left: 50%` + a translate: the entry animation
	   owns `transform` and would override the centring for its whole duration. It also stays
	   centred once `max-width` narrows the panel on a phone, which a fixed offset would not. */
	.align-center {
		left: 0;
		right: 0;
		margin-inline: auto;
	}

	/* `.input-base` is a surface and a border, and every field pairs it with a recipe carrying
	   the padding and the type. The composer's popovers declare their own instead, so this is
	   the steering quick box's, kept identical: the two boxes sit one gesture apart. */
	.opening-box {
		width: 100%;
		padding: 0.45rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-primary) 65%, transparent);
		color: var(--color-text-primary);
		font-family: var(--font-body);
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.opening-box:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	.opening-box::placeholder {
		color: var(--color-text-muted);
	}

	.opening-go {
		align-self: flex-end;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.7rem;
		border: 1px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 120ms ease, border-color 120ms ease;
	}

	.opening-go:hover {
		background: color-mix(in srgb, var(--color-accent) 22%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 65%, transparent);
	}

	.opening-go:focus-visible {
		outline: 0;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent-muted) 70%, transparent);
	}

	/* Thumb-sized on touch, the rule every other control in the message toolbar follows. */
	@media (pointer: coarse) {
		.opening-go {
			padding: 0.55rem 0.9rem;
			font-size: 0.8rem;
		}
	}
</style>
