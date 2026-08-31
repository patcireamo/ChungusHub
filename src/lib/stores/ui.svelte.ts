/**
 * Workspace UI state: which overlay is open, which sub-tab each panel remembers,
 * and the chat search modal. Lives independently of the data stores so
 * navigation survives chat switches.
 */
import { workspaceFocus } from '$lib/stores/workspaceFocus.svelte';

/** Chat-area overlays: they cover the chat column. Settings and the merged Library
 *  are separate (settingsOpen / libraryOpen), each docking into a side margin. The
 *  Chungus Assistant is neither: it's a free-floating widget (assistantOpen). */
export type OverlayType = 'chats' | 'presetControls' | 'storymap' | 'memory' | 'stats';
/** The three shelves of the merged Library, chosen by the panel's top switcher. */
export type LibraryTab = 'characters' | 'personas' | 'lorebooks';
/** What the Chats panel lists: the open chat's character, or every chat there is. */
export type ChatsScope = 'character' | 'all';
/** Transient side occupied by the snapped Assistant; null while floating/centered/closed. */
export type AssistantSnapSide = 'left' | 'right';

class UiStore {
	// The settings panel's drill-down position: 'root' is the grouped index, any
	// other value is a SettingsPage id (settings-pages.ts). Survives overlay
	// switches within a session, so the panel reopens where it was left.
	// (`SettingsTab`, the assistant deep-link contract, lives in settings-pages.ts
	// with the rest of the settings information architecture.)
	settingsPage = $state<string>('root');

	// The connection open in the Connections-page editor: its id, or null when the
	// list + roles view is showing. Lives here (not in the page) so the split view's
	// history/back/forward and the drill back chip can step out of the editor. Every
	// page navigation clears it via gotoSettingsPage, so it can't leak onto another page.
	settingsConnectionId = $state<string | null>(null);

	// The in-place Provider Routing sub-view of the connection editor: the model id
	// being routed, null when the plain editor is showing. Lives here (not in the
	// component) so the split view's history/back/forward and the drill back chip can
	// both drive it. Cleared on every page navigation via gotoSettingsPage.
	settingsRoutingModel = $state<string | null>(null);

	// The engine open in the Engines-page detail view: its id, or null when the
	// overview list is showing. Same doctrine as settingsConnectionId: it lives here
	// so the split view's history and the drill back chip can step out of the
	// detail, and every page navigation clears it via gotoSettingsPage.
	settingsEngineId = $state<string | null>(null);

	// One-shot deep link: when set, the Library panel opens this entry's editor on
	// mount and clears the field. Set by "Edit in Library" style buttons.
	pendingLibraryEntryId = $state<string | null>(null);

	// One-shot deep link for the Lorebooks shelf: when set, the shelf opens this book's
	// editor and clears the field (an id that names no book is dropped once the shelf has
	// loaded). Set by assistant chips pointing at a book (assistant-targets.ts).
	pendingLorebookId = $state<string | null>(null);

	// One-shot deep link for settings anchors: navigation.ts sets it; the
	// SettingsPanel router consumes it to open the page hosting that
	// `data-setting` anchor, then clears the field.
	pendingSettingsAnchor = $state<string | null>(null);

	// The chat-area overlay. Renders directly over the chat column at its exact size.
	activeOverlay = $state<OverlayType | null>(null);
	// Which chats the Chats panel lists. Kept across opens like `libraryTab`, so a scope
	// the user picked is not re-picked on every visit. It names a KIND of scope, never a
	// character, which is what lets it survive walking from one story into another; and
	// it is a preference rather than a binding, so a panel opened with no character on
	// screen lists everything whatever this says.
	chatsScope = $state<ChatsScope>('character');
	// The boot landing surface. A persistent base layer beneath the chat overlays,
	// not part of activeOverlay, so opening/closing any panel never disturbs it. It
	// closes only when a chat opens (chatStore.selectChat calls dismissWelcome).
	welcomeOpen = $state(false);
	// Settings: a left-margin dock on wide screens, a chat-area overlay on narrow
	// ones. The merged Library mirrors it on the right. Only one panel is open at a
	// time (Settings, Library, and every overlay are mutually exclusive), unless a
	// side dock is pinned with its lock toggle, which keeps it open until its own
	// button closes it.
	settingsOpen = $state(false);
	settingsLocked = $state(false);
	libraryOpen = $state(false);
	libraryLocked = $state(false);
	// Which shelf of the merged Library is showing. Persisted across opens so the
	// panel reopens on the tab you left it on; deep links override it.
	libraryTab = $state<LibraryTab>('characters');
	// The library entry (character or persona) whose editor is open in the centered
	// Library-editor overlay. Null = list only. The Library dock shows the browse
	// list; opening an entry pops its editor out over the chat column, so the wide
	// editor never gets squeezed into the dock.
	libraryEditorId = $state<string | null>(null);
	// The lorebook whose editor is open, in the same centered slot and for the same
	// reason: a book is a document and the dock is a shelf. At most ONE of the two
	// centered editors stands at a time (`openEditor`), or a deep link out of one
	// would stack the other on top of it.
	lorebookEditorId = $state<string | null>(null);
	// The Chungus Assistant is a free-floating widget, not a docked panel: it never
	// participates in the mutual exclusion above. `assistantOpen` toggles the panel vs.
	// its mascot launcher button; there's no lock because it remains independently
	// movable and minimizable.
	assistantOpen = $state(false);
	// A side-snapped Assistant shares the native dock seam with the chat column. Workspace
	// reads this transient layout state to drive the same animated tint overhang as
	// Settings/Library; it is never persisted and does not join panel choreography.
	assistantSnapSide = $state<AssistantSnapSide | null>(null);
	// Prompt debug panel: a chat-area cover like the overlays, but opened from its own
	// handle. Mutually exclusive with every other panel, no lock.
	debugPanelOpen = $state(false);
	// The two-step New chat flow, guided through the Library panel itself: pick a
	// character (step 'character'), then a persona (step 'persona'), then a fresh
	// chat is created for that pair. Null = no flow running. The picked character
	// is held here between the steps.
	newChatStep = $state<'character' | 'persona' | null>(null);
	newChatCharacterId = $state<string | null>(null);

	// Navigation guard. A panel can register a blocker that vetoes leaving it while
	// it has unfinished business: the Library uses it to trap an unsaved brand-new
	// entry. When a blocker vetoes, `guardPulse` ticks so the panel can flash a
	// warning. Memory-only; the registered fn reads live state each time it's asked.
	private _navBlocker: (() => boolean) | null = null;
	private _guardPulse = $state(0);
	get guardPulse() {
		return this._guardPulse;
	}

	registerNavBlocker(fn: () => boolean) {
		this._navBlocker = fn;
	}

	clearNavBlocker(fn: () => boolean) {
		if (this._navBlocker === fn) this._navBlocker = null;
	}

	/** True if navigation is currently vetoed; also signals a guard pulse when it is. */
	private navBlocked(): boolean {
		if (this._navBlocker && this._navBlocker()) {
			this._guardPulse++;
			return true;
		}
		return false;
	}

	/** Public form of the nav guard for call sites outside the panel methods, e.g. a
	 *  browse-card click that navigates away from an open editor. Pulses on veto. */
	guardBlocksNav(): boolean {
		return this.navBlocked();
	}

	// Opening any panel drops the others, except a pinned (locked) side dock. The debug
	// panel has no lock, so it always closes when something else opens. The floating
	// assistant is independent and never dropped here.
	private dropUnlockedSidePanels() {
		if (this.settingsOpen && !this.settingsLocked) this.closeSettings();
		if (this.libraryOpen && !this.libraryLocked) this.closeLibrary();
		this.debugPanelOpen = false;
	}

	toggleOverlay(overlay: OverlayType, flushFn?: () => void) {
		if (this.activeOverlay === overlay) {
			this.closeOverlay(flushFn);
		} else {
			this.openOverlay(overlay, flushFn);
		}
	}

	openOverlay(overlay: OverlayType, flushFn?: () => void) {
		if (this.navBlocked()) return;
		// Flush pending edits when switching away from another overlay.
		if (this.activeOverlay && this.activeOverlay !== overlay) flushFn?.();
		this.dropUnlockedSidePanels();
		this.activeOverlay = overlay;
	}

	closeOverlay(flushFn?: () => void) {
		if (this.navBlocked()) return;
		if (this.activeOverlay) flushFn?.();
		this.activeOverlay = null;
	}

	/** Raise the welcome / home surface, the app's landing screen on boot. It sits
	 *  below every panel, so this neither drops nor is dropped by other overlays. */
	openWelcome() {
		this.welcomeOpen = true;
	}

	/** Dismiss the landing screen. The one and only trigger is a chat opening. */
	dismissWelcome() {
		this.welcomeOpen = false;
	}

	/** The Chats browser. */
	openChats() {
		if (this.navBlocked()) return;
		this.dropUnlockedSidePanels();
		this.activeOverlay = 'chats';
	}

	// The merged Library: a right-margin dock (mirror of Settings) holding the
	// Characters/Personas switcher. Opening it drops the chat overlay and the unlocked
	// Settings dock.
	openLibrary(flushFn?: () => void) {
		if (this.navBlocked()) return;
		if (this.activeOverlay) flushFn?.();
		this.activeOverlay = null;
		if (this.settingsOpen && !this.settingsLocked) this.closeSettings();
		this.debugPanelOpen = false;
		this.libraryOpen = true;
	}

	/** Raise one of the two centered editors and lower the other. They share a slot over
	 *  the chat, so a deep link out of one must replace it rather than stack on it. */
	private openEditor(entry: string | null, lorebook: string | null) {
		this.libraryEditorId = entry;
		this.lorebookEditorId = lorebook;
	}

	closeLibrary() {
		// Honour the nav guard: an unsaved brand-new entry traps the close (and pulses the
		// warning) whether it's the pill, click-away, or another panel stealing the dock.
		if (this.navBlocked()) return;
		this.libraryOpen = false;
		// Closing the dock also dismisses whichever centered editor it opened.
		this.openEditor(null, null);
		// The flow lives in the Library, so closing the panel abandons the wizard.
		this.clearNewChat();
		// The Library dock owned the auto-attach focus; releasing it on close means the
		// assistant never sees an entry the user has navigated away from.
		workspaceFocus.setEntry(null);
	}

	/** Begin the New chat flow: the Library opens on Characters, a character pick
	 *  advances to Personas, a persona pick creates the fresh chat. The flow ends
	 *  when the Library closes or any chat opens (chatStore.selectChat clears it). */
	startNewChat(flushFn?: () => void) {
		if (this.navBlocked()) return;
		if (this.libraryTab !== 'characters') {
			flushFn?.();
			this.libraryTab = 'characters';
		}
		// The wizard presents the browse list, so dismiss any open editor.
		this.openEditor(null, null);
		this.openLibrary(flushFn);
		this.newChatStep = 'character';
		this.newChatCharacterId = null;
	}

	/** Step 2 of the New chat flow: lock in the character pick, flip to Personas. */
	advanceNewChat(characterId: string) {
		if (this.navBlocked()) return;
		this.newChatCharacterId = characterId;
		this.newChatStep = 'persona';
		this.libraryTab = 'personas';
		this.openEditor(null, null);
	}

	/** End the New chat flow, completion and cancel alike. */
	clearNewChat() {
		this.newChatStep = null;
		this.newChatCharacterId = null;
	}

	toggleLibrary(flushFn?: () => void) {
		if (this.libraryOpen) this.closeLibrary();
		else this.openLibrary(flushFn);
	}

	toggleLibraryLock() {
		this.libraryLocked = !this.libraryLocked;
	}

	// Flip the Library's shelf switcher, trapped by the nav guard so an unsaved
	// brand-new entry can't be abandoned by switching tabs.
	setLibraryTab(tab: LibraryTab, flushFn?: () => void) {
		if (this.libraryTab === tab) return;
		if (this.navBlocked()) return;
		flushFn?.();
		this.libraryTab = tab;
		// The centered editor belongs to the tab it was opened from, so dismiss it and the
		// dock and the editor never show different shelves of the Library.
		this.openEditor(null, null);
	}

	// Open the Library on the entry's tab, deep-linking to its editor (the view opens
	// it on mount via pendingLibraryEntryId).
	openLibraryEntry(entryId: string, entityType: 'character' | 'persona', flushFn?: () => void) {
		// Asked BEFORE the editors are lowered, not by openLibrary below: the blocker reads
		// `libraryEditorId`, so clearing it first would answer its own question with a no.
		if (this.navBlocked()) return;
		this.pendingLibraryEntryId = entryId;
		this.libraryTab = entityType === 'persona' ? 'personas' : 'characters';
		this.openEditor(null, null);
		this.openLibrary(flushFn);
	}

	/** The Lorebooks shelf: the third tab of the Library, where books are browsed. */
	openLorebooks(flushFn?: () => void) {
		if (this.navBlocked()) return;
		this.libraryTab = 'lorebooks';
		this.openEditor(null, null);
		this.openLibrary(flushFn);
	}

	/** Ctrl+B and the command palette: the shelf, or away from it if it is already up. */
	toggleLorebooks(flushFn?: () => void) {
		if (this.libraryOpen && this.libraryTab === 'lorebooks') this.closeLibrary();
		else this.openLorebooks(flushFn);
	}

	/** Open one book's editor with the shelf behind it (an assistant chip pointing at a
	 *  book). The shelf consumes `pendingLorebookId` so an id naming nothing is dropped
	 *  rather than opening an editor over a book that is gone. */
	openLorebook(bookId: string, flushFn?: () => void) {
		this.pendingLorebookId = bookId;
		this.openLorebooks(flushFn);
	}

	/** Route the settings surface to a page. Every page navigation funnels through
	 *  here so the connection editor, its routing sub-view, and the engine detail
	 *  can't survive a page switch. */
	gotoSettingsPage(page: string) {
		this.settingsPage = page;
		this.settingsConnectionId = null;
		this.settingsRoutingModel = null;
		this.settingsEngineId = null;
	}

	openSettings(flushFn?: () => void) {
		if (this.navBlocked()) return;
		// One panel at a time: drop the chat-area overlay and the unlocked Library dock.
		if (this.activeOverlay) flushFn?.();
		this.activeOverlay = null;
		if (this.libraryOpen && !this.libraryLocked) this.closeLibrary();
		this.debugPanelOpen = false;
		this.settingsOpen = true;
	}

	closeSettings() {
		// The lock is a sticky preference: only its own button clears it, never an
		// open/close of the panel.
		this.settingsOpen = false;
	}

	toggleSettings(flushFn?: () => void) {
		if (this.settingsOpen) this.closeSettings();
		else this.openSettings(flushFn);
	}

	toggleSettingsLock() {
		this.settingsLocked = !this.settingsLocked;
	}

	// The Chungus Assistant floats above everything, so opening/closing it touches no other
	// panel and never clears the workspace focus (the Library dock owns that).
	openAssistant() {
		this.assistantOpen = true;
	}

	closeAssistant() {
		this.assistantOpen = false;
		this.assistantSnapSide = null;
	}

	toggleAssistant() {
		if (this.assistantOpen) this.closeAssistant();
		else this.openAssistant();
	}

	setAssistantSnapSide(side: AssistantSnapSide | null) {
		if (this.assistantSnapSide !== side) this.assistantSnapSide = side;
	}

	openDebugPanel(flushFn?: () => void) {
		if (this.navBlocked()) return;
		// One panel at a time, same as Settings/Library: drop the chat-area overlay and
		// the unlocked side docks.
		if (this.activeOverlay) flushFn?.();
		this.activeOverlay = null;
		if (this.settingsOpen && !this.settingsLocked) this.closeSettings();
		if (this.libraryOpen && !this.libraryLocked) this.closeLibrary();
		this.debugPanelOpen = true;
	}

	closeDebugPanel() {
		this.debugPanelOpen = false;
	}

	toggleDebugPanel(flushFn?: () => void) {
		if (this.debugPanelOpen) this.closeDebugPanel();
		else this.openDebugPanel(flushFn);
	}
}

export const uiStore = new UiStore();
