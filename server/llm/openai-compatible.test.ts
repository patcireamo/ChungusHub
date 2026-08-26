import { afterAll, describe, expect, test } from 'bun:test';
import { OpenAICompatibleProvider } from './openai-compatible';
import type { ProviderProfile } from './providers/types';

/**
 * Wiring tests for the provider class against a real local endpoint: net.ts SSE
 * framing + inline-reasoning extraction + the parseInlineReasoning gate working
 * together across all three completion paths (stream, non-stream, tools). The
 * scripted responses split reasoning markers across SSE events on purpose.
 */

function delta(content: string): string {
	return JSON.stringify({ choices: [{ delta: { content } }] });
}

const USAGE = '{"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}';

/** Scripted responses, selected by the requested model id. */
const SCENARIOS: Record<
	string,
	{ stream?: string[]; json?: unknown; hangs?: boolean; silent?: boolean; delayMs?: number }
> = {
	'split-tags': {
		stream: [
			delta('<thi'),
			delta('nking>secret plan</thinki'),
			delta('ng>Hello '),
			JSON.stringify({ choices: [{ delta: { content: 'world.' }, finish_reason: 'stop' }] }),
			USAGE,
			'[DONE]'
		]
	},
	'reasoning-fields': {
		json: {
			choices: [
				{
					message: { content: '<think>local plan</think>Answer.', reasoning_content: 'field plan' },
					finish_reason: 'stop'
				}
			],
			usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
		}
	},
	tools: {
		stream: [
			delta('<think>agent plan</think>Okay, '),
			delta('doing it'),
			JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: 'call_1', function: { name: 'navigate', arguments: '{"to":' } }]
						}
					}
				]
			}),
			JSON.stringify({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, function: { arguments: '"settings"}' } }] },
						finish_reason: 'tool_calls'
					}
				]
			}),
			USAGE,
			'[DONE]'
		]
	},
	// The same turn as `tools`, non-streamed: the whole step arrives in one message.
	'tools-json': {
		json: {
			choices: [
				{
					message: {
						content: '<think>agent plan</think>Okay, doing it',
						reasoning_content: 'field plan',
						tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'navigate', arguments: '{"to":"settings"}' } }]
					},
					finish_reason: 'tool_calls'
				}
			],
			usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
		}
	},
	// Nothing to show and no finish_reason: an endpoint that ended the request early.
	'tools-json-truncated': { json: { choices: [{ message: { content: '' } }] } },
	// OpenRouter-style mid-stream failure: 200 headers, then an error event instead of choices.
	'stream-error': {
		stream: [
			delta('Hel'),
			JSON.stringify({
				error: {
					message: 'Provider returned error',
					code: 502,
					metadata: { provider_name: 'DeepInfra', raw: '{"error":{"message":"upstream 502: no capacity"}}' }
				}
			})
		]
	},
	'tools-stream-error': {
		stream: [
			JSON.stringify({ error: { message: 'Rate limited', code: 429 } })
		]
	},
	// A corrupt stream: arguments accumulate but the call never gets a name.
	'tools-nameless': {
		stream: [
			JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] } }] }),
			JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
			USAGE,
			'[DONE]'
		]
	},
	// A truncated / early-closed stream: usage may arrive but no content and NO finish_reason
	// (a slow local endpoint hanging up mid-generation). Must fail loud, not read as a stop.
	'truncated': { stream: [USAGE, '[DONE]'] },
	'tools-truncated': { stream: [USAGE, '[DONE]'] },
	// A genuine explicit empty stop (finish_reason present, no content) passes through: the
	// assistant loop decides what to do with an empty-but-clean turn.
	'empty-stop': { stream: [JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), USAGE, '[DONE]'] },
	// Accepts the request and answers never: a wedged endpoint, or a model so slow on this
	// hardware that nothing has come back yet. From here those are the same thing.
	'never-answers': { silent: true },
	// A local endpoint that spends a while on the prompt before its first token. The whole
	// reply still lands: a slow start is not a dead endpoint.
	'slow-to-start': {
		stream: [delta('Worth '), JSON.stringify({ choices: [{ delta: { content: 'the wait.' }, finish_reason: 'stop' }] }), '[DONE]'],
		delayMs: 400
	},
	// Stream one delta and then never close, so a test can abort mid-flight.
	'abort-midstream': { stream: [delta('Half a reply')], hangs: true },
	// Same, with reasoning only: aborting from the thinking callback lands the "cancelled
	// with no content" shape the client must refuse to persist.
	'abort-thinking-only': {
		stream: [JSON.stringify({ choices: [{ delta: { reasoning: 'thinking out loud' } }] })],
		hangs: true
	}
};

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const body = (await req.json()) as { model: string; stream?: boolean };
		const scenario = SCENARIOS[body.model];
		if (!scenario) return new Response('unknown scenario', { status: 500 });
		if (scenario.silent) return new Promise<Response>(() => {});
		if (scenario.delayMs) await Bun.sleep(scenario.delayMs);
		if (body.stream) {
			const sse = (scenario.stream ?? []).map((d) => `data: ${d}\n\n`).join('');
			const headers = { 'Content-Type': 'text/event-stream' };
			if (!scenario.hangs) return new Response(sse, { headers });
			// Deliberately never closed: the request stays open until the caller aborts it.
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(sse));
					}
				}),
				{ headers }
			);
		}
		return Response.json(scenario.json);
	}
});

afterAll(() => {
	server.stop(true);
});

const provider = new OpenAICompatibleProvider({
	name: 'test',
	displayName: 'Test',
	defaultBaseUrl: `http://127.0.0.1:${server.port}/v1`,
	requiresApiKey: false,
	baseUrlEditable: false
});
provider.configure({ apiKey: '' });

const USER = [{ role: 'user' as const, content: 'hi' }];

describe('OpenAICompatibleProvider inline-reasoning wiring', () => {
	test('streaming: markers split across SSE events land in thinking, not content', async () => {
		const tokens: string[] = [];
		const thoughts: string[] = [];
		const result = await provider.complete({
			model: 'split-tags',
			messages: USER,
			onToken: (t) => tokens.push(t),
			onThinkingToken: (t) => thoughts.push(t)
		});
		expect(result.content).toBe('Hello world.');
		expect(result.thinking).toBe('secret plan');
		expect(tokens.join('')).toBe('Hello world.');
		expect(thoughts.join('')).toBe('secret plan');
		expect(result.finishReason).toBe('stop');
		expect(result.usage.promptTokens).toBe(5);
	});

	test('streaming: parseInlineReasoning=false leaves the markers in content', async () => {
		const tokens: string[] = [];
		const result = await provider.complete({
			model: 'split-tags',
			messages: USER,
			tuning: { parseInlineReasoning: false },
			onToken: (t) => tokens.push(t)
		});
		expect(result.content).toBe('<thinking>secret plan</thinking>Hello world.');
		expect(result.thinking).toBeNull();
		expect(tokens.join('')).toBe('<thinking>secret plan</thinking>Hello world.');
	});

	test('non-streaming: inline reasoning merges after the structured field', async () => {
		const result = await provider.complete({ model: 'reasoning-fields', messages: USER });
		expect(result.content).toBe('Answer.');
		expect(result.thinking).toBe('field plan\nlocal plan');
	});

	test('non-streaming: parseInlineReasoning=false keeps markers, still honours fields', async () => {
		const result = await provider.complete({
			model: 'reasoning-fields',
			messages: USER,
			tuning: { parseInlineReasoning: false }
		});
		expect(result.content).toBe('<think>local plan</think>Answer.');
		expect(result.thinking).toBe('field plan');
	});

	test('tool path: inline markers stay in content (assistant may legitimately quote them)', async () => {
		const result = await provider.completeWithTools({
			model: 'tools',
			messages: USER,
			tools: [],
			onToken: () => {}
		});
		// Deliberate: no inline extraction on the tool path, because an unclosed marker would
		// silently reroute the rest of the assistant's reply into the thinking channel.
		expect(result.content).toBe('<think>agent plan</think>Okay, doing it');
		expect(result.thinking).toBeNull();
		expect(result.toolCalls).toEqual([
			{ id: 'call_1', name: 'navigate', arguments: { to: 'settings' }, rawArguments: '{"to":"settings"}' }
		]);
		expect(result.finishReason).toBe('tool_calls');
	});
});

describe('OpenAICompatibleProvider user aborts keep what streamed', () => {
	// The whole "Stop keeps the partial reply" chain rests on this: the provider must
	// RESOLVE an aborted stream with everything it accumulated, flagged cancelled, so the
	// client can persist it as the turn instead of losing text the user watched arrive.
	test('streaming: an abort resolves with the partial accumulation, flagged cancelled', async () => {
		const controller = new AbortController();
		const tokens: string[] = [];
		const result = await provider.complete({
			model: 'abort-midstream',
			messages: USER,
			signal: controller.signal,
			onToken: (t) => {
				tokens.push(t);
				controller.abort();
			}
		});
		expect(result.content).toBe('Half a reply');
		expect(result.finishReason).toBe('cancelled');
		expect(tokens.join('')).toBe('Half a reply');
	});

	// The empty case is the one the client must NOT persist. It reaches the stream-closed-
	// with-nothing guard below on the identical shape, so only the cancelled flag keeps it
	// from failing loud as a truncated stream.
	test('streaming: an abort before any content resolves cancelled and empty', async () => {
		const controller = new AbortController();
		const result = await provider.complete({
			model: 'abort-thinking-only',
			messages: USER,
			signal: controller.signal,
			onToken: () => {},
			onThinkingToken: () => controller.abort()
		});
		expect(result.content).toBe('');
		expect(result.finishReason).toBe('cancelled');
	});
});

describe('OpenAICompatibleProvider slow endpoints', () => {
	// These two hold the shape rather than the bound: net.ts owns the deadlines and net.test.ts
	// is what goes red if either changes. What is pinned here is that the provider carries an
	// abort through the non-streamed path as an AbortError rather than swallowing it or
	// waiting the deadline out, since a Stop that only stops WAITING leaves the endpoint
	// generating and the whole "Stop is the real bound" argument with it.
	test('non-streaming: an endpoint that never answers is ended by Stop, and by nothing else', async () => {
		const controller = new AbortController();
		const startedAt = performance.now();
		setTimeout(() => controller.abort(), 150);
		const error = await provider
			.complete({ model: 'never-answers', messages: USER, signal: controller.signal })
			.then(() => null)
			.catch((e: Error) => e);
		expect(error?.name).toBe('AbortError');
		// The abort ended the request, rather than the request ending on its own deadline.
		expect(performance.now() - startedAt).toBeLessThan(3_000);
	});

	// Streamed, the same slow endpoint is answerable: the reply starts late and still lands,
	// and from the first token on it is silence (not elapsed time) that would call it dead.
	test('streaming: a reply that starts late still lands whole', async () => {
		const tokens: string[] = [];
		const result = await provider.complete({
			model: 'slow-to-start',
			messages: USER,
			onToken: (t) => tokens.push(t)
		});
		expect(result.content).toBe('Worth the wait.');
		expect(tokens.join('')).toBe('Worth the wait.');
		expect(result.finishReason).toBe('stop');
	});
});

describe('OpenAICompatibleProvider mid-stream failures fail loud', () => {
	test('streaming: an error event throws with the unwrapped upstream message', async () => {
		expect(
			provider.complete({ model: 'stream-error', messages: USER, onToken: () => {} })
		).rejects.toThrow(/DeepInfra: upstream 502: no capacity \(502\)/);
	});

	test('tool path: an error event throws instead of returning an empty turn', async () => {
		expect(
			provider.completeWithTools({ model: 'tools-stream-error', messages: USER, tools: [], onToken: () => {} })
		).rejects.toThrow(/Rate limited \(429\)/);
	});

	test('tool path: arguments without a tool name throw as a corrupt stream', async () => {
		expect(
			provider.completeWithTools({ model: 'tools-nameless', messages: USER, tools: [], onToken: () => {} })
		).rejects.toThrow(/no name/);
	});

	test('streaming: a stream that closes with no output and no finish_reason throws (not a fake stop)', async () => {
		expect(provider.complete({ model: 'truncated', messages: USER, onToken: () => {} })).rejects.toThrow(
			/closed before the model produced any output/
		);
	});

	test('tool path: a truncated stream throws instead of reporting an empty stop', async () => {
		expect(
			provider.completeWithTools({ model: 'tools-truncated', messages: USER, tools: [], onToken: () => {} })
		).rejects.toThrow(/closed before the model produced any reply or tool call/);
	});

	test('tool path: a genuine explicit empty stop passes through (loop decides)', async () => {
		const result = await provider.completeWithTools({ model: 'empty-stop', messages: USER, tools: [], onToken: () => {} });
		expect(result.content).toBe('');
		expect(result.toolCalls).toEqual([]);
		expect(result.finishReason).toBe('stop');
	});
});

describe('OpenAICompatibleProvider non-streamed tool path', () => {
	// No onToken = the Assistant connection has Stream response off. The request must go
	// out with stream:false and the step's reply + tool calls must land whole.
	test('parses the reply, reasoning field and tool calls from one response', async () => {
		const result = await provider.completeWithTools({ model: 'tools-json', messages: USER, tools: [] });
		expect(result.content).toBe('<think>agent plan</think>Okay, doing it');
		expect(result.thinking).toBe('field plan');
		expect(result.toolCalls).toEqual([
			{ id: 'call_1', name: 'navigate', arguments: { to: 'settings' }, rawArguments: '{"to":"settings"}' }
		]);
		expect(result.finishReason).toBe('tool_calls');
		expect(result.usage.totalTokens).toBe(12);
	});

	test('a response with no reply, no tool call and no finish reason throws', async () => {
		expect(provider.completeWithTools({ model: 'tools-json-truncated', messages: USER, tools: [] })).rejects.toThrow(
			/no reply, no tool call and no finish reason/
		);
	});
});

/**
 * Base-URL resolution for bring-your-own endpoints. Where the API lives under the
 * typed URL is unknowable from the string, so the class walks candidate bases and
 * pins only the one that PROVES itself with a JSON model list. These servers are
 * the real worlds: LM-Studio-style /v1-only, llama.cpp-style root-mounted, a
 * gateway whose web UI answers 200 HTML everywhere, an auth-walled API, a
 * redirecting /models, a chat-only endpoint with no /models, and a mount that
 * moves mid-process.
 */
const COMPLETION = {
	choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
};

/** Serves the OpenAI surface under `mount` only; every other path is a 404. */
function mountedServer(mount: string) {
	return Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === `${mount}/models`) return Response.json({ data: [{ id: 'local-model' }] });
			if (path === `${mount}/chat/completions`) return Response.json(COMPLETION);
			return new Response('not found', { status: 404 });
		}
	});
}

const v1Server = mountedServer('/v1');
const rootServer = mountedServer('');

/** A gateway hosting a web UI: 200 HTML for anything unknown, the API only under /v1. */
const spaServer = Bun.serve({
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === '/v1/models') return Response.json({ data: [{ id: 'local-model' }] });
		if (path === '/v1/chat/completions') return Response.json(COMPLETION);
		return new Response('<!doctype html><title>Web UI</title>', {
			headers: { 'Content-Type': 'text/html' }
		});
	}
});

/** An auth-walled API under /v1: every request there is a 401; everything else 404s. */
const authServer = Bun.serve({
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path.startsWith('/v1/')) {
			return Response.json({ error: { message: 'Invalid API key' } }, { status: 401 });
		}
		return new Response('not found', { status: 404 });
	}
});

/** A minimal proxy: only POST /chat/completions at the root, no /models anywhere. */
const chatOnlyServer = Bun.serve({
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === '/chat/completions' && req.method === 'POST') return Response.json(COMPLETION);
		return new Response('not found', { status: 404 });
	}
});

/** A server whose mount flips mid-test: a stack swap behind one URL. */
let movableMount = '/v1';
const movableServer = Bun.serve({
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === `${movableMount}/models`) return Response.json({ data: [{ id: 'local-model' }] });
		return new Response('not found', { status: 404 });
	}
});

/** /models 307-redirects to /v1/models: the http→https / moved-mount shape. */
const redirectServer = Bun.serve({
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === '/models') {
			return Response.redirect(`http://127.0.0.1:${redirectServer.port}/v1/models`, 307);
		}
		if (path === '/v1/models') return Response.json({ data: [{ id: 'local-model' }] });
		if (path === '/v1/chat/completions') return Response.json(COMPLETION);
		return new Response('not found', { status: 404 });
	}
});

/** Records the Authorization header of the completion POST it receives. */
const recorded = { auth: '' };
const recordingServer = Bun.serve({
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === '/v1/models') return Response.json({ data: [{ id: 'local-model' }] });
		if (path === '/v1/chat/completions') {
			recorded.auth = req.headers.get('authorization') ?? '';
			return Response.json(COMPLETION);
		}
		return new Response('not found', { status: 404 });
	}
});

afterAll(() => {
	v1Server.stop(true);
	rootServer.stop(true);
	spaServer.stop(true);
	authServer.stop(true);
	chatOnlyServer.stop(true);
	movableServer.stop(true);
	redirectServer.stop(true);
	recordingServer.stop(true);
});

function byoProvider(): OpenAICompatibleProvider {
	return new OpenAICompatibleProvider({
		name: 'byo',
		displayName: 'BYO',
		defaultBaseUrl: '',
		requiresApiKey: false,
		baseUrlEditable: true
	});
}

describe('OpenAICompatibleProvider base URL resolution', () => {
	test('a URL missing /v1 resolves to the /v1 the server actually serves', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${v1Server.port}` });
		expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
		expect(byo.resolvedBaseUrl()).toBe(`http://127.0.0.1:${v1Server.port}/v1`);
	});

	test('a URL carrying /v1 the server does not serve resolves to the root', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${rootServer.port}/v1` });
		expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
		expect(byo.resolvedBaseUrl()).toBe(`http://127.0.0.1:${rootServer.port}`);
	});

	test('a URL that already answers is left alone and reports no correction', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${v1Server.port}/v1` });
		expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
		expect(byo.resolvedBaseUrl()).toBeNull();
	});

	test('a trailing slash never doubles up in the request path', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${v1Server.port}/v1/` });
		expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
		expect(byo.resolvedBaseUrl()).toBeNull();
	});

	// The resolution has to reach generation, not just the model list: a connection whose
	// URL needed correcting must still be able to send.
	test('completions go to the resolved URL, not the typed one', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${v1Server.port}` });
		const result = await byo.complete({ model: 'local-model', messages: USER });
		expect(result.content).toBe('ok');
	});

	// Scope guard: the 13 providers whose endpoint we know must never shift under us.
	test('a fixed-endpoint provider never tries another shape', async () => {
		const fixed = new OpenAICompatibleProvider({
			name: 'fixed',
			displayName: 'Fixed',
			defaultBaseUrl: `http://127.0.0.1:${v1Server.port}`,
			requiresApiKey: false,
			baseUrlEditable: false
		});
		fixed.configure({ apiKey: '' });
		expect(await fixed.validateCredentials()).toBe(false);
		expect(fixed.resolvedBaseUrl()).toBeNull();
	});

	// An SPA catch-all serves 200 HTML for every unknown path. Only a JSON model
	// list may pin a base: an index page must not beat the /v1 the API lives at.
	test('a web UI answering 200 at the root cannot fool resolution', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${spaServer.port}` });
		expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
		expect(byo.resolvedBaseUrl()).toBe(`http://127.0.0.1:${spaServer.port}/v1`);
	});

	// LM Studio's UI shows ".../v1/models"; docs show ".../v1/chat/completions".
	// A paste of either identifies the server just as well as its base does.
	test('a pasted full endpoint URL resolves to its base', async () => {
		for (const suffix of ['/v1/models', '/v1/chat/completions']) {
			const byo = byoProvider();
			byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${v1Server.port}${suffix}` });
			expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
			expect(byo.resolvedBaseUrl()).toBe(`http://127.0.0.1:${v1Server.port}/v1`);
		}
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${rootServer.port}/models` });
		expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
		expect(byo.resolvedBaseUrl()).toBe(`http://127.0.0.1:${rootServer.port}`);
	});

	// An auth rejection proves a server engaged but must never pin: once the key is
	// fixed the next call re-walks cleanly. Generation goes where the server engaged,
	// so the POST surfaces the endpoint's real auth error, not a misleading 404.
	test('an auth wall surfaces its own error and pins nothing', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${authServer.port}` });
		await expect(byo.fetchAvailableModels()).rejects.toThrow('Invalid API key');
		expect(byo.resolvedBaseUrl()).toBeNull();
		await expect(byo.complete({ model: 'local-model', messages: USER })).rejects.toThrow('Invalid API key');
	});

	// A pinned base that stops proving (stack swap behind the same URL, same
	// long-lived server process) must heal by re-walking, not stay broken.
	test('a pin that stops answering is dropped and re-resolved', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${movableServer.port}` });
		expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
		expect(byo.resolvedBaseUrl()).toBe(`http://127.0.0.1:${movableServer.port}/v1`);
		movableMount = '';
		expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
		expect(byo.resolvedBaseUrl()).toBeNull();
	});

	// A redirect-following fetch lands somewhere else; the pin must be the base that
	// finally answered, so completions POST there directly.
	test('a redirected /models pins the base that finally answered', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${redirectServer.port}` });
		expect(await byo.fetchAvailableModels()).toEqual([{ id: 'local-model' }]);
		expect(byo.resolvedBaseUrl()).toBe(`http://127.0.0.1:${redirectServer.port}/v1`);
		const result = await byo.complete({ model: 'local-model', messages: USER });
		expect(result.content).toBe('ok');
	});

	// Some minimal proxies implement only /chat/completions. Generation must fall
	// back to the URL as typed; the model list fails naming every URL it tried.
	test('an endpoint with no /models still gets its completion at the typed URL', async () => {
		const root = `http://127.0.0.1:${chatOnlyServer.port}`;
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: root });
		const result = await byo.complete({ model: 'local-model', messages: USER });
		expect(result.content).toBe('ok');
		await expect(byo.fetchAvailableModels()).rejects.toThrow(`at ${root} or ${root}/v1`);
		await expect(byo.validateCredentials()).rejects.toThrow('no OpenAI-compatible /models endpoint');
	});

	// Path surgery on a query-carrying URL only makes garbage, so it gets no derived candidates.
	test('a URL carrying a query gets no derived candidates', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: '', baseUrl: `http://127.0.0.1:${rootServer.port}?upstream=x` });
		await expect(byo.fetchAvailableModels()).rejects.toThrow('not found');
		expect(byo.resolvedBaseUrl()).toBeNull();
	});

	// The registry reuses one instance per provider and configure() mutates it. A
	// request must snapshot its key + URL before the probe await, or a concurrent
	// request for another connection would swap credentials under it.
	test('a concurrent reconfigure cannot swap credentials under a resolving request', async () => {
		const byo = byoProvider();
		byo.configure({ apiKey: 'key-A', baseUrl: `http://127.0.0.1:${recordingServer.port}` });
		const pending = byo.complete({ model: 'local-model', messages: USER });
		byo.configure({ apiKey: 'key-B', baseUrl: `http://127.0.0.1:${v1Server.port}` });
		const result = await pending;
		expect(result.content).toBe('ok');
		expect(recorded.auth).toBe('Bearer key-A');
	});
});

// ===== Reasoning dialects =====
// applyTuning is the one place a reasoning policy becomes wire fields. For a BYO profile
// ('declared') the policy rides the request, because only the endpoint's owner knows which
// shape their server speaks; everywhere else the profile's own policy is the truth and the
// request's copy must not be able to touch it. These two shapes mirror REASONING_DIALECTS
// (src/lib/config/sampling.ts), whose vocabulary contracts.test.ts holds to this file's types.

const FLAT_DIALECT = { efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' } } as const;
const NESTED_DIALECT = {
	efforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' },
	effortField: 'reasoning-object',
	exclude: true
} as const;

/** Captures the completion POST's body, so a test can read what actually went out. */
let sentBody: Record<string, unknown> = {};
const dialectServer = Bun.serve({
	port: 0,
	async fetch(req) {
		sentBody = (await req.json()) as Record<string, unknown>;
		return Response.json(COMPLETION);
	}
});

afterAll(() => {
	dialectServer.stop(true);
});

function dialectProvider(reasoning: ProviderProfile['reasoning']): OpenAICompatibleProvider {
	const p = new OpenAICompatibleProvider({
		name: 'dialect',
		displayName: 'Dialect',
		defaultBaseUrl: `http://127.0.0.1:${dialectServer.port}/v1`,
		requiresApiKey: false,
		baseUrlEditable: false,
		reasoning
	});
	p.configure({ apiKey: '' });
	return p;
}

describe('OpenAICompatibleProvider declared reasoning dialects', () => {
	test('a declared flat dialect becomes reasoning_effort', async () => {
		await dialectProvider('declared').complete({
			model: 'm',
			messages: USER,
			tuning: { reasoningEffort: 'off', reasoningPolicy: FLAT_DIALECT }
		});
		expect(sentBody.reasoning_effort).toBe('none');
		expect(sentBody.reasoning).toBeUndefined();
	});

	test('a declared nested dialect becomes a reasoning object, effort and visibility together', async () => {
		await dialectProvider('declared').complete({
			model: 'm',
			messages: USER,
			tuning: { reasoningEffort: 'high', showReasoning: false, reasoningPolicy: NESTED_DIALECT }
		});
		expect(sentBody.reasoning).toEqual({ effort: 'high', exclude: true });
		expect(sentBody.reasoning_effort).toBeUndefined();
	});

	test('a declared profile with no dialect on the request sends no reasoning field', async () => {
		await dialectProvider('declared').complete({
			model: 'm',
			messages: USER,
			tuning: { reasoningEffort: 'high' }
		});
		expect(sentBody.reasoning_effort).toBeUndefined();
		expect(sentBody.reasoning).toBeUndefined();
	});

	test("a known provider's own dialect wins over a policy on the request", async () => {
		await dialectProvider(FLAT_DIALECT).complete({
			model: 'm',
			messages: USER,
			tuning: { reasoningEffort: 'high', reasoningPolicy: NESTED_DIALECT }
		});
		expect(sentBody.reasoning_effort).toBe('high');
		expect(sentBody.reasoning).toBeUndefined();
	});

	test('a provider that documents no reasoning ignores a policy on the request', async () => {
		await dialectProvider(undefined).complete({
			model: 'm',
			messages: USER,
			tuning: { reasoningEffort: 'high', reasoningPolicy: FLAT_DIALECT }
		});
		expect(sentBody.reasoning_effort).toBeUndefined();
		expect(sentBody.reasoning).toBeUndefined();
	});
});
