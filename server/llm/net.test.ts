import { afterAll, describe, expect, test } from 'bun:test';
import { timedFetch, readWithIdleTimeout, COMPLETION_START_BACKSTOP_MS } from './net';

/**
 * What bounds a completion, against real sockets.
 *
 * The distinction these tests exist to pin: the idle timeout is a LIVENESS check and the
 * headers deadline is not. A generating model emits continuously, so silence between chunks
 * really does mean nothing is coming, however long the whole generation runs. Before the
 * first byte there is no such signal, so the only honest bounds left are the user's Stop and
 * a backstop far past anything worth waiting through. Getting that backwards is what made a
 * healthy slow generation on local hardware fail as if the endpoint were dead.
 */

/** Sends `chunks` bytes `gapMs` apart, then either closes or holds the connection open. */
function dribbleServer(chunks: number, gapMs: number, thenSilent = false) {
	return Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch() {
			return new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						for (let i = 0; i < chunks; i++) {
							controller.enqueue(new TextEncoder().encode('.'));
							await Bun.sleep(gapMs);
						}
						// Held open rather than merely unclosed: a start() that returns lets the
						// stream end, which is a closed stream, not a silent one.
						if (thenSilent) await new Promise(() => {});
						controller.close();
					}
				}),
				{ headers: { 'Content-Type': 'text/plain' } }
			);
		}
	});
}

/** Accepts the connection and answers never: a wedged endpoint, or a black-holed network. */
const silentServer = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	fetch() {
		return new Promise<Response>(() => {});
	}
});

const trickle = dribbleServer(12, 40);
const stalls = dribbleServer(1, 0, true);

afterAll(() => {
	silentServer.stop(true);
	trickle.stop(true);
	stalls.stop(true);
});

describe('the idle timeout measures silence, not total time', () => {
	// The load-bearing one. A slow model streams for far longer than any single gap between
	// its tokens, so an idle bound that behaved like a total-time cap would kill exactly the
	// generation it exists to protect.
	test('a stream that keeps trickling runs well past the idle bound and never trips it', async () => {
		const response = await fetch(`http://127.0.0.1:${trickle.port}/`);
		const reader = response.body!.getReader();
		const startedAt = performance.now();
		let read = 0;
		while (true) {
			const { done, value } = await readWithIdleTimeout(reader, 150, 'trickle');
			if (done || !value) break;
			read += value.byteLength;
		}
		const elapsed = performance.now() - startedAt;
		expect(read).toBe(12);
		// The proof is in the arithmetic: the whole read outlived the bound several times over.
		expect(elapsed).toBeGreaterThan(300);
	});

	test('a stream that goes quiet is called dead, by name', async () => {
		const response = await fetch(`http://127.0.0.1:${stalls.port}/`);
		const reader = response.body!.getReader();
		await readWithIdleTimeout(reader, 5_000, 'stalled stream');
		await expect(readWithIdleTimeout(reader, 120, 'stalled stream')).rejects.toThrow(
			/stalled stream stalled: no data for/
		);
	});
});

describe('the headers deadline is a backstop, and Stop is the real bound', () => {
	test("a caller's Stop ends a request at once, whatever the deadline says", async () => {
		const controller = new AbortController();
		const startedAt = performance.now();
		setTimeout(() => controller.abort(), 120);
		const failure = timedFetch(
			`http://127.0.0.1:${silentServer.port}/`,
			{ method: 'POST', body: '{}', signal: controller.signal },
			// The real one. Nothing about this test may depend on the backstop being small.
			COMPLETION_START_BACKSTOP_MS,
			'Test completion'
		).catch((e: Error) => e);
		const error = await failure;
		expect(error.name).toBe('AbortError');
		expect(performance.now() - startedAt).toBeLessThan(3_000);
	});

	test('nothing else ends it: an endpoint that never answers holds until the deadline', async () => {
		await expect(
			timedFetch(`http://127.0.0.1:${silentServer.port}/`, { method: 'POST', body: '{}' }, 250, 'Test completion')
		).rejects.toThrow('Test completion timed out after 250ms with no response');
	});

	// The deadline is quoted to a person when it fires, and the backstop's own value would
	// print as "21600s". So the sentence carries the unit that reads.
	test('the deadline is quoted in the unit that reads', async () => {
		await expect(
			timedFetch(`http://127.0.0.1:${silentServer.port}/`, { method: 'POST', body: '{}' }, 1_500, 'Test completion')
		).rejects.toThrow('timed out after 2 seconds with no response');
	});

	// Not a tautology: tuning this back down to something a person could reach is exactly the
	// regression the change exists to prevent, and it would look like an innocent edit.
	test('the backstop sits past any generation worth waiting through', () => {
		expect(COMPLETION_START_BACKSTOP_MS).toBeGreaterThan(60 * 60 * 1000);
	});
});
