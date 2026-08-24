import type {
	LLMProviderConfig,
	LLMCompletionOptions,
	LLMCompletionResult,
	LLMToolStreamOptions,
	LLMToolResult,
	LLMToolCall,
	LLMMessage,
	LLMToolMessage,
	GenerationTuning,
	ModelInfo,
	ModelEndpoint,
	ProviderAccount
} from './types';
import { num } from './providers/util';
import { imageDataUrl } from './media';
import {
	createInlineReasoningParser,
	extractInlineReasoning,
	stripResidualMarkers,
	type InlineReasoningParser
} from './inline-reasoning';
import type { ChatProvider, ProviderProfile, ProviderRuntime } from './providers/types';
import {
	timedFetch,
	readBodyCapped,
	readJsonCapped,
	sseData,
	CONTROL_TIMEOUT_MS,
	STREAM_HEADERS_TIMEOUT_MS,
	COMPLETION_HEADERS_TIMEOUT_MS,
	MAX_CONTROL_BODY_BYTES,
	MAX_COMPLETION_BODY_BYTES,
	MAX_ERROR_BODY_BYTES
} from './net';

/**
 * Generic OpenAI-compatible chat provider. Handles streaming + non-streaming
 * completions, thinking extraction (reasoning_content / reasoning / thinking
 * fields, plus inline markers via inline-reasoning.ts, disabled per request
 * when `tuning.parseInlineReasoning` is false), credential validation, and
 * live model listing.
 *
 * Everything that differs between providers lives in a ProviderProfile: default
 * endpoint, auth, extra headers, which sampling params the API accepts, and
 * optional hooks for provider-specific /models shaping, account snapshots and
 * endpoint listing. The class itself stays provider-agnostic.
 *
 * Model lists are always fetched live from /models: we never fall back to a
 * stale hardcoded list, so a broken endpoint surfaces as an error instead of
 * silently offering models that may not exist.
 *
 * All network I/O runs through the shared guards in net.ts: headers deadlines,
 * per-chunk idle timeouts and body size caps, so a wedged or hostile endpoint
 * fails loudly instead of hanging a generation or buffering without bound.
 */

/** Endpoint paths a user pastes whole (LM Studio's UI shows `.../v1/models`; docs
 *  everywhere show `.../v1/chat/completions`); their stem joins the probe candidates. */
const ENDPOINT_SUFFIXES = ['/chat/completions', '/models'];

/**
 * What GET /models against the candidate bases established:
 *  - 'api':     a candidate PROVED it serves the API (a JSON model list came back).
 *               `base` is pinned and `models` carries the raw list entries.
 *  - 'engaged': a server answered at `base` (auth rejection, server error) but the
 *               list is unreadable. Held, never pinned; the response body is unread.
 *  - 'none':    nothing served a model list; `message` names every URL tried.
 */
type ModelsProbe =
	| { kind: 'api'; base: string; models: Record<string, unknown>[] }
	| { kind: 'engaged'; base: string; response: Response }
	| { kind: 'none'; message: string };

export class OpenAICompatibleProvider implements ChatProvider {
	readonly name: string;
	readonly displayName: string;
	readonly supportsStreaming = true;
	readonly availableModels = [] as const;

	private readonly defaultBaseUrl: string;
	private readonly requiresApiKey: boolean;
	private readonly profile: ProviderProfile;
	private readonly extraHeaders: Record<string, string>;
	private apiKey = '';
	private baseUrl: string;
	/** Typed base URL → the base that PROVED it serves the API (a JSON model list
	 *  answered there). Nothing weaker is ever pinned. See probeModels(). */
	private readonly resolvedBases = new Map<string, string>();

	constructor(profile: ProviderProfile) {
		this.profile = profile;
		this.name = profile.name;
		this.displayName = profile.displayName;
		this.defaultBaseUrl = profile.defaultBaseUrl;
		this.baseUrl = profile.defaultBaseUrl;
		this.requiresApiKey = profile.requiresApiKey;
		this.extraHeaders = profile.extraHeaders ?? {};
	}

	configure(config: LLMProviderConfig): void {
		this.apiKey = config.apiKey;
		// Trailing slashes are stripped here so every `${base}/path` concat below stays
		// well-formed: a pasted ".../v1/" would otherwise request ".../v1//models".
		this.baseUrl = config.baseUrl?.trim().replace(/\/+$/, '') || this.defaultBaseUrl;
	}

	/**
	 * The base URLs a bring-your-own endpoint might live at, in the order we try
	 * them: exactly what the user typed, then (when the paste is a full endpoint
	 * URL) its stem, then the stem's /v1-toggled twin. Which shape is right is
	 * genuinely unknowable from the string: llama.cpp and LiteLLM answer both at
	 * the root and under /v1, LM Studio and Ollama only under /v1, and a gateway
	 * path can end in something else entirely (Cloudflare's `/openai`, Azure's
	 * deployment path) while still carrying a /v1 mid-path. So candidates are only
	 * ever suggestions for the probe to verify; nothing is rewritten on a guess.
	 * A fixed base URL has one candidate and never probes, and a URL carrying a
	 * query or hash gets no derived candidates, since path surgery there makes garbage.
	 */
	private baseCandidates(url: string): string[] {
		if (!this.profile.baseUrlEditable) return [url];
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return [url]; // let the request itself fail loudly with fetch's own error
		}
		if (parsed.search || parsed.hash) return [url];
		const candidates: string[] = [];
		const push = (u: string) => {
			if (!candidates.includes(u)) candidates.push(u);
		};
		push(url);
		// Suffixes are detected on the parsed pathname but sliced off the raw string,
		// so the rest of the URL text survives exactly as typed.
		const suffix = ENDPOINT_SUFFIXES.find((s) => parsed.pathname.endsWith(s));
		const stem = suffix ? url.slice(0, -suffix.length) : url;
		if (suffix) push(stem);
		push(stem.endsWith('/v1') ? stem.slice(0, -'/v1'.length) : `${stem}/v1`);
		return candidates;
	}

	/**
	 * Base URL for a completion request. A pin costs nothing; an unpinned BYO
	 * endpoint costs one probe walk the first time this process sends to it (the
	 * model list normally resolves it well before any generation). When nothing
	 * proves: an engaged base wins (the endpoint's real auth/server error is the
	 * truthful thing for the POST to surface), else the typed URL stands, because
	 * an endpoint serving only /chat/completions and no /models must still get its
	 * request, with the POST's own failure as the loud signal.
	 */
	private async resolveBase(typed: string, headers: Record<string, string>): Promise<string> {
		const pinned = this.resolvedBases.get(typed);
		if (pinned) return pinned;
		if (this.baseCandidates(typed).length === 1) return typed;
		const probe = await this.probeModels(typed, headers);
		if (probe.kind === 'engaged') {
			await probe.response.body?.cancel().catch(() => {});
			return probe.base;
		}
		return probe.kind === 'api' ? probe.base : typed;
	}

	/** The URL that proved it serves the API, when it differs from the typed one (null otherwise). */
	resolvedBaseUrl(): string | null {
		const found = this.resolvedBases.get(this.baseUrl);
		return found && found !== this.baseUrl ? found : null;
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = { 'Content-Type': 'application/json', ...this.extraHeaders };
		if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
		return h;
	}

	/**
	 * Assemble the /chat/completions request body. The ONE place model/messages/sampling
	 * fields become a body, so plain and tool-calling completions send an identical param
	 * set (max_tokens, temperature, stop, provider routing, and every sampling knob in
	 * `params`). `extra` carries only what differs (stream flags, tools). `params` is
	 * merged last so it wins, exactly as the API expects.
	 */
	private buildRequestBody(
		o: {
			model: string;
			messages: unknown;
			maxTokens?: number;
			temperature?: number;
			stop?: string[];
			providerRouting?: Record<string, unknown>;
			params?: Record<string, string | number>;
			tuning?: GenerationTuning;
		},
		extra: Record<string, unknown>
	): Record<string, unknown> {
		const body: Record<string, unknown> = { model: o.model, messages: o.messages, ...extra };
		if (o.maxTokens !== undefined) body.max_tokens = o.maxTokens;
		if (o.temperature !== undefined) body.temperature = o.temperature;
		if (o.stop) body.stop = o.stop;
		if (o.providerRouting) body.provider = o.providerRouting;
		if (o.tuning) this.applyTuning(body, o.tuning);
		if (o.params) Object.assign(body, o.params);
		return body;
	}

	/**
	 * Translate the user's response tuning into this provider's documented wire
	 * fields, per the profile's descriptors. Anything the profile doesn't declare
	 * is skipped: the client hides those controls for this provider, so a value
	 * left over from another connection must not leak into the request.
	 */
	private applyTuning(body: Record<string, unknown>, tuning: GenerationTuning): void {
		// A BYO profile knows no dialect of its own, so the request carries the one its
		// connection declared. Gated on 'declared' rather than merged: a provider whose
		// dialect we DO know must never be overridable from the wire.
		const r = this.profile.reasoning === 'declared' ? tuning.reasoningPolicy : this.profile.reasoning;
		if (r) {
			const effort = tuning.reasoningEffort;
			if (effort === 'off' && r.offViaThinking) {
				body.thinking = { type: 'disabled' };
			} else if (effort && r.efforts?.[effort] !== undefined) {
				if (r.effortField === 'reasoning-object') {
					body.reasoning = { ...(body.reasoning as Record<string, unknown>), effort: r.efforts[effort] };
				} else {
					body.reasoning_effort = r.efforts[effort];
				}
			}
			if (tuning.showReasoning === false && r.exclude) {
				body.reasoning = { ...(body.reasoning as Record<string, unknown>), exclude: true };
			}
		}
		if (this.profile.verbosity && tuning.verbosity) {
			body.verbosity = tuning.verbosity;
		}
	}

	/**
	 * Expand messages that carry image attachments into OpenAI multimodal content
	 * arrays (text part + one image_url part per attachment), loading each image
	 * from server storage. Text-only messages keep their plain-string content (an
	 * identical wire shape to before), so providers that never see images are
	 * untouched. Tool-calling fields (tool_calls, tool_call_id, name) pass through
	 * unchanged, so the assistant conversation can ride the same expansion. The client
	 * only leaves `images` on messages when the provider's media policy + model
	 * modalities allow it.
	 */
	private toWireMessages(messages: (LLMMessage | LLMToolMessage)[], tuning?: GenerationTuning): unknown {
		// Only place `cache_control` for a provider that caches explicitly AND when the user
		// turned caching on for this request. Auto-caching providers cache server-side with no
		// field; sending the marker to their strict APIs would 4xx.
		const cache = this.profile.caching?.mode === 'explicit' && tuning?.promptCaching === true;
		// Fast path: no images and no caching → the plain messages, images stripped, as before.
		if (!cache && !messages.some((m) => m.images?.length)) {
			return messages.map(({ images: _images, ...m }) => m);
		}
		const media = this.profile.media;
		const detail = media?.detail ? tuning?.imageDetail : undefined;
		const wire = messages.map((message) => {
			const { images, ...m } = message;
			if (!images?.length) return { ...m } as Record<string, unknown>;
			const parts: Record<string, unknown>[] = [];
			if (m.content) parts.push({ type: 'text', text: m.content });
			for (const path of images) {
				const url = imageDataUrl(path);
				parts.push({
					type: 'image_url',
					// Mistral takes image_url as a bare string; everyone else as {url, detail?}.
					image_url: media?.shape === 'string' ? url : { url, ...(detail ? { detail } : {}) }
				});
			}
			return { ...m, content: parts };
		});
		if (cache) this.markCacheBreakpoints(wire, tuning?.cacheTtl);
		return wire;
	}

	/**
	 * Stamp `cache_control` on the two stable breakpoints the assistant/roleplay reuses every
	 * turn: the (static) system preamble and the end of the conversation prefix. Marking the
	 * final message writes the cache this turn so next turn's longer history reads it back.
	 * String content is lifted into a one-item text part to carry the marker; an existing
	 * content-part array (images) gets it on the last part. Two breakpoints, well under the
	 * 4-per-request limit. `ttl` selects the cache lifetime where the upstream honours 1h
	 * (Anthropic via OpenRouter); the field is ignored by upstreams that only do 5m. Only
	 * ever called for an explicit-caching profile with caching enabled this request.
	 */
	private markCacheBreakpoints(wire: Record<string, unknown>[], ttl?: '5m' | '1h'): void {
		if (!wire.length) return;
		const control = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
		const stamp = (msg: Record<string, unknown> | undefined): void => {
			if (!msg) return;
			if (typeof msg.content === 'string') {
				if (!msg.content) return;
				msg.content = [{ type: 'text', text: msg.content, cache_control: { ...control } }];
			} else if (Array.isArray(msg.content) && msg.content.length) {
				const last = msg.content[msg.content.length - 1] as Record<string, unknown>;
				if (last && typeof last === 'object') last.cache_control = { ...control };
			}
		};
		stamp(wire.find((m) => m.role === 'system'));
		stamp(wire[wire.length - 1]);
	}

	/**
	 * Cache-hit token count, normalized across the shapes providers report it in: OpenAI-style
	 * nesting (OpenAI / OpenRouter / xAI / Mistral / Z.AI), Moonshot's top-level `cached_tokens`,
	 * DeepSeek's `prompt_cache_hit_tokens`, and Gemini's `total_cached_tokens`. 0 when none present.
	 */
	private cachedTokensFrom(u: Record<string, any> | undefined): number {
		if (!u) return 0;
		return (
			num(u.prompt_tokens_details?.cached_tokens) ??
			num(u.cached_tokens) ??
			num(u.prompt_cache_hit_tokens) ??
			num(u.total_cached_tokens) ??
			0
		);
	}

	async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
		if (this.requiresApiKey && !this.apiKey) {
			throw new Error(`${this.displayName} API key not configured`);
		}

		if (!options.model) {
			throw new Error(`${this.displayName}: no model selected. Pick a model in settings.`);
		}

		const isStreaming = !!options.onToken;
		// Snapshot the connection's wire identity BEFORE the first await: the registry
		// reuses one instance per provider and configure() mutates it, so a concurrent
		// request for another connection must not swap the key or URL under a request
		// that is still resolving its base.
		const typed = this.baseUrl;
		const headers = this.headers();
		const body = this.buildRequestBody(
			{ ...options, messages: this.toWireMessages(options.messages, options.tuning) },
			{
				stream: isStreaming,
				...(isStreaming ? { stream_options: { include_usage: true } } : {})
			}
		);

		if (isStreaming) {
			return this.streamCompletion(body, options, typed, headers);
		}

		const response = await timedFetch(
			`${await this.resolveBase(typed, headers)}/chat/completions`,
			{ method: 'POST', headers, body: JSON.stringify(body), signal: options.signal },
			COMPLETION_HEADERS_TIMEOUT_MS,
			`${this.displayName} completion`
		);

		if (!response.ok) {
			throw new Error(await this.extractErrorMessage(response));
		}

		const data = (await readJsonCapped(
			response,
			MAX_COMPLETION_BODY_BYTES,
			`${this.displayName} completion response`
		)) as Record<string, any>;
		const message = data.choices?.[0]?.message;
		if (!message) {
			throw new Error(`${this.displayName} returned a completion with no choices`);
		}

		let thinking: string | null = null;
		let content = message.content ?? '';

		if (message.reasoning_content) {
			thinking = message.reasoning_content;
		}
		if (message.reasoning) {
			thinking = thinking ? thinking + '\n' + message.reasoning : message.reasoning;
		}
		if (message.thinking) {
			thinking = thinking ? thinking + '\n' + message.thinking : message.thinking;
		}

		if (options.tuning?.parseInlineReasoning !== false) {
			const extracted = extractInlineReasoning(content);
			content = extracted.content;
			if (extracted.reasoning) {
				thinking = thinking ? thinking + '\n' + extracted.reasoning : extracted.reasoning;
			}
		} else {
			content = content.trim();
		}
		if (thinking !== null) thinking = stripResidualMarkers(thinking) || null;

		return {
			content,
			thinking,
			finishReason: this.mapFinishReason(data.choices[0].finish_reason),
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				cachedTokens: this.cachedTokensFrom(data.usage)
			},
			model: data.model,
			provider: this.name
		};
	}

	private async streamCompletion(
		body: Record<string, unknown>,
		options: LLMCompletionOptions,
		typed: string,
		headers: Record<string, string>
	): Promise<LLMCompletionResult> {
		const response = await timedFetch(
			`${await this.resolveBase(typed, headers)}/chat/completions`,
			{ method: 'POST', headers, body: JSON.stringify(body), signal: options.signal },
			STREAM_HEADERS_TIMEOUT_MS,
			`${this.displayName} completion`
		);

		if (!response.ok) {
			throw new Error(await this.extractErrorMessage(response));
		}

		let content = '';
		let thinking = '';
		let finishReason: LLMCompletionResult['finishReason'] = 'stop';
		// See completeWithTools: default 'stop' misreports a stream that closed early as a
		// clean finish, so track whether the provider ever actually signalled one.
		let sawFinishReason = false;
		let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };

		const emitThinking = (t: string) => {
			thinking += t;
			options.onThinkingToken?.(t);
		};
		const emitContent = (t: string) => {
			content += t;
			options.onToken?.(t);
		};
		const inlineParser = this.inlineParserFor(options.tuning, emitThinking, emitContent);

		try {
			for await (const data of sseData(response, `${this.displayName} stream`)) {
				if (data === '[DONE]') continue;

				// Parse in its own try so ONLY malformed JSON is skipped. A catch around the
				// whole handler would swallow real errors from the branches below with it.
				let parsed: Record<string, any>;
				try {
					parsed = JSON.parse(data);
				} catch (e) {
					// Don't echo the chunk itself: it can carry chat content.
					console.warn(`[${this.displayName}] Failed to parse SSE chunk (${data.length} chars):`, e);
					continue;
				}

				// A mid-stream error event ends the generation: fail loud, never return
				// the partial accumulation as a quietly "successful" completion.
				const streamError = this.streamEventError(parsed);
				if (streamError) throw new Error(`${this.displayName}: ${streamError}`);

				const choice = parsed.choices?.[0];

				// Take the first reasoning field present, not all three: a provider that
				// echoes the same text under two keys would otherwise double-count it.
				const reasoningDelta =
					choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? choice?.delta?.thinking;
				if (reasoningDelta) {
					emitThinking(reasoningDelta);
				}

				const contentDelta = choice?.delta?.content;
				if (contentDelta) {
					if (inlineParser) inlineParser.push(contentDelta);
					else emitContent(contentDelta);
				}

				if (choice?.finish_reason) {
					finishReason = this.mapFinishReason(choice.finish_reason);
					sawFinishReason = true;
				}

				if (parsed.usage) {
					usage = {
						promptTokens: parsed.usage.prompt_tokens ?? 0,
						completionTokens: parsed.usage.completion_tokens ?? 0,
						totalTokens: parsed.usage.total_tokens ?? 0,
						cachedTokens: this.cachedTokensFrom(parsed.usage)
					};
				}
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				finishReason = 'cancelled';
			} else {
				throw error;
			}
		}

		// Release any held-back partial delimiter (stream ended mid-tag) so it isn't lost.
		inlineParser?.flush();

		// A stream that closed with no content and no finish signal is truncated, not
		// empty-by-choice, so fail loud instead of rendering a blank message (same guard +
		// rationale as completeWithTools).
		if (!sawFinishReason && !content.trim() && finishReason !== 'cancelled') {
			throw new Error(
				`${this.displayName}: the response stream closed before the model produced any output, and without a finish signal. The endpoint likely ended the connection early (for a local server, often during prompt processing or without keepalives). Try again, or raise the endpoint's idle/read limit.`
			);
		}

		return {
			content: inlineParser ? stripResidualMarkers(content) : content.trim(),
			thinking: stripResidualMarkers(thinking) || null,
			finishReason,
			usage,
			model: body.model as string,
			provider: this.name
		};
	}

	/** Streaming inline-marker parser, or null when the user disabled parsing for this request. */
	private inlineParserFor(
		tuning: GenerationTuning | undefined,
		onThinking: (token: string) => void,
		onContent: (token: string) => void
	): InlineReasoningParser | null {
		if (tuning?.parseInlineReasoning === false) return null;
		return createInlineReasoningParser({ onThinking, onContent });
	}

	/**
	 * Tool-calling completion used by the Chungus Assistant. Returns the assistant text
	 * for this step plus any fully-parsed tool calls. Streaming follows the same rule as
	 * plain completions (whether the caller wants tokens), which is how the Assistant
	 * connection's Stream response setting reaches the wire.
	 */
	async completeWithTools(options: LLMToolStreamOptions): Promise<LLMToolResult> {
		if (this.requiresApiKey && !this.apiKey) {
			throw new Error(`${this.displayName} API key not configured`);
		}
		if (!options.model) {
			throw new Error(`${this.displayName}: no model selected. Pick an assistant model in settings.`);
		}

		const isStreaming = !!options.onToken;
		// Same snapshot-before-await rule as complete(), for the same reason.
		const typed = this.baseUrl;
		const headers = this.headers();
		const body = this.buildRequestBody(
			{ ...options, messages: this.toWireMessages(options.messages, options.tuning) },
			{
				tools: options.tools,
				tool_choice: 'auto',
				stream: isStreaming,
				...(isStreaming ? { stream_options: { include_usage: true } } : {})
			}
		);

		if (!isStreaming) return this.toolCompletion(body, options, typed, headers);

		const response = await timedFetch(
			`${await this.resolveBase(typed, headers)}/chat/completions`,
			{ method: 'POST', headers, body: JSON.stringify(body), signal: options.signal },
			STREAM_HEADERS_TIMEOUT_MS,
			`${this.displayName} completion`
		);
		if (!response.ok) throw new Error(await this.extractErrorMessage(response));

		let content = '';
		let thinking = '';
		let finishReason: LLMToolResult['finishReason'] = 'stop';
		// Whether the provider ever sent an explicit finish_reason. Default 'stop' is a
		// LIE for a stream that just closed early (local endpoints do this under load): it
		// makes an empty truncated turn read as "the model chose to stop with nothing".
		let sawFinishReason = false;
		let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };

		const emitThinking = (t: string) => {
			thinking += t;
			options.onThinkingToken?.(t);
		};
		const emitContent = (t: string) => {
			content += t;
			options.onToken?.(t);
		};
		// No inline-reasoning parser here, deliberately: the assistant legitimately WRITES
		// marker-like text (quoting or fixing a roleplay message that contains "<think>"),
		// and an unclosed marker would silently reroute the rest of its reply into the
		// thinking channel. Structured reasoning fields still stream normally; a model
		// that leaks inline markers into a tool-calling reply shows them as plain text,
		// which is ugly but honest and beats silently losing the answer.

		// Tool calls accumulate by their `index` across deltas; id/name arrive on
		// the first chunk for a call, arguments stream in as string fragments.
		const toolAcc = new Map<number, { id: string; name: string; args: string }>();

		try {
			for await (const data of sseData(response, `${this.displayName} stream`)) {
				if (data === '[DONE]') continue;

				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(data);
				} catch (e) {
					// Don't echo the chunk itself: it can carry chat content.
					console.warn(`[${this.displayName}] Failed to parse SSE chunk (${data.length} chars):`, e);
					continue;
				}

				// A mid-stream error event ends the generation: fail loud, never return
				// the partial accumulation as a quietly "successful" empty turn.
				const streamError = this.streamEventError(parsed);
				if (streamError) throw new Error(`${this.displayName}: ${streamError}`);

				const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0];
				const delta = choice?.delta as Record<string, unknown> | undefined;

				const reasoningDelta =
					(delta?.reasoning_content as string) ?? (delta?.reasoning as string) ?? (delta?.thinking as string);
				if (reasoningDelta) {
					emitThinking(reasoningDelta);
				}

				const contentDelta = delta?.content as string | undefined;
				if (contentDelta) {
					emitContent(contentDelta);
				}

				const toolDeltas = delta?.tool_calls as
					| { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
					| undefined;
				if (toolDeltas) {
					for (const td of toolDeltas) {
						const idx = td.index ?? 0;
						let acc = toolAcc.get(idx);
						if (!acc) {
							acc = { id: '', name: '', args: '' };
							toolAcc.set(idx, acc);
						}
						if (td.id) acc.id = td.id;
						if (td.function?.name) acc.name = td.function.name;
						if (td.function?.arguments) acc.args += td.function.arguments;
						if (acc.name) {
							options.onToolCallDelta?.({ index: idx, name: acc.name, argumentsSoFar: acc.args });
						}
					}
				}

				const fr = choice?.finish_reason as string | undefined;
				if (fr) {
					finishReason = this.mapToolFinishReason(fr);
					sawFinishReason = true;
				}

				const u = parsed.usage as Record<string, any> | undefined;
				if (u) {
					usage = {
						promptTokens: u.prompt_tokens ?? 0,
						completionTokens: u.completion_tokens ?? 0,
						totalTokens: u.total_tokens ?? 0,
						// Normalized across every provider's cache-reporting shape (see cachedTokensFrom).
						cachedTokens: this.cachedTokensFrom(u)
					};
				}
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				finishReason = 'cancelled';
			} else {
				throw error;
			}
		}

		// A call that accumulated arguments but never a name is a corrupt stream: the
		// model asked for SOMETHING and silently dropping it would fake an empty turn.
		// (Nameless empty accumulators are glitch residue and are dropped below.)
		for (const [, acc] of toolAcc) {
			if (!acc.name && acc.args.trim() && finishReason !== 'cancelled') {
				throw new Error(`${this.displayName} streamed a tool call with arguments but no name, so the stream arrived corrupt. Try again.`);
			}
		}

		const toolCalls: LLMToolCall[] = [...toolAcc.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, acc]) => {
				let args: Record<string, unknown> = {};
				try {
					args = acc.args.trim() ? JSON.parse(acc.args) : {};
				} catch {
					// Leave args empty; the executor surfaces a clear error so the model retries.
					args = {};
				}
				return { id: acc.id, name: acc.name, arguments: args, rawArguments: acc.args };
			})
			.filter((c) => c.name);

		// The stream ended with NOTHING (no text, no tool call), and the provider never
		// sent a finish_reason. That is a truncated / early-closed connection, not a real
		// stop: reporting the default 'stop' makes the loop announce "the model chose to
		// end its turn empty" when the endpoint actually hung up mid-generation. Common
		// with local endpoints whose server (or a reverse proxy in front of it) ends the
		// stream during a long prompt-processing phase, or that stream without keepalives.
		// (`sawFinishReason` gates this so a genuine explicit empty stop still passes through.)
		if (!sawFinishReason && !content.trim() && !toolCalls.length && finishReason !== 'cancelled') {
			throw new Error(
				`${this.displayName}: the response stream closed before the model produced any reply or tool call, and without a finish signal. For a local endpoint this usually means the server (or a reverse proxy) ended the connection during a long prompt-processing phase, or it streams without keepalives, and the model may still be generating on its side. Raise the endpoint's idle/read limit or enable SSE keepalives, then try again.`
			);
		}

		return {
			content,
			thinking: stripResidualMarkers(thinking) || null,
			toolCalls,
			finishReason,
			usage,
			model: options.model,
			provider: this.name
		};
	}

	/**
	 * One non-streamed tool-calling request: the step's reply and every tool call land
	 * whole. No inline-reasoning extraction, for the reason the streaming path states:
	 * the assistant legitimately writes marker-like text.
	 */
	private async toolCompletion(
		body: Record<string, unknown>,
		options: LLMToolStreamOptions,
		typed: string,
		headers: Record<string, string>
	): Promise<LLMToolResult> {
		const response = await timedFetch(
			`${await this.resolveBase(typed, headers)}/chat/completions`,
			{ method: 'POST', headers, body: JSON.stringify(body), signal: options.signal },
			COMPLETION_HEADERS_TIMEOUT_MS,
			`${this.displayName} completion`
		);
		if (!response.ok) throw new Error(await this.extractErrorMessage(response));

		const data = (await readJsonCapped(
			response,
			MAX_COMPLETION_BODY_BYTES,
			`${this.displayName} completion response`
		)) as Record<string, any>;
		const choice = data.choices?.[0];
		const message = choice?.message;
		if (!message) {
			throw new Error(`${this.displayName} returned a completion with no choices`);
		}

		const thinking = [message.reasoning_content, message.reasoning, message.thinking]
			.filter((t: unknown): t is string => typeof t === 'string' && t.length > 0)
			.join('\n');

		const toolCalls: LLMToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
			.map((c: Record<string, any>): LLMToolCall => {
				const raw = typeof c.function?.arguments === 'string' ? c.function.arguments : '';
				let args: Record<string, unknown> = {};
				try {
					args = raw.trim() ? JSON.parse(raw) : {};
				} catch {
					// Leave args empty; the executor surfaces a clear error so the model retries.
				}
				return { id: String(c.id ?? ''), name: String(c.function?.name ?? ''), arguments: args, rawArguments: raw };
			})
			.filter((c: LLMToolCall) => c.name);

		const content = String(message.content ?? '').trim();
		const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
		// Nothing to show AND no finish signal is a truncated response, not a model that
		// chose to say nothing (the same guard the streaming path keeps, for the same reason).
		if (!finish && !content && !toolCalls.length) {
			throw new Error(
				`${this.displayName}: the completion returned no reply, no tool call and no finish reason. The endpoint likely ended the request early. Try again.`
			);
		}

		return {
			content,
			thinking: stripResidualMarkers(thinking) || null,
			toolCalls,
			finishReason: this.mapToolFinishReason(finish),
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				cachedTokens: this.cachedTokensFrom(data.usage)
			},
			model: options.model,
			provider: this.name
		};
	}

	private mapToolFinishReason(reason: string): LLMToolResult['finishReason'] {
		switch (reason) {
			case 'stop':
				return 'stop';
			case 'length':
				return 'length';
			case 'tool_calls':
			case 'function_call':
				return 'tool_calls';
			default:
				return 'error';
		}
	}

	async validateCredentials(): Promise<boolean> {
		if (this.requiresApiKey && !this.apiKey) return false;
		const probe = await this.probeModels(this.baseUrl, this.headers());
		if (probe.kind === 'engaged') {
			await probe.response.body?.cancel().catch(() => {});
			return false;
		}
		// "No API here at all" is not a credential verdict: throw the named error so
		// the editor can say what was tried instead of blaming the key.
		if (probe.kind === 'none') throw new Error(probe.message);
		return true;
	}

	async fetchAvailableModels(): Promise<ModelInfo[]> {
		const probe = await this.probeModels(this.baseUrl, this.headers());
		if (probe.kind === 'engaged') throw new Error(await this.extractErrorMessage(probe.response));
		if (probe.kind === 'none') throw new Error(probe.message);
		return probe.models
			.filter((m: { id?: unknown }) => typeof m.id === 'string')
			.map((m) => this.normalizeModel(m));
	}

	/** Normalize one /models entry into ModelInfo, keeping only fields we trust. */
	private normalizeModel(m: Record<string, unknown>): ModelInfo {
		const arch = m.architecture as Record<string, unknown> | undefined;
		const top = m.top_provider as Record<string, unknown> | undefined;
		const pricing = m.pricing as Record<string, unknown> | undefined;
		const ctx = num(m.context_length) ?? num(top?.context_length);
		const info: ModelInfo = { id: m.id as string };
		if (typeof m.name === 'string') info.name = m.name;
		if (ctx !== undefined) info.contextLength = ctx;
		if (pricing) {
			const prompt = num(pricing.prompt);
			const completion = num(pricing.completion);
			if (prompt !== undefined || completion !== undefined) info.pricing = { prompt, completion };
		}
		if (Array.isArray(arch?.input_modalities)) info.inputModalities = arch!.input_modalities as string[];
		if (Array.isArray(m.supported_parameters)) info.supportedParameters = m.supported_parameters as string[];
		if (num(m.created) !== undefined) info.created = num(m.created);

		// Rich enrichment (OpenRouter exposes these; bare providers leave them undefined).
		if (typeof m.knowledge_cutoff === 'string' && m.knowledge_cutoff) info.knowledgeCutoff = m.knowledge_cutoff;
		if (typeof top?.is_moderated === 'boolean') info.isModerated = top.is_moderated as boolean;
		const maxOut = num(top?.max_completion_tokens) ?? num((m.per_request_limits as Record<string, unknown> | undefined)?.completion_tokens);
		if (maxOut !== undefined) info.maxCompletionTokens = maxOut;
		const defaultTemp = num((m.default_parameters as Record<string, unknown> | undefined)?.temperature);
		if (defaultTemp !== undefined) info.defaultTemperature = defaultTemp;
		const reasoning = m.reasoning as Record<string, unknown> | undefined;
		if (reasoning && (reasoning.mandatory === true || reasoning.default_enabled === true || Array.isArray(reasoning.supported_efforts))) {
			info.isReasoning = true;
		} else if (Array.isArray(m.supported_parameters) && (m.supported_parameters as string[]).includes('reasoning')) {
			info.isReasoning = true;
		}
		// Let the provider profile shape its own /models fields over the generic pass.
		if (this.profile.normalizeModel) Object.assign(info, this.profile.normalizeModel(m));
		return info;
	}

	/** Bind the current credentials + base URL into a context for profile hooks.
	 *  The closure keeps the values captured HERE: a hook that awaits between
	 *  requests must not pick up another connection's configure() midway. */
	private runtime(): ProviderRuntime {
		const baseUrl = this.baseUrl;
		const headers = this.headers();
		return {
			baseUrl,
			request: (path, init) =>
				timedFetch(
					`${baseUrl}${path}`,
					{
						...init,
						headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) }
					},
					CONTROL_TIMEOUT_MS,
					`${this.displayName} request`
				),
			extractError: (res) => this.extractErrorMessage(res)
		};
	}

	/** Provider endpoints that serve a model, delegated to the profile hook ([] when none). */
	async fetchModelEndpoints(model: string): Promise<ModelEndpoint[]> {
		if (!this.profile.fetchModelEndpoints) return [];
		return this.profile.fetchModelEndpoints(this.runtime(), model);
	}

	/** Account/balance snapshot, delegated to the profile hook (null when none). */
	async fetchAccountInfo(): Promise<ProviderAccount | null> {
		if (!this.profile.fetchAccount) return null;
		return this.profile.fetchAccount(this.runtime());
	}

	/**
	 * GET /models against the candidate bases until one PROVES it serves the API:
	 * only a JSON model list pins a winner. A 404 means "not here, keep walking",
	 * and so does a 200 that is not a model list (an SPA's catch-all index page, a
	 * status page). An auth rejection or server error means a server engaged but
	 * can't be read: it is held as the best answer WITHOUT being pinned, so a later
	 * candidate that positively proves outranks it and nothing sticks while the
	 * user's key is wrong. A pinned base that stops proving is dropped and the walk
	 * re-runs in the same call, so a stack swap behind the same URL heals on the
	 * next use instead of staying broken for the life of the process. An
	 * unreachable host throws naming the typed URL: candidates differ only in
	 * path, so reachability is host-level and walking on would repeat the failure.
	 */
	private async probeModels(typed: string, headers: Record<string, string>): Promise<ModelsProbe> {
		const pinned = this.resolvedBases.get(typed);
		const candidates = pinned ? [pinned] : this.baseCandidates(typed);
		// Fixed-endpoint providers (and underivable URLs) have one candidate and no
		// probe: any status there is the provider's own answer, returned as-is.
		const probing = !!pinned || candidates.length > 1;
		let engaged: { base: string; response: Response } | null = null;
		let answered: string | null = null;
		for (const base of candidates) {
			let response: Response;
			try {
				response = await timedFetch(
					`${base}/models`,
					{ headers },
					CONTROL_TIMEOUT_MS,
					`${this.displayName} /models request`
				);
			} catch (e) {
				await engaged?.response.body?.cancel().catch(() => {});
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(`Cannot reach ${this.displayName} at ${typed} (${msg})`);
			}
			if (response.ok) {
				const body = await readBodyCapped(response, MAX_CONTROL_BODY_BYTES, `${this.displayName} /models response`);
				let list: unknown;
				try {
					list = (JSON.parse(body) as { data?: unknown } | null)?.data;
				} catch {
					list = undefined;
				}
				if (Array.isArray(list)) {
					const found = this.answeredBase(base, response);
					this.resolvedBases.set(typed, found);
					await engaged?.response.body?.cancel().catch(() => {});
					return {
						kind: 'api',
						base: found,
						models: list.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
					};
				}
				// 200, but not a model list: a web UI or another service answered here.
				answered ??= base;
				continue;
			}
			if (response.status === 404 && probing) {
				await response.body?.cancel().catch(() => {});
				continue;
			}
			if (engaged) await response.body?.cancel().catch(() => {});
			else engaged = { base, response };
		}
		if (engaged) return { kind: 'engaged', base: engaged.base, response: engaged.response };
		if (pinned) {
			// The pinned base no longer serves the API, so forget it and walk everything.
			this.resolvedBases.delete(typed);
			return this.probeModels(typed, headers);
		}
		return { kind: 'none', message: this.noApiMessage(candidates, answered, probing) };
	}

	/** The base that actually answered: derived from the response's final URL when
	 *  redirects moved the request (http→https, root→/v1), else the requested base.
	 *  The check runs on the parsed pathname: a bare endsWith could match inside a
	 *  query string and slice a base that never existed. */
	private answeredBase(requested: string, response: Response): string {
		const final = response.url;
		if (!final || final === `${requested}/models`) return requested;
		try {
			const parsed = new URL(final);
			if (parsed.search || parsed.hash || !parsed.pathname.endsWith('/models')) return requested;
		} catch {
			return requested;
		}
		return final.slice(0, -'/models'.length).replace(/\/+$/, '');
	}

	/** Human message for "nothing served a model list", naming every URL tried. */
	private noApiMessage(candidates: string[], answered: string | null, probing: boolean): string {
		if (!probing) {
			return `${this.displayName} returned an unexpected /models response from ${candidates[0]}`;
		}
		const seen = answered
			? ` ${answered} answered, but not with a model list, which looks like a web UI or another service.`
			: '';
		return `${this.displayName}: no OpenAI-compatible /models endpoint at ${candidates.join(' or ')}.${seen} If the API is mounted somewhere else, enter its full base URL.`;
	}

	private mapFinishReason(reason: string): LLMCompletionResult['finishReason'] {
		switch (reason) {
			case 'stop':
				return 'stop';
			case 'length':
				return 'length';
			default:
				return 'error';
		}
	}

	/**
	 * A mid-stream failure event: OpenRouter (and other gateways) answer 200, start the
	 * SSE stream, and deliver upstream errors as a `{"error": {...}}` event with no
	 * choices before ending the stream. Ignoring it (the pre-fix behavior) turned real
	 * provider failures into empty "successful" completions: the assistant's infamous
	 * bare "No reply.". Returns the human message, or null when the event is not an error.
	 */
	private streamEventError(parsed: Record<string, unknown>): string | null {
		const err = parsed.error;
		if (!err || typeof err !== 'object') return null;
		const e = err as Record<string, unknown>;
		const metadata = e.metadata as Record<string, unknown> | undefined;
		const raw = this.unwrapRaw(metadata?.raw);
		let msg = this.toErrorString(e.message) ?? raw ?? this.toErrorString(e) ?? 'stream error';
		// OpenRouter masks upstream failures behind a generic "Provider returned error";
		// the real reason lives in metadata.raw, so prefer it over the mask.
		if (raw && /provider returned error/i.test(msg)) msg = raw;
		const provider = this.toErrorString(metadata?.provider_name);
		const code = e.code != null ? ` (${String(e.code)})` : '';
		return `${provider ? `${provider}: ` : ''}${msg}${code}`;
	}

	private async extractErrorMessage(response: Response): Promise<string> {
		const text = await readBodyCapped(response, MAX_ERROR_BODY_BYTES, `${this.displayName} error response`).catch(
			() => ''
		);
		try {
			const body = JSON.parse(text);
			const raw = this.unwrapRaw(body?.error?.metadata?.raw);
			let msg = this.toErrorString(body?.error?.message)
				?? raw
				?? this.toErrorString(body?.detail?.error?.message)
				?? this.toErrorString(body?.message)
				?? this.toErrorString(body?.detail)
				?? this.toErrorString(body?.error);
			// OpenRouter masks upstream failures behind a generic "Provider returned error";
			// the real reason lives in metadata.raw, so prefer it over the mask.
			if (raw && msg && /provider returned error/i.test(msg)) msg = raw;
			if (msg) {
				const provider = this.toErrorString(body?.error?.metadata?.provider_name);
				return provider ? `${provider}: ${msg}` : msg;
			}
		} catch { /* not JSON */ }
		if (text && !text.startsWith('<')) return text.slice(0, 300);
		return this.httpStatusMessage(response.status);
	}

	// OpenRouter's metadata.raw is often a JSON-encoded upstream error body; unwrap it to the
	// human message inside rather than surfacing the raw JSON string.
	private unwrapRaw(val: unknown): string | null {
		const s = this.toErrorString(val);
		if (!s) return null;
		const trimmed = s.trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				const parsed = JSON.parse(trimmed);
				return this.toErrorString(parsed?.error?.message)
					?? this.toErrorString(parsed?.error)
					?? this.toErrorString(parsed?.message)
					?? this.toErrorString(parsed)
					?? trimmed.slice(0, 300);
			} catch { /* not JSON after all */ }
		}
		return s.slice(0, 300);
	}

	// Safely extract a human-readable string from an error field that could be a string, object, or array.
	private toErrorString(val: unknown): string | null {
		if (val == null) return null;
		if (typeof val === 'string') return val || null;
		if (Array.isArray(val)) {
			const first = val[0];
			const msg = typeof first === 'string' ? first : first?.msg ?? first?.message;
			return typeof msg === 'string' ? msg : null;
		}
		if (typeof val === 'object') {
			const obj = val as Record<string, unknown>;
			if (typeof obj.message === 'string' && obj.message) return obj.message;
			if (typeof obj.msg === 'string' && obj.msg) return obj.msg;
		}
		return null;
	}

	private httpStatusMessage(status: number): string {
		switch (status) {
			case 400: return 'Invalid request format or parameters';
			case 401: return 'Invalid or missing API key';
			case 402: return 'Insufficient credits';
			case 403: return 'API key lacks required permissions';
			case 404: return 'Model or endpoint not found';
			case 429: return 'Rate limited, try again shortly';
			case 500: return 'Server error, try again later';
			case 503: return 'Service temporarily unavailable';
			default: return `API error (${status})`;
		}
	}
}
