<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import Icon from './Icon.svelte';

	type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

	const sizeClasses: Record<DialogSize, string> = {
		sm: 'max-w-sm',
		md: 'max-w-md',
		lg: 'max-w-lg',
		xl: 'max-w-3xl',
		// For a dialog whose subject is machine text rather than prose, where a narrow
		// measure is not a kindness but a second scrollbar.
		'2xl': 'max-w-5xl'
	};

	interface Props {
		open: boolean;
		onClose: () => void;
		title?: string;
		size?: DialogSize;
		/** A dialog that must be answered rather than escaped: no close X, and Escape
		 *  and the backdrop stop dismissing. All three go together on purpose. Leaving
		 *  the X while blocking the key would leave a button on screen that does
		 *  nothing, which is the one thing a control is never allowed to be. Use it
		 *  only where closing would leave the app in a state it cannot work in. */
		dismissible?: boolean;
		/** Hands the whole panel to the child: no padding of its own and no scroller of its
		 *  own, so a surface that needs a head and a foot standing still around a scrolling
		 *  middle can build one. The child then owns every edge, scrolling included. */
		bare?: boolean;
		/** Take the full height a dialog is allowed instead of the height of the content, so
		 *  the box is the same size whatever it is asked to hold. For a surface that is a place
		 *  to work rather than something to read: one that resized itself per request would
		 *  move its own controls under the pointer between one opening and the next. */
		fill?: boolean;
		children: Snippet;
	}

	let {
		open,
		onClose,
		title,
		size = 'md',
		dismissible = true,
		bare = false,
		fill = false,
		children
	}: Props = $props();

	/** The single door: every dismissal route runs through here, so `dismissible`
	 *  cannot be honoured by one of them and forgotten by another. */
	function requestClose(): void {
		if (dismissible) onClose();
	}

	const titleId = `dialog-title-${crypto.randomUUID()}`;
	let dialogEl: HTMLDivElement | null = $state(null);
	let portalEl: HTMLDivElement | null = $state(null);
	let previouslyFocused: HTMLElement | null = null;

	const focusableSelector =
		'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], summary';

	function getFocusableElements(): HTMLElement[] {
		if (!dialogEl) return [];
		return Array.from(dialogEl.querySelectorAll<HTMLElement>(focusableSelector)).filter(
			(el) => !el.hasAttribute('disabled') && el.offsetParent !== null
		);
	}

	function trapFocus(e: KeyboardEvent) {
		if (e.key !== 'Tab') return;

		const focusable = getFocusableElements();
		if (focusable.length === 0) return;

		const first = focusable[0];
		const last = focusable[focusable.length - 1];

		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	// Portal: move dialog to body to escape stacking contexts (e.g., backdrop-filter)
	$effect(() => {
		if (open && portalEl) {
			document.body.appendChild(portalEl);
			previouslyFocused = document.activeElement as HTMLElement | null;
			// Double rAF ensures DOM is fully painted before focusing
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					const focusable = getFocusableElements();
					if (focusable.length > 0) {
						focusable[0].focus();
					} else {
						dialogEl?.focus();
					}
				});
			});
		}

		return () => {
			if (portalEl && portalEl.parentNode === document.body) {
				document.body.removeChild(portalEl);
			}
			if (previouslyFocused) {
				previouslyFocused.focus();
				previouslyFocused = null;
			}
		};
	});

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			requestClose();
		}
	}

	function handleBackdropKeydown(e: KeyboardEvent) {
		// Allow Enter/Space on backdrop to close (keyboard equivalent of click)
		if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
			requestClose();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			requestClose();
		}
		trapFocus(e);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
<div bind:this={portalEl} class="dialog-portal">
	<!-- Backdrop -->
	<div
		class="dialog-scrim fixed inset-0 z-[300] flex items-start justify-center px-3 panel-scroll"
		style="background: var(--color-overlay); backdrop-filter: var(--backdrop-blur);"
		onclick={handleBackdropClick}
		onkeydown={handleBackdropKeydown}
		role="dialog"
		aria-modal="true"
		aria-labelledby={title ? titleId : undefined}
		tabindex="-1"
		transition:fade={{ duration: 200 }}
	>
		<!-- Dialog panel wrapper - non-scrolling container for close button -->
		<div
			class="dialog-panel surface-float relative w-full {sizeClasses[size]} mb-8 rounded-[var(--radius-xl)] {bare
				? 'flex flex-col overflow-hidden'
				: ''} {fill ? 'dialog-panel--fill' : ''}"
			style="box-shadow: var(--shadow-lg);"
			transition:fly={{ y: 20, duration: 200 }}
		>
			<!-- Close button - outside scrollable area so it never disappears. Gone
			     entirely while the dialog must be answered, never shown inert. -->
			{#if dismissible}
				<button
					type="button"
					class="absolute top-3 right-3 icon-btn hover:bg-bg-tertiary z-10"
					onclick={onClose}
					aria-label="Close dialog"
				>
					<Icon name="close" class="w-5 h-5" />
				</button>
			{/if}

			<!-- Scrollable content area, unless the child asked to own its own edges -->
			<div
				bind:this={dialogEl}
				class="dialog-body {bare ? 'flex flex-col min-h-0 flex-1' : 'panel-scroll overscroll-contain'}"
			>
				{#if title}
					<div class="px-5 py-3 border-b border-border-subtle">
						<h2 id={titleId} class="text-lg font-ui font-semibold text-text-primary text-center">
							{title}
						</h2>
					</div>
				{/if}

				{#if bare}
					{@render children()}
				{:else}
					<div class="p-5">
						{@render children()}
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
{/if}

<style>
	/* The room a panel has, declared where it is actually spent so nothing below has to
	   restate it: this padding, top and bottom, and the panel between them. */
	.dialog-scrim {
		--dialog-inset: 4dvh;
		padding-block: var(--dialog-inset);
	}

	/* The ceiling every dialog stands under, declared once so `fill` can reach for exactly it
	   rather than restate the number and drift from it on the phone. */
	.dialog-panel {
		--dialog-max-h: 90dvh;
		max-height: var(--dialog-max-h);
	}

	/* Never taller than the room the scrim leaves it, and without the gap a content-sized
	   dialog keeps under itself: a filling panel that overshoots by a few pixels hands the
	   backdrop a scrollbar of its own, which is a second scroller over one surface. */
	.dialog-panel--fill {
		height: min(var(--dialog-max-h), calc(100dvh - 2 * var(--dialog-inset)));
		margin-bottom: 0;
	}

	.dialog-body {
		max-height: var(--dialog-max-h);
	}

	@media (max-width: 700px) {
		.dialog-panel {
			--dialog-max-h: 94vh;
			max-width: 100% !important;
			border-radius: var(--radius-lg);
		}
	}
</style>
