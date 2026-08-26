<script lang="ts">
	import MessageList from './MessageList.svelte';
	import InputArea from './InputArea.svelte';
	import PortraitViewer from './PortraitViewer.svelte';
	import SpriteLayer from './SpriteLayer.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { messageStore } from '$lib/stores/messages.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import type { MessageAttachment } from '$lib/types/chat';

	let chatState = $derived(chatStore.currentChatState);
	// Everything the transcript paints comes off the VISIBLE stream, so a reply still
	// arriving in a chat the reader has left cannot spill its tokens into this one.
	let stream = $derived(chatStore.visibleStream);
	let isStreaming = $derived(stream !== null);
	let streamingContent = $derived(stream?.content ?? '');
	let streamingThinking = $derived(stream?.thinking ?? '');
	let continuingMessageId = $derived(stream?.continuingMessageId ?? null);
	let openingSceneStream = $derived(stream?.openingScene ?? false);
	// A reply being written for this chat that this page never started: after a reload (the
	// ordinary way a phone comes back), or from another device. It has no stream here to
	// paint, but the chat is genuinely busy and its Stop has to work.
	let liveElsewhere = $derived(chatStore.visibleLiveElsewhere);
	// The composer asks the app instead: a generation running anywhere holds the one abort
	// controller, so this chat offers Stop rather than a Send that would race it.
	let busy = $derived(messageStore.isStreaming || liveElsewhere !== null);
	let activePath = $derived(chatState?.activePath ?? []);
	let allMessages = $derived(chatState?.allMessages ?? []);

	// Chats are only born from the New chat flow (character + persona picked
	// through the Library), so this hands off to it rather than creating anything here.
	function handleNewChat() {
		uiStore.startNewChat();
	}

	function handleSendMessage(content: string, attachments?: MessageAttachment[], onCommit?: () => void) {
		if (!chatState) return;
		messageStore.sendMessage(content, attachments, onCommit);
	}

	function handleCancelGeneration() {
		messageStore.cancelGeneration();
	}

	function handleInsertDummy(role: 'user' | 'assistant') {
		if (!chatState) return;
		messageStore.insertDummyMessage(role);
	}

	// The composer's shortcut to the last reply's own Retry → "Replace current". No try/catch
	// here on purpose: unlike continueMessage, retryMessageResponse already toasts its own
	// failures, so wrapping it would double every error message.
	function handleRegenerateLast() {
		if (!chatState) return;
		messageStore.regenerateLastResponse('replace');
	}

	// The same call with the non-destructive action: keep what is there and add a sibling to
	// swipe between. Reached only by `/swipe`; the composer menu carries Retry alone, because
	// the transcript's own Retry button already offers both rows on the turn itself.
	function handleSwipeLast() {
		if (!chatState) return;
		messageStore.regenerateLastResponse('branch');
	}

	// Same shape as the opening-scene call site: the store's guard errors (engine off,
	// vanished target) surface as toasts instead of unhandled rejections.
	async function handleContinue() {
		if (!chatState) return;
		try {
			await messageStore.continueMessage();
		} catch (error) {
			toastStore.failed('continue the reply', error);
		}
	}

	// The centered column leaves empty margins on wide screens. When a side dock is
	// open it covers its margin and eats the wheel itself; when it's closed the margin
	// is dead space and the wheel never reaches the scroller. Forward it manually so
	// the reader can scroll the story from anywhere. (Over the column the native
	// scroller already handles it; while an overlay hides the chat the margins go
	// pointer-events-inert, so this only fires over genuinely empty margin.)
	let scrollEl = $state<HTMLDivElement>();

	// Feel has to match scrolling over the column exactly. The column glides because the
	// scroller carries CSS `scroll-behavior: smooth`; reading its live scrollTop back
	// mid-glide and adding a notch only ever nudges the target one step ahead, which
	// crawls. So we hold our OWN target that races ahead of the still-animating position
	// and write it to scrollTop. The same CSS animator then glides to it, identical to
	// the column. The target resets to the live position once the gesture goes idle, so a
	// native scroll in between can't make the next notch jump.
	let wheelTarget: number | null = null;
	let wheelIdle: ReturnType<typeof setTimeout> | undefined;

	// `.chat-content` wraps the composer as well as the transcript, and the forward below
	// preventDefaults, so a scrollable box under the pointer that ISN'T the message scroller
	// (the textarea once the draft outgrows its 200px cap, the persona popover's list) would
	// never scroll itself: the story would scroll under it instead. Walk up to the margin
	// element and let any real scroller on the way keep its own wheel. The walk only ever runs
	// over the composer: over the transcript the `contains` check above returns first, and over
	// the margin the target IS the stop element, so the loop never enters.
	function consumesWheel(e: WheelEvent): boolean {
		let el = e.target instanceof Element ? e.target : null;
		while (el && el !== e.currentTarget) {
			if (el.scrollHeight > el.clientHeight) {
				const overflowY = getComputedStyle(el).overflowY;
				// A textarea scrolls its own overflow whatever the UA sheet computes to.
				if (el instanceof HTMLTextAreaElement || overflowY === 'auto' || overflowY === 'scroll') {
					return true;
				}
			}
			el = el.parentElement;
		}
		return false;
	}

	function handleMarginWheel(e: WheelEvent) {
		if (!scrollEl || scrollEl.contains(e.target as Node)) return;
		if (consumesWheel(e)) return;
		e.preventDefault();
		const max = scrollEl.scrollHeight - scrollEl.clientHeight;
		if (wheelTarget === null) wheelTarget = scrollEl.scrollTop;
		const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scrollEl.clientHeight : 1;
		wheelTarget = Math.max(0, Math.min(max, wheelTarget + e.deltaY * factor));
		scrollEl.scrollTop = wheelTarget;
		clearTimeout(wheelIdle);
		wheelIdle = setTimeout(() => (wheelTarget = null), 150);
	}

	/** Earlier turns loaded above the viewport and the transcript corrected `scrollTop` to
	 *  hold the reading position. The wheel target above is an ABSOLUTE position, so it takes
	 *  the same correction: left alone, the next notch of a wheel that just reached the top
	 *  edge would snap back to where the content used to start, and load again. */
	function handleContentShift(delta: number) {
		if (wheelTarget !== null) wheelTarget += delta;
	}
</script>

<div class="chat-shell">
	{#if chatState}
		<div class="chat-content" onwheel={handleMarginWheel}>
			<div class="chat-center-shell">
				<div class="chat-message-pane">
					<MessageList bind:scrollEl messages={activePath} {allMessages} {isStreaming} {streamingContent} {streamingThinking} {continuingMessageId} {openingSceneStream} onContentShift={handleContentShift} />
				</div>

				<div class="chat-input-pane">
					<InputArea
						onSend={handleSendMessage}
						onCancel={handleCancelGeneration}
						onInsertDummy={handleInsertDummy}
						onContinue={handleContinue}
						onRegenerateLast={handleRegenerateLast}
						onSwipeLast={handleSwipeLast}
						isStreaming={busy}
						generatingSince={liveElsewhere?.startedAt ?? null}
					/>
				</div>
			</div>
		</div>
	{:else}
		<div class="chat-empty-wrap">
			<EmptyState icon="bookOpen" title="No chat open">
				Pick a character and a persona, and the story starts from their first
				message.
				{#snippet actions()}
					<Button variant="primary" size="sm" onclick={handleNewChat}>
						<Icon name="plus" class="w-4 h-4" />
						New chat
					</Button>
				{/snippet}
			</EmptyState>
		</div>
	{/if}

	<!-- Not on a phone: there the chat column is the whole screen, so a standing figure has
	     nowhere to stand that is not on top of the story being read. The layer is also what
	     asks the engine to read a reply, so a phone spends nothing on sprites either. -->
	{#if !viewport.isMobile}
		<SpriteLayer />
	{/if}
	<PortraitViewer />
</div>

<style>
	.chat-shell {
		position: relative;
		height: 100%;
		display: flex;
		flex-direction: column;
		/* Transparent so the workspace-level ambient layer shows through. The chat
		   column's own surfaces (center shell, bubbles) provide the readable backing. */
		background: transparent;
	}

	.chat-content {
		position: relative;
		display: flex;
		justify-content: center;
		flex: 1;
		min-height: 0;
		padding: 0 1rem;
	}

	.chat-center-shell {
		position: relative;
		/* Own stacking context so the ::before backing can sit at z-index -1 without
		   slipping behind the workspace layers. */
		isolation: isolate;
		width: 100%;
		max-width: var(--chat-col-max);
		min-width: 0;
		min-height: 0;
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
	}

	/* The column's tint lives on a pseudo-element whose vertical edges feather out
	   instead of ending in a hard 1px border, so the chat melts into whatever the
	   workspace shows behind it. The ramp is eased (smoothstep-ish stops), since a
	   plain two-stop gradient reads as visible band edges where the ramp starts and
	   stops.
	   **The element is grown by the feather on each side so the ramp lives in the
	   MARGIN, not on the content.** The mask goes solid at exactly --chat-feather-*
	   from the element's edge, so an element sized to the column would spend that
	   distance fading across the column's own left and right extremities, which is
	   where the portrait rail and the composer's shoulders sit, leaving them backed
	   by nothing. Grow it and the solid region lands exactly on the content while
	   the melt happens over empty workspace. A side with a dock glued to it has no
	   empty workspace left, so Workspace zeroes that side's feather and this box
	   stops dead at the panel's border. See there for why tucking the ramp under
	   a translucent panel instead does not work.
	   Keep this gradient identical to the welcome copy in Workspace.svelte. */
	.chat-center-shell::before {
		content: '';
		position: absolute;
		inset: 0;
		left: calc(-1 * var(--chat-feather-left));
		right: calc(-1 * var(--chat-feather-right));
		z-index: -1;
		pointer-events: none;
		/* The palette's own surface tone, opaque, faded by the Column shade strength.
		   The opacity carries BOTH layers on purpose: the grain below exists only to
		   dither this tint's alpha ramp, so it has to vanish with it (theme store). */
		background: var(--theme-column-shade, #1c1718);
		/* Grain over the tint so the low-delta alpha ramp doesn't band (app.css). */
		background-image: var(--chat-col-noise);
		opacity: var(--theme-column-shade-opacity, 0);
		-webkit-mask-image: linear-gradient(
			to right,
			transparent,
			rgb(0 0 0 / 0.16) calc(var(--chat-feather-left) * 0.25),
			rgb(0 0 0 / 0.5) calc(var(--chat-feather-left) * 0.5),
			rgb(0 0 0 / 0.84) calc(var(--chat-feather-left) * 0.75),
			#000 var(--chat-feather-left),
			#000 calc(100% - var(--chat-feather-right)),
			rgb(0 0 0 / 0.84) calc(100% - var(--chat-feather-right) * 0.75),
			rgb(0 0 0 / 0.5) calc(100% - var(--chat-feather-right) * 0.5),
			rgb(0 0 0 / 0.16) calc(100% - var(--chat-feather-right) * 0.25),
			transparent
		);
		mask-image: linear-gradient(
			to right,
			transparent,
			rgb(0 0 0 / 0.16) calc(var(--chat-feather-left) * 0.25),
			rgb(0 0 0 / 0.5) calc(var(--chat-feather-left) * 0.5),
			rgb(0 0 0 / 0.84) calc(var(--chat-feather-left) * 0.75),
			#000 var(--chat-feather-left),
			#000 calc(100% - var(--chat-feather-right)),
			rgb(0 0 0 / 0.84) calc(100% - var(--chat-feather-right) * 0.75),
			rgb(0 0 0 / 0.5) calc(100% - var(--chat-feather-right) * 0.5),
			rgb(0 0 0 / 0.16) calc(100% - var(--chat-feather-right) * 0.25),
			transparent
		);
	}

	.chat-message-pane {
		grid-row: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
	}

	.chat-input-pane {
		grid-row: 2;
		min-width: 0;
	}

	@media (max-width: 1500px) {
		.chat-content {
			padding: 0;
		}
	}

	.chat-empty-wrap {
		flex: 1;
		display: grid;
		place-items: center;
		padding: 1rem;
	}

</style>
