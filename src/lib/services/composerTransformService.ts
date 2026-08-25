/**
 * Composer Transform Service
 * Runs the user's composer draft through an LLM for on-demand rewrites: Spellcheck
 * (fix spelling/grammar/punctuation/flow while preserving voice) and Impersonate (expand
 * a short draft into a full message from the user's persona's perspective).
 * Both ride their own engine connection and that connection's generation settings,
 * so the two can sit on different models. Split in two on purpose (a pure build-prompt
 * function, then a run function), so the exact messages a real run would send can be
 * inspected without making the call, which is what `TransformPanel` prices its
 * before-you-press estimate off. The message SHAPE (Impersonate's role-swapped history,
 * post-processing) lives in the pure utils/composer-transforms; this file resolves the
 * live inputs it needs.
 *
 * No UI, no store writes, no persistence here: the result only ever reaches the draft
 * through `TransformPanel`'s approve/reject. The one thing this file waits on a person for
 * is the prompt hold, and that is a gate on the request rather than a surface of its own.
 */

import type { LLMMessage } from '$lib/types/llm';
import type { Message, ImpersonatePerspective } from '$lib/types/chat';
import { llmService } from '$lib/services/llm/provider';
import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
import { promptHoldStore } from '$lib/stores/promptHold.svelte';
import { resolveMacroValues, substitute } from '$lib/macros';
import { buildLiveMacroContext } from '$lib/utils/live-macro-context';
import { shapeComposerTransform } from '$lib/utils/composer-transforms';

export interface ComposerTransformParams {
	kind: 'spellcheck' | 'impersonate';
	draft: string;
	chatMessages: Message[];
	/** Impersonate only; defaults to 'first' when omitted. */
	perspective?: ImpersonatePerspective;
	signal?: AbortSignal;
}

/** Exported so the panel's cost estimate is counted off the exact messages a real run
 *  would send, and the two can never drift. */
export function buildComposerTransformPrompt(params: ComposerTransformParams): LLMMessage[] {
	const { kind, draft, chatMessages, perspective = 'first' } = params;

	const template = featurePromptsStore.promptFor(kind);
	// Global engine macros first ({{char}}/{{user}}/etc. from live story state), the flow's
	// own draft/perspective values on top, the same two-phase idiom the opening scene uses
	// for {{idea}}. Neither key is registered in macros.ts; they're ad-hoc flow values.
	// Impersonate is a story generation of its own, so lore entries limited to it fire here
	// and nowhere else. Spellcheck reads the same context under the plain send's terms.
	const ctx = buildLiveMacroContext({
		chatMessages,
		lorebookTrigger: kind === 'impersonate' ? 'impersonate' : undefined
	});
	const filled = substitute(template, {
		...resolveMacroValues(template, ctx),
		draft,
		perspective
	});

	// The shape (Impersonate's role-swapped history + final-user-turn template, and the
	// engine connection's own post-processing) is the pure module's business; the live
	// names carry the same fallbacks as prompt-assembly.toInjectedMessage.
	return shapeComposerTransform({
		kind,
		filled,
		chatMessages,
		charName: ctx.resolvedCharacters?.[0]?.name || 'Narrator',
		userName: ctx.resolvedPersona?.name || 'User',
		postProcessing: {
			mode: llmService.getPromptPostProcessing({ engine: kind }),
			placeholder: llmService.getPromptPlaceholder({ engine: kind })
		}
	});
}

/** The rewrite, or null when the reader cancelled this kind's prompt hold: nothing was spent
 *  and the panel goes back to where its press came from. */
export async function runComposerTransform(opts: ComposerTransformParams): Promise<string | null> {
	const { kind, draft, signal } = opts;

	// Fail loud at the top, same style as generateOpeningScene's disabled-guard
	// (messages.svelte.ts): the composer UI hides the trigger when its engine is off, so
	// reaching here with the flag off means something called in anyway.
	if (kind === 'spellcheck' && !featurePromptsStore.spellcheckEnabled) {
		throw new Error('Spellcheck is turned off in Settings → Engines');
	}
	if (kind === 'impersonate' && !featurePromptsStore.impersonateEnabled) {
		throw new Error('Impersonate is turned off in Settings → Engines');
	}
	if (!draft.trim()) throw new Error('Cannot transform an empty draft');

	const messages = buildComposerTransformPrompt(opts);

	// The hold, when this gate is armed: what the reader approves is what goes out. It sits
	// here rather than in the panel so the request cannot be built twice, once to review and
	// once to send. Nothing has been spent at this point, which is what makes a cancel free.
	const approved = await promptHoldStore.review(kind, messages, { engine: kind });
	if (!approved) return null;

	// Unlike a background sidecar, these transforms are user-triggered foreground actions
	// the caller is actively waiting on, so errors (including AbortError) PROPAGATE: no
	// catch-and-null here. The approve/reject dialog renders them.
	const result = await llmService.complete({ engine: kind }, { messages: approved, source: kind, signal });

	const text = result.content.trim();
	if (!text) throw new Error('The transform returned an empty result');
	return text;
}
