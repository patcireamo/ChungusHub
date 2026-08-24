/**
 * Client LLM service.
 *
 * Provider implementations and API keys live on the server. This façade resolves
 * WHO serves each call: every calling point (`primary`, `assistant`, each
 * calling engine) is routed to its own concrete Connection in one flat map (see
 * stores/connections.svelte.ts). This service reads that map to build the
 * request: provider, model, per-connection generation settings,
 * capability-filtered tuning, and the connection's OpenRouter routing.
 * Completions stream over the WebSocket (the server holds the keys); model
 * lists / validation / account go over REST.
 */
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	ProviderName,
	Connection,
	GenerationTuning,
	CachingPolicy,
	MediaPolicy,
	ModelInfo,
	ModelEndpoint,
	ProviderAccount,
	ProfileReasoning,
	ParamPolicy,
	PromptPostProcessingMode,
	RoutingConfig,
	CallTarget
} from '$lib/types/llm';
import {
	buildGenerationParams,
	buildGenerationTuning,
	imagesEnabled,
	resolveParamPolicy
} from '$lib/config/sampling';
import { connectionStore } from '$lib/stores/connections.svelte';
import { db } from '$lib/services/database';
import { apiGet, apiSend, llmComplete } from '$lib/services/transport';
import { tokenCalibration } from '$lib/tokenizer';

/** Human-readable call target, for fail-loud messages when nothing resolves. */
function targetLabel(target: CallTarget): string {
	return typeof target === 'object' ? `${target.engine} engine` : target;
}

/**
 * Real-token prompt budget for a context window: window − response reserve − safety margin.
 * The margin (max(1024, 3%)) absorbs the provider's chat-template framing and tokenizer
 * drift while the per-model calibration is still converging.
 */
export function computePromptBudget(contextSize: number, maxResponseTokens: number): number {
	const margin = Math.max(1024, Math.ceil(contextSize * 0.03));
	return Math.max(0, contextSize - maxResponseTokens - margin);
}

export interface ProviderMeta {
	name: ProviderName;
	displayName: string;
	availableModels: string[];
	requiresApiKey: boolean;
	baseUrlEditable: boolean;
	defaultBaseUrl: string;
	/** Sampling-param support policy driving the generation UI. */
	paramPolicy: ParamPolicy;
	/** Per-model provider routing panel (OpenRouter). */
	routing: boolean;
	/** service_tier field is honoured. */
	serviceTier: boolean;
	/** An account/balance snapshot is available (drives the connection ledger). */
	account: boolean;
	/** Reasoning controls the API documents (null = none; controls stay hidden), or
	 *  'declared' when the connection names the dialect (BYO endpoints). */
	reasoning: ProfileReasoning | null;
	/** Inline-image support (null = the API takes no image content parts). */
	media: MediaPolicy | null;
	/** `verbosity` support: true provider-wide, 'reported' per model, false = hidden. */
	verbosity: boolean | 'reported';
	/** Prompt-caching nature (null = no caching we can drive or report). */
	caching: CachingPolicy | null;
}

class LLMService {
	private meta: Partial<Record<ProviderName, ProviderMeta>> = {};
	/** Last-fetched model list per CONNECTION id: two connections on the same
	 *  provider can carry different keys/base URLs and thus different model lists. */
	private modelsCache: Record<string, ModelInfo[]> = {};
	/** Per connection: the base URL that answered, when it isn't the typed one. */
	private resolvedBaseUrls: Record<string, string | null> = {};
	private initialized = false;

	async initialize(): Promise<void> {
		if (this.initialized) return;

		try {
			const data = (await apiGet('/api/llm/providers')) as { providers: Record<ProviderName, ProviderMeta> };
			this.meta = data.providers;
		} catch (error) {
			console.error('Failed to load provider metadata:', error);
		}

		this.initialized = true;
	}

	// ===== Provider metadata (static, keyed by provider) =====

	getProviderList(): ProviderMeta[] {
		return Object.values(this.meta) as ProviderMeta[];
	}

	getProviderMeta(name: ProviderName): ProviderMeta | undefined {
		return this.meta[name] as ProviderMeta | undefined;
	}

	// ===== Target resolution =====

	providerFor(target: CallTarget): ProviderName | undefined {
		return connectionStore.connectionFor(target)?.provider;
	}

	modelFor(target: CallTarget): string {
		return connectionStore.connectionFor(target)?.model ?? '';
	}

	connectionIdFor(target: CallTarget): string | undefined {
		return connectionStore.connectionFor(target)?.id;
	}

	/** The connection's OpenRouter routing for a call target (openrouter only; null otherwise). */
	routingFor(target: CallTarget): RoutingConfig | null {
		const conn = connectionStore.connectionFor(target);
		if (!conn || conn.provider !== 'openrouter') return null;
		return conn.routing;
	}

	/** The primary connection's model: the chat generation model the meters price. */
	getPrimaryModel(): string {
		return this.modelFor('primary');
	}

	/** Prompt post-processing mode for a target's connection ('merge' when none resolves).
	 *  Defaults to primary, the chat send; Opening Scene and Continue pass their own
	 *  engine target so their assigned connection's prompt shape actually applies. */
	getPromptPostProcessing(target: CallTarget = 'primary'): PromptPostProcessingMode {
		return connectionStore.connectionFor(target)?.postProcessing ?? 'merge';
	}

	/** User-turn placeholder a target's connection inserts under strict post-processing. */
	getPromptPlaceholder(target: CallTarget = 'primary'): string {
		return connectionStore.connectionFor(target)?.promptPlaceholder ?? '';
	}

	/**
	 * Prompt-token budget for assembly, in the target connection's terms. Computed in
	 * real-token space ({@link computePromptBudget}), then divided by the model's
	 * calibration ratio so it lands in the base-estimate space the assembler counts in.
	 */
	getPromptTokenBudget(target: CallTarget = 'primary'): number {
		const conn = connectionStore.connectionFor(target);
		if (!conn) return 0;
		const real = computePromptBudget(conn.contextSize, conn.generation.maxTokens);
		const ratio = tokenCalibration.ratioFor(conn.model);
		return Math.floor(real / (ratio > 0 ? ratio : 1));
	}

	// ===== Model lists (cached per connection) =====

	/** Last-fetched model list for a connection (for instant paint while a refresh runs). */
	getCachedModels(connectionId: string): ModelInfo[] {
		return this.modelsCache[connectionId] ?? [];
	}

	getCachedModel(id: string, connectionId: string): ModelInfo | undefined {
		return this.modelsCache[connectionId]?.find((m) => m.id === id);
	}

	async fetchAvailableModels(connectionId: string, provider: ProviderName): Promise<ModelInfo[]> {
		const data = (await apiSend('/api/llm/models', 'POST', { connectionId, provider })) as {
			models?: ModelInfo[];
			baseUrl?: string | null;
			error?: string;
		};
		if (data.error) throw new Error(data.error);
		const list = data.models ?? [];
		this.modelsCache[connectionId] = list;
		this.resolvedBaseUrls[connectionId] = data.baseUrl ?? null;
		return list;
	}

	/**
	 * For a bring-your-own endpoint, the base URL the server found answering when it
	 * differs from the one the user typed (null otherwise). Set by the last model
	 * fetch; the connection editor renders it under the URL field.
	 */
	getResolvedBaseUrl(connectionId: string): string | null {
		return this.resolvedBaseUrls[connectionId] ?? null;
	}

	/** Cache a connection's model list if we haven't already (for capability-aware params). */
	async ensureModelsLoaded(connectionId: string, provider: ProviderName): Promise<void> {
		if (this.modelsCache[connectionId]) return;
		try {
			await this.fetchAvailableModels(connectionId, provider);
		} catch (error) {
			// Non-fatal: generation still proceeds; buildGenerationParams falls back to the
			// user's explicit settings (the provider ignores anything unsupported).
			console.warn('Could not preload model list for capability-aware params:', error);
		}
	}

	// ===== Credentials & account (per connection) =====

	async setConnectionCredentials(connectionId: string, provider: ProviderName, apiKey: string, baseUrl?: string): Promise<void> {
		await db.setConnectionCredentials(connectionId, provider, apiKey, baseUrl);
	}

	/** Validate a connection's credentials server-side. `error` names the reason when
	 *  one is known: for a BYO endpoint that can be "no API found at <url> or
	 *  <url>/v1", a very different fix than a rejected key. */
	async validateConnection(
		connectionId: string,
		provider: ProviderName
	): Promise<{ valid: boolean; error?: string }> {
		const data = (await apiSend('/api/llm/validate', 'POST', { connectionId, provider })) as {
			valid: boolean;
			error?: string;
		};
		return { valid: data.valid, error: data.error };
	}

	/** Provider endpoints that serve a model (OpenRouter only; [] elsewhere). */
	async fetchModelEndpoints(connectionId: string, provider: ProviderName, model: string): Promise<ModelEndpoint[]> {
		const data = (await apiSend('/api/llm/model-endpoints', 'POST', { connectionId, provider, model })) as {
			endpoints?: ModelEndpoint[];
			error?: string;
		};
		if (data.error) throw new Error(data.error);
		return data.endpoints ?? [];
	}

	/** Account snapshot for a connection's key (OpenRouter only; null elsewhere). */
	async fetchAccount(connectionId: string, provider: ProviderName): Promise<ProviderAccount | null> {
		const data = (await apiSend('/api/llm/account', 'POST', { connectionId, provider })) as {
			account?: ProviderAccount | null;
			error?: string;
		};
		if (data.error) throw new Error(data.error);
		return data.account ?? null;
	}

	// ===== Request building =====

	/**
	 * Sampling fields built from a connection's generation settings, filtered by what
	 * its provider/model accepts. Takes the connection whole because every input came
	 * from one anyway (and a BYO endpoint's accepted params are a field on it); `model`
	 * stays separate only because a caller may generate on a model other than the
	 * connection's own. Used for the primary generation and by the editor / routing
	 * panel to learn a model's honoured parameters.
	 */
	getGenerationParams(conn: Connection, model: string): Record<string, string | number> {
		const meta = this.meta[conn.provider];
		const policy = resolveParamPolicy(meta?.paramPolicy ?? 'base-only', conn.samplingParams);
		return buildGenerationParams(conn.generation, this.getCachedModel(model, conn.id), policy, model, meta?.serviceTier ?? false);
	}

	/**
	 * A target's own sampling, with its model list warmed first so the capability
	 * filtering is real. `complete()` does exactly this inline for every call it
	 * serves; the Chungus Assistant needs the same resolution WITHOUT complete(),
	 * because its tool loop rides its own WebSocket channel.
	 */
	async resolveConnectionParams(target: CallTarget): Promise<Record<string, string | number>> {
		const conn = connectionStore.connectionFor(target);
		if (!conn) throw new Error(`No connection resolved for the ${targetLabel(target)}`);
		await this.ensureModelsLoaded(conn.id, conn.provider);
		return this.getGenerationParams(conn, conn.model);
	}

	/** Reasoning/verbosity/media tuning for a target's connection, filtered to provider support. */
	getGenerationTuning(target: CallTarget): GenerationTuning | undefined {
		const conn = connectionStore.connectionFor(target);
		if (!conn) return undefined;
		const meta = this.meta[conn.provider];
		return buildGenerationTuning(
			conn.generation,
			meta?.reasoning ?? null,
			conn.reasoningDialect,
			meta?.media ?? null,
			meta?.verbosity ?? false,
			meta?.caching ?? null,
			this.getCachedModel(conn.model, conn.id)
		);
	}

	/** Whether attached images may ride a target's generation (connection toggle + provider media policy + model modality). */
	sendsImages(target: CallTarget = 'primary', model?: string): boolean {
		const conn = connectionStore.connectionFor(target);
		if (!conn || !conn.generation.sendImages) return false;
		const meta = this.meta[conn.provider];
		return imagesEnabled(meta?.media ?? null, this.getCachedModel(model ?? conn.model, conn.id));
	}

	/**
	 * Stream a completion for a call target. Resolves provider/model/connection from
	 * the target's binding and builds sampling from THAT connection's own generation
	 * settings: a connection you assigned is a connection whose settings apply, with
	 * no app-owned override anywhere.
	 */
	async complete(
		target: CallTarget,
		options: Omit<LLMCompletionOptions, 'model'> & { model?: string; source?: string }
	): Promise<LLMCompletionResult> {
		const conn = connectionStore.connectionFor(target);
		if (!conn) throw new Error(`No connection resolved for the ${targetLabel(target)}`);
		const provider = conn.provider;
		const model = options.model ?? conn.model;
		await this.ensureModelsLoaded(conn.id, provider);
		const meta = this.meta[provider];
		const info = this.getCachedModel(model, conn.id);
		// Response tuning, filtered to what this provider/model supports (visible === sent).
		const tuning = buildGenerationTuning(
			conn.generation,
			meta?.reasoning ?? null,
			conn.reasoningDialect,
			meta?.media ?? null,
			meta?.verbosity ?? false,
			meta?.caching ?? null,
			info
		);
		// Attachments only reach providers/models that take image content parts.
		const sendImages = this.sendsImages(target, model);
		const messages = sendImages
			? options.messages
			: options.messages.map(({ images: _images, ...m }) => m);
		// Every call rides its own connection's sampling. No exceptions anywhere in the app.
		const params = this.getGenerationParams(conn, model);
		// Streaming off = a genuine non-streamed request; the reply lands whole.
		const stream = conn.generation.streamResponses;
		const result = await llmComplete({
			connectionId: conn.id,
			provider,
			model,
			messages,
			maxTokens: options.maxTokens,
			temperature: options.temperature,
			params,
			tuning,
			routing: provider === 'openrouter' ? conn.routing : undefined,
			source: options.source,
			onToken: stream ? options.onToken : undefined,
			onThinkingToken: stream ? options.onThinkingToken : undefined,
			signal: options.signal
		});
		return result as LLMCompletionResult;
	}
}

export const llmService = new LLMService();
