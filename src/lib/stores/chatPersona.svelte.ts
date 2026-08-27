/**
 * Which persona the open chat plays as.
 *
 * The app still has exactly one active persona (stores/persona.svelte.ts). On top of it a
 * character may carry a default for its chats, and a chat may say something of its own, and
 * this store is the single place those layers resolve:
 *
 *   global      personaStore.activeId
 *     beaten by
 *   character   the bound entry's overrides.personaId
 *     beaten by
 *   chat        the chat row's own decision (types/chat.ts ChatPersona)
 *
 * Everything that asks "who is the user in this story" reads `resolved` / `resolvedEntry`
 * here rather than personaStore, which keeps its own job intact: it is the app-wide value.
 *
 * **A chat's decision has three states, and the third is load-bearing.** A chat may name a
 * persona, may say "the app's, whatever this character defaults to", or may have said nothing
 * at all and inherit. Without that middle state, handing ONE chat back to the app would have
 * to be done by stripping the default off the character, which reaches every other chat of
 * that card. That was the shape this store shipped with, and it was wrong.
 *
 * **Switching persona by hand detaches the open chat, and nothing else.** All three manual
 * doors (the composer's picker, the Personas list, the persona editor) go through
 * `switchGlobal`: it writes the app-wide value and moves THIS chat to "the app's", so the
 * switch takes effect where the reader made it. A pin left standing would outrank the pick and
 * the picker would read as broken. The character's default is not touched, so its other chats
 * keep it; pushing a new persona to all of them is what the Character pill is for.
 *
 * Keyed on the chat that is ON SCREEN rather than the one being navigated to, for the same
 * reason chatScene is: `activeChatId` is claimed at the click and the rows land a couple of
 * hundred milliseconds later, so keying on it would relabel the outgoing story's turns with
 * the incoming chat's persona for that gap.
 *
 * A pin naming a persona that no longer exists resolves one layer down instead of being swept
 * at delete time. Lazy costs no writes, cannot miss a chat, and cannot turn a delete on one
 * device into a silent rewrite of another device's chats and cards. It is nearly unreachable
 * anyway behind the persona floor, which keeps one persona alive and hands the role to a
 * survivor (architecture/library.md). Pinned by `server/overrideLifetime.test.ts`.
 */

import { chatStore } from '$lib/stores/chat.svelte';
import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
import { personaStore } from '$lib/stores/persona.svelte';
import { chatDefersToCharacter, normalizeChatFeatureState, type ChatPersona } from '$lib/types/chat';
import type { LibraryEntry } from '$lib/types/library';
import type { PromptCharacter } from '$lib/macros';

/** Which layer decided the persona currently in force. */
export type PersonaScope = 'global' | 'character' | 'chat';

class ChatPersonaStore {
	/** The chat on screen. See the note at the top on why this is not `activeChatId`. */
	private openChat = $derived(chatStore.currentChatState?.chat ?? null);

	/** What the open chat has said about its own persona, or null while it has said nothing. */
	private decision = $derived.by((): ChatPersona | null => {
		const chat = this.openChat;
		return chat ? normalizeChatFeatureState(chat.featureState).persona : null;
	});

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

	/** The persona this chat named, if it named one and that one still exists. */
	chatPin = $derived.by((): LibraryEntry | null => {
		const decision = this.decision;
		return decision?.follows === 'persona' ? this.livePersona(decision.id) : null;
	});

	/** Whether this chat has explicitly opted out of its character's default. */
	private detached = $derived(this.decision?.follows === 'app');

	/** The bound character's default, if it still names a persona. */
	characterPin = $derived.by((): LibraryEntry | null =>
		this.livePersona(this.boundCharacter?.overrides?.personaId)
	);

	/** Which layer is actually deciding, which is also which pill reads as on. A chat that
	 *  opted out and a chat with no default to inherit both read as global: what separates
	 *  them only decides what a LATER character default would do to this chat, and a pill
	 *  claiming otherwise would be describing bookkeeping rather than the story. */
	scope = $derived.by((): PersonaScope => {
		if (this.chatPin) return 'chat';
		if (this.detached) return 'global';
		return this.characterPin ? 'character' : 'global';
	});

	/** The persona in force for the open chat. Null only where the app has no persona at all
	 *  (the first-run case), exactly as personaStore.activeEntry is null there. */
	resolvedEntry = $derived.by((): LibraryEntry | null => {
		if (this.chatPin) return this.chatPin;
		if (this.detached) return personaStore.activeEntry;
		return this.characterPin ?? personaStore.activeEntry;
	});

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

	/** Whether this chat follows the app while its character carries a default it could have
	 *  inherited. The one case where "Global" needs a second sentence: the reader can see a
	 *  default on the card and would otherwise have no idea why this chat ignores it. */
	ignoringCharacterDefault = $derived(this.detached && this.characterPin !== null);

	/** How many OTHER chats a change to the character's default would actually reach: the ones
	 *  that READ through the character layer, which is not the same as the ones that stored
	 *  nothing (see chatDefersToCharacter). A number is only worth saying if it is the number
	 *  resolution would give. */
	otherChatsFollowingCharacter = $derived.by((): number => {
		const character = this.boundCharacter;
		if (!character) return 0;
		const openId = this.openChat?.id ?? null;
		const isLive = (id: string) => this.livePersona(id) !== null;
		return chatStore.chats.filter(
			(chat) =>
				chat.id !== openId &&
				chat.characterId === character.id &&
				chatDefersToCharacter(normalizeChatFeatureState(chat.featureState).persona, isLive)
		).length;
	});

	/** Pin whatever is in force to this chat. Seeding from the resolved value is what makes
	 *  the press itself change nothing on screen, the same trick chatScene.adopt uses. */
	async pinToChat(): Promise<void> {
		const id = this.resolvedId;
		if (!this.openChat || !id) return;
		await this.write({ follows: 'persona', id });
	}

	/** Pin whatever is in force to the bound character, and hand this chat back to inheriting
	 *  so the layer just written is the one deciding. Null rather than "the app's": the chat
	 *  has to READ the default it just set, and a detached chat would ignore it. */
	async pinToCharacter(): Promise<void> {
		const character = this.boundCharacter;
		const id = this.resolvedId;
		if (!this.openChat || !character || !id) return;
		await characterLibraryStore.updateOverrides(character.id, { personaId: id });
		await this.write(null);
	}

	/** Hand THIS chat to the app's active persona and leave everything else alone. The
	 *  character keeps its default, so its other chats keep theirs, and the explicit state is
	 *  what stops this chat quietly re-inheriting that default on the next read. */
	async resetToGlobal(): Promise<void> {
		if (!this.openChat) return;
		await this.write({ follows: 'app' });
	}

	/**
	 * Switch the app's active persona, and make the switch stick in the chat it was made from.
	 *
	 * The one door for every manual switch (composer picker, Personas list, persona editor).
	 * The two bootstrap calls, first run and the first persona ever created, deliberately stay
	 * on personaStore.setActive: there is nothing to detach then, and routing them here would
	 * have creating a persona rewrite a chat row.
	 *
	 * Only the open chat moves. Every other chat of the same character keeps what it had,
	 * which is the whole difference between this and the version that cleared the card.
	 */
	async switchGlobal(id: string): Promise<void> {
		personaStore.setActive(id);
		// Nothing to record when the chat already reads the app's persona and nothing could
		// outrank it, and skipping that write matters: a chat row write broadcasts the `chats`
		// scope, which every other device answers with a refetch.
		if (this.detached) return;
		if (this.decision === null && this.characterPin === null) return;
		await this.resetToGlobal();
	}

	/** The one writer of a chat's persona decision. */
	private async write(next: ChatPersona | null): Promise<void> {
		const chat = this.openChat;
		// Every caller gates on an open chat, so its absence here is a bug in one of them
		// rather than a state worth absorbing.
		if (!chat) throw new Error('No chat is open, so there is no persona decision to write');
		await chatStore.updateChatFeatureState(chat.id, { persona: next });
	}
}

export const chatPersonaStore = new ChatPersonaStore();
