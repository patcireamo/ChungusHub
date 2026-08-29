/**
 * Which persona the open chat plays as.
 *
 * The app still has exactly one active persona (stores/persona.svelte.ts). On top of it a
 * character may carry a default for its chats, and a chat may say something of its own.
 * `ChatOverrideLayer` (stores/chatOverride.svelte.ts) is where those layers stack, and its
 * header is where the rules are written down. This file only says which tables persona
 * means by them:
 *
 *   global      personaStore.activeId
 *     beaten by
 *   character   the bound card's overrides.personaId
 *     beaten by
 *   chat        the chat row's own decision
 *
 * Everything that asks "who is the user in this story" reads `resolved` / `resolvedEntry`
 * here rather than personaStore, which keeps its own job intact: it is the app-wide value.
 * The generation path is the exception, and deliberately so: `utils/prompt-builder.ts` is
 * handed a chat id rather than reading the one on screen, so it runs the same pure resolver
 * (types/chat.ts) over the row it was given.
 */

import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
import { personaStore } from '$lib/stores/persona.svelte';
import { createChatOverrideLayer } from '$lib/stores/chatOverride.svelte';
import type { OverrideScope } from '$lib/types/chat';
import type { LibraryEntry } from '$lib/types/library';
import type { PromptCharacter } from '$lib/macros';

/** A persona id resolved against the library, or null if it names nothing live. A stored id
 *  is never trusted on its own; the fall-through happens at resolve time. */
function livePersona(id: string | null | undefined): LibraryEntry | null {
	if (!id) return null;
	return characterLibraryStore.entries.find((e) => e.id === id && e.type === 'persona') ?? null;
}

class ChatPersonaStore {
	private layer = createChatOverrideLayer({
		kind: 'persona',
		characterKey: 'personaId',
		chatPatch: (persona) => ({ persona }),
		characterPatch: (personaId) => ({ personaId }),
		isLive: (id) => livePersona(id) !== null,
		globalId: () => personaStore.activeId,
		setGlobal: (id) => personaStore.setActive(id)
	});

	/** The persona in force for the open chat. Null only where the app has no persona at all
	 *  (the first-run case), exactly as personaStore.activeEntry is null there.
	 *
	 *  Getters rather than `$derived` throughout, for the reason chatOverride.svelte.ts sets
	 *  out: this is a module-level singleton in an import cycle, and a derived created while
	 *  modules are still evaluating reads `chatStore` before it exists. */
	get resolvedEntry(): LibraryEntry | null {
		return livePersona(this.layer.resolvedId);
	}

	/** Resolved for prompt assembly. A drop-in for personaStore.activeResolved, which is what
	 *  lets the live meters pick this up without threading a chat id through them. */
	get resolved(): PromptCharacter | null {
		const entry = this.resolvedEntry;
		if (!entry) return null;
		return { name: entry.identity.name, traits: entry.data.traits, storyNotes: '' };
	}

	/** The id stamped onto a user turn as it is written, so attribution survives a later
	 *  switch. Read off the resolved entry rather than the layer, so an id that no longer
	 *  names a persona is never stamped onto a turn. */
	get resolvedId(): string | null {
		return this.resolvedEntry?.id ?? null;
	}

	get scope(): OverrideScope {
		return this.layer.scope;
	}
	get canScope(): boolean {
		return this.layer.canScope;
	}
	get canScopeCharacter(): boolean {
		return this.layer.canScopeCharacter;
	}
	get characterName(): string | null {
		return this.layer.characterName;
	}
	get ignoringCharacterDefault(): boolean {
		return this.layer.ignoringCharacterDefault;
	}
	get otherChatsFollowingCharacter(): number {
		return this.layer.otherChatsFollowingCharacter;
	}

	pinToChat(): Promise<void> {
		return this.layer.pinToChat();
	}
	pinToCharacter(): Promise<void> {
		return this.layer.pinToCharacter();
	}
	resetToGlobal(): Promise<void> {
		return this.layer.resetToGlobal();
	}

	/**
	 * Switch the app's active persona, and make the switch stick in the chat it was made from.
	 *
	 * The one door for every manual switch (composer picker, Personas list, persona editor).
	 * The two bootstrap calls, first run and the first persona ever created, deliberately stay
	 * on personaStore.setActive: there is nothing to detach then, and routing them here would
	 * have creating a persona rewrite a chat row.
	 */
	switchGlobal(id: string): Promise<void> {
		return this.layer.switchGlobal(id);
	}
}

export const chatPersonaStore = new ChatPersonaStore();
