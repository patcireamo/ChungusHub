/**
 * The pure half of the prompt hold: turning a held request into text a person can edit, and
 * turning their text back into messages that are safe to put on the wire.
 *
 * Every rejection NAMES what is wrong and which message it is in. A review whose whole job is
 * showing what will be sent cannot then send something the reader did not mean, so a shape
 * this layer does not recognise is refused rather than repaired by guessing: an unknown field
 * would ride along silently doing nothing, and a missing one would send a message the reader
 * never saw.
 *
 * Rune-free and IO-free on purpose (tested in prompt-review.test.ts).
 */
import type { LLMMessage } from '$lib/types/llm';

const ROLES = ['system', 'user', 'assistant'] as const;

/** The whole of `LLMMessage`. A field added there is a field this must learn to carry. */
const FIELDS = ['role', 'content', 'images'] as const;

export type ParsedPrompt = { ok: true; messages: LLMMessage[] } | { ok: false; error: string };

/** The request as editable text: the array itself, never a wrapper around it. */
export function promptToJson(messages: LLMMessage[]): string {
	return JSON.stringify(messages, null, 2);
}

/**
 * Read an edited request back. The result carries only the fields `LLMMessage` declares, in
 * a fixed order, so what the reader approves and what the provider receives are the same
 * object. An empty `images` list is dropped: it means the message carries no attachment,
 * which is what its absence means.
 */
export function parsePromptJson(text: string): ParsedPrompt {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (!Array.isArray(raw)) return { ok: false, error: 'The request must be a list of messages.' };
	if (raw.length === 0) return { ok: false, error: 'The request has no messages left.' };

	const messages: LLMMessage[] = [];
	for (let i = 0; i < raw.length; i++) {
		const at = `Message ${i + 1}`;
		const item = raw[i];
		if (typeof item !== 'object' || item === null || Array.isArray(item)) {
			return { ok: false, error: `${at} is not an object.` };
		}
		const entry = item as Record<string, unknown>;

		const unknown = Object.keys(entry).find((key) => !FIELDS.includes(key as (typeof FIELDS)[number]));
		if (unknown) return { ok: false, error: `${at} has a field the request has no place for: "${unknown}".` };

		const role = entry.role;
		if (typeof role !== 'string' || !ROLES.includes(role as (typeof ROLES)[number])) {
			return { ok: false, error: `${at} needs a role of "system", "user" or "assistant".` };
		}
		if (typeof entry.content !== 'string') {
			return { ok: false, error: `${at} needs its content to be text.` };
		}

		const message: LLMMessage = { role: role as LLMMessage['role'], content: entry.content };
		if (entry.images !== undefined) {
			if (!Array.isArray(entry.images) || entry.images.some((path) => typeof path !== 'string')) {
				return { ok: false, error: `${at} needs its images to be a list of file paths.` };
			}
			if (entry.images.length > 0) message.images = entry.images as string[];
		}
		messages.push(message);
	}

	return { ok: true, messages };
}

/**
 * Whether two messages carry the same thing. Compared field by field rather than by
 * serializing: key order is not information, and a request that only came back through the
 * JSON view must not read as edited.
 */
export function sameMessage(a: LLMMessage, b: LLMMessage): boolean {
	if (a.role !== b.role || a.content !== b.content) return false;
	const left = a.images ?? [];
	const right = b.images ?? [];
	return left.length === right.length && left.every((path, i) => path === right[i]);
}

/** The same question asked of a whole request. */
export function samePrompt(a: LLMMessage[], b: LLMMessage[]): boolean {
	return a.length === b.length && a.every((message, i) => sameMessage(message, b[i]));
}
