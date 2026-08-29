/**
 * Which connection the open chat sends its story turns on.
 *
 * The app still routes every calling point to a concrete connection in one flat map
 * (stores/connections.svelte.ts). On top of the `primary` entry in that map a character may
 * carry a default for its chats, and a chat may say something of its own.
 * `ChatOverrideLayer` is where those layers stack and where the rules are written down; this
 * file only says which tables Connection means by them:
 *
 *   global      connectionStore.assignments.primary
 *     beaten by
 *   character   the bound card's overrides.connectionId
 *     beaten by
 *   chat        the chat row's own decision
 *
 * **`primary` alone.** The assistant and every calling engine keep their app-wide
 * assignments, and a chat override does not touch them. Those points are about which
 * machinery runs where: the assistant is not part of anyone's story, and Opening Scene
 * being pinned to a cheap model is a choice about that tool rather than about this chat.
 * `primary` is the one point that IS the story, so it is the one a story gets to claim. This
 * is also what keeps the Connections page honest: what it shows is still literally what each
 * of those other calls rides.
 *
 * Everything that asks "who serves this chat's turns" reads through
 * `services/llm/provider.ts`, which applies this to the `primary` target and leaves every
 * other target on the map. That is one chokepoint rather than a rewiring of each caller, so
 * the model name in the composer, the context budget the assembler trims to and the request
 * that actually goes out can never disagree about which connection is in force.
 */

import { connectionStore } from '$lib/stores/connections.svelte';
import { createChatOverrideLayer } from '$lib/stores/chatOverride.svelte';
import type { OverrideScope } from '$lib/types/chat';
import type { Connection } from '$lib/types/llm';

/** The routing point a chat is allowed to claim. The story, and nothing else. */
export const STORY_ROUTING_POINT = 'primary';

class ChatConnectionStore {
	private layer = createChatOverrideLayer({
		kind: 'connection',
		characterKey: 'connectionId',
		chatPatch: (connection) => ({ connection }),
		characterPatch: (connectionId) => ({ connectionId }),
		isLive: (id) => connectionStore.get(id) !== undefined,
		// `assignmentFor` answers '' for a point it has no entry for, which is the same
		// "nothing to fall back to" as a missing map and has to read as null here.
		globalId: () => connectionStore.assignmentFor(STORY_ROUTING_POINT) || null,
		setGlobal: (id) => connectionStore.setAssignment(STORY_ROUTING_POINT, id)
	});

	/** The connection serving the open chat's story turns, or undefined before the store has
	 *  loaded. Never a dangling id: an override naming a deleted connection has already
	 *  fallen one layer down by the time this is read. */
	resolvedConnection = $derived.by((): Connection | undefined => {
		const id = this.layer.resolvedId;
		return id ? connectionStore.get(id) : undefined;
	});

	/** The id in force, or null where nothing resolves. */
	resolvedId = $derived(this.resolvedConnection?.id ?? null);

	/** The connection's name, for the Overrides card's own line. */
	resolvedName = $derived(this.resolvedConnection?.name ?? null);

	/** The model it would send to, which is the half of the answer a reader actually feels. */
	resolvedModel = $derived(this.resolvedConnection?.model ?? '');

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
	 * Route the story to a connection app-wide, and make the switch stick in the chat it was
	 * made from. The one door for every manual switch of the Primary point: the Connections
	 * page's routing row. Every other point on that page still writes straight to the map,
	 * because no chat can override those.
	 *
	 * The connection floor is what keeps this from ever needing to clear anything: the store
	 * refuses to delete the last connection, and a delete moves every point that used it onto
	 * a survivor, so there is always something for `primary` to name.
	 */
	switchGlobal(id: string): Promise<void> {
		return this.layer.switchGlobal(id);
	}
}

export const chatConnectionStore = new ChatConnectionStore();
