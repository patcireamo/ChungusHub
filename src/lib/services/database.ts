/**
 * Client database service.
 *
 * Every call forwards to the server's DatabaseService over the HTTP RPC bridge. The real
 * SQL (and the single source of truth) lives on the server; this is a thin, typed proxy,
 * so nothing above it knows where the data comes from.
 */
import type { Chat, ChatListStats, ChatMemoryFootprint, Message, BranchLabel } from '$lib/types/chat';
import type { CharacterVersion, LibraryEntry } from '$lib/types/library';
import type { Lorebook } from '$lib/lorebook/types';
import type { SteeringNote } from '$lib/types/steering';
import type { AssistantSession, AssistantMessage } from '$lib/types/assistant';
import type { BatchResult, Episode, MemoryState, PromotionResult } from '$lib/memory/types';
import type { UserStats } from '$lib/types/stats';
import { connectWs, dbRpc } from '$lib/services/transport';

class DatabaseService {
	async initialize(): Promise<void> {
		// The schema is created and migrated server-side; here we just make sure the
		// live-sync socket is up before the app starts reading data.
		await connectWs();
	}

	private call<T>(method: string, ...args: unknown[]): Promise<T> {
		return dbRpc(method, args) as Promise<T>;
	}

	// ===== CHATS =====
	getAllChats(): Promise<Chat[]> { return this.call('getAllChats'); }
	getChat(id: string): Promise<Chat | null> { return this.call('getChat', id); }
	insertChat(chat: Chat): Promise<void> { return this.call('insertChat', chat); }
	/** An imported chat and its whole message forest in one atomic call. `messages` must be
	 *  parent-first. Never a loop of `insertChat` + `insertMessage`: that is one round trip and
	 *  one sync hint per turn, and it can leave a pointerless chat behind if it stops halfway. */
	importChat(chat: Chat, messages: Message[]): Promise<void> {
		return this.call('importChat', chat, messages);
	}
	updateChat(chat: Partial<Chat> & { id: string }, options: { touchUpdatedAt?: boolean } = {}): Promise<void> {
		return this.call('updateChat', chat, options);
	}
	updateChatActiveLeaf(chatId: string, leafId: string | null, options: { touchUpdatedAt?: boolean } = {}): Promise<void> {
		return this.call('updateChatActiveLeaf', chatId, leafId, options);
	}
	touchChatActivity(chatId: string): Promise<void> { return this.call('touchChatActivity', chatId); }
	updateChatFavorite(chatId: string, isFavorite: boolean): Promise<void> {
		return this.call('updateChatFavorite', chatId, isFavorite);
	}
	/** Record what the character card handed this chat, so a later card edit can tell a chat
	 *  that is still only that opening from one holding a story (architecture/chat-sessions.md).
	 *  Write-only from here: nothing on the client reads it back, so it is not on `Chat`. */
	setChatSeededGreetings(chatId: string, greetings: string[]): Promise<void> {
		return this.call('setChatSeededGreetings', chatId, greetings);
	}
	/** Deep-copies the chat and its whole message forest server-side (one transaction);
	 *  memory comes along only when asked. Returns the new chat's id. */
	duplicateChat(options: { chatId: string; title: string; includeMemory: boolean }): Promise<string> {
		return this.call('duplicateChat', options);
	}
	/** Per-chat row data for the chats panel: one server-side pass, no message bodies. */
	getChatListStats(): Promise<Record<string, ChatListStats>> { return this.call('getChatListStats'); }
	/** chatId → a key shared by every chat with a byte-identical message tree. Only
	 *  chats that actually have a twin appear. */
	getChatContentGroups(): Promise<Record<string, string>> { return this.call('getChatContentGroups'); }
	/** Chats whose ACTIVE branch contains every term, with a snippet around the newest hit. */
	searchChatMessages(query: string): Promise<Record<string, { hits: number; snippet: string }>> {
		return this.call('searchChatMessages', query);
	}
	/** The whole-library aggregate behind the stats screen: one server-side pass over every
	 *  message, no bodies over the wire. Expensive by nature, so call it when the screen
	 *  opens and never on a render. */
	getUserStats(): Promise<UserStats> { return this.call('getUserStats'); }
	getChatMemoryFootprint(chatId: string): Promise<ChatMemoryFootprint> {
		return this.call('getChatMemoryFootprint', chatId);
	}
	deleteChat(chatId: string): Promise<void> { return this.call('deleteChat', chatId); }

	// ===== MESSAGES =====
	getMessagesByChat(chatId: string): Promise<Message[]> { return this.call('getMessagesByChat', chatId); }
	getMessageCounts(): Promise<Record<string, number>> { return this.call('getMessageCounts'); }
	getLastUserMessageTimes(): Promise<Record<string, number>> { return this.call('getLastUserMessageTimes'); }
	getLastPersonaByChat(): Promise<Record<string, string>> { return this.call('getLastPersonaByChat'); }
	getMessage(id: string): Promise<Message | null> { return this.call('getMessage', id); }
	insertMessage(message: Message): Promise<void> { return this.call('insertMessage', message); }
	/** `minor: true` records the touch without advancing `edited_at`, so the summary covering
	 *  this turn survives it (architecture/memory.md). */
	updateMessageContent(messageId: string, content: string, opts?: { minor?: boolean }): Promise<void> {
		return this.call('updateMessageContent', messageId, content, opts);
	}
	/** Continuation write: joined content + accumulated stats, edited_at untouched. Carries no
	 *  `firstTokenMs`: the turn started speaking on the run that created it, so a continuation
	 *  must never rewrite that stamp. */
	applyMessageContinuation(
		messageId: string,
		patch: {
			content: string;
			thinking: string | null;
			tokensPrompt: number | null;
			tokensCompletion: number | null;
			finishReason: string | null;
			generationMs: number | null;
			reasoningMs: number | null;
		}
	): Promise<void> {
		return this.call('applyMessageContinuation', messageId, patch);
	}
	setChatUserPersona(chatId: string, personaId: string | null): Promise<void> {
		return this.call('setChatUserPersona', chatId, personaId);
	}
	updateMessageBranchLabel(messageId: string, label: BranchLabel | null): Promise<void> {
		return this.call('updateMessageBranchLabel', messageId, label);
	}
	updateMessageSpriteLabel(messageId: string, label: string | null): Promise<void> {
		return this.call('updateMessageSpriteLabel', messageId, label);
	}
	deleteMessageOnly(messageId: string): Promise<void> { return this.call('deleteMessageOnly', messageId); }
	deleteMessageAndDescendants(messageId: string): Promise<void> { return this.call('deleteMessageAndDescendants', messageId); }
	deleteDescendants(messageId: string): Promise<void> { return this.call('deleteDescendants', messageId); }
	getNextSiblingIndex(chatId: string, parentId: string | null): Promise<number> { return this.call('getNextSiblingIndex', chatId, parentId); }

	// ===== SETTINGS =====
	getSetting(key: string): Promise<string | null> { return this.call('getSetting', key); }
	setSetting(key: string, value: string): Promise<void> { return this.call('setSetting', key, value); }
	deleteSetting(key: string): Promise<void> { return this.call('deleteSetting', key); }

	// ===== CHAT DRAFTS =====
	getChatDraft(chatId: string): Promise<{ chatId: string; content: string; updatedAt: number } | null> {
		return this.call('getChatDraft', chatId);
	}
	upsertChatDraft(chatId: string, content: string): Promise<void> {
		return this.call('upsertChatDraft', chatId, content);
	}
	deleteChatDraft(chatId: string): Promise<void> { return this.call('deleteChatDraft', chatId); }

	// ===== INPUT HISTORY =====
	getInputHistory(limit: number): Promise<{ id: number; chatId: string | null; content: string }[]> {
		return this.call('getInputHistory', limit);
	}
	addInputHistory(chatId: string | null, content: string, cap: number): Promise<void> {
		return this.call('addInputHistory', chatId, content, cap);
	}
	clearInputHistory(): Promise<void> { return this.call('clearInputHistory'); }

	// ===== IMPORT SOURCES =====
	getImportedSources(): Promise<{ key: string; entityId: string | null }[]> {
		return this.call('getImportedSources');
	}
	recordImportedSources(claims: { key: string; entityId?: string | null }[]): Promise<void> {
		return this.call('recordImportedSources', claims);
	}

	// ===== CONNECTION CREDENTIALS =====
	getConnectionCredentials(connectionId: string): Promise<{ provider: string; apiKey: string; baseUrl: string | null } | null> {
		return this.call('getConnectionCredentials', connectionId);
	}
	setConnectionCredentials(connectionId: string, provider: string, apiKey: string, baseUrl?: string): Promise<void> {
		return this.call('setConnectionCredentials', connectionId, provider, apiKey, baseUrl);
	}
	deleteConnectionCredentials(connectionId: string): Promise<void> { return this.call('deleteConnectionCredentials', connectionId); }
	copyConnectionCredentials(fromConnectionId: string, toConnectionId: string): Promise<void> {
		return this.call('copyConnectionCredentials', fromConnectionId, toConnectionId);
	}

	// ===== CHARACTER LIBRARY =====
	getAllLibraryEntries(): Promise<LibraryEntry[]> { return this.call('getAllLibraryEntries'); }
	getLibraryEntry(id: string): Promise<LibraryEntry | null> { return this.call('getLibraryEntry', id); }
	insertLibraryEntry(entry: LibraryEntry): Promise<void> { return this.call('insertLibraryEntry', entry); }
	/** Resolves with the ids of the chats whose seeded greetings the save refreshed (see
	 *  server/db.ts refreshSeededGreetings). The server announces those itself, on the
	 *  `messages` scope and to every device, so nothing here has to act on the list. */
	updateLibraryEntry(entry: LibraryEntry): Promise<string[]> { return this.call('updateLibraryEntry', entry); }
	updateLibraryEntryFavorite(id: string, isFavorite: boolean): Promise<void> {
		return this.call('updateLibraryEntryFavorite', id, isFavorite);
	}
	/** Refuses the last persona outright, and returns the persona that took over when the
	 *  deleted one was active (null otherwise). The server announces that move on the
	 *  `settings` scope, so nothing here has to act on the id. */
	deleteLibraryEntry(id: string): Promise<string | null> { return this.call('deleteLibraryEntry', id); }

	// ===== CHARACTER VERSIONS =====
	getAllCharacterVersions(): Promise<CharacterVersion[]> { return this.call('getAllCharacterVersions'); }
	getCharacterVersion(id: string): Promise<CharacterVersion | null> { return this.call('getCharacterVersion', id); }
	insertCharacterVersion(version: CharacterVersion): Promise<void> { return this.call('insertCharacterVersion', version); }
	renameCharacterVersion(id: string, name: string): Promise<void> { return this.call('renameCharacterVersion', id, name); }
	deleteCharacterVersion(id: string): Promise<void> { return this.call('deleteCharacterVersion', id); }
	pinUnpinnedChatsToVersion(entryId: string, versionId: string): Promise<void> {
		return this.call('pinUnpinnedChatsToVersion', entryId, versionId);
	}

	// ===== LOREBOOKS =====
	getAllLorebooks(): Promise<Lorebook[]> { return this.call('getAllLorebooks'); }
	getLorebook(id: string): Promise<Lorebook | null> { return this.call('getLorebook', id); }
	insertLorebook(book: Lorebook): Promise<void> { return this.call('insertLorebook', book); }
	updateLorebook(book: Lorebook): Promise<void> { return this.call('updateLorebook', book); }
	deleteLorebook(id: string): Promise<void> { return this.call('deleteLorebook', id); }

	// ===== STEERING NOTES =====
	getAllSteeringNotes(): Promise<SteeringNote[]> { return this.call('getAllSteeringNotes'); }
	insertSteeringNote(note: SteeringNote): Promise<void> { return this.call('insertSteeringNote', note); }
	updateSteeringNote(note: SteeringNote): Promise<void> { return this.call('updateSteeringNote', note); }
	deleteSteeringNote(id: string): Promise<void> { return this.call('deleteSteeringNote', id); }

	// ===== ASSISTANT SESSIONS =====
	getAllAssistantSessions(): Promise<AssistantSession[]> { return this.call('getAllAssistantSessions'); }
	insertAssistantSession(session: AssistantSession): Promise<void> { return this.call('insertAssistantSession', session); }
	updateAssistantSession(session: { id: string; title?: string; updatedAt?: number }): Promise<void> {
		return this.call('updateAssistantSession', session);
	}
	deleteAssistantSession(id: string): Promise<void> { return this.call('deleteAssistantSession', id); }
	getAssistantMessages(sessionId: string): Promise<AssistantMessage[]> { return this.call('getAssistantMessages', sessionId); }
	/** Appends a transcript row. The SERVER stamps its time and returns it: the transcript
	 *  is ordered by that stamp, and this device's clock is not the one the assistant's own
	 *  rows are written with (server/db.ts). */
	insertAssistantMessage(message: Omit<AssistantMessage, 'createdAt'>): Promise<number> { return this.call('insertAssistantMessage', message); }
	deleteAssistantMessage(id: string): Promise<void> { return this.call('deleteAssistantMessage', id); }

	// ===== SESSION MEMORY =====
	memGetState(chatId: string): Promise<MemoryState | null> { return this.call('memGetState', chatId); }
	memListEpisodes(chatId: string): Promise<Episode[]> { return this.call('memListEpisodes', chatId); }
	memSetState(chatId: string, patch: Partial<Pick<MemoryState, 'enabled' | 'autoExtract' | 'config'>>): Promise<void> {
		return this.call('memSetState', chatId, patch);
	}
	memApplyBatch(chatId: string, result: BatchResult): Promise<void> { return this.call('memApplyBatch', chatId, result); }
	memApplyPromotion(chatId: string, result: PromotionResult): Promise<void> { return this.call('memApplyPromotion', chatId, result); }
	memReapEpisodes(chatId: string, episodeIds: string[]): Promise<void> { return this.call('memReapEpisodes', chatId, episodeIds); }
	memUpdateEpisodeContent(chatId: string, episodeId: string, content: string): Promise<void> {
		return this.call('memUpdateEpisodeContent', chatId, episodeId, content);
	}
	memReset(chatId: string): Promise<void> { return this.call('memReset', chatId); }
}

export const db = new DatabaseService();
