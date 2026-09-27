<!--
  A pop-out editor for every multi-line field in the app. Mounted once, in AppShell; it
  watches focus, so no editor has to opt in. Whichever `<textarea>` has focus gets a small
  button in its corner, and the button opens the field's text in a large editor: a panel on
  a desktop, the whole screen on a phone. Edits are written back to the field as they are
  typed, through the field's own `input` event, so the owning component cannot tell them
  from typing. See architecture/text-popout.md.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import Icon from './Icon.svelte';
	import { copyText } from '$lib/utils/clipboard';
	import {
		finishEdit,
		isPopoutEligible,
		placeButton,
		popoutTitle,
		writeBack
	} from '$lib/utils/text-popout';

	const BUTTON_SIZE = 30;
	const BUTTON_INSET = 6;
	/** How long a field may be without focus before its button goes. Long enough for a tap
	 *  on the button to land after the tap itself has blurred the field. */
	const HIDE_DELAY_MS = 200;

	/** The focused field the button is offered on. */
	let field = $state<HTMLTextAreaElement | null>(null);
	let spot = $state<{ top: number; left: number } | null>(null);
	/** The field whose text is open in the editor. Set only while the editor is open. */
	let source = $state<HTMLTextAreaElement | null>(null);

	let draft = $state('');
	let title = $state('');
	let readOnly = $state(false);
	let maxLength = $state<number | undefined>(undefined);
	let spellcheck = $state(true);
	let fontFamily = $state('');
	let fontSize = $state('');
	/** The source field went away while its text was open, so edits have nowhere to go. */
	let orphaned = $state(false);
	/** The visual viewport's height, where it is shorter than the layout viewport: iOS keeps
	 *  the keyboard out of `dvh`, so without this the editor's foot sits under it. */
	let viewportHeight = $state<number | null>(null);

	let editorEl = $state<HTMLTextAreaElement | null>(null);
	let panelEl = $state<HTMLDivElement | null>(null);
	/** The text the source held when the editor opened. */
	let initial = '';
	/** The field a press on the button began on; the press itself may blur it. */
	let armed: HTMLTextAreaElement | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let frame = 0;
	let resizeObserver: ResizeObserver | undefined;

	const titleId = `text-popout-title-${crypto.randomUUID()}`;

	/** Paint on `<body>`, clear of any stacking context around the mount point. */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	function track(el: HTMLTextAreaElement): void {
		if (field !== el) {
			resizeObserver?.disconnect();
			field = el;
			resizeObserver?.observe(el);
		}
		schedule();
	}

	function untrack(): void {
		resizeObserver?.disconnect();
		field = null;
		spot = null;
	}

	function schedule(): void {
		if (!frame) frame = requestAnimationFrame(reposition);
	}

	function reposition(): void {
		frame = 0;
		if (!field || source) {
			spot = null;
			return;
		}
		if (!field.isConnected) {
			untrack();
			return;
		}
		spot = placeButton(field.getBoundingClientRect(), {
			size: BUTTON_SIZE,
			inset: BUTTON_INSET,
			scrollbar: field.offsetWidth - field.clientWidth,
			viewportHeight: window.innerHeight
		});
	}

	function onFocusIn(e: FocusEvent): void {
		if (source) return;
		const target = e.target;
		if (target instanceof HTMLTextAreaElement && isPopoutEligible(target)) {
			clearTimeout(hideTimer);
			track(target);
		}
	}

	function onFocusOut(e: FocusEvent): void {
		if (source || e.target !== field) return;
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			if (!source && document.activeElement !== field) untrack();
		}, HIDE_DELAY_MS);
	}

	function syncViewport(): void {
		const vv = window.visualViewport;
		viewportHeight = vv && vv.height < window.innerHeight - 1 ? vv.height : null;
		schedule();
	}

	/**
	 * Registered once, at boot, on the window's capture phase, so it runs ahead of every
	 * Escape handler a surface adds later (Dialog, Settings, the prompt review). While the
	 * editor is open it owns Escape and Tab outright; the surface underneath hears neither.
	 */
	function onKeydown(e: KeyboardEvent): void {
		if (!source || e.isComposing) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopImmediatePropagation();
			close();
		} else if (e.key === 'Tab' && panelEl) {
			e.preventDefault();
			e.stopImmediatePropagation();
			const stops = Array.from(
				panelEl.querySelectorAll<HTMLElement>('button:not([disabled]), textarea')
			);
			if (stops.length === 0) return;
			const at = stops.indexOf(document.activeElement as HTMLElement);
			const next = at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
			stops[next].focus();
		}
	}

	async function open(el: HTMLTextAreaElement | null): Promise<void> {
		armed = null;
		if (!el || !el.isConnected || source) return;
		clearTimeout(hideTimer);

		const style = getComputedStyle(el);
		const selection = [el.selectionStart, el.selectionEnd] as const;
		initial = el.value;
		draft = el.value;
		readOnly = el.readOnly;
		maxLength = el.maxLength > 0 ? el.maxLength : undefined;
		spellcheck = el.spellcheck;
		fontFamily = style.fontFamily;
		fontSize = style.fontSize;
		orphaned = false;
		title = popoutTitle({
			label: el.labels?.[0]?.textContent,
			ariaLabel: el.getAttribute('aria-label'),
			placeholder: el.placeholder
		});
		source = el;
		spot = null;

		await tick();
		if (!editorEl) return;
		editorEl.focus({ preventScroll: true });
		editorEl.setSelectionRange(selection[0], selection[1]);
	}

	function onEditorInput(e: Event & { currentTarget: HTMLTextAreaElement }): void {
		draft = e.currentTarget.value;
		if (!source || readOnly) return;
		if (!source.isConnected) {
			orphaned = true;
			return;
		}
		writeBack(source, draft);
	}

	function close(): void {
		const el = source;
		if (!el) return;
		const selection = editorEl ? ([editorEl.selectionStart, editorEl.selectionEnd] as const) : null;
		source = null;
		if (!el.isConnected) return;

		// Handing focus back on a phone raises the keyboard over whatever the field sits in,
		// which is rarely what closing the editor was for.
		const refocus = window.matchMedia('(pointer: fine)').matches;
		if (!readOnly) finishEdit(el, initial, refocus);
		if (refocus) {
			el.focus({ preventScroll: true });
			if (selection) el.setSelectionRange(selection[0], selection[1]);
		}
	}

	function onScrimClick(e: MouseEvent): void {
		// Every edit is already in the field, so a stray press outside loses nothing.
		if (e.target === e.currentTarget) close();
	}

	onMount(() => {
		resizeObserver = new ResizeObserver(schedule);
		const vv = window.visualViewport;
		document.addEventListener('focusin', onFocusIn, true);
		document.addEventListener('focusout', onFocusOut, true);
		window.addEventListener('keydown', onKeydown, true);
		window.addEventListener('scroll', schedule, { capture: true, passive: true });
		window.addEventListener('resize', syncViewport);
		vv?.addEventListener('resize', syncViewport);
		vv?.addEventListener('scroll', schedule);
		return () => {
			document.removeEventListener('focusin', onFocusIn, true);
			document.removeEventListener('focusout', onFocusOut, true);
			window.removeEventListener('keydown', onKeydown, true);
			window.removeEventListener('scroll', schedule, true);
			window.removeEventListener('resize', syncViewport);
			vv?.removeEventListener('resize', syncViewport);
			vv?.removeEventListener('scroll', schedule);
			resizeObserver?.disconnect();
			clearTimeout(hideTimer);
			if (frame) cancelAnimationFrame(frame);
		};
	});
</script>

{#if spot && field && !source}
	<button
		use:portal
		type="button"
		class="text-popout-trigger"
		style="top: {spot.top}px; left: {spot.left}px; width: {BUTTON_SIZE}px; height: {BUTTON_SIZE}px;"
		aria-label="Open in a larger editor"
		title="Open in a larger editor"
		aria-haspopup="dialog"
		onpointerdown={(e) => {
			// Keep focus (and a phone's keyboard) on the field until the editor takes it.
			e.preventDefault();
			armed = field;
		}}
		onmousedown={(e) => e.preventDefault()}
		onclick={() => void open(armed ?? field)}
	>
		<svg
			viewBox="0 0 24 24"
			class="w-4 h-4"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
		</svg>
	</button>
{/if}

{#if source}
	<div
		use:portal
		class="text-popout-scrim"
		style={viewportHeight ? `height: ${viewportHeight}px;` : ''}
		onclick={onScrimClick}
		role="presentation"
		transition:fade={{ duration: 150 }}
	>
		<div
			bind:this={panelEl}
			class="text-popout-panel surface-float"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
		>
			<div class="text-popout-head">
				<h2 id={titleId} class="text-popout-title">{title}</h2>
				<span class="text-popout-meta">
					{#if readOnly}Read only ·{/if}
					{draft.length.toLocaleString()}{maxLength ? ` / ${maxLength.toLocaleString()}` : ''} chars
				</span>
				<button type="button" class="icon-btn" onclick={close} aria-label="Close editor" title="Close (Esc)">
					<Icon name="close" class="w-5 h-5" />
				</button>
			</div>

			{#if orphaned}
				<div class="text-popout-orphaned" role="alert">
					<span>The field this text came from has closed, so edits here are no longer saved.</span>
					<button type="button" class="text-popout-copy" onclick={() => void copyText(draft)}>
						Copy text
					</button>
				</div>
			{/if}

			<!-- Opted out, or focusing it would offer a pop-out of the pop-out. -->
			<textarea
				bind:this={editorEl}
				data-no-popout
				class="text-popout-editor panel-scroll"
				style="font-family: {fontFamily}; font-size: max(16px, {fontSize});"
				value={draft}
				readonly={readOnly}
				maxlength={maxLength}
				{spellcheck}
				aria-labelledby={titleId}
				oninput={onEditorInput}
			></textarea>
		</div>
	</div>
{/if}

<style>
	/* Above the dialogs (z 300), so a field inside one still gets its button. */
	.text-popout-trigger {
		position: fixed;
		z-index: 310;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-elevated) 88%, transparent);
		color: var(--color-text-secondary);
		box-shadow: var(--shadow-sm);
		opacity: 0.8;
		transition:
			opacity 120ms ease,
			color 120ms ease;
	}

	.text-popout-trigger:hover,
	.text-popout-trigger:focus-visible {
		opacity: 1;
		color: var(--color-text-primary);
	}

	/* Above the dialogs too: the field being edited may live in one. */
	.text-popout-scrim {
		position: fixed;
		inset: 0 0 auto 0;
		height: 100dvh;
		z-index: 400;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4dvh 0.75rem;
		background: var(--color-overlay);
		backdrop-filter: var(--backdrop-blur);
	}

	.text-popout-panel {
		display: flex;
		flex-direction: column;
		width: 100%;
		max-width: 64rem;
		height: 100%;
		overflow: hidden;
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-lg);
	}

	.text-popout-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-shrink: 0;
		padding: 0.5rem 0.5rem 0.5rem 1.25rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.text-popout-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.text-popout-meta {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-muted);
	}

	.text-popout-orphaned {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-shrink: 0;
		padding: 0.5rem 1.25rem;
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-warning);
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.text-popout-copy {
		flex-shrink: 0;
		padding: 0.25rem 0.6rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-text-primary);
	}

	/* The editor owns the only scrollbar; the head stays put above it. */
	.text-popout-editor {
		flex: 1;
		min-height: 0;
		width: 100%;
		padding: clamp(1rem, 2.5vw, 1.75rem);
		padding-bottom: max(clamp(1rem, 2.5vw, 1.75rem), env(safe-area-inset-bottom));
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--color-text-primary);
		line-height: 1.6;
		resize: none;
		overscroll-behavior: contain;
	}

	/* A phone gets the whole screen: a panel with margins round it would spend the width
	   this exists to give back. The 16px font floor on the editor also keeps iOS from
	   zooming the page when it takes focus. */
	@media (max-width: 700px) {
		.text-popout-scrim {
			padding: 0;
		}

		.text-popout-panel {
			max-width: none;
			border-radius: 0;
			padding-top: env(safe-area-inset-top);
		}
	}
</style>
