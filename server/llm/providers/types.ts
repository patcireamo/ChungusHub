/**
 * A provider profile: everything that differs between the OpenAI-compatible
 * providers we ship. The generic OpenAICompatibleProvider stays untouched:
 * a new provider is a new file in this folder plus one line in index.ts, and a
 * provider's quirks (which params it accepts, how its /models is shaped, whether
 * it exposes a balance endpoint) live entirely in its own file.
 */
import type {
	LLMProvider,
	LLMToolStreamOptions,
	LLMToolResult,
	ModelInfo,
	ModelEndpoint,
	ProviderAccount,
	ReasoningPolicy
} from '../types';

/**
 * Which sampling parameters the API accepts, in the form the visibility helpers
 * and request builders consume:
 *  - 'reported':    trust each model's self-reported `supported_parameters`
 *                   (OpenRouter; only provider rich enough to drive the UI live).
 *  - 'base-only':   a strict API that takes only the universal temperature + max_tokens.
 *  - string[]:      a static allow-list of `supported_parameters`-vocabulary
 *                   names the provider documents (e.g. ['temperature','top_p']).
 */
export type ResolvedParamPolicy = 'reported' | 'base-only' | string[];

/**
 * What a profile may declare. Everything except 'declared' is already resolved.
 *
 * 'declared' states the opposite of a capability: the endpoint is the user's own
 * (the BYO openai-compatible profile), so nothing on our side can know what it
 * accepts. The CONNECTION carries the allow-list instead: `Connection.samplingParams`,
 * written by the person who set the endpoint up, the only one who actually knows.
 * It is resolved into a plain allow-list (`resolveParamPolicy` in config/sampling.ts)
 * before any visibility or request-building code sees it; those take
 * `ResolvedParamPolicy`, so leaving it unresolved is a type error, not a silent
 * mis-branch.
 */
export type ParamPolicy = ResolvedParamPolicy | 'declared';

export type { ReasoningPolicy } from '../types';

/**
 * What a profile may declare about reasoning. A concrete policy is already
 * resolved; 'declared' states the opposite of a capability, exactly as the
 * ParamPolicy literal of the same name does: the endpoint is the user's own
 * (the BYO openai-compatible profile), so nothing here can know which dialect
 * it speaks. The CONNECTION carries the choice instead (`Connection.reasoningDialect`),
 * resolved into a real policy by `resolveReasoningPolicy` (config/sampling.ts)
 * before any visibility or request-building code sees it. The visibility helpers
 * take `ReasoningPolicy | null`, so leaving it unresolved is a type error rather
 * than a control that renders and sends nothing.
 */
export type ProfileReasoning = ReasoningPolicy | 'declared';

/**
 * How a provider handles prompt caching, so the app can offer honest, per-provider
 * control instead of a one-size toggle that lies on half the providers:
 *  - 'explicit':  the API caches only where we place `cache_control` breakpoints
 *                 (Anthropic Messages API; OpenRouter forwards them to Anthropic/
 *                 Gemini/Qwen upstreams and ignores them elsewhere). This is the one
 *                 mode a user toggle can truly turn ON/OFF, and TTL is selectable.
 *  - 'auto':      the API caches server-side unconditionally; there is no field to
 *                 send and no way to opt out (OpenAI, DeepSeek, Grok, Gemini implicit,
 *                 Moonshot, Z.AI, Mistral, …). We never send `cache_control` here (a
 *                 strict API can 4xx on it); the UI shows an honest read-only note.
 * Absent = the API has no prompt caching (or an unknown custom endpoint): no markers,
 * no UI.
 */
export interface CachingPolicy {
	mode: 'explicit' | 'auto';
	/** Explicit only: the API honours a 1-hour TTL (`cache_control.ttl: '1h'`), not just
	 *  the 5-minute default (Anthropic; OpenRouter for Anthropic upstreams). */
	ttl?: boolean;
}

/** Inline-image support: whether the chat API takes image content parts at all,
 *  whether an OpenAI-style `detail` hint is honoured, and the content-part shape. */
export interface MediaPolicy {
	images: boolean;
	/** Show the attach affordance only for models advertising image input. */
	gate?: 'model';
	/** The API honours `image_url.detail` (low/high). Strict APIs 4xx on it, so leave off there. */
	detail?: boolean;
	/** Mistral quirk: `image_url` is a bare string, not `{url}`. */
	shape?: 'openai' | 'string';
}

/**
 * Context handed to per-provider hooks so they can call the provider's own API
 * (auth + base URL already wired) without reaching into the shared class.
 */
export interface ProviderRuntime {
	baseUrl: string;
	/** fetch against `${baseUrl}${path}` with the provider's auth + extra headers applied. */
	request(path: string, init?: RequestInit): Promise<Response>;
	/** Turn a failed Response into a human-readable error string (shared parser). */
	extractError(res: Response): Promise<string>;
}

/**
 * The behavior surface the registry drives: the client-facing LLMProvider
 * contract plus tool-calling, model endpoints and account snapshots. Static
 * and capability metadata (base URL, key requirement, param policy, routing,
 * service tier, account presence) is deliberately NOT here: the registry
 * reads it from the ProviderProfile, so the profile stays the single source
 * of truth and a native implementation can never drift from its profile.
 */
export interface ChatProvider extends LLMProvider {
	completeWithTools(options: LLMToolStreamOptions): Promise<LLMToolResult>;
	fetchAvailableModels(): Promise<ModelInfo[]>;
	fetchModelEndpoints(model: string): Promise<ModelEndpoint[]>;
	fetchAccountInfo(): Promise<ProviderAccount | null>;
	/** For providers whose base URL the user supplies: the URL that actually answered,
	 *  when it differs from what was typed. Absent on providers with a fixed endpoint. */
	resolvedBaseUrl?(): string | null;
}

export interface ProviderProfile {
	name: string;
	displayName: string;
	defaultBaseUrl: string;
	requiresApiKey: boolean;
	baseUrlEditable: boolean;
	extraHeaders?: Record<string, string>;

	/** Sampling-param support policy (defaults to 'base-only'). */
	paramPolicy?: ParamPolicy;
	/** OpenRouter-style per-model provider routing (shows the routing panel). */
	routing?: boolean;
	/** The API honours the OpenAI `service_tier` field. */
	serviceTier?: boolean;
	/** Reasoning controls the API documents (absent = none; controls stay hidden), or
	 *  'declared' when only the endpoint's owner can know (BYO). */
	reasoning?: ProfileReasoning;
	/** Inline-image support (absent = the API takes no image content parts). */
	media?: MediaPolicy;
	/** The API accepts a `verbosity` field: true = provider-wide (OpenAI GPT-5),
	 *  'reported' = per-model via supported_parameters (OpenRouter). */
	verbosity?: boolean | 'reported';
	/** Prompt-caching nature (absent = the API has no caching we can drive or report). */
	caching?: CachingPolicy;

	/**
	 * Provider-specific /models field mapping, merged over the generic
	 * normalization. Return only the fields you actually resolved.
	 */
	normalizeModel?(raw: Record<string, unknown>): Partial<ModelInfo>;
	/** Account / balance snapshot for the connection ledger (presence => UI shows it). */
	fetchAccount?(rt: ProviderRuntime): Promise<ProviderAccount | null>;
	/** Provider endpoints that serve a given model (OpenRouter only). */
	fetchModelEndpoints?(rt: ProviderRuntime, model: string): Promise<ModelEndpoint[]>;

	/**
	 * Native (non-OpenAI-compatible) implementation. When present the registry
	 * instantiates this instead of wrapping the profile in the generic
	 * OpenAICompatibleProvider, for vendors whose real API is worth speaking
	 * directly (Anthropic's Messages API). Everything else about the profile
	 * (metadata, display order, one-line registration) stays identical.
	 */
	createProvider?(profile: ProviderProfile): ChatProvider;
}
