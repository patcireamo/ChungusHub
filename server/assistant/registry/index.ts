/**
 * The capability registry's public surface. The assistant loop talks only to this file:
 * it asks for the tool list and dispatches calls by name. Everything is derived from
 * CAPABILITIES + ENTITIES + the group table, so extending the assistant never touches the loop.
 */
import type { LLMToolDef } from '../../llm/types';
import { raiseRisk } from '../types';
import type { ApprovalCall, ApprovalNote, AssistantContext, AssistantPermissions, RiskClass, ToolOutcome } from '../types';
import { CAPABILITIES } from './capabilities';
import { CAPABILITY_GROUPS, groupOfTool } from './groups';
import { toolFor, describeDataModel, estimateToolTokens } from './schema';

const BY_NAME = new Map(CAPABILITIES.map((c) => [c.name, c]));

/**
 * Whether this consent set reaches a tool, decided by the one thing that decides it: the
 * family the tool belongs to (groups.ts). A tool in NO family is a registration bug, not a
 * permission question: it fails loudly here rather than becoming quietly ungatable.
 */
function allowed(name: string, permissions: AssistantPermissions): boolean {
	const group = groupOfTool(name);
	if (!group) throw new Error(`Capability "${name}" belongs to no group. Add it to a family in registry/groups.ts.`);
	return permissions.groups.has(group.id);
}

/** The OpenAI tool list handed to the model: one entry per available capability.
 *  Takes the session's FROZEN permissions: the list is part of the cached request
 *  prefix, so it must not move when the user touches a setting mid-session. */
export function buildTools(permissions: AssistantPermissions): LLMToolDef[] {
	return CAPABILITIES.filter((c) => allowed(c.name, permissions)).map(toolFor);
}

/** Tools this turn OFFERED (frozen set) that the live set now refuses: what the model
 *  must be told about when the user switches a family off mid-session. Derived, so a new
 *  capability is covered without touching the loop. */
export function revokedToolNames(offered: AssistantPermissions, effective: AssistantPermissions): string[] {
	return CAPABILITIES.filter((c) => allowed(c.name, offered) && !allowed(c.name, effective)).map((c) => c.name);
}

/** Run one tool call, turning any thrown ToolError into a loud, model-readable failure. */
export async function dispatch(name: string, rawArgs: unknown, ctx: AssistantContext): Promise<ToolOutcome> {
	const cap = BY_NAME.get(name);
	if (!cap) {
		const msg = `Unknown tool: ${name}`;
		return { uiResult: { type: name, label: name, error: msg }, toolMessage: JSON.stringify({ ok: false, error: msg }) };
	}
	// Second guard behind the tool-list filter, and the one that makes a WITHDRAWN family
	// bite immediately: it asks the effective set, which the loop has already intersected
	// with the live setting.
	if (!allowed(name, ctx.permissions)) {
		const msg = `The tool "${name}" is switched off. The user disabled its capability group in Assistant Settings → Capabilities.`;
		return { uiResult: { type: name, label: name, error: msg }, toolMessage: JSON.stringify({ ok: false, error: msg }) };
	}
	const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
	try {
		// Awaited, never returned bare: a capability that waits (ask_user waits on the user)
		// rejects after this block has exited, and a plain `return` would let that rejection
		// past the catch below, killing the whole turn instead of failing one call.
		return await cap.run(args, ctx);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return { uiResult: { type: name, label: cap.summary.slice(0, 40), error: message }, toolMessage: JSON.stringify({ ok: false, error: message }) };
	}
}

/** How much of one argument the card shows before the diff (or the tool itself) takes over. */
const ARG_PREVIEW_CHARS = 60;

/** Arguments that say nothing to a person: an id they cannot use, and the confirm token, which
 *  is an anti-accident handshake between the model and the tool rather than a decision input. */
function readableArg(key: string): boolean {
	return key !== 'confirm' && key !== 'id' && !key.endsWith('Id');
}

/**
 * The arguments, compact enough to scan: the floor for a row whose preview could not speak
 * (a tool switched off mid-turn, or one whose preview threw). Long values are clipped, and ids
 * are left out entirely: the one identifier a human cannot act on has no business being the
 * most prominent thing on the card.
 */
function argNotes(args: Record<string, unknown>): ApprovalNote[] {
	const parts = Object.entries(args)
		.filter(([key]) => readableArg(key))
		.map(([key, value]) => {
			const shown = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
			const clipped = shown.length > ARG_PREVIEW_CHARS ? `${shown.slice(0, ARG_PREVIEW_CHARS)}…` : shown;
			return `${key}: ${clipped.replace(/\s+/g, ' ')}`;
		});
	return parts.length ? [{ text: parts.join(' · ') }] : [];
}

/** A tool name as a sentence, for the rows nothing predicts: "read_chat_messages" is the
 *  developer's name for it, and the mono chip beside the row still carries that one. */
function humanizeToolName(name: string): string {
	const words = name.split('_').join(' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One pending call as the approval card renders it. Everything specific comes from the
 * capability's own `preview`, the same derivations its result carries afterwards. A tool that
 * predicts nothing falls back to its name and its arguments; a tool that predicts is trusted
 * completely, and its arguments are NOT appended, because a row that has already said "Turn
 * #42 · Aria" gains nothing from repeating the raw call underneath it.
 */
export function previewCall(index: number, name: string, rawArgs: unknown, ctx: AssistantContext): ApprovalCall {
	const cap = BY_NAME.get(name);
	const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
	const base: ApprovalCall = { index, tool: name, label: humanizeToolName(name), notes: argNotes(args), risk: cap?.risk ?? 'delete' };
	// A call `dispatch` is about to refuse must not be described as though it will happen:
	// the card would be asking the user to approve something that cannot run. Same guard,
	// same effective set, so the two can never disagree about which tools are live.
	if (!cap || !allowed(name, ctx.permissions)) {
		return { ...base, notes: [{ text: 'This tool is switched off and will not run.', warn: true }, ...base.notes] };
	}
	if (!cap.preview) return base;
	try {
		const extra = cap.preview(args, ctx);
		return {
			...base,
			...(extra.label ? { label: extra.label } : {}),
			notes: extra.notes ?? [],
			...(extra.act ? { act: extra.act } : {}),
			...(extra.actNotes?.length ? { actNotes: extra.actNotes } : {}),
			...(extra.within ? { within: extra.within } : {}),
			...(extra.at !== undefined ? { at: extra.at } : {}),
			...(extra.target ? { target: extra.target } : {}),
			...(extra.diff ? { diff: extra.diff } : {}),
			...(extra.rows !== undefined ? { rows: extra.rows } : {}),
			// A preview may only RAISE the rung: a capability declared `delete` is asked about
			// whatever its arguments turn out to be.
			risk: extra.risk ? raiseRisk(base.risk, extra.risk) : base.risk
		};
	} catch (e) {
		// A preview that throws must not take the turn with it: the card says what it can,
		// and the call fails with this same error the moment it is approved and runs.
		return { ...base, notes: [{ text: `Could not preview: ${e instanceof Error ? e.message : String(e)}`, warn: true }, ...base.notes] };
	}
}

/**
 * The highest rung a call of this tool could possibly land on: its declared floor, or `delete`
 * when only its arguments say (`escalates`). This is what the loop's cheap name-only pass asks,
 * so a call that MIGHT take something away is priced instead of waved through; the preview then
 * reports where it actually landed. An unknown tool answers `delete`: dispatch is about to
 * refuse it anyway, and guessing low is the one direction that could run something unseen.
 */
export function riskCeiling(tool: string): RiskClass {
	const cap = BY_NAME.get(tool);
	if (!cap) return 'delete';
	return cap.escalates ? 'delete' : cap.risk;
}

/**
 * Estimated prompt cost of each family's tool schemas, keyed by group id: what the
 * Capabilities page prices a switch at. Measured with the estimator the loop's context
 * budget uses, so the page and the budget never quote different numbers.
 */
export function capabilityGroupCosts(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const group of CAPABILITY_GROUPS) {
		out[group.id] = estimateToolTokens(CAPABILITIES.filter((c) => group.tools.includes(c.name)).map(toolFor));
	}
	return out;
}

export { describeDataModel };
export { getEntity } from './entities';
export { branchStamp, chatLorebooks } from './chat-reads';
// Read-parity helpers for the loop's workspace note: a full entry block must hand over
// what read_entity hands over, or "treat it as read" claims more than was sent.
export { readEntryImages } from './images';
export { versionSummary } from './versions';
