/**
 * Pure message shaping for the composer transforms (Spellcheck, Impersonate): what goes on
 * the wire once the template is filled. Split out of composerTransformService so bun test
 * can reach it (the service reads stores; architecture/testing.md's pure-core pattern).
 * The service resolves the template, the live names and the connection's post-processing;
 * this module owns the shape. Covered by composer-transforms.test.ts.
 */

import type { LLMMessage, PromptPostProcessingMode } from '$lib/types/llm';
import type { Message } from '$lib/types/chat';
import { expandSelfRefs } from '$lib/macros';
import { applyPostProcessing } from './prompt-assembly';

export interface TransformShapeInput {
	kind: 'spellcheck' | 'impersonate';
	/** The engine template with every macro and flow key already substituted. */
	filled: string;
	chatMessages: Message[];
	/** Live names for self-ref expansion, same fallbacks as prompt-assembly.toInjectedMessage. */
	charName: string;
	userName: string;
	/** The engine connection's own reshaping, the same one assembly applies for the story
	 *  prompt: Impersonate is the one engine sending a multi-turn history, so a connection
	 *  declared strict or single-user must get the shape it declared. */
	postProcessing: { mode: PromptPostProcessingMode; placeholder?: string };
}

export function shapeComposerTransform(input: TransformShapeInput): LLMMessage[] {
	const { kind, filled, chatMessages, charName, userName, postProcessing } = input;
	const postProcess = (messages: LLMMessage[]) =>
		applyPostProcessing(messages, postProcessing.mode, postProcessing.placeholder);

	if (kind === 'spellcheck') {
		// The template embeds the draft and needs no story context: a single user turn
		// is the shape every provider accepts.
		return postProcess([{ role: 'user', content: filled }]);
	}

	// Impersonate: history rides with the ROLES SWAPPED so the chat template itself seats
	// the model as the user; unswapped, the whole context conditions the assistant seat as
	// {{char}} and small models write the character no matter what an instruction asks.
	// Self-refs expand like injected story turns (prompt-assembly.toInjectedMessage), and
	// the filled template closes the prompt as the final user turn so the task and draft
	// sit where generation begins instead of decaying with chat length.
	const history: LLMMessage[] = chatMessages
		.filter((m) => m.role === 'user' || m.role === 'assistant')
		.map((m) => ({
			role: m.role === 'user' ? ('assistant' as const) : ('user' as const),
			content: expandSelfRefs(m.content, charName, userName)
		}));

	return postProcess([...history, { role: 'user', content: filled }]);
}
