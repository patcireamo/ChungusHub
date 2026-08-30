/**
 * What a chat is running on: the connection its prompt is priced and shaped against.
 *
 * The composer's meter, the Prompt Builder breakdown, the substitute-level surfaces and the
 * send all need a model, a context budget and a prompt post-processing shape. They must take
 * them from the same place for the same chat, or the meter trims to one context window while
 * the send goes out on another and nothing on screen says so.
 *
 * The chat is handed in rather than reached for: the generation path imports this module, and
 * a reach into `chatStore` would close the import cycle documented in live-macro-context.ts.
 */

import type { Chat } from '$lib/types/chat';
import { normalizeChatFeatureState } from '$lib/types/chat';
import type { CallTarget, PromptPostProcessingMode } from '$lib/types/llm';
import { connectionStore } from '$lib/stores/connections.svelte';
import { llmService } from '$lib/services/llm/provider';

export interface PromptTarget {
	/** The call this prompt rides. Every surface that names the model names this one's, so
	 *  the review dialog and the meter can never label a request the send did not make. */
	target: CallTarget;
	model: string;
	postProcessing: { mode: PromptPostProcessingMode; placeholder: string };
	contextBudget: number;
}

/**
 * The connection a chat claimed for itself, or null when it follows the app.
 *
 * A claim naming a connection that has since been deleted reads as no claim: the story keeps
 * sending on the app's connection instead of failing, and the chip says the claim is gone.
 * Sweeping the stored id instead would throw away a pin the user could still want back by
 * restoring the connection.
 */
export function chatConnectionId(chat: Chat | null): string | null {
	if (!chat) return null;
	const claimed = normalizeChatFeatureState(chat.featureState).connection;
	return claimed && connectionStore.get(claimed) ? claimed : null;
}

/**
 * Resolve the connection terms a chat's prompt is assembled in.
 *
 * `base` is the routing point the caller would ride without a chat in hand: the story send
 * and every meter beside it pass `primary`, while an engine passes its own target so its
 * assigned connection applies to assembly exactly as it does to the call. **Only `primary`
 * can be claimed by a chat**: the assistant and every engine stay app-wide, which is what
 * keeps the Connections page honest about the rows it does own.
 */
export function resolvePromptTarget(chat: Chat | null, base: CallTarget = 'primary'): PromptTarget {
	const claimed = base === 'primary' ? chatConnectionId(chat) : null;
	const target: CallTarget = claimed ? { connection: claimed } : base;
	return {
		target,
		model: llmService.modelFor(target),
		postProcessing: {
			mode: llmService.getPromptPostProcessing(target),
			placeholder: llmService.getPromptPlaceholder(target)
		},
		contextBudget: llmService.getPromptTokenBudget(target)
	};
}
