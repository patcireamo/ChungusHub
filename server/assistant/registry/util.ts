/**
 * Shared primitives for the capability registry: the loud failure type, small
 * coercion helpers, and the two write-time guards (the surgical find/replace used by
 * every text edit, and the claim gate every blind whole-value overwrite asks first).
 */
import { isTracked, stampState } from '../freshness';
import { claimKey } from '../freshness-core';
import type { AssistantToolResult, ToolOutcome } from '../types';

/** A tool failure the model should see and recover from (re-read, retry, ask). */
export class ToolError extends Error {}

export function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

/** A required string argument: anything else fails loud instead of coercing to ''. */
export function requireStr(v: unknown, label: string): string {
	if (typeof v !== 'string') {
		throw new ToolError(`\`${label}\` must be a string${Array.isArray(v) ? ', got an array' : v === null ? ', got null' : `, got ${typeof v}`}.`);
	}
	return v;
}

/** A keyword-list argument: accepts a comma-separated string OR an array of strings
 *  (reads return arrays, so models naturally echo both shapes). Anything else fails loud. */
export function strList(v: unknown, label: string): string[] {
	if (typeof v === 'string') {
		return v.split(',').map((t) => t.trim()).filter(Boolean);
	}
	if (Array.isArray(v) && v.every((t) => typeof t === 'string')) {
		return v.map((t) => t.trim()).filter(Boolean);
	}
	throw new ToolError(`\`${label}\` must be a comma-separated string or an array of strings.`);
}

/** A boolean argument: accepts true/false and the strings "true"/"false". Anything else fails loud. */
export function boolArg(v: unknown, label: string): boolean {
	if (typeof v === 'boolean') return v;
	if (v === 'true') return true;
	if (v === 'false') return false;
	throw new ToolError(`\`${label}\` must be true or false.`);
}

/** A whole-number setting inside its range: anything else fails loud, since a value clamped into
 *  range is one nobody asked for. Numeric strings are taken, as `boolArg` takes "true". */
export function intArg(v: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
	const n = typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
		const range = max === Number.MAX_SAFE_INTEGER ? `of at least ${min}` : `from ${min} to ${max}`;
		throw new ToolError(`\`${label}\` must be a whole number ${range}.`);
	}
	return n;
}

/** One of a fixed set of words, or a loud error naming the set. */
export function oneOf<T extends string>(v: unknown, label: string, values: readonly T[]): T {
	if (typeof v === 'string' && (values as readonly string[]).includes(v)) return v as T;
	throw new ToolError(`\`${label}\` must be one of: ${values.join(', ')}.`);
}

/** Parse + clamp an integer argument, falling back when absent/invalid. */
/** Pass as `clampInt`'s max for a read whose full size isn't known up front. Reads default
 *  to a small page but never carry a constant ceiling: one would leave the assistant unable
 *  to return everything at the moment the user asks for exactly that. Where the total IS
 *  known, clamp to it instead: same freedom, no absurd slice sizes. */
export const NO_CAP = Number.MAX_SAFE_INTEGER;

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** Split a comma-separated tag string into a clean array. */
export function splitTags(v: unknown): string[] {
	return str(v)
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
}

/** Replace the first occurrence of `find` in `text`; throws loudly if absent. */
export function applyFindReplace(text: string, find: string, replace: string, label: string): string {
	if (!find) throw new ToolError('`find` must be a non-empty snippet.');
	const idx = text.indexOf(find);
	if (idx === -1) {
		throw new ToolError(`Could not find that snippet in ${label}. Re-read it and copy the exact current text before editing.`);
	}
	return text.slice(0, idx) + replace + text.slice(idx + find.length);
}

/**
 * The claim gate a blind whole-value overwrite (set_entity, a greeting mutation) asks
 * before it writes: refuses when this conversation holds a claim for the target and the
 * workspace has since moved past it. The per-turn state note only covers motion up to the
 * turn's start, and a turn can run for minutes while the user keeps editing. Without
 * this gate, a value composed from the pre-edit read lands whole and silently erases the
 * user's change. No claim passes untouched (the model never read the thing; the prompt's
 * read-before-edit rule owns that case, never the tool), and an untracked kind carries no
 * claims at all, so the gate fires only on a genuine foreign change under a held claim.
 * Callers keep the ledger LIVE within the turn (loop.ts folds each result's stamps back
 * in as it lands), which is what lets the assistant's own re-stamping writes satisfy the
 * gate on its next call. Ask it from `run` AND `preview`, so the approval card shows the
 * same refusal the call would make.
 */
export function assertClaimFresh(kind: string, id: string, title: string, claims: ReadonlyMap<string, string> | undefined): void {
	if (!claims || !isTracked(kind)) return;
	const key = claimKey(kind, id);
	const claimed = claims.get(key);
	if (claimed === undefined) return;
	if (stampState([kind, id]).stateRevs[key] === claimed) return;
	throw new ToolError(
		`The ${kind} "${title}" changed in the workspace after you read it (not by you), so this write did NOT run: it would have overwritten that change. Re-read it, then redo the write against the current text.`
	);
}

/** Wrap a successful result: UI summary + the JSON the model reads next. */
export function ok(uiResult: AssistantToolResult, payload: Record<string, unknown>): ToolOutcome {
	return { uiResult, toolMessage: JSON.stringify({ ok: true, ...payload }) };
}
