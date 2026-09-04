<script lang="ts">
	/**
	 * The Chungus Assistant panel: shell, tab bar, composer, and wiring. The heavy
	 * limbs live in their own components: AssistantTurnTimeline (turn rendering +
	 * navigate/diff), AssistantHistoryPopover (session history), AssistantAttachBar
	 * (context chips + picker + attach menu), AssistantContextMeter (window occupancy).
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import AssistantSettingsView from './AssistantSettingsView.svelte';
	import AssistantTurnTimeline from './AssistantTurnTimeline.svelte';
	import AssistantHistoryPopover from './AssistantHistoryPopover.svelte';
	import AssistantAttachBar from './AssistantAttachBar.svelte';
	import AssistantApprovalCard from './AssistantApprovalCard.svelte';
	import AssistantQuestionCard from './AssistantQuestionCard.svelte';
	import AssistantContextMeter from './AssistantContextMeter.svelte';
	import AssistantCostNotice from './AssistantCostNotice.svelte';
	import AssistantMascot from './AssistantMascot.svelte';
	import { autoResize } from '$lib/actions/autoResize';
	import { tick } from 'svelte';
	import { assistantSessionStore } from '$lib/stores/assistantSessions.svelte';
	import { generalSettingsStore } from '$lib/stores/general-settings.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { workspaceFocus } from '$lib/stores/workspaceFocus.svelte';
	import { chatSelection } from '$lib/stores/chatSelection.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { imageService, imageRejectionReason, isImageFile } from '$lib/services/imageService';
	import {
		fileRejectionReason,
		isDocumentPng,
		uploadAssistantFile,
		type AssistantFile
	} from '$lib/services/assistantFilesService';
	import AssistantFileViewer from './AssistantFileViewer.svelte';
	import { llmService } from '$lib/services/llm/provider';
	import { SUGGESTED_PROMPTS_COLLAPSED } from '$lib/config/assistant-suggestions';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { attachmentKey, type AssistantAttachment } from '$lib/types/assistant';

	let scrollEl = $state<HTMLElement | null>(null);
	let showHistory = $state(false);
	let showSettings = $state(false);
	let settingsButton: HTMLButtonElement | undefined = $state();
	let uploadingImages = $state(0);
	let uploadingFiles = $state(0);
	let composerEl: HTMLTextAreaElement | undefined = $state();
	/** The attached file open in the viewer, if any. */
	let viewingFile = $state<AssistantFile | null>(null);
	/** Depth-counted so a drag crossing a child element doesn't flicker the overlay off. */
	let dragDepth = $state(0);

	const store = assistantSessionStore;

	/** The one-time cost notice takes the whole panel until its Got it is pressed, so nothing
	 *  else of the assistant is on screen to read instead. Only that button writes the mark. */
	let costNotice = $derived(!generalSettingsStore.assistantCostSeen);

	let activeId = $derived(store.activeTabId);
	let messages = $derived(store.activeMessages);
	let runtime = $derived(store.activeRuntime);
	// Composer state (draft + staged uploads) lives in the STORE per session, so
	// minimizing the widget (which unmounts this panel) keeps a half-typed message
	// and its uploaded files instead of silently destroying them.
	let composer = $derived(activeId ? store.composer[activeId] : undefined);
	// With no session open yet the draft lives here, until the first send creates one:
	// typing must never require a "New session" click first.
	let orphanDraft = $state('');
	let draft = $derived(activeId ? (composer?.draft ?? '') : orphanDraft);
	let pendingImages = $derived(composer?.images ?? []);
	/** Files uploaded against this tab but not yet sent. Unlike an image these are real
	 *  server rows already, so the store mirrors the server's list rather than holding
	 *  pending uploads of its own. */
	let stagedFiles = $derived(activeId ? store.stagedFiles(activeId) : []);
	let canSend = $derived(
		(draft.trim().length > 0 || pendingImages.length > 0 || stagedFiles.length > 0) &&
			!runtime.busy &&
			!uploadingImages &&
			!uploadingFiles
	);
	// A running call draws a row only once it has text to show (AssistantTurnTimeline), so
	// this is the row count the scroll-follow below cares about.
	let liveToolRows = $derived(runtime.running.reduce((n, call) => n + (call.text ? 1 : 0), 0));

	// ===== Context attachments =====
	// One auto-attach slot, mirroring the focused panel live, in four rungs: a live
	// selection in the open chat wins, then the library entry open in the editor, then
	// the open lorebook, else the active chat. Sent as a pointer (read on demand). The
	// user can toggle it off without hiding it. Hand-added items are separate and sent
	// in full.
	let autoAttachment = $derived.by<AssistantAttachment | null>(() => {
		// 1) A live highlight in the open chat points the assistant at an exact spot. It wins,
		//    replacing the whole-chat pointer so the assistant looks exactly there.
		if (chatSelection.active && chatSelection.chatId === chatStore.activeChatId) {
			// A clipped text preview is useless in a narrow chip, so show a count instead: words
			// for a short pick on one line, lines once the highlight spans several.
			const lines = chatSelection.lineCount;
			const words = chatSelection.wordCount;
			const label =
				lines >= 2 ? `${lines} lines selected` : `${words} ${words === 1 ? 'word' : 'words'} selected`;
			return {
				kind: 'selection',
				refId: chatSelection.chatId!,
				label,
				selection: {
					anchorMessageId: chatSelection.anchorMessageId!,
					text: chatSelection.text,
					truncated: chatSelection.truncated,
					spanCount: chatSelection.spanCount
				}
			};
		}
		// 2) The library entry open in the editor.
		const entryId = workspaceFocus.entryId;
		if (entryId) {
			const entry = characterLibraryStore.entries.find((e) => e.id === entryId);
			if (entry) return { kind: 'entry', refId: entry.id, entryType: entry.type, label: entry.identity.name || 'Untitled' };
		}
		// 3) The lorebook open in the Lorebook view, the same "what is open in the editor"
		//    band as the entry. The entry outranks it: the two only coexist when a LOCKED
		//    Library dock keeps its editor while the overlay switches, and that editor
		//    renders on top of the overlay (Workspace.svelte), so the entry is what the
		//    user actually sees. Pointer only, like everything in this slot.
		const bookId = workspaceFocus.lorebookId;
		if (bookId) {
			const book = lorebookStore.books.find((b) => b.id === bookId);
			if (book) return { kind: 'lorebook', refId: book.id, label: book.name.trim() || 'Untitled lorebook' };
		}
		// 4) The active chat as a whole.
		const chat = chatStore.activeChat;
		if (chat) return { kind: 'chat', refId: chat.id, label: chat.title };
		return null;
	});

	let autoOff = $derived(activeId && autoAttachment ? store.autoMuted(activeId, attachmentKey(autoAttachment)) : false);
	let manualAttachments = $derived(activeId ? store.manualAttachments(activeId) : []);

	// What a send carries: the enabled auto item (a pointer) + hand-added items (asking for
	// full: the server resolves what each actually gets and stamps it on the message).
	let autoSend = $derived.by<AssistantAttachment[]>(() =>
		autoAttachment && !autoOff ? [{ ...autoAttachment, full: false }] : []
	);
	let attachments = $derived.by<AssistantAttachment[]>(() => [
		...autoSend,
		...manualAttachments.map((m) => ({ ...m, full: true }))
	]);

	function toggleAuto() {
		if (activeId && autoAttachment) store.toggleAutoAttach(activeId, attachmentKey(autoAttachment));
	}

	function removeManual(att: AssistantAttachment) {
		if (activeId) store.removeAttachment(activeId, att);
	}

	function addAttachment(att: AssistantAttachment) {
		if (activeId) store.addAttachment(activeId, att);
	}

	// ===== Scroll follow =====
	const NEAR_BOTTOM_PX = 120;
	let nearBottom = true;
	let lastScrollTop = 0;
	// Guards a programmatic snap so the scroll event it fires isn't read as user intent.
	let programmaticScroll = false;

	function onMessagesScroll() {
		if (!scrollEl) return;
		const st = scrollEl.scrollTop;
		const dist = scrollEl.scrollHeight - st - scrollEl.clientHeight;
		if (programmaticScroll) {
			programmaticScroll = false;
		} else if (st < lastScrollTop - 1) {
			// A deliberate scroll-up releases the follow immediately: streaming must not
			// keep yanking the view back down while the user reads earlier output.
			nearBottom = false;
		} else {
			nearBottom = dist <= NEAR_BOTTOM_PX;
		}
		lastScrollTop = st;
	}

	async function scrollToBottom() {
		await tick();
		if (!scrollEl || !nearBottom) return;
		// Clamped: a session shorter than the panel has a negative overflow, and a write the
		// browser clamps back to 0 is exactly the no-op the guard must not be armed for.
		const top = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
		// Already there, and a write that moves nothing fires no scroll event, so arming the
		// guard for it leaves it armed. It then swallows the user's first real scroll-up, the
		// follow reads them as still pinned, and the next frame drags them back down.
		if (Math.abs(scrollEl.scrollTop - top) < 1) return;
		programmaticScroll = true;
		scrollEl.scrollTop = top;
		lastScrollTop = scrollEl.scrollTop;
	}

	// One owner for where this scroller sits: a new tab opens at its latest, and everything
	// the active turn adds is followed to the bottom, but only while the user is still
	// pinned near the bottom (nearBottom), so scrolling up sticks.
	let prevActiveId: string | null = null;
	let prevBusy = false;
	$effect(() => {
		const id = activeId;
		const busy = runtime.busy;
		void messages.length;
		void runtime.steps.length;
		// Only the COUNT of running-tool rows that actually render: each has a fixed
		// footprint, so the text streaming through them never moves the content and must not
		// drag the scroller onto the ~7-frames-a-second path. The derived recomputes on every
		// frame but only CHANGES when a row appears, which is the moment worth following.
		void liveToolRows;
		// Reply AND reasoning text: an opened thinking block fills exactly like a reply does,
		// and a follow blind to it sits still while the text scrolls off the bottom.
		for (const s of runtime.steps) if (s.kind !== 'tool') void s.text.length;

		const switchedTab = id !== prevActiveId;
		// A settling turn swaps the live timeline for the persisted one in a single tick, so
		// nobody needs moving for it: a pinned reader is already at the bottom, and one who
		// scrolled up to read must not be thrown to the end by the turn's last frame.
		const settled = !switchedTab && prevBusy && !busy;
		prevActiveId = id;
		prevBusy = busy;

		if (switchedTab) nearBottom = true;
		if (!settled) scrollToBottom();
	});

	// ===== Image attachments =====

	async function attachImageFiles(files: File[]): Promise<void> {
		const images: File[] = [];
		for (const file of files) {
			const refused = imageRejectionReason(file);
			if (refused) toastStore.error(refused);
			else images.push(file);
		}
		if (!images.length) return;
		// Attaching is always possible; whether the images actually reach the assistant
		// depends on its provider/model + the Send images setting, so say so up front
		// instead of silently dropping them at request time.
		if (!llmService.sendsImages('assistant')) {
			toastStore.warning(
				'The assistant model does not take images, or sending images is off. The picture stays in the transcript but never reaches the assistant.'
			);
		}
		// Pin the session at entry: a slow upload must land in the tab it started on,
		// not whichever tab is active when it finishes. Attaching with no session open
		// starts one, the same lazy contract as send().
		const sessionId = activeId ?? (await store.newSession());
		uploadingImages += images.length;
		for (const file of images) {
			try {
				const path = await imageService.saveImage(file, 'chat');
				const url = imageService.thumbnailUrl(path) ?? '';
				const slot = store.composerFor(sessionId);
				slot.images = [...slot.images, { path, url }];
			} catch (error) {
				toastStore.failed(`attach "${file.name}"`, error);
			} finally {
				uploadingImages -= 1;
			}
		}
	}

	function handlePaste(e: ClipboardEvent) {
		const files = Array.from(e.clipboardData?.files ?? []).filter(isImageFile);
		if (files.length) {
			e.preventDefault();
			void attachImageFiles(files);
		}
	}

	// ===== File attachments =====

	/**
	 * Uploads reference files against this tab. Nothing is decided here about what a file IS
	 * (recognition is structural and server-side), so this only refuses what must be refused
	 * before a spinner starts, and shows the server's own wording for everything else.
	 */
	async function attachDocuments(files: File[]): Promise<void> {
		const usable: File[] = [];
		for (const file of files) {
			const refused = fileRejectionReason(file);
			if (refused) toastStore.error(refused);
			else usable.push(file);
		}
		if (!usable.length) return;
		// Pinned at entry like an image upload: a slow one must land in the tab it started on.
		const sessionId = activeId ?? (await store.newSession());
		uploadingFiles += usable.length;
		for (const file of usable) {
			try {
				store.addStagedFile(sessionId, await uploadAssistantFile(sessionId, file));
			} catch (error) {
				toastStore.failed(`attach "${file.name}"`, error);
			} finally {
				uploadingFiles -= 1;
			}
		}
	}

	/** Throws away a staged file, bytes and all. Only reachable before the send. */
	async function discardFile(id: string): Promise<void> {
		if (!activeId) return;
		try {
			await store.discardStagedFile(activeId, id);
		} catch (error) {
			toastStore.failed('remove this file', error);
		}
	}

	/**
	 * Splits a drop into the two paths. A PNG is the one ambiguous case and MIME type cannot
	 * settle it: a character card is a real picture carrying a document, so the bytes are
	 * read for a card chunk and only a plain picture goes to the image path. Getting this
	 * wrong would make the likeliest file of all unattachable by the gesture built for it.
	 */
	async function routeDropped(files: File[]): Promise<void> {
		const images: File[] = [];
		const documents: File[] = [];
		for (const file of files) {
			if (!isImageFile(file)) {
				documents.push(file);
				continue;
			}
			if (file.type === 'image/png' && isDocumentPng(new Uint8Array(await file.arrayBuffer()))) documents.push(file);
			else images.push(file);
		}
		if (images.length) await attachImageFiles(images);
		if (documents.length) await attachDocuments(documents);
	}

	function handleDragEnter(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		dragDepth += 1;
	}

	function handleDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		// Without this the browser navigates away to the dropped file.
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
	}

	function handleDragLeave() {
		dragDepth = Math.max(0, dragDepth - 1);
	}

	function handleDrop(e: DragEvent) {
		const files = Array.from(e.dataTransfer?.files ?? []);
		dragDepth = 0;
		if (!files.length) return;
		e.preventDefault();
		void routeDropped(files);
	}

	function removePendingImage(path: string) {
		if (!activeId) return;
		const slot = store.composerFor(activeId);
		slot.images = slot.images.filter((img) => img.path !== path);
		// The upload is already on the server; drop the file too so abandoned
		// attachments don't pile up in images/chat/.
		void imageService.deleteImage(path);
	}

	async function send() {
		const text = draft.trim();
		if (!canSend) return;
		// The first send with no session open creates one on the fly.
		let sessionId = activeId;
		if (!sessionId) {
			sessionId = await store.newSession();
			orphanDraft = '';
		}
		const images = pendingImages.map((img) => img.path);
		// Read before the store rebinds them to this turn: after that they are no longer staged.
		const files = store.stagedFiles(sessionId).map((f) => f.id);
		const slot = store.composerFor(sessionId);
		slot.draft = '';
		slot.images = [];
		await store.send(sessionId, text, attachments, images, files);
	}

	// Tappable prompts that fill the composer, the user's own list where they wrote one
	// (Assistant Settings → Suggested Prompts) and the shipped set otherwise. Collapsed it
	// shows the first few; expanded, the list scrolls inside its own box and nothing else on
	// the screen moves.
	let suggestions = $derived(store.suggestedPrompts);
	let suggestionsOpen = $state(false);
	let visibleSuggestions = $derived(
		suggestionsOpen ? suggestions : suggestions.slice(0, SUGGESTED_PROMPTS_COLLAPSED)
	);

	function useExample(text: string) {
		if (activeId) store.composerFor(activeId).draft = text;
		else orphanDraft = text;
		composerEl?.focus();
	}

	function stop() {
		if (activeId) store.stop(activeId);
	}

	function openSettings(): void {
		showHistory = false;
		showSettings = true;
	}

	async function closeSettings(): Promise<void> {
		showSettings = false;
		// Instructions, skills and permissions are frozen per session; this view is the
		// only place they change, so leaving it is when a session can become stale.
		if (activeId) void store.refreshSettingsDrift(activeId);
		await tick();
		settingsButton?.focus();
	}

	// The focused tab's freeze can also be stale from a change made before it was opened
	// (or on another device), so re-check on focus as well.
	$effect(() => {
		const id = activeId;
		if (id) void store.refreshSettingsDrift(id);
	});

	let settingsStale = $derived(activeId ? store.settingsStale[activeId] === true : false);
	let applyingSettings = $state(false);

	async function applySettings(): Promise<void> {
		if (!activeId || applyingSettings) return;
		applyingSettings = true;
		try {
			await store.applySettings(activeId);
			toastStore.success('Settings applied to this session');
		} catch (e) {
			toastStore.failed('apply the settings', e);
		} finally {
			applyingSettings = false;
		}
	}

	async function newSession() {
		showHistory = false;
		await store.newSession();
		await scrollToBottom();
	}

	function tabTitle(id: string): string {
		return store.sessions.find((s) => s.id === id)?.title ?? 'Session';
	}

	/** A stopped tab says WHAT it is stopped on: approving a call and answering a question are
	 *  different jobs, and a tab that named neither would send the user hunting. */
	function waitingTitle(id: string): string {
		const pending = store.runtime[id]?.pending;
		if (!pending) return tabTitle(id);
		return `${tabTitle(id)} · waiting for your ${pending.kind === 'question' ? 'answer' : 'approval'}`;
	}

	// A wheel over the tab strip scrolls it sideways: the strip only overflows
	// horizontally, so a plain vertical turn (the only gesture a mouse has) would
	// otherwise do nothing at all here. A trackpad's sideways swipe arrives as
	// deltaX and is left to the browser.
	function handleTabsWheel(e: WheelEvent): void {
		const el = e.currentTarget as HTMLElement;
		if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
		e.preventDefault();
		const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
		el.scrollLeft += e.deltaY * factor;
	}

	// On touch devices there is no Shift key, so Enter must insert a newline and
	// sending is done with the send button, the chat composer's exact contract.
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !viewport.isTouch) {
			e.preventDefault();
			send();
		}
	}
</script>

<!-- The whole panel is the drop target, not just the composer: a dropped file is aimed at
     the assistant, and a strip at the bottom is a target you have to find. Images and files
     both land here and are told apart by their content. -->
<div
	class="assistant-shell"
	ondragenter={handleDragEnter}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
	role="presentation"
>
	{#if dragDepth > 0 && !showSettings && !costNotice}
		<div class="assistant-drop">
			<Icon name="document" class="w-6 h-6" />
			<span>Drop to attach. Pictures are looked at, files are read.</span>
		</div>
	{/if}
	{#if costNotice}
		<!-- Outranks everything, the gear included: the panel says what it costs before it
		     hands over anything to spend it with. -->
		<AssistantCostNotice />
	{:else if showSettings}
		<AssistantSettingsView onClose={closeSettings} />
	{:else}
	<header class="assistant-tabbar">
		<div class="assistant-tabs" onwheel={handleTabsWheel}>
			{#each store.openTabIds as id (id)}
				<div class="assistant-tab" class:assistant-tab--active={id === activeId}>
					<button
						type="button"
						class="assistant-tab-label"
						onclick={() => store.selectTab(id)}
						title={waitingTitle(id)}
					>
						{#if store.runtime[id]?.pending}
							<!-- A tab stopped on a card is not working, it is waiting: the busy pulse would
							     say the opposite and the user would leave it sitting there. -->
							<Icon
								name={store.runtime[id]?.pending?.kind === 'question' ? 'annotation' : 'shield'}
								class="w-3.5 h-3.5 shrink-0 assistant-tab-waiting"
							/>
						{:else if store.runtime[id]?.busy}
							<span class="assistant-dot assistant-dot--tab"></span>
						{:else}
							<AssistantMascot size={16} />
						{/if}
						<span class="assistant-tab-text">{tabTitle(id)}</span>
					</button>
					<button type="button" class="assistant-tab-close" onclick={() => store.closeTab(id)} aria-label="Close tab">
						<Icon name="x" class="w-3 h-3" />
					</button>
				</div>
			{/each}
		</div>
		<div class="assistant-tabbar-actions">
			<button type="button" class="assistant-icon-btn" onclick={newSession} aria-label="New assistant session" title="New session">
				<Icon name="plus" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="assistant-icon-btn"
				class:assistant-icon-btn--active={showHistory}
				data-history-toggle
				onclick={() => (showHistory = !showHistory)}
				aria-label="Session history"
				title="History"
			>
				<Icon name="chevronDown" class="w-4 h-4" />
			</button>
			<button bind:this={settingsButton} type="button" class="assistant-icon-btn" onclick={openSettings} aria-label="Assistant settings" title="Assistant settings">
				<Icon name="settings" class="w-4 h-4" />
			</button>
		</div>
	</header>

	{#if showHistory}
		<AssistantHistoryPopover onClose={() => (showHistory = false)} onNewSession={newSession} />
	{/if}

	<div class="assistant-messages panel-scroll" bind:this={scrollEl} onscroll={onMessagesScroll}>
		{#if !activeId || (messages.length === 0 && !runtime.busy)}
			<div class="assistant-empty">
				<AssistantMascot size={44} />
				<p class="assistant-empty-title">Chungus Assistant</p>
				<p class="assistant-empty-hint">Reads and edits your characters, chats, and lorebooks.</p>
				{#if suggestions.length > 0}
					<!-- Unkeyed on purpose: nothing dedupes the stored list, and two rows holding the
					     same text is the user's business, not a crash. The button that opens the list
					     stays outside it, so scrolling the rows never carries it out of reach. -->
					<div class="assistant-empty-examples">
						{#each visibleSuggestions as example}
							<button type="button" class="assistant-empty-example" onclick={() => useExample(example)}>
								{example}
							</button>
						{/each}
					</div>
					{#if suggestions.length > SUGGESTED_PROMPTS_COLLAPSED}
						<button
							type="button"
							class="assistant-empty-more"
							aria-expanded={suggestionsOpen}
							onclick={() => (suggestionsOpen = !suggestionsOpen)}
						>
							<Icon name={suggestionsOpen ? 'chevronUp' : 'chevronDown'} class="w-3.5 h-3.5" />
							<span>{suggestionsOpen ? 'Show less' : 'Show more'}</span>
						</button>
					{/if}
				{/if}
			</div>
		{:else}
			<!-- Retry re-runs a message that was already sent, and Continue sends a canned line
			     the user never composed: hand-added chips belong to the user's OWN next message,
			     so neither consumes them: only the auto pointer (what is open now) rides. -->
			<AssistantTurnTimeline
				{messages}
				{runtime}
				{activeId}
				onRetry={() => activeId && store.retry(activeId, autoSend)}
				onContinue={() => activeId && store.continueTurn(activeId, autoSend)}
				onOpenFile={(file) => (viewingFile = file)}
			/>
		{/if}
	</div>

	<div class="assistant-input">
		{#if settingsStale}
			<div class="assistant-settings-drift">
				<Icon name="settings" class="w-3.5 h-3.5 shrink-0" />
				<span class="assistant-settings-drift-text">
					Assistant settings changed since this session started, so it still runs on the old ones.
				</span>
				<button type="button" onclick={applySettings} disabled={applyingSettings} title="Resends this conversation once, so the turn costs more than usual">
					{applyingSettings ? 'Applying…' : 'Apply'}
				</button>
			</div>
		{/if}

		<AssistantContextMeter onNewTab={newSession} />

		{#if runtime.pending}
			<!-- Keyed on the card's id: the next card of the same turn arrives as a fresh
			     component, so no decision leaks from one model step into the next. -->
			{#key runtime.pending.askId}
				{#if runtime.pending.kind === 'approval'}
					<AssistantApprovalCard
						calls={runtime.pending.calls}
						onRespond={(approved) => activeId && void store.respondToApproval(activeId, approved)}
					/>
				{:else}
					<AssistantQuestionCard
						questions={runtime.pending.questions}
						onRespond={(answers) => activeId && void store.answerQuestions(activeId, answers)}
					/>
				{/if}
			{/key}
		{/if}

		{#if pendingImages.length || uploadingImages > 0}
			<div class="assistant-pending-images">
				{#each pendingImages as img (img.path)}
					<div class="assistant-pending-thumb">
						<img src={img.url} alt="Attached" />
						<button
							type="button"
							class="assistant-pending-remove"
							onclick={() => removePendingImage(img.path)}
							aria-label="Remove image"
							title="Remove"
						>
							<Icon name="x" class="w-3 h-3" strokeWidth={2.5} />
						</button>
					</div>
				{/each}
				{#if uploadingImages > 0}
					<div class="assistant-pending-thumb assistant-pending-uploading" title="Uploading…">
						<Icon name="refresh" class="w-4 h-4 animate-spin text-text-muted" />
					</div>
				{/if}
			</div>
		{/if}

		<div class="assistant-input-row">
			<!-- The draft lives in the store, so every change that isn't a keystroke (a send
			     clearing it, an example filling it, switching tabs) reaches the field without an
			     `input` event: `value` is what makes those re-measure. No grip either: this box is
			     anchored to the panel's bottom edge (see `autoResize`), and one drag would latch a
			     manual height that no later measurement could undo. -->
			<textarea
				bind:this={composerEl}
				use:autoResize={{ maxHeight: 160, value: draft, grip: false }}
				value={draft}
				oninput={(e) => {
					if (activeId) store.composerFor(activeId).draft = e.currentTarget.value;
					else orphanDraft = e.currentTarget.value;
				}}
				onkeydown={handleKeydown}
				onpaste={handlePaste}
				rows="1"
				placeholder="Message the Chungus Assistant…"
				aria-label="Message the Chungus Assistant"
				class="assistant-textarea"
			></textarea>
			{#if runtime.busy}
				<button type="button" class="assistant-send assistant-stop" onclick={stop} aria-label="Stop the assistant">
					<Icon name="close" class="w-4 h-4" />
				</button>
			{:else}
				<button type="button" class="assistant-send" disabled={!canSend} onclick={send} aria-label="Send message">
					<Icon name="arrowRight" class="w-4 h-4" />
				</button>
			{/if}
		</div>

		{#if activeId}
			<AssistantAttachBar
				{autoAttachment}
				{autoOff}
				{manualAttachments}
				{stagedFiles}
				busy={runtime.busy}
				approvalMode={store.approvalMode(activeId)}
				onToggleAuto={toggleAuto}
				onAdd={addAttachment}
				onRemoveManual={removeManual}
				onFiles={(files) => void attachImageFiles(files)}
				onDocuments={(files) => void attachDocuments(files)}
				onRemoveFile={(id) => void discardFile(id)}
				onOpenFile={(file) => (viewingFile = file)}
				onApprovalMode={(mode) => activeId && store.setApprovalMode(activeId, mode)}
			/>
		{/if}
	</div>
	{/if}
</div>

<!-- Outside the shell: the viewer is a Dialog, and one portalled from inside a panel with a
     backdrop-filter would be trapped by it (the same reason the diff modal sits here). -->
<AssistantFileViewer file={viewingFile} onClose={() => (viewingFile = null)} />

<style>
	/* Over everything in the panel while a drag is on it, and never interactive: the drop is
	   handled by the shell underneath, so this must not become the event target. */
	.assistant-drop {
		position: absolute;
		inset: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		pointer-events: none;
		border: 2px dashed var(--color-accent);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-solid) 88%, transparent);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-text-muted);
		text-align: center;
		padding: 1rem;
	}

	.assistant-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		/* Transparent so the frosted dock / overlay with ambient behind shows through. */
		background: transparent;
		position: relative;
	}

	/* ===== Tab bar ===== */
	.assistant-tabbar {
		/* The tab strip scrolls horizontally and the bar is a classic one drawn
		   inside the strip's own box, so it needs a band reserved under the tabs
		   or it lands on them: the box's auto height counts the tabs and not the
		   bar. Both children reserve the same band: on the strip alone it would
		   push the tabs half a band off the action buttons beside them. Sized for
		   `thin` (app.css), which tops out near 11px in either engine. */
		--assistant-tabbar-scrollbar: 0.7rem;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.assistant-tabs {
		display: flex;
		/* Top, not centre: the bar takes its band out of the content box, and
		   centring would slide the tabs up by half of it the moment it appears. */
		align-items: flex-start;
		gap: 0.3rem;
		overflow-x: auto;
		flex: 1;
		min-width: 0;
		padding-bottom: var(--assistant-tabbar-scrollbar);
	}

	.assistant-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.15rem;
		padding: 0.25rem 0.3rem 0.25rem 0.5rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
		max-width: 7.5rem;
		flex-shrink: 0;
	}

	.assistant-tab--active {
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 38%, transparent);
	}

	.assistant-tab-label {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0;
		color: var(--color-text-primary);
	}

	.assistant-tab-text {
		font-family: var(--font-ui);
		font-size: 0.74rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 4.5rem;
	}

	.assistant-tab-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: var(--radius-sm);
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.assistant-tab-close:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
		color: var(--color-text-primary);
	}

	.assistant-tabbar-actions {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		flex-shrink: 0;
		padding-bottom: var(--assistant-tabbar-scrollbar);
	}

	.assistant-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.8rem;
		height: 1.8rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: background-color 120ms ease;
	}

	.assistant-icon-btn:hover,
	.assistant-icon-btn--active {
		background: color-mix(in srgb, var(--color-accent) 16%, transparent);
		color: var(--color-text-primary);
	}

	/* A tab holding a card: accented and still, the opposite of the busy pulse beside it. */
	.assistant-tab-label :global(svg.assistant-tab-waiting) {
		color: var(--color-accent);
	}

	/* The tab's busy pulse (the timeline has its own copy for the thinking line). */
	.assistant-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-full);
		background: var(--color-accent);
		animation: assistant-pulse 1s ease-in-out infinite;
	}

	.assistant-dot--tab {
		width: 0.45rem;
		height: 0.45rem;
		flex-shrink: 0;
	}

	@keyframes assistant-pulse {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 1; }
	}

	/* ===== Messages ===== */
	.assistant-messages {
		flex: 1;
		min-height: 0;
		padding: clamp(0.65rem, 0.5rem + 0.75vw, 1rem);
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	/* Auto margins centre it while there is room and resolve to zero once there is not, so a
	   long list squeezes the block to the panel instead of pushing past it. `min-height: 0`
	   is what lets that squeeze happen; the suggestion list is the only part that gives. */
	.assistant-empty {
		margin: auto;
		min-height: 0;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		padding: 2rem 1rem;
	}

	/* The mascot: a foreign element, so it needs the scoping escape to be pinned. */
	.assistant-empty > :global(svg) {
		flex-shrink: 0;
	}

	.assistant-empty-title {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.assistant-empty-hint {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		color: var(--color-text-muted);
		opacity: 0.8;
	}

	/* The one part that gives: it scrolls on its own rather than growing the empty screen,
	   so expanding a long list moves the suggestions and nothing else. */
	.assistant-empty-examples {
		margin-top: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		width: 100%;
		max-width: 21rem;
		/* About ten rows. Expanded, the list is a box on the empty screen rather than the
		   whole of it, and anything past that is reached inside the box. The smaller of this
		   and the room the panel has left is what the list gets. */
		max-height: 23rem;
		min-height: 0;
		overflow-y: auto;
		/* The rows are inset from both edges instead of the track being reserved (.panel-scroll,
		   scrollbar-gutter). Where the OS hides scrollbars until they are used, the bar is an
		   OVERLAY: it reserves nothing, gutters do nothing, and it paints straight over the last
		   row. Padding is the one inset both kinds of bar respect, and equal on both edges keeps
		   the box on the centre line the mascot and the title share. */
		padding: 0 0.65rem;
		overscroll-behavior: contain;
	}

	.assistant-empty-example {
		/* Without this the rows compress to fit the scroller and it never scrolls at all. */
		flex-shrink: 0;
		text-align: left;
		padding: 0.45rem 0.7rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		line-height: 1.35;
		cursor: pointer;
		transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
	}

	.assistant-empty-example:hover {
		border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		color: var(--color-text-primary);
	}

	/* The resting pill the home screen opens its recent chats with, and narrower than the
	   rows it reveals so it reads as the list's handle rather than another suggestion. It
	   sits outside the scroller, so it stays put however far the list is scrolled. */
	.assistant-empty-more {
		flex-shrink: 0;
		align-self: center;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.35rem;
		padding: 0.3rem 0.8rem;
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
	}

	.assistant-empty-more:hover {
		color: var(--color-text-primary);
		border-color: var(--color-border);
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
	}

	/* ===== Input ===== */
	.assistant-input {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: clamp(0.55rem, 0.45rem + 0.5vw, 0.85rem);
		border-top: 1px solid var(--color-border-subtle);
	}

	/* Shown only while the session's frozen settings actually differ from the live ones,
	   so it costs no room in the normal case. */
	.assistant-settings-drift {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
		background: var(--color-bg-tertiary);
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		line-height: 1.3;
	}

	.assistant-settings-drift-text {
		flex: 1;
		min-width: 0;
	}

	.assistant-settings-drift button {
		flex-shrink: 0;
		padding: 0.2rem 0.5rem;
		border-radius: var(--radius-sm);
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		cursor: pointer;
	}

	.assistant-settings-drift button:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.assistant-input-row {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
	}

	/* ===== Image attachments (staged uploads) ===== */
	.assistant-pending-images {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.assistant-pending-thumb {
		position: relative;
		width: 3rem;
		height: 3rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 80%, transparent);
		overflow: hidden;
		background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
	}

	.assistant-pending-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.assistant-pending-uploading {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.assistant-pending-remove {
		position: absolute;
		top: 2px;
		right: 2px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border: none;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-bg-primary) 75%, transparent);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.assistant-pending-remove:hover {
		background: var(--color-bg-primary);
	}

	.assistant-textarea {
		flex: 1;
		min-height: 2.4rem;
		max-height: 160px;
		padding: 0.55rem 0.72rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-input-bg);
		color: var(--color-text-primary);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		line-height: 1.45;
		resize: none;
	}

	.assistant-textarea::placeholder {
		color: var(--color-text-muted);
	}

	.assistant-textarea:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 22%, transparent);
	}

	.assistant-send {
		flex-shrink: 0;
		width: 2.4rem;
		height: 2.4rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-accent) 80%, black 20%);
		background: var(--color-accent);
		color: var(--color-on-accent);
		cursor: pointer;
		transition: background-color 140ms ease, opacity 140ms ease;
	}

	.assistant-send:hover:not(:disabled) {
		background: var(--color-accent-hover);
	}

	.assistant-send:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.assistant-stop {
		background: var(--color-error);
		border-color: color-mix(in srgb, var(--color-error) 80%, black 20%);
	}

	.assistant-stop:hover {
		background: color-mix(in srgb, var(--color-error) 88%, black 12%);
	}
</style>
