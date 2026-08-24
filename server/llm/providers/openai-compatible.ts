import type { ProviderProfile } from './types';

/**
 * Bring-your-own OpenAI-compatible endpoint (LM Studio, llama.cpp, vLLM, …).
 * The user supplies the base URL, so nothing here can know its param support:
 * these stacks serve exactly the RP knobs (min_p, top_k, repetition_penalty)
 * that a strict base-only policy hides, and their /models never reports
 * `supported_parameters`, so 'reported' would degrade to base-only too.
 *
 * 'declared' is the honest answer to that: we don't claim, we ask. Each
 * connection carries its owner's own allow-list (`Connection.samplingParams`),
 * and "visible === sent" holds against it exactly as it does against a static
 * allow-list. An empty declaration behaves as base-only, so a connection that
 * has never been told anything sends nothing beyond the universal knobs.
 *
 * Reasoning is the same story in a different vocabulary. These stacks disagree
 * on the wire shape (vLLM/Ollama/llama.cpp take `reasoning_effort`, gateways
 * built on OpenRouter's surface take `reasoning: {effort}`), and /models never
 * says which. So the connection names its dialect and the request carries the
 * resolved policy; absent, no reasoning control is shown or sent, exactly as
 * before.
 */
export const openaiCompatible: ProviderProfile = {
	name: 'openai-compatible',
	displayName: 'OpenAI Compatible',
	defaultBaseUrl: '',
	requiresApiKey: false,
	baseUrlEditable: true,
	paramPolicy: 'declared',
	reasoning: 'declared',
	// Image parts are part of the standard surface most local stacks implement
	// (vLLM, LM Studio); an endpoint that doesn't will reject them loudly.
	// Verbosity stays off: it is an OpenAI-only field, not a BYO dialect question.
	media: { images: true }
};
