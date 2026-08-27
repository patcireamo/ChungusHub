/**
 * Which persona the open chat plays as.
 *
 * The app still has exactly one active persona (stores/persona.svelte.ts) and that is what
 * every chat starts from. On top of it a chat may pin its own, or inherit one pinned to the
 * character it is bound to, and this store is the single place those three layers resolve:
 *
 *   global      personaStore.activeId
 *     beaten by
 *   character   the bound entry's overrides.personaId
 *     beaten by
 *   chat        the chat row's featureState.persona
 *
 * Everything that asks "who is the user in this story" reads `resolved` / `resolvedEntry`
 * here rather than personaStore, which keeps its own job intact: it is the app-wide value.
 *
 * **Switching persona by hand stands the overrides down.** All three doors that switch the
 * active persona (the composer's picker, the Personas list, the persona editor) go through
 * `switchGlobal`, which sets the app's persona and clears the pins. Without that a pin would
 * quietly outrank the switch and the control would look broken: you pick Polka, Mai stays.
 * Overrides are therefore set from exactly one place, the Overrides settings page.
 *
 * Keyed on the chat that is ON SCREEN rather than the one being navigated to, for the same
 * reason chatScene is: `activeChatId` is claimed at the click and the rows land a couple of
 * hundred milliseconds later, so keying on it would relabel the outgoing story's turns with
 * the incoming chat's persona for that gap.
 *
 * A pin naming a persona that no longer exists resolves one layer down instead of being
 * swept at delete time. Lazy costs no writes and cannot miss a chat, and the case is nearly
 * unreachable anyway: the library keeps at least one persona and a delete hands the role to
 * a survivor server-side (architecture/library.md).
 */

import { chatStore } from '$lib/stores/chat.svelte';
import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
import { personaStore } from '$lib/stores/persona.svelte';
import { normalizeChatFeatureState } from '$lib/types/chat';
import type { LibraryEntry } from '$lib/types/library';
import { toastStore } from '$lib/stores/toast.svelte';
import type { PromptCharacter } from '$lib/macros';

/** Which layer decided the persona currently in force. */export type PersonaScope = 'global' | 'character' | 'chat';

class ChatPersonaStore {
	/** The chat on screen. See the note at the top on why this is not `activeChatId`. */
	private openChat = $derived(chatStore.currentChatState?.chat ?? null);

	/** The character the open chat is bound to. Null for an unbound chat, which is what
	 *  makes the Character layer unavailable rather than merely empty. */
	private boundCharacter = $derived.by((): LibraryEntry | null => {
		const id = this.openChat?.characterId;
		if (!id) return null;
		return characterLibraryStore.entries.find((e) => e.id === id && e.type === 'character') ?? null;
	});

	/** A persona id resolved against the library, or null if it names nothing live. This is
	 *  the fall-through the header describes: a stored id is never trusted on its own. */
	private livePersona(id: string | null | undefined): LibraryEntry | null {
		if (!id) return null;
		return characterLibraryStore.entries.find((e) => e.id === id && e.type === 'persona') ?? null;
	}

	/** This chat's own pin, if it still names a persona. */
	chatPin = $derived.by((): LibraryEntry | null => {
		const chat = this.openChat;
		if (!chat) return null;
		return this.livePersona(normalizeChatFeatureState(chat.featureState).persona);
	});

	/** The bound character's default, if it still names a persona. */
	characterPin = $derived.by((): LibraryEntry | null =>
		this.livePersona(this.boundCharacter?.overrides?.personaId)
	);

	/** Which layer is actually deciding, which is also which pill reads as on. */
	scope = $derived<PersonaScope>(this.chatPin ? 'chat' : this.characterPin ? 'character' : 'global');

	/** The persona in force for the open chat. Null only where the app has no persona at all
	 *  (the first-run case), exactly as personaStore.activeEntry is null there. */
	resolvedEntry = $derived(this.chatPin ?? this.characterPin ?? personaStore.activeEntry);

	/** Resolved for prompt assembly. A drop-in for personaStore.activeResolved, which is what
	 *  lets the generation path pick this up without threading a chat id through it. */
	resolved = $derived.by((): PromptCharacter | null => {
		const entry = this.resolvedEntry;
		if (!entry) return null;
		return { name: entry.identity.name, traits: entry.data.traits, storyNotes: '' };
	});

	/** The id stamped onto a user turn as it is written, so attribution survives a later switch. */
	resolvedId = $derived(this.resolvedEntry?.id ?? null);

	/** Whether there is a chat to override at all. */
	canScope = $derived(this.openChat !== null);

	/** Whether the Character layer is reachable: an unbound chat has no card to pin to. */
	canScopeCharacter = $derived(this.boundCharacter !== null);

	/** The bound character's name, for the pill's own line. */
	characterName = $derived(this.boundCharacter?.identity.name?.trim() || null);

	/** How many OTHER chats a change to the character's default would actually reach. Chats
	 *  carrying a pin of their own are excluded because they would not feel it, which is the
	 *  whole reason this says a number rather than "other chats". */
	otherChatsFollowingCharacter = $derived.by((): number => {
		const character = this.boundCharacter;
		if (!character) return 0;
		const openId = this.openChat?.id ?? null;
		return chatStore.chats.filter(
			(chat) =>
				chat.id !== openId &&
				chat.characterId === character.id &&
				// RESOLVED, not merely read off the column. A chat pinning a persona that has
				// since been deleted is following the character's default too, because that
				// pin falls through at resolve time like any other. Counting the raw value
				// would under-report the reach of a change in the one line whose entire job
				// is to state it.
				this.livePersona(normalizeChatFeatureState(chat.featureState).persona) === null
		).length;
	});
	/** Pin whatever is in force to this chat. Seeding from the resolved value is what makes
	 *  the press itself change nothing on screen, the same trick chatScene.adopt uses. */
	async pinToChat(): Promise<void> {
		const chat = this.openChat;
		const id = this.resolvedId;
		if (!chat || !id) return;
		await chatStore.updateChatFeatureState(chat.id, { persona: id });
	}

	/** Pin whatever is in force to the bound character, and drop this chat's own pin on the
	 *  way: the chat pin outranks the one just written, so leaving it would highlight a layer
	 *  the chat is not actually reading from. */
	async pinToCharacter(): Promise<void> {
		const chat = this.openChat;
		const character = this.boundCharacter;
		const id = this.resolvedId;
		if (!chat || !character || !id) return;
		await characterLibraryStore.updateOverrides(character.id, { personaId: id });
		await this.clearChatPin(chat.id);
	}

	/** Hand the chat back to the app's active persona. Both pins go, because either one left
	 *  standing still outranks it and the pill would be claiming something untrue. */
	async resetToGlobal(): Promise<LibraryEntry | null> {
		return this.clearPins();
	}

	/**
	 * Switch the app's active persona, and stand down anything that would outrank it.
	 *
	 * The one door for every manual switch (composer picker, Personas list, persona editor).
	 * The two bootstrap calls, first run and the first persona ever created, deliberately stay
	 * on personaStore.setActive: there is nothing to clear then, and routing them here would
	 * make creating a persona reach into a character card.
	 *
	 * Clearing the CHARACTER's default reaches that card's other chats, not just this one, so
	 * it is announced here rather than by each caller: three doors that each had to remember
	 * would eventually be two that do and one that does not. The chat pin is silent, since it
	 * only ever affects the story already on screen.
	 */
	async switchGlobal(id: string): Promise<void> {
		personaStore.setActive(id);
		const cleared = await this.clearPins();
		if (cleared) {
			const name = cleared.identity.name?.trim() || 'that character';
			toastStore.info(`${name} no longer has a default persona.`);
		}
	}
	/** Drop every pin the open chat resolves through. Returns the character whose default was
	 *  cleared, or null when there was none. */
	private async clearPins(): Promise<LibraryEntry | null> {
		const chat = this.openChat;
		const character = this.boundCharacter;
		const clearedCharacter = character?.overrides?.personaId ? character : null;
		if (clearedCharacter) {
			await characterLibraryStore.updateOverrides(clearedCharacter.id, { personaId: undefined });
		}
		if (chat) await this.clearChatPin(chat.id);
		return clearedCharacter;
	}

	/** Write null over a chat's pin, skipping the write when there is nothing there: a chat
	 *  row write broadcasts the `chats` scope and every other device answers with a refetch,
	 *  so a no-op clear must not cost one. Read raw rather than resolved on purpose, so a pin
	 *  left naming a deleted persona still counts as something to clear: this is the one path
	 *  that tidies that value away, and it does it the next time the reader touches the chat's
	 *  scope rather than in a sweep nobody asked for. */	private async clearChatPin(chatId: string): Promise<void> {
		const chat = chatStore.chats.find((c) => c.id === chatId) ?? this.openChat;
		if (chat && normalizeChatFeatureState(chat.featureState).persona === null) return;
		await chatStore.updateChatFeatureState(chatId, { persona: null });
	}
}

export const chatPersonaStore = new ChatPersonaStore();
