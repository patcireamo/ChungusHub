import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	LLMProviderConfig,
	LLMToolCall,
	LLMToolMessage,
	LLMToolResult,
	LLMToolStreamOptions,
	LLMMessage,
	GenerationTuning,
	ModelEndpoint,
	ModelInfo,
	ProviderAccount
} from './types';
import type { ChatProvider, ProviderProfile } from './providers/types';
import { num } from './providers/util';
import { loadImage } from './media';
import {
	timedFetch,
	readBodyCapped,
	readJsonCapped,
	sseData,
	CONTROL_TIMEOUT_MS,
	COMPLETION_START_BACKSTOP_MS,
	MAX_CONTROL_BODY_BYTES,
	MAX_COMPLETION_BODY_BYTES,
	MAX_ERROR_BODY_BYTES
} from './net';

const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic requires max_tokens; used only when neither the UI nor the caller set one. */
const FALLBACK_MAX_TOKENS = 8192;

/** The Messages API requires the first message to be a user turn (roleplay chats
 *  often open with an assistant greeting). Same text the client's strict
 *  post-processing mode inserts by default. */
const PLACEHOLDER_USER_TURN = '[Start a new chat]';

/** How long the per-model capability snapshot (from /models) stays fresh. */
const CAPS_TTL_MS = 5 * 60_000;

/** How many raw assistant turns (thinking + tool_use blocks) we keep for replay. */
const RAW_TURN_CACHE_MAX = 200;

/** What we need per model to build honest requests, from /models capabilities. */
interface ModelCaps {
	thinking: boolean;
	adaptive: boolean;
	enabled: boolean;
	/** output_config.effort is accepted (adaptive-thinking generations). */
	effort: boolean;
}

/** App effort level → output_config.effort value (adaptive-thinking models). */
const ADAPTIVE_EFFORT: Record<string, string> = {
	minimal: 'low',
	low: 'low',
	medium: 'medium',
	high: 'high',
	max: 'max'
};

/** App effort level → thinking budget as a fraction of max_tokens (enabled-style models).
 *  'minimal' rides the 1024-token API floor. */
const BUDGET_FRACTION: Record<string, number> = {
	minimal: 0,
	low: 0.1,
	medium: 0.25,
	high: 0.5,
	max: 0.8
};

type Block = Record<string, unknown>;

/** One Messages API turn on the wire. */
interface WireMessage {
	role: 'user' | 'assistant';
	content: Block[];
}

interface StreamOutcome {
	text: string;
	thinking: string;
	stopReason: string | null;
	refusalExplanation: string | null;
	cancelled: boolean;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number };
	/** Content blocks exactly as streamed (thinking/text/tool_use), replayable next turn. */
	raw: Block[];
	tools: { id: string; name: string; args: string }[];
}

/**
 * Native Anthropic Messages API provider (POST /v1/messages).
 *
 * Speaks the real wire format instead of the OpenAI-compat shim, which buys us
 * what the shim strips: extended/adaptive thinking (streamed into the existing
 * thinking channel), prompt caching (system + conversation prefix, a large win
 * for roleplay where the whole history is resent every turn), native top_k, and
 * real error messages.
 *
 * Honesty contract: paramPolicy is 'reported' and each model's
 * supportedParameters is synthesized from the live /models `capabilities`
 * object, so the UI only offers knobs the request will actually honour.
 * Sampling support is inferred structurally rather than from a hardcoded model
 * list: the generations that removed manual thinking (`thinking.types.enabled`
 * unsupported while `adaptive` is supported: Opus 4.7/4.8, Sonnet 5, Fable 5)
 * are exactly the ones that reject temperature/top_p/top_k with a 400.
 */
export class AnthropicNativeProvider implements ChatProvider {
	readonly name: string;
	readonly displayName: string;
	readonly supportsStreaming = true;
	readonly availableModels = [] as const;

	private readonly defaultBaseUrl: string;
	private apiKey = '';
	private baseUrl: string;

	/** Per-model capability snapshot from the last /models fetch. */
	private caps = new Map<string, ModelCaps>();
	private capsAt = 0;

	/**
	 * Raw assistant content blocks from previous tool-calling turns, keyed by the
	 * turn's first tool_use id. The assistant transport only carries text +
	 * tool_calls, but the Messages API requires thinking blocks to be replayed
	 * unmodified ahead of the tool_use blocks they produced, so we stash each
	 * streamed turn here and splice it back verbatim when the loop resends the
	 * conversation. In-process only: after a restart mid-conversation the rebuilt
	 * turn simply lacks its thinking blocks (thinking-enabled models may reject
	 * that one request; a fresh assistant conversation recovers).
	 */
	private rawTurns = new Map<string, Block[]>();

	constructor(profile: ProviderProfile) {
		this.name = profile.name;
		this.displayName = profile.displayName;
		this.defaultBaseUrl = profile.defaultBaseUrl;
		this.baseUrl = profile.defaultBaseUrl;
	}

	configure(config: LLMProviderConfig): void {
		this.apiKey = config.apiKey;
		this.baseUrl = config.baseUrl?.trim() || this.defaultBaseUrl;
	}

	private headers(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'anthropic-version': ANTHROPIC_VERSION,
			'x-api-key': this.apiKey
		};
	}

	// ===== Models & capabilities =====

	async validateCredentials(): Promise<boolean> {
		if (!this.apiKey) return false;
		const res = await this.controlRequest('/models?limit=1');
		await res.body?.cancel().catch(() => {});
		return res.ok;
	}

	async fetchAvailableModels(): Promise<ModelInfo[]> {
		const models: ModelInfo[] = [];
		let after: string | null = null;
		// The catalog is a few dozen entries; 5 pages of 1000 is a hard sanity cap.
		for (let page = 0; page < 5; page++) {
			const path = `/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
			const res = await this.controlRequest(path);
			if (!res.ok) throw new Error(await this.extractErrorMessage(res));
			const data = (await readJsonCapped(res, MAX_CONTROL_BODY_BYTES, `${this.displayName} /models response`)) as
				| Record<string, unknown>
				| null;
			const list = data?.data;
			if (!Array.isArray(list)) {
				throw new Error(`${this.displayName} returned an unexpected /models response from ${this.baseUrl}`);
			}
			for (const m of list) {
				if (m && typeof m.id === 'string') models.push(this.normalizeModel(m as Record<string, unknown>));
			}
			if (data?.has_more === true && typeof data.last_id === 'string') after = data.last_id;
			else break;
		}
		this.capsAt = Date.now();
		return models;
	}

	/** Map one native /models entry to ModelInfo and record its capability snapshot. */
	private normalizeModel(raw: Record<string, unknown>): ModelInfo {
		const info: ModelInfo = { id: raw.id as string };
		if (typeof raw.display_name === 'string' && raw.display_name) info.name = raw.display_name;
		const ctx = num(raw.max_input_tokens);
		if (ctx !== undefined && ctx > 0) info.contextLength = ctx;
		const maxOut = num(raw.max_tokens);
		if (maxOut !== undefined && maxOut > 0) info.maxCompletionTokens = maxOut;
		if (typeof raw.created_at === 'string') {
			const t = Date.parse(raw.created_at);
			if (Number.isFinite(t)) info.created = Math.floor(t / 1000);
		}

		const c = raw.capabilities as Record<string, Record<string, unknown>> | undefined;
		const thinking = c?.thinking as { supported?: boolean; types?: Record<string, { supported?: boolean }> } | undefined;
		const caps: ModelCaps = {
			thinking: thinking?.supported === true,
			adaptive: thinking?.types?.adaptive?.supported === true,
			enabled: thinking?.types?.enabled?.supported === true,
			effort: (c?.effort as { supported?: boolean } | undefined)?.supported === true
		};
		this.caps.set(info.id, caps);

		if (caps.thinking) info.isReasoning = true;
		info.inputModalities = (c?.image_input as { supported?: boolean } | undefined)?.supported === true
			? ['text', 'image']
			: ['text'];
		// 'tools' is included unconditionally: every Claude model speaks native
		// tool use, and the connection UI reads this flag for the assistant badge.
		info.supportedParameters = this.samplingSupported(caps)
			? ['max_tokens', 'temperature', 'top_p', 'top_k', 'tools']
			: ['max_tokens', 'tools'];
		return info;
	}

	/** The adaptive-only generation rejects temperature/top_p/top_k with a 400. */
	private samplingSupported(caps: ModelCaps): boolean {
		return !(caps.thinking && caps.adaptive && !caps.enabled);
	}

	/**
	 * Capability snapshot for a model, refreshing /models when stale or unknown.
	 * The attempt timestamp advances even on failure or a model id absent from
	 * the catalog (aliases), so a broken /models endpoint costs at most one
	 * bounded pre-flight per TTL window, never a stall on every generation.
	 * A failed refresh is logged loudly; the generation itself still runs and
	 * the Messages API remains the judge of what the model accepts.
	 */
	private async capsFor(model: string): Promise<ModelCaps | undefined> {
		const fresh = Date.now() - this.capsAt < CAPS_TTL_MS;
		if (!fresh || !this.caps.has(model)) {
			try {
				await this.fetchAvailableModels();
			} catch (e) {
				console.warn(`[${this.displayName}] capability refresh failed:`, e instanceof Error ? e.message : e);
			}
			this.capsAt = Date.now();
		}
		return this.caps.get(model);
	}

	async fetchModelEndpoints(): Promise<ModelEndpoint[]> {
		return [];
	}

	async fetchAccountInfo(): Promise<ProviderAccount | null> {
		// Anthropic exposes no balance/usage endpoint for inference keys.
		return null;
	}

	// ===== Request assembly =====

	/**
	 * Reshape the assembled chat into Messages API structure: leading system
	 * turns become the top-level system blocks, later system turns demote to
	 * user (there is no mid-conversation system on this surface), empty turns
	 * drop, and a placeholder user turn opens the chat when the prompt would
	 * otherwise start with the assistant (hard API requirement).
	 */
	private convertPlainMessages(messages: LLMMessage[]): { system?: Block[]; messages: WireMessage[] } {
		const systemParts: string[] = [];
		const turns: { role: 'user' | 'assistant'; text: string; images?: string[] }[] = [];
		// Positional: only system messages BEFORE the first chat turn are hoisted,
		// even when that first turn is empty and gets dropped.
		let seenTurn = false;
		for (const m of messages) {
			if (m.role !== 'system') seenTurn = true;
			if ((!m.content || !m.content.trim()) && !m.images?.length) continue;
			if (m.role === 'system') {
				if (!seenTurn) systemParts.push(m.content);
				else turns.push({ role: 'user', text: m.content });
			} else {
				turns.push({ role: m.role, text: m.content, images: m.images });
			}
		}
		if (turns.length === 0 && systemParts.length === 0) {
			throw new Error(`${this.displayName}: assembled prompt is empty`);
		}
		if (turns.length === 0 || turns[0].role !== 'user') {
			turns.unshift({ role: 'user', text: PLACEHOLDER_USER_TURN });
		}
		// The API rejects trailing whitespace on a final assistant turn (prefill).
		// (Never empties the turn: whitespace-only messages were dropped above.)
		const last = turns[turns.length - 1];
		if (last.role === 'assistant') last.text = last.text.replace(/\s+$/, '');

		// Image blocks lead their turn (the documented placement); text follows.
		const wire: WireMessage[] = turns.map((t) => {
			const content: Block[] = (t.images ?? []).map((path) => {
				const img = loadImage(path);
				return { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } };
			});
			if (t.text.trim() || content.length === 0) content.push({ type: 'text', text: t.text });
			return { role: t.role, content };
		});
		return { system: this.systemBlocks(systemParts), messages: wire };
	}

	private systemBlocks(parts: string[]): Block[] | undefined {
		if (parts.length === 0) return undefined;
		return parts.map((text) => ({ type: 'text', text }));
	}

	/**
	 * Prompt-caching breakpoints: end of system (stable across a session) and the
	 * final content block (so next turn's longer conversation reads this whole
	 * request from cache). Roleplay resends the full history every turn, so this
	 * turns ~all input tokens into cache reads at ~0.1x price.
	 *
	 * Opt-in: the Messages API caches nothing without these markers, so we place them
	 * only when the user enabled caching this request. Off = plain full-price input, by
	 * the user's choice. `cacheTtl` selects the 5m (default) or 1h lifetime.
	 */
	private placeCacheBreakpoints(system: Block[] | undefined, messages: WireMessage[], tuning?: GenerationTuning): void {
		if (tuning?.promptCaching !== true) return;
		const control = tuning.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
		if (system && system.length > 0) {
			system[system.length - 1] = { ...system[system.length - 1], cache_control: { ...control } };
		}
		// Replace (never mutate) the final block: cached raw turns are shared
		// across requests, so mutation here would poison the replay cache.
		const last = messages[messages.length - 1];
		if (last && last.content.length > 0) {
			const content = [...last.content];
			content[content.length - 1] = { ...content[content.length - 1], cache_control: { ...control } };
			last.content = content;
		}
	}

	/**
	 * Merge tuning into the request body, honestly:
	 *  - max_tokens is required by the API (UI value, else a documented default);
	 *  - only sampling fields the Messages API defines are accepted: anything
	 *    else in `params` throws naming the field, instead of a cryptic 400
	 *    (params can carry other providers' knobs when the client's model
	 *    capability cache failed to load);
	 *  - NEUTRAL sampling values, no-ops by definition (temperature 1, top_p 1,
	 *    top_k 0), are silently omitted where the model rejects the field or the
	 *    field conflicts; a NON-neutral value the model would reject throws, so
	 *    user intent is never silently dropped;
	 *  - Claude 4+ accepts temperature OR top_p, not both: the neutral one
	 *    yields, two non-neutral values throw;
	 *  - the native API bounds temperature to 0–1, and out-of-range throws with the
	 *    slider named rather than being clamped out of sight.
	 */
	private applyTuning(
		body: Record<string, unknown>,
		o: { maxTokens?: number; temperature?: number; stop?: string[]; params?: Record<string, string | number> },
		caps: ModelCaps | undefined
	): void {
		const params = { ...(o.params ?? {}) };
		const paramMax = num(params.max_tokens) ?? num(params.max_completion_tokens);
		delete params.max_tokens;
		delete params.max_completion_tokens;
		body.max_tokens = o.maxTokens ?? paramMax ?? FALLBACK_MAX_TOKENS;
		if (o.stop?.length) body.stop_sequences = o.stop;

		if (o.temperature !== undefined) body.temperature = o.temperature;
		const sampling: Record<string, number> = { temperature: 1, top_p: 1, top_k: 0 }; // field -> neutral value
		for (const [key, value] of Object.entries(params)) {
			if (!(key in sampling)) {
				throw new Error(
					`${this.displayName} does not accept the "${key}" parameter, so reset it in sampling settings`
				);
			}
			body[key] = value;
		}

		if (caps && !this.samplingSupported(caps)) {
			const set = Object.keys(sampling).filter((k) => body[k] !== undefined && body[k] !== sampling[k]);
			if (set.length) {
				throw new Error(
					`${this.displayName}: this model does not accept ${set.join(', ')}, so reset the slider(s) or pick another model`
				);
			}
			for (const k of Object.keys(sampling)) delete body[k];
			return;
		}

		// Claude 4+ accepts temperature OR top_p, not both.
		if (body.temperature !== undefined && body.top_p !== undefined) {
			if (body.temperature === 1) delete body.temperature;
			else if (body.top_p === 1) delete body.top_p;
			else throw new Error(`${this.displayName} accepts temperature OR top_p, not both, so reset one of the sliders`);
		}
		const temp = num(body.temperature);
		if (temp !== undefined && (temp < 0 || temp > 1)) {
			throw new Error(`${this.displayName} accepts temperature between 0 and 1, so lower the Temperature slider`);
		}
	}

	/**
	 * Translate the user's reasoning tuning into this model generation's dialect:
	 *  - adaptive generations (Opus 4.7+, Sonnet 5, Fable 5): `thinking.display`
	 *    for visibility, `output_config.effort` for depth; 'off' sends an explicit
	 *    disable (Fable rejects that with a 400, loudly and as intended);
	 *  - enabled-style generations (Sonnet/Haiku 4.5 and older): thinking only runs
	 *    with an explicit `budget_tokens` (min 1024, must be < max_tokens), derived
	 *    from the effort level as a fraction of the response budget; 'off' is their
	 *    default, so nothing is sent;
	 *  - no tuning: prior behavior (adaptive with summarized display where accepted).
	 * Must run after applyTuning so max_tokens is final when budgets derive from it.
	 */
	private applyReasoning(
		body: Record<string, unknown>,
		caps: ModelCaps | undefined,
		tuning: GenerationTuning | undefined
	): void {
		const effort = tuning?.reasoningEffort;
		const display = tuning?.showReasoning === false ? 'omitted' : 'summarized';
		if (!caps?.thinking) return;
		const adaptive = caps.adaptive && !caps.enabled;

		if (effort === 'off') {
			if (adaptive) body.thinking = { type: 'disabled' };
			return;
		}
		if (adaptive) {
			body.thinking = { type: 'adaptive', display };
			if (effort && caps.effort) {
				body.output_config = { effort: ADAPTIVE_EFFORT[effort] ?? 'high' };
			}
			return;
		}
		if (effort && caps.enabled) {
			const maxTokens = num(body.max_tokens) ?? FALLBACK_MAX_TOKENS;
			const budget = Math.max(1024, Math.floor(maxTokens * (BUDGET_FRACTION[effort] ?? 0)));
			if (budget >= maxTokens) {
				throw new Error(
					`${this.displayName}: this model needs max_tokens above ${budget} for a thinking budget, so raise the max response length or lower the reasoning effort`
				);
			}
			body.thinking = { type: 'enabled', budget_tokens: budget };
		}
	}

	// ===== Plain completions =====

	async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
		this.assertConfigured(options.model, 'Pick a model in settings.');
		const caps = await this.capsFor(options.model);
		const { system, messages } = this.convertPlainMessages(options.messages);
		this.placeCacheBreakpoints(system, messages, options.tuning);

		const body: Record<string, unknown> = { model: options.model, messages };
		if (system) body.system = system;
		this.applyTuning(body, options, caps);
		this.applyReasoning(body, caps, options.tuning);

		if (options.onToken) {
			body.stream = true;
			const response = await this.messagesRequest(body, options.signal, COMPLETION_START_BACKSTOP_MS);
			const s = await this.consumeStream(response, {
				onText: options.onToken,
				onThinking: options.onThinkingToken
			});
			this.assertNotEmptyRefusal(s.stopReason, s.text, s.refusalExplanation);
			return {
				content: s.text,
				thinking: s.thinking || null,
				finishReason: s.cancelled ? 'cancelled' : this.mapStopReason(s.stopReason),
				usage: s.usage,
				model: options.model,
				provider: this.name
			};
		}

		const response = await this.messagesRequest(body, options.signal, COMPLETION_START_BACKSTOP_MS);
		const data = (await readJsonCapped(
			response,
			MAX_COMPLETION_BODY_BYTES,
			`${this.displayName} completion response`
		)) as Record<string, unknown>;
		const blocks = Array.isArray(data.content) ? (data.content as Block[]) : [];
		const content = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
		const thinkingText = blocks.filter((b) => b.type === 'thinking').map((b) => String(b.thinking ?? '')).join('\n');
		const stopReason = typeof data.stop_reason === 'string' ? data.stop_reason : null;
		const details = data.stop_details as { explanation?: string } | undefined;
		this.assertNotEmptyRefusal(stopReason, content, details?.explanation ?? null);
		return {
			content,
			thinking: thinkingText.trim() ? thinkingText : null,
			finishReason: this.mapStopReason(stopReason),
			usage: this.usageFrom(data.usage as Record<string, unknown> | undefined),
			model: options.model,
			provider: this.name
		};
	}

	// ===== Tool-calling completions (Chungus Assistant) =====

	async completeWithTools(options: LLMToolStreamOptions): Promise<LLMToolResult> {
		this.assertConfigured(options.model, 'Pick an assistant model in settings.');
		const caps = await this.capsFor(options.model);
		const { system, messages } = this.convertToolMessages(options.messages);
		this.placeCacheBreakpoints(system, messages, options.tuning);

		// Streaming follows the same rule as plain completions (whether the caller wants
		// tokens), which is how the Assistant connection's Stream response setting reaches
		// the wire. Off, the step's blocks land whole in one response.
		const isStreaming = !!options.onToken;
		const body: Record<string, unknown> = {
			model: options.model,
			messages,
			...(isStreaming ? { stream: true } : {}),
			tools: options.tools.map((t) => ({
				name: t.function.name,
				description: t.function.description,
				input_schema: t.function.parameters
			})),
			tool_choice: { type: 'auto' }
		};
		if (system) body.system = system;
		this.applyTuning(body, options, caps);
		// Honour the assistant's reasoning tuning (effort / visibility) exactly like plain
		// completions; with no tuning this reproduces the prior default (adaptive + summarized).
		this.applyReasoning(body, caps, options.tuning);

		if (!isStreaming) return this.toolCompletion(body, options);

		const response = await this.messagesRequest(body, options.signal, COMPLETION_START_BACKSTOP_MS);
		const s = await this.consumeStream(response, {
			onText: options.onToken,
			onThinking: options.onThinkingToken,
			onToolDelta: (ordinal, name, argsSoFar) =>
				options.onToolCallDelta?.({ index: ordinal, name, argumentsSoFar: argsSoFar })
		});
		this.assertNotEmptyRefusal(s.stopReason, s.text, s.refusalExplanation);

		if (s.tools.length > 0) this.rememberRawTurn(s.tools[0].id, s.raw);

		const toolCalls: LLMToolCall[] = s.tools.map((t) => {
			let args: Record<string, unknown> = {};
			try {
				args = t.args.trim() ? JSON.parse(t.args) : {};
			} catch {
				// Leave args empty; the executor surfaces a clear error so the model retries.
			}
			return { id: t.id, name: t.name, arguments: args, rawArguments: t.args };
		});

		const finishReason: LLMToolResult['finishReason'] = s.cancelled
			? 'cancelled'
			: s.stopReason === 'tool_use'
				? 'tool_calls'
				: this.mapStopReason(s.stopReason);

		return {
			content: s.text,
			thinking: s.thinking || null,
			toolCalls,
			finishReason,
			usage: s.usage,
			model: options.model,
			provider: this.name
		};
	}

	/**
	 * Reshape the assistant transcript (OpenAI-shaped roles) into Messages API turns:
	 * assistant tool calls become tool_use blocks (replayed verbatim from the raw
	 * cache when we streamed them ourselves, preserving thinking blocks), and
	 * consecutive tool results fold into ONE user turn of tool_result blocks, as
	 * the API requires for parallel calls.
	 */
	private convertToolMessages(messages: LLMToolMessage[]): { system?: Block[]; messages: WireMessage[] } {
		const systemParts: string[] = [];
		const wire: WireMessage[] = [];

		const pushTurn = (role: 'user' | 'assistant', blocks: Block[]) => {
			if (blocks.length > 0) wire.push({ role, content: blocks });
		};

		// Positional, like convertPlainMessages: hoist only leading system turns.
		let seenTurn = false;
		for (const m of messages) {
			if (m.role !== 'system') seenTurn = true;
			if (m.role === 'system') {
				if (!seenTurn) systemParts.push(m.content);
				else if (m.content.trim()) pushTurn('user', [{ type: 'text', text: m.content }]);
				continue;
			}
			if (m.role === 'tool') {
				const block: Block = { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content };
				const prev = wire[wire.length - 1];
				// Fold consecutive tool results into the same user turn.
				if (prev && prev.role === 'user' && prev.content.every((b) => b.type === 'tool_result')) {
					prev.content.push(block);
				} else {
					pushTurn('user', [block]);
				}
				continue;
			}
			if (m.role === 'assistant' && m.tool_calls?.length) {
				const cached = this.rawTurns.get(m.tool_calls[0].id);
				if (cached) {
					// Shared directly: nothing downstream mutates blocks (see
					// placeCacheBreakpoints), so no per-request deep copy is needed.
					pushTurn('assistant', cached);
				} else {
					const blocks: Block[] = [];
					if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
					for (const tc of m.tool_calls) {
						let input: Record<string, unknown> = {};
						try {
							input = tc.function.arguments.trim() ? JSON.parse(tc.function.arguments) : {};
						} catch {
							input = {};
						}
						blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
					}
					pushTurn('assistant', blocks);
				}
				continue;
			}
			// Image blocks lead their turn (the documented placement); text follows.
			const blocks: Block[] = (m.images ?? []).map((path) => {
				const img = loadImage(path);
				return { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } };
			});
			if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
			pushTurn(m.role, blocks);
		}

		if (wire.length === 0 || wire[0].role !== 'user') {
			wire.unshift({ role: 'user', content: [{ type: 'text', text: PLACEHOLDER_USER_TURN }] });
		}
		return { system: this.systemBlocks(systemParts), messages: wire };
	}

	/**
	 * One non-streamed tool-calling request: the step's blocks land whole. The response's
	 * own `content` array IS the replayable raw turn, so thinking blocks survive the next
	 * iteration exactly as they do on the streamed path.
	 */
	private async toolCompletion(body: Record<string, unknown>, options: LLMToolStreamOptions): Promise<LLMToolResult> {
		const response = await this.messagesRequest(body, options.signal, COMPLETION_START_BACKSTOP_MS);
		const data = (await readJsonCapped(
			response,
			MAX_COMPLETION_BODY_BYTES,
			`${this.displayName} completion response`
		)) as Record<string, unknown>;

		const blocks = Array.isArray(data.content) ? (data.content as Block[]) : [];
		const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
		const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => String(b.thinking ?? '')).join('\n');
		const stopReason = typeof data.stop_reason === 'string' ? data.stop_reason : null;
		const details = data.stop_details as { explanation?: string } | undefined;
		this.assertNotEmptyRefusal(stopReason, text, details?.explanation ?? null);

		const toolBlocks = blocks.filter((b) => b.type === 'tool_use');
		if (toolBlocks.length > 0) this.rememberRawTurn(String(toolBlocks[0].id ?? ''), blocks);

		const toolCalls: LLMToolCall[] = toolBlocks.map((b) => {
			const args = (b.input ?? {}) as Record<string, unknown>;
			return { id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: args, rawArguments: JSON.stringify(args) };
		});

		return {
			content: text,
			thinking: thinking.trim() ? thinking : null,
			toolCalls,
			finishReason: stopReason === 'tool_use' ? 'tool_calls' : this.mapStopReason(stopReason),
			usage: this.usageFrom(data.usage as Record<string, unknown> | undefined),
			model: options.model,
			provider: this.name
		};
	}

	private rememberRawTurn(firstToolId: string, raw: Block[]): void {
		// Streaming can emit empty text blocks ahead of tool_use; the API rejects
		// them on replay ("text content blocks must be non-empty"), so strip them.
		const replayable = raw.filter((b) => !(b.type === 'text' && !String(b.text ?? '').trim()));
		this.rawTurns.set(firstToolId, replayable);
		while (this.rawTurns.size > RAW_TURN_CACHE_MAX) {
			const oldest = this.rawTurns.keys().next().value;
			if (oldest === undefined) break;
			this.rawTurns.delete(oldest);
		}
	}

	// ===== Wire plumbing =====

	private assertConfigured(model: string, hint: string): void {
		if (!this.apiKey) throw new Error(`${this.displayName} API key not configured`);
		if (!model) throw new Error(`${this.displayName}: no model selected. ${hint}`);
	}

	/** A refusal with no usable output must fail loudly, not render an empty reply. */
	private assertNotEmptyRefusal(stopReason: string | null, content: string, explanation: string | null): void {
		if (stopReason === 'refusal' && !content.trim()) {
			throw new Error(
				`${this.displayName} declined the request (safety refusal${explanation ? `: ${explanation}` : ''})`
			);
		}
	}

	private async controlRequest(path: string): Promise<Response> {
		try {
			return await timedFetch(
				`${this.baseUrl}${path}`,
				{ headers: this.headers() },
				CONTROL_TIMEOUT_MS,
				`${this.displayName} request`
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`Cannot reach ${this.displayName} at ${this.baseUrl} (${msg})`);
		}
	}

	private async messagesRequest(
		body: Record<string, unknown>,
		signal: AbortSignal | undefined,
		headersTimeoutMs: number
	): Promise<Response> {
		const response = await timedFetch(
			`${this.baseUrl}/messages`,
			{ method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal },
			headersTimeoutMs,
			`${this.displayName} completion`
		);
		if (!response.ok) throw new Error(await this.extractErrorMessage(response));
		return response;
	}

	/**
	 * Consume a Messages API SSE stream. Every event type the API documents is
	 * handled; mid-stream `error` events throw (fail loud), user aborts return
	 * the partial accumulation flagged cancelled, and idle/oversize streams are
	 * killed inside the shared sseData framing (which also cancels the upstream
	 * request on any exit).
	 */
	private async consumeStream(
		response: Response,
		handlers: {
			onText?: (t: string) => void;
			onThinking?: (t: string) => void;
			onToolDelta?: (ordinal: number, name: string, argsSoFar: string) => void;
		}
	): Promise<StreamOutcome> {
		const raw: Block[] = [];
		const open = new Map<number, { block: Block; toolArgs: string; toolOrdinal: number }>();
		const tools: StreamOutcome['tools'] = [];
		let toolOrdinal = 0;
		let stopReason: string | null = null;
		let refusalExplanation: string | null = null;
		let cancelled = false;
		let promptTokens = 0;
		let cacheReadTokens = 0;
		let completionTokens = 0;

		try {
			for await (const data of sseData(response, `${this.displayName} stream`)) {
				let ev: Record<string, unknown>;
				try {
					ev = JSON.parse(data);
				} catch (e) {
					// Don't echo the chunk itself: it can carry chat content.
					console.warn(`[${this.displayName}] Failed to parse SSE chunk (${data.length} chars):`, e);
					continue;
				}

				switch (ev.type) {
						case 'message_start': {
							const u = (ev.message as Record<string, unknown> | undefined)?.usage as
								| Record<string, unknown>
								| undefined;
							cacheReadTokens = num(u?.cache_read_input_tokens) ?? 0;
							promptTokens =
								(num(u?.input_tokens) ?? 0) +
								(num(u?.cache_creation_input_tokens) ?? 0) +
								cacheReadTokens;
							break;
						}
						case 'content_block_start': {
							const index = num(ev.index) ?? 0;
							const cb = (ev.content_block ?? {}) as Block;
							let block: Block;
							if (cb.type === 'text') block = { type: 'text', text: '' };
							else if (cb.type === 'thinking') block = { type: 'thinking', thinking: '', signature: '' };
							else if (cb.type === 'tool_use') block = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
							else block = { ...cb }; // redacted_thinking and future block types, kept verbatim
							raw.push(block);
							open.set(index, { block, toolArgs: '', toolOrdinal: cb.type === 'tool_use' ? toolOrdinal++ : -1 });
							break;
						}
						case 'content_block_delta': {
							const entry = open.get(num(ev.index) ?? 0);
							if (!entry) break;
							const d = (ev.delta ?? {}) as Block;
							if (d.type === 'text_delta' && typeof d.text === 'string') {
								entry.block.text = String(entry.block.text ?? '') + d.text;
								handlers.onText?.(d.text);
							} else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
								entry.block.thinking = String(entry.block.thinking ?? '') + d.thinking;
								handlers.onThinking?.(d.thinking);
							} else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
								entry.block.signature = String(entry.block.signature ?? '') + d.signature;
							} else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
								entry.toolArgs += d.partial_json;
								handlers.onToolDelta?.(entry.toolOrdinal, String(entry.block.name ?? ''), entry.toolArgs);
							}
							break;
						}
						case 'content_block_stop': {
							const index = num(ev.index) ?? 0;
							const entry = open.get(index);
							if (entry && entry.block.type === 'tool_use') {
								try {
									entry.block.input = entry.toolArgs.trim() ? JSON.parse(entry.toolArgs) : {};
								} catch {
									entry.block.input = {};
								}
								tools.push({
									id: String(entry.block.id ?? ''),
									name: String(entry.block.name ?? ''),
									args: entry.toolArgs
								});
							}
							open.delete(index);
							break;
						}
						case 'message_delta': {
							const d = ev.delta as Record<string, unknown> | undefined;
							if (typeof d?.stop_reason === 'string') stopReason = d.stop_reason;
							const details = d?.stop_details as { explanation?: string } | undefined;
							if (typeof details?.explanation === 'string') refusalExplanation = details.explanation;
							const out = num((ev.usage as Record<string, unknown> | undefined)?.output_tokens);
							if (out !== undefined) completionTokens = out; // cumulative, not a delta
							break;
						}
						case 'error': {
							const err = ev.error as { type?: string; message?: string } | undefined;
							throw new Error(`${this.displayName}: ${err?.message ?? 'stream error'} (${err?.type ?? 'error'})`);
						}
					// ping / message_stop / unknown: nothing to accumulate
				}
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				cancelled = true;
			} else {
				throw error;
			}
		}

		const text = raw.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
		const thinkingText = raw
			.filter((b) => b.type === 'thinking')
			.map((b) => String(b.thinking ?? ''))
			.filter((t) => t.trim())
			.join('\n');

		return {
			text,
			thinking: thinkingText,
			stopReason,
			refusalExplanation,
			cancelled,
			usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedTokens: cacheReadTokens },
			raw,
			tools
		};
	}

	private usageFrom(u: Record<string, unknown> | undefined): LLMCompletionResult['usage'] {
		const cachedTokens = num(u?.cache_read_input_tokens) ?? 0;
		const promptTokens =
			(num(u?.input_tokens) ?? 0) +
			(num(u?.cache_creation_input_tokens) ?? 0) +
			cachedTokens;
		const completionTokens = num(u?.output_tokens) ?? 0;
		return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedTokens };
	}

	private mapStopReason(reason: string | null): LLMCompletionResult['finishReason'] {
		switch (reason) {
			case 'end_turn':
			case 'stop_sequence':
			case 'tool_use':
				return 'stop';
			case 'max_tokens':
			case 'model_context_window_exceeded':
				return 'length';
			default:
				// refusal (with partial content), pause_turn (an incomplete turn we
				// have no resume path for) and anything unknown surface as error,
				// never as a fake successful stop.
				return 'error';
		}
	}

	private async extractErrorMessage(response: Response): Promise<string> {
		const text = await readBodyCapped(response, MAX_ERROR_BODY_BYTES, `${this.displayName} error response`).catch(
			() => ''
		);
		try {
			const body = JSON.parse(text);
			const err = body?.error as { type?: string; message?: string } | undefined;
			if (err?.message) return err.type ? `${err.message} (${err.type})` : err.message;
		} catch {
			/* not JSON */
		}
		if (text && !text.startsWith('<')) return text.slice(0, 300);
		switch (response.status) {
			case 400: return 'Invalid request format or parameters';
			case 401: return 'Invalid or missing API key';
			case 403: return 'API key lacks required permissions';
			case 404: return 'Model or endpoint not found';
			case 413: return 'Request too large';
			case 429: return 'Rate limited, try again shortly';
			case 500: return 'Server error, try again later';
			case 529: return 'Anthropic is overloaded, try again shortly';
			default: return `API error (${response.status})`;
		}
	}
}
