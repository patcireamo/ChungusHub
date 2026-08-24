/**
 * Named LLM connections + the flat routing map.
 *
 * A Connection is a self-contained provider/model/settings bundle. Its secret
 * half (API key + base URL) lives server-side keyed by the connection id
 * (the `connection_credentials` table), never in this object.
 *
 * Routing is ONE flat map (`assignments`), and every calling point carries its own
 * concrete connection id: `primary` (the story), `assistant` (the Chungus Assistant),
 * and each calling engine by id. There are no roles, no groups, no
 * "follows X" defaults, no pins: what the Connections page shows is literally
 * what each call rides. A fresh install binds every point to the one Default
 * connection; splitting them later is the user's own, explicit choice.
 *
 * This store is the client-side source of truth for the non-secret connection
 * data and the routing map, riding the settings spine (cross-device synced).
 * `llmService` reads it to resolve who serves each call.
 */
import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';
import { db } from '$lib/services/database';
import { ENGINES } from '$lib/engines/registry';
import { DECLARABLE_PARAMS, REASONING_DIALECTS } from '$lib/config/sampling';
import {
	DEFAULT_CONTEXT_SIZE,
	DEFAULT_GENERATION_SETTINGS,
	DEFAULT_PROMPT_PLACEHOLDER,
	PROMPT_POST_PROCESSING_MODES,
	PROVIDER_NAMES,
	type CallTarget,
	type Connection,
	type ProviderName,
	type PromptPostProcessingMode,
	type ReasoningDialect
} from '$lib/types/llm';

const CONNECTIONS_KEY = 'connections';
const ASSIGNMENTS_KEY = 'connectionAssignments';

/** Every routing point, in display order: the story, the assistant, then each
 *  calling engine (registry order). Steering makes no call and is absent. */
export const ASSIGNMENT_IDS: string[] = [
	'primary',
	'assistant',
	...ENGINES.filter((e) => e.makesCalls).map((e) => e.id)
];

/** OpenRouter-first: a fresh connection points there until the user changes it. */
const DEFAULT_PROVIDER: ProviderName = 'openrouter';

function makeConnection(name: string, provider: ProviderName = DEFAULT_PROVIDER): Connection {
	return {
		id: crypto.randomUUID(),
		name,
		provider,
		model: '',
		contextSize: DEFAULT_CONTEXT_SIZE,
		postProcessing: 'merge',
		promptPlaceholder: DEFAULT_PROMPT_PLACEHOLDER,
		routing: null,
		samplingParams: [],
		reasoningDialect: 'none',
		generation: { ...DEFAULT_GENERATION_SETTINGS }
	};
}

/**
 * A BYO endpoint's declared params, kept to names we can actually render and send
 * and put back in card order. Anything else would be a declaration with no slider
 * behind it. Absent (every connection until now, and every non-BYO one) = empty,
 * which behaves exactly like the base-only policy those connections already had.
 */
function normalizeSamplingParams(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return DECLARABLE_PARAMS.filter((p) => raw.includes(p.key)).map((p) => p.key);
}

function normalizeConnection(raw: Partial<Connection> | null): Connection | null {
	if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
	const provider = PROVIDER_NAMES.includes(raw.provider as ProviderName)
		? (raw.provider as ProviderName)
		: DEFAULT_PROVIDER;
	const post = PROMPT_POST_PROCESSING_MODES.includes(raw.postProcessing as PromptPostProcessingMode)
		? (raw.postProcessing as PromptPostProcessingMode)
		: 'merge';
	// Absent (every connection until now, and every non-BYO one) or unknown = 'none',
	// which shows no reasoning control and sends nothing: exactly today's behaviour.
	const dialect = REASONING_DIALECTS.some((d) => d.value === raw.reasoningDialect)
		? (raw.reasoningDialect as ReasoningDialect)
		: 'none';
	return {
		id: raw.id,
		name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Connection',
		provider,
		model: typeof raw.model === 'string' ? raw.model : '',
		contextSize:
			typeof raw.contextSize === 'number' && raw.contextSize > 0
				? Math.floor(raw.contextSize)
				: DEFAULT_CONTEXT_SIZE,
		postProcessing: post,
		promptPlaceholder:
			typeof raw.promptPlaceholder === 'string' && raw.promptPlaceholder.trim()
				? raw.promptPlaceholder
				: DEFAULT_PROMPT_PLACEHOLDER,
		routing: raw.routing ?? null,
		samplingParams: normalizeSamplingParams(raw.samplingParams),
		reasoningDialect: dialect,
		generation: { ...DEFAULT_GENERATION_SETTINGS, ...(raw.generation ?? {}) }
	};
}

/** Every point gets a valid connection id; anything missing or dangling lands on
 *  the first connection, visible in the UI immediately, never a hidden rule. */
function normalizeAssignments(
	raw: Partial<Record<string, string>> | null,
	connections: Connection[]
): Record<string, string> {
	const ids = new Set(connections.map((c) => c.id));
	const fallback = connections[0]?.id ?? '';
	const out: Record<string, string> = {};
	for (const point of ASSIGNMENT_IDS) {
		const id = raw?.[point];
		out[point] = id && ids.has(id) ? id : fallback;
	}
	return out;
}

class ConnectionStore {
	connections = $state<Connection[]>([]);
	/** Routing point → connection id. Always complete after load. */
	assignments = $state<Record<string, string>>({});
	private initialized = false;

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.load();
		if (this.connections.length === 0) {
			const conn = makeConnection('Default');
			this.connections = [conn];
			this.assignments = normalizeAssignments(null, this.connections);
			this.persist();
		}
		registerSettingsReload(() => this.load());
		this.initialized = true;
	}

	private async load(): Promise<void> {
		const rawConns = await readSetting<Partial<Connection>[]>(CONNECTIONS_KEY, []);
		const conns = (Array.isArray(rawConns) ? rawConns : [])
			.map(normalizeConnection)
			.filter((c): c is Connection => c !== null);
		this.connections = conns;

		const rawAssignments = await readSetting<Partial<Record<string, string>> | null>(ASSIGNMENTS_KEY, null);
		this.assignments = normalizeAssignments(rawAssignments, conns);
	}

	private persist(): void {
		writeSetting(CONNECTIONS_KEY, this.connections);
		writeSetting(ASSIGNMENTS_KEY, this.assignments);
	}

	private uniqueName(base: string): string {
		const taken = new Set(this.connections.map((c) => c.name));
		if (!taken.has(base)) return base;
		for (let n = 2; ; n += 1) {
			const candidate = `${base} ${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}

	list(): Connection[] {
		return this.connections;
	}

	get(id: string): Connection | undefined {
		return this.connections.find((c) => c.id === id);
	}

	/** Create a fresh keyless connection (OpenRouter, no model) and return it.
	 *  Nothing is routed to it: pointing things at it is the user's move. */
	create(name?: string): Connection {
		const conn = makeConnection(this.uniqueName(name?.trim() || 'New connection'));
		this.connections = [...this.connections, conn];
		this.persist();
		return conn;
	}

	/** Copy a connection's settings under a new id, credentials included. The key
	 *  is duplicated server-side by id (`copyConnectionCredentials`) and never
	 *  rides the wire. Awaited so an editor opened on the copy already sees it. */
	async duplicate(id: string): Promise<Connection | undefined> {
		const src = this.get(id);
		if (!src) return undefined;
		const snapshot = $state.snapshot(src) as Connection;
		const conn: Connection = { ...snapshot, id: crypto.randomUUID(), name: this.uniqueName(`${src.name} copy`) };
		this.connections = [...this.connections, conn];
		this.persist();
		await db.copyConnectionCredentials(id, conn.id);
		return conn;
	}

	/** Shallow-merge a patch onto one connection (callers build nested objects themselves). */
	update(id: string, patch: Partial<Connection>): void {
		this.connections = this.connections.map((c) => (c.id === id ? { ...c, ...patch } : c));
		this.persist();
	}

	/** Delete a connection (never the last one). Every point routed to it moves to
	 *  the first remaining connection (visible in the UI right away) and its
	 *  server-side credentials are dropped. */
	remove(id: string): void {
		if (this.connections.length <= 1) return;
		this.connections = this.connections.filter((c) => c.id !== id);
		const fallback = this.connections[0].id;
		const next = { ...this.assignments };
		for (const point of ASSIGNMENT_IDS) {
			if (next[point] === id) next[point] = fallback;
		}
		this.assignments = next;
		this.persist();
		void db.deleteConnectionCredentials(id);
	}

	/** The connection id a routing point currently uses. */
	assignmentFor(point: string): string {
		return this.assignments[point] ?? '';
	}

	/** Route a point to a connection. */
	setAssignment(point: string, connectionId: string): void {
		if (!ASSIGNMENT_IDS.includes(point) || !this.get(connectionId)) return;
		this.assignments = { ...this.assignments, [point]: connectionId };
		this.persist();
	}

	/** The connection serving a call: a straight map lookup, nothing behind it. */
	connectionFor(target: CallTarget): Connection | undefined {
		const point = typeof target === 'object' ? target.engine : target;
		return this.get(this.assignments[point] ?? '');
	}

	/** Every routing point a connection currently serves (for the list UI's chips). */
	assignedPoints(id: string): string[] {
		return ASSIGNMENT_IDS.filter((point) => this.assignments[point] === id);
	}
}

export const connectionStore = new ConnectionStore();
