/**
 * The universe of generation/sampling knobs, in ONE place. Which controls a
 * user sees and which fields actually reach the API are driven entirely by the
 * selected model's `supportedParameters` (from OpenRouter's /models), not a
 * hardcoded per-model list, so new models/params need no code change.
 *
 * Ranges/labels are static (the API only gives names, not ranges); visibility
 * and sending are dynamic.
 */
import type {
	GenerationSettings,
	GenerationTuning,
	CachingPolicy,
	MediaPolicy,
	ModelInfo,
	ProfileReasoning,
	ReasoningDialect,
	ReasoningEffort,
	ReasoningPolicy,
	SamplingParamKey,
	ServiceTier,
	ParamPolicy,
	ResolvedParamPolicy
} from '$lib/types/llm';

/** A numeric sampling knob rendered as a slider. */
export interface SamplingSlider {
	/** The GenerationSettings field this control reads/writes. */
	key: SamplingParamKey;
	/** Exact string as it appears in a model's `supportedParameters`. */
	supportedKey: string;
	/** Exact /chat/completions request-body field name. */
	apiField: string;
	label: string;
	min: number;
	max: number;
	step: number;
	/** Render/parse as an integer. */
	int?: boolean;
	/** Value at which the knob is a no-op: omitted from the request when equal. */
	neutral: number;
	/** Always send when the model supports it (temperature has no neutral). */
	alwaysSend?: boolean;
	/** Shown even when the model reports no `supportedParameters` (universal knob). */
	base?: boolean;
	info: string;
}

export const SAMPLING_SLIDERS: SamplingSlider[] = [
	{ key: 'temperature', supportedKey: 'temperature', apiField: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.01, neutral: 1, alwaysSend: true, base: true, info: 'Lower = focused & predictable, higher = diverse & creative.' },
	{ key: 'topP', supportedKey: 'top_p', apiField: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01, neutral: 1, info: 'Nucleus sampling: keep the likeliest tokens up to probability P. 1 = off.' },
	{ key: 'topK', supportedKey: 'top_k', apiField: 'top_k', label: 'Top K', min: 0, max: 200, step: 1, int: true, neutral: 0, info: 'Keep only the K likeliest tokens each step. 0 = off.' },
	{ key: 'minP', supportedKey: 'min_p', apiField: 'min_p', label: 'Min P', min: 0, max: 1, step: 0.01, neutral: 0, info: "Drop tokens below this fraction of the top token's probability. 0 = off." },
	{ key: 'topA', supportedKey: 'top_a', apiField: 'top_a', label: 'Top A', min: 0, max: 1, step: 0.01, neutral: 0, info: "Adaptive cutoff scaled by the top token's probability. 0 = off." },
	{ key: 'repetitionPenalty', supportedKey: 'repetition_penalty', apiField: 'repetition_penalty', label: 'Repetition Penalty', min: 0, max: 2, step: 0.01, neutral: 1, info: 'Penalize reused tokens. 1 = off; higher reduces repetition.' },
	{ key: 'frequencyPenalty', supportedKey: 'frequency_penalty', apiField: 'frequency_penalty', label: 'Frequency Penalty', min: -2, max: 2, step: 0.01, neutral: 0, info: 'Penalize tokens by how often they appear. 0 = off.' },
	{ key: 'presencePenalty', supportedKey: 'presence_penalty', apiField: 'presence_penalty', label: 'Presence Penalty', min: -2, max: 2, step: 0.01, neutral: 0, info: 'Penalize tokens that already appeared at all. 0 = off.' }
];

/**
 * The knobs a BYO endpoint's owner can declare their endpoint accepts, in card
 * order: every non-base slider plus `seed`. Temperature is absent on purpose:
 * it is the universal knob every OpenAI-compatible surface takes, always sent
 * and never declarable. Derived from SAMPLING_SLIDERS so a new slider joins the
 * declaration vocabulary for free instead of drifting out of a hand-kept list.
 */
export const DECLARABLE_PARAMS: { key: string; label: string; info: string }[] = [
	...SAMPLING_SLIDERS.filter((p) => !p.base).map((p) => ({ key: p.supportedKey, label: p.label, info: p.info })),
	{ key: 'seed', label: 'Seed', info: 'A fixed seed makes the same prompt reproduce the same output.' }
];

/**
 * Collapse a provider's declared policy into one the visibility helpers and param
 * builders can consume. Everything but 'declared' passes through untouched; for
 * 'declared' (BYO OpenAI-compatible endpoints) the connection's own declaration
 * IS the allow-list, because the person who stood the endpoint up is the only
 * source of truth about what it accepts. An empty declaration therefore behaves
 * exactly like 'base-only': no branch needed, the allow-list code already does it.
 */
export function resolveParamPolicy(policy: ParamPolicy, declared: string[]): ResolvedParamPolicy {
	return policy === 'declared' ? declared : policy;
}

/**
 * The reasoning wire shapes a BYO endpoint's owner can declare, and the policy each
 * one resolves to. One table: the Select renders from it and `resolveReasoningPolicy`
 * reads from it, so a dialect cannot be offered without a translation behind it.
 *
 * Neither dialect gates on the model's `isReasoning` flag: a BYO /models almost never
 * carries one, and gating would hide the control its owner just declared.
 *
 * Effort levels are the documented ones, not a superset: vLLM takes low/medium/high
 * plus "none" to disable, Ollama rejects "minimal", and llama.cpp only acts on "none".
 * The nested shape mirrors the OpenRouter profile, which is the request surface the
 * gateways speaking it copy.
 */
export const REASONING_DIALECTS: {
	value: ReasoningDialect;
	label: string;
	hint: string;
	policy: ReasoningPolicy | null;
}[] = [
	{
		value: 'none',
		label: 'None',
		hint: 'No reasoning control, and nothing added to the request.',
		policy: null
	},
	{
		value: 'reasoning_effort',
		label: 'reasoning_effort',
		hint: 'A flat reasoning_effort field. vLLM, Ollama, llama.cpp and NVIDIA NIM read this one.',
		policy: { efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' } }
	},
	{
		value: 'reasoning-object',
		label: 'reasoning.effort',
		hint: 'A nested reasoning object. Gateways built on OpenRouter’s request shape read this one.',
		policy: {
			efforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' },
			effortField: 'reasoning-object',
			exclude: true
		}
	}
];

/**
 * Collapse a provider's declared reasoning into the policy the visibility helpers and
 * `applyTuning` consume. Everything but 'declared' passes through untouched; for
 * 'declared' (BYO endpoints) the connection's chosen dialect IS the policy, because the
 * person who stood the endpoint up is the only source of truth about what it speaks.
 * 'none' resolves to null: no controls, nothing sent, which is where a connection stays
 * until its owner says otherwise.
 */
export function resolveReasoningPolicy(
	reasoning: ProfileReasoning | null,
	dialect: ReasoningDialect
): ReasoningPolicy | null {
	if (reasoning !== 'declared') return reasoning;
	return REASONING_DIALECTS.find((d) => d.value === dialect)?.policy ?? null;
}

export const SERVICE_TIERS: { value: ServiceTier; label: string; hint: string }[] = [
	{ value: 'default', label: 'Default', hint: 'Standard routing and pricing.' },
	{ value: 'flex', label: 'Flex', hint: 'Lower cost, higher latency.' },
	{ value: 'priority', label: 'Priority', hint: 'Faster, higher cost.' }
];

/** Model-id authors whose providers honor service tiers (OpenRouter's allowlist). */
const TIER_AUTHORS = new Set(['openai', 'google']);

/**
 * Whether the service-tier control is meaningful. Aggregators (OpenRouter) namespace
 * ids as `author/model` and only openai/google authors honour tiers, so we author-gate
 * those. A direct single-vendor provider that flags the capability vouches for all its
 * (unnamespaced) ids, so a slash-free id is eligible whenever the provider is capable.
 */
export function serviceTierEligible(capable: boolean, modelId: string): boolean {
	if (!capable || !modelId) return false;
	const slash = modelId.indexOf('/');
	return slash === -1 ? true : TIER_AUTHORS.has(modelId.slice(0, slash));
}

/** true = supported, false = not supported, null = unknown (provider didn't report). */
function supportState(model: ModelInfo | undefined, key: string): boolean | null {
	const sup = model?.supportedParameters;
	if (!sup) return null;
	return sup.includes(key);
}

/**
 * Whether a slider should be shown for this model, per the provider's param policy:
 *  - 'base-only': strict API, only the universal base knobs (temperature);
 *  - allow-list:  base knobs plus anything the provider documents as accepted;
 *  - 'reported':  driven by the model's own `supported_parameters` (base knobs
 *                 when the provider hasn't reported any yet).
 * Kept in lockstep with buildGenerationParams so "visible === sent". Takes a
 * RESOLVED policy: a BYO endpoint's declaration arrives here as a plain allow-list.
 */
export function sliderVisible(p: SamplingSlider, model: ModelInfo | undefined, policy: ResolvedParamPolicy): boolean {
	if (policy === 'base-only') return !!p.base;
	if (Array.isArray(policy)) return !!p.base || policy.includes(p.supportedKey);
	const s = supportState(model, p.supportedKey);
	return s === null ? !!p.base : s;
}

/** Whether the seed control should be shown (the provider/model advertises `seed`). */
export function seedVisible(model: ModelInfo | undefined, policy: ResolvedParamPolicy): boolean {
	if (policy === 'base-only') return false;
	if (Array.isArray(policy)) return policy.includes('seed');
	return supportState(model, 'seed') === true;
}

/**
 * Shared capability probe for the param builders ('base-only' is handled before
 * this): how a provider/model answers "may I send k?" under each policy.
 *  - supports(): for 'reported', boolean|null (null = provider hasn't reported);
 *    for an allow-list, a plain membership test.
 *  - listed(): plain boolean membership under either policy.
 */
function paramSupport(model: ModelInfo | undefined, policy: ResolvedParamPolicy) {
	const reported = policy === 'reported';
	const sup = model?.supportedParameters;
	return {
		reported,
		supports: (k: string): boolean | null => (reported ? (sup ? sup.includes(k) : null) : policy.includes(k)),
		listed: (k: string): boolean => (reported ? !!sup?.includes(k) : policy.includes(k))
	};
}

/** Emit the output cap under whichever max field the API advertises. Sent always,
 *  except when a reported policy explicitly rejects `max_tokens` without
 *  affirming `max_completion_tokens`. */
function emitMaxTokens(out: Record<string, string | number>, cap: ReturnType<typeof paramSupport>, value: number): void {
	const field = cap.listed('max_completion_tokens') && !cap.listed('max_tokens') ? 'max_completion_tokens' : 'max_tokens';
	if (!cap.reported || cap.supports('max_tokens') !== false || cap.supports('max_completion_tokens') === true) {
		out[field] = value;
	}
}

/**
 * Assemble the request-body sampling fields for one generation, driven by the
 * provider's param policy:
 *  - 'base-only': strict API, only the universal `temperature` + `max_tokens`;
 *  - allow-list:  base fields plus every param the provider documents (respecting
 *                 each knob's neutral value);
 *  - 'reported':  filter by the model's `supported_parameters`. Callers warm the
 *                 model cache first (llmService.ensureModelsLoaded), so support is
 *                 normally known. Only if that fetch failed is support UNKNOWN; then we
 *                 still send what the user set rather than dropping it silently.
 */
export function buildGenerationParams(
	g: GenerationSettings,
	model: ModelInfo | undefined,
	policy: ResolvedParamPolicy,
	modelId: string,
	serviceTierCapable: boolean
): Record<string, string | number> {
	const out: Record<string, string | number> = {};

	if (policy === 'base-only') {
		out.max_tokens = g.maxTokens;
		out.temperature = g.temperature;
		return out;
	}

	const cap = paramSupport(model, policy);
	emitMaxTokens(out, cap, g.maxTokens);

	for (const p of SAMPLING_SLIDERS) {
		// reported: send unless explicitly unsupported (null = cold cache, still send).
		// allow-list: base knobs always, others only when documented.
		const send = cap.reported ? cap.supports(p.supportedKey) !== false : !!p.base || cap.listed(p.supportedKey);
		if (!send) continue;
		if (p.alwaysSend) {
			out[p.apiField] = g[p.key];
		} else if (g[p.key] !== p.neutral) {
			out[p.apiField] = g[p.key];
		}
	}

	const seedOk = cap.reported ? cap.supports('seed') !== false : cap.listed('seed');
	if (seedOk && g.seed != null) out.seed = g.seed;

	// service_tier isn't in supported_parameters. Gate on the provider capability
	// plus the documented model-author allowlist, so it matches when the UI shows it.
	if (g.serviceTier !== 'default' && serviceTierEligible(serviceTierCapable, modelId)) out.service_tier = g.serviceTier;

	return out;
}

// ===== Response tuning (reasoning / verbosity / media) =====
// Same contract as the sliders: a control is only shown where the provider's
// profile documents support, and only shown values are sent.

/** Selectable effort levels, in menu order ('auto' is prepended by effortOptions). */
const EFFORT_ORDER: ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'max'];

export const EFFORT_LABELS: Record<'auto' | ReasoningEffort, string> = {
	auto: 'Auto',
	off: 'Off',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	max: 'Max'
};

/** Model-gated reasoning policies apply only to models flagged isReasoning; an
 *  unfetched model list (cold cache) keeps the control visible, like the sliders. */
function reasoningGateOpen(policy: ReasoningPolicy | null, model: ModelInfo | undefined): boolean {
	if (!policy) return false;
	if (policy.gate === 'model' && model) return model.isReasoning === true;
	return true;
}

/** Effort levels selectable for this provider, 'auto' first. */
export function effortOptions(policy: ReasoningPolicy | null): ('auto' | ReasoningEffort)[] {
	if (!policy) return [];
	const levels = EFFORT_ORDER.filter(
		(level) => policy.efforts?.[level] !== undefined || (level === 'off' && policy.offViaThinking)
	);
	return levels.length ? ['auto', ...levels] : [];
}

export function effortVisible(policy: ReasoningPolicy | null, model: ModelInfo | undefined): boolean {
	return effortOptions(policy).length > 1 && reasoningGateOpen(policy, model);
}

/** The show-reasoning toggle appears only where visibility is controllable independently. */
export function showReasoningVisible(policy: ReasoningPolicy | null, model: ModelInfo | undefined): boolean {
	return !!policy?.exclude && reasoningGateOpen(policy, model);
}

export function verbosityVisible(capability: boolean | 'reported', model: ModelInfo | undefined): boolean {
	if (capability === true) return true;
	if (capability === 'reported') return model?.supportedParameters?.includes('verbosity') === true;
	return false;
}

/** Whether chat images may be attached/sent for this provider + model. */
export function imagesEnabled(media: MediaPolicy | null, model: ModelInfo | undefined): boolean {
	if (!media?.images) return false;
	if (media.gate === 'model' && model) return model.inputModalities?.includes('image') === true;
	return true;
}

export function imageDetailVisible(media: MediaPolicy | null, model: ModelInfo | undefined): boolean {
	return imagesEnabled(media, model) && !!media?.detail;
}

/**
 * What the caching control should render for a provider:
 *  - 'explicit' → an interactive on/off toggle; `ttl` true = also offer a 5m/1h selector;
 *  - 'auto'     → an honest read-only note ("caches automatically, always on"); no toggle;
 *  - null       → nothing (the API has no caching we can drive or report).
 * Mirrors buildGenerationTuning so what is visible is exactly what is sent.
 */
export function cachingControl(caching: CachingPolicy | null): { mode: 'explicit' | 'auto'; ttl: boolean } | null {
	if (!caching) return null;
	return { mode: caching.mode, ttl: caching.mode === 'explicit' && !!caching.ttl };
}

/**
 * Assemble the per-request tuning from the global generation settings, filtered
 * to what the active provider/model actually supports, kept in lockstep with
 * the visibility helpers above so "visible === sent".
 */
export function buildGenerationTuning(
	g: GenerationSettings,
	reasoning: ProfileReasoning | null,
	dialect: ReasoningDialect,
	media: MediaPolicy | null,
	verbosity: boolean | 'reported',
	caching: CachingPolicy | null,
	model: ModelInfo | undefined
): GenerationTuning | undefined {
	const out: GenerationTuning = {};
	const policy = resolveReasoningPolicy(reasoning, dialect);
	if (g.reasoningEffort !== 'auto' && effortVisible(policy, model) && effortOptions(policy).includes(g.reasoningEffort)) {
		out.reasoningEffort = g.reasoningEffort;
	}
	if (!g.showReasoning && showReasoningVisible(policy, model)) out.showReasoning = false;
	// The server knows every shipped provider's dialect; only a declared one has to ride
	// along, and only when something actually uses it. Sending it beside nothing would put
	// a policy on the wire (and in the prompt debug panel) that translates to no field.
	if (reasoning === 'declared' && policy && (out.reasoningEffort !== undefined || out.showReasoning !== undefined)) {
		out.reasoningPolicy = policy;
	}
	// Inline-marker parsing is our own post-processing, not a wire param, so no capability
	// gate applies: only the non-default (off) state is carried.
	if (!g.parseReasoning) out.parseInlineReasoning = false;
	if (g.verbosity !== 'auto' && verbosityVisible(verbosity, model)) out.verbosity = g.verbosity;
	if (g.imageDetail !== 'auto' && imageDetailVisible(media, model)) out.imageDetail = g.imageDetail;
	// Explicit-caching providers only: carry the on/off + TTL choice. Auto/none providers cache
	// (or not) server-side regardless, so we send nothing, matching the read-only UI note.
	if (caching?.mode === 'explicit' && g.promptCaching) {
		out.promptCaching = true;
		if (caching.ttl && g.cacheTtl === '1h') out.cacheTtl = '1h';
	}
	return Object.keys(out).length ? out : undefined;
}
