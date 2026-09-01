/** Small presentation helpers shared by the debug panel pieces. */
// The rune-free counting module, like the prompt assembler uses: the panel states a BASE
// estimate and labels it as one, so it needs no calibration layer. Importing the layer
// would drag the store graph into a module that is otherwise pure.
import { countTokens } from '$lib/tokenizer/count';
import type { EngineId } from '$lib/engines/registry';
import type { PromptLogEntry, PromptLogMessage, PromptLogStatus } from './types';

/**
 * A stable color per query kind, so the eye can scan the list. Keyed by the engine ids
 * (an engine's registry id IS its debug source label, per architecture/engines.md coupling
 * #1) plus the three callers that are not engines (an ordinary chat send, the assistant, and
 * a continue, which rides the primary connection like a send but is worth telling apart in
 * the log), so a new engine without a color is a compile error instead of an unexplained
 * gray row.
 */
const SOURCE_COLORS: Record<EngineId | 'chat' | 'assistant' | 'continue', string> = {
	chat: '#22c55e',
	'opening-scene': '#14b8a6',
	continue: '#f97316',
	memory: '#a855f7',
	assistant: '#3b82f6',
	steering: '#6366f1',
	spellcheck: '#06b6d4',
	corrections: '#d946ef',
	impersonate: '#f43f5e',
	sprites: '#eab308'
};

/** Unlabeled callers render gray as "completion". Deliberate, see architecture/engines.md. */
export function sourceColor(source: string): string {
	return SOURCE_COLORS[source as keyof typeof SOURCE_COLORS] ?? '#94a3b8';
}

/**
 * One color per message role, declared once so a role reads identically wherever the panel
 * draws it: a transcript card, a synthesized response card, a tool-call block. `thinking`
 * is the panel's own label for extracted reasoning; it never rides the wire.
 */
const ROLE_COLORS: Record<string, string> = {
	system: '#60a5fa',
	user: '#4ade80',
	assistant: '#c084fc',
	tool: '#fbbf24',
	thinking: '#22d3ee'
};

export function roleColor(role: string): string {
	return ROLE_COLORS[role] ?? '#94a3b8';
}

export function statusColor(status: PromptLogStatus): string {
	switch (status) {
		case 'done':
			return '#22c55e';
		case 'pending':
			return '#f59e0b';
		case 'error':
			return '#ef4444';
		case 'cancelled':
			return '#94a3b8';
	}
}

export function statusLabel(status: PromptLogStatus): string {
	switch (status) {
		case 'done':
			return 'completed';
		case 'pending':
			return 'in flight';
		case 'error':
			return 'error';
		case 'cancelled':
			return 'canceled';
	}
}

export function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}

/** Wall clock down to the millisecond. The assistant fires several iterations inside one
 *  second, and a seconds-only stamp makes them look simultaneous. */
export function formatPreciseTime(ts: number): string {
	return `${new Date(ts).toLocaleTimeString()}.${String(new Date(ts).getMilliseconds()).padStart(3, '0')}`;
}

export function formatDuration(start: number, end?: number): string | null {
	if (!end) return null;
	const ms = end - start;
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(1)} s`;
}

// ===== Size =====

/**
 * Base-estimate tokens for one logged message: its text PLUS the tool-call payload it
 * carries. An assistant turn's tool arguments are real prompt weight on every later
 * iteration, and counting only `content` prices them at zero.
 */
export function messageTokens(message: PromptLogMessage, model?: string): number {
	let total = countTokens(message.content ?? '', model);
	if (message.tool_calls) total += countTokens(JSON.stringify(message.tool_calls), model);
	return total;
}

/** Base-estimate tokens for the tool definitions sent with a request: routinely more than
 *  half of an assistant prompt, so leaving them out understates the request by more than
 *  the conversation itself. */
export function toolTokens(tools: unknown[] | undefined, model?: string): number {
	return tools?.length ? countTokens(JSON.stringify(tools), model) : 0;
}

/**
 * Estimating means BPE-encoding an entire prompt, and the list re-renders on every log
 * event. A captured entry's REQUEST half never changes once recorded, so the estimate is
 * memoized by id; the map is dropped wholesale once it outgrows a few logs' worth.
 */
const estimateCache = new Map<string, number>();

function estimatePrompt(entry: PromptLogEntry): number {
	const hit = estimateCache.get(entry.id);
	if (hit !== undefined) return hit;
	let total = toolTokens(entry.tools, entry.model);
	for (const message of entry.messages) total += messageTokens(message, entry.model);
	if (estimateCache.size > 1000) estimateCache.clear();
	estimateCache.set(entry.id, total);
	return total;
}

/**
 * The ONE prompt-size number the panel shows. The model was handed a single prompt, so the
 * panel states a single figure: what the provider reported when it reported anything, our
 * own base estimate otherwise. `reported` says which of the two it is, so the panel never
 * puts two competing numbers on screen. A provider that answers with a zero prompt count
 * has reported nothing usable, and falls to the estimate under the estimate's own label.
 */
export function promptSize(entry: PromptLogEntry): { tokens: number; reported: boolean } {
	if (entry.usage && entry.usage.promptTokens > 0) return { tokens: entry.usage.promptTokens, reported: true };
	return { tokens: estimatePrompt(entry), reported: false };
}

/** Estimated tokens of the whole conversation (no tool definitions), for the section header. */
export function messagesSize(entry: PromptLogEntry): number {
	let total = 0;
	for (const message of entry.messages) total += messageTokens(message, entry.model);
	return total;
}

/** Every image path that rode this request, in message order. Their presence in the logged
 *  messages IS the proof they were sent: the log stores what went on the wire, after the
 *  provider/model image gate has already dropped what could not go. */
export function entryImages(entry: PromptLogEntry): string[] {
	return entry.messages.flatMap((m) => m.images ?? []);
}

// ===== Request fields =====

/** Flatten one request object into `key value` chips. Nested keys are dotted and arrays
 *  joined, so a knob added to the tuning or routing shapes later shows up here with no edit,
 *  which is what makes "visible === sent" auditable from this panel. */
function fieldChips(prefix: string, value: unknown, out: string[]): void {
	if (value === undefined || value === null) return;
	if (Array.isArray(value)) {
		if (value.length) out.push(`${prefix} ${value.join(', ')}`);
		return;
	}
	if (typeof value === 'object') {
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			fieldChips(prefix ? `${prefix}.${key}` : key, nested, out);
		}
		return;
	}
	if (typeof value === 'boolean') {
		out.push(`${prefix} ${value ? 'on' : 'off'}`);
		return;
	}
	out.push(`${prefix} ${String(value)}`);
}

/** Every request field that rode this call: the sampling params the provider received, the
 *  stream mode, and the tuning/routing objects field by field. */
export function requestChips(entry: PromptLogEntry): string[] {
	const chips: string[] = [];
	const params = entry.params ?? {};
	// Most callers put max_tokens/temperature inside `params`; the assistant also surfaces
	// them as top-level fields. Show each value once, from whichever half carries it.
	if (entry.temperature !== undefined && params.temperature === undefined) chips.push(`temperature ${entry.temperature}`);
	if (entry.maxTokens !== undefined && params.max_tokens === undefined && params.max_completion_tokens === undefined) {
		chips.push(`max_tokens ${entry.maxTokens}`);
	}
	for (const [key, value] of Object.entries(params)) chips.push(`${key} ${value}`);
	chips.push(entry.stream ? 'stream' : 'no-stream');
	fieldChips('', entry.tuning, chips);
	fieldChips('route', entry.routing, chips);
	return chips;
}
