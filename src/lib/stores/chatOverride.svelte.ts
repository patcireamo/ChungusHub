/**
 * The chat → character → global layering, written once for every setting a chat can
 * override.
 *
 *   global      the app-wide value
 *     beaten by
 *   character   the bound card's overrides.<field>
 *     beaten by
 *   chat        the chat row's own decision (types/chat.ts ChatOverride)
 *
 * Persona, Connection and Preset are three answers to one question, "does THIS story get
 * its own?", and the ways to get that question wrong are identical for all three. They are
 * not three similar features; they are one feature pointed at three tables, so the rule
 * lives here and each store supplies only what its own table is called.
 *
 * **A chat's decision has three states, and the third is load-bearing.** A chat may name a
 * value, may say "the app's, whatever this character defaults to", or may have said nothing
 * at all and inherit. Without that middle state, handing ONE chat back to the app can only
 * be done by stripping the default off the character, which reaches every other chat of
 * that card. That was the shape persona shipped with, and it was wrong.
 *
 * **Switching by hand detaches the open chat, and nothing else.** Every manual door goes
 * through `switchGlobal`: it writes the app-wide value and moves THIS chat to "the app's",
 * so the switch takes effect where the reader made it. A pin left standing would outrank the
 * pick and the picker would read as broken. The character's default is not touched, so its
 * other chats keep it; pushing a new value to all of them is what the Character pill is for.
 *
 * Keyed on the chat that is ON SCREEN rather than the one being navigated to, for the same
 * reason chatScene is: `activeChatId` is claimed at the click and the rows land a couple of
 * hundred milliseconds later, so keying on it would answer for the incoming chat while the
 * outgoing one is still drawn.
 *
 * A pin naming something that no longer exists resolves one layer down instead of being
 * swept at delete time. Lazy costs no writes, cannot miss a chat, and cannot turn a delete
 * on one device into a silent rewrite of another device's chats and cards. Pinned by
 * `server/overrideLifetime.test.ts`.
 *
 * The resolution itself is NOT here. It is pure, in types/chat.ts, because the generation
 * path has to run the same rule over a chat row read from the database with no store in
 * reach (utils/prompt-builder.ts). One function, two callers, so a token meter can never
 * price a different answer than the send uses.
 */

import { chatStore } from '$lib/stores/chat.svelte';
import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
import {
	chatDefersToCharacter,
	normalizeChatFeatureState,
	resolveOverrideId,
	resolveOverrideScope,
	type AnyChatOverride,
	type Chat,
	type ChatFeatureState,
	type ChatOverride,
	type OverrideKind,
	type OverrideScope
} from '$lib/types/chat';
import type { LibraryEntry, LibraryEntryOverrides } from '$lib/types/library';

/**
 * What the Overrides page needs from a store to draw one card and move its pills.
 *
 * All three stores satisfy this without saying so, and that is deliberate: the page renders
 * one component three times rather than three cards that could drift, and this is the seam
 * that lets it. Everything setting-specific (what the value IS, what it is called) is a
 * prop, because those are the only parts that actually differ.
 */
export interface OverrideSurface {
	scope: OverrideScope;
	canScope: boolean;
	canScopeCharacter: boolean;
	characterName: string | null;
	ignoringCharacterDefault: boolean;
	otherChatsFollowingCharacter: number;
	pinToChat(): Promise<void>;
	pinToCharacter(): Promise<void>;
	resetToGlobal(): Promise<void>;
}

export interface ChatOverrideConfig<Kind extends OverrideKind> {
	/**
	 * Which setting this layer is for. One field rather than two: it is both the
	 * ChatFeatureState key the chat's decision lives under and the `follows` discriminant
	 * written into it, and letting those be configured separately would only be inviting them
	 * to disagree.
	 */
	kind: Kind;
	/** The LibraryEntryOverrides key the character's default lives under. */
	characterKey: keyof LibraryEntryOverrides;
	/**
	 * Record a decision on a chat, and record this layer's default on a character.
	 *
	 * Supplied per store rather than built from `kind` here, and that is the point: only the
	 * concrete store knows its kind as a literal, so only there can `{ persona: next }` be
	 * checked against the real field. Built here they would each need a cast into place, and
	 * a cast is exactly the thing that would still compile after someone wired a layer to the
	 * wrong column.
	 */
	chatPatch: (next: ChatOverride<Kind> | null) => Partial<ChatFeatureState>;
	characterPatch: (id: string) => Partial<LibraryEntryOverrides>;
	/**
	 * Whether an id still names something that exists. Called inside deriveds, so reading a
	 * store here is what keeps a resolved value current when the thing underneath is deleted.
	 */
	isLive: (id: string) => boolean;
	/** The app-wide value this layer falls back to. Read inside deriveds, as above. */
	globalId: () => string | null;
	/**
	 * Make `id` the app-wide value. Awaited, because not every one of these is synchronous:
	 * activating a preset writes a setting and can reject.
	 */
	setGlobal: (id: string) => void | Promise<void>;
}

/** Everything one layer exposes: the surface the page draws, plus what a store builds on. */
export interface ChatOverrideLayer extends OverrideSurface {
	/** What the open chat has said about this setting, or null while it has said nothing. */
	readonly decision: AnyChatOverride | null;
	/** The character the open chat is bound to, or null when it is bound to none. */
	readonly boundCharacter: LibraryEntry | null;
	/** The id in force for the open chat, or null where the app itself has none. */
	readonly resolvedId: string | null;
	switchGlobal(id: string): Promise<void>;
}

/**
 * A factory of plain getters, and every part of that is deliberate.
 *
 * **No runes here.** A `$derived` is a signal that gets CREATED, and creating one reads what
 * it depends on. These stores are module-level singletons, so that read happens while modules
 * are still being evaluated, and this module sits in an import cycle: `provider.ts` needs the
 * connection layer, which needs `chatStore`, which reaches `provider.ts` again through memory.
 * A cycle is harmless as long as nothing is READ until every module has finished evaluating,
 * and eager deriveds are exactly the thing that reads too early. It surfaced as
 * `Cannot access 'chatStore' before initialization`, and only in the merged deploy tree, where
 * another topic's tests import these modules in a different order.
 *
 * Plain getters create nothing and read nothing until someone asks, so the cycle stops
 * mattering. Reactivity is unaffected: Svelte tracks the `$state` reads themselves, wherever
 * they happen, which is the same reason `personaStore.activeEntry` is a plain getter.
 *
 * What is given up is memoisation, so a caller that reads one of these inside a loop should
 * hoist it into a local `$derived` first, as the composer's persona menu does.
 *
 * **A factory rather than a class** because a config assigned in a constructor BODY arrives
 * after every field initialiser has run. A parameter is bound before the first line of the
 * body, so there is no ordering left to get wrong.
 */
export function createChatOverrideLayer<Kind extends OverrideKind>(
	cfg: ChatOverrideConfig<Kind>
): ChatOverrideLayer {
	/** The chat on screen. See the note at the top on why this is not `activeChatId`. */
	const openChat = (): Chat | null => chatStore.currentChatState?.chat ?? null;

	const decision = (): AnyChatOverride | null => {
		const chat = openChat();
		if (!chat) return null;
		return normalizeChatFeatureState(chat.featureState)[cfg.kind];
	};

	/** Null for an unbound chat, which is what makes the Character layer unavailable rather
	 *  than merely empty. */
	const boundCharacter = (): LibraryEntry | null => {
		const id = openChat()?.characterId;
		if (!id) return null;
		return characterLibraryStore.entries.find((e) => e.id === id && e.type === 'character') ?? null;
	};

	/** The bound character's default for this setting, whether or not it still resolves. */
	const characterDefaultId = (): string | null =>
		boundCharacter()?.overrides?.[cfg.characterKey] ?? null;

	/** Whether that default is one this chat could actually inherit. A dangling one is not:
	 *  it falls through exactly like no default at all. */
	const characterDefaultLive = (): boolean => {
		const id = characterDefaultId();
		return id !== null && cfg.isLive(id);
	};

	/** The one writer of a chat's decision for this setting. */
	const write = (chatId: string, next: ChatOverride<Kind> | null): Promise<void> =>
		chatStore.updateChatFeatureState(chatId, cfg.chatPatch(next));

	return {
		get decision() {
			return decision();
		},

		get boundCharacter() {
			return boundCharacter();
		},

		/** The id in force for the open chat, or null where the app itself has none. */
		get resolvedId() {
			return resolveOverrideId(decision(), characterDefaultId(), cfg.globalId(), cfg.isLive);
		},

		/** Which layer is actually deciding, which is also which pill reads as on. */
		get scope() {
			return resolveOverrideScope(decision(), characterDefaultId(), cfg.isLive);
		},

		/** Whether there is a chat to override at all. */
		get canScope() {
			return openChat() !== null;
		},

		/** Whether the Character layer is reachable: an unbound chat has no card to pin to. */
		get canScopeCharacter() {
			return boundCharacter() !== null;
		},

		get characterName() {
			return boundCharacter()?.identity.name?.trim() || null;
		},

		/** Whether this chat follows the app while its character carries a default it could
		 *  have inherited. The one case where "Global" needs a second sentence: the reader can
		 *  see a default on the card and would otherwise have no idea why this chat ignores
		 *  it. */
		get ignoringCharacterDefault() {
			return decision()?.follows === 'app' && characterDefaultLive();
		},

		/** How many OTHER chats a change to the character's default would actually reach: the
		 *  ones that READ through the character layer, which is not the same as the ones that
		 *  stored nothing (see chatDefersToCharacter). A number is only worth saying if it is
		 *  the number resolution would give. */
		get otherChatsFollowingCharacter() {
			const character = boundCharacter();
			if (!character) return 0;
			const openId = openChat()?.id ?? null;
			return chatStore.chats.filter(
				(chat) =>
					chat.id !== openId &&
					chat.characterId === character.id &&
					chatDefersToCharacter(normalizeChatFeatureState(chat.featureState)[cfg.kind], cfg.isLive)
			).length;
		},

		/** Pin whatever is in force to this chat. Seeding from the resolved value is what
		 *  makes the press itself change nothing on screen, the same trick chatScene.adopt
		 *  uses. */
		async pinToChat(): Promise<void> {
			const chat = openChat();
			const id = this.resolvedId;
			if (!chat || !id) return;
			await write(chat.id, { follows: cfg.kind, id });
		},

		/** Pin whatever is in force to the bound character, and hand this chat back to
		 *  inheriting so the layer just written is the one deciding. Null rather than "the
		 *  app's": the chat has to READ the default it just set, and a detached chat would
		 *  ignore it. */
		async pinToCharacter(): Promise<void> {
			const chat = openChat();
			const character = boundCharacter();
			const id = this.resolvedId;
			if (!chat || !character || !id) return;
			await characterLibraryStore.updateOverrides(character.id, cfg.characterPatch(id));
			await write(chat.id, null);
		},

		/** Hand THIS chat to the app's value and leave everything else alone. The character
		 *  keeps its default, so its other chats keep theirs, and the explicit state is what
		 *  stops this chat quietly re-inheriting that default on the next read. */
		async resetToGlobal(): Promise<void> {
			const chat = openChat();
			if (!chat) return;
			await write(chat.id, { follows: 'app' });
		},

		/**
		 * Switch the app-wide value, and make the switch stick in the chat it was made from.
		 *
		 * The one door for every manual switch. Bootstrap paths (first run, and the first of a
		 * thing ever created) deliberately stay on the underlying store's own setter: there is
		 * nothing to detach then, and routing them here would have creating a persona rewrite
		 * a chat row.
		 *
		 * Only the open chat moves. Every other chat of the same character keeps what it had.
		 */
		async switchGlobal(id: string): Promise<void> {
			// Read before the await, and written to the id read here. `setGlobal` is allowed to
			// be asynchronous, and re-reading afterwards would answer for whichever chat is on
			// screen by then rather than the one the switch was actually made in.
			const chat = openChat();
			const current = decision();
			const inheritable = characterDefaultLive();

			await cfg.setGlobal(id);

			if (!chat) return;
			// Nothing to record when the chat already reads the app's value and nothing could
			// outrank it, and skipping that write matters: a chat row write broadcasts the
			// `chats` scope, which every other device answers with a refetch.
			if (current?.follows === 'app') return;
			if (current === null && !inheritable) return;
			await write(chat.id, { follows: 'app' });
		}
	};
}
