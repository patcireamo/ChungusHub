import type { Chat, Message, MessageNode, ChatState, ChatStream } from '$lib/types/chat';
import {
	normalizeChatFeatureState,
	pushSteeringHistoryEntry,
	type ChatFeatureState,
	type ImpersonatePerspective
} from '$lib/types/chat';
import { db } from '$lib/services/database';
import { buildMessageTree, findActivePath } from '$lib/utils/message-tree';
import { formatDate } from '$lib/utils/date';
import { convertSillyTavernChat } from '$lib/services/sillyTavernChatImport';
import { toastStore } from '$lib/stores/toast.svelte';
import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
import { lorebookStore } from '$lib/lorebook/store.svelte';
import { chatCastStore } from '$lib/stores/chatCast.svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import { memoryStore } from '$lib/memory/store.svelte';

class ChatStore {
	chats = $state<Chat[]>([]);
	activeChatId = $state<string | null>(null);
	currentChatState = $state<ChatState | null>(null);
	/** The one generation in flight, tagged with the chat that owns it. Null when idle. */
	stream = $state<ChatStream | null>(null);
	/** A sync hint that arrived mid-stream, replayed once the stream ends. */
	private missedSyncWhileStreaming = false;

	activeChat = $derived(this.chats.find((c) => c.id === this.activeChatId) ?? null);
	sortedChats = $derived([...this.chats].sort((a, b) => b.updatedAt - a.updatedAt));

	/** The in-flight generation only when the chat on screen is the one that owns it:
	 *  everything the transcript is allowed to paint. Null while a reply streams into a
	 *  chat the reader has left, which is what keeps those tokens out of this one. */
	visibleStream = $derived(
		this.stream && this.stream.chatId === this.currentChatState?.chat.id ? this.stream : null
	);

	// Title scheme: "<character name> - YYYY-MM-DD", carrying the app's one numeric date
	// shape rather than a second recipe. The character anchors whose story it is wherever
	// a title shows on its own; the creation date sets chats apart. Year-first is doing
	// more than reading unambiguously here: a title is a STORED string, so the chats
	// panel's Title sort compares it as text, and this is what makes that sort group by
	// character and then run chronologically inside each one.
	// A missing or unnamed entry falls back to just the date.
	private generateChatTitle(characterId: string, when: number = Date.now()): string {
		const datePrefix = formatDate(when);

		const name = characterLibraryStore.entries
			.find((e) => e.id === characterId)
			?.identity.name?.trim();

		return name ? `${name} - ${datePrefix}` : datePrefix;
	}

	/** Load the global chat list. Boot always lands on the welcome screen with no
	 *  active chat (a character only becomes active once the user actually opens a
	 *  chat), so we deliberately don't auto-select or restore one here. */
	async loadAllChats(): Promise<void> {
		this.chats = await db.getAllChats();
		this.activeChatId = null;
		this.currentChatState = null;
		memoryStore.clear();
	}

	/** Create a chat bound to a library character (ST-style). Always a fresh
	 *  chat: a story never exists without a character, so the id is required. */
	async createChat(options: { characterId: string }): Promise<string> {
		const now = Date.now();
		const { characterId } = options;
		// Pin the chat to the character's active version at birth: the story keeps the
		// exact variant it started with, however far the character moves on. Unversioned
		// characters pin nothing (null = follow live data, the pre-version behavior).
		const characterVersionId =
			characterLibraryStore.entries.find((e) => e.id === characterId)?.activeVersionId ?? null;
		const chat: Chat = {
			id: crypto.randomUUID(),
			title: this.generateChatTitle(characterId),
			createdAt: now,
			updatedAt: now,
			rootMessageId: null,
			activeLeafId: null,
			canonLeafId: null,
			settings: null,
			characterId,
			characterVersionId,
			isFavorite: false,
			featureState: null
		};

		await db.insertChat(chat);
		this.chats = [chat, ...this.chats];
		chatCastStore.setForChat(chat.id, characterId);
		// The chat opens on its greeting: the First Message becomes message 1 and any
		// alternate greetings become its sibling branches (swipeable).
		await this.seedCharacterGreetings(chat, characterId);
		await this.selectChat(chat.id);

		return chat.id;
	}

	/** Lay down the character's First Message + alternate greetings as root-level sibling
	 *  branches, so the chat opens on a greeting the user can swipe between. Records the list
	 *  on the chat as well: a chat still holding exactly it and nothing else is a mirror of the
	 *  card, and a later card edit reaches it (architecture/chat-sessions.md). That record is
	 *  written even for a character with no greetings at all: the empty claim is what lets a
	 *  card that later gains an opening reach the empty chat. */
	private async seedCharacterGreetings(chat: Chat, characterId: string): Promise<void> {
		const entry = characterLibraryStore.entries.find(
			(e) => e.id === characterId && e.type === 'character'
		);
		if (!entry) return;

		const greetings = [entry.data.traits.firstMessage ?? '', ...(entry.data.alternateGreetings ?? [])]
			.map((g) => g.trim())
			.filter((g) => g.length > 0);
		await db.setChatSeededGreetings(chat.id, greetings);
		if (greetings.length === 0) return;

		const now = Date.now();

		let rootId: string | null = null;
		for (let i = 0; i < greetings.length; i++) {
			const message: Message = {
				id: crypto.randomUUID(),
				chatId: chat.id,
				parentId: null,
				role: 'assistant',
				// Store greetings RAW: {{char}}/{{user}} stay literal and resolve live at
				// display and generation, so changing persona reflows the greeting too.
				content: greetings[i],
				personaId: null,
				branchLabel: null,
				thinking: null,
				attachments: null,
				createdAt: now + i,
				editedAt: null,
				minorEditedAt: null,
				spriteLabel: null,
				model: null,
				provider: null,
				tokensPrompt: null,
				tokensCompletion: null,
				finishReason: null,
				generationMs: null,
				firstTokenMs: null,
				reasoningMs: null,
				// A greeting comes off the card, not out of a generation: no prompt, no scan.
				lorebook: null,
				siblingIndex: i
			};
			await db.insertMessage(message);
			if (i === 0) rootId = message.id;
		}

		if (rootId) {
			await db.updateChat(
				{ id: chat.id, rootMessageId: rootId, activeLeafId: rootId },
				{ touchUpdatedAt: true }
			);
			chat.rootMessageId = rootId;
			chat.activeLeafId = rootId;
		}
	}

	/** Import a SillyTavern chat (.jsonl, already split into lines) as a new chat bound to
	 *  `characterId`. Builds the whole message tree in one shot, with swipes becoming sibling
	 *  branches and the chosen swipe carrying the active path (see convertSillyTavernChat), then
	 *  writes it straight to the db, the same store-owns-the-tree pattern as
	 *  seedCharacterGreetings. Does NOT open the chat (bulk import). Returns the new chat id,
	 *  or null when the file held no importable messages. */
	async importSillyTavernChat(options: {
		characterId: string;
		lines: string[];
	}): Promise<{ chatId: string | null }> {
		const { characterId, lines } = options;
		const characterVersionId =
			characterLibraryStore.entries.find((e) => e.id === characterId)?.activeVersionId ?? null;

		const now = Date.now();
		const chatId = crypto.randomUUID();
		const converted = convertSillyTavernChat(lines, { chatId, baseTime: now });

		if (converted.messages.length === 0 || !converted.rootMessageId) {
			return { chatId: null };
		}

		// Anchor the chat's dates to the conversation itself: created at its first turn,
		// last touched at its last, so imported stories sort by when they were actually played.
		const createdAt = converted.messages[0].createdAt;
		const updatedAt = converted.messages[converted.messages.length - 1].createdAt;
		// Insert the chat with null root/leaf first: chats.root_message_id references a
		// message row, so the messages must land before we can point at them (same
		// ordering as createChat → seedCharacterGreetings).
		const chat: Chat = {
			id: chatId,
			title: this.generateChatTitle(characterId, createdAt),
			createdAt,
			updatedAt,
			rootMessageId: null,
			activeLeafId: null,
			canonLeafId: null,
			settings: null,
			characterId,
			characterVersionId,
			isFavorite: false,
			featureState: null
		};

		await db.insertChat(chat);
		// Rows are already parent-first (roots emitted before their children), so the
		// foreign-key parent_id references resolve as we go.
		for (const message of converted.messages) {
			await db.insertMessage(message);
		}
		await db.updateChat(
			{ id: chatId, rootMessageId: converted.rootMessageId, activeLeafId: converted.activeLeafId },
			{ touchUpdatedAt: false }
		);
		chat.rootMessageId = converted.rootMessageId;
		chat.activeLeafId = converted.activeLeafId;

		this.chats = [chat, ...this.chats];
		chatCastStore.setForChat(chatId, characterId);

		return { chatId };
	}

	/** Close the open chat and land on the welcome screen, the same zero state as
	 *  boot: no active chat, no loaded chat state, memory cleared (story map and
	 *  memory panels then show their no-chat states). Callers must check
	 *  `messageStore.warnIfBusy()` first: this store can't import messageStore
	 *  (import cycle), and nulling `currentChatState` mid-generation would orphan
	 *  the stream that writes into it. */
	async goHome(): Promise<void> {
		if (!this.activeChatId) {
			uiStore.openWelcome();
			return;
		}
		// Persist any pending lorebook edits before leaving, same as selectChat.
		await lorebookStore.flush();
		this.activeChatId = null;
		this.currentChatState = null;
		memoryStore.clear();
		uiStore.openWelcome();
	}

	async selectChat(chatId: string): Promise<void> {
		// Opening a chat is the sole trigger that retires the landing screen, and it runs
		// before the early-return, so re-selecting the active chat still dismisses it.
		uiStore.dismissWelcome();
		// Opening any chat also ends an in-flight New chat wizard: either this IS
		// its final step, or the user wandered into an existing story and abandoned it.
		uiStore.clearNewChat();
		if (this.activeChatId === chatId && this.currentChatState) return;
		// Persist any pending lorebook edits before leaving.
		await lorebookStore.flush();
		this.activeChatId = chatId;
		await this.loadChatState(chatId);
	}

	async loadChatState(chatId: string): Promise<void> {
		const chat = await db.getChat(chatId);
		if (!chat) {
			throw new Error(`Chat ${chatId} not found`);
		}

		const messages = await db.getMessagesByChat(chatId);
		const messageTree = chat.rootMessageId ? buildMessageTree(messages, chat.activeLeafId) : null;
		const activePath = chat.activeLeafId ? findActivePath(messages, chat.activeLeafId) : [];

		this.currentChatState = {
			chat,
			messageTree,
			activePath,
			allMessages: messages
		};

		// Chat memory (non-blocking): load it when the chat changes, then re-sync the
		// archive boundary for the current active path so the ghost markers stay correct
		// after swipes/branches/edits. No-op when memory is off for this chat.
		void this.refreshMemory(chat, messages);
	}

	private async refreshMemory(chat: Chat, messages: Message[]): Promise<void> {
		try {
			if (memoryStore.activeChatId !== chat.id) await memoryStore.loadForChat(chat.id);
			await memoryStore.syncForPath({
				chatId: chat.id,
				allMessages: messages,
				leafId: chat.activeLeafId,
				characterId: chat.characterId,
				characterVersionId: chat.characterVersionId
			});
		} catch (e) {
			console.error('[memory] refresh failed:', e);
		}
	}

	// Called when another device changed chats/messages. Reloads the chat list
	// and the open chat without disturbing an in-progress local stream.
	async syncReload(): Promise<void> {
		// A reload mid-stream would yank the tree out from under the tokens still arriving,
		// so it waits. But the hint is not repeated, so remember it and replay when the
		// stream ends. Dropping it outright left this device stale until the NEXT remote
		// change, which may never come.
		if (this.stream) {
			this.missedSyncWhileStreaming = true;
			return;
		}
		// Captured before the reload swaps the list out. It routes where we land if the
		// active chat turns out to have vanished in the sync.
		const prevCharacterId = this.activeChat?.characterId ?? null;
		this.chats = await db.getAllChats();
		if (this.chats.length === 0) {
			if (this.activeChatId) uiStore.openWelcome();
			this.activeChatId = null;
			this.currentChatState = null;
			memoryStore.clear();
			return;
		}
		if (this.activeChatId) {
			if (this.chats.some((c) => c.id === this.activeChatId)) {
				await this.refreshCurrentChat();
			} else {
				// The active chat was deleted elsewhere. Fall to another chat of
				// the same character when one survives, else land on welcome: a sync
				// must neither invent new rows nor teleport into an unrelated story.
				const sibling = prevCharacterId
					? this.sortedChats.find((c) => c.characterId === prevCharacterId)
					: undefined;
				if (sibling) {
					await this.selectChat(sibling.id);
				} else {
					this.activeChatId = null;
					this.currentChatState = null;
					memoryStore.clear();
					uiStore.openWelcome();
				}
			}
		}
	}

	/** Re-read `chatId`: the open transcript when that chat is the one on screen, and its
	 *  row in the chat list either way. The generation paths call this with the chat that
	 *  OWNS the stream rather than refreshCurrentChat, because a reply lands long after it
	 *  was asked for and the reader is free to be elsewhere by then. Refreshing whatever
	 *  is active would leave the chat that actually changed sitting in the list at its old
	 *  time and position, while re-reading a transcript nothing touched. */
	async refreshChat(chatId: string): Promise<void> {
		if (this.activeChatId === chatId) await this.loadChatState(chatId);
		const chat = await db.getChat(chatId);
		if (chat) this.chats = this.chats.map((c) => (c.id === chat.id ? chat : c));
	}

	/** The open chat, used by the instant mutations, which cannot span a navigation. */
	async refreshCurrentChat(): Promise<void> {
		if (this.activeChatId) await this.refreshChat(this.activeChatId);
	}

	/**
	 * Delete a chat, immediately and for good: rows, attachment files and chat-scoped
	 * steering notes go in one server call. The asking happened BEFORE this, in the chats
	 * panel's confirm dialog, which states the real message count (the destructive-act
	 * ladder, architecture/ui-shell-settings.md), so this method only refuses the one case no
	 * dialog can cover: a reply still streaming into the very rows about to go.
	 */
	async deleteChat(chatId: string): Promise<void> {
		const chat = this.chats.find((c) => c.id === chatId);
		if (!chat) return;

		if (this.stream?.chatId === chatId) {
			toastStore.warning('A reply is still generating in this chat. Wait for it, or stop it first.');
			return;
		}

		// Server first: if the delete fails, nothing on screen has lied about it.
		try {
			await db.deleteChat(chatId);
		} catch (e) {
			toastStore.failed(`delete "${chat.title}"`, e);
			return;
		}
		const wasActive = this.activeChatId === chatId;
		this.chats = this.chats.filter((c) => c.id !== chatId);
		chatCastStore.removeChat(chatId);
		if (wasActive) await this.routeAfterDelete(chat);
	}

	/**
	 * Delete several chats in one pass, immediately and for good. Deliberately NOT a loop
	 * over `deleteChat`: that re-routes the open chat once per row, so a batch containing
	 * the chat you are in can land you inside another chat that is itself still about to
	 * go, and it would refuse the whole selection over one streaming reply. Here the
	 * refusal is per row and the routing happens once, after everything that could go has.
	 *
	 * The asking happened BEFORE this, once, for the whole batch: the chats panel's confirm
	 * states the real chat and message counts (the destructive-act ladder,
	 * architecture/ui-shell-settings.md).
	 */
	async deleteChats(chatIds: string[]): Promise<void> {
		const ids = new Set(chatIds);
		const targets = this.chats.filter((c) => ids.has(c.id));
		if (targets.length === 0) return;

		// One live reply costs its own chat, not the other nineteen.
		const streaming = this.stream ? targets.find((c) => c.id === this.stream?.chatId) : undefined;
		const deletable = streaming ? targets.filter((c) => c.id !== streaming.id) : targets;

		// Server first, row by row: a failure stops the pass with the list still telling the
		// truth about what is left, rather than clearing rows the server kept.
		const gone: string[] = [];
		let failure: { title: string; cause: unknown } | null = null;
		for (const chat of deletable) {
			try {
				await db.deleteChat(chat.id);
				gone.push(chat.id);
			} catch (e) {
				failure = { title: chat.title, cause: e };
				break;
			}
		}

		const wasActive = this.activeChatId !== null && gone.includes(this.activeChatId);
		const active = wasActive ? targets.find((c) => c.id === this.activeChatId) : undefined;
		const goneSet = new Set(gone);
		this.chats = this.chats.filter((c) => !goneSet.has(c.id));
		for (const id of gone) chatCastStore.removeChat(id);
		if (active) await this.routeAfterDelete(active);

		// The vanished rows say the delete happened. These two say what the rows cannot:
		// one chat the batch could not touch, and one that refused.
		if (streaming) {
			toastStore.warning(`"${streaming.title}" was kept: a reply is still generating in it`);
		}
		if (failure) toastStore.failed(`delete "${failure.title}"`, failure.cause);
	}

	/**
	 * Where the reader lands after the chat they were in was deleted. Stays inside its
	 * story: a character chat falls to that character's next-most-recent chat, and a living
	 * character never drops to zero chats: deleting its last one respawns a fresh chat
	 * (greetings and all). Chats without a living character (characterless, or orphaned by a
	 * character deletion) return to the welcome landing, never teleport into an unrelated
	 * story. Called with the row already out of `this.chats`, so the sibling search cannot
	 * pick what was just deleted.
	 */
	private async routeAfterDelete(chat: Chat): Promise<void> {
		// The living bound character, or null when the chat had none / it was deleted.
		const characterId =
			chat.characterId !== null &&
			characterLibraryStore.entries.some((e) => e.id === chat.characterId)
				? chat.characterId
				: null;
		const sibling = characterId
			? this.sortedChats.find((c) => c.characterId === characterId)
			: undefined;
		if (sibling) {
			await this.selectChat(sibling.id);
		} else if (characterId) {
			await this.createChat({ characterId });
		} else {
			this.activeChatId = null;
			this.currentChatState = null;
			memoryStore.clear();
			uiStore.openWelcome();
		}
	}

	/** Repin the chat to another version of its bound character. This is the whole
	 *  switch: from here on EVERY request this chat makes (story turns, memory,
	 *  opening scene) plays against the new variant, and the library's own active
	 *  version has no say. Fully reversible: versions are parked rows, so
	 *  this only moves a pointer; nothing already written changes. */
	async setChatCharacterVersion(chatId: string, versionId: string): Promise<void> {
		await db.updateChat({ id: chatId, characterVersionId: versionId }, { touchUpdatedAt: false });
		this.chats = this.chats.map((c) => (c.id === chatId ? { ...c, characterVersionId: versionId } : c));
		if (this.currentChatState?.chat.id === chatId) {
			this.currentChatState = {
				...this.currentChatState,
				chat: { ...this.currentChatState.chat, characterVersionId: versionId }
			};
		}
	}

	/** Bless (or clear, with null) a node as the canonical timeline's tip for the current
	 *  chat. Pure story-map metadata: it never moves the active leaf or touches content, so
	 *  it doesn't bump the chat's activity order. */
	async setCanonLeaf(leafId: string | null): Promise<void> {
		if (!this.currentChatState) return;
		const chatId = this.currentChatState.chat.id;
		await db.updateChat({ id: chatId, canonLeafId: leafId }, { touchUpdatedAt: false });
		await this.refreshCurrentChat();
	}

	async updateChatTitle(chatId: string, title: string): Promise<void> {
		await db.updateChat({ id: chatId, title });
		this.chats = this.chats.map((c) => (c.id === chatId ? { ...c, title } : c));
		if (this.currentChatState?.chat.id === chatId) {
			this.currentChatState = {
				...this.currentChatState,
				chat: { ...this.currentChatState.chat, title }
			};
		}
	}

	/** Star/unstar a chat. Deliberately does not touch updatedAt (server-side too): a
	 *  star is bookkeeping, not activity, and must not reshuffle the list under the user. */
	async toggleChatFavorite(chatId: string): Promise<void> {
		const chat = this.chats.find((c) => c.id === chatId);
		if (!chat) return;
		const isFavorite = !chat.isFavorite;
		await db.updateChatFavorite(chatId, isFavorite);
		this.chats = this.chats.map((c) => (c.id === chatId ? { ...c, isFavorite } : c));
		if (this.currentChatState?.chat.id === chatId) {
			this.currentChatState = {
				...this.currentChatState,
				chat: { ...this.currentChatState.chat, isFavorite }
			};
		}
	}

	/** Copy a chat into a new one and drop it at the top of the list. The copy itself is
	 *  one server-side transaction (`db.duplicateChat`: whole message forest, branch
	 *  labels, pointers, feature state, memory on request); this only pulls the finished
	 *  row into the list so nothing has to reload. Deliberately does NOT open the copy:
	 *  duplicating is a filing action, and yanking the user out of what they were reading
	 *  would be a different one. Returns the new chat's id. */
	async duplicateChat(chatId: string, options: { includeMemory: boolean }): Promise<string> {
		const source = this.chats.find((c) => c.id === chatId);
		if (!source) throw new Error(`duplicateChat: no chat with id ${chatId}`);

		const newChatId = await db.duplicateChat({
			chatId,
			title: this.copyTitle(source.title),
			includeMemory: options.includeMemory
		});
		const chat = await db.getChat(newChatId);
		if (!chat) throw new Error(`duplicateChat: server made ${newChatId} but it can't be read back`);

		// A sync landing between the copy and this prepend would already have pulled the
		// new row in; adding it again puts two rows with one id into every keyed list.
		if (!this.chats.some((c) => c.id === chat.id)) this.chats = [chat, ...this.chats];
		chatCastStore.setForChat(chat.id, chat.characterId);
		// The copy's user turns carry the source's persona ids, but the cast index is only
		// built from a db sweep at load, so seed it here or the new row shows no face until
		// the next reload.
		chatCastStore.setPersonaForChat(chat.id, chatCastStore.personaForChat(chatId)?.libraryEntryId ?? null);
		return newChatId;
	}

	/** "<title> (copy)", counting up when that name is taken: duplicating twice must
	 *  not leave two rows nothing can tell apart. Re-copying a copy re-uses the base
	 *  name instead of stacking "(copy) (copy)". */
	private copyTitle(title: string): string {
		const base = title.replace(/\s*\(copy(?: \d+)?\)$/, '');
		const taken = new Set(this.chats.map((c) => c.title));
		let candidate = `${base} (copy)`;
		for (let n = 2; taken.has(candidate); n++) candidate = `${base} (copy ${n})`;
		return candidate;
	}

	/**
	 * Reflect a character deletion in the in-memory chat state: the DB rows were
	 * already unbound (characterId → null), so mirror that here instead of leaving the
	 * store pointing at a gone entry until the next reload.
	 */
	unbindCharacterFromChats(chatIds: string[]): void {
		if (chatIds.length === 0) return;
		const idSet = new Set(chatIds);
		this.chats = this.chats.map((c) =>
			idSet.has(c.id) ? { ...c, characterId: null, characterVersionId: null } : c
		);
		if (this.currentChatState && idSet.has(this.currentChatState.chat.id)) {
			this.currentChatState = {
				...this.currentChatState,
				chat: { ...this.currentChatState.chat, characterId: null, characterVersionId: null }
			};
		}
		for (const id of chatIds) chatCastStore.setForChat(id, null);
	}

	/** Open the stream for `chatId`. `continuingMessageId` routes it into an existing
	 *  assistant bubble (the continue flow) instead of the streaming-indicator bubble;
	 *  `openingScene` says the tokens are a new beginning rather than the next turn. Named
	 *  options rather than positional flags: `startStream(id, null, true)` says nothing. */
	startStream(
		chatId: string,
		opts: { continuingMessageId?: string; openingScene?: boolean } = {}
	): void {
		this.stream = {
			chatId,
			content: '',
			thinking: '',
			continuingMessageId: opts.continuingMessageId ?? null,
			openingScene: opts.openingScene ?? false
		};
	}

	/** Close the stream. Every caller does this in a `finally`, after its own message is
	 *  committed, so a deferred sync reload reads a settled tree. */
	endStream(): void {
		this.stream = null;
		if (this.missedSyncWhileStreaming) {
			this.missedSyncWhileStreaming = false;
			void this.syncReload();
		}
	}

	// Tokens land on the stream record itself, which already names its owner, so they
	// reach the chat that asked for them however far the reader has wandered.
	appendStreamingContent(content: string): void {
		if (this.stream) this.stream.content += content;
	}

	appendStreamingThinking(thinking: string): void {
		if (this.stream) this.stream.thinking += thinking;
	}

	// ===== Chat feature state (steering reuse history + impersonate) =====

	private featureStateQueues = new Map<string, Promise<void>>();

	private loadedChatRow(chatId: string): Chat | undefined {
		if (this.currentChatState?.chat.id === chatId) return this.currentChatState.chat;
		return this.chats.find((c) => c.id === chatId);
	}

	/** Normalized read of a chat's steering/impersonate state. Reactive for the active
	 *  chat, where it reads off currentChatState, so a $derived over this re-runs when it
	 *  changes; falls back to the chat-list copy for a background chat, and to the
	 *  defaults when neither is loaded. */
	featureState(chatId: string): ChatFeatureState {
		return normalizeChatFeatureState(this.loadedChatRow(chatId)?.featureState ?? null);
	}

	/** Freshest feature state for `chatId`: in-memory when loaded, else a direct db read,
	 *  so a background writer never merges onto a stale snapshot. Only call from inside
	 *  queueFeatureStateWrite so concurrent writers stay serialized. */
	private async freshFeatureState(chatId: string): Promise<ChatFeatureState> {
		const loaded = this.loadedChatRow(chatId);
		if (loaded) return normalizeChatFeatureState(loaded.featureState);
		const chat = await db.getChat(chatId);
		return normalizeChatFeatureState(chat?.featureState ?? null);
	}

	/** Persist `next` and optimistically mirror it onto whichever of currentChatState /
	 *  the chat-list copy is loaded. */
	private async writeFeatureState(chatId: string, next: ChatFeatureState): Promise<void> {
		const raw = JSON.stringify(next);
		await db.updateChat({ id: chatId, featureState: raw });
		if (this.currentChatState?.chat.id === chatId) {
			this.currentChatState = {
				...this.currentChatState,
				chat: { ...this.currentChatState.chat, featureState: raw }
			};
		}
		this.chats = this.chats.map((c) => (c.id === chatId ? { ...c, featureState: raw } : c));
	}

	/** Runs `task` after every previously queued feature-state write for this chat
	 *  finishes, so read-merge-write cycles (updateChatFeatureState, pushSteeringHistory)
	 *  can't clobber each other. */
	private queueFeatureStateWrite(chatId: string, task: () => Promise<void>): Promise<void> {
		const prev = this.featureStateQueues.get(chatId) ?? Promise.resolve();
		const run = prev.then(task);
		// Keep the chain alive even when a write rejects, then re-throw to the caller.
		this.featureStateQueues.set(chatId, run.catch(() => undefined));
		return run;
	}

	/** Read-merge-write a partial patch onto a chat's feature state. */
	async updateChatFeatureState(chatId: string, patch: Partial<ChatFeatureState>): Promise<void> {
		return this.queueFeatureStateWrite(chatId, async () => {
			const current = await this.freshFeatureState(chatId);
			await this.writeFeatureState(chatId, { ...current, ...patch });
		});
	}

	/** Record the texts of one-shot steering notes that were just spent, newest last, so
	 *  the composer's Recent list can re-arm them. Called by generation code right after
	 *  `steeringStore.consumeOnce`. The notes themselves live in their own table
	 *  (src/lib/types/steering.ts); this is only the per-chat reuse list. No-op for an
	 *  empty list, so a turn with no one-shot never touches the row. */
	async pushSteeringHistory(chatId: string, texts: string[]): Promise<void> {
		if (texts.length === 0) return;
		return this.queueFeatureStateWrite(chatId, async () => {
			const current = await this.freshFeatureState(chatId);
			let history = current.steeringHistory;
			for (const text of texts) history = pushSteeringHistoryEntry(history, text);
			await this.writeFeatureState(chatId, { ...current, steeringHistory: history });
		});
	}

	async setImpersonatePerspective(chatId: string, perspective: ImpersonatePerspective): Promise<void> {
		return this.updateChatFeatureState(chatId, { impersonatePerspective: perspective });
	}
}

export const chatStore = new ChatStore();
