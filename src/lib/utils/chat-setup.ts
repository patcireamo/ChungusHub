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
import type { CallTarget, PromptPostProcessingMode } from '$lib/types/llm';
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
 * Resolve the connection terms a chat's prompt is assembled in.
 *
 * `base` is the routing point the caller would ride without a chat in hand: the story send
 * and every meter beside it pass `primary`, while an engine passes its own target so its
 * assigned connection applies to assembly exactly as it does to the call.
 */
export function resolvePromptTarget(chat: Chat | null, base: CallTarget = 'primary'): PromptTarget {
	const target = base;
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
