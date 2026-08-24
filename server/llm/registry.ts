/**
 * Server-side LLM registry. API keys live here and never reach the client.
 * Credentials are loaded fresh from the database before each operation so that
 * updates made through the settings UI take effect immediately.
 *
 * Most providers speak the OpenAI-compatible /chat/completions + /models
 * surface and run on the generic OpenAICompatibleProvider; a profile that
 * declares createProvider (Anthropic's native Messages API) brings its own
 * implementation instead. Either way, one profile file + one line in
 * providers/index.ts is the whole registration.
 */
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	LLMToolStreamOptions,
	LLMToolResult,
	ModelInfo,
	ModelEndpoint,
	ProviderAccount,
	ProviderName
} from './types';
import { OpenAICompatibleProvider } from './openai-compatible';
import { PROVIDER_PROFILES } from './providers';
import type { CachingPolicy, ChatProvider, MediaPolicy, ParamPolicy, ProfileReasoning } from './providers/types';
import { serverDb } from '../db';

/**
 * OpenRouter routing a connection owns (camelCase). It rides each request from
 * the client and we translate it here to OpenRouter's snake_case `provider`
 * body field. The camelCase→snake_case boundary stays server-side.
 */
export interface RoutingConfig {
	order?: string[];
	only?: string[];
	allowFallbacks?: boolean;
	sort?: 'price' | 'throughput' | 'latency';
	maxPrice?: { prompt?: number; completion?: number };
	quantizations?: string[];
	dataCollection?: 'allow' | 'deny';
	zdr?: boolean;
	requireParameters?: boolean;
	ignore?: string[];
}

/** Translate a stored RoutingConfig into OpenRouter's `provider` object, or undefined if it carries nothing. */
function toProviderField(c: RoutingConfig): Record<string, unknown> | undefined {
	const p: Record<string, unknown> = {};
	if (c.order?.length) p.order = c.order;
	if (c.only?.length) p.only = c.only;
	if (c.ignore?.length) p.ignore = c.ignore;
	if (c.allowFallbacks === false) p.allow_fallbacks = false;
	if (c.requireParameters) p.require_parameters = true;
	if (c.sort) p.sort = c.sort;
	if (c.quantizations?.length) p.quantizations = c.quantizations;
	if (c.dataCollection === 'deny') p.data_collection = 'deny';
	if (c.zdr) p.zdr = true;
	if (c.maxPrice && (c.maxPrice.prompt != null || c.maxPrice.completion != null)) {
		const mp: Record<string, number> = {};
		if (c.maxPrice.prompt != null) mp.prompt = c.maxPrice.prompt;
		if (c.maxPrice.completion != null) mp.completion = c.maxPrice.completion;
		p.max_price = mp;
	}
	return Object.keys(p).length ? p : undefined;
}

/** Translate a connection's routing to the OpenRouter `provider` field (openrouter only). */
function routingFor(name: ProviderName, routing: RoutingConfig | null | undefined): Record<string, unknown> | undefined {
	if (name !== 'openrouter' || !routing) return undefined;
	return toProviderField(routing);
}

const providers = Object.fromEntries(
	PROVIDER_PROFILES.map((profile) => [
		profile.name,
		profile.createProvider ? profile.createProvider(profile) : new OpenAICompatibleProvider(profile)
	])
) as Record<ProviderName, ChatProvider>;

function configure(connectionId: string, name: ProviderName): ChatProvider {
	const provider = providers[name];
	const creds = serverDb.getConnectionCredentials(connectionId) as { apiKey: string; baseUrl: string | null } | null;
	provider.configure({
		apiKey: creds?.apiKey ?? '',
		baseUrl: creds?.baseUrl ?? undefined
	});
	return provider;
}

export function isProvider(name: string): name is ProviderName {
	return name in providers;
}

export interface ProviderMetadata {
	name: string;
	displayName: string;
	availableModels: string[];
	requiresApiKey: boolean;
	baseUrlEditable: boolean;
	defaultBaseUrl: string;
	/** Sampling-param support policy that drives the generation UI. */
	paramPolicy: ParamPolicy;
	/** Per-model provider routing panel (OpenRouter). */
	routing: boolean;
	/** service_tier field is honoured. */
	serviceTier: boolean;
	/** An account/balance snapshot is available (drives the connection ledger). */
	account: boolean;
	/** Reasoning controls the API documents (null = none; controls stay hidden), or
	 *  'declared' when the connection names the dialect (BYO). */
	reasoning: ProfileReasoning | null;
	/** Inline-image support (null = the API takes no image content parts). */
	media: MediaPolicy | null;
	/** `verbosity` support: true provider-wide, 'reported' per model, false = hidden. */
	verbosity: boolean | 'reported';
	/** Prompt-caching nature (null = no caching we can drive or report). */
	caching: CachingPolicy | null;
}

/**
 * Static metadata the client needs to render UI without holding any keys.
 * Read from the PROFILES (not the provider instances) so the profile file
 * stays the single source of truth for capabilities: a native provider can't
 * shadow or drift from what its profile declares.
 */
export function providerMetadata(): Record<ProviderName, ProviderMetadata> {
	const out = {} as Record<ProviderName, ProviderMetadata>;
	for (const profile of PROVIDER_PROFILES) {
		const name = profile.name as ProviderName;
		out[name] = {
			name: profile.name,
			displayName: profile.displayName,
			availableModels: [...providers[name].availableModels],
			requiresApiKey: profile.requiresApiKey,
			baseUrlEditable: profile.baseUrlEditable,
			defaultBaseUrl: profile.defaultBaseUrl,
			paramPolicy: profile.paramPolicy ?? 'base-only',
			routing: profile.routing ?? false,
			serviceTier: profile.serviceTier ?? false,
			account: !!profile.fetchAccount,
			reasoning: profile.reasoning ?? null,
			media: profile.media ?? null,
			verbosity: profile.verbosity ?? false,
			caching: profile.caching ?? null
		};
	}
	return out;
}

export async function complete(
	connectionId: string,
	name: ProviderName,
	options: LLMCompletionOptions & { routing?: RoutingConfig | null }
): Promise<LLMCompletionResult> {
	const { routing, ...rest } = options;
	return configure(connectionId, name).complete({ ...rest, providerRouting: routingFor(name, routing) });
}

export async function completeWithTools(
	connectionId: string,
	name: ProviderName,
	options: LLMToolStreamOptions & { routing?: RoutingConfig | null }
): Promise<LLMToolResult> {
	const { routing, ...rest } = options;
	return configure(connectionId, name).completeWithTools({ ...rest, providerRouting: routingFor(name, routing) });
}

export async function validateCredentials(connectionId: string, name: ProviderName): Promise<boolean> {
	return configure(connectionId, name).validateCredentials();
}

export async function fetchAvailableModels(connectionId: string, name: ProviderName): Promise<ModelInfo[]> {
	return configure(connectionId, name).fetchAvailableModels();
}

/**
 * For a bring-your-own endpoint, the base URL that answered when it differs from the
 * one the user typed (null otherwise). Read after a model fetch has resolved it; the
 * connection editor shows it so the correction is visible rather than silent.
 */
export function resolvedBaseUrl(connectionId: string, name: ProviderName): string | null {
	return configure(connectionId, name).resolvedBaseUrl?.() ?? null;
}

/** Provider endpoints serving a model (profile hook; [] when the provider has none). */
export async function fetchModelEndpoints(connectionId: string, name: ProviderName, model: string): Promise<ModelEndpoint[]> {
	return configure(connectionId, name).fetchModelEndpoints(model);
}

/** Account snapshot for the configured key (profile hook; null when the provider has none). */
export async function fetchAccount(connectionId: string, name: ProviderName): Promise<ProviderAccount | null> {
	return configure(connectionId, name).fetchAccountInfo();
}
