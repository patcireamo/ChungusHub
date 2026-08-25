import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A generation must outlive the socket that asked for it, and a page that comes back must be
 * able to claim what it missed.
 *
 * This is the one test that runs the real server, because the failure it pins only exists
 * where the socket does: a phone that backgrounds its browser has the socket torn down by the
 * OS mid-reply, and nothing below the WebSocket layer can be handed that situation. It spawns
 * the executable against a throwaway data dir and a scripted model endpoint, streams a reply,
 * severs the socket while the model is still writing, and asks a second socket for the rest.
 *
 * The endpoint holds the second half of its answer behind `gate`, so the tokens it sends after
 * the cut are provably produced with nobody listening: if the server still killed generations
 * with their socket, they would never be produced at all.
 */

const TOKENS_BEFORE_CUT = ['Hel', 'lo '];
const TOKENS_AFTER_CUT = ['wor', 'ld.'];

let releaseGate: () => void;
const gate = new Promise<void>((resolve) => {
	releaseGate = resolve;
});

function sse(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** An OpenAI-compatible endpoint that answers /v1/models (so the base pins) and streams a
 *  chat completion in two halves with a gate between them. */
const model = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === '/v1/models') {
			return Response.json({ data: [{ id: 'scripted' }] });
		}
		if (path !== '/v1/chat/completions') return new Response('Not found', { status: 404 });

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const encode = (s: string) => controller.enqueue(new TextEncoder().encode(s));
				for (const token of TOKENS_BEFORE_CUT) {
					encode(sse({ choices: [{ delta: { content: token } }] }));
					await Bun.sleep(10);
				}
				await gate;
				for (const token of TOKENS_AFTER_CUT) {
					encode(sse({ choices: [{ delta: { content: token } }] }));
					await Bun.sleep(10);
				}
				encode(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
				encode(sse({ usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }));
				encode('data: [DONE]\n\n');
				controller.close();
			}
		});
		return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
	}
});

const scratch = mkdtempSync(join(tmpdir(), 'chungus-gen-'));
let child: ReturnType<typeof Bun.spawn>;
let origin = '';

/** Boot the real server on an OS-assigned port and read that port off its own banner. */
async function bootServer(): Promise<string> {
	child = Bun.spawn([process.execPath, 'server/index.ts'], {
		env: {
			...process.env,
			// The child is a real server, not a test process, and `bun test` puts NODE_ENV=test
			// in the environment it would inherit. config.ts reads exactly that to decide whether
			// to create the data dirs, so inheriting it boots an install with nowhere to write.
			NODE_ENV: 'production',
			CHUNGUS_PORT: '0',
			CHUNGUS_HOST: '127.0.0.1',
			CHUNGUS_DATA_DIR: join(scratch, 'data'),
			CHUNGUS_BACKUP_DIR: join(scratch, 'backups'),
			CHUNGUS_NO_OPEN: '1'
		},
		stdout: 'pipe',
		stderr: 'pipe'
	});

	let errors = '';
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
			errors += decoder.decode(chunk, { stream: true });
		}
	})();

	const decoder = new TextDecoder();
	let banner = '';
	for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
		banner += decoder.decode(chunk, { stream: true });
		const match = banner.match(/http:\/\/localhost:(\d+)/);
		if (match) return `http://127.0.0.1:${match[1]}`;
	}
	await Bun.sleep(50);
	throw new Error(`The server exited before it announced a port.\nstdout:\n${banner}\nstderr:\n${errors}`);
}

/** One WebSocket, open and ready to send. */
function openSocket(): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws?clientId=${crypto.randomUUID()}`);
		socket.onopen = () => resolve(socket);
		socket.onerror = () => reject(new Error('The test socket would not open'));
	});
}

/** Collect frames off a socket until `done` says the test has what it waited for. */
function collect(
	socket: WebSocket,
	done: (frames: Record<string, unknown>[]) => boolean
): Promise<Record<string, unknown>[]> {
	const frames: Record<string, unknown>[] = [];
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timed out waiting on frames. Got: ${JSON.stringify(frames)}`)),
			15_000
		);
		socket.onmessage = (event) => {
			const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (frame.t === 'pong') return;
			frames.push(frame);
			if (done(frames)) {
				clearTimeout(timer);
				resolve(frames);
			}
		};
	});
}

const CONNECTION_ID = 'test-connection';

function generateRequest(id: string): string {
	return JSON.stringify({
		t: 'llm',
		id,
		connectionId: CONNECTION_ID,
		provider: 'openai-compatible',
		model: 'scripted',
		messages: [{ role: 'user', content: 'say hello' }],
		stream: true,
		source: 'chat'
	});
}

beforeAll(async () => {
	origin = await bootServer();
	// The registry reads the key and base URL out of connection_credentials per request, so
	// the connection has to exist before the first generation.
	const res = await fetch(`${origin}/api/rpc/db`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			method: 'setConnectionCredentials',
			args: [CONNECTION_ID, 'openai-compatible', 'test-key', `http://127.0.0.1:${model.port}/v1`],
			clientId: 'test'
		})
	});
	expect(res.status).toBe(200);
});

afterAll(async () => {
	child?.kill();
	// Windows will not unlink a file another process still has open, and the child holds the
	// SQLite handle until it is actually gone. Waiting on the exit is the difference between
	// a clean scratch dir and a red suite.
	await child?.exited;
	model.stop(true);
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			rmSync(scratch, { recursive: true, force: true });
			return;
		} catch {
			await Bun.sleep(100);
		}
	}
	rmSync(scratch, { recursive: true, force: true });
});

describe('a generation outlives its socket (architecture/server-core.md, WebSocket protocol)', () => {
	test('the tokens written while nobody was listening are handed to the page that comes back', async () => {
		const id = crypto.randomUUID();
		const first = await openSocket();

		// Watch until the model has said everything it will say before the cut.
		const early = collect(first, (frames) => {
			const content = frames.filter((f) => f.t === 'llm-token').map((f) => String(f.token)).join('');
			return content === TOKENS_BEFORE_CUT.join('');
		});
		first.send(generateRequest(id));
		const seen = await early;
		const haveContent = seen
			.filter((f) => f.t === 'llm-token')
			.map((f) => String(f.token))
			.join('').length;
		expect(haveContent).toBe(TOKENS_BEFORE_CUT.join('').length);

		// The phone goes away mid-reply. Only once the socket is gone does the model write the
		// rest, so every token after this point is produced with nothing attached to send it to.
		first.close();
		await Bun.sleep(150);
		releaseGate();
		await Bun.sleep(300);

		const second = await openSocket();
		const claimed = collect(second, (frames) => frames.some((f) => f.t === 'llm-done'));
		second.send(JSON.stringify({ t: 'llm-attach', id, haveContent, haveThinking: 0 }));
		const frames = await claimed;

		const attached = frames.find((f) => f.t === 'llm-attached');
		expect(attached).toBeDefined();
		// The remainder alone: a claim that repainted from the start would duplicate the text
		// already on screen in the page that never reloaded.
		expect(attached?.content).toBe(TOKENS_AFTER_CUT.join(''));

		const result = frames.find((f) => f.t === 'llm-done')?.result as { content: string; finishReason: string };
		expect(result.content).toBe([...TOKENS_BEFORE_CUT, ...TOKENS_AFTER_CUT].join(''));
		expect(result.finishReason).toBe('stop');
		second.close();
	}, 30_000);

	test('a claim on a generation the server never had is answered, not left hanging', async () => {
		const socket = await openSocket();
		const frames = collect(socket, (f) => f.some((frame) => frame.t === 'llm-attach-miss'));
		socket.send(JSON.stringify({ t: 'llm-attach', id: 'never-existed', haveContent: 0, haveThinking: 0 }));
		expect((await frames)[0]?.t).toBe('llm-attach-miss');
		socket.close();
	}, 15_000);

	test('a released generation is forgotten, so its id cannot be claimed twice', async () => {
		const id = crypto.randomUUID();
		const socket = await openSocket();
		const run = collect(socket, (f) => f.some((frame) => frame.t === 'llm-done'));
		socket.send(generateRequest(id));
		await run;

		socket.send(JSON.stringify({ t: 'llm-release', id }));
		await Bun.sleep(100);

		const claim = collect(socket, (f) => f.some((frame) => frame.t === 'llm-attach-miss'));
		socket.send(JSON.stringify({ t: 'llm-attach', id, haveContent: 0, haveThinking: 0 }));
		expect((await claim)[0]?.t).toBe('llm-attach-miss');
		socket.close();
	}, 30_000);
});
