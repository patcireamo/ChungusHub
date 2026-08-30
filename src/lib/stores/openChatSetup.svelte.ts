/**
 * What the open story is running on, resolved once for every surface that draws it.
 *
 * The claims are a property of the CHAT, so resolving them per rendered turn buys nothing:
 * each `chatPersonaEntry`/`chatPreset` pair parses the chat's feature blob and walks the
 * library, and the transcript was paying both on every message on screen, again on every
 * change of the open chat. Read here once and shared, the whole transcript costs one parse.
 *
 * It is reactive by nature, which is why it cannot live in `utils/chat-setup.ts`: that
 * module is handed its chat so the generation path can import it, and a reach into
 * `chatStore` from there would close the import cycle live-macro-context.ts documents.
 */

import { chatStore } from '$lib/stores/chat.svelte';
import { normalizeChatFeatureState } from '$lib/types/chat';
import { personaEntryFor, presetForClaim } from '$lib/utils/chat-setup';

class OpenChatSetup {
	/** The one parse. Both fields below read their claim off this rather than off the blob. */
	private claims = $derived(normalizeChatFeatureState(chatStore.activeChat?.featureState ?? null));

	/** The persona this story is played by, or the app's while it claims none or names one
	 *  that is gone. */
	persona = $derived(personaEntryFor(this.claims.persona));

	/** The preset its transcript is read under: effective on both branches, so an unsaved
	 *  draft is what the display rules come from either way. */
	preset = $derived(presetForClaim(this.claims.preset));
}

export const openChatSetup = new OpenChatSetup();
