/** LLM provider types */

/** Every provider, in display order. This list IS the client's provider vocabulary:
 *  `ProviderName` is derived from it, so adding a provider here is the only client edit.
 *  It still has to agree with the server's own `ProviderName` union and `PROVIDER_PROFILES`
 *  (server code is not type-checked, so that half is asserted in `src/lib/contracts.test.ts`;
 *  see architecture/llm-providers.md coupling #1). */
export const PROVIDER_NAMES = [
	'openai',
	'openai-compatible',
	'anthropic',
	'chutes',
	'deepseek',
	'electronhub',
	'googleaistudio',
	'mistral',
	'moonshot',
	'nanogpt',
	'openrouter',
	'perplexity',
	'xai',
	'zai'
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface LLMMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	/** Chat image attachments as server-relative paths (images/chat/<file>); the
	 *  server inlines the bytes for vision-capable providers at request time. */
	images?: string[];
}

/** Reasoning effort levels the app exposes; each provider maps them to its own values. */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

/** Mirrors the server-side ReasoningPolicy: which reasoning knobs a provider's API takes. */
export interface ReasoningPolicy {
	efforts?: Partial<Record<ReasoningEffort, string>>;
	effortField?: 'reasoning_effort' | 'reasoning-object';
	offViaThinking?: boolean;
	exclude?: boolean;
	gate?: 'model';
}

/**
 * Mirrors the server-side ProfileReasoning: what a provider profile declares about
 * reasoning. 'declared' says the dialect is unknowable from here (BYO endpoints), so
 * the connection names it and `resolveReasoningPolicy` (config/sampling.ts) turns the
 * pair into a real policy. The helpers take `ReasoningPolicy | null`, so an unresolved
 * value fails to type-check instead of rendering controls that send nothing.
 */
export type ProfileReasoning = ReasoningPolicy | 'declared';

/**
 * Which wire shape a bring-your-own endpoint speaks for reasoning, named by its
 * request field. Nothing on our side can detect it (/models never reports it), so
 * the person who stood the endpoint up picks it; 'none' means no control is shown
 * and nothing is sent. The dialects and the policies they resolve to live in one
 * table, REASONING_DIALECTS in config/sampling.ts.
 */
export type ReasoningDialect = 'none' | 'reasoning_effort' | 'reasoning-object';

/** Mirrors the server-side MediaPolicy: inline-image support of a provider's API. */
export interface MediaPolicy {
	images: boolean;
	gate?: 'model';
	detail?: boolean;
	shape?: 'openai' | 'string';
}

/**
 * Mirrors the server-side CachingPolicy: a provider's prompt-caching nature.
 *  - 'explicit': caches only where we place `cache_control`; a real on/off toggle,
 *                TTL selectable when `ttl` is set (Anthropic, OpenRouter).
 *  - 'auto':     caches server-side unconditionally; no field to send, no opt-out
 *                (OpenAI, DeepSeek, Grok, Gemini, …). The UI shows an honest note.
 * null (absent): no caching we can drive or report; the UI hides caching entirely.
 */
export interface CachingPolicy {
	mode: 'explicit' | 'auto';
	ttl?: boolean;
}

/**
 * Per-request response tuning sent with a generation. Providers translate only
 * the fields their profile declares support for. The UI hides the rest, so
 * what is visible is exactly what is sent.
 */
export interface GenerationTuning {
	reasoningEffort?: ReasoningEffort;
	/** The dialect this request speaks, carried only by connections whose provider declares
	 *  `reasoning: 'declared'` (BYO). Every other provider's dialect is known server-side and
	 *  this is ignored there, so it can never override one we ship. */
	reasoningPolicy?: ReasoningPolicy;
	showReasoning?: boolean;
	/** false = leave inline reasoning markers (<think> …) in message content instead of
	 *  extracting them to `thinking` server-side. Absent/true = extract. Provider-agnostic
	 *  post-processing, so it skips the capability gates. */
	parseInlineReasoning?: boolean;
	verbosity?: 'low' | 'medium' | 'high';
	imageDetail?: 'low' | 'high';
	/** Explicit-caching providers only: place `cache_control` breakpoints (set only when
	 *  the provider's caching is 'explicit' and the user enabled caching). */
	promptCaching?: boolean;
	/** Cache lifetime for those breakpoints, where the provider honours 1h (else 5m). */
	cacheTtl?: '5m' | '1h';
}

/**
 * Which sampling parameters a provider's API accepts, in the form the visibility
 * helpers and request builders consume. Mirrors the server-side ResolvedParamPolicy:
 *  - 'reported':  trust each model's self-reported `supported_parameters` (OpenRouter);
 *  - 'base-only': strict API, only universal temperature + max_tokens;
 *  - string[]:    a static allow-list of `supported_parameters`-vocabulary names.
 */
export type ResolvedParamPolicy = 'reported' | 'base-only' | string[];

/**
 * What a provider profile declares. Mirrors the server-side ParamPolicy: every
 * value is already resolved except 'declared', which says the endpoint is the
 * user's own (BYO openai-compatible) and its allow-list therefore lives on the
 * connection (`Connection.samplingParams`), not in any profile we ship.
 * `resolveParamPolicy` (config/sampling.ts) collapses it before use; the helpers
 * take `ResolvedParamPolicy`, so an unresolved policy fails to type-check.
 */
export type ParamPolicy = ResolvedParamPolicy | 'declared';

/**
 * How the assembled prompt is reshaped before sending, for APIs that restrict message
 * structure (single system message, alternating roles, user-first). Stored per connection;
 * 'merge' is the default. The transform lives in prompt-assembly's applyPostProcessing.
 */
export type PromptPostProcessingMode = 'none' | 'merge' | 'semi-strict' | 'strict' | 'single-user';

export const PROMPT_POST_PROCESSING_MODES: PromptPostProcessingMode[] = [
	'none',
	'merge',
	'semi-strict',
	'strict',
	'single-user'
];

/** User turn strict mode inserts when the prompt would otherwise open with the assistant. */
export const DEFAULT_PROMPT_PLACEHOLDER = '[Start a new chat]';

/** Default per-connection context window (tokens) when the user hasn't set one. */
export const DEFAULT_CONTEXT_SIZE = 32768;

/**
 * Upper bounds for the two token fields in the connection editor. They are UI
 * sanity caps, not capability claims: nothing in the app or on the server clamps
 * either value, and both sit far above any model that exists, so a real endpoint
 * is never the thing that hits them.
 */
export const MAX_CONTEXT_SIZE = 2097152;
export const MAX_RESPONSE_TOKENS = 262144;

/**
 * Rich metadata for a single model, normalized from the provider's /models
 * endpoint. Only `id` is guaranteed: providers that return bare ids leave the
 * rest undefined and the UI degrades gracefully.
 */
export interface ModelInfo {
	id: string;
	name?: string;
	contextLength?: number;
	/** USD per token (not per million). */
	pricing?: { prompt?: number; completion?: number };
	inputModalities?: string[];
	supportedParameters?: string[];
	created?: number;
	// ----- Rich enrichment (OpenRouter /models; undefined for bare providers) -----
	/** Training knowledge cutoff, e.g. "2024-04" (handy for a writing tool). */
	knowledgeCutoff?: string;
	/** Whether the default route applies content moderation (RP users care). */
	isModerated?: boolean;
	/** Largest completion the model allows; clamps the max-tokens slider. */
	maxCompletionTokens?: number;
	/** The model's own recommended temperature; seeds the slider hint. */
	defaultTemperature?: number;
	/** True when the model is a reasoning model (drives the reasoning badge). */
	isReasoning?: boolean;
}

/**
 * One provider endpoint that serves a given model (OpenRouter only). `tag` is
 * the routing slug used in RoutingConfig.order/only; `providerName` is for
 * display.
 */
export interface ModelEndpoint {
	providerName: string;
	tag: string;
	contextLength?: number;
	maxCompletionTokens?: number;
	quantization?: string;
	pricing?: { prompt?: number; completion?: number };
	supportedParameters?: string[];
	/** Uptime % over the last 30m, when available. */
	uptime?: number;
	/** Endpoint health: 0 = ok, negative = degraded/down. */
	status?: number;
	/** Typical first-token latency (ms), p50 over the last 30m. */
	latencyP50?: number;
	/** Typical generation throughput (tokens/sec), p50 over the last 30m. */
	throughputP50?: number;
}

/**
 * A provider account snapshot for the Connection page. Only OpenRouter fills
 * this in (from GET /api/v1/key + best-effort /api/v1/credits); other providers
 * return null and the UI degrades to a plain "connected" state.
 */
export interface ProviderAccount {
	/** Masked key fingerprint OpenRouter returns, e.g. "sk-or-v1-au7...890". */
	label: string | null;
	/** Spend cap in USD for this key; null = no cap. */
	limit: number | null;
	/** Remaining USD against the cap; null when there is no cap. */
	limitRemaining: number | null;
	/** Cap reset cadence, e.g. "monthly"; null when none. */
	limitReset: string | null;
	/** Lifetime spend on this key (USD). */
	usage: number;
	usageDaily: number;
	usageWeekly: number;
	usageMonthly: number;
	isFreeTier: boolean;
	/** True for provisioning/management keys: the wrong key type for inference. */
	isManagementKey: boolean;
	/** ISO expiry, or null when the key never expires. */
	expiresAt: string | null;
	/** Whole-account balance from /credits (total_credits − total_usage); null if unavailable. */
	balance: number | null;
}

/** OpenRouter quantization levels accepted by the routing `quantizations` filter. */
export const QUANTIZATION_LEVELS = ['int4', 'int8', 'fp4', 'fp6', 'fp8', 'fp16', 'bf16', 'fp32'] as const;

/**
 * Per-model OpenRouter provider routing. Stored client-side (camelCase) and
 * converted to OpenRouter's snake_case `provider` body field server-side.
 */
export interface RoutingConfig {
	/** Preferred provider slugs, in priority order. */
	order?: string[];
	/** Hard whitelist: only these providers may serve the request. */
	only?: string[];
	/** Fall back to non-preferred providers when the preferred ones fail. */
	allowFallbacks?: boolean;
	/** Auto-order endpoints by a single metric (overrides manual order). */
	sort?: 'price' | 'throughput' | 'latency';
	/** Price ceiling in USD per million tokens. */
	maxPrice?: { prompt?: number; completion?: number };
	quantizations?: string[];
	dataCollection?: 'allow' | 'deny';
	/** Restrict to zero-data-retention endpoints. */
	zdr?: boolean;
	/** Only route to providers that honor every sampling parameter we send. */
	requireParameters?: boolean;
	/** Hard deny-list: never route to these provider slugs. */
	ignore?: string[];
}

/** True when a routing config carries no active constraint (treated as "no routing"). */
export function isRoutingEmpty(c: RoutingConfig | null | undefined): boolean {
	return (
		!c ||
		(!c.order?.length &&
			!c.only?.length &&
			!c.ignore?.length &&
			c.allowFallbacks !== false &&
			!c.requireParameters &&
			!c.sort &&
			!c.quantizations?.length &&
			c.dataCollection !== 'deny' &&
			!c.zdr &&
			c.maxPrice?.prompt == null &&
			c.maxPrice?.completion == null)
	);
}

/** OpenRouter service tier: trades cost vs latency. 'default' = omit the field. */
export type ServiceTier = 'default' | 'flex' | 'priority';

/**
 * Generation settings configured by the user. Optional sampling knobs default to
 * a NEUTRAL value (the value at which they're a no-op), so they're only sent when
 * the user actually changes them AND the selected model supports them.
 */
/** The numeric sampling fields a slider can drive. */
export type SamplingParamKey =
	| 'temperature'
	| 'topP'
	| 'topK'
	| 'minP'
	| 'topA'
	| 'repetitionPenalty'
	| 'frequencyPenalty'
	| 'presencePenalty';

export interface GenerationSettings {
	temperature: number;
	maxTokens: number;
	topP: number;
	topK: number;
	minP: number;
	topA: number;
	repetitionPenalty: number;
	frequencyPenalty: number;
	presencePenalty: number;
	/** Deterministic seed; null = unset (omitted). */
	seed: number | null;
	serviceTier: ServiceTier;
	/** Stream the reply token by token (off = the message appears whole when done).
	 *  Applies to the Chungus Assistant too: off, each of its steps lands complete. */
	streamResponses: boolean;
	/** How hard reasoning models should think; 'auto' = provider default (nothing sent). */
	reasoningEffort: 'auto' | ReasoningEffort;
	/** Return the model's reasoning alongside the reply, where the API can control it. */
	showReasoning: boolean;
	/** Detect inline chain-of-thought markers (<think> tags, Harmony channels, …) in replies
	 *  and divert them to the reasoning box, keeping them out of chat content, and therefore
	 *  out of chat history and future prompts. Off = raw markers stay in the message text. */
	parseReasoning: boolean;
	/** Reply length/detail hint; 'auto' = nothing sent. GPT-5-era models only. */
	verbosity: 'auto' | 'low' | 'medium' | 'high';
	/** Include attached chat images in the prompt for vision-capable models. */
	sendImages: boolean;
	/** Resolution hint for attached images, where the API takes one. */
	imageDetail: 'auto' | 'low' | 'high';
	/** Explicit-caching providers: send `cache_control` breakpoints so the whole resent
	 *  prefix bills as cache reads. Off (default) = no markers; the choice is the user's.
	 *  Auto-caching providers cache server-side regardless, so this doesn't apply there. */
	promptCaching: boolean;
	/** Cache lifetime for explicit caching, where the provider honours 1h (Anthropic).
	 *  1h costs more to write but pays off across long chats. */
	cacheTtl: '5m' | '1h';
}

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
	temperature: 1.0,
	maxTokens: 6144,
	topP: 1,
	topK: 0,
	minP: 0,
	topA: 0,
	repetitionPenalty: 1,
	frequencyPenalty: 0,
	presencePenalty: 0,
	seed: null,
	serviceTier: 'default',
	streamResponses: true,
	reasoningEffort: 'auto',
	showReasoning: true,
	parseReasoning: true,
	verbosity: 'auto',
	sendImages: true,
	imageDetail: 'auto',
	promptCaching: false,
	cacheTtl: '5m'
};

/**
 * Who serves one model call. Routing is one flat map: every calling point
 * (`primary` = the story, `assistant` = the Chungus Assistant, plus each calling
 * engine by id) is assigned its own concrete connection in
 * `connectionStore.assignments`. There are no roles and no defaults-following: what
 * the Connections page shows is what the app routes each point to.
 *
 * `{ connection }` is the one target that names a connection outright instead of a
 * point in that map: a chat that has claimed its own connection sends on it, and
 * only the story's `primary` calls can be claimed that way. Resolving it is
 * `resolvePromptTarget`'s job (utils/chat-setup.ts), so no caller builds one by hand.
 */
export type CallTarget = 'primary' | 'assistant' | { engine: string } | { connection: string };

/**
 * A named, self-contained LLM connection: a provider, its own model, context
 * window, prompt reshaping, OpenRouter routing, and a full generation-settings
 * blob. The secret half (API key + base URL) lives server-side keyed by `id`
 * and never reaches this object. Surfaces bind to a connection by id.
 */
export interface Connection {
	id: string;
	name: string;
	provider: ProviderName;
	model: string;
	contextSize: number;
	postProcessing: PromptPostProcessingMode;
	/** User-turn placeholder for strict post-processing; pairs with `postProcessing`. */
	promptPlaceholder: string;
	/** OpenRouter provider routing for this connection's model (null = none). */
	routing: RoutingConfig | null;
	/**
	 * Sampling params this endpoint accepts, in `supported_parameters` vocabulary:
	 * the user's own declaration, and the allow-list a 'declared' provider policy
	 * resolves to. Only BYO openai-compatible connections use it; every other
	 * provider's real policy is known and wins. Empty = base knobs only (the state a
	 * connection stays in until its owner says otherwise). See DECLARABLE_PARAMS.
	 */
	samplingParams: string[];
	/**
	 * The reasoning wire shape this endpoint speaks, the same declaration as
	 * `samplingParams` in a different vocabulary: only BYO openai-compatible
	 * connections use it, every other provider's dialect is known and wins.
	 * 'none' (the state a connection stays in until its owner says otherwise)
	 * shows no reasoning control and sends nothing.
	 */
	reasoningDialect: ReasoningDialect;
	generation: GenerationSettings;
}

export interface LLMCompletionOptions {
	model: string;
	messages: LLMMessage[];
	maxTokens?: number;
	temperature?: number;
	stop?: string[];
	/** Extra request-body fields (sampling knobs + service_tier) merged verbatim. */
	params?: Record<string, string | number>;
	/** Reasoning/verbosity/media tuning; providers translate what they support. */
	tuning?: GenerationTuning;
	onToken?: (token: string) => void;
	onThinkingToken?: (token: string) => void;
	signal?: AbortSignal;
	/** Where this reply belongs in the story, for the two calls whose turn the SERVER writes
	 *  (a reply, an opening scene). Absent everywhere else, which is what keeps every other
	 *  call's result the client's to persist. See architecture/chat-sessions.md. */
	commit?: import('$shared/generation').GenerationCommit;
}

export interface LLMCompletionResult {
	content: string;
	thinking: string | null;
	finishReason: 'stop' | 'length' | 'error' | 'cancelled';
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	model: string;
	provider: string;
	/** Request start → the first streamed token of either kind, in ms. Null when nothing
	 *  streamed, which is every non-streamed call. Measured in the transport, the one place
	 *  that sees the frames land. */
	firstTokenMs: number | null;
	/** How long the reasoning stream ran, first thinking token to last, in ms. Null when the
	 *  turn produced no reasoning. */
	reasoningMs: number | null;
	/** The row the server wrote this reply as, for a call that carried a `commit`. Null for
	 *  every other call, and for a committing one that had nothing to land. */
	committedMessageId: string | null;
	/** The one-shot steering notes the commit really deleted. A subset of what the request
	 *  asked it to spend, since a note edited to permanent meanwhile is left armed. */
	spentSteeringIds: string[];
	/** The request lived through a dropped socket. Nothing this side clocked around the call
	 *  is usable: the disconnection is inside it. */
	reattached: boolean;
}

export interface LLMProviderConfig {
	apiKey: string;
	baseUrl?: string;
	defaultModel?: string;
	timeout?: number;
}

export interface LLMProvider {
	readonly name: string;
	readonly displayName: string;
	readonly availableModels: readonly string[];
	readonly supportsStreaming: boolean;

	configure(config: LLMProviderConfig): void;
	complete(options: LLMCompletionOptions): Promise<LLMCompletionResult>;
	validateCredentials(): Promise<boolean>;
	fetchAvailableModels?(): Promise<ModelInfo[]>;
}
