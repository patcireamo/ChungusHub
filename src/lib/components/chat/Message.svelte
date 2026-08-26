<script lang="ts">
	import type { Message, EditAction, DeleteAction, RegenerateAction } from '$lib/types/chat';
	import MessageActions from './MessageActions.svelte';
	import MessageEditor from './MessageEditor.svelte';
	import BranchNavigator from './BranchNavigator.svelte';
	import OpeningScenePopover from './OpeningScenePopover.svelte';
	import MessageReasoning from './MessageReasoning.svelte';
	import MessageAvatar from './MessageAvatar.svelte';
	import MessageMeta from './MessageMeta.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import HoldToConfirmButton, { holdMsForBlast } from '$lib/components/ui/HoldToConfirmButton.svelte';
	import { deleteGuard } from '$lib/stores/delete-guard.svelte';
	import { messageStore } from '$lib/stores/messages.svelte';
	import { chatCursor } from '$lib/stores/chatCursor.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { renderedHtml } from '$lib/actions/renderedHtml';
	import { copyText } from '$lib/utils/clipboard';
	import { previewContinuation } from '$lib/utils/continuation';
	import { expandSelfRefs } from '$lib/macros';
	import { personaStore } from '$lib/stores/persona.svelte';
	import { regexRulesStore } from '$lib/stores/regex-rules.svelte';
	import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
	import { memoryStore } from '$lib/memory/store.svelte';
	import { describeMemoryImpact } from '$lib/memory/impact-copy';
	import { canSpliceMessage, collectSubtree, subtreeBlastRadius } from '$lib/utils/message-tree';
	import { countTokens } from '$lib/tokenizer';
	import { imageService } from '$lib/services/imageService';
	import ImageLightbox from '$lib/components/ui/ImageLightbox.svelte';
	import Dialog from '$lib/components/ui/Dialog.svelte';
	import LorebookTraceList from '$lib/components/lorebook/LorebookTraceList.svelte';

	/** Position in `imageAttachments` open in the full-size viewer; null = closed. */
	let viewerIndex = $state<number | null>(null);

	/** The lorebook reading for this turn, open or not. */
	let loreOpen = $state(false);

	interface Props {
		message: Message;
		/** 1-based position in the visible transcript: purely positional, renumbers on delete. */
		ordinal: number;
		/** Turns back from the newest one on screen, 0 = newest. What a depth-bounded regex
		 *  rule is measured against; MessageList counts it, including the turn a live stream
		 *  is about to become. */
		depth: number;
		siblingCount: number;
		siblingIndex: number;
		isLast: boolean;
		allMessages: Message[];
		onNavigateBranch: (messageId: string) => void;
		/** This message has been folded into chat memory (a "ghost": recalled, not sent verbatim). */
		archived?: boolean;
		/** Live continuation streaming into this turn (continue flow): the partial tail
		 *  renders as part of the bubble; the stored row is only written when it completes. */
		streamTail?: string | null;
		streamTailThinking?: string | null;
	}

	let {
		message,
		ordinal,
		depth,
		siblingCount,
		siblingIndex,
		isLast,
		allMessages,
		onNavigateBranch,
		archived = false,
		streamTail = null,
		streamTailThinking = null
	}: Props = $props();

	/** The set the viewer pages: this turn's own pictures, and nothing wider. A chat is a
	 *  tree, so "every image in this chat" would have to pick a branch to mean anything. */
	let imageAttachments = $derived((message.attachments ?? []).filter((a) => a.kind === 'image').map((a) => a.path));

	// One editor, two intents, chosen by which button opened it: Edit rewrites this turn,
	// Branch writes the text as a new sibling and leaves this one alone. Nothing is created
	// until Save, so cancelling a branch costs nothing. Cloning the row up front instead
	// leaves a verbatim duplicate sibling behind every time you back out.
	let isEditing = $state(false);
	let editorMode = $state<EditAction>('save_only');
	let showActions = $state(false);
	let showDeleteMenu = $state(false);
	let showRegenerateMenu = $state(false);
	/** The delete the user has been asked to confirm, or null while the menu offers choices. */
	let confirmingDelete = $state<DeleteAction | null>(null);
	/** Text waiting on the memory confirmation, set only when this turn is already summarised,
	 *  so an ordinary edit still saves on the first press. */
	let pendingEdit = $state<string | null>(null);
	// "Replace reply" on a user turn deletes everything below it, a hard rewind. Gate it behind
	// a confirm that shows how many messages will go.
	let confirmingReplace = $state(false);
	let deleteMenuElement = $state<HTMLDivElement | undefined>(undefined);
	let regenerateMenuElement = $state<HTMLDivElement | undefined>(undefined);

	// Blast radius of the destructive actions on this message, since the confirmations always
	// state the real numbers. (Lazy deriveds: only computed while a menu/editor shows them.)
	const deleteBlast = $derived(subtreeBlastRadius(allMessages, message.id));
	const belowBlast = $derived(subtreeBlastRadius(allMessages, message.id, { includeSelf: false }));
	// With nothing below it, "this only" and "with all responses" delete the exact same single
	// row. Offering both is a lie about a choice that doesn't exist, so the menu collapses to
	// one delete. It always takes the this_only path: allMessages is a snapshot, and if a reply
	// landed since it was taken, a splice costs one row where a subtree delete costs the branch.
	const hasBelow = $derived(belowBlast.messages > 0);
	// A branch head can't be spliced out from under its replies: see canSpliceMessage. When it
	// holds anything below, the whole-subtree delete is the only offer the menu can honour.
	const canSplice = $derived(canSpliceMessage(allMessages, message.id));

	// What each destructive action costs chat memory, in the same lazy spirit as the blast
	// radii above: nothing computes until a handler or a confirmation panel reads it, and
	// every one of them reads zero when memory is off (architecture/memory.md).
	//
	// A rewrite keeps its turns and a delete removes them, which is the whole difference:
	// the same summaries die either way, but only a rewrite has to re-read all of them.
	const editImpact = $derived(memoryStore.impactOf([message.id], { removed: false }));
	const spliceImpact = $derived(memoryStore.impactOf([message.id], { removed: true }));
	const subtreeImpact = $derived(
		memoryStore.impactOf(collectSubtree(allMessages, message.id).map((m) => m.id), { removed: true })
	);
	// The hold scales with what the action actually sets in motion, not just its row count:
	// deleting one folded turn is a heavier act than deleting one loose reply, because the
	// summary over it dies and everything behind it waits on a re-read.
	const editBlast = $derived(editImpact.reread + editImpact.paused);
	const confirmImpact = $derived(confirmingDelete === 'this_only' ? spliceImpact : subtreeImpact);
	const confirmCount = $derived(confirmingDelete === 'this_only' ? 1 : deleteBlast.messages);
	const confirmLines = $derived(
		describeMemoryImpact(confirmImpact, { mode: 'delete', auto: memoryStore.autoExtract })
	);
	const editLines = $derived(describeMemoryImpact(editImpact, { mode: 'edit', auto: memoryStore.autoExtract }));

	// {{char}}/{{user}} resolve live at display against the active persona + bound character.
	// Greetings store their macros raw, so changing persona reflows them on screen without
	// touching the row (matches the generation path in prompt-assembly.toInjectedMessage).
	const selfRefChar = $derived(
		characterLibraryStore.entries.find((e) => e.id === chatStore.activeChat?.characterId)?.identity
			.name || 'Character'
	);
	const selfRefUser = $derived(personaStore.activeResolved?.name || 'You');

	$effect(() => {
		if (showDeleteMenu && deleteMenuElement) {
			deleteMenuElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}
	});

	$effect(() => {
		if (showRegenerateMenu && regenerateMenuElement) {
			regenerateMenuElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}
	});

	async function handleEdit(newContent: string, action: EditAction) {
		// Ask before closing: a busy store rejects the edit, and closing first would
		// throw away the draft the user just wrote.
		if (messageStore.warnIfBusy()) return;
		// Branching writes a NEW sibling and leaves this turn untouched, so its summary
		// stands: only a rewrite in place outdates one, and only that asks.
		if (action === 'save_only' && (editImpact.dropped > 0 || editImpact.droppedStored > 0)) {
			pendingEdit = newContent;
			return;
		}
		isEditing = false;
		await messageStore.editMessage(message.id, newContent, action);
	}

	/**
	 * Commit the draft the confirmation is holding.
	 *
	 * `minor` is the user answering the question the app cannot: a typo and a retcon are the
	 * same two strings to us, so nothing here inspects the text. It saves without advancing
	 * the turn's edit stamp, which is what leaves the summary covering it alone.
	 */
	async function commitPendingEdit(minor: boolean) {
		const content = pendingEdit;
		if (content === null) return;
		// Re-asked here, not only in handleEdit: a generation can start during the press-and-hold,
		// and closing the editor before a rejected write would drop the draft on the floor.
		if (messageStore.warnIfBusy()) return;
		pendingEdit = null;
		isEditing = false;
		await messageStore.editMessage(message.id, content, 'save_only', { minor });
	}

	/** Leave the editor from any door. The pending draft must die with it, or the next
	 *  editor (including a Branch, which never rewrites in place) opens pre-armed with
	 *  text the user already walked away from. */
	function closeEditor() {
		pendingEdit = null;
		isEditing = false;
	}

	function handleDeleteClick() {
		showDeleteMenu = true;
	}

	async function handleDeleteAction(action: DeleteAction) {
		// A whole-subtree delete always confirms for its blast radius; a single row confirms
		// only when it costs memory, so an ordinary tidy-up stays one press.
		const costsMemory = action === 'this_only' && (spliceImpact.dropped > 0 || spliceImpact.droppedStored > 0);
		if (deleteGuard.asks && (action === 'with_descendants' || costsMemory) && confirmingDelete !== action) {
			confirmingDelete = action;
			return;
		}
		await messageStore.deleteMessage(message.id, action);
		showDeleteMenu = false;
		confirmingDelete = null;
	}

	function cancelDelete() {
		showDeleteMenu = false;
		confirmingDelete = null;
	}

	async function handleRegenerateClick() {
		// A user turn with no reply yet has nothing to "regenerate", so just generate the first
		// reply directly, no replace/alternate choice to make.
		if (isUser && !hasReply) {
			await messageStore.retryMessageResponse(message.id, 'replace');
			return;
		}
		showRegenerateMenu = true;
	}

	async function handleRegenerateAction(action: RegenerateAction) {
		// Replacing a user reply nukes the whole subtree below, so confirm first with the count.
		if (deleteGuard.asks && action === 'replace' && isUser && !confirmingReplace && belowBlast.messages > 0) {
			confirmingReplace = true;
			return;
		}
		showRegenerateMenu = false;
		confirmingReplace = false;
		await messageStore.retryMessageResponse(message.id, action);
	}

	function cancelRegenerate() {
		showRegenerateMenu = false;
		confirmingReplace = false;
	}

	function handleBranchClick() {
		pendingEdit = null;
		editorMode = 'create_branch';
		isEditing = true;
	}

	// `/branch` names the newest turn and the row it names opens its own editor, the same
	// one-shot hand-off the story map uses to point at a turn (`revealTargetId`). The editor
	// is this component's state, so the composer can ask for it and nothing more.
	let branchTargetId = $derived(messageStore.branchTargetId);

	$effect(() => {
		if (branchTargetId !== message.id) return;
		messageStore.branchTargetId = null;
		// An editor already open belongs to the button that opened it. Flipping its mode would
		// silently change what Save does (a rewrite becomes a fork), so refuse out loud instead:
		// the composer stays typeable while a turn is being edited, so this is reachable.
		if (isEditing) {
			toastStore.warning('That turn is already open in the editor');
			return;
		}
		handleBranchClick();
	});

	function handleEditClick() {
		pendingEdit = null;
		editorMode = 'save_only';
		isEditing = true;
	}

	function handleBranchNavigate(direction: 'prev' | 'next') {
		// Use store method to fetch fresh data and navigate (avoids stale allMessages race condition)
		messageStore.navigateToSibling(message.id, direction);
	}

	// ===== The keyboard on this turn =====
	// The cursor IS focus on this card (architecture/chat-sessions.md, "The message cursor"),
	// and that is what lets these be bare letters: on a turn the keyboard sits on a card, never
	// in a box that takes text, so nothing has to be modified to stay out of the way of typing.
	let cursored = $derived(chatCursor.id === message.id);

	/**
	 * Focus arrives two ways and only one of them is navigation: the keyboard doors land here,
	 * and so does a pointer press, since the browser hands focus to the nearest focusable
	 * ancestor of whatever was clicked. Only the first may mark the cursor, or reading a story
	 * with the mouse would paint a ring on the last turn touched, with nothing to clear it: the
	 * ring says where the KEYBOARD is, which is a claim a click never makes.
	 *
	 * `:focus-visible` is the browser's own answer to which kind of focus this was. It never
	 * matches a click or a tap, and it does match a programmatic focus that followed a keypress,
	 * which is what the hint labels and the focus keys do: that is what lets those two reach a
	 * turn without knowing anything about turns.
	 */
	function handleRowFocus(e: FocusEvent & { currentTarget: EventTarget & HTMLElement }) {
		if (e.currentTarget.matches(':focus-visible')) chatCursor.mark(message.id);
	}

	function handleRowKeydown(e: KeyboardEvent) {
		// Only while the cursor is on this turn. A pointer press focuses the row without marking
		// it, and a bare `E` opening an editor on a card wearing no ring would be a key landing
		// where nothing on screen says it lands.
		if (!cursored) return;
		// Only while the keyboard is on the CARD itself. Everything inside it owns its own keys
		// (the editor, the menus, a link in the prose), and one of their events passing through
		// here on the way up is not this turn being addressed.
		if (e.target !== e.currentTarget) return;
		// A modified key belongs to the workspace's own shortcuts, Alt+↑ included.
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		switch (e.key.toLowerCase()) {
			case 'arrowup':
				chatCursor.step(-1);
				break;
			case 'arrowdown':
				chatCursor.step(1);
				break;
			case 'arrowleft':
				if (siblingCount > 1) handleBranchNavigate('prev');
				break;
			case 'arrowright':
				if (siblingCount > 1) handleBranchNavigate('next');
				break;
			// Every one of these is this row's own button and never a second path to the act:
			// delete and regenerate open the very menus the pointer opens, so the confirmations
			// gating them hold for the keyboard exactly as they do for a click.
			case 'e':
				handleEditClick();
				break;
			case 'b':
				handleBranchClick();
				break;
			case 'r':
				if (showRegenerate) void handleRegenerateClick();
				break;
			case 'c':
				void handleCopy();
				break;
			case 'delete':
			case 'backspace':
				handleDeleteClick();
				break;
			default:
				return;
		}
		e.preventDefault();
	}

	async function handleCopy() {
		await copyText(message.content);
	}

	const isUser = $derived(message.role === 'user');
	// Whether this turn already has a reply below it. A user leaf (no reply) should offer
	// "Generate Reply" (make the first one), not "Regenerate".
	const hasReply = $derived(allMessages.some((m) => m.parentId === message.id));
	// Resolve the persona this message was sent with: locked per-message, NOT the global
	// active persona. Switching the active persona must never re-label past messages.
	const userPersona = $derived.by(() => {
		const pid = message.personaId;
		if (message.role !== 'user' || !pid) return null;
		const entry = characterLibraryStore.entries.find((e) => e.id === pid && e.type === 'persona');
		return entry
			? {
					name: entry.identity.name,
					imageUrl: entry.identity.imageUrl ?? null,
					portraitFocus: entry.identity.portraitFocus
				}
			: null;
	});
	const assistantSpeaker = $derived.by(() => {
		const cid = chatStore.activeChat?.characterId;
		if (!cid) return null;
		const entry = characterLibraryStore.entries.find((e) => e.id === cid);
		return entry
			? {
					name: entry.identity.name,
					imageUrl: entry.identity.imageUrl ?? null,
					portraitFocus: entry.identity.portraitFocus
				}
			: null;
	});
	const speakerName = $derived(
		message.role === 'user'
			? userPersona?.name?.trim() || 'You'
			: message.role === 'assistant'
				? assistantSpeaker?.name?.trim() || 'Assistant'
				: 'System'
	);
	const speakerImagePath = $derived(
		message.role === 'user'
			? userPersona?.imageUrl ?? null
			: message.role === 'assistant'
				? assistantSpeaker?.imageUrl ?? null
				: null
	);
	const speakerFocus = $derived(
		message.role === 'user' ? userPersona?.portraitFocus : assistantSpeaker?.portraitFocus
	);
	// Generate belongs to the last user turn and retry to the last reply, nowhere else. Offered
	// mid-story, "add alternate reply" forked a second reply under a turn that already had one,
	// and after a splice had left a user turn hanging there, the two became swipe variants of
	// each other: 1 of 2 a user turn, 2 of 2 a reply. To re-roll from further back, branch the
	// user turn there (the Branch action): the clone becomes the leaf and generates from it.
	// Every root assistant turn is a BEGINNING: a seeded greeting, or an opening already
	// written here. So "write another one" belongs in the same cluster as the arrows that walk
	// between them, which is where the hand reaching for another opening already is. A root
	// turn of the reader's own is their first line and gets no offer; /opening covers that.
	const canWriteOpening = $derived(
		message.parentId === null && message.role === 'assistant' && featurePromptsStore.openingSceneEnabled
	);
	let openingPopoverOpen = $state(false);

	function handleGenerateOpening(direction: string) {
		// The store toasts its own generation failures; only its throw-guards reach here, and
		// the button is gated on the one this row can see.
		void messageStore.generateOpeningScene(direction).catch((error) => {
			toastStore.failed('generate the opening scene', error);
		});
	}

	const showRegenerate = $derived(
		isLast && (message.role === 'user' || (message.role === 'assistant' && message.parentId !== null))
	);
	// Continue extends a reply in place, so it belongs to the newest turn and nowhere else.
	// A seeded greeting qualifies where Retry refuses one: a continuation works from the reply
	// itself, while a re-roll needs the prompt that wrote it, and a greeting has none.
	const showContinue = $derived(isLast && message.role === 'assistant');

	function handleContinue() {
		// The store toasts its own generation failures; only its throw-guards reach here.
		void messageStore.continueMessage().catch((error) => {
			toastStore.failed('continue the reply', error);
		});
	}
	const messageTokens = $derived(countTokens(message.content, message.model ?? undefined));
	// Assistant turns carry the provider's real completion token count, so show that rather
	// than a local estimate. User turns have no per-message actual (the API only reports
	// whole-prompt tokens), so they stay estimated.
	const actualTokens = $derived(
		message.role === 'assistant' && message.tokensCompletion ? message.tokensCompletion : null
	);
	// Shown in the meta info icon's tooltip; "~" marks a local estimate.
	const tokenLabel = $derived(
		actualTokens !== null
			? `${actualTokens.toLocaleString()} tokens`
			: `~${messageTokens} tokens`
	);
	// Continue flow: the live tail joins the stored content through the preview rule (the
	// final write's seam rule, plus a hold on tails that are still pure restatement, so a
	// model re-typing the message never paints it duplicating itself). The anchor is the
	// content with self-refs expanded: the model restates the expanded text it was sent,
	// not the stored macros. Any new reasoning streams in after the stored block.
	const displayedContent = $derived(
		streamTail != null
			? previewContinuation(message.content, streamTail, expandSelfRefs(message.content, selfRefChar, selfRefUser))
			: message.content
	);
	const liveThinking = $derived(
		streamTailThinking
			? message.thinking
				? message.thinking + '\n\n' + streamTailThinking
				: streamTailThinking
			: message.thinking
	);
	// The emptiness check lives here, not in MessageReasoning: the box is a pure
	// renderer, so a whitespace-only reasoning string never mounts an empty shell.
	const hasReasoning = $derived(Boolean(liveThinking?.trim()));
	// The story text as it reaches the page: display-scope regex rules (measured against this
	// turn's depth), then live {{char}}/{{user}}, then markdown. Derived rather than inlined
	// so the action below re-runs on exactly these inputs and nothing else.
	const bodyHtml = $derived(
		renderMarkdown(
			expandSelfRefs(
				regexRulesStore.forDisplay(displayedContent, message.role, depth),
				selfRefChar,
				selfRefUser
			)
		)
	);
	// Portraits style renders the portrait INSIDE the card (floated top-left),
	// so the outer avatar column has to come off the DOM, not just hide.
	const isPortraitStyle = $derived(themeStore.appearance.chatStyle === 'portrait');
	// Null suppresses the badge; MessageAvatar renders it only when given a number.
	const avatarOrdinal = $derived(themeStore.appearance.showMessageNumbers ? ordinal : null);
	// No portrait column to hang the #N badge and the timer off: the Portraits setting
	// is off, or Manuscript (which has never drawn one). Both readouts fall back into
	// the meta row rather than vanishing, because a visibility toggle silently killing two
	// OTHER visibility toggles is a lie, not a layout.
	const avatarsHidden = $derived(
		!themeStore.appearance.showAvatars || themeStore.appearance.chatStyle === 'manuscript'
	);
	// Meta-row visibility knobs (Settings → Layout): a null prop drops the piece, and
	// MessageMeta hides the info icon entirely once model and tokens are both gone.
	// Gating tokens here also skips the countTokens estimate while it's off ($derived is lazy).
	const showTimestamps = $derived(themeStore.appearance.showTimestamps);
	const showModelName = $derived(themeStore.appearance.showModelName);
	const showTokenCount = $derived(themeStore.appearance.showTokenCount);
	const showGenerationTime = $derived(themeStore.appearance.showGenerationTime);
	// The pill appears only where a scan actually happened: a turn that consulted no book at
	// all (no lorebook linked, an imported chat, a seeded greeting) has nothing to report, and
	// a pill reading zero on every reply would be noise for everyone not using lorebooks.
	const loreTrace = $derived(
		message.lorebook && (message.lorebook.records.length > 0 || message.lorebook.silent > 0)
			? message.lorebook
			: null
	);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- the card is where the
     message cursor parks, so it takes focus and the turn's own keys; it stays out of the
     tab order (tabindex -1) because Tab through a long transcript is not navigation. -->
<article
	id="msg-{message.id}"
	class="message-row group fade-in"
	class:message-archived={archived}
	class:message-row-cursor={cursored}
	tabindex="-1"
	data-hint
	onfocus={handleRowFocus}
	onkeydown={handleRowKeydown}
	onmouseenter={() => (showActions = true)}
	onmouseleave={() => (showActions = false)}
	aria-label="{message.role} message{archived ? ' (in memory)' : ''}"
>
	<div class="message-inner">
		<div class="message-main {isUser ? 'message-main-user' : 'message-main-assistant'}">
			{#if !isPortraitStyle && !avatarsHidden}
				<MessageAvatar
					role={message.role}
					name={speakerName}
					imagePath={speakerImagePath}
					focus={speakerFocus}
					ordinal={avatarOrdinal}
					durationMs={showGenerationTime ? message.generationMs : null}
				/>
			{/if}

			<div class="message-body">
				<div class="message-rail {isUser ? 'message-rail-user' : 'message-rail-assistant'}">
					<div class="message-bubble-shell {isUser ? 'message-bubble-shell-user' : 'message-bubble-shell-assistant'}">
						<!-- data-message-card: the handle MessageList throws the arrival glow around.
						     It has to be the CARD and not the row: the row is as wide as the
						     scrollport, which clips a glow left and right and lets the next turn
						     paint over the bottom of it, leaving a bar along the top edge. -->
						<div
							class="message-bubble {isUser ? 'message-bubble-user' : 'message-bubble-assistant'}"
							data-message-card
						>
							{#if isPortraitStyle && !avatarsHidden}
								<div class="message-portrait">
									<MessageAvatar
										role={message.role}
										name={speakerName}
										imagePath={speakerImagePath}
										focus={speakerFocus}
										ordinal={avatarOrdinal}
										durationMs={showGenerationTime ? message.generationMs : null}
									/>
								</div>
							{/if}
							<div class="message-card-col">
							<MessageMeta
								name={speakerName}
								{isUser}
								timestamp={showTimestamps ? message.createdAt : null}
								model={showModelName ? message.model : null}
								provider={showModelName ? message.provider : null}
								edited={!!(message.editedAt || message.minorEditedAt)}
								tokens={showTokenCount ? tokenLabel : null}
								ordinal={avatarsHidden ? avatarOrdinal : null}
								durationMs={avatarsHidden && showGenerationTime ? message.generationMs : null}
								{archived}
								lorebook={loreTrace}
								onLorebook={() => (loreOpen = true)}
							/>
							{#if hasReasoning}
								<div class="message-thinking">
									<MessageReasoning
										thinking={liveThinking!}
										isStreaming={!!streamTailThinking}
									/>
								</div>
							{/if}

							{#if isEditing}
								<div class="message-content message-content-editing">
									<MessageEditor
										initialContent={message.content}
										role={message.role}
										mode={editorMode}
										onSave={handleEdit}
										onCancel={closeEditor}
										locked={pendingEdit !== null}
									/>
									<!-- Raised by Save, not by the Edit button: opening an editor costs nothing,
									     and the draft has to be readable while the cost of keeping it is stated.
									     Cancel drops back into the editor with the text still there. -->
									{#if pendingEdit !== null}
										<div class="memory-confirm">
											<p class="memory-confirm-title">This turn is in memory</p>
											{#each editLines as line (line)}
												<p class="memory-confirm-line">{line}</p>
											{/each}
											<div class="memory-confirm-actions">
												<HoldToConfirmButton holdMs={holdMsForBlast(editBlast)} onconfirm={() => commitPendingEdit(false)}>
													<Icon name="check" class="w-3.5 h-3.5" />
													Save the edit
												</HoldToConfirmButton>
												<!-- The cheap door, and a plain click on purpose: the gesture is the
												     difference between the two saves. Holding pays for the rebuild;
												     tapping says there is nothing to rebuild. -->
												<button
													class="memory-confirm-minor"
													onclick={() => commitPendingEdit(true)}
												>
													<Icon name="feather" class="w-3.5 h-3.5" />
													<span>
														Save quietly
														<span class="memory-confirm-minor-note">Saves without rebuilding this part of the memory. Use it when the turn still says the same thing.</span>
													</span>
												</button>
												<button
													class="w-full px-3 py-2 text-left text-sm font-ui font-medium text-text-secondary hover:bg-bg-tertiary rounded-[var(--radius-lg)] transition-all duration-150"
													onclick={() => (pendingEdit = null)}
												>
													Keep editing
												</button>
											</div>
										</div>
									{/if}
								</div>
							{:else}
								<div class="message-content">
									{#if imageAttachments.length}
										<div class="message-attachments">
											{#each imageAttachments as path, i (path)}
												<button
													type="button"
													class="message-attachment"
													onclick={() => (viewerIndex = i)}
													title="View full size"
												>
													<img src={imageService.thumbnailUrl(path)} alt="Attachment" loading="lazy" />
												</button>
											{/each}
										</div>
									{/if}
									<!-- data-search-text is the find-in-chat scope hook (ChatSearchBar):
									     the story text and nothing else, so the meta row, toolbar and
									     token readouts can never produce a phantom hit.
									     use:renderedHtml rather than {@html}: it patches this subtree
									     instead of rebuilding it, which is what lets a folding panel
									     take a click while the reply is still arriving. -->
									<div class="prose message-prose" data-search-text use:renderedHtml={bodyHtml}></div>
								</div>
							{/if}
							</div>
						</div>
					</div>
				</div>

				{#if !isEditing}
					<div class="message-toolbar-shell {isUser ? 'message-toolbar-shell-user' : 'message-toolbar-shell-assistant'}">
						<div class="message-toolbar {isUser ? 'justify-end' : 'justify-start'}">
							<div
								class="relative message-actions-slot"
								class:message-actions-visible={showActions || cursored || showDeleteMenu || showRegenerateMenu}
							>
								<MessageActions
									onEdit={handleEditClick}
									onDelete={handleDeleteClick}
									onCopy={handleCopy}
									onRegenerate={showRegenerate ? handleRegenerateClick : undefined}
									{showRegenerate}
									regenerateLabel={isUser ? (hasReply ? 'Regenerate' : 'Generate Reply') : 'Retry'}
									onContinue={showContinue ? handleContinue : undefined}
									{showContinue}
									onBranch={handleBranchClick}
									showBranch
								/>

								{#if showDeleteMenu}
									<div
										class="fixed inset-0 z-10"
										onclick={cancelDelete}
										onkeydown={(e) => {
											if (e.key === 'Escape') {
												// Consume the press so the workspace's global Esc stands down.
												e.preventDefault();
												e.stopPropagation();
												cancelDelete();
											}
										}}
										role="button"
										tabindex="-1"
										aria-label="Close menu"
									></div>
									<div
										bind:this={deleteMenuElement}
										class="absolute top-full mt-2 {isUser ? 'right-0' : 'left-0'} w-72 max-w-[calc(100vw-2rem)] surface-float rounded-[var(--radius-lg)] overflow-hidden z-20 slide-up"
										style="box-shadow: var(--shadow-md);"
									>
										{#if confirmingDelete}
											<div class="p-3 border-b border-border-subtle bg-error/10">
												<p class="text-sm font-ui font-medium text-error">Are you sure?</p>
												<p class="text-xs text-text-muted mt-1">
													This deletes {confirmCount} message{confirmCount === 1 ? '' : 's'}{confirmingDelete === 'with_descendants' && deleteBlast.branches > 1 ? ` across ${deleteBlast.branches} branches` : ''}.
													This cannot be undone.
												</p>
												<!-- What it costs memory, in the numbers of THIS delete: which summaries
												     go, which pause, and what re-reads them. Absent when memory is off or
												     these turns were never folded. -->
												{#each confirmLines as line (line)}
													<p class="text-xs text-text-muted mt-1.5">{line}</p>
												{/each}
											</div>
											<div class="p-1.5 space-y-1.5">
												<HoldToConfirmButton
													holdMs={holdMsForBlast(confirmCount + confirmImpact.reread + confirmImpact.paused)}
													onconfirm={() => handleDeleteAction(confirmingDelete!)}
												>
													<Icon name="trash" class="w-3.5 h-3.5" />
													Delete {confirmCount} message{confirmCount === 1 ? '' : 's'}
												</HoldToConfirmButton>
												<button
													class="w-full px-3 py-2 text-left text-sm font-ui font-medium text-text-secondary hover:bg-bg-tertiary rounded-[var(--radius-lg)] transition-all duration-150"
													onclick={cancelDelete}
												>
													Cancel
												</button>
											</div>
										{:else}
											<div class="p-3 border-b border-border-subtle bg-bg-secondary">
												<p class="text-sm font-ui font-medium text-text-primary">Delete message</p>
											</div>
											<div class="p-1.5">
												{#if hasBelow}
													{#if canSplice}
														<button
															class="w-full text-left px-3 py-2.5 hover:bg-bg-tertiary rounded-[var(--radius-lg)] text-sm font-ui transition-all duration-150"
															onclick={() => handleDeleteAction('this_only')}
														>
															<span class="font-medium text-text-primary">Delete this message only</span>
															<p class="text-text-muted text-xs mt-0.5">Replies below are kept and reattach to the previous turn</p>
														</button>
													{/if}
													<button
														class="w-full text-left px-3 py-2.5 hover:bg-error/5 rounded-[var(--radius-lg)] text-sm font-ui transition-all duration-150"
														onclick={() => handleDeleteAction('with_descendants')}
													>
														<span class="font-medium text-error">Delete with all responses</span>
														<p class="text-text-muted text-xs mt-0.5">
															{canSplice
																? 'Remove this and everything below it'
																: 'This turn starts a branch, so it can only go whole'} · {deleteBlast.messages} message{deleteBlast.messages === 1 ? '' : 's'}
														</p>
													</button>
												{:else}
													<button
														class="w-full text-left px-3 py-2.5 hover:bg-error/5 rounded-[var(--radius-lg)] text-sm font-ui transition-all duration-150"
														onclick={() => handleDeleteAction('this_only')}
													>
														<span class="font-medium text-error">Delete this message</span>
														<p class="text-text-muted text-xs mt-0.5">Nothing follows this turn · this can't be undone</p>
													</button>
												{/if}
												<button
													class="w-full text-left px-3 py-2.5 hover:bg-bg-tertiary rounded-[var(--radius-lg)] text-sm font-ui text-text-muted transition-all duration-150"
													onclick={cancelDelete}
												>
													Cancel
												</button>
											</div>
										{/if}
									</div>
								{/if}

								{#if showRegenerateMenu}
									<div
										class="fixed inset-0 z-10"
										onclick={cancelRegenerate}
										onkeydown={(e) => {
											if (e.key === 'Escape') {
												// Consume the press so the workspace's global Esc stands down.
												e.preventDefault();
												e.stopPropagation();
												cancelRegenerate();
											}
										}}
										role="button"
										tabindex="-1"
										aria-label="Close menu"
									></div>
									<div
										bind:this={regenerateMenuElement}
										class="absolute top-full mt-2 {isUser ? 'right-0' : 'left-0'} w-72 max-w-[calc(100vw-2rem)] surface-float rounded-[var(--radius-lg)] overflow-hidden z-20 slide-up"
										style="box-shadow: var(--shadow-md);"
									>
										{#if confirmingReplace}
											<div class="p-3 border-b border-border-subtle bg-error/10">
												<p class="text-sm font-ui font-medium text-error">Replace reply?</p>
												<p class="text-xs text-text-muted mt-1">
													This deletes {belowBlast.messages} message{belowBlast.messages === 1 ? '' : 's'}{belowBlast.branches > 1 ? ` across ${belowBlast.branches} branches` : ''} below
													and generates a fresh reply. This can't be undone.
												</p>
											</div>
											<div class="p-1.5 space-y-1.5">
												<HoldToConfirmButton
													holdMs={holdMsForBlast(belowBlast.messages)}
													onconfirm={() => handleRegenerateAction('replace')}
												>
													<Icon name="warning" class="w-3.5 h-3.5" />
													Delete {belowBlast.messages} message{belowBlast.messages === 1 ? '' : 's'} & replace
												</HoldToConfirmButton>
												<button
													class="w-full px-3 py-2 text-left text-sm font-ui font-medium text-text-secondary hover:bg-bg-tertiary rounded-[var(--radius-lg)] transition-all duration-150"
													onclick={cancelRegenerate}
												>
													Cancel
												</button>
											</div>
										{:else}
										<div class="p-3 border-b border-border-subtle bg-bg-secondary">
											<p class="text-sm font-ui font-medium text-text-primary">
												{message.role === 'user' ? 'Regenerate reply' : 'Regenerate response'}
											</p>
										</div>
										<div class="p-1.5">
											<button
												class="w-full text-left px-3 py-2.5 hover:bg-bg-tertiary rounded-[var(--radius-lg)] text-sm font-ui transition-all duration-150"
												onclick={() => handleRegenerateAction('replace')}
											>
												<span class="font-medium text-text-primary">
													{message.role === 'user' ? 'Replace reply' : 'Replace current'}
												</span>
												<p class="text-text-muted text-xs mt-0.5">
													{message.role === 'user'
														? 'Delete the replies below and generate a fresh one'
														: 'Delete this response and generate a new one'}
												</p>
											</button>
											<button
												class="w-full text-left px-3 py-2.5 hover:bg-bg-tertiary rounded-[var(--radius-lg)] text-sm font-ui transition-all duration-150"
												onclick={() => handleRegenerateAction('branch')}
											>
												<span class="font-medium text-text-primary">
													{message.role === 'user' ? 'Add alternate reply' : 'Create alternate'}
												</span>
												<p class="text-text-muted text-xs mt-0.5">
													{message.role === 'user'
														? 'Keep the current reply and generate another to swipe between'
														: 'Keep this response and generate a new branch'}
												</p>
											</button>
											<button
												class="w-full text-left px-3 py-2.5 hover:bg-bg-tertiary rounded-[var(--radius-lg)] text-sm font-ui text-text-muted transition-all duration-150"
												onclick={cancelRegenerate}
											>
												Cancel
											</button>
										</div>
										{/if}
									</div>
								{/if}
							</div>
							{#if siblingCount > 1 || canWriteOpening}
								<div
									class="message-pager-slot"
									class:message-actions-visible={showActions || cursored || openingPopoverOpen}
								>
									{#if siblingCount > 1}
										<BranchNavigator current={siblingIndex} total={siblingCount} onNavigate={handleBranchNavigate} />
									{/if}
									{#if canWriteOpening}
										<div class="opening-anchor">
											<button
												type="button"
												class="opening-btn"
												onclick={() => (openingPopoverOpen = true)}
												disabled={messageStore.isStreaming}
												aria-label="Write another opening scene"
												title="Write another opening scene"
											>
												<Icon name="sparkles" class="w-3.5 h-3.5" strokeWidth={1.75} />
											</button>
											<OpeningScenePopover
												open={openingPopoverOpen}
												onClose={() => (openingPopoverOpen = false)}
												onGenerate={handleGenerateOpening}
											/>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</article>

<!-- Gated on having attachments at all, not on the viewer being open: the open/closed
     condition belongs to the component (see ImageLightbox), but a message with no
     attachment can never open it and shouldn't carry an instance per row. -->
{#if imageAttachments.length}
	<ImageLightbox
		images={imageAttachments}
		bind:index={viewerIndex}
		alt="Chat attachment"
		onClose={() => (viewerIndex = null)}
	/>
{/if}

<!-- Mounted only while open, unlike the lightbox above: a trace is a whole record, and every
     turn on screen carrying a parked copy of one would cost the transcript for a panel almost
     nobody has open. -->
{#if loreTrace && loreOpen}
	<Dialog open onClose={() => (loreOpen = false)} title="Lorebook scan" size="xl">
		<LorebookTraceList trace={loreTrace} />
	</Dialog>
{/if}

<style>
	/* Everything shaped by Settings → Chat reads a --msg-* / --user-* var
	   here; the fallback in each is the shipped default, so the transcript paints
	   correctly before the theme store has stamped anything on <html>. */
	.message-row {
		position: relative;
		padding: var(--msg-row-gap, clamp(0.45rem, 0.36rem + 0.42vw, 0.75rem))
			clamp(0.55rem, 0.4rem + 0.5vw, 0.95rem);
	}

	/* Ghost state: a turn that has been folded into chat memory. Subtle by default
	   (dimmed, a hint of desaturation) so live turns stand out at a glance, and it lifts
	   toward full clarity on hover so the text stays readable when you go looking. */
	.message-archived {
		opacity: var(--msg-archived-opacity, 0.6);
		transition: opacity 160ms ease, filter 160ms ease;
	}

	.message-archived :global(.message-bubble) {
		filter: saturate(0.82);
	}

	/* The outline moved to the shell, so the ghost's dashed treatment follows it. */
	.message-archived :global(.message-bubble-shell)::before {
		border-style: dashed;
	}

	.message-archived:hover {
		opacity: 1;
	}

	.message-inner {
		width: 100%;
		max-width: 100%;
		margin: 0 auto;
	}

	.message-main {
		width: 100%;
		display: flex;
		align-items: flex-start;
		gap: clamp(0.5rem, 0.42rem + 0.3vw, 0.78rem);
	}

	.message-main-user {
		flex-direction: row-reverse;
	}

	.message-main-assistant {
		flex-direction: row;
	}

	.message-body {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.message-rail {
		width: 100%;
		display: flex;
	}

	.message-rail-user {
		justify-content: flex-end;
	}

	.message-rail-assistant {
		justify-content: flex-start;
	}

	.message-bubble-shell {
		position: relative;
		width: 100%;
	}

	/* The readable cap (--reading-measure, app.css) scales with the user's
	   chat-width knob so a wider column actually yields wider text instead of more
	   empty margin; the card-width knob then takes a fraction of whatever that
	   resolved to. */
	.message-bubble-shell-user,
	.message-bubble-shell-assistant {
		width: calc(
			min(94%, calc(var(--reading-measure) * var(--user-chat-width, 1))) *
				var(--user-bubble-width, 1)
		);
	}

	/* The card's border is transparent: it is here only to hold the box model. The
	   VISIBLE outline is drawn by .message-bubble-shell::before, above the card, so
	   it survives a style whose card must not clip its own content (Portraits, where
	   the sticky portrait needs overflow: visible). `background-clip: padding-box`
	   stops the translucent fill from painting under that transparent border, where
	   it would stack with the outline into a denser edge. */
	.message-bubble {
		position: relative;
		z-index: 1;
		border-radius: var(--msg-radius, calc(var(--radius-xl) + 0.14rem));
		border: var(--msg-border-width, 1px) solid transparent;
		background-clip: padding-box;
		box-shadow: var(--msg-shadow, var(--shadow-sm));
		overflow: hidden;
	}

	.message-bubble-user {
		background: var(--color-user-bubble);
		border-top-right-radius: var(--msg-radius-notch, 0.58rem);
	}

	.message-bubble-assistant {
		background: var(--color-assistant-bubble);
		border-top-left-radius: var(--msg-radius-notch, 0.58rem);
	}

	/* The card outline, on the shell so it paints above the card's own content. */
	.message-bubble-shell::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
		border: var(--msg-border-width, 1px) solid
			var(--msg-border-color, color-mix(in srgb, var(--color-border-subtle) 88%, transparent));
		border-radius: var(--msg-radius, calc(var(--radius-xl) + 0.14rem));
	}

	.message-bubble-shell-user::before {
		border-top-right-radius: var(--msg-radius-notch, 0.58rem);
	}

	.message-bubble-shell-assistant::before {
		border-top-left-radius: var(--msg-radius-notch, 0.58rem);
	}

	/* Vertical rhythm around the diagnostics bar: the gap above (meta's 0.18rem
	   bottom padding + 0.35rem here) matches the gap below (0.3rem here + the
	   content's 0.24rem top padding). */
	.message-thinking {
		padding: 0.35rem var(--msg-pad-x, 0.98rem) 0.3rem;
	}

	.message-content {
		padding: 0.24rem var(--msg-pad-x, 0.98rem) var(--msg-pad-bottom, 0.95rem);
	}

	.message-content-editing {
		padding-top: 0.45rem;
	}

	/* The memory cost of keeping this rewrite, under the editor it applies to. It carries the
	   error tint the destructive menus use, because that is what the hold button below it
	   means, but it sits inside the editor rather than over it, so the draft stays readable
	   while the price is being read. */
	.memory-confirm {
		margin-top: 0.5rem;
		padding: 0.6rem 0.65rem 0.5rem;
		border: 1px solid color-mix(in srgb, var(--color-error) 26%, transparent);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-error) 7%, transparent);
	}
	.memory-confirm-title {
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--color-error);
	}
	.memory-confirm-line {
		margin-top: 0.3rem;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}
	.memory-confirm-actions {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.55rem;
	}

	/* Deliberately NOT in the error palette the hold button wears: this is the save that
	   costs nothing, and the two must not read as variations of the same risk. */
	.memory-confirm-minor {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		width: 100%;
		padding: 0.5rem 0.65rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
		transition: border-color 140ms ease, background-color 140ms ease;
	}
	.memory-confirm-minor:hover {
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: var(--color-bg-tertiary);
	}
	.memory-confirm-minor-note {
		display: block;
		margin-top: 0.15rem;
		font-weight: 400;
		font-size: 0.72rem;
		line-height: 1.4;
		color: var(--color-text-muted);
	}

	.message-attachments {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 0.5rem;
	}

	.message-attachment {
		display: block;
		width: 8.5rem;
		max-width: 40%;
		padding: 0;
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
		border-radius: var(--radius-md);
		overflow: hidden;
		cursor: zoom-in;
		background: color-mix(in srgb, var(--color-bg-tertiary) 50%, transparent);
	}

	.message-attachment img {
		display: block;
		width: 100%;
		height: auto;
	}

	.message-prose {
		font-size: calc(clamp(0.95rem, 0.91rem + 0.16vw, 1.03rem) * var(--user-font-scale, 1));
		line-height: var(--user-line-height, 1.72);
	}

	.message-bubble-user .message-prose {
		line-height: calc(var(--user-line-height, 1.72) - 0.08);
	}

	.message-prose :global(p) {
		margin: 0 0 var(--user-paragraph-spacing, 1em);
	}

	.message-prose :global(p:last-child) {
		margin-bottom: 0;
	}

	.message-prose :global(h1),
	.message-prose :global(h2),
	.message-prose :global(h3),
	.message-prose :global(h4) {
		font-family: var(--font-ui);
		letter-spacing: 0.01em;
		margin-top: 1.15em;
		margin-bottom: 0.55em;
	}

	.message-prose :global(blockquote) {
		margin: 1.05rem 0;
		padding: 0.2rem 0 0.2rem 0.92rem;
		border-left-width: 2px;
	}

	.message-prose :global(ul),
	.message-prose :global(ol) {
		margin: 0.86em 0;
		padding-left: 1.34em;
	}

	.message-prose :global(li + li) {
		margin-top: 0.26em;
	}

	.message-prose :global(pre) {
		margin: 1.05em 0;
	}

	/* Quiet footnote line: one slim in-flow row under the bubble. The branch pager
	   and token count are always-visible faint footnotes; the action icons share
	   the same line and only fade in on hover. In-flow, so it can never sit on
	   message text, and at ~1.5rem it costs half the old pill toolbar. */
	.message-toolbar-shell {
		margin-top: 0.2rem;
		display: flex;
	}

	.message-toolbar-shell-user {
		justify-content: flex-end;
	}

	.message-toolbar-shell-assistant {
		justify-content: flex-start;
	}

	.message-toolbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: max-content;
		max-width: 100%;
	}

	/* Idle visibility of the action icons and the branch pager both come from
	   Settings → Chat; hover and focus-within always reveal, so the tray
	   stays reachable by keyboard and not just by mouse. */
	.message-actions-slot {
		opacity: var(--msg-actions-idle-opacity, 0);
		pointer-events: var(--msg-actions-idle-events, none);
		transition: opacity 120ms ease;
	}

	.message-pager-slot {
		display: flex;
		gap: 0.25rem;
		opacity: var(--msg-pager-idle-opacity, 1);
		pointer-events: var(--msg-pager-idle-events, auto);
		transition: opacity 120ms ease;
	}

	.opening-anchor {
		position: relative;
		display: inline-flex;
	}

	/* Drawn as one more pill in the pager cluster rather than as a stray icon beside it, so
	   its size tracks BranchNavigator's outer shell: that pill is a 1.6rem button inside
	   0.16rem of padding and a 1px border, which is what these numbers add up to. */
	.opening-btn {
		width: 2.05rem;
		height: 2.05rem;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 92%, transparent);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-bg-secondary) 76%, transparent);
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease;
	}

	.opening-btn:hover:not(:disabled) {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	.opening-btn:disabled {
		opacity: 0.32;
		cursor: not-allowed;
	}

	.opening-btn:focus-visible {
		outline: 0;
		border-color: color-mix(in srgb, var(--color-accent) 85%, white 15%);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent-muted) 70%, transparent);
	}

	@media (pointer: coarse) {
		.opening-btn {
			width: 2.85rem;
			height: 2.85rem;
		}
	}

	.message-actions-visible,
	.message-actions-slot:focus-within,
	.message-pager-slot:focus-within {
		opacity: 1;
		pointer-events: auto;
	}

	/* The always-visible footnotes hug the bubble's edge; the idle-hidden actions
	   take the inner end of the line so they never leave a blank indent. */
	.message-toolbar-shell-assistant .message-actions-slot {
		order: 2;
	}

	@media (max-width: 900px) {
		.message-row {
			padding-inline: 0.45rem;
		}

		.message-main {
			gap: 0.42rem;
		}

		.message-bubble-shell-user,
		.message-bubble-shell-assistant {
			width: 100%;
		}

		.message-content {
			padding-inline: min(0.86rem, var(--msg-pad-x, 0.98rem));
		}

	}

	/* No hover on touch (any width, since a touch laptop is wider than 900px): the
	   action icons and pager stay visible and archived turns don't rely on hover to
	   lift. "Hidden" actions still win, since that is a display rule. */
	@media (hover: none) {
		.message-actions-slot,
		.message-pager-slot {
			opacity: 1;
			pointer-events: auto;
		}

		.message-archived {
			opacity: max(var(--msg-archived-opacity, 0.6), 0.75);
		}
	}

	/* ===== Chat style: Flat =====
	   Bubbles exactly (same cards, same per-role colors) with both speakers down
	   the left. Everything below is just the user turn giving up its mirroring;
	   nothing about the card itself changes, which is why every knob on the Chat
	   Layout page applies here the same way it does to Bubbles. */
	:global([data-chat-style='flat']) .message-main-user {
		flex-direction: row;
	}

	:global([data-chat-style='flat']) .message-rail-user {
		justify-content: flex-start;
	}

	/* The tight notch follows the portrait to the left edge: it marks the speaker's
	   side of the card, and in this style the speaker is always on the left. */
	:global([data-chat-style='flat']) .message-bubble-shell-user::before {
		border-top-right-radius: var(--msg-radius, calc(var(--radius-xl) + 0.14rem));
		border-top-left-radius: var(--msg-radius-notch, 0.58rem);
	}

	:global([data-chat-style='flat']) .message-bubble-user {
		border-top-right-radius: var(--msg-radius, calc(var(--radius-xl) + 0.14rem));
		border-top-left-radius: var(--msg-radius-notch, 0.58rem);
	}

	/* Left-packed line: footnotes hug the left edge, actions take the inner end. */
	:global([data-chat-style='flat']) .message-toolbar-shell-user {
		justify-content: flex-start;
	}

	:global([data-chat-style='flat']) .message-toolbar-shell-user .message-actions-slot {
		order: 2;
	}

	/* ===== Chat style: Portraits =====
	   Forum-log look: every turn is a full-width flat card, both roles aligned
	   left. The card is a two-column flex row: the portrait is the left column,
	   fading into the card on its right/bottom edges; the speaker header,
	   diagnostics and prose live in .message-card-col beside it. The portrait is
	   sticky against the chat scrollport: it pins to the top while the card
	   scrolls past and rides down until the card's bottom edge catches it.
	   The data-chat-style attribute is stamped on <html> by the theme store. */
	.message-portrait {
		flex: 0 0 calc(clamp(5rem, 4rem + 3.5vw, 8.75rem) * var(--avatar-scale, 1));
		position: sticky;
		top: 0;
		margin-right: 0.2rem;
		/* Breathing room under the portrait when the message is short; also stops
		   the sticky ride just short of the card's bottom edge. */
		margin-bottom: 1.8rem;
	}

	:global([data-chat-style='portrait']) .message-card-col {
		flex: 1;
		min-width: 0;
	}

	:global([data-chat-style='portrait']) .message-main-user {
		flex-direction: row;
	}

	:global([data-chat-style='portrait']) .message-rail-user {
		justify-content: flex-start;
	}

	:global([data-chat-style='portrait']) .message-bubble-shell-user,
	:global([data-chat-style='portrait']) .message-bubble-shell-assistant {
		width: 100%;
	}

	:global([data-chat-style='portrait']) .message-bubble {
		border-radius: var(--msg-radius-card, var(--radius-lg));
		display: flex;
		align-items: flex-start;
		/* Sticky is inert inside any clipping ancestor, so the card must not clip.
		   The portrait's own top-left radius covers the exposed corner. */
		overflow: visible;
	}

	:global([data-chat-style='portrait']) .message-bubble-shell::before {
		border-radius: var(--msg-radius-card, var(--radius-lg));
	}

	/* Left-packed line: footnotes hug the left edge, actions take the inner end. */
	:global([data-chat-style='portrait']) .message-toolbar-shell-user {
		justify-content: flex-start;
	}

	:global([data-chat-style='portrait']) .message-toolbar-shell-user .message-actions-slot {
		order: 2;
	}

	:global([data-chat-style='portrait']) .message-toolbar {
		justify-content: flex-start;
	}

	/* ===== Chat style: Manuscript =====
	   Bare reading flow: no cards, no avatars (hidden in MessageAvatar), just the
	   speaker label and prose: as close to a book page as a chat can get. */
	:global([data-chat-style='manuscript']) .message-main-user {
		flex-direction: row;
	}

	:global([data-chat-style='manuscript']) .message-rail-user {
		justify-content: flex-start;
	}

	:global([data-chat-style='manuscript']) .message-bubble-shell-user,
	:global([data-chat-style='manuscript']) .message-bubble-shell-assistant {
		width: 100%;
	}

	/* No card, no clip: the bubble's rounded-corner overflow clipping would
	   softly shave the speaker label sitting 0.2rem from the corner. */
	:global([data-chat-style='manuscript']) .message-bubble {
		background: transparent;
		border-color: transparent;
		box-shadow: none;
		border-radius: 0;
		overflow: visible;
	}

	:global([data-chat-style='manuscript']) .message-bubble-shell::before {
		display: none;
	}

	:global([data-chat-style='manuscript']) .message-bubble-user,
	:global([data-chat-style='manuscript']) .message-bubble-assistant {
		background: transparent;
	}

	:global([data-chat-style='manuscript']) .message-content {
		padding-left: 0.2rem;
		padding-right: 0.2rem;
	}

	:global([data-chat-style='manuscript']) .message-thinking {
		padding-left: 0.2rem;
	}

	:global([data-chat-style='manuscript']) .message-row {
		padding-block: 0.3rem;
	}

	/* Left-packed line: footnotes hug the left edge, actions take the inner end. */
	:global([data-chat-style='manuscript']) .message-toolbar-shell-user {
		justify-content: flex-start;
	}

	:global([data-chat-style='manuscript']) .message-toolbar-shell-user .message-actions-slot {
		order: 2;
	}

	:global([data-chat-style='manuscript']) .message-toolbar {
		justify-content: flex-start;
	}

	/* ===== The message cursor =====
	   Where the keyboard is in the story. It rides the shell's ring rather than a ring of its
	   own, which is what makes it work in every chat style at once and keeps the card's
	   geometry identical whether or not the cursor is on it.

	   It sits BELOW the manuscript block on purpose, same specificity and so source order
	   decides: that block hides the ring outright, and a cursor written up beside the other
	   ring rules would be invisible in the one style that draws no card. */
	.message-row-cursor .message-bubble-shell::before {
		display: block;
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	/* Brighter while the keyboard is actually ON the turn. Dimmed, the ring is a mark saying
	   where Alt+↑ comes back to, which is a different claim from "your keys land here" and
	   must not read as the same one. */
	.message-row-cursor:focus .message-bubble-shell::before {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 38%, transparent);
	}

	/* The row is as wide as the scrollport, so the browser's own ring around it would draw a
	   rectangle across the whole column with the card floating somewhere inside. The ring
	   above IS this row's focus ring, drawn where the turn actually is. */
	.message-row:focus {
		outline: none;
	}
</style>
