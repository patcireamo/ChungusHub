/**
 * Which prompt preset the open chat is assembled with.
 *
 * The app still has exactly one active preset (services/presets.svelte.ts). On top of it a
 * character may carry a default for its chats, and a chat may say something of its own.
 * `ChatOverrideLayer` is where those layers stack and where the rules are written down; this
 * file only says which tables Prompt means by them:
 *
 *   global      presetService.getActivePresetId()
 *     beaten by
 *   character   the bound card's overrides.presetId
 *     beaten by
 *   chat        the chat row's own decision
 *
 * **Effective, not committed.** Everything here resolves through `presetService.getEffective`,
 * so a chat pinned to a preset with an unsaved Prompt Builder draft is assembled with that
 * draft, exactly as the app-wide active preset already is. Editing a preset live and watching
 * the result is the whole point of drafts, and an override must not quietly opt a chat out
 * of it.
 *
 * **The Prompt Builder edits what is IN FORCE for the open chat**, not the app-wide active
 * preset. A builder that edited a preset the open story is not using would be a worse kind of
 * broken than the picker that loses to a pin: the reader would save changes and see nothing
 * happen. Its own picker still goes through `switchGlobal`, so choosing a preset there means
 * what it says.
 */

import { presetService } from '$lib/services/presets.svelte';
import { createChatOverrideLayer } from '$lib/stores/chatOverride.svelte';
import type { OverrideScope } from '$lib/types/chat';
import type { PromptPreset } from '$lib/types/database';

class ChatPresetStore {
	private layer = createChatOverrideLayer({
		kind: 'preset',
		characterKey: 'presetId',
		chatPatch: (preset) => ({ preset }),
		characterPatch: (presetId) => ({ presetId }),
		isLive: (id) => presetService.getEffective(id) !== null,
		globalId: () => presetService.getActivePresetId(),
		// activatePreset resolves with the preset and rejects if the id names none, so the
		// wrapper is what keeps a rejection reaching the caller rather than the chat row being
		// detached from a switch that never happened.
		setGlobal: async (id) => {
			await presetService.activatePreset(id);
		}
	});

	/**
	 * The preset in force for the open chat, or null where the app has none at all.
	 *
	 * A drop-in for `presetService.getActiveEffectivePreset()`, including its first-preset
	 * fallback: that fallback only covers boot, before `ensureActivePreset` has written an id,
	 * and dropping it here would leave the composer briefly assembling against nothing.
	 */
	get resolvedPreset(): PromptPreset | null {
		const id = this.layer.resolvedId;
		const own = id ? presetService.getEffective(id) : null;
		return own ?? presetService.getActiveEffectivePreset();
	}

	/** The id in force, or null where nothing resolves. Taken off the resolved preset so the
	 *  boot fallback above is reflected here too. */
	get resolvedId(): string | null {
		return this.resolvedPreset?.id ?? null;
	}

	/** Its name, for the Overrides card's own line. */
	get resolvedName(): string | null {
		return this.resolvedPreset?.name ?? null;
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
	 * Activate a preset app-wide, and make the switch stick in the chat it was made from.
	 *
	 * The one door for every manual switch: the Preset Controls picker, the Prompt Builder's
	 * preset list, and the switch that follows creating, importing or duplicating one. The
	 * boot path (`ensureActivePreset`, which invents a preset when none exists) deliberately
	 * stays on `presetService.activatePreset`: there is nothing to detach then, and it can run
	 * before any chat is open.
	 */
	switchGlobal(id: string): Promise<void> {
		return this.layer.switchGlobal(id);
	}
}

export const chatPresetStore = new ChatPresetStore();
