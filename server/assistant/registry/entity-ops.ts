/**
 * Generic entity capabilities: read/find/create/edit/set/update/delete, working
 * uniformly over every addressable entity, driven entirely by the field metadata in
 * entities.ts. A new entity field is reachable here for free.
 *
 * The bulk `update_entities` is what makes cross-cutting fixes (e.g. attribute every
 * orphaned "You" message to a persona) a single call instead of bespoke code.
 */
import { serverDb } from '../../db';
import type { ApprovalNote, ApprovalPreview, ApprovalTarget, AssistantContext, AssistantToolResult } from '../types';
import type { Capability, EntityDef, EntityFlat, FieldDef, FieldValue } from './types';
import { ADDRESSABLE_KINDS, CREATABLE_KINDS, getAddressable, editableField } from './entities';
import { CAPABILITY_GROUPS } from './groups';
import { isTracked, stampGone, stampState } from '../freshness';
import { ToolError, str, requireStr, clampInt, applyFindReplace, assertClaimFresh, ok } from './util';
import { readEntryImages } from './images';
import { versionSummary } from './versions';
import {
	describeMessage,
	memoryCostLabel,
	memoryCostOfMessageChange,
	offPathMessageCount,
	offPathWarning,
	OFF_PATH_NOTE,
	type MemoryCost
} from './chat-reads';

// ===== shared helpers =====

/** Coerce + validate a raw argument into a field's stored value. */
function coerceFieldValue(field: FieldDef, value: unknown): FieldValue {
	if (field.type === 'number') throw new ToolError(`Field "${field.key}" is a count and cannot be written.`);
	if (field.type === 'boolean') {
		if (typeof value === 'boolean') return value;
		if (value === 'true') return true;
		if (value === 'false') return false;
		throw new ToolError(`Field "${field.key}" expects true/false.`);
	}
	if (field.type === 'enum') {
		const v = str(value);
		if (!field.enumValues?.includes(v)) {
			throw new ToolError(`Field "${field.key}" must be one of: ${field.enumValues?.join(', ')}.`);
		}
		return v;
	}
	// string / text: accept a scalar, but never silently stringify an object/array into
	// "[object Object]" or "a,b": a malformed argument fails loud (project rule).
	if (value != null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
		throw new ToolError(`Field "${field.key}" expects a string${Array.isArray(value) ? ', got an array' : ', got an object'}.`);
	}
	return value == null ? '' : String(value);
}

/** Does a flat record satisfy every clause of a where-filter? */
function matchesWhere(flat: EntityFlat, where: Record<string, unknown>): boolean {
	for (const [key, expected] of Object.entries(where)) {
		const actual = flat.fields[key];
		if (expected === null) {
			if (actual !== null && actual !== '') return false;
		} else if (typeof expected === 'boolean') {
			if (Boolean(actual) !== expected) return false;
		} else if (String(actual ?? '') !== String(expected)) {
			return false;
		}
	}
	return true;
}

/** Reject where-keys that aren't real fields, so a typo fails loud instead of matching nothing. */
function assertWhereKeys(def: EntityDef, where: Record<string, unknown>): void {
	for (const key of Object.keys(where)) {
		if (!def.fields.some((f) => f.key === key)) {
			throw new ToolError(`"${key}" is not a field of ${def.kind}. Fields: ${def.fields.map((f) => f.key).join(', ')}.`);
		}
	}
}

function asObject(v: unknown, label: string): Record<string, unknown> {
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ToolError(`\`${label}\` must be an object.`);
	return v as Record<string, unknown>;
}

/** A compact projection of a flat record for find/list results. */
function summarize(def: EntityDef, flat: EntityFlat): Record<string, unknown> {
	const out: Record<string, unknown> = { id: flat.id };
	for (const f of def.fields) {
		if (f.summary) out[f.key] = flat.fields[f.key];
	}
	return out;
}

/** Read a flat record or throw a uniform not-found error. */
function readOrThrow(def: EntityDef, id: string, ctx: AssistantContext): EntityFlat {
	const flat = def.read?.(id, ctx) ?? null;
	if (!flat) throw new ToolError(`No ${def.kind} with id "${id}". Use find_entities to locate the right id.`);
	return flat;
}

/**
 * A kind may ride a capability family (EntityDef.group): the setting catalog belongs to
 * Navigation, so switching that family off takes the KIND away from the generic reads
 * (not just the `navigate` tool), while schema.ts drops it from the data model. Asked with
 * the same effective set dispatch gates tools with, so the two can never disagree.
 */
function requireKindEnabled(def: EntityDef, ctx: AssistantContext): void {
	if (!def.group || ctx.permissions.groups.has(def.group)) return;
	const label = CAPABILITY_GROUPS.find((g) => g.id === def.group)?.label ?? def.group;
	throw new ToolError(`The "${def.kind}" kind belongs to the ${label} family, which is switched off. The user can turn it on in Assistant Settings → Capabilities.`);
}

/**
 * The branch check a single-target message write owes the user, computed BEFORE the write
 * (a delete leaves nothing to ask afterwards). Only messages have branches; every other
 * kind returns nothing and costs nothing. See chat-reads.ts `offPathWarning`.
 */
function branchWarningFor(def: EntityDef, id: string): string | undefined {
	return def.kind === 'message' ? offPathWarning(id) : undefined;
}

/** Both places a branch warning has to land: the panel's row and the model's result. */
function withBranchWarning<T extends AssistantToolResult>(result: T, warning: string | undefined): T {
	if (warning) result.label = `${result.label} · off the active branch`;
	return result;
}

/**
 * The two doors a message rewrite can go through. Two tools offer the flag, and the criterion
 * is stated ONCE in full: `edit_entity` is the surgical edit the model should reach for first,
 * so it carries the rule and the example, and `set_entity` points at it. Both schemas sit in
 * the same list, and paying for the paragraph twice buys nothing but the tokens.
 */
const MINOR_DESCRIBE =
	"Messages only. true records a QUIET save: the memory summary over that turn stands and nothing is re-read. The test is meaning, not size: typos, grammar, punctuation, rephrasing and flow are quiet; anything that changes what happened is not, however few characters it moves (a name from Mahmut to Mehmet is one word and NOT quiet). Default false; unsure means false.";
const MINOR_DESCRIBE_SHORT =
	"Messages only. The quiet-save flag, judged by MEANING and not size: typos, grammar, punctuation, rephrasing and flow are quiet; anything that changes what happened is not. edit_entity's `minor` carries the full rule and its example. Default false; unsure means false.";

/**
 * The `minor` argument, read only where it means anything. A quiet save is the CALLER's
 * assertion that the turn still says the same thing (architecture/memory.md coupling 8), so
 * it is refused outright on anything but a message's content: offering it elsewhere would
 * invite the model to believe it buys something.
 */
function quietSave(def: EntityDef, field: FieldDef, raw: unknown): boolean {
	if (raw === undefined || raw === null || raw === false || raw === 'false') return false;
	if (raw !== true && raw !== 'true') throw new ToolError('`minor` expects true/false.');
	if (def.kind !== 'message' || field.key !== 'content') {
		throw new ToolError('`minor` applies only to the content of a message: it is the quiet-save flag chat memory reads, and nothing else has summaries over it.');
	}
	return true;
}

/** What this write costs the chat's memory, for the one write that can cost anything. */
function memoryCostFor(def: EntityDef, field: FieldDef, id: string): MemoryCost | null {
	return def.kind === 'message' && field.key === 'content' ? memoryCostOfMessageChange(id, 'edit') : null;
}

/** Which door a message rewrite went through, said in the model-facing result. Only ever
 *  present on a message content write, where the choice exists. */
function saveNote(def: EntityDef, field: FieldDef, minor: boolean): Record<string, unknown> {
	if (def.kind !== 'message' || field.key !== 'content') return {};
	return {
		save: minor ? 'quiet' : 'normal',
		saveNote: minor
			? 'Recorded as a quiet save: the memory summary over this turn stands, so nothing is re-read. If this actually changed what happened, correct the summary too with edit_memory_episode.'
			: 'Recorded as an ordinary edit: any summary covering this turn is now out of date and the engine will re-read it. Do not also rewrite that summary: the re-read throws it away.'
	};
}

/** The memory price of touching one turn, folded into both halves of the result. A quiet
 *  save costs nothing by construction, so it is never priced. */
function withMemoryCost<T extends AssistantToolResult>(result: T, cost: MemoryCost | null): T {
	if (cost) result.label = `${result.label} · ${memoryCostLabel(cost)}`;
	return result;
}

/**
 * The freshness claims a read of this entity carries (freshness.ts): exactly what it
 * handed the model, nothing wider. Untracked kinds (setting, skill) claim nothing.
 */
function readStamps(def: EntityDef, id: string): Record<string, unknown> {
	return isTracked(def.kind) ? stampState([def.kind, id]) : {};
}

/**
 * The freshness claims a WRITE to this entity carries. A message write moves its chat's
 * rows and its memory answer with it, so it re-claims all three. Otherwise the next
 * turn would announce the assistant's own edit back at it as a change it has to go
 * re-read. `chatId` rides in from the pre-write read (a deleted row has none to ask).
 */
function writeStamps(def: EntityDef, id: string, chatId: string): Record<string, unknown> {
	if (!isTracked(def.kind)) return {};
	if (def.kind === 'message' && chatId) return stampState(['message', id], ['chat', chatId], ['memory', chatId]);
	return stampState([def.kind, id]);
}

// ===== approval previews =====
//
// The card in front of the user is built from the SAME derivations the result carries
// afterwards (one branch check, one memory pricing, one save-mode rule), asked before
// anything is written. A second implementation here would be a second answer to "what will
// this cost", and the two would drift the first time either rule changed.

/** The kinds the app can actually take the user to: a preview target for anything else
 *  would render an arrow that leads nowhere. */
const NAVIGABLE_KINDS = new Set(['character', 'persona', 'message', 'lorebook', 'chat']);
function targetOf(kind: string, id: string): ApprovalTarget | undefined {
	return NAVIGABLE_KINDS.has(kind) ? ({ kind, id } as ApprovalTarget) : undefined;
}

/**
 * Everything a single-target write owes the card except the change itself: which thing it
 * lands on, which deed it is, what the deed costs, and what is true of this row alone.
 *
 * A message has no name ("user message" identifies nothing on a card holding twenty of them),
 * so it is named by where it sits and who said it. Everything else is named by its own title.
 * The two note lists are split by what they belong to: the save door is a property of the DEED
 * (every row repeating it says the same thing, so the card says it once), while the memory
 * price and the branch warning are this row's own.
 */
function writePlacement(verb: string, def: EntityDef, id: string, flat: EntityFlat, field: FieldDef, minor: boolean): ApprovalPreview {
	const notes: ApprovalNote[] = [];
	const actNotes: ApprovalNote[] = [];
	const onContent = def.kind === 'message' && field.key === 'content';
	if (onContent) {
		actNotes.push(
			minor
				? { text: 'Quiet save: the memory summary over this turn stands, and nothing is re-read.' }
				: { text: 'Ordinary edit: any summary covering this turn goes out of date and the engine re-reads it.' }
		);
	}
	const cost = minor ? null : memoryCostFor(def, field, id);
	if (cost) for (const line of cost.says) notes.push({ text: line, warn: true });

	const message = def.kind === 'message' ? describeMessage(id) : null;
	if (message?.offPath) notes.push({ text: OFF_PATH_NOTE, warn: true });
	return {
		label: message ? message.line : flat.title,
		act: `${verb} ${onContent ? 'message' : field.label.toLowerCase()}${minor ? ' (quiet save)' : ''}`,
		...(actNotes.length ? { actNotes } : {}),
		...(message ? { within: message.chatTitle, ...(message.seq ? { at: message.seq } : {}) } : {}),
		...(targetOf(def.kind, id) ? { target: targetOf(def.kind, id) } : {}),
		notes
	};
}

/** The shared head of every single-target preview: resolve the target or fail loudly, the
 *  same way `run` would a moment later. */
function previewTarget(args: Record<string, unknown>, ctx: AssistantContext): { def: EntityDef; id: string; flat: EntityFlat } {
	const def = getAddressable(str(args.kind));
	const id = str(args.id).trim();
	return { def, id, flat: readOrThrow(def, id, ctx) };
}

/**
 * Everything a bulk sweep settles before it writes anything: the kind, the coerced patch, how
 * many rows match, which of them the cap lets through, and how many sit off the active branch.
 *
 * `run` and `preview` share it so the card can never promise a sweep the call would refuse.
 * Every throw here is a refusal the model has to hear either way: describing "Update 847
 * messages" and then rejecting the same call for an empty `where` would make the card a liar
 * about the one number it exists to state.
 */
function bulkPlan(
	args: Record<string, unknown>,
	ctx: AssistantContext
): { def: EntityDef; patch: Record<string, FieldValue>; matched: number; slice: EntityFlat[]; offBranch: number } {
	const def = getAddressable(str(args.kind));
	if (!def.ops?.bulk || !def.write) throw new ToolError(`A ${def.kind} does not support bulk update.`);
	const where = asObject(args.where, 'where');
	if (!Object.keys(where).length) throw new ToolError('update_entities requires a non-empty `where`: it will not match every row blindly.');
	assertWhereKeys(def, where);
	const setRaw = asObject(args.set, 'set');
	if (!Object.keys(setRaw).length) throw new ToolError('update_entities requires a non-empty `set`.');
	const patch: Record<string, FieldValue> = {};
	for (const [key, value] of Object.entries(setRaw)) {
		const field = editableField(def, key);
		// Bulk overwriting long-form prose across many rows is a data-loss footgun
		// (e.g. blanking every message body). Bulk is for short attribution/flag fields.
		if (field.type === 'text') {
			throw new ToolError(`Bulk update can't overwrite the free-text field "${field.key}". Edit it one id at a time with edit_entity/set_entity.`);
		}
		patch[field.key] = coerceFieldValue(field, value);
	}
	const cap = clampInt(args.limit, 1, 500, 200);
	const chatId = str(args.chatId).trim() || undefined;
	const candidates = (def.list?.(ctx, { chatId }) ?? []).filter((flat) => matchesWhere(flat, where));
	const slice = candidates.slice(0, cap);
	// A bulk message sweep can reach branches the user is not reading. Those rows are
	// counted before the write, since nothing on their screen would show them changing.
	const offBranch = def.kind === 'message' ? offPathMessageCount(slice.map((f) => ({ id: f.id, chatId: String(f.fields.chatId ?? '') }))) : 0;
	return { def, patch, matched: candidates.length, slice, offBranch };
}

// ===== the seven generic capabilities =====

export const readEntity: Capability = {
	name: 'read_entity',
	summary: 'Read every field of one entity by id: any addressable kind (character, persona, message, lorebook, setting, skill). Required before editing anything you have not read in this conversation, or that a state note has since named as changed.',
	risk: 'read',
	params: [
		{ name: 'kind', type: 'string', describe: 'Entity kind.', required: true, enum: ADDRESSABLE_KINDS },
		{ name: 'id', type: 'string', describe: 'The id, taken verbatim from a prior tool result.', required: true }
	],
	run(args, ctx) {
		const def = getAddressable(str(args.kind));
		requireKindEnabled(def, ctx);
		const flat = readOrThrow(def, str(args.id).trim(), ctx);
		// A character/persona read also states what art the entry owns (always, since knowing a
		// portrait exists is what makes it nameable as a source later) and shows the portrait
		// itself when image access and a vision model allow it, with no separate view call.
		const art = def.kind === 'character' || def.kind === 'persona' ? readEntryImages(flat.id, ctx) : null;
		// A versioned character reads as its ACTIVE variant, which is silently misleading
		// unless the read says so: without the roster the assistant treats a card with three
		// variants as the only card there is. Naming them is information, not an invitation:
		// the fields still belong to the active one and the version tools stay opt-in.
		const versions = def.kind === 'character' ? versionSummary(flat.id) : {};
		return {
			...ok(
				{ type: 'read_entity', kind: def.kind, id: flat.id, name: flat.title, label: `Read ${def.kind}: ${flat.title}` },
				{ kind: def.kind, id: flat.id, fields: flat.fields, ...versions, ...(art ? { images: art.images } : {}), ...readStamps(def, flat.id) }
			),
			...(art?.paths.length ? { injectImages: art.paths } : {})
		};
	}
};

export const findEntities: Capability = {
	name: 'find_entities',
	summary: 'List or search entities of one kind: the way to discover ids, and to preview what a bulk update would touch. Filter by exact field values with `where`, by substring with `query`, or neither to list the kind.',
	risk: 'read',
	params: [
		{ name: 'kind', type: 'string', describe: 'Entity kind to list.', required: true, enum: ADDRESSABLE_KINDS },
		{ name: 'where', type: 'object', freeform: true, describe: 'Exact field-match filter, e.g. {"personaId": null, "role": "user"}. null matches empty/unset.' },
		{ name: 'query', type: 'string', describe: 'Case-insensitive substring matched across the kind\'s searchable fields.' },
		{ name: 'chatId', type: 'string', describe: 'For messages: confine the sweep to one chat (omit to scan every chat).' },
		{
			name: 'limit',
			type: 'integer',
			describe: 'How many to return (default 20). No maximum: pass the reported match count to get every match at once.',
			minimum: 1
		},
		{ name: 'offset', type: 'integer', describe: 'Skip this many matches, to page through a long result set.', minimum: 0 }
	],
	run(args, ctx) {
		const def = getAddressable(str(args.kind));
		requireKindEnabled(def, ctx);
		const where = args.where != null ? asObject(args.where, 'where') : {};
		assertWhereKeys(def, where);
		const query = str(args.query).trim().toLowerCase();
		const chatId = str(args.chatId).trim() || undefined;

		const searchable = def.fields.filter((f) => f.searchable).map((f) => f.key);
		let rows = def.list?.(ctx, { chatId }) ?? [];
		const total = rows.length;
		rows = rows.filter((flat) => matchesWhere(flat, where));
		if (query) {
			rows = rows.filter((flat) => searchable.some((k) => String(flat.fields[k] ?? '').toLowerCase().includes(query)));
		}
		const matched = rows.length;
		// Clamped to the match count, never to a constant: the default keeps an ordinary
		// lookup small, but "go through all 120 of them" has to remain a call the assistant
		// can actually make.
		const offset = clampInt(args.offset, 0, matched, 0);
		const limit = clampInt(args.limit, 1, Math.max(matched, 1), 20);
		const results = rows.slice(offset, offset + limit).map((flat) => summarize(def, flat));
		const shownTo = offset + results.length;
		const remaining = matched - shownTo;
		const matching = query ? ` matching "${args.query}"` : '';
		return ok(
			{
				type: 'find_entities',
				label:
					results.length === matched
						? `Found ${matched} ${def.kind}${matched === 1 ? '' : 's'}${matching}`
						: `Found ${matched} ${def.kind}s${matching}: returned ${offset + 1} to ${shownTo}`
			},
			{
				kind: def.kind,
				scanned: total,
				matched,
				offset,
				returned: results.length,
				results,
				...(remaining > 0
					? {
							note: `${remaining} more match${remaining === 1 ? '' : 'es'} not returned. Pass offset:${shownTo} for the next page, or limit:${matched} to get them all at once.`
						}
					: {})
			}
		);
	}
};

export const createEntity: Capability = {
	name: 'create_entity',
	summary: 'Create a character, persona, or lorebook, populating any fields in this one call. For a persona fill only name + description. Messages cannot be created this way.',
	risk: 'write',
	params: [
		{ name: 'kind', type: 'string', describe: 'What to create.', required: true, enum: CREATABLE_KINDS },
		{ name: 'fields', type: 'object', freeform: true, describe: 'Field values keyed by field name, e.g. {"name": "Aria", "description": "..."}.', required: true }
	],
	run(args, ctx) {
		const def = getAddressable(str(args.kind));
		if (!def.ops?.create || !def.create) throw new ToolError(`A ${def.kind} cannot be created with create_entity.`);
		const fields = asObject(args.fields, 'fields');
		const editableKeys = def.fields.filter((f) => f.editable).map((f) => f.key);
		const ignored = Object.keys(fields).filter((k) => !editableKeys.includes(k));
		// Validate every known field the same way the edit path does: a wrong-typed value
		// (tags as an array, personality as an object) fails loud here instead of being
		// silently blanked by the storage adapter's str() coercion.
		const clean: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(fields)) {
			if (!editableKeys.includes(key)) continue;
			clean[key] = coerceFieldValue(def.fields.find((f) => f.key === key)!, value);
		}
		const flat = def.create(clean, ctx);
		ctx.broadcast(def.scope!);
		return ok(
			{ type: 'create_entity', kind: def.kind, id: flat.id, name: flat.title, label: `Created ${def.kind}: ${flat.title}` },
			{ kind: def.kind, id: flat.id, ...(ignored.length ? { ignoredFields: ignored } : {}), ...readStamps(def, flat.id) }
		);
	},
	preview(args) {
		const def = getAddressable(str(args.kind));
		const fields = asObject(args.fields, 'fields');
		const editableKeys = def.fields.filter((f) => f.editable).map((f) => f.key);
		const filled = editableKeys.filter((k) => String(fields[k] ?? '').trim());
		return {
			act: `Create ${def.kind}`,
			label: str(fields.name).trim() || `(unnamed ${def.kind})`,
			// Nothing exists yet to look at, so what it arrives holding is the whole preview.
			notes: filled.length
				? [{ text: `Arrives with ${filled.join(', ')} filled in.` }]
				: [{ text: 'No fields given, so it would be created empty.', warn: true }]
		};
	}
};

export const editEntity: Capability = {
	name: 'edit_entity',
	summary: 'Replace an exact snippet inside one text field of an entity: the preferred, surgical edit. If the snippet is not found the tool fails; re-read and retry against fresh text.',
	risk: 'write',
	params: [
		{ name: 'kind', type: 'string', describe: 'Entity kind.', required: true, enum: ADDRESSABLE_KINDS },
		{ name: 'id', type: 'string', describe: 'Entity id.', required: true },
		{ name: 'field', type: 'string', describe: 'Which field to edit (must be a text field).', required: true },
		{ name: 'find', type: 'string', describe: 'Exact snippet to locate, copied verbatim and unique within the field.', required: true },
		{ name: 'replace', type: 'string', describe: 'Replacement text. Empty string deletes the snippet.', required: true },
		{ name: 'minor', type: 'boolean', describe: MINOR_DESCRIBE }
	],
	run(args, ctx) {
		const def = getAddressable(str(args.kind));
		if (!def.ops?.edit || !def.write) throw new ToolError(`A ${def.kind} cannot be edited.`);
		const id = str(args.id).trim();
		const field = editableField(def, str(args.field));
		if (field.type === 'boolean' || field.type === 'enum') throw new ToolError(`Field "${field.key}" is not free text: use set_entity to overwrite it.`);
		const flat = readOrThrow(def, id, ctx);
		const current = String(flat.fields[field.key] ?? '');
		// requireStr, not str(): a non-string `replace` coerced to '' would silently turn
		// "replace X with 21" into "delete X", exactly the silent damage we refuse.
		const next = applyFindReplace(current, requireStr(args.find, 'find'), requireStr(args.replace, 'replace'), `${flat.title}'s ${field.key}`);
		const minor = quietSave(def, field, args.minor);
		const offBranch = branchWarningFor(def, id);
		const cost = minor ? null : memoryCostFor(def, field, id);
		def.write(id, { [field.key]: next }, ctx, { minor });
		ctx.broadcast(def.scope!);
		return ok(
			withMemoryCost(
				withBranchWarning(
					{ type: 'edit_entity', kind: def.kind, id, name: flat.title, field: field.key, label: `Edited ${field.key} of ${flat.title}${minor ? ' (quiet save)' : ''}`, diff: { before: current, after: next, title: `${flat.title} · ${field.key}` } },
					offBranch
				),
				cost
			),
			{ kind: def.kind, id, field: field.key, ...saveNote(def, field, minor), ...(offBranch ? { branchWarning: offBranch } : {}), ...(cost ? { memory: cost } : {}), ...writeStamps(def, id, String(flat.fields.chatId ?? '')) }
		);
	},
	preview(args, ctx) {
		const { def, id, flat } = previewTarget(args, ctx);
		const field = editableField(def, str(args.field));
		const current = String(flat.fields[field.key] ?? '');
		const next = applyFindReplace(current, requireStr(args.find, 'find'), requireStr(args.replace, 'replace'), `${flat.title}'s ${field.key}`);
		const minor = quietSave(def, field, args.minor);
		const place = writePlacement('Edit', def, id, flat, field, minor);
		return { ...place, diff: { before: current, after: next, title: `${place.label} · ${field.key}` } };
	}
};

export const setEntity: Capability = {
	name: 'set_entity',
	summary: 'Overwrite one whole field of an entity with a new value. Use for a full replacement or for non-text fields; prefer edit_entity for small textual changes.',
	risk: 'write',
	params: [
		{ name: 'kind', type: 'string', describe: 'Entity kind.', required: true, enum: ADDRESSABLE_KINDS },
		{ name: 'id', type: 'string', describe: 'Entity id.', required: true },
		{ name: 'field', type: 'string', describe: 'Which field to overwrite.', required: true },
		{ name: 'value', type: 'string', describe: 'New value for the field. For boolean fields pass "true"/"false".', required: true },
		{ name: 'minor', type: 'boolean', describe: MINOR_DESCRIBE_SHORT }
	],
	run(args, ctx) {
		const def = getAddressable(str(args.kind));
		if (!def.ops?.edit || !def.write) throw new ToolError(`A ${def.kind} cannot be edited.`);
		const id = str(args.id).trim();
		const field = editableField(def, str(args.field));
		const flat = readOrThrow(def, id, ctx);
		// The whole-field overwrite is the one write that can silently erase a change landing
		// mid-turn (edit_entity's find/replace already fails loudly against moved text), so it
		// alone asks the claim gate before anything lands.
		assertClaimFresh(def.kind, id, flat.title, ctx.claims);
		const before = flat.fields[field.key];
		const next = coerceFieldValue(field, args.value);
		const minor = quietSave(def, field, args.minor);
		const offBranch = branchWarningFor(def, id);
		const cost = minor ? null : memoryCostFor(def, field, id);
		def.write(id, { [field.key]: next }, ctx, { minor });
		ctx.broadcast(def.scope!);
		const result: AssistantToolResult = { type: 'set_entity', kind: def.kind, id, name: flat.title, field: field.key, label: `Set ${field.key} of ${flat.title}${minor ? ' (quiet save)' : ''}` };
		if (field.type === 'text' || field.type === 'string') {
			result.diff = { before: String(before ?? ''), after: String(next ?? ''), title: `${flat.title} · ${field.key}` };
		}
		return ok(withMemoryCost(withBranchWarning(result, offBranch), cost), {
			kind: def.kind,
			id,
			field: field.key,
			...saveNote(def, field, minor),
			...(offBranch ? { branchWarning: offBranch } : {}),
			...(cost ? { memory: cost } : {}),
			...writeStamps(def, id, String(flat.fields.chatId ?? ''))
		});
	},
	preview(args, ctx) {
		const { def, id, flat } = previewTarget(args, ctx);
		// The same gate `run` asks, so a card never describes an overwrite the call refuses.
		assertClaimFresh(def.kind, id, flat.title, ctx.claims);
		const field = editableField(def, str(args.field));
		const minor = quietSave(def, field, args.minor);
		const next = coerceFieldValue(field, args.value);
		const preview: ApprovalPreview = writePlacement('Replace', def, id, flat, field, minor);
		if (field.type === 'text' || field.type === 'string') {
			preview.diff = { before: String(flat.fields[field.key] ?? ''), after: String(next ?? ''), title: `${preview.label} · ${field.key}` };
		} else {
			// A boolean/enum has no diff to read, so the new value has to be on the row itself.
			preview.notes = [...(preview.notes ?? []), { text: `New value: ${String(next)}` }];
		}
		return preview;
	}
};

export const updateEntities: Capability = {
	name: 'update_entities',
	summary: 'Set one or more fields on EVERY entity matching a filter, in one call. e.g. attribute all unassigned user messages to a persona: kind "message", where {"personaId": null, "role": "user"}, set {"personaId": "<id>"}. Preview the match first with find_entities.',
	// A sweep is N writes, not a delete: it replaces values the card shows and the timeline
	// keeps a diff of, however many rows it reaches. Auto therefore lets it through, and the
	// `limit` param (500 hard cap) is what bounds it.
	risk: 'write',
	params: [
		{ name: 'kind', type: 'string', describe: 'Entity kind to update.', required: true, enum: ADDRESSABLE_KINDS },
		{ name: 'where', type: 'object', freeform: true, describe: 'Exact field-match filter selecting the rows. Must be non-empty. null matches empty/unset.', required: true },
		{ name: 'set', type: 'object', freeform: true, describe: 'Editable field values to write to every match.', required: true },
		{ name: 'chatId', type: 'string', describe: 'For messages: confine the sweep to one chat.' },
		{ name: 'limit', type: 'integer', describe: 'Safety cap on how many rows to touch (default 200, max 500).', minimum: 1, maximum: 500 }
	],
	run(args, ctx) {
		const { def, patch, matched, slice, offBranch } = bulkPlan(args, ctx);
		if (matched === 0) {
			return ok({ type: 'update_entities', label: `No ${def.kind} matched, nothing changed` }, { kind: def.kind, matched: 0, updated: 0 });
		}
		// Atomic: a per-row validation throw (e.g. personaId onto an assistant message)
		// rolls back EVERY row, so "failed" honestly means "nothing changed" instead of
		// leaving half the sweep written with no broadcast.
		serverDb.inTransaction(() => {
			for (const flat of slice) def.write!(flat.id, patch, ctx);
		});
		ctx.broadcast(def.scope!);
		// A message sweep re-claims the chats it touched: honest, because bulk writes only
		// the short non-text fields the model itself just set. Per-row claims from earlier
		// individual reads are deliberately left to go stale: the next turn's note says
		// those rows changed, which the sweep made true. Non-message sweeps re-claim
		// nothing for the same reason at row scale (500 stamps would be the note's cost
		// every turn), and the resulting self-note is the safe direction.
		const sweptChats = def.kind === 'message' ? [...new Set(slice.map((f) => String(f.fields.chatId ?? '')).filter(Boolean))] : [];
		const truncated = matched > slice.length;
		return ok(
			{
				type: 'update_entities',
				label: `Updated ${slice.length} ${def.kind}${slice.length === 1 ? '' : 's'}${truncated ? ` (capped from ${matched})` : ''}${offBranch ? `, ${offBranch} off the active branch` : ''}`
			},
			{
				kind: def.kind,
				matched,
				updated: slice.length,
				set: patch,
				...(offBranch
					? {
							branchWarning: `${offBranch} of the ${slice.length} updated message${slice.length === 1 ? '' : 's'} ${offBranch === 1 ? 'sits' : 'sit'} on branches the user is not reading: those rows changed, but nothing on their screen will show it. Say so.`
						}
					: {}),
				...(truncated ? { note: `Only the first ${slice.length} of ${matched} were updated (limit). Raise limit or narrow where, then call again for the rest.` } : {}),
				ids: slice.slice(0, 25).map((f) => f.id),
				...(sweptChats.length ? stampState(...sweptChats.map((c): [string, string] => ['chat', c])) : {})
			}
		);
	},
	preview(args, ctx) {
		const { def, patch, matched, slice, offBranch } = bulkPlan(args, ctx);
		const notes: ApprovalNote[] = [{ text: `Sets ${Object.keys(patch).join(', ')} on every match.` }];
		if (matched > slice.length) notes.push({ text: `${matched} match; the limit caps this call at ${slice.length}.` });
		if (offBranch) {
			notes.push({ text: `${offBranch} of them sit on branches you are not reading, so those rows change with nothing on screen to show it.`, warn: true });
		}
		return { label: `Update ${slice.length} ${def.kind}${slice.length === 1 ? '' : 's'}`, notes, rows: slice.length };
	}
};

export const deleteEntity: Capability = {
	name: 'delete_entity',
	summary: 'Delete an entity: permanently, with no undo, and only when the user asked for it in this conversation.',
	risk: 'delete',
	params: [
		{ name: 'kind', type: 'string', describe: 'Entity kind.', required: true, enum: ADDRESSABLE_KINDS },
		{ name: 'id', type: 'string', describe: 'Entity id.', required: true },
		{ name: 'confirm', type: 'string', describe: 'The entry\'s exact name (character/persona/lorebook) or the word "DELETE" (message). A mismatch is rejected.', required: true },
		{
			name: 'scope',
			type: 'string',
			describe:
				'Messages only: this_only (default) re-attaches the replies to the parent, with_descendants removes the whole subtree. this_only is REFUSED on a message that heads a branch and has replies below it, since re-parenting would merge them into the fork. Use with_descendants there, or delete the replies first.',
			enum: ['this_only', 'with_descendants']
		}
	],
	run(args, ctx) {
		const def = getAddressable(str(args.kind));
		if (!def.ops?.delete || !def.remove || !def.confirmToken) throw new ToolError(`A ${def.kind} cannot be deleted.`);
		const id = str(args.id).trim();
		const flat = readOrThrow(def, id, ctx);
		const token = def.confirmToken(flat);
		if (!token) throw new ToolError(`This ${def.kind} has no name to confirm against. Give it a name before deleting.`);
		if (str(args.confirm) !== token) {
			throw new ToolError(`delete_entity confirmation failed. \`confirm\` must equal "${token}" for this ${def.kind}; got "${str(args.confirm)}".`);
		}
		const scope = str(args.scope) === 'with_descendants' ? 'with_descendants' : 'this_only';
		// Both asked before the row is gone: afterwards there is no path to check it against
		// and no coverage left to price.
		const offBranch = branchWarningFor(def, id);
		const cost = def.kind === 'message' ? memoryCostOfMessageChange(id, scope === 'with_descendants' ? 'delete_subtree' : 'delete') : null;
		const chatId = def.kind === 'message' ? String(flat.fields.chatId ?? '') : '';
		def.remove(id, { scope }, ctx);
		ctx.broadcast(def.scope!);
		// The delete claims its own outcome: the row as gone, and (for a message) the
		// chat and memory it just changed, so the next turn never reports this delete
		// back to the model as a foreign change.
		const stamps = isTracked(def.kind)
			? { stateRevs: { ...stampGone(def.kind, id).stateRevs, ...(chatId ? stampState(['chat', chatId], ['memory', chatId]).stateRevs : {}) } }
			: {};
		return ok(
			withMemoryCost(withBranchWarning({ type: 'delete_entity', kind: def.kind, id, name: flat.title, label: `Deleted ${def.kind}: ${flat.title}` }, offBranch), cost),
			{ kind: def.kind, id, ...(def.kind === 'message' ? { scope } : {}), ...(offBranch ? { branchWarning: offBranch } : {}), ...(cost ? { memory: cost } : {}), ...stamps }
		);
	},
	preview(args, ctx) {
		const { def, id, flat } = previewTarget(args, ctx);
		// No "permanent, no undo" line anywhere here: NOTHING the assistant does can be undone,
		// so a sentence on every delete saying so is one the reader learns to skip. The row's
		// own mark carries it, and what is left is the part that differs between deletes.
		const target = targetOf(def.kind, id);
		if (def.kind !== 'message') return { act: `Delete ${def.kind}`, label: flat.title, ...(target ? { target } : {}) };

		const scope = str(args.scope) === 'with_descendants' ? 'with_descendants' : 'this_only';
		const notes: ApprovalNote[] = [];
		const message = describeMessage(id);
		if (message?.offPath) notes.push({ text: OFF_PATH_NOTE, warn: true });
		const cost = memoryCostOfMessageChange(id, scope === 'with_descendants' ? 'delete_subtree' : 'delete');
		if (cost) for (const line of cost.says) notes.push({ text: line, warn: true });
		return {
			act: scope === 'with_descendants' ? 'Delete message and its replies' : 'Delete message',
			actNotes: [{ text: scope === 'with_descendants' ? 'Takes the turn and everything below it.' : 'Takes the turn alone; its replies re-attach to the parent.' }],
			label: message?.line ?? flat.title,
			notes,
			...(target ? { target } : {}),
			...(message ? { within: message.chatTitle, ...(message.seq ? { at: message.seq } : {}) } : {}),
			// A message is what it says, so the text going away IS the preview, a diff to nothing.
			...(message ? { diff: { before: message.text, after: '', title: message.line } } : {})
		};
	}
};
