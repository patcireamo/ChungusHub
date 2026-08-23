<script lang="ts">
	import type { Message } from '$lib/types/chat';
	import MessageComponent from './Message.svelte';
	import StreamingIndicator from './StreamingIndicator.svelte';
	import OpeningScenePopover from './OpeningScenePopover.svelte';
	import ChatSearchBar from './ChatSearchBar.svelte';
	import { chatSearch } from '$lib/stores/chatSearch.svelte';
	import { chatCursor } from '$lib/stores/chatCursor.svelte';
	import { messageStore } from '$lib/stores/messages.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { chatSelection, MAX_SELECTION_CHARS } from '$lib/stores/chatSelection.svelte';
	import { findSiblings } from '$lib/utils/message-tree';
	import { flashTarget } from '$lib/utils/flash-target';
	import { memoryStore } from '$lib/memory/store.svelte';
	import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
	import { generalSettingsStore } from '$lib/stores/general-settings.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Button from '$lib/components/ui/Button.svelte';

	interface Props {
		messages: Message[];
		allMessages: Message[];
		isStreaming?: boolean;
		streamingContent?: string;
		streamingThinking?: string;
		/** Set while a continue streams into an existing turn: that bubble renders the
		 *  live tail and the streaming-indicator bubble stays out of the list. */
		continuingMessageId?: string | null;
		/** Set while an opening scene streams: the path stays off screen and the streaming
		 *  bubble stands alone, since a new beginning is not a turn after the ones there. */
		openingSceneStream?: boolean;
		// Exposed so the parent can forward wheel from the empty margins beside the
		// centered column into this scroller (compiler-checked, so a rename can't
		// silently break the forwarding).
		scrollEl?: HTMLDivElement;
		/** Earlier turns landed ABOVE the viewport and `scrollTop` was corrected by this many
		 *  pixels to hold the reading position. Anything outside holding an absolute scroll
		 *  position (the margin wheel's target) has to take the same correction, or its next
		 *  step snaps the reader back to where the content used to start. */
		onContentShift?: (delta: number) => void;
	}

	let {
		messages,
		allMessages,
		isStreaming = false,
		streamingContent = '',
		streamingThinking = '',
		continuingMessageId = null,
		openingSceneStream = false,
		scrollEl = $bindable(),
		onContentShift
	}: Props = $props();

	// Chat-memory ghosting: archived messages render dimmed, with a single boundary
	// marker between the memory-folded prefix and the live tail. Archived ids form a
	// contiguous prefix of the active path, so the count doubles as the boundary index.
	// The ghost tag claims "recalled, not re-sent verbatim", which is only true when the
	// active preset injects {{memory}}, so the store already empties this set when the
	// macro is absent (memoryStore.active), the same condition prompt assembly uses to
	// filter history. Reading it here keeps one boundary with one owner.
	let archivedIds = $derived(memoryStore.archivedMessageIds);
	// Count only the leading run that's actually archived, which stays robust to a stale
	// set (e.g. mid-navigation), so the boundary never lands in the middle of live turns.
	let archivedPrefix = $derived.by(() => {
		let n = 0;
		for (const m of messages) {
			if (archivedIds.has(m.id)) n++;
			else break;
		}
		return n;
	});

	let openingPopoverOpen = $state(false);

	// The store toasts its own generation failures; what reaches here is the guards it throws
	// on before the try (engine off, no chat), which the trigger already prevents. Catching
	// keeps one of those from surfacing as an unhandled rejection instead of a message.
	async function handleGenerateOpeningScene(direction: string) {
		try {
			await messageStore.generateOpeningScene(direction);
		} catch (error) {
			toastStore.failed('generate the opening scene', error);
		}
	}

	// $state, not a plain let: the scroller is handed down to ChatSearchBar as a prop, so
	// the binding landing has to be a reactive change, not a silent one-way write.
	let listElement = $state<HTMLDivElement | undefined>(undefined);
	// Hand the scroller to the parent so it can forward margin wheel into it.
	$effect(() => {
		scrollEl = listElement;
	});
	let prevLastMessageId: string | null = null;
	let prevChatId: string | null = null;
	let prevIsStreaming = false;

	// A reply landing in its own bubble is a turn the stored rows don't have yet, so while
	// it streams every one of them sits one turn further back than its index says. Depth is
	// what a depth-bounded regex rule measures against (architecture/prompt-pipeline.md), and
	// without this the newest reply would flip between turn 0 and turn 1 as a stream starts
	// and settles. A continue writes into a row that already exists, so it adds no turn.
	let streamingTurnOffset = $derived(isStreaming && !continuingMessageId ? 1 : 0);

	// Auto-pinning follows the stream only while the user is near the bottom;
	// scrolling up to read hands them the reins until they come back (or jump).
	const NEAR_BOTTOM_PX = 120;
	let nearBottom = $state(true);
	let hasUnseen = $state(false);
	let showJumpToLatest = $derived(!nearBottom && (isStreaming || hasUnseen));
	let lastScrollTop = 0;
	// Set right before a programmatic snap so the resulting scroll event isn't mistaken for
	// the user scrolling. Otherwise our own auto-follow reads as intent and releases the pin.
	let programmaticScroll = false;

	/** `smooth` is for a deliberate travel (the jump-to-latest pill). The auto-follow uses
	 *  `instant`, the only value that overrides this scroller's CSS `scroll-behavior: smooth`
	 *  (`auto` defers to that CSS, and so does a plain `scrollTop` write): an animated snap
	 *  fires a whole run of scroll events and the guard below only covers the first, so the
	 *  rest would be read as the user scrolling mid-glide. */
	function snapToBottom(behavior: ScrollBehavior = 'instant') {
		if (!listElement) return;
		// Clamped: a transcript shorter than the viewport has a negative overflow, and a write
		// the browser clamps back to 0 is exactly the no-op the guard must not be armed for.
		const top = Math.max(0, listElement.scrollHeight - listElement.clientHeight);
		// Already there, and a write that moves nothing fires no scroll event, so arming the
		// guard for it leaves it armed. It then swallows the user's first real scroll-up, the
		// pin stays set, and the next token drags them back down.
		if (Math.abs(listElement.scrollTop - top) < 1) return;
		programmaticScroll = true;
		listElement.scrollTo({ top, behavior });
		// Read back rather than assuming `top`: a smooth scroll has not moved yet, and the
		// glide's own events must read as downward, not as a jump backwards.
		lastScrollTop = listElement.scrollTop;
	}

	function updateNearBottom() {
		if (!listElement) return;
		const st = listElement.scrollTop;
		// Reading back through the top edge pulls the next stretch in before the reader hits
		// the wall, so the story keeps flowing under a fast scroll. In button mode the
		// identical load waits for the press instead.
		if (!manualLoad && st < LOAD_EARLIER_PX) loadEarlier();
		const dist = listElement.scrollHeight - st - listElement.clientHeight;
		if (programmaticScroll) {
			programmaticScroll = false;
		} else if (st < lastScrollTop - 1) {
			// Any deliberate upward scroll hands control to the user at once, even inside the
			// pin band: a fast stream must never yank them back down mid-read.
			nearBottom = false;
		} else {
			nearBottom = dist <= NEAR_BOTTOM_PX;
		}
		if (nearBottom) hasUnseen = false;
		lastScrollTop = st;
	}

	function jumpToLatest() {
		snapToBottom('smooth');
		nearBottom = true;
		hasUnseen = false;
	}

	// ===== Transcript window =====
	// A long branch is not mounted all at once. Every turn on screen costs a markdown parse,
	// a card of DOM and a row this scroller re-measures on every streaming token, so a
	// nine-hundred-turn story is slow to open and then drags every reply that follows it.
	// The reader gets the newest `pageSize` turns and reaches further back deliberately.
	// NOTHING else is windowed: the tree, the prompt, the story map, the chats panel and find
	// in chat all still see the whole path (architecture/chat-sessions.md coupling 14).
	const LOAD_EARLIER_PX = 240;

	let paging = $derived(generalSettingsStore.transcriptPaging);
	let pageSize = $derived(generalSettingsStore.transcriptPageSize);
	let manualLoad = $derived(generalSettingsStore.transcriptLoadMode === 'button');

	// The chat the RENDERED path belongs to, which is not always the active id: selecting a chat
	// sets that id and then AWAITS the load, so for one flush the store names the new chat while
	// `messages` is still the previous one's. The anchor keys off the state object instead,
	// where the id and the path are written together, or arriving anywhere could pin a window
	// onto a turn from the story just left.
	let pathChatId = $derived(chatStore.currentChatState?.chat.id ?? null);

	// The top edge is held by the TURN the window starts at, never by a count back from the
	// newest one. A counted window slides forward with the story: every reply that lands pushes
	// a turn off the top, and removing content ABOVE the viewport shifts everything a reader
	// who scrolled back to re-read something is looking at. Pinned, the loaded stretch only
	// ever grows, and it grows at the end the reader is already watching.
	let topAnchor = $state<{ chatId: string | null; messageId: string; index: number } | null>(null);
	let anchorIndex = $derived.by(() => {
		const anchor = topAnchor;
		if (!anchor || anchor.chatId !== pathChatId) return -1;
		const at = messages.findIndex((m) => m.id === anchor.messageId);
		if (at >= 0) return at;
		// The anchor turn itself can be deleted, or a branch switch can replace the stretch it
		// was in. Its last index still states how far back the reader had reached, so the window
		// holds roughly there instead of collapsing to the newest page and yanking them forward.
		return Math.min(anchor.index, messages.length);
	});
	/** Where the window sits with nothing loaded: the newest `pageSize` turns. */
	let baseStart = $derived(paging ? Math.max(0, messages.length - pageSize) : 0);
	/** Turns of the path held back, i.e. the window's offset into it. Every index handed to a
	 *  message is measured against the WHOLE path and never against this slice: the ordinal
	 *  badge, the depth a regex rule is scoped by and the memory boundary all count from the
	 *  start of the branch, and a window that shifted them would renumber the story. */
	let windowStart = $derived(anchorIndex >= 0 ? Math.min(anchorIndex, baseStart) : baseStart);
	let shown = $derived(windowStart > 0 ? messages.slice(windowStart) : messages);
	let nextChunk = $derived(Math.min(pageSize, windowStart));
	// The count is the point of the marker: it is the only thing on screen saying how much
	// story sits above, in either mode.
	let earlierLabel = $derived(`${windowStart} earlier ${windowStart === 1 ? 'turn' : 'turns'}`);
	let loadLabel = $derived(
		nextChunk < windowStart ? `Load ${nextChunk} of ${earlierLabel}` : `Load ${earlierLabel}`
	);
	// A momentum scroll fires many events over one gesture; without this it would spend
	// several pages before the first correction has landed.
	let loadPending = false;

	/** Pull the window's top edge back to a path index. Never forward: within one chat the
	 *  window only ever grows, so nothing can pull turns out from under the reader. The
	 *  caller places the view itself, which is why this one holds no scroll position. */
	function showFrom(index: number): void {
		if (index < 0 || index >= windowStart) return;
		topAnchor = { chatId: pathChatId, messageId: messages[index].id, index };
	}

	/** Pin the top edge where the chat opened, and re-pin when the setting turns the window on
	 *  mid-story. This is the ONLY writer that may move the edge forward, which is why it runs
	 *  once per arrival: within a chat, `showFrom` alone moves it, and only earlier. */
	let pinnedChatId: string | null = null;
	$effect(() => {
		const chatId = pathChatId;
		const arrived = chatId !== pinnedChatId;
		pinnedChatId = chatId;
		if (!paging || messages.length === 0) {
			// Dropped rather than left inert: returning to a chat re-opens it at its newest
			// turns, and a stale anchor would quietly revive the stretch loaded last time.
			if (arrived) topAnchor = null;
			return;
		}
		if (!arrived && anchorIndex >= 0) return;
		topAnchor = { chatId, messageId: messages[baseStart].id, index: baseStart };
	});

	/** The reader's own door into earlier turns: the button, or scrolling to the top edge.
	 *  It holds the reading position, because the turns arrive ABOVE the viewport and the
	 *  story would otherwise drop away from under them by everything just loaded. */
	function loadEarlier(): void {
		if (loadPending || windowStart <= 0) return;
		const el = listElement;
		const held = shown.length ? el?.querySelector<HTMLElement>(`#msg-${CSS.escape(shown[0].id)}`) : null;
		if (!el || !held) return;
		// Measured against a TURN rather than against the scroller's total height. Two reasons,
		// and both are silent when got wrong: a reply landing below while this is in flight
		// grows that height too (the correction would push the reader down by a message they
		// were not even looking at), and a measured correction is idempotent with the browser's
		// own scroll anchoring, which does this same job on the engines that have it. Whatever
		// it already fixed simply is not in this number, so the two can never double up.
		const heldTop = held.getBoundingClientRect().top;
		const scrollBefore = el.scrollTop;
		loadPending = true;
		showFrom(Math.max(0, windowStart - pageSize));
		requestAnimationFrame(() => {
			loadPending = false;
			// The turn we measured against went away in the meantime (a delete landing, a sync).
			// A detached node measures as zero, which would "correct" the view by a whole screen.
			if (!held.isConnected) return;
			const shift = held.getBoundingClientRect().top - heldTop;
			// `instant`, the one value that overrides this scroller's CSS `scroll-behavior:
			// smooth`. `auto` defers to that CSS and so does a plain `scrollTop +=`, so either
			// ANIMATES the correction and the reader watches the whole stretch that just loaded
			// fly past. The button mode is where that bites: the reader is parked at the top
			// edge, so no gesture of theirs cuts the glide short.
			if (shift) el.scrollTo({ top: el.scrollTop + shift, behavior: 'instant' });
			// The whole travel, ours plus anything the browser's anchoring did: an absolute
			// scroll position held outside is stale by all of it, not just by our half.
			const travelled = el.scrollTop - scrollBefore;
			if (travelled) onContentShift?.(travelled);
		});
	}

	// A window too short to fill the viewport gives the auto mode no scroll to ride, and the
	// turns above it would be unreachable (a small page size on short turns). Grow it until
	// there is something to scroll: the overflow is the condition, so this settles itself.
	// The load is direct rather than through loadEarlier, which holds a reading position that
	// a scroller with no scroll does not have.
	$effect(() => {
		void messages;
		void windowStart;
		if (manualLoad || windowStart <= 0 || !listElement) return;
		// A zero-height scroller (mid-mount, or a host with no layout yet) says nothing, and
		// reading that as "does not fill" would load the whole chat with nobody looking.
		if (!listElement.clientHeight || listElement.scrollHeight > listElement.clientHeight) return;
		showFrom(Math.max(0, windowStart - pageSize));
		// The turns arrive above, so the moment they finally overflow, the reader is left at the
		// TOP of a story that is supposed to open at its end: nothing else re-snaps for them,
		// since no message landed. Idempotent, so the loads before that one cost nothing.
		if (nearBottom) requestAnimationFrame(() => snapToBottom());
	});

	$effect(() => {
		// The path's own chat, not the store's active id: that id names the chat being opened
		// a flush before its path arrives, so keyed to it this reads the swap as a chat change
		// against the PREVIOUS story's rows, and then reads the new story's rows as a branch
		// switch, which is the one case that deliberately does not scroll. Opening a chat would
		// land wherever the last one's scroll offset happened to survive the swap.
		const chatId = pathChatId;
		const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
		const isNewMessage = lastMessageId !== prevLastMessageId;
		// An appended turn EXTENDS the previous path, so the old leaf is still on it. A
		// swipe / branch jump / delete replaces the tail instead, so the old leaf is gone.
		// Only extensions may auto-scroll: snapping on a branch switch teleports the user
		// to the new branch's bottom and loses the fork they were working at.
		const isExtension = prevLastMessageId == null || messages.some((m) => m.id === prevLastMessageId);
		// Track the stream so pinning follows tokens, not just message inserts.
		void streamingContent;
		void streamingThinking;
		// The settled turn replaces the streaming bubble in place, so nobody needs moving for
		// it: a pinned reader is already at the bottom, and one who scrolled up to read must
		// not be thrown to the end by the last frame of a reply they already left behind.
		const streamSettled = chatId === prevChatId && prevIsStreaming && !isStreaming;

		if (listElement) {
			if (chatId !== prevChatId) {
				snapToBottom();
				nearBottom = true;
				hasUnseen = false;
			} else if (isNewMessage && !isExtension) {
				// Branch switch. The pin as it stood BEFORE the swap is part of the reading
				// position, and this effect still sees it: it runs before any scroll event the
				// swap itself fires. A reader at the bottom is reading the newest turn, which is
				// exactly the turn a swipe replaces, and the control they pressed sits at that
				// turn's bottom. Holding their offset instead measures a longer alternative as
				// far from the bottom and strands them mid-message with the controls below it.
				if (nearBottom) {
					snapToBottom();
				} else {
					// Scrolled up: keep the reading position, and re-baseline the pin from real
					// geometry, because the content under the viewport just changed wholesale, so
					// the stale nearBottom from the previous branch must not let the next stream
					// token yank the view down.
					const dist = listElement.scrollHeight - listElement.scrollTop - listElement.clientHeight;
					nearBottom = dist <= NEAR_BOTTOM_PX;
				}
				// Written on both paths: the swap can shrink the content and let the browser clamp
				// `scrollTop` by itself, and a clamp measured against a stale value reads as the
				// user scrolling up, which drops the pin a frame later.
				lastScrollTop = listElement.scrollTop;
				hasUnseen = false;
			} else if ((isNewMessage || isStreaming) && nearBottom && !streamSettled) {
				snapToBottom();
			} else if (isNewMessage) {
				hasUnseen = true;
			}
		}

		prevChatId = chatId;
		prevLastMessageId = lastMessageId;
		prevIsStreaming = isStreaming;
	});

	function handleNavigateBranch(messageId: string) {
		messageStore.navigateToBranch(messageId);
	}

	// ===== Arrival from another surface =====
	// The story map navigates to a BRANCH and names the turn that was picked; the transcript
	// is the only place that can show it. `flashTarget` is the app's one "look here" gesture,
	// the same scroll and accent glow the assistant points with, so arriving from either
	// surface reads identically and there is one recipe to change.
	let revealTargetId = $derived(messageStore.revealTargetId);

	$effect(() => {
		const id = revealTargetId;
		if (!id) return;
		// Read the path so this re-runs when the new branch lands, in case the target was
		// named before its row was on screen, and the window so it re-runs once the turn
		// below has been loaded back into it.
		void messages;
		void windowStart;
		// Behind the window is the one case where a missing row does not mean the target is
		// gone: load back through it and let this effect fire again on the row that now exists.
		const index = messages.findIndex((m) => m.id === id);
		if (index >= 0 && index < windowStart) {
			showFrom(index);
			return;
		}
		const row = document.getElementById(`msg-${id}`);
		// The card, not the row: a row is as wide as the scrollport, so its glow is clipped
		// left and right and painted over below by the turn that follows it.
		const card = row?.querySelector<HTMLElement>('[data-message-card]') ?? row;
		if (card) {
			flashTarget(card);
			messageStore.revealTargetId = null;
			return;
		}
		// Never rendered: the row was deleted between the click and the jump. Give up rather
		// than sit armed and fire later under an unrelated branch switch.
		const timer = setTimeout(() => (messageStore.revealTargetId = null), 1000);
		return () => clearTimeout(timer);
	});

	// ===== The message cursor =====
	// Where the keyboard is in the story (architecture/chat-sessions.md, "The message cursor").
	// The same reach as the arrival mark above and for the same reason, but it lands rather
	// than points: a turn behind the window is loaded back in, and only then does the keyboard
	// move to it.
	//
	// Marking and taking are separate on purpose. `takeNonce` is what says the keyboard should
	// MOVE; find in chat marks its live hit while the reader is still typing in that field, and
	// a mark that also took focus would empty the box on the first match.
	let takenNonce = 0;
	$effect(() => {
		const id = chatCursor.id;
		const nonce = chatCursor.takeNonce;
		// The path, so a cursor named before its branch rendered still lands, and the window,
		// so this re-runs once the turn below has been loaded back into it.
		void messages;
		void windowStart;
		if (!id) {
			takenNonce = nonce;
			return;
		}
		const index = messages.findIndex((m) => m.id === id);
		// Not on the visible path: a stale mark from a branch that moved under it. Nothing to
		// land on, and nothing to clean up either, since the ring reads off the same id.
		if (index < 0) return;
		if (index < windowStart) {
			showFrom(index);
			return;
		}
		if (nonce === takenNonce) return;
		takenNonce = nonce;
		const row = document.getElementById(`msg-${id}`);
		if (!row) return;
		// `instant`, the one value that overrides this scroller's CSS glide: a step between two
		// turns has to land, and stepping through a stretch of story would otherwise queue one
		// animation per press. Deliberately NOT armed with `programmaticScroll`, exactly like
		// the arrival mark: landing mid-history SHOULD release the bottom pin.
		row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
		row.focus({ preventScroll: true });
	});

	// ===== Selection → Chungus Assistant context =====
	// A highlight inside a message becomes the assistant's auto-attached "look here" pointer,
	// exactly like an IDE feeding the editor selection to the model. Lives only while the
	// highlight does.
	function messageIdOf(node: Node | null): string | null {
		const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
		const row = el?.closest?.('[id^="msg-"]') as HTMLElement | null;
		return row?.id?.startsWith('msg-') ? row.id.slice(4) : null;
	}

	function captureSelection() {
		const sel = window.getSelection();
		const chatId = chatStore.activeChatId;
		if (!sel || !chatId || !listElement) return;
		const anchorInList = sel.anchorNode ? listElement.contains(sel.anchorNode) : false;
		// A collapsed selection clears the context only when it collapses INSIDE the chat
		// (a plain click in a message). Collapsing elsewhere, e.g. clicking into the assistant
		// input to type the request, must leave the highlight context intact, IDE-style.
		if (sel.rangeCount === 0 || sel.isCollapsed) {
			if (anchorInList) chatSelection.clear();
			return;
		}
		const range = sel.getRangeAt(0);
		// A non-empty selection elsewhere (e.g. inside the assistant panel) doesn't touch the
		// chat context; only highlights inside this chat's message list count.
		if (!listElement.contains(range.commonAncestorContainer)) return;
		const raw = sel.toString().replace(/ /g, ' ').trim();
		const anchorMessageId = messageIdOf(range.startContainer) ?? messageIdOf(range.endContainer);
		if (!raw || !anchorMessageId) {
			if (anchorInList) chatSelection.clear();
			return;
		}
		// How many bubbles the highlight touches: a "spans N messages" signal for the assistant.
		let spanCount = 0;
		for (const row of listElement.querySelectorAll('[id^="msg-"]')) {
			if (range.intersectsNode(row)) spanCount++;
		}
		// Word + line counts drive the chip label, since a text preview is useless once the chip
		// clips it. Lines are real content lines (hard breaks / paragraphs), NOT soft visual
		// wraps, so the count doesn't change when the panel gets narrower.
		const wordCount = (raw.match(/\S+/g) ?? []).length;
		const lineCount = raw.split('\n').map((l) => l.trim()).filter(Boolean).length || 1;
		const truncated = raw.length > MAX_SELECTION_CHARS;
		chatSelection.set({
			chatId,
			anchorMessageId,
			text: truncated ? raw.slice(0, MAX_SELECTION_CHARS) : raw,
			truncated,
			spanCount: Math.max(1, spanCount),
			wordCount,
			lineCount
		});
	}

	$effect(() => {
		let raf = 0;
		const onChange = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(captureSelection);
		};
		document.addEventListener('selectionchange', onChange);
		return () => {
			cancelAnimationFrame(raf);
			document.removeEventListener('selectionchange', onChange);
			chatSelection.clear();
		};
	});
</script>

<div class="message-list-wrap">
<div
	bind:this={listElement}
	class="message-list panel-scroll"
	role="log"
	aria-label="Chat messages"
	aria-live="polite"
	onscroll={updateNearBottom}
>
	{#if openingSceneStream}
		<!-- The scene arriving is a new beginning, so it is the only thing on screen while it
		     writes: leaving the path up would read as a reply to the turns above it. This is
		     also what gives an opening a visible stream and a reachable Stop at last. -->
		<div class="message-list-content">
			<StreamingIndicator content={streamingContent} thinking={streamingThinking} />
		</div>
	{:else if messages.length === 0}
		<div class="message-empty-wrap">
			<div class="message-empty-card card-elevated">
				<div class="message-empty-icon">
					<Icon name="bookOpen" class="w-8 h-8 text-accent" strokeWidth={1.5} />
				</div>
				<h3 class="message-empty-title">Begin your story</h3>
				<p class="message-empty-copy">
					{#if featurePromptsStore.openingSceneEnabled}
						Write your first action or let the AI set the scene
					{:else}
						Write your first action to begin
					{/if}
				</p>
				{#if featurePromptsStore.openingSceneEnabled}
					<div class="message-empty-action">
						<!-- Asks the app, not this chat: starting a scene while a reply generates
						     elsewhere would run two generations over one abort controller. -->
						<Button
							variant="secondary"
							onclick={() => (openingPopoverOpen = true)}
							disabled={messageStore.isStreaming}
						>
							<Icon name="bookOpen" class="w-4 h-4" />
							Generate an opening scene
						</Button>
						<OpeningScenePopover
							open={openingPopoverOpen}
							align="center"
							onClose={() => (openingPopoverOpen = false)}
							onGenerate={handleGenerateOpeningScene}
						/>
					</div>
				{/if}
			</div>
		</div>
	{:else}
		<div class="message-list-content">
			{#if windowStart > 0}
				<div class="window-edge">
					<span class="window-edge-line"></span>
					{#if manualLoad}
						<button type="button" class="window-edge-btn" onclick={loadEarlier}>
							<Icon name="chevronUp" class="w-3 h-3" />
							{loadLabel}
						</button>
					{:else}
						<span class="window-edge-label">
							<Icon name="chevronUp" class="w-3 h-3" />
							{earlierLabel}
						</span>
					{/if}
					<span class="window-edge-line"></span>
				</div>
			{/if}
			{#each shown as message, offset (message.id)}
				{@const index = windowStart + offset}
				{@const siblings = findSiblings(allMessages, message.id)}
				{@const siblingIndex = siblings.findIndex(m => m.id === message.id)}
				{#if archivedPrefix > 0 && archivedPrefix < messages.length && index === archivedPrefix}
						<div class="memory-boundary" aria-hidden="true">
							<span class="memory-boundary-line"></span>
							<span class="memory-boundary-label">
								<Icon name="brain" class="w-3 h-3" />
								Earlier turns are in memory
							</span>
							<span class="memory-boundary-line"></span>
						</div>
					{/if}
					<MessageComponent
						{message}
						ordinal={index + 1}
						depth={messages.length - 1 - index + streamingTurnOffset}
						siblingCount={siblings.length}
						{siblingIndex}
						isLast={index === messages.length - 1 && !isStreaming}
						{allMessages}
						archived={index < archivedPrefix}
						onNavigateBranch={handleNavigateBranch}
						streamTail={continuingMessageId === message.id ? streamingContent : null}
						streamTailThinking={continuingMessageId === message.id ? streamingThinking : null}
					/>
			{/each}
			{#if isStreaming && !continuingMessageId}
				<StreamingIndicator content={streamingContent} thinking={streamingThinking} />
			{/if}
		</div>
	{/if}
</div>

{#if chatSearch.open}
	<ChatSearchBar
		container={listElement}
		{messages}
		{allMessages}
		{windowStart}
		loadThrough={showFrom}
	/>
{/if}

{#if showJumpToLatest}
	<button
		type="button"
		class="jump-to-latest surface-float shadow-md"
		onclick={jumpToLatest}
		aria-label="Jump to latest message"
	>
		<Icon name="chevronDown" class="w-3.5 h-3.5" />
		{#if hasUnseen}<span>New</span>{/if}
	</button>
{/if}
</div>

<style>
	.message-list-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		/* Without min-width:0 a flex child adopts the min-content width of its widest
		   descendant: an expanded thinking block (long tokens/code) then blows the whole
		   column past the viewport and stretches every row. This lets it shrink so the wide
		   content scrolls inside its own panel instead. */
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	/* No padding on the scroll container itself: a scroller's own padding insets
	   the position: sticky constraint rect, which would pin the Portraits-style
	   sticky portrait short of the top edge. The spacing lives on
	   .message-list-content instead. */
	.message-list {
		flex: 1;
		min-height: 0;
		scroll-behavior: smooth;
		overscroll-behavior-y: contain;
	}

	.jump-to-latest {
		position: absolute;
		bottom: 0.85rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 10;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.38rem 0.8rem;
		border-radius: var(--radius-full);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-primary);
		cursor: pointer;
	}

	/* The transcript's content column: capped and centered inside the chat column,
	   which above the dock breakpoint is a share of the screen rather than a fixed
	   width (--chat-col-max, app.css). The cap lives here and not on the column
	   itself, because the docks key their glue math off the column's width (a
	   column capped to its content hands every surplus pixel to them) and because
	   Portraits and Manuscript rows fill their row, so without this box they would
	   stretch to whatever the share resolves to on a wide screen. */
	.message-list-content {
		max-width: var(--chat-content-max);
		margin-inline: auto;
		padding-top: calc(clamp(0.45rem, 0.28rem + 0.34vw, 0.82rem) + 0.28rem);
		padding-bottom: calc(clamp(1rem, 0.72rem + 0.92vw, 1.68rem) + clamp(0.45rem, 0.28rem + 0.34vw, 0.82rem));
	}

	/* The top edge of the transcript window, in the same rule-and-label shape as the memory
	   boundary below: what sits above it is unloaded, not lost, and the marker is the only
	   thing on screen that says so. */
	.window-edge {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0.2rem auto 0.9rem;
		padding: 0 clamp(0.6rem, 0.4rem + 1vw, 1.4rem);
		max-width: calc(var(--reading-measure) * var(--user-chat-width, 1));
	}

	.window-edge-line {
		flex: 1;
		height: 1px;
		background: linear-gradient(
			to right,
			transparent,
			var(--color-border-subtle),
			transparent
		);
	}

	.window-edge-label,
	.window-edge-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--color-text-muted);
	}

	.window-edge-btn {
		padding: 0.22rem 0.65rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-full);
		background: transparent;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
	}

	.window-edge-btn:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	/* The line between the memory-folded prefix and the live tail. */
	.memory-boundary {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0.5rem auto 0.9rem;
		padding: 0 clamp(0.6rem, 0.4rem + 1vw, 1.4rem);
		max-width: calc(var(--reading-measure) * var(--user-chat-width, 1));
	}

	.memory-boundary-line {
		flex: 1;
		height: 1px;
		background: linear-gradient(
			to right,
			transparent,
			color-mix(in srgb, var(--color-accent) 30%, transparent),
			transparent
		);
	}

	.memory-boundary-label {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: color-mix(in srgb, var(--color-accent) 80%, var(--color-text-muted));
	}

	.message-empty-wrap {
		min-height: 100%;
		display: grid;
		place-items: center;
		padding: 1rem;
	}

	.message-empty-card {
		width: min(100%, 32rem);
		padding: clamp(1.1rem, 0.95rem + 1vw, 1.65rem);
		text-align: center;
	}

	.message-empty-icon {
		width: 3.7rem;
		height: 3.7rem;
		margin: 0 auto 0.75rem;
		border-radius: 1rem;
		display: grid;
		place-items: center;
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-accent) 24%, transparent);
	}

	.message-empty-title {
		margin: 0;
		font-family: var(--font-ui);
		font-size: clamp(1rem, 0.92rem + 0.4vw, 1.2rem);
		font-weight: 700;
		color: var(--color-text-primary);
	}

	.message-empty-copy {
		margin: 0.42rem auto 0.9rem;
		max-width: 25rem;
		font-family: var(--font-ui);
		font-size: 0.84rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	/* The popover positions against this, not against the centered card: anchored to the
	   card it would hang from the card's full width instead of from the button. */
	.message-empty-action {
		position: relative;
		display: inline-block;
	}
</style>
