/**
 * Network hardening primitives shared by every provider implementation.
 *
 * All outbound LLM traffic goes through user-configured endpoints and keys, so
 * nothing here may hang forever or buffer an unbounded response:
 *  - timedFetch: bounds the time until response HEADERS arrive. For a completion
 *    that bound is a backstop rather than a liveness check (see
 *    COMPLETION_START_BACKSTOP_MS). The caller's AbortSignal keeps governing the
 *    body for the rest of the request's life, and it is the real bound.
 *  - readBodyCapped: reads a full body with a per-chunk idle timeout and a hard
 *    byte cap, so a wedged or malicious server fails loudly instead of eating
 *    memory or blocking a generation slot forever.
 *  - readWithIdleTimeout: one stream read bounded by an idle timeout, for SSE
 *    loops that must keep flowing (providers send pings/deltas continuously).
 *
 * Every timeout aborts the underlying request and surfaces as a thrown Error
 * naming what stalled, never a silent partial result.
 */

/** Whole control-plane request (models list, key validation, account). */
export const CONTROL_TIMEOUT_MS = 30_000;
/**
 * How long a completion that has sent NOTHING is allowed to stay open. This is a backstop,
 * not a liveness check, and the distinction is the whole point: until the first byte arrives
 * there is nothing to tell a model still prefilling a long context on slow hardware from an
 * endpoint that will never answer. Any number a person could plausibly reach is therefore a
 * guess about their machine, and guessing low kills a healthy generation.
 *
 * Liveness is asked where it can be answered: STREAM_IDLE_TIMEOUT_MS measures silence once a
 * response has started, and the user's Stop ends any request at once (both bounds a person
 * can act on). This one exists only so a request nobody is waiting for cannot hold a socket
 * for the life of the process, which is why it sits far past any generation worth waiting
 * through. One value for streamed and non-streamed alike: they ask the same unanswerable
 * question, and a tighter number for one of them would only be a smaller guess.
 */
export const COMPLETION_START_BACKSTOP_MS = 6 * 60 * 60 * 1000;
/** Max silence between stream chunks before we call the stream dead. A generating model emits
 *  continuously, so this one IS a liveness check: silence this long means nothing is coming. */
export const STREAM_IDLE_TIMEOUT_MS = 500_000;

/** Largest /models (or other control-plane) body we'll buffer. */
export const MAX_CONTROL_BODY_BYTES = 32 * 1024 * 1024;
/** Largest non-streaming completion body we'll buffer (128K output tokens ≈ 1 MB). */
export const MAX_COMPLETION_BODY_BYTES = 16 * 1024 * 1024;
/** Largest error body worth reading for a message. */
export const MAX_ERROR_BODY_BYTES = 256 * 1024;
/** Largest carry-over an SSE parser may hold for one unterminated line. */
export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/** A deadline in the unit that reads: "21600s" names nothing a person can act on. */
function deadlineText(ms: number): string {
	const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`;
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 90_000) return unit(Math.round(ms / 1000), 'second');
	if (ms < 5_400_000) return unit(Math.round(ms / 60_000), 'minute');
	return unit(Math.round(ms / 3_600_000), 'hour');
}

/**
 * fetch() with a headers deadline. The returned Response's body remains
 * governed by the caller's own signal (user cancellation): the deadline only
 * covers connect + request + time-to-first-header.
 */
export async function timedFetch(
	url: string,
	init: RequestInit,
	headersTimeoutMs: number,
	what: string
): Promise<Response> {
	// AbortSignal.any composes the caller's signal with our deadline without
	// hand-managed listeners (which would accumulate on a signal reused across
	// requests, e.g. one assistant-loop AbortController spanning many turns).
	const deadline = new AbortController();
	const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
	const timer = setTimeout(
		() => deadline.abort(new Error(`${what} timed out after ${deadlineText(headersTimeoutMs)} with no response`)),
		headersTimeoutMs
	);
	try {
		return await fetch(url, { ...init, signal });
	} catch (e) {
		// Surface our deadline instead of the generic "operation was aborted"
		// the fetch layer wraps it in; caller aborts pass through untouched.
		if (deadline.signal.aborted) throw deadline.signal.reason;
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The slice of a stream reader this helper actually uses. Written structurally on
 * purpose: the global `ReadableStreamDefaultReader` name resolves to Bun's declaration
 * (which carries an extra `readMany`), and that is not the reader a fetch response body
 * hands back. Naming either one makes the other side fail to type-check.
 */
type BodyStreamReader = {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(): Promise<unknown>;
};

/**
 * One reader.read() bounded by an idle timeout. On timeout the reader is
 * cancelled (killing the request) and a loud error names the stalled stream.
 *
 * The rejection is raised BEFORE the cancel, and the order is the whole guard:
 * cancelling settles the read this race is already waiting on with `{done:true}`,
 * so cancelling first hands the race a clean end-of-stream and the stall is
 * reported as a stream that finished normally. Every caller believes it: an SSE
 * loop ends its generator, a buffered body returns the bytes it happened to have,
 * and a wedged endpoint reads as a short but successful answer.
 */
export async function readWithIdleTimeout(
	reader: BodyStreamReader,
	idleMs: number,
	what: string
): Promise<{ done: boolean; value?: Uint8Array }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`${what} stalled: no data for ${deadlineText(idleMs)}`));
			reader.cancel().catch(() => {});
		}, idleMs);
	});
	try {
		return await Promise.race([reader.read(), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Read a whole response body as text with an idle timeout per chunk and a hard
 * size cap. Throws (and aborts the request) when either bound is exceeded.
 */
export async function readBodyCapped(response: Response, maxBytes: number, what: string): Promise<string> {
	const body = response.body;
	if (!body) return '';
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await readWithIdleTimeout(reader, STREAM_IDLE_TIMEOUT_MS, what);
			if (done || !value) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error(`${what} exceeded ${Math.round(maxBytes / 1024 / 1024)} MB, so it was not buffered`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		joined.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(joined);
}

/** readBodyCapped + JSON.parse with a uniform loud error for malformed bodies. */
export async function readJsonCapped(response: Response, maxBytes: number, what: string): Promise<unknown> {
	const text = await readBodyCapped(response, maxBytes, what);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${what} was not valid JSON`);
	}
}

/**
 * Iterate the `data: ` payloads of an SSE response. Owns all the framing a provider
 * would otherwise hand-roll (idle timeout per chunk, oversize guard, line splitting,
 * carry-over buffer) so every stream consumer shares one hardened implementation.
 * The finally block cancels the reader on ANY exit, whether a normal end, a consumer
 * throw or an abort, so the upstream request never keeps generating into a stream
 * nobody is reading.
 */
export async function* sseData(response: Response, what: string): AsyncGenerator<string> {
	const body = response.body;
	if (!body) throw new Error(`${what} returned no response body for streaming`);
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await readWithIdleTimeout(reader, STREAM_IDLE_TIMEOUT_MS, what);
			if (done || !value) break;
			buffer += decoder.decode(value, { stream: true });
			if (buffer.length > MAX_SSE_BUFFER_BYTES) {
				throw new Error(`${what} sent an oversized stream event, so the stream was aborted`);
			}
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const trimmed = line.trim();
				// Per the SSE spec the space after `data:` is optional; strip exactly one if
				// present. Matching only `data: ` silently dropped conforming `data:{...}` events.
				if (trimmed.startsWith('data:')) {
					const rest = trimmed.slice(5);
					yield rest.startsWith(' ') ? rest.slice(1) : rest;
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
