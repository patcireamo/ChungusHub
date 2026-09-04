/**
 * Chungus Assistant session store.
 *
 * Owns every assistant conversation: the persisted history, which sessions are open
 * as tabs, and the live streaming state of each. Streaming state is kept PER
 * SESSION (not per component) so a turn started in one tab keeps running while
 * the user works in another, like background browser tabs.
 *
 * Persistence: sessions + messages live in the database (so history survives a
 * refresh and syncs across devices); the open-tab set and active tab are saved
 * as device preferences in settings.
 */
import { db } from '$lib/services/database';
import { toastStore } from '$lib/stores/toast.svelte';
import {
	assistantStream,
	assistantApprove,
	assistantAnswer,
	assistantCancel,
	assistantStatus,
	onAssistantEvent,
	onReconnect,
	type AssistantEvent,
	type AssistantQuestionAnswer,
	type AssistantTurnError
} from '$lib/services/transport';
import { llmService } from '$lib/services/llm/provider';
import { DEFAULT_APPROVAL_MODE, readApprovalMode } from '$lib/config/assistant-approval';
import { applySessionSettings, isSessionSettingsStale } from '$lib/services/assistantSessionSettingsService';
import { deleteAssistantFile, listAssistantFiles, type AssistantFile } from '$lib/services/assistantFilesService';
import { SUGGESTED_PROMPTS_SETTING, readSuggestedPrompts } from '$lib/config/assistant-suggestions';
import { readSetting, registerSettingsReload, writeSetting } from '$lib/services/syncedSetting';
import { chatStore } from '$lib/stores/chat.svelte';
import { connectionStore } from '$lib/stores/connections.svelte';
import type { ApprovalMode, AssistantSession, AssistantMessage, AssistantSessionRuntime, AssistantAttachment } from '$lib/types/assistant';
import { attachmentKey } from '$lib/types/assistant';

const OPEN_TABS_KEY = 'assistantOpenTabs';
const ACTIVE_TAB_KEY = 'assistantActiveTab';
const APPROVAL_MODE_KEY = 'assistantApprovalMode';

function emptyRuntime(): AssistantSessionRuntime {
	return { busy: false, steps: [], iteration: 0, running: [], pending: null };
}

function deriveTitle(text: string): string {
	const firstLine = text.trim().split('\n')[0].trim();
	if (!firstLine) return 'New session';
	return firstLine.length > 48 ? firstLine.slice(0, 48).trimEnd() + '…' : firstLine;
}

class AssistantSessionStore {
	/** Every session, newest-updated first: the history list. */
	sessions = $state<AssistantSession[]>([]);
	/** Session ids currently open as tabs, in tab order. */
	openTabIds = $state<string[]>([]);
	/** The focused tab. */
	activeTabId = $state<string | null>(null);
	/** Loaded transcripts, keyed by session id. */
	messages = $state<Record<string, AssistantMessage[]>>({});
	/** Live turn state, keyed by session id. */
	runtime = $state<Record<string, AssistantSessionRuntime>>({});
	/**
	 * Sessions whose frozen Assistant settings differ from the live ones, keyed by id.
	 * A session freezes instructions / skills / image access at its first turn (they sit
	 * in the cached request prefix), so an edit made later does nothing to it until the
	 * user applies it. Refreshed on tab focus and whenever Assistant Settings closes, the
	 * only surfaces that change those three.
	 */
	settingsStale = $state<Record<string, boolean>>({});

	/**
	 * Per-tab context-bar state (memory only). `muted` holds the attachment keys the
	 * user toggled off (the mute belongs to the ITEM, so muting the session chip never
	 * silently mutes a later text selection); `manual` holds the items the user added
	 * by hand. The panel combines these with the live focus to render the chips.
	 */
	private attachUi = $state<Record<string, { muted: string[]; manual: AssistantAttachment[] }>>({});

	/**
	 * Per-tab composer state (draft text + staged image uploads). It lives HERE, not in
	 * the panel component, so minimizing the widget (which unmounts the panel) keeps
	 * a half-typed message and its uploads instead of silently destroying them.
	 */
	composer = $state<Record<string, { draft: string; images: { path: string; url: string }[] }>>({});

	/** The composer slot of one tab (created on first touch). */
	composerFor(sessionId: string): { draft: string; images: { path: string; url: string }[] } {
		this.composer[sessionId] ??= { draft: '', images: [] };
		return this.composer[sessionId];
	}

	/**
	 * Every file attached to a tab, sent and staged alike (assistantFilesService.ts). Unlike
	 * images, a file's whole state lives server-side (the composer stages a real row rather
	 * than a pending upload), so this is a mirror of the server's list, re-read whenever the
	 * transcript is.
	 */
	files = $state<Record<string, AssistantFile[]>>({});

	/** The files still staged in one tab's composer: uploaded, not yet sent. */
	stagedFiles(sessionId: string): AssistantFile[] {
		return (this.files[sessionId] ?? []).filter((f) => f.messageId === null);
	}

	/** The files that rode one user turn: the chips under its bubble. */
	filesOfMessage(sessionId: string, messageId: string): AssistantFile[] {
		return (this.files[sessionId] ?? []).filter((f) => f.messageId === messageId);
	}

	/** Adds a freshly uploaded file to the tab's list, staged. */
	addStagedFile(sessionId: string, file: AssistantFile): void {
		this.files[sessionId] = [...(this.files[sessionId] ?? []), file];
	}

	/** Throws away a staged file, server first: a failed delete leaves the chip where it
	 *  is rather than hiding a file the assistant would still be handed. */
	async discardStagedFile(sessionId: string, id: string): Promise<void> {
		await deleteAssistantFile(id);
		this.files[sessionId] = (this.files[sessionId] ?? []).filter((f) => f.id !== id);
	}

	/**
	 * How much each open tab wants to be asked before the assistant acts, keyed by session.
	 * Per TAB by design, and deliberately in memory only: a tab loosened for one long job
	 * falls back to the standing default on the next load, which is the safe direction to
	 * forget in. A running turn keeps the mode it was sent with.
	 */
	approvalModes = $state<Record<string, ApprovalMode>>({});
	/** The standing default a new tab is born with. It comes from Assistant Settings, read
	 *  at boot and re-read whenever that page writes it. */
	approvalDefault = $state<ApprovalMode>(DEFAULT_APPROVAL_MODE);

	/** This tab's mode, falling back to the standing default it was born with. */
	approvalMode(sessionId: string): ApprovalMode {
		return this.approvalModes[sessionId] ?? this.approvalDefault;
	}

	setApprovalMode(sessionId: string, mode: ApprovalMode): void {
		this.approvalModes = { ...this.approvalModes, [sessionId]: mode };
	}

	/** Re-reads the standing approval default from settings. A tab that has already been
	 *  switched by hand keeps its own mode. This only moves the default. */
	async refreshApprovalDefaults(): Promise<void> {
		this.approvalDefault = readApprovalMode(await db.getSetting(APPROVAL_MODE_KEY));
	}

	/** The empty screen's suggested prompts. Held here rather than read by the panel, because
	 *  Assistant Settings edits the same list on the same screen: one owner is what makes an
	 *  edit show up on the empty screen at once instead of at the next load. */
	suggestedPrompts = $state<string[]>([]);

	async refreshSuggestedPrompts(): Promise<void> {
		this.suggestedPrompts = readSuggestedPrompts(
			await readSetting<unknown>(SUGGESTED_PROMPTS_SETTING, null)
		);
	}

	/** The one writer: Assistant Settings. The list shows before the round trip, so the empty
	 *  screen behind the settings view is already right when the reader goes back to it. */
	async saveSuggestedPrompts(prompts: string[]): Promise<void> {
		this.suggestedPrompts = prompts;
		await writeSetting(SUGGESTED_PROMPTS_SETTING, prompts);
	}

	/**
	 * True while an OPEN tab is holding a card: the badge on the closed launcher and the mark
	 * in the tab strip. Scoped to open tabs on purpose: a badge has to point at something the
	 * user can actually answer, and a turn left waiting on a closed tab is reached by reopening
	 * it from history, which hands the card back through `assistantStatus`.
	 */
	get anyPendingAsk(): boolean {
		return this.openTabIds.some((id) => !!this.runtime[id]?.pending);
	}

	/**
	 * Answers the approval card `sessionId` is blocked on. Anything missing from `approved` is
	 * refused, so a partial answer is the normal case rather than a special one. The card is
	 * taken down here as well as by the server's settled event: the answer has left this
	 * device, and leaving the buttons live invites a second answer the server would ignore.
	 */
	async respondToApproval(sessionId: string, approved: number[]): Promise<void> {
		const pending = this.runtime[sessionId]?.pending;
		if (pending?.kind !== 'approval') return;
		try {
			await assistantApprove(sessionId, pending.askId, approved);
		} catch (e) {
			toastStore.failed('send your answer', e);
			return;
		}
		this.clearPending(sessionId, pending.askId);
	}

	/** The same, for a question card: the answers ride in the order they were asked, which is
	 *  how the server matches each one back to its question. */
	async answerQuestions(sessionId: string, answers: AssistantQuestionAnswer[]): Promise<void> {
		const pending = this.runtime[sessionId]?.pending;
		if (pending?.kind !== 'question') return;
		try {
			await assistantAnswer(sessionId, pending.askId, answers);
		} catch (e) {
			toastStore.failed('send your answer', e);
			return;
		}
		this.clearPending(sessionId, pending.askId);
	}

	/** Guarded by id so a slow round trip cannot take down the card that replaced this one. */
	private clearPending(sessionId: string, askId: string): void {
		const rt = this.runtime[sessionId];
		if (rt?.pending?.askId === askId) rt.pending = null;
	}

	/** AbortControllers for in-flight turns, kept off the reactive graph. */
	private aborts = new Map<string, AbortController>();
	private initialized = false;

	get activeSession(): AssistantSession | null {
		return this.sessions.find((s) => s.id === this.activeTabId) ?? null;
	}

	get activeMessages(): AssistantMessage[] {
		return this.activeTabId ? (this.messages[this.activeTabId] ?? []) : [];
	}

	get activeRuntime(): AssistantSessionRuntime {
		return (this.activeTabId && this.runtime[this.activeTabId]) || emptyRuntime();
	}

	/** True while ANY session is mid-turn. Drives the floating launcher's "working"
	 *  pulse when the panel is minimized. */
	get anyBusy(): boolean {
		return Object.values(this.runtime).some((r) => r.busy);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		this.sessions = await db.getAllAssistantSessions();

		const existing = new Set(this.sessions.map((s) => s.id));
		const savedTabs = await this.readJsonSetting<string[]>(OPEN_TABS_KEY, []);
		this.openTabIds = savedTabs.filter((id) => existing.has(id));

		const savedActive = await db.getSetting(ACTIVE_TAB_KEY);
		this.activeTabId =
			savedActive && this.openTabIds.includes(savedActive) ? savedActive : this.openTabIds[0] ?? null;

		await this.refreshApprovalDefaults();
		await this.refreshSuggestedPrompts();
		// Both live in the shared settings table and are read straight from it, so a change made
		// on another device has to reach this store: `syncReload` answers the `assistant` scope,
		// which a settings write does not broadcast.
		registerSettingsReload(async () => {
			await this.refreshApprovalDefaults();
			await this.refreshSuggestedPrompts();
		});
		await Promise.all(this.openTabIds.map((id) => this.loadMessages(id)));

		// Turns run on the SERVER, keyed by session. A reload, a second device or a network
		// blip never had a request of its own to listen on. One subscription here renders
		// every turn this workspace is running, whoever started it.
		onAssistantEvent((event) => this.applyEvent(event));
		// Hints broadcast while the socket was down are gone, and so are the deltas of any
		// turn that ran meanwhile: re-ask what is running on every reconnect. A failure here
		// means the socket dropped again. The next reconnect asks again, and until then a
		// tab keeps the busy state it had, which is the honest answer.
		onReconnect(() => {
			this.adoptRunningTurns(this.openTabIds).catch((e) =>
				console.error('[assistant] could not re-check running turns after reconnect:', e)
			);
		});
		await this.adoptRunningTurns(this.openTabIds);
	}

	/** Reload after a cross-device 'assistant' sync hint. */
	async syncReload(): Promise<void> {
		this.sessions = await db.getAllAssistantSessions();
		const existing = new Set(this.sessions.map((s) => s.id));
		this.openTabIds = this.openTabIds.filter((id) => existing.has(id));
		if (this.activeTabId && !existing.has(this.activeTabId)) {
			this.activeTabId = this.openTabIds[0] ?? null;
		}
		// Refresh the visible tab's transcript unless a turn started HERE is mid-flight: that
		// window holds local writes a db read would race (the optimistic user bubble, a
		// retry's row delete). A turn running elsewhere makes no local writes, so its tab
		// refreshes normally and picks up the user turn that started it.
		for (const id of this.openTabIds) {
			if (!this.aborts.has(id)) await this.loadMessages(id);
		}
	}

	private async loadMessages(sessionId: string): Promise<void> {
		const rows = await db.getAssistantMessages(sessionId);
		// A turn still marked running is being rendered LIVE from this session's runtime
		// slot; leaving it in the transcript too would draw the same turn twice. It joins
		// the transcript when the server finalizes it (or, after a server restart, as the
		// interrupted turn it became).
		this.messages[sessionId] = rows.filter((m) => m.status !== 'running');
		this.runtime[sessionId] ??= emptyRuntime();
		await this.loadFiles(sessionId);
	}

	/**
	 * The tab's attached files, read alongside its transcript.
	 *
	 * One list serves both surfaces: the chips under each user bubble (matched by
	 * `messageId`) and the ones still staged in the composer (`messageId` null). They are
	 * the same rows at two moments of their life, so a second source for either would let
	 * the composer show a file the transcript has already claimed.
	 */
	private async loadFiles(sessionId: string): Promise<void> {
		this.files[sessionId] = await listAssistantFiles(sessionId);
	}

	/**
	 * Asks the server which of these sessions have a turn running and takes over rendering
	 * them: the tab goes busy and shows the timeline as it stands, then the deltas that
	 * follow extend it, so a reload looks like nothing happened. A session with nothing
	 * running drops any stale busy state and re-reads its transcript, which is also what
	 * closes the race where a turn finishes between the boot read and this query.
	 */
	private async adoptRunningTurns(sessionIds: string[]): Promise<void> {
		if (!sessionIds.length) return;
		const running = await assistantStatus(sessionIds);
		// Adopt BEFORE any await: a delta arriving during a reload below must never be
		// overwritten by a snapshot taken before it.
		for (const turn of running) {
			// No running-tool row rides the snapshot: a call that has not returned is not a
			// step, so the server never records one. The next progress frame (one throttle
			// period away at most) draws it here. A pending CARD does ride it, and must: it is
			// not a delta that will be re-sent, so a page that reloaded mid-wait would otherwise
			// face a turn that looks hung with no way to answer it.
			this.runtime[turn.sessionId] = {
				busy: true,
				steps: turn.steps,
				iteration: turn.iteration,
				running: [],
				pending: turn.ask ?? null
			};
		}
		const live = new Set(running.map((t) => t.sessionId));
		for (const id of sessionIds) {
			if (live.has(id)) continue;
			if (this.runtime[id]?.busy) this.runtime[id] = emptyRuntime();
			await this.loadMessages(id);
		}
	}

	/**
	 * Folds one live event into a session's runtime slot: the same accumulation the server
	 * mirrors for its snapshot (server/index.ts recordLiveEvent), so a page that joins
	 * mid-turn and one that watched from the start end up with the same timeline.
	 * Events for a session with no screen here (not open, nothing running) are ignored.
	 */
	private applyEvent(event: AssistantEvent): void {
		const known = this.openTabIds.includes(event.sessionId) || !!this.runtime[event.sessionId]?.busy;
		if (!known) return;
		if (event.kind === 'settled') {
			// A turn started on THIS page settles through its own promise, which carries the
			// cases no event can (a pre-flight throw, a dropped socket), so leave it alone.
			if (this.aborts.has(event.sessionId)) return;
			this.runtime[event.sessionId] = emptyRuntime();
			this.absorbCommitted(event.sessionId, event.committed);
			return;
		}
		const rt = (this.runtime[event.sessionId] ??= emptyRuntime());
		// A turn this page did not start still makes its tab busy: the composer must refuse
		// a second turn the server would refuse anyway, and Stop has to be reachable.
		rt.busy = true;
		if (event.kind === 'iteration') {
			rt.iteration = event.iteration;
			// Call ordinals restart with each model step, so anything still marked running
			// belongs to the step that just ended: it was dispatched, refused, or skipped at
			// the action cap, and must not linger under the new step's calls.
			rt.running = [];
			return;
		}
		if (event.kind === 'tool-progress') {
			const row = rt.running.find((r) => r.index === event.index);
			// Only the text moves on a repeat frame: the row keeps its identity (and its DOM)
			// while the model writes into it, which is what keeps ~7 frames a second cheap.
			if (row) row.text = event.text;
			else {
				// Kept in call order rather than arrival order, so the oldest row really is the
				// one the next result finishes. The retirement below depends on it.
				rt.running.push({ index: event.index, name: event.name, text: event.text });
				rt.running.sort((a, b) => a.index - b.index);
			}
			return;
		}
		if (event.kind === 'tool-result') {
			// Results arrive in call order, so the oldest running row is the one this result
			// finishes: it hands its place to the step below instead of becoming a second row.
			rt.running.shift();
			rt.steps.push({ kind: 'tool', tool: event.result });
			return;
		}
		if (event.kind === 'ask') {
			rt.pending = event.ask;
			return;
		}
		if (event.kind === 'ask-settled') {
			// Answered here (already cleared), on another device, or the turn was stopped.
			// Either way the card is spent. Guarded by id so a late frame from an older card
			// cannot take down the one that replaced it.
			if (rt.pending?.askId === event.askId) rt.pending = null;
			return;
		}
		if (event.kind === 'attachments') {
			// The server resolved what actually rode with the user turn, so fold the truth onto
			// the bubble this page rendered optimistically (without chips). A transcript that
			// has not loaded the row yet simply reads it from the db, where the server wrote
			// the record before announcing it.
			const list = this.messages[event.sessionId];
			if (list?.some((m) => m.id === event.messageId)) {
				this.messages[event.sessionId] = list.map((m) =>
					m.id === event.messageId ? { ...m, ...(event.attachments.length ? { attachments: event.attachments } : {}) } : m
				);
			}
			return;
		}
		// Extend the trailing text/thinking step, or start a new one after a tool call:
		// this is what keeps reply text and tools in chronological order.
		const last = rt.steps[rt.steps.length - 1];
		const kind = event.kind === 'reply' ? 'text' : 'thinking';
		if (last && last.kind === kind) last.text += event.delta;
		else rt.steps.push({ kind, text: event.delta });
	}

	private async readJsonSetting<T>(key: string, fallback: T): Promise<T> {
		const raw = await db.getSetting(key);
		if (!raw) return fallback;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return fallback;
		}
	}

	private async persistTabs(): Promise<void> {
		await db.setSetting(OPEN_TABS_KEY, JSON.stringify(this.openTabIds));
		if (this.activeTabId) await db.setSetting(ACTIVE_TAB_KEY, this.activeTabId);
		else await db.deleteSetting(ACTIVE_TAB_KEY);
	}

	/** Opens a brand-new session in a fresh tab and focuses it. */
	async newSession(): Promise<string> {
		const now = Date.now();
		const session: AssistantSession = { id: crypto.randomUUID(), title: 'New session', createdAt: now, updatedAt: now };
		await db.insertAssistantSession(session);
		this.sessions = [session, ...this.sessions];
		this.messages[session.id] = [];
		this.runtime[session.id] = emptyRuntime();
		this.openTabIds = [...this.openTabIds, session.id];
		this.activeTabId = session.id;
		await this.persistTabs();
		return session.id;
	}

	/** Re-checks whether `sessionId` is running on out-of-date settings. Server-side
	 *  comparison: the client never holds the frozen snapshot. */
	async refreshSettingsDrift(sessionId: string): Promise<void> {
		const stale = await isSessionSettingsStale(sessionId);
		this.settingsStale = { ...this.settingsStale, [sessionId]: stale };
	}

	/** Re-freeze this session on the current settings. The next turn resends the whole
	 *  conversation at full price, which is the cost the button exists to make explicit. */
	async applySettings(sessionId: string): Promise<void> {
		await applySessionSettings(sessionId);
		this.settingsStale = { ...this.settingsStale, [sessionId]: false };
	}

	/** Opens an existing (history) session as a tab and focuses it. */
	async openSession(sessionId: string): Promise<void> {
		if (!this.openTabIds.includes(sessionId)) {
			this.openTabIds = [...this.openTabIds, sessionId];
			await this.loadMessages(sessionId);
			// The session may have a turn running (started before this page loaded, or on
			// another device), so pick it up live rather than opening onto a frozen transcript.
			await this.adoptRunningTurns([sessionId]);
		}
		this.activeTabId = sessionId;
		await this.persistTabs();
	}

	selectTab(sessionId: string): void {
		if (this.activeTabId === sessionId) return;
		this.activeTabId = sessionId;
		void this.persistTabs();
	}

	/** Closes a tab (keeps the session in history). Streaming turns keep running. */
	async closeTab(sessionId: string): Promise<void> {
		const idx = this.openTabIds.indexOf(sessionId);
		if (idx === -1) return;
		this.openTabIds = this.openTabIds.filter((id) => id !== sessionId);
		if (this.activeTabId === sessionId) {
			this.activeTabId = this.openTabIds[idx] ?? this.openTabIds[idx - 1] ?? this.openTabIds[0] ?? null;
		}
		await this.persistTabs();
	}

	/**
	 * Deletes a session, immediately and for good: the row, its transcript and its
	 * attachment files go in one server call. The asking happened BEFORE this, in the
	 * history list's confirm dialog (the destructive-act ladder,
	 * architecture/ui-shell-settings.md). A running turn is stopped first, session-level,
	 * so a turn this page merely adopted (started before a reload, or on another device)
	 * cannot run on against a deleted row.
	 */
	async deleteSession(sessionId: string): Promise<void> {
		const session = this.sessions.find((s) => s.id === sessionId);
		if (!session) return;

		this.stop(sessionId);
		// Server first: if the delete fails, nothing on screen has lied about it.
		try {
			await db.deleteAssistantSession(sessionId);
		} catch (e) {
			toastStore.failed(`delete "${session.title}"`, e);
			return;
		}

		const tabIndex = this.openTabIds.indexOf(sessionId);
		const wasActive = this.activeTabId === sessionId;
		this.sessions = this.sessions.filter((s) => s.id !== sessionId);
		this.openTabIds = this.openTabIds.filter((id) => id !== sessionId);
		if (wasActive) {
			this.activeTabId = this.openTabIds[Math.min(Math.max(tabIndex, 0), this.openTabIds.length - 1)] ?? null;
		}
		delete this.messages[sessionId];
		delete this.runtime[sessionId];
		delete this.attachUi[sessionId];
		delete this.composer[sessionId];
		await this.persistTabs();
	}

	async renameSession(sessionId: string, title: string): Promise<void> {
		const clean = title.trim() || 'New session';
		await db.updateAssistantSession({ id: sessionId, title: clean });
		this.bumpSession(sessionId, { title: clean });
	}

	private bumpSession(sessionId: string, patch: Partial<AssistantSession>): void {
		this.sessions = this.sessions
			.map((s) => (s.id === sessionId ? { ...s, ...patch } : s))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	stop(sessionId: string): void {
		const local = this.aborts.get(sessionId);
		if (local) {
			local.abort();
			return;
		}
		// No local request to abort: this page adopted a turn that started before its reload,
		// or on another device. Turns are session-keyed server-side, so the Stop still lands
		// and the turn answers with its usual stopped finish.
		assistantCancel(sessionId).catch((e) => {
			toastStore.failed('stop the turn', e);
		});
	}

	// ===== Context attachments =====

	private ensureAttachUi(sessionId: string): { muted: string[]; manual: AssistantAttachment[] } {
		this.attachUi[sessionId] ??= { muted: [], manual: [] };
		return this.attachUi[sessionId];
	}

	/** True when THIS auto-attached item (by key) is toggled off for this tab. */
	autoMuted(sessionId: string, key: string): boolean {
		return this.attachUi[sessionId]?.muted.includes(key) ?? false;
	}

	/** Items the user attached by hand on this tab. */
	manualAttachments(sessionId: string): AssistantAttachment[] {
		return this.attachUi[sessionId]?.manual ?? [];
	}

	/** Toggle whether one auto-attached item is sent. Its chip stays visible and
	 *  keeps mirroring the focused panel either way. Keyed per item, so a mute never
	 *  bleeds onto a different attachment that later fills the auto slot. */
	toggleAutoAttach(sessionId: string, key: string): void {
		const ui = this.ensureAttachUi(sessionId);
		ui.muted = ui.muted.includes(key) ? ui.muted.filter((k) => k !== key) : [...ui.muted, key];
	}

	/** Attach an item by hand (sent in full); no-op if already attached. */
	addAttachment(sessionId: string, att: AssistantAttachment): void {
		const key = attachmentKey(att);
		const ui = this.ensureAttachUi(sessionId);
		if (!ui.manual.some((a) => attachmentKey(a) === key)) ui.manual = [...ui.manual, att];
	}

	/** Remove a hand-added attachment. */
	removeAttachment(sessionId: string, att: AssistantAttachment): void {
		const key = attachmentKey(att);
		const ui = this.ensureAttachUi(sessionId);
		ui.manual = ui.manual.filter((a) => attachmentKey(a) !== key);
	}

	/**
	 * Synchronously claims the per-tab turn slot BEFORE any await. Two entry points
	 * racing (Retry clicked, Enter pressed within one roundtrip) must never both start.
	 * Setting `busy` deep inside runTurn instead, after several awaited RPCs, lets an
	 * overlap corrupt the shared runtime and leaves the surviving turn unstoppable.
	 */
	private claimTurn(sessionId: string): boolean {
		const rt = (this.runtime[sessionId] ??= emptyRuntime());
		if (rt.busy) return false;
		this.runtime[sessionId] = { ...emptyRuntime(), busy: true };
		return true;
	}

	/**
	 * Runs one assistant turn for `sessionId`. Persists the user message, then streams
	 * the reply into this session's runtime slot; the SERVER commits the turn's row.
	 * Safe to run concurrently across multiple sessions.
	 */
	async send(sessionId: string, text: string, attachments: AssistantAttachment[] = [], images: string[] = [], files: string[] = []): Promise<void> {
		const body = text.trim();
		if ((!body && !images.length && !files.length) || !this.claimTurn(sessionId)) return;

		// Minted out here because the turn request carries it: the server writes the resolved
		// attachment record onto exactly this row once the workspace note is built.
		const userMessageId = crypto.randomUUID();
		try {
			const session = this.sessions.find((s) => s.id === sessionId);
			const isFirst = (this.messages[sessionId]?.length ?? 0) === 0;

			const userMsg: Omit<AssistantMessage, 'createdAt'> = {
				id: userMessageId,
				sessionId,
				role: 'user',
				content: body,
				...(images.length ? { images } : {})
			};
			// Insert BEFORE the local push: a sync reload racing this window would replace
			// the array with a DB read that predates the row and eat the bubble. The row's
			// time comes back FROM the server: it is the key the transcript is ordered by,
			// and the reply to this message is stamped by that same clock, not this one.
			const createdAt = await db.insertAssistantMessage(userMsg);
			this.messages[sessionId] = [...(this.messages[sessionId] ?? []), { ...userMsg, createdAt }];

			// Name the session from its first prompt, and always bump activity on the row's own
			// stamp, so the history list is ordered by the same clock the turn will bump it with.
			const patch: Partial<AssistantSession> = { updatedAt: createdAt };
			if (isFirst && session && session.title === 'New session') patch.title = deriveTitle(body || 'Image');
			await db.updateAssistantSession({ id: sessionId, ...patch });
			this.bumpSession(sessionId, patch);

			// Hand-added chips are consumed by the send that carries them: what rode THIS
			// message (the server records how, on this very row) leaves the composer, and
			// sending the same item again is a deliberate re-add. Matched by key rather than
			// cleared wholesale, because Continue arrives here too with only the auto slot:
			// chips staged for the user's own next message must not vanish unsent under it.
			const sentKeys = new Set(attachments.map(attachmentKey));
			const ui = this.attachUi[sessionId];
			if (ui?.manual.some((m) => sentKeys.has(attachmentKey(m)))) {
				ui.manual = ui.manual.filter((m) => !sentKeys.has(attachmentKey(m)));
			}
		} catch (e) {
			if (sessionId in this.runtime) this.runtime[sessionId] = emptyRuntime();
			throw e;
		}

		// The server binds these rows to the user turn, so the local mirror says the same
		// thing at once. Otherwise the chips stay in the composer until the next reload.
		if (files.length) {
			this.files[sessionId] = (this.files[sessionId] ?? []).map((f) =>
				files.includes(f.id) && f.messageId === null ? { ...f, messageId: userMessageId } : f
			);
		}

		await this.runTurn(sessionId, body, attachments, false, images, userMessageId, files);
	}

	/** True when the tab's last turn failed and can be re-run. */
	canRetry(sessionId: string): boolean {
		const msgs = this.messages[sessionId] ?? [];
		const last = msgs[msgs.length - 1];
		return !!last && last.role === 'assistant' && !!last.error && !this.runtime[sessionId]?.busy;
	}

	/** True when the tab's last turn ended at the step/action budget with work possibly left. */
	canContinue(sessionId: string): boolean {
		const msgs = this.messages[sessionId] ?? [];
		const last = msgs[msgs.length - 1];
		return !!last && last.role === 'assistant' && !last.error && !!last.usage?.capped && !this.runtime[sessionId]?.busy;
	}

	/** One-click resume after a budget-capped turn: a normal user turn with a canned prompt. */
	async continueTurn(sessionId: string, attachments: AssistantAttachment[] = []): Promise<void> {
		if (!this.canContinue(sessionId)) return;
		await this.send(sessionId, 'Continue exactly where you left off. Do not redo completed work.', attachments);
	}

	/** The tab's current context occupancy (tokens), from the last completed turn. */
	contextTokens(sessionId: string): number | null {
		const msgs = this.messages[sessionId] ?? [];
		for (let i = msgs.length - 1; i >= 0; i -= 1) {
			const u = msgs[i].usage;
			if (msgs[i].role === 'assistant' && typeof u?.contextTokens === 'number' && u.contextTokens > 0) return u.contextTokens;
		}
		return null;
	}

	/** Re-runs the last (failed) turn without duplicating the user bubble; the
	 *  server continues the same context instead of appending the message again. */
	async retry(sessionId: string, attachments: AssistantAttachment[] = []): Promise<void> {
		if (!this.canRetry(sessionId) || !this.claimTurn(sessionId)) return;
		const msgs = this.messages[sessionId] ?? [];
		const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
		if (!lastUser) {
			this.runtime[sessionId] = emptyRuntime();
			return;
		}
		try {
			// Drop the failed turn's bubble before re-running. Otherwise a successful retry
			// leaves the old red error line (and its partial steps) stranded above the new reply.
			const failed = msgs[msgs.length - 1];
			if (failed?.role === 'assistant' && failed.error) {
				this.messages[sessionId] = msgs.slice(0, -1);
				await db.deleteAssistantMessage(failed.id);
			}
		} catch (e) {
			if (sessionId in this.runtime) this.runtime[sessionId] = emptyRuntime();
			throw e;
		}
		await this.runTurn(sessionId, lastUser.content, attachments, true, lastUser.images ?? [], lastUser.id);
	}

	private async runTurn(sessionId: string, body: string, attachments: AssistantAttachment[], retry: boolean, images: string[], userMessageId: string, files: string[] = []): Promise<void> {
		const controller = new AbortController();
		this.aborts.set(sessionId, controller);
		// The turn slot was claimed synchronously by the caller (claimTurn), never here.
		/** The socket dropped while the turn kept running server-side: the tab must stay busy. */
		let detached = false;

		try {
			// The assistant rides its assigned connection exactly like every other call:
			// sampling, context size, streaming and tuning all come from that connection's
			// own settings. Nothing about this turn is app-owned.
			const conn = connectionStore.connectionFor('assistant');
			if (!conn) throw new Error('No connection is assigned to the Assistant. Assign one in Settings → Connections.');
			const params = await llmService.resolveConnectionParams('assistant');
			const done = await assistantStream({
				connectionId: conn.id,
				provider: conn.provider,
				model: conn.model,
				assistantSessionId: sessionId,
				userMessageId,
				chatId: chatStore.activeChatId,
				userMessage: body,
				images,
				// Ids only: the rows are already stored, so this turn just binds them to its
				// user message. A retry passes none: those rows were bound the first time.
				files,
				// Resolved AFTER resolveConnectionParams so the model list is loaded and
				// the vision gate + tuning capabilities read real modalities, like the main chat.
				sendImages: llmService.sendsImages('assistant'),
				// The connection's declared context size budgets the persisted context
				// server-side (token trim + pre-flight fit check), the same number the
				// chat assembles against.
				contextSize: conn.contextSize,
				// Off = one non-streamed request per model step; the panel then shows each
				// step's reply and tool calls when they land instead of as they arrive.
				stream: conn.generation.streamResponses,
				// Per TAB, and deliberately not part of the frozen session settings: approval is
				// the app's business, so it reaches neither the system prompt nor the tool list.
				approvalMode: this.approvalMode(sessionId),
				retry,
				attachments: attachments.map((a) => ({ kind: a.kind, refId: a.refId, entryType: a.entryType, full: !!a.full, selection: a.selection })),
				params,
				// Reasoning effort / show-reasoning / verbosity for the assistant model, same as main chat.
				tuning: llmService.getGenerationTuning('assistant'),
				routing: llmService.routingFor('assistant'),
				signal: controller.signal
				// Streaming lands through the session-addressed event feed (applyEvent), not
				// through per-request callbacks: the deltas of this turn must reach a page that
				// reloaded and never issued this request.
			});
			// The SERVER committed the turn's row (steps, usage, capped, warnings), so adopt it.
			// Nothing is committed client-side for a finished turn any more, so a dropped
			// socket cannot lose a transcript the server already owns.
			this.absorbCommitted(sessionId, done.committed);
		} catch (e) {
			const err = e as AssistantTurnError;
			if (err?.detached) {
				// The socket dropped mid-turn. The turn keeps running server-side, so the tab
				// stays busy with the timeline it has: the reconnect's status query re-adopts
				// the live turn, or clears it if it finished meanwhile. Clearing here is what
				// made a running reply vanish from the screen.
				detached = true;
			} else if (err?.name === 'AbortError') {
				// Stop-grace expired without the server's final word (a dead socket). The turn
				// is over as far as this page knows; a reconnect corrects it either way.
			} else if (err?.committed) {
				// The turn failed but the server recorded it (partial steps + error).
				this.absorbCommitted(sessionId, err.committed);
			} else {
				// The turn never reached a server commit (client pre-flight throw, busy-lock
				// or duplicate-id refusal): record a local error bubble so the failure is
				// visible in the transcript and Retry has a target.
				await this.commitLocalError(sessionId, err);
			}
		} finally {
			this.aborts.delete(sessionId);
			if (!detached && sessionId in this.runtime) this.runtime[sessionId] = emptyRuntime();
		}
	}

	/** Adopts the server-committed turn row into the local transcript, deduping against
	 *  the sync reload its broadcast may already have delivered, and settles the live
	 *  runtime in the same tick, so the turn never renders twice during the handoff. */
	private absorbCommitted(sessionId: string, committed?: AssistantMessage): void {
		if (sessionId in this.runtime) this.runtime[sessionId] = emptyRuntime();
		if (!committed || !this.sessions.some((s) => s.id === sessionId)) return;
		const list = this.messages[sessionId] ?? [];
		if (list.some((m) => m.id === committed.id)) return;
		this.messages[sessionId] = [...list, committed];
		this.bumpSession(sessionId, { updatedAt: committed.createdAt });
	}

	/** A failure with no server-side row (pre-flight throw, lock refusal): persist a local
	 *  error bubble so the failure is visible and retryable. Best-effort by nature: if
	 *  even this insert fails, the error still reaches the console. */
	private async commitLocalError(sessionId: string, err: AssistantTurnError): Promise<void> {
		if (sessionId in this.runtime) this.runtime[sessionId] = emptyRuntime();
		if (!this.sessions.some((s) => s.id === sessionId)) return;
		const msg: Omit<AssistantMessage, 'createdAt'> = {
			id: crypto.randomUUID(),
			sessionId,
			role: 'assistant',
			content: '',
			error: err?.message || String(err),
			// A failed turn still grew the persisted context. Keep the reading so the
			// meter stays honest (the error event carries it when the loop got far enough).
			...(err?.contextTokens ? { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextTokens: err.contextTokens } } : {})
		};
		try {
			const createdAt = await db.insertAssistantMessage(msg);
			this.messages[sessionId] = [...(this.messages[sessionId] ?? []), { ...msg, createdAt }];
			await db.updateAssistantSession({ id: sessionId, updatedAt: createdAt });
			this.bumpSession(sessionId, { updatedAt: createdAt });
		} catch (persistError) {
			console.error('[assistant] failed to record a turn error:', persistError, 'original error:', err);
		}
	}

}

export const assistantSessionStore = new AssistantSessionStore();
