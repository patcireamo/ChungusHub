/**
 * Registry contracts.
 *
 * Two ideas live here and nothing else does:
 *  - An **entity** is one concept in the workspace (character, persona, message,
 *    lorebook, chat). Its FieldDef[] is the single source of truth for the data
 *    model: the same list feeds the generic tools, the JSON schemas, and the
 *    system-prompt data-model section. Add a field once, here, and it is reachable
 *    everywhere with no follow-up edits elsewhere.
 *  - A **capability** is one tool the assistant can call. The loop derives the entire
 *    tool list, the JSON schemas, and the mutate/destructive flags from these, so
 *    adding an action is one registration, not edits scattered across four files.
 */
import type { ApprovalPreview, AssistantContext, RiskClass, ToolOutcome } from '../types';
import type { SyncScope } from '../../../shared/sync';

export type { SyncScope };

/**
 * What an entity's storage adapter actually needs: somewhere to send the sync hint.
 * Adapters read no permissions and no turn state, so they take this rather than the whole
 * `AssistantContext`. That lets an internal caller with no turn behind it (the system
 * prompt's entry block) pass an honest context instead of fabricating permissions it has no
 * business inventing. A full `AssistantContext` satisfies it.
 */
export type EntityContext = Pick<AssistantContext, 'broadcast'>;

/** `number` is for read-only fields (a count): no write path coerces one, and entity-ops refuses to try. */
export type FieldType = 'string' | 'text' | 'enum' | 'boolean' | 'number';

/** One field on an entity: described once, consumed everywhere. */
export interface FieldDef {
	key: string;
	label: string;
	/** Model-facing description of what the field holds. */
	describe: string;
	type: FieldType;
	enumValues?: readonly string[];
	/** Whether the assistant may write it. Read-only fields (role, chatId) are reported but never edited. */
	editable: boolean;
	/** Surfaced in compact find/list results (vs only in a full read_entity). */
	summary?: boolean;
	/** Included in the substring-search haystack for find_entities. */
	searchable?: boolean;
}

export type FieldValue = string | number | boolean | null;

/** A uniform, storage-agnostic view of one record. */
export interface EntityFlat {
	id: string;
	kind: string;
	/** Field values keyed by FieldDef.key. */
	fields: Record<string, FieldValue>;
	/** Human label for UI lines + delete confirmation ("Aria", "user message"). */
	title: string;
}

/**
 * Per-write options one entity may honour and the rest ignore, the same shape `ListScope`
 * takes for reads. Kept off the field patch on purpose: these describe HOW to record the
 * write, not what to write.
 */
export interface WriteOptions {
	/** Messages only: record the content change as a MINOR edit (`minor_edited_at` instead of
	 *  `edited_at`), so the chat-memory summary covering that turn survives. It is an
	 *  assertion that the turn still says the same thing, never something inferred from the
	 *  text (see architecture/memory.md coupling 8). */
	minor?: boolean;
}

/** Restricts a list() sweep; entities that can't honor a key ignore it. */
export interface ListScope {
	/** Confine messages to one chat (skips scanning every chat). */
	chatId?: string;
}

/** Generic operations an addressable entity exposes to the assistant. */
export interface EntityOps {
	create: boolean;
	edit: boolean;
	delete: boolean;
	bulk: boolean;
}

/**
 * An entity definition. `addressable` entities implement the read/write adapter and
 * are reachable through the generic entity tools; non-addressable ones (lorebook,
 * chat) contribute only their field metadata to the data-model description while
 * their actions live in dedicated capabilities.
 */
export interface EntityDef {
	kind: string;
	/** One-line, model-facing summary of the entity. */
	describe: string;
	fields: FieldDef[];
	addressable: boolean;
	/** Extra prose appended to this entity's data-model line (e.g. lorebook injection). */
	note?: string;
	/** Capability family (groups.ts id) this KIND rides: while the family is off, the generic
	 *  reads refuse the kind and the data model stops advertising it. Absent = always on. */
	group?: string;

	// --- adapter (addressable entities only) ---
	ops?: EntityOps;
	/** Live-sync scope a successful mutation broadcasts so every client refreshes. The
	 *  vocabulary is the app-wide one (shared/sync.ts); the assistant only ever reaches
	 *  the story-workspace half of it: it never writes drafts, input history or presets. */
	scope?: SyncScope;
	read?(id: string, ctx: EntityContext): EntityFlat | null;
	list?(ctx: EntityContext, scope: ListScope): EntityFlat[];
	create?(fields: Record<string, unknown>, ctx: EntityContext): EntityFlat;
	/** Persist a validated patch of editable fields to an existing record. */
	write?(id: string, patch: Record<string, FieldValue>, ctx: EntityContext, opts?: WriteOptions): void;
	remove?(id: string, opts: { scope?: string }, ctx: EntityContext): void;
	/**
	 * The exact string a destructive `confirm` must equal before a delete proceeds:
	 * the entry's name for library entries, a fixed sentinel for ids whose name is
	 * not unique (messages). Single source of truth for the confirmation gate.
	 */
	confirmToken?(flat: EntityFlat): string;
}

export type ParamType = 'string' | 'integer' | 'boolean' | 'object' | 'array';

/** A declarative tool parameter; the schema generator turns these into JSON Schema. */
export interface ParamDef {
	name: string;
	type: ParamType;
	describe: string;
	required?: boolean;
	enum?: readonly string[];
	minimum?: number;
	maximum?: number;
	/** For `object` params: a free-form map (where/set/fields) with arbitrary keys. */
	freeform?: boolean;
	/**
	 * For `array` params: the JSON Schema of one element, written out. A structured element
	 * is the one param shape prose cannot carry: a malformed one is a malformed card, and
	 * the model has no way to know the shape it is guessing at.
	 */
	items?: Record<string, unknown>;
}

/** One tool the assistant can call. The registry derives everything else from this. */
export interface Capability {
	name: string;
	/** Model-facing description shown in the tool list. */
	summary: string;
	params: ParamDef[];
	/**
	 * The LOWEST rung any call of this tool can sit on (server/assistant/types.ts). It is the
	 * one thing the approval modes read: Manual asks from `write` up, Auto from `delete` up.
	 * `read` also means "changes nothing", so it is what the contracts net checks a missing
	 * `preview` against.
	 */
	risk: RiskClass;
	/**
	 * This tool's rung depends on its ARGUMENTS: a version action only deletes when it says
	 * `delete`, a portrait write only takes something away when it replaces one. The cheap
	 * name-only pass treats these as capable of reaching `delete`, so they are priced by
	 * `preview` and judged on what it says. Without it that pass would wave a permanent
	 * variant delete straight through in Auto.
	 */
	escalates?: boolean;
	/**
	 * No per-capability gate: consent is granted by FAMILY (registry/groups.ts), and a tool
	 * belonging to none is a registration bug that `buildTools`/`dispatch` throw on. A closed
	 * family is enforced twice (the tool leaves the list, and dispatch refuses it even if the
	 * model somehow calls it), and the two guards deliberately ask DIFFERENT sets: the list
	 * uses the session's frozen one, dispatch the effective one, so switching a family off
	 * mid-session bites at once without disturbing the tool list (and with it the prompt
	 * cache). See server/assistant/sessionSettings.ts.
	 */
	run(args: Record<string, unknown>, ctx: AssistantContext): ToolOutcome | Promise<ToolOutcome>;
	/**
	 * What this call WOULD do, for the approval card: the same derivations the result
	 * carries afterwards (a diff, a memory price, a branch warning, a row count), asked
	 * before anything is written. Must not mutate, and may throw: a preview that fails is
	 * reported on the card and the call fails identically when it runs.
	 */
	preview?(args: Record<string, unknown>, ctx: AssistantContext): ApprovalPreview;
}
