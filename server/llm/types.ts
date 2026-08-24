/** LLM provider types (server-side). Mirrors the client-facing contract. */

export type ProviderName =
	| 'openai'
	| 'openai-compatible'
	| 'anthropic'
	| 'chutes'
	| 'deepseek'
	| 'electronhub'
	| 'googleaistudio'
	| 'mistral'
	| 'moonshot'
	| 'nanogpt'
	| 'openrouter'
	| 'perplexity'
	| 'xai'
	| 'zai';

export interface LLMMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	/** Chat image attachments as server-relative paths (images/chat/<file>); providers
	 *  load the bytes and build their own multimodal content parts. */
	images?: string[];
}

/** Reasoning effort levels the app exposes; each provider maps them to its own values. */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

/**
 * How a provider's API expresses reasoning controls. Drives BOTH the request
 * translation (OpenAICompatibleProvider / native provider) and the client UI
 * (which effort levels appear, whether a visibility toggle shows), so what is
 * visible is exactly what is sent. Lives here beside `ReasoningEffort`, which
 * keys it; `providers/types.ts` re-exports it for the profiles.
 */
export interface ReasoningPolicy {
	/**
	 * App effort level → the provider's documented wire value. Only mapped levels
	 * are selectable in the UI. 'off' appears here when the API disables thinking
	 * via an effort value (e.g. OpenRouter 'none'); use `offViaThinking` when the
	 * API uses `thinking: {type: "disabled"}` instead.
	 */
	efforts?: Partial<Record<ReasoningEffort, string>>;
	/** Where effort values go: flat `reasoning_effort` (default) or nested `reasoning: {effort}`. */
	effortField?: 'reasoning_effort' | 'reasoning-object';
	/** 'off' sends `thinking: {type: "disabled"}` (DeepSeek / Z.AI / Moonshot style). */
	offViaThinking?: boolean;
	/** Reasoning visibility is controllable independently via `reasoning: {exclude: true}`. */
	exclude?: boolean;
	/** Show reasoning controls only for models flagged isReasoning (from /models). */
	gate?: 'model';
}

/**
 * Per-request response tuning built from the user's generation settings. Every
 * field is optional; absent = provider default. Providers translate only the
 * fields their profile declares support for and ignore the rest. The client
 * hides unsupported controls, so "visible === sent" holds per provider.
 */
export interface GenerationTuning {
	reasoningEffort?: ReasoningEffort;
	/**
	 * The reasoning dialect for THIS request, sent only by connections whose provider
	 * declares `reasoning: 'declared'` (the BYO openai-compatible profile), where the
	 * endpoint is the user's own and nothing on our side can know what it speaks. The
	 * connection's owner picks it and the client resolves it here, so the server stays
	 * the same dumb translator it is for a profile-declared policy. Ignored by every
	 * provider whose own dialect is known.
	 */
	reasoningPolicy?: ReasoningPolicy;
	/** Return the model's reasoning alongside the reply (visibility, where controllable). */
	showReasoning?: boolean;
	/** false = leave inline reasoning markers (<think> …, see inline-reasoning.ts) in message
	 *  content instead of extracting them to `thinking`. Absent/true = extract. Our own
	 *  post-processing, not a wire param: provider-agnostic, so no profile policy gates it. */
	parseInlineReasoning?: boolean;
	verbosity?: 'low' | 'medium' | 'high';
	/** Resolution hint for attached images, where the API takes one. */
	imageDetail?: 'low' | 'high';
	/** Explicit-caching providers only: place `cache_control` breakpoints this request.
	 *  Absent/false = no markers. The client sets it only for a provider whose caching is
	 *  'explicit' AND the user turned caching on; auto-caching providers cache regardless. */
	promptCaching?: boolean;
	/** Cache lifetime for those breakpoints, where the provider honours 1h (else 5m). */
	cacheTtl?: '5m' | '1h';
}

/** Rich model metadata normalized from a provider's /models endpoint. */
export interface ModelInfo {
	id: string;
	name?: string;
	contextLength?: number;
	pricing?: { prompt?: number; completion?: number };
	inputModalities?: string[];
	supportedParameters?: string[];
	created?: number;
	knowledgeCutoff?: string;
	isModerated?: boolean;
	maxCompletionTokens?: number;
	defaultTemperature?: number;
	isReasoning?: boolean;
}

/** One provider endpoint serving a model (OpenRouter /endpoints). */
export interface ModelEndpoint {
	providerName: string;
	tag: string;
	contextLength?: number;
	maxCompletionTokens?: number;
	quantization?: string;
	pricing?: { prompt?: number; completion?: number };
	supportedParameters?: string[];
	uptime?: number;
	status?: number;
	latencyP50?: number;
	throughputP50?: number;
}

/** A provider account snapshot (OpenRouter only; null elsewhere). */
export interface ProviderAccount {
	label: string | null;
	limit: number | null;
	limitRemaining: number | null;
	limitReset: string | null;
	usage: number;
	usageDaily: number;
	usageWeekly: number;
	usageMonthly: number;
	isFreeTier: boolean;
	isManagementKey: boolean;
	expiresAt: string | null;
	balance: number | null;
}

export interface LLMCompletionOptions {
	model: string;
	messages: LLMMessage[];
	maxTokens?: number;
	temperature?: number;
	stop?: string[];
	/** Extra request-body fields (sampling knobs + service_tier) merged verbatim. */
	params?: Record<string, string | number>;
	/** Reasoning/verbosity/media tuning; each provider translates what it supports. */
	tuning?: GenerationTuning;
	onToken?: (token: string) => void;
	onThinkingToken?: (token: string) => void;
	signal?: AbortSignal;
	/** OpenRouter `provider` routing object (already snake_cased); ignored by others. */
	providerRouting?: Record<string, unknown>;
}

export interface LLMCompletionResult {
	content: string;
	thinking: string | null;
	finishReason: 'stop' | 'length' | 'error' | 'cancelled';
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		/** Subset of promptTokens read from the provider's prompt cache (billed at a fraction);
		 *  absent when the provider doesn't report it. Lets the UI show cache health. */
		cachedTokens?: number;
	};
	model: string;
	provider: string;
}

// ===== Tool calling (assistant) =====

/** A function tool definition in OpenAI shape. */
export interface LLMToolDef {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

/** A message in a tool-calling conversation (superset of LLMMessage). */
export interface LLMToolMessage {
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	/** Present on assistant turns that called tools. */
	tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
	/** Present on tool-result turns; links back to the assistant's tool_call id. */
	tool_call_id?: string;
	name?: string;
	/** Image attachments on user turns, as server-relative paths (images/<category>/<file>);
	 *  providers load the bytes and build their own multimodal content parts. */
	images?: string[];
}

/** A fully-accumulated tool call parsed out of the model's stream. */
export interface LLMToolCall {
	id: string;
	name: string;
	/** Parsed arguments object; {} if the model emitted invalid JSON. */
	arguments: Record<string, unknown>;
	/** Raw argument string exactly as the model produced it. */
	rawArguments: string;
}

export interface LLMToolStreamOptions {
	model: string;
	messages: LLMToolMessage[];
	tools: LLMToolDef[];
	maxTokens?: number;
	temperature?: number;
	/** Extra request-body fields (sampling knobs + service_tier) merged verbatim, as in complete(). */
	params?: Record<string, string | number>;
	/** Reasoning/verbosity/media tuning; each provider translates what it supports (as in complete()). */
	tuning?: GenerationTuning;
	signal?: AbortSignal;
	onToken?: (token: string) => void;
	onThinkingToken?: (token: string) => void;
	/** Fires as tool-call arguments stream in, for live UI preview. */
	onToolCallDelta?: (delta: { index: number; name: string; argumentsSoFar: string }) => void;
	/** OpenRouter `provider` routing object (already snake_cased); ignored by others. */
	providerRouting?: Record<string, unknown>;
}

export interface LLMToolResult {
	content: string;
	thinking: string | null;
	toolCalls: LLMToolCall[];
	finishReason: 'stop' | 'length' | 'error' | 'cancelled' | 'tool_calls';
	usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number };
	model: string;
	provider: string;
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
