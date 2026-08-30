<script lang="ts">
	/**
	 * The chats browser, raised from the composer hamburger ("Chats") or the welcome
	 * landing. Two scopes, one list, and the switch in the header picks between them:
	 * scoped to the open chat's character it shows that character's chats and New chat
	 * makes another one directly; scoped to everything it shows EVERY chat with per-row
	 * faces and the button hands off to the New chat flow.
	 *
	 * Four things here are deliberate and easy to undo by accident:
	 *
	 *  - `scopedCharacterId` is the only thing that decides what the list holds. The
	 *    switch writes the scope, that one derived reads it, and the list, the row faces
	 *    and the New chat button all read the derived, so the panel cannot end up
	 *    showing one thing while its button does another.
	 *  - The counts are two numbers, labelled. `path` is the branch you would read;
	 *    `total - path` is everything hanging off it. One unlabelled count is what makes
	 *    a list and its preview disagree by four.
	 *  - The preview starts empty, fills with the row the pointer touches, and HOLDS it.
	 *    Nothing but the list changing under it empties it again: the trip from a row to
	 *    the pane crosses the list's padding, its scrollbar and the section labels, so a
	 *    pane that clears on any of those is blank by the time the pointer lands in it,
	 *    and its action bar (the only copy of the row actions a mouse can reach) is
	 *    unusable.
	 *  - Rows are not in the tab order. The list is arrow-driven with a roving selection
	 *    (aria-activedescendant), and every row action also lives in the preview's action
	 *    bar, which IS tabbable, so nothing is reachable by mouse alone.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { holdMsForBlast } from '$lib/components/ui/HoldToConfirmButton.svelte';
	import ChatAvatars from './ChatAvatars.svelte';
	import ChatListRow from './ChatListRow.svelte';
	import ChatPreviewPane from './ChatPreviewPane.svelte';
	import DuplicateChatDialog from './DuplicateChatDialog.svelte';
	import ImportChatsDialog from './ImportChatsDialog.svelte';
	import { duplicateAsksAboutMemory } from '$lib/types/chat';
	import type { Chat, ChatListStats, ChatMemoryFootprint } from '$lib/types/chat';
	import { db } from '$lib/services/database';
	import { expandSelfRefs } from '$lib/macros';
	import { buildSearchRegex } from '$lib/utils/chat-search';
	import { dayBucket } from '$lib/utils/date';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { messageStore } from '$lib/stores/messages.svelte';
	import { uiStore, type ChatsScope } from '$lib/stores/ui.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { chatCastStore, type ChatCastMember } from '$lib/stores/chatCast.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';

	type SortKey = 'activity' | 'created' | 'messages' | 'title';
	type SortDir = 'asc' | 'desc';
	type FilterMode = 'all' | 'favorites' | 'duplicates';

	const SORT_OPTIONS: { key: SortKey; label: string; defaultDir: SortDir }[] = [
		{ key: 'activity', label: 'Last activity', defaultDir: 'desc' },
		{ key: 'created', label: 'Date created', defaultDir: 'desc' },
		{ key: 'messages', label: 'Message count', defaultDir: 'desc' },
		{ key: 'title', label: 'Title', defaultDir: 'asc' }
	];

	const BUCKET_LABELS: Record<string, string> = {
		today: 'Today',
		yesterday: 'Yesterday',
		week: 'Previous 7 days',
		month: 'Previous 30 days',
		older: 'Older'
	};

	let chats = $derived(chatStore.sortedChats);
	let activeChatId = $derived(chatStore.activeChatId);

	let isMobile = $derived(viewport.isMobile);

	// Whether the preview pane fits, decided by the PANEL's own width, not the
	// viewport's. The panel renders two ways (a fixed-width desktop modal and a
	// full-width mobile overlay), so a viewport media query describes neither: on a
	// 700px window the modal is 700px wide and `viewport.isMobile` is still false. Hiding
	// the pane with CSS `display: none` leaves it mounted, invisible, fetching a whole
	// chat on every row hover and holding the only tabbable copy of the row actions.
	// The two columns need 17rem + 20rem to breathe.
	const TWO_PANE_MIN = 640;
	let bodyWidth = $state(0);
	let singleColumn = $derived(bodyWidth > 0 ? bodyWidth < TWO_PANE_MIN : isMobile);

	// ===== Scope =====
	//
	// Two scopes, one list, and the switch in the header is what picks between them.
	// `scopedCharacterId` is the SINGLE value everything downstream reads (the list, the
	// face each row wears, the New chat button), so nothing can end up disagreeing with
	// what the switch says.
	//
	// The switch is gated on the library entry RESOLVING, not on the id: a chat orphaned
	// by a character deletion keeps a dangling id, and scoping to that narrows the list
	// to a character with no name, no face and nothing on screen saying why. Those chats
	// browse globally.
	let scope = $derived(uiStore.chatsScope);
	let scopeCharacter = $derived.by<ChatCastMember | null>(() => {
		const id = chatStore.activeChat?.characterId ?? null;
		if (!id) return null;
		const entry = characterLibraryStore.entries.find((e) => e.id === id);
		if (!entry) return null;
		return {
			libraryEntryId: entry.id,
			name: entry.identity.name,
			imageUrl: entry.identity.imageUrl ?? null,
			portraitFocus: entry.identity.portraitFocus
		};
	});
	let scopedCharacterId = $derived(
		scope === 'character' && scopeCharacter ? scopeCharacter.libraryEntryId : null
	);

	function setScope(next: ChatsScope) {
		uiStore.chatsScope = next;
		// Hand the keyboard back to the field the list is driven from: a press that parks
		// focus on this button leaves the arrows dead (listKeysActive). Never on a phone,
		// where focusing the field throws the on-screen keyboard over the list.
		if (!viewport.isMobile) requestAnimationFrame(() => searchInputEl?.focus());
	}

	let searchQuery = $state('');
	let searchInMessages = $state(false);
	let sortKey = $state<SortKey>('activity');
	let sortDir = $state<SortDir>('desc');
	let sortMenuOpen = $state(false);
	let filterMode = $state<FilterMode>('all');
	let searchInputEl: HTMLInputElement | null = $state(null);
	let listEl: HTMLDivElement | null = $state(null);
	let selectedIndex = $state(0);
	// The selected-row highlight only shows while the keyboard is driving (arrows).
	// The mouse uses a plain CSS :hover so nothing stays highlighted after the cursor
	// leaves. Any hover flips this back off.
	let keyboardActive = $state(false);

	let hoveredChatId = $state<string | null>(null);
	let renamingChatId = $state<string | null>(null);
	let menu = $state<{ chatId: string; left: number; top: number; anchorTop: number } | null>(null);
	let litTwinGroup = $state<string | null>(null);

	// ===== Server-side aggregates =====

	let stats = $state<Record<string, ChatListStats>>({});
	let twinGroups = $state<Record<string, string>>({});

	$effect(() => {
		// Track the chat set so this re-runs on add/remove (duplicate, delete, import),
		// not just on mount. The cancelled guard makes the LATEST fetch win: a bulk
		// import reassigns chatStore.chats once per chat, so several can be in flight and
		// resolve out of order, freezing the counts at a stale snapshot.
		void chatStore.chats.length;
		let cancelled = false;
		Promise.all([db.getChatListStats(), db.getChatContentGroups()])
			.then(([nextStats, nextGroups]) => {
				if (cancelled) return;
				stats = nextStats;
				twinGroups = nextGroups;
			})
			.catch((e) => console.error('Failed to load chat list stats:', e));
		return () => {
			cancelled = true;
		};
	});

	/** chatId → how many chats share its content. Absent = unique. Counted over the
	 *  chats the store still holds, not over the fingerprint map: the map is a server
	 *  aggregate read on its own schedule, so it can briefly hold a chat the list has
	 *  already dropped, and a twin must stop claiming a partner the moment the row
	 *  disappears. */
	let twinCounts = $derived.by(() => {
		const live = new Set(chats.map((c) => c.id));
		const sizes = new Map<string, number>();
		for (const [chatId, group] of Object.entries(twinGroups)) {
			if (live.has(chatId)) sizes.set(group, (sizes.get(group) ?? 0) + 1);
		}
		const out: Record<string, number> = {};
		for (const [chatId, group] of Object.entries(twinGroups)) {
			if (live.has(chatId)) out[chatId] = sizes.get(group) ?? 0;
		}
		return out;
	});

	// ===== Search =====

	let messageHits = $state<Record<string, { hits: number; snippet: string }>>({});
	let searchingMessages = $state(false);

	// Message search costs a server pass over every active branch, so it waits for a
	// pause in typing. Title matching stays instant and local either way.
	$effect(() => {
		const query = searchQuery.trim();
		const deep = searchInMessages;
		if (!deep || !query) {
			messageHits = {};
			searchingMessages = false;
			return;
		}
		let cancelled = false;
		searchingMessages = true;
		const timer = setTimeout(() => {
			db.searchChatMessages(query)
				.then((hits) => {
					if (cancelled) return;
					messageHits = hits;
				})
				.catch((e) => console.error('Chat message search failed:', e))
				.finally(() => {
					if (!cancelled) searchingMessages = false;
				});
		}, 250);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	let titleMatcher = $derived(buildSearchRegex(searchQuery.trim(), { matchCase: false, wholeWord: false }));

	function matchesTitle(title: string): boolean {
		if (!titleMatcher) return true;
		// The matcher is a /g/ regex, so its lastIndex survives a test. Reset it, or every
		// second row silently fails to match.
		titleMatcher.lastIndex = 0;
		return titleMatcher.test(title);
	}

	// ===== Scope, filter, sort =====

	// The unfiltered scope (drives the count under the title): the scoped character's
	// chats, or every chat there is.
	let scopedChats = $derived(
		scopedCharacterId ? chats.filter((c) => c.characterId === scopedCharacterId) : chats
	);

	let twinsInScope = $derived(scopedChats.some((c) => (twinCounts[c.id] ?? 0) > 1));

	/** One activity value for sorting, grouping and the row's timestamp alike: the last
	 *  message on the branch, falling back to the row's own updated_at for a chat that
	 *  has none. Two different values here would order the sections against the rows. */
	function activityAt(chat: Chat): number {
		return stats[chat.id]?.lastAt ?? chat.updatedAt;
	}

	let visibleChats = $derived.by(() => {
		const query = searchQuery.trim();
		let list = scopedChats.filter((chat) => {
			if (filterMode === 'favorites' && !chat.isFavorite) return false;
			if (filterMode === 'duplicates' && (twinCounts[chat.id] ?? 0) < 2) return false;
			if (!query) return true;
			return matchesTitle(chat.title) || !!messageHits[chat.id];
		});

		const dir = sortDir === 'asc' ? 1 : -1;
		list = [...list].sort((a, b) => {
			let cmp: number;
			switch (sortKey) {
				case 'created':
					cmp = a.createdAt - b.createdAt;
					break;
				case 'messages':
					// The branch count, the number the row leads with.
					cmp = (stats[a.id]?.path ?? 0) - (stats[b.id]?.path ?? 0);
					break;
				case 'title':
					cmp = a.title.localeCompare(b.title);
					break;
				default:
					cmp = activityAt(a) - activityAt(b);
			}
			// Stable tiebreaker so equal keys (e.g. same count) keep a deterministic order.
			return cmp !== 0 ? cmp * dir : activityAt(b) - activityAt(a);
		});

		// Favorites float above everything, whatever the sort: the standard pinned-items
		// behaviour. Pointless while the list is already filtered down to favorites.
		if (filterMode === 'favorites') return list;
		return [...list.filter((c) => c.isFavorite), ...list.filter((c) => !c.isFavorite)];
	});

	/** The same flat order, cut into labelled sections. Boundaries only ever fall between
	 *  runs, because the flat list is already ordered favorites-first then by the sort
	 *  key, so the keyboard's index and what's on screen can't drift apart. */
	let sections = $derived.by(() => {
		const timeGrouped = sortKey === 'activity' || sortKey === 'created';
		const out: { key: string; label: string | null; chats: Chat[] }[] = [];
		for (const chat of visibleChats) {
			let key = 'all';
			let label: string | null = null;
			if (chat.isFavorite && filterMode !== 'favorites') {
				key = 'favorites';
				label = 'Favorites';
			} else if (timeGrouped) {
				key = dayBucket(sortKey === 'created' ? chat.createdAt : activityAt(chat));
				label = BUCKET_LABELS[key];
			}
			const last = out[out.length - 1];
			if (last && last.key === key) last.chats.push(chat);
			else out.push({ key, label, chats: [chat] });
		}
		return out;
	});

	/** chatId → its position in the flat order. The sections render nested, but the
	 *  keyboard indexes the flat list, and looking each row up by scan would be
	 *  quadratic on every keystroke. */
	let indexById = $derived(new Map(visibleChats.map((chat, index) => [chat.id, index])));

	let isEmpty = $derived(visibleChats.length === 0);
	let hoveredChat = $derived(hoveredChatId ? (chats.find((c) => c.id === hoveredChatId) ?? null) : null);
	let hoveredCharacter = $derived(hoveredChat ? (chatCastStore.charactersForChat(hoveredChat.id)[0] ?? null) : null);
	// Preview speakers mirror the main chat: every user line is the chat's persona,
	// every assistant line is the chat's bound character.
	let hoveredPersona = $derived(hoveredChat ? chatCastStore.personaForChat(hoveredChat.id) : null);

	/** The face a row wears. In the global scope that's the bound character; inside one
	 *  character's list every row would wear the same face, so it shows the persona the
	 *  story is being written with instead, the one thing that actually differs. */
	function faceFor(chat: Chat): ChatCastMember | null {
		return scopedCharacterId
			? chatCastStore.personaForChat(chat.id)
			: (chatCastStore.charactersForChat(chat.id)[0] ?? null);
	}

	/** Context for a row that matched on message text, and nothing otherwise: browsing
	 *  rows carry a time, not a preview line. Self-refs resolve here, not in the row:
	 *  this is the only side that knows the chat's character and persona names
	 *  (coupling #6 in architecture/chat-sessions.md). */
	function hitSnippetFor(chat: Chat): string {
		const raw = messageHits[chat.id]?.snippet;
		if (!raw) return '';
		const charName = chatCastStore.charactersForChat(chat.id)[0]?.name?.trim() || 'Story';
		// The CHAT's persona, falling back to a neutral "You": the same pair the preview
		// pane resolves with, so one chat can't read two different names in one panel.
		const userName = chatCastStore.personaForChat(chat.id)?.name?.trim() || 'You';
		return expandSelfRefs(raw.replace(/\s+/g, ' ').trim(), charName, userName);
	}

	// ===== Selection =====

	$effect(() => {
		searchQuery;
		sortKey;
		sortDir;
		filterMode;
		// A scope flip replaces the whole list, so it empties the held preview like any
		// other filter. Reading the resolved id rather than the switch also covers the
		// character disappearing from the library under an open panel.
		scopedCharacterId;
		selectedIndex = 0;
		// The rows these two point at may not exist in the new list at all: a held
		// preview would go on showing a chat the query just filtered out.
		litTwinGroup = null;
		hoveredChatId = null;
	});

	// Keep the selection in range. The preview follows the selection while the keyboard
	// is driving; with the mouse, hover sets it and it stays on that row. An emptied
	// list has no row to hold, so the pane goes back to idle.
	$effect(() => {
		if (visibleChats.length === 0) {
			hoveredChatId = null;
			return;
		}
		const normalized = Math.min(Math.max(selectedIndex, 0), visibleChats.length - 1);
		if (normalized !== selectedIndex) selectedIndex = normalized;
		if (!keyboardActive) return;
		const selected = visibleChats[normalized];
		if (selected && hoveredChatId !== selected.id) hoveredChatId = selected.id;
	});

	// Land focused on the search box so the user can type immediately, but never on a
	// phone, where focusing a field throws the on-screen keyboard over half the list
	// somebody opened the panel to browse.
	$effect(() => {
		if (viewport.isMobile) return;
		requestAnimationFrame(() => searchInputEl?.focus());
	});

	function sortLabel(key: SortKey): string {
		return SORT_OPTIONS.find((o) => o.key === key)!.label;
	}

	function chooseSort(key: SortKey) {
		if (key === sortKey) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			sortDir = SORT_OPTIONS.find((o) => o.key === key)!.defaultDir;
		}
		sortMenuOpen = false;
	}

	function toggleSortDir() {
		sortDir = sortDir === 'asc' ? 'desc' : 'asc';
	}

	function setFilter(mode: FilterMode) {
		filterMode = filterMode === mode ? 'all' : mode;
	}

	/** The twin highlight is lit by a chip's mouseenter and put out by its mouseleave,
	 *  which never fires if that row unmounts under the pointer (a delete, a sync),
	 *  leaving the survivors glowing. Leaving the body puts it out either way. The
	 *  preview is deliberately NOT dropped here: this is the edge the pointer crosses
	 *  on its way to the pane's own buttons. */
	function clearTwinHighlight() {
		litTwinGroup = null;
	}

	function close() {
		uiStore.closeOverlay(() => lorebookStore.flush());
	}

	function selectChat(chatId: string) {
		chatStore.selectChat(chatId);
		close();
	}

	// The button follows the scope switch, because a list that says "every character"
	// cannot have a New chat button that silently means one of them. Scoped to a
	// character it means "another chat with them", created directly, greeting and all;
	// createChat opens it, which dismisses the panel. Scoped to everything there is no
	// character to inherit, so it hands off to the New chat flow instead (opening the
	// Library drops this overlay on its own).
	// The direct branch is refused mid-generation, same guard and same reason as the
	// composer's own New chat row: createChat opens the chat it makes, and the stream
	// appends into whichever chat state is current. The New chat branch only raises the
	// Library, so it takes no guard: the pick that eventually creates a chat is several
	// steps and a whole panel away.
	async function handleNewChat() {
		if (scopedCharacterId) {
			if (messageStore.warnIfBusy()) return;
			await chatStore.createChat({ characterId: scopedCharacterId });
			close();
		} else {
			uiStore.startNewChat(() => lorebookStore.flush());
		}
	}

	// SillyTavern chat files, brought onto the character the list is narrowed to. Nothing is
	// written until the dialog confirms it, since which character a file lands on is the one
	// thing this app cannot undo afterwards.
	let chatFileInput = $state<HTMLInputElement | null>(null);
	let importPick = $state<{ files: File[]; characterId: string; characterName: string } | null>(null);

	function handlePickedChatFiles(event: Event) {
		const input = event.target as HTMLInputElement;
		const picked = input.files ? Array.from(input.files) : [];
		// Cleared so picking the same file twice in a row still fires a change event.
		input.value = '';
		if (picked.length === 0 || !scopedCharacterId || !scopeCharacter) return;
		// The target is taken HERE and carried, never read live by the dialog: a pick is for
		// the character it was made from, and a scope that moved underneath must not move
		// where those files land.
		importPick = {
			files: picked,
			characterId: scopedCharacterId,
			characterName: scopeCharacter.name
		};
	}

	// ===== Row actions =====

	/** The panel is a backdrop-filtered, overflow-hidden surface, which makes it the
	 *  containing block for `position: fixed` children AND clips them, so a menu placed
	 *  from viewport coordinates has to leave the panel entirely. Same reason and same
	 *  shape as the message editor's action menu. Body-portaled nodes also sit outside
	 *  the workspace element, so Workspace's click-away leaves them alone. */
	function portalToBody(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}

	function openRowMenu(chatId: string, anchor: DOMRect) {
		if (menu?.chatId === chatId) {
			menu = null;
			return;
		}
		// Placed below the button, then corrected against its REAL height once it has
		// rendered (see the effect below): a guessed height either flips a menu that had
		// room or leaves a flipped one hanging in the air above its own button.
		const width = 190;
		const left = Math.max(EDGE, Math.min(anchor.right - width, window.innerWidth - width - EDGE));
		menu = { chatId, left, top: anchor.bottom + 6, anchorTop: anchor.top };
	}

	const EDGE = 8;
	let menuEl: HTMLElement | null = $state(null);

	$effect(() => {
		const el = menuEl;
		const current = menu;
		if (!el || !current) return;
		const height = el.offsetHeight;
		const fits = current.top + height + EDGE <= window.innerHeight;
		const top = fits ? current.top : Math.max(EDGE, current.anchorTop - height - 6);
		// Only write when it actually moves: this effect reads `menu`, so an
		// unconditional write would loop.
		if (Math.abs(top - current.top) > 0.5) menu = { ...current, top };
	});

	// A menu whose chat vanished (a sync, or another device's delete) leaves nothing on
	// screen but still swallows the next Escape.
	$effect(() => {
		if (menu && !chats.some((c) => c.id === menu?.chatId)) menu = null;
	});

	function startRename(chatId: string) {
		menu = null;
		renamingChatId = chatId;
	}

	/** Closing the rename field would otherwise drop focus onto <body>, leaving the
	 *  keyboard with nothing to drive. */
	function endRename() {
		renamingChatId = null;
		requestAnimationFrame(() => searchInputEl?.focus());
	}

	async function commitRename(chatId: string, title: string) {
		endRename();
		await chatStore.updateChatTitle(chatId, title);
	}

	async function toggleFavorite(chatId: string) {
		menu = null;
		await chatStore.toggleChatFavorite(chatId);
	}

	// ===== Delete =====

	let deleteTarget = $state<Chat | null>(null);
	// The dialog states the real numbers of what goes, from the stats already loaded for
	// the rows; past the hold threshold the confirm becomes a press-and-hold (the
	// destructive-act ladder, architecture/ui-shell-settings.md). Deletion is immediate
	// and final once confirmed: there is no undo anywhere in the app.
	let deleteStats = $derived(deleteTarget ? (stats[deleteTarget.id] ?? null) : null);
	let deleteMessage = $derived.by(() => {
		if (!deleteTarget) return '';
		const name = `"${deleteTarget.title}"`;
		if (!deleteStats) return `Delete ${name} and every message in it? This cannot be undone.`;
		const n = deleteStats.total;
		const branches = n > deleteStats.path ? ', branches included' : '';
		return `Delete ${name} and its ${n} message${n === 1 ? '' : 's'}${branches}? This cannot be undone.`;
	});

	function deleteChat(chatId: string) {
		menu = null;
		deleteTarget = chats.find((c) => c.id === chatId) ?? null;
	}

	function confirmDeleteChat() {
		const target = deleteTarget;
		deleteTarget = null;
		if (target) void chatStore.deleteChat(target.id);
	}

	// ===== Selecting several =====
	//
	// The reason this exists is the shape of a cleanup, not a missing feature: clearing out
	// twenty old chats one row at a time is twenty menus and twenty confirms, and no amount
	// of lowering the delete ladder fixes the repetition around it. Picked as a set, the
	// whole batch is one confirm stating one real total.

	let selecting = $state(false);
	let selectedIds = $state<Set<string>>(new Set());
	let bulkDeleteOpen = $state(false);

	let selectedChats = $derived(chats.filter((c) => selectedIds.has(c.id)));
	let selectedCount = $derived(selectedChats.length);
	let allVisibleSelected = $derived(
		visibleChats.length > 0 && visibleChats.every((c) => selectedIds.has(c.id))
	);

	function toggleSelecting() {
		selecting = !selecting;
		if (!selecting) selectedIds = new Set();
	}

	function toggleSelect(chatId: string) {
		const next = new Set(selectedIds);
		if (!next.delete(chatId)) next.add(chatId);
		selectedIds = next;
	}

	function selectAllVisible() {
		// What the filters and the search have left on screen, never the whole store: the
		// rows the reader can see are the ones they agreed to.
		selectedIds = new Set([...selectedIds, ...visibleChats.map((c) => c.id)]);
	}

	// The confirm carries both figures, because the one that hurts is the second: nobody
	// counts the messages inside twenty chats before agreeing to lose them.
	let bulkDeleteStats = $derived(
		selectedChats.reduce((n, c) => n + (stats[c.id]?.total ?? 0), 0)
	);
	let bulkDeleteMessage = $derived(
		`Delete ${selectedCount} chat${selectedCount === 1 ? '' : 's'} and ${bulkDeleteStats} message${bulkDeleteStats === 1 ? '' : 's'} in total? This cannot be undone.`
	);

	async function confirmBulkDelete() {
		const ids = [...selectedIds];
		bulkDeleteOpen = false;
		selectedIds = new Set();
		selecting = false;
		await chatStore.deleteChats(ids);
	}

	// ===== Duplicate =====

	let duplicateTarget = $state<{ chat: Chat; footprint: ChatMemoryFootprint } | null>(null);
	// True for the whole flow, memory lookup included, not just the copy itself. Two
	// fast clicks would otherwise run two copies concurrently, both naming themselves
	// against a list that holds neither yet: two rows called "X (copy)", which is exactly
	// what the counting in copyTitle exists to prevent.
	let duplicating = $state(false);

	function reportDuplicateFailure(chat: Chat, e: unknown) {
		console.error('Duplicate failed:', e);
		// The one failure worth explaining: the source's memory still points at messages
		// that have been deleted, a state the chat repairs itself the next time it is
		// opened (architecture/memory.md). Anything else gets the plain message.
		const stale = e instanceof Error && e.message.includes('mem-copy-stale');
		if (stale) {
			toastStore.error(
				`"${chat.title}" has memory pointing at deleted messages. Open the chat once to let it repair itself, or duplicate the story on its own.`
			);
		} else {
			toastStore.failed(`duplicate "${chat.title}"`, e);
		}
	}

	/** Only ever asks about memory when there is memory to ask about: a chat with none
	 *  is copied on the spot. */
	async function handleDuplicate(chatId: string) {
		menu = null;
		if (duplicating) return;
		const chat = chats.find((c) => c.id === chatId);
		if (!chat) return;
		duplicating = true;
		try {
			const footprint = await db.getChatMemoryFootprint(chatId);
			if (!duplicateAsksAboutMemory(footprint)) {
				await runDuplicate(chat, false);
				return;
			}
			duplicateTarget = { chat, footprint };
		} catch (e) {
			reportDuplicateFailure(chat, e);
		} finally {
			// Released here so the dialog's own buttons are live; the copy re-raises it.
			duplicating = false;
		}
	}

	async function runDuplicate(chat: Chat, includeMemory: boolean) {
		duplicating = true;
		try {
			await chatStore.duplicateChat(chat.id, { includeMemory });
			toastStore.success(includeMemory ? 'Chat duplicated with its memory' : 'Chat duplicated');
			// The selection is deliberately left where it was: the copy's position is not
			// knowable yet (it settles when the refreshed stats give it its real activity
			// time), and moving the cursor to a guessed index is worse than not moving it.
			duplicateTarget = null;
		} catch (e) {
			reportDuplicateFailure(chat, e);
		} finally {
			duplicating = false;
		}
	}

	// ===== Keyboard =====

	function scrollToSelected() {
		requestAnimationFrame(() => {
			listEl?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
		});
	}

	function moveSelection(next: number) {
		if (visibleChats.length === 0) return;
		keyboardActive = true;
		selectedIndex = next;
		hoveredChatId = visibleChats[next]?.id ?? null;
		scrollToSelected();
	}

	/** Whether the list keys belong to the list right now. They are bound on the window,
	 *  so without this a press meant for whatever has focus is stolen: Enter on the
	 *  preview's Delete button would open the selected chat instead of pressing Delete,
	 *  and the panel's own "every action is reachable by keyboard" promise would be a
	 *  lie. Focus normally sits in the search field (the combobox half of this pair);
	 *  anything else interactive owns its own keys. Escape is deliberately NOT gated:
	 *  it closes layers, and every layer wants it. */
	function listKeysActive(): boolean {
		const el = document.activeElement;
		if (!el || el === document.body || el === searchInputEl) return true;
		return !el.closest('button, a, input, select, textarea, [contenteditable="true"], [role="menuitem"]');
	}

	/** Standard "open the context menu for the focused thing" keys, so the row menu is
	 *  reachable without a pointer: the row buttons stay out of the tab order, which
	 *  would otherwise mean tabbing through every chat to reach one. */
	function openMenuForSelection() {
		const chat = visibleChats[selectedIndex];
		if (!chat) return;
		const button = listEl?.querySelector<HTMLElement>(`#chat-option-${CSS.escape(chat.id)} .chat-row-action`);
		if (button) openRowMenu(chat.id, button.getBoundingClientRect());
	}

	function handleKeydown(e: KeyboardEvent) {
		// A modal Dialog owns the keyboard while its portal is mounted and closes itself
		// on Escape. Same guard Workspace and LorebookView use, or one press would shut
		// the dialog AND the panel behind it.
		if (document.querySelector('.dialog-portal')) return;
		// While a rename field is open it owns the keyboard; the row's own handler stops
		// those keys before they reach here, so this only guards the stragglers.
		const renaming = renamingChatId !== null;

		if (e.key === 'Escape') {
			e.preventDefault();
			if (menu) menu = null;
			else if (sortMenuOpen) sortMenuOpen = false;
			else if (renaming) endRename();
			// A typed query is a layer too: clear it before dropping the whole panel, so
			// one stray press doesn't cost both the search and the place you were in.
			else if (searchQuery) searchQuery = '';
			// Last before the panel itself, because a selection built across a scroll is the
			// most expensive thing on this screen to lose to a stray press.
			else if (selecting) toggleSelecting();
			else close();
			return;
		}
		if (renaming || !listKeysActive()) return;

		if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
			e.preventDefault();
			openMenuForSelection();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			moveSelection((selectedIndex + 1) % visibleChats.length);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			moveSelection(selectedIndex <= 0 ? visibleChats.length - 1 : selectedIndex - 1);
		} else if ((e.key === 'Home' || e.key === 'End') && !searchQuery) {
			// Only with an empty field: focus lives in the search box, and taking Home/End
			// away from someone editing a query to jump a list they can already wrap
			// around with the arrows is a bad trade.
			e.preventDefault();
			moveSelection(e.key === 'Home' ? 0 : visibleChats.length - 1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const chat = visibleChats[selectedIndex];
			// Enter does whatever the row's own click does, or the keyboard and the mouse
			// would mean two different things about the same row.
			if (chat && selecting) toggleSelect(chat.id);
			else if (chat) selectChat(chat.id);
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="chats-view">
	<header class="chats-header">
		<!-- The shared chat-area overlay header row. The subject names the PANEL and
		     never the character, because whose chats these are is what the scope
		     switch below says. A header that shape-shifted into the character's
		     name would say it a second time, and only for one of the two scopes. -->
		<div class="overlay-header chats-identity-row">
			<div class="overlay-crumb">
				<h2 class="overlay-subject">Chats</h2>
				<span class="overlay-facts">
					{#if visibleChats.length !== scopedChats.length}
						{visibleChats.length} of {scopedChats.length} chats
					{:else}
						{scopedChats.length} chat{scopedChats.length === 1 ? '' : 's'}
					{/if}
				</span>
			</div>

			<div class="overlay-actions">
				<!-- Only while the list is narrowed to somebody, because that character IS the
				     target: scoped to everything there is nobody to import onto, and the
				     alternative is a picker over a library that runs to thousands of entries.
				     Hidden rather than shown inert, the same rule every other control here
				     follows. Icon only, so the row still fits a phone beside the labelled
				     button that is the panel's actual subject. -->
				{#if scopedCharacterId}
					<button
						type="button"
						class="overlay-action-btn"
						title="Import SillyTavern chats"
						aria-label="Import SillyTavern chats"
						onclick={() => chatFileInput?.click()}
					>
						<Icon name="download" class="w-4 h-4" />
					</button>
				{/if}
				<button type="button" class="chats-new-button" onclick={handleNewChat}>
					<Icon name="plus" class="w-4 h-4" />
					New chat
				</button>
			</div>
		</div>

		<!-- The scope switch, on its own line because it decides WHAT the row below
		     filters rather than being another filter itself. Rendered only when there is
		     a character to name: with none, one half would be permanently dead and the
		     other permanently on, which is a label dressed up as a choice. -->
		{#if scopeCharacter}
			<div class="chats-scope" role="group" aria-label="Which chats to list">
				<button
					type="button"
					class="chats-scope-btn"
					class:is-active={scope === 'character'}
					aria-pressed={scope === 'character'}
					onclick={() => setScope('character')}
				>
					<!-- The face is decoration here: its own label would make the button
					     announce the name twice. The tooltip it keeps is the only way to read
					     a name the label has ellipsised. -->
					<span class="chats-scope-face" aria-hidden="true">
						<ChatAvatars members={[scopeCharacter]} size={22} max={1} />
					</span>
					<span class="chats-scope-label">{scopeCharacter.name.trim() || 'This character'}</span>
				</button>
				<button
					type="button"
					class="chats-scope-btn"
					class:is-active={scope === 'all'}
					aria-pressed={scope === 'all'}
					onclick={() => setScope('all')}
				>
					<Icon name="globe" class="w-4 h-4 shrink-0" />
					<span class="chats-scope-label">All chats</span>
				</button>
			</div>
		{/if}

		<div class="chats-controls">
			<div class="chats-search input-base">
				<Icon name="search" class="w-4 h-4 chats-search-icon" />
				<!-- The field keeps focus while the arrows drive the list below it, so the
				     pair is a combobox: focus stays here and aria-activedescendant names the
				     row the selection is on. -->
				<input
					bind:this={searchInputEl}
					type="text"
					placeholder={searchInMessages ? 'Search titles and messages…' : 'Search chats…'}
					bind:value={searchQuery}
					class="chats-search-input"
					role="combobox"
					aria-expanded="true"
					aria-controls="chats-listbox"
					aria-autocomplete="list"
					aria-activedescendant={keyboardActive && visibleChats[selectedIndex]
						? `chat-option-${visibleChats[selectedIndex].id}`
						: undefined}
				/>
				{#if searchingMessages}
					<span class="chats-search-spinner" aria-hidden="true"></span>
				{/if}
				{#if searchQuery}
					<button
						type="button"
						class="chats-search-btn"
						onclick={() => (searchQuery = '')}
						aria-label="Clear search"
					>
						<Icon name="close" class="w-3.5 h-3.5" />
					</button>
				{/if}
				<button
					type="button"
					class="chats-search-btn chats-search-deep"
					class:is-on={searchInMessages}
					aria-pressed={searchInMessages}
					title={searchInMessages
						? 'Searching message text too (the branch each chat is on)'
						: 'Search inside messages as well'}
					aria-label="Search inside messages"
					onclick={() => (searchInMessages = !searchInMessages)}
				>
					<Icon name="annotation" class="w-4 h-4" />
				</button>
			</div>

			<!-- Filters ride the controls row as icon toggles rather than a row of their
			     own: a second header line for two switches is a lot of panel to spend. -->
			<button
				type="button"
				class="chats-toggle"
				class:is-on={filterMode === 'favorites'}
				aria-pressed={filterMode === 'favorites'}
				title="Show favorites only"
				aria-label="Show favorites only"
				onclick={() => setFilter('favorites')}
			>
				<Icon name="heart" class="w-4 h-4 {filterMode === 'favorites' ? 'fill-current' : ''}" />
			</button>
			<!-- Kept on screen while its own filter is on, even once the scope holds no
			     twins: a flip of the switch would otherwise take the only control that
			     can turn it back off away with it. -->
			{#if twinsInScope || filterMode === 'duplicates'}
				<button
					type="button"
					class="chats-toggle"
					class:is-on={filterMode === 'duplicates'}
					aria-pressed={filterMode === 'duplicates'}
					title="Show only chats whose content is identical to another chat's"
					aria-label="Show identical chats only"
					onclick={() => setFilter('duplicates')}
				>
					<Icon name="copy" class="w-4 h-4" />
				</button>
			{/if}

			<button
				type="button"
				class="chats-toggle"
				class:is-on={selecting}
				aria-pressed={selecting}
				title="Pick several chats"
				aria-label="Pick several chats"
				onclick={toggleSelecting}
			>
				<Icon name="checkCircle" class="w-4 h-4" />
			</button>

			<div class="chats-sort">
				<button
					type="button"
					class="chats-sort-btn"
					aria-haspopup="menu"
					aria-expanded={sortMenuOpen}
					onclick={() => (sortMenuOpen = !sortMenuOpen)}
				>
					<span class="chats-sort-caption">Sort</span>
					<span>{sortLabel(sortKey)}</span>
					<Icon name="chevronDown" class="w-3.5 h-3.5 text-text-muted" />
				</button>
				<button
					type="button"
					class="chats-sort-dir"
					onclick={toggleSortDir}
					title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
					aria-label="Toggle sort direction"
				>
					<Icon name={sortDir === 'asc' ? 'chevronUp' : 'chevronDown'} class="w-4 h-4" />
				</button>

				{#if sortMenuOpen}
					<div
						class="chats-scrim"
						onclick={() => (sortMenuOpen = false)}
						onkeydown={(e) => {
							if (e.key === 'Escape') {
								// Consume the press so the window handler doesn't see the menu
								// already closed and close the whole panel on the same event.
								e.preventDefault();
								e.stopPropagation();
								sortMenuOpen = false;
							}
						}}
						role="button"
						tabindex="-1"
						aria-label="Close menu"
					></div>
					<div class="chats-sort-menu surface-float" role="menu">
						{#each SORT_OPTIONS as opt (opt.key)}
							<button
								type="button"
								role="menuitemradio"
								aria-checked={sortKey === opt.key}
								class="chats-menu-item"
								class:is-active={sortKey === opt.key}
								onclick={() => chooseSort(opt.key)}
							>
								<span>{opt.label}</span>
								{#if sortKey === opt.key}
									<Icon name="check" class="w-4 h-4" />
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<!-- The picking bar: count and scope on the left, the one destructive action on the
		     right. It replaces nothing above it, so the search and the filters keep working
		     while a selection is being built across several queries. -->
		{#if selecting}
			<div class="chats-bulk">
				<span class="chats-bulk-count"><b>{selectedCount}</b> selected</span>
				<button
					type="button"
					class="chats-bulk-link"
					onclick={selectAllVisible}
					disabled={allVisibleSelected}
				>
					All ({visibleChats.length})
				</button>
				<button
					type="button"
					class="chats-bulk-link"
					onclick={() => (selectedIds = new Set())}
					disabled={selectedCount === 0}
				>
					None
				</button>
				<div class="chats-bulk-spacer"></div>
				<button
					type="button"
					class="chats-bulk-delete"
					onclick={() => (bulkDeleteOpen = true)}
					disabled={selectedCount === 0}
				>
					<Icon name="trash" class="w-3.5 h-3.5" />
					Delete {selectedCount}
				</button>
			</div>
		{/if}

	</header>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="chats-body"
		class:chats-body-single={singleColumn}
		bind:clientWidth={bodyWidth}
		onmouseleave={clearTwinHighlight}
	>
		<div class="chats-list-pane">
			<div
				bind:this={listEl}
				id="chats-listbox"
				class="chats-scroll chats-list panel-scroll"
				role="listbox"
				tabindex="-1"
				aria-label="Chats"
			>
				{#if isEmpty}
					<div class="chats-empty">
						<Icon name="chat" class="w-8 h-8 mb-3 opacity-60" />
						<p class="chats-empty-text">
							{#if searchQuery && searchingMessages}
								Searching messages…
							{:else if searchQuery}
								No chats match "{searchQuery}"
							{:else if filterMode === 'favorites'}
								No favorites yet
							{:else if filterMode === 'duplicates'}
								No identical chats
							{:else}
								No chats yet
							{/if}
						</p>
						{#if searchQuery && !searchInMessages}
							<button type="button" class="chats-empty-action" onclick={() => (searchInMessages = true)}>
								Search inside messages too
							</button>
						{:else if filterMode !== 'all'}
							<button type="button" class="chats-empty-action" onclick={() => (filterMode = 'all')}>
								Show all chats
							</button>
						{/if}
					</div>
				{:else}
					{#each sections as section (section.key)}
						{#if section.label}
							<!-- Hidden from the tree: a heading is not a listbox child, and the
							     group below carries the same text as its accessible name. -->
							<div class="chats-section-label" aria-hidden="true">
								{#if section.key === 'favorites'}
									<Icon name="heart" class="w-3 h-3 fill-current" />
								{/if}
								{section.label}
							</div>
						{/if}
						<div class="chats-section-body" role="group" aria-label={section.label ?? 'Chats'}>
							{#each section.chats as chat (chat.id)}
								{@const index = indexById.get(chat.id) ?? 0}
								<ChatListRow
									{chat}
									stats={stats[chat.id] ?? null}
									member={faceFor(chat)}
									isActive={chat.id === activeChatId}
									isSelected={keyboardActive && index === selectedIndex}
									twinCount={twinCounts[chat.id] ?? 0}
									twinHighlighted={!!litTwinGroup && twinGroups[chat.id] === litTwinGroup}
									snippet={hitSnippetFor(chat)}
									renaming={renamingChatId === chat.id}
									menuOpen={menu?.chatId === chat.id}
									{selecting}
									checked={selectedIds.has(chat.id)}
									onToggleSelect={() => toggleSelect(chat.id)}
									onOpen={() => selectChat(chat.id)}
									onHover={() => {
										keyboardActive = false;
										selectedIndex = index;
										hoveredChatId = chat.id;
									}}
									onMenu={(anchor) => openRowMenu(chat.id, anchor)}
									onRenameCommit={(title) => commitRename(chat.id, title)}
									onRenameCancel={endRename}
									onTwinHover={(on) => (litTwinGroup = on ? (twinGroups[chat.id] ?? null) : null)}
								/>
							{/each}
						</div>
					{/each}
				{/if}
			</div>
		</div>

		{#if !singleColumn}
			<div class="chats-preview-pane">
				<ChatPreviewPane
					chat={hoveredChat}
					stats={hoveredChat ? (stats[hoveredChat.id] ?? null) : null}
					character={hoveredCharacter}
					persona={hoveredPersona}
					onOpen={() => hoveredChat && selectChat(hoveredChat.id)}
					onRename={() => hoveredChat && startRename(hoveredChat.id)}
					onDuplicate={() => hoveredChat && handleDuplicate(hoveredChat.id)}
					onToggleFavorite={() => hoveredChat && toggleFavorite(hoveredChat.id)}
					onDelete={() => hoveredChat && deleteChat(hoveredChat.id)}
				/>
			</div>
		{/if}
	</div>

	<!-- Keyboard hints are for keyboards: on a phone the row is dead weight that only
	     adds a horizontal scrollbar. -->
	{#if !isMobile}
		<footer class="chats-footer">
			<span><kbd>Up/Down</kbd> navigate</span>
			<span><kbd>Enter</kbd> open</span>
			<span><kbd>Home/End</kbd> jump</span>
			<span><kbd>Menu</kbd> actions</span>
			<span><kbd>Esc</kbd> close</span>
		</footer>
	{/if}
</div>

{#if menu}
	{@const menuChat = chats.find((c) => c.id === menu?.chatId)}
	{#if menuChat}
		<div
			use:portalToBody
			class="chats-scrim chats-scrim-portaled"
			onclick={() => (menu = null)}
			onkeydown={(e) => {
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					menu = null;
				}
			}}
			role="button"
			tabindex="-1"
			aria-label="Close menu"
		></div>
		<div
			bind:this={menuEl}
			use:portalToBody
			class="chats-row-menu surface-float"
			role="menu"
			style="left: {menu.left}px; top: {menu.top}px;"
		>
			<button type="button" role="menuitem" class="chats-menu-item" onclick={() => selectChat(menuChat.id)}>
				<Icon name="chat" class="w-4 h-4" />
				<span>Open</span>
			</button>
			<button type="button" role="menuitem" class="chats-menu-item" onclick={() => startRename(menuChat.id)}>
				<Icon name="pencil" class="w-4 h-4" />
				<span>Rename</span>
			</button>
			<button type="button" role="menuitem" class="chats-menu-item" onclick={() => handleDuplicate(menuChat.id)}>
				<Icon name="copy" class="w-4 h-4" />
				<span>Duplicate…</span>
			</button>
			<button type="button" role="menuitem" class="chats-menu-item" onclick={() => toggleFavorite(menuChat.id)}>
				<Icon name="heart" class="w-4 h-4 {menuChat.isFavorite ? 'fill-current' : ''}" />
				<span>{menuChat.isFavorite ? 'Remove from favorites' : 'Add to favorites'}</span>
			</button>
			<div class="chats-menu-sep"></div>
			<button
				type="button"
				role="menuitem"
				class="chats-menu-item is-danger"
				onclick={() => deleteChat(menuChat.id)}
			>
				<Icon name="trash" class="w-4 h-4" />
				<span>Delete</span>
			</button>
		</div>
	{/if}
{/if}

<ConfirmDialog
	open={deleteTarget !== null}
	title="Delete chat"
	message={deleteMessage}
	confirmLabel="Delete"
	variant="danger"
	destructive
	holdMs={holdMsForBlast(deleteStats?.total ?? 0)}
	onConfirm={confirmDeleteChat}
	onCancel={() => (deleteTarget = null)}
/>

<ConfirmDialog
	open={bulkDeleteOpen}
	title="Delete {selectedCount} chat{selectedCount === 1 ? '' : 's'}"
	message={bulkDeleteMessage}
	confirmLabel="Delete {selectedCount}"
	variant="danger"
	destructive
	holdMs={holdMsForBlast(bulkDeleteStats)}
	onConfirm={confirmBulkDelete}
	onCancel={() => (bulkDeleteOpen = false)}
/>

{#if duplicateTarget}
	<DuplicateChatDialog
		open={true}
		title={duplicateTarget.chat.title}
		footprint={duplicateTarget.footprint}
		busy={duplicating}
		onConfirm={(includeMemory) => duplicateTarget && runDuplicate(duplicateTarget.chat, includeMemory)}
		onCancel={() => {
			// Escape and the backdrop reach this too, so the busy check belongs here and
			// not only on the Cancel button: dismissing a copy that is already running
			// wouldn't stop it, it would just hide it.
			if (!duplicating) duplicateTarget = null;
		}}
	/>
{/if}

{#if importPick}
	<ImportChatsDialog
		files={importPick.files}
		characterId={importPick.characterId}
		characterName={importPick.characterName}
		onClose={() => (importPick = null)}
	/>
{/if}

<input
	bind:this={chatFileInput}
	type="file"
	class="hidden"
	accept=".jsonl"
	multiple
	onchange={handlePickedChatFiles}
/>

<style>
	.chats-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		/* Transparent so the frosted overlay surface with ambient behind shows through. */
		background: transparent;
	}

	/* The controls row below the identity carries the bottom seam, so the shared
	   header keeps only its own padding here. */
	.chats-header {
		flex-shrink: 0;
		padding: 0.8rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.chats-identity-row {
		/* Deliberately compact: this header stacks two more rows below the identity
		   (scope switch, search), and the controls row carries the seam, so the
		   shared recipe's uniform height would only push them down. */
		min-height: 0;
		padding: 0 0 0.7rem;
		border-bottom: 0;
	}

	.chats-new-button {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 0.9rem;
		flex-shrink: 0;
		border: 0;
		border-radius: var(--radius-lg);
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		transition: background-color 140ms ease;
	}

	.chats-new-button:hover {
		background: var(--color-accent-hover);
	}

	/* ===== Scope switch ===== */
	/* A segmented track on the app's canonical recipe (.seg / .seg-lift in app.css),
	   scoped rather than shared because those segments are fixed-width icon squares
	   and these are two labelled halves splitting the panel. */
	.chats-scope {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
		margin-bottom: 0.6rem;
		padding: 3px;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
	}

	.chats-scope-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		min-width: 0;
		padding: 0.35rem 0.6rem;
		border: 0;
		border-radius: calc(var(--radius-lg) - 3px);
		background: transparent;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 140ms ease, color 140ms ease;
	}

	.chats-scope-btn:hover {
		color: var(--color-text-primary);
	}

	/* The canonical lifted chip. */
	.chats-scope-btn.is-active {
		background: var(--color-bg-primary);
		color: var(--color-accent);
		box-shadow: var(--shadow-sm);
	}

	.chats-scope-face {
		display: inline-flex;
		flex-shrink: 0;
		line-height: 0;
	}

	/* A long character name gives way rather than pushing its half of the track wide. */
	.chats-scope-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chats-controls {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	/* ===== Search ===== */
	/* .input-base in markup carries the border + focus ring, so the field is visible on
	   every theme instead of only while focused. */
	.chats-search {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0 0.5rem 0 0.65rem;
		height: 2.4rem;
	}

	.chats-search :global(.chats-search-icon) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.chats-search-input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		outline: none;
		font-family: var(--font-ui);
		font-size: 0.85rem;
		color: var(--color-text-primary);
	}

	.chats-search-input::placeholder {
		color: var(--color-text-muted);
	}

	.chats-search-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		flex-shrink: 0;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease, background-color 120ms ease;
	}

	.chats-search-btn:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
	}

	.chats-search-deep.is-on {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 15%, transparent);
	}

	.chats-search-spinner {
		width: 0.85rem;
		height: 0.85rem;
		flex-shrink: 0;
		border-radius: var(--radius-full);
		border: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
		border-top-color: var(--color-accent);
		animation: chats-spin 700ms linear infinite;
	}

	@keyframes chats-spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ===== Sort ===== */
	.chats-sort {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	.chats-sort-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0 0.75rem;
		height: 2.4rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		transition: background-color 130ms ease, border-color 130ms ease, color 130ms ease;
	}

	.chats-sort-btn:hover {
		color: var(--color-text-primary);
		border-color: var(--color-border);
	}

	.chats-sort-caption {
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
	}

	.chats-sort-dir {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.4rem;
		height: 2.4rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
		color: var(--color-text-secondary);
		cursor: pointer;
		flex-shrink: 0;
		transition: background-color 130ms ease, border-color 130ms ease, color 130ms ease;
	}

	.chats-sort-dir:hover {
		color: var(--color-text-primary);
		border-color: var(--color-border);
	}

	.chats-sort-menu {
		position: absolute;
		top: calc(100% + 0.4rem);
		right: 0;
		z-index: 20;
		min-width: 12rem;
		padding: 0.3rem;
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
	}

	/* ===== Filter toggles ===== */
	/* Square, same height as the sort controls they sit beside. */
	.chats-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.4rem;
		height: 2.4rem;
		flex-shrink: 0;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 130ms ease, border-color 130ms ease, color 130ms ease;
	}

	.chats-toggle:hover {
		color: var(--color-text-primary);
		border-color: var(--color-border);
	}

	.chats-toggle.is-on {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
	}

	.chats-bulk {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.6rem;
		padding: 0.4rem 0.5rem;
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-accent) 9%, transparent);
		font-family: var(--font-ui);
		font-size: 0.75rem;
	}

	.chats-bulk-count {
		color: var(--color-text-secondary);
	}
	.chats-bulk-count b {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.chats-bulk-link {
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease;
	}
	.chats-bulk-link:hover:not(:disabled) {
		color: var(--color-text-primary);
	}
	.chats-bulk-link:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.chats-bulk-spacer {
		flex: 1;
	}

	.chats-bulk-delete {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.25rem 0.6rem;
		border: 1px solid color-mix(in srgb, var(--color-error) 38%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-error) 9%, transparent);
		color: var(--color-error);
		font-weight: 600;
		cursor: pointer;
		transition: background-color 120ms ease, border-color 120ms ease;
	}
	.chats-bulk-delete:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--color-error) 60%, transparent);
		background: color-mix(in srgb, var(--color-error) 16%, transparent);
	}
	.chats-bulk-delete:disabled {
		opacity: 0.45;
		cursor: default;
	}

	/* ===== Body ===== */
	.chats-body {
		flex: 1;
		display: grid;
		grid-template-columns: minmax(17rem, 0.95fr) minmax(20rem, 1.2fr);
		min-height: 0;
	}

	/* Mobile: the preview pane isn't rendered at all, so the list takes the row. */
	.chats-body-single {
		grid-template-columns: 1fr;
	}

	.chats-body-single .chats-list-pane {
		border-right: 0;
	}

	.chats-list-pane {
		border-right: 1px solid var(--color-border-subtle);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.chats-list {
		flex: 1;
		padding: 0.35rem 0.35rem 0.6rem;
		outline: none;
	}

	.chats-preview-pane {
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: color-mix(in srgb, var(--color-bg-secondary) 30%, transparent);
	}

	.chats-section-label {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin: 0.5rem 0 0.2rem;
		padding: 0 0.6rem;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-text-muted);
	}

	.chats-section-label:first-child {
		margin-top: 0.15rem;
	}

	.chats-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 4rem 1rem;
		text-align: center;
	}

	.chats-empty-text {
		max-width: 100%;
		font-family: var(--font-ui);
		font-size: 0.85rem;
		color: var(--color-text-muted);
		/* The query is echoed here, and a long unbroken one would push the panel wide. */
		overflow-wrap: anywhere;
	}

	.chats-empty-action {
		margin-top: 0.7rem;
		padding: 0.35rem 0.7rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
		transition: color 120ms ease, border-color 120ms ease;
	}

	.chats-empty-action:hover {
		color: var(--color-text-primary);
		border-color: var(--color-border);
	}

	/* ===== Menus ===== */
	/* Click-away layer shared by the sort menu and the per-row menu. */
	.chats-scrim {
		position: fixed;
		inset: 0;
		z-index: 10;
	}

	/* The portaled pair sits on <body>, above every panel, including the assistant
	   launcher/widget at z 200, which would otherwise paint over the menu and stay
	   clickable through the scrim. Same ceiling the composer's token popup uses, and for
	   the same reason (architecture/chat-sessions.md). */
	.chats-scrim-portaled {
		z-index: 1000;
	}

	/* Fixed and portaled: the row it belongs to lives in a scroll container inside a
	   backdrop-filtered panel, which both clips fixed children and makes itself their
	   containing block (the message editor's Save menu has the same problem). */
	.chats-row-menu {
		position: fixed;
		z-index: 1001;
		width: 190px;
		padding: 0.3rem;
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
	}

	.chats-menu-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.chats-menu-item span {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chats-menu-item:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.chats-menu-item.is-active {
		color: var(--color-accent);
	}

	.chats-menu-item.is-danger:hover {
		background: color-mix(in srgb, var(--color-error) 14%, transparent);
		color: var(--color-error);
	}

	.chats-menu-sep {
		height: 1px;
		margin: 0.25rem 0.3rem;
		background: var(--color-border-subtle);
	}

	/* ===== Footer ===== */
	.chats-footer {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.55rem 0.8rem;
		border-top: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-secondary) 48%, transparent);
		overflow-x: auto;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.chats-footer kbd {
		font-family: inherit;
		padding: 0.1rem 0.35rem;
		margin-right: 0.25rem;
		background: var(--color-bg-tertiary);
		border-radius: var(--radius-sm);
		font-size: 10px;
	}

	.chats-scroll::-webkit-scrollbar {
		width: 6px;
	}

	.chats-scroll::-webkit-scrollbar-thumb {
		background: var(--color-border);
		border-radius: 9999px;
	}

	.chats-scroll::-webkit-scrollbar-thumb:hover {
		background: var(--color-text-muted);
	}

	/* The controls row wraps rather than overflowing once the panel gets narrow. The
	   single-column switch is NOT here: it is decided from the panel's measured width
	   (see `singleColumn`), because this query would be answering about the window. */
	@media (max-width: 900px) {
		.chats-controls {
			flex-wrap: wrap;
		}
	}

	/* Fingers get bigger targets, the same bump the browse controls take (app.css). */
	@media (pointer: coarse) {
		.chats-search-btn {
			width: 2.15rem;
			height: 2.15rem;
		}

		.chats-search {
			height: 2.75rem;
		}

		.chats-toggle,
		.chats-sort-dir {
			width: 2.75rem;
			height: 2.75rem;
		}

		.chats-sort-btn {
			height: 2.75rem;
		}

		.chats-scope-btn {
			padding: 0.6rem;
		}
	}
</style>
