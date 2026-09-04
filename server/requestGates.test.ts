import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The request gates on the wire (server/index.ts).
 *
 * server/sameOrigin.test.ts pins the rules as functions. What only a running server can answer
 * is whether the fetch handler asks them, and where: the host gate above every route, the
 * cross-site gate above the login, the socket refused at the handshake, and a `/files/` answer
 * that is a picture and nothing else. Any of those can be dropped with every unit test still
 * green, so this spawns the executable against a throwaway data dir, the way
 * generationSurvival.test.ts does, and speaks raw HTTP to it: `fetch` sets `Host` itself and
 * refuses an `Origin` of the caller's choosing, and Bun's own WebSocket client sends no
 * `Origin` at all, so a browser's headers have to be spelled out by hand.
 */

const scratch = mkdtempSync(join(tmpdir(), 'chungus-gates-'));
let child: ReturnType<typeof Bun.spawn>;
let port = 0;
/** Everything the server has said on either stream, so a server that dies mid-file can say why. */
let said = '';

/** Boot the real server on an OS-assigned port and read that port off its own banner. Both
 *  streams are drained for as long as it lives: a child whose pipe nobody reads blocks on it. */
async function bootServer(): Promise<number> {
	child = Bun.spawn([process.execPath, 'server/index.ts'], {
		env: {
			...process.env,
			// A real server rather than a test process: `bun test` puts NODE_ENV=test in the
			// environment it would inherit, which config.ts reads to skip creating the data dirs.
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
	const decoder = new TextDecoder();
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream) said += decoder.decode(chunk, { stream: true });
	};
	void drain(child.stdout as ReadableStream<Uint8Array>).catch(() => {});
	void drain(child.stderr as ReadableStream<Uint8Array>).catch(() => {});
	const deadline = Date.now() + 30_000;
	for (;;) {
		const match = said.match(/http:\/\/localhost:(\d+)/);
		if (match) return Number(match[1]);
		if (child.exitCode !== null || Date.now() > deadline) {
			throw new Error(`The server did not announce a port.\n${said}`);
		}
		await Bun.sleep(20);
	}
}

interface Answer {
	status: number;
	headers: Record<string, string>;
	body: string;
}

/** One HTTP/1.1 exchange, written out so the headers are exactly what the case names. It reads
 *  to the announced length rather than waiting for the server to hang up: a small file answer
 *  leaves the connection open whatever `Connection: close` asked. */
function exchange(method: string, path: string, headers: Record<string, string>, body = ''): Promise<Answer> {
	const lines = [
		`${method} ${path} HTTP/1.1`,
		...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
		'Connection: close'
	];
	if (body) lines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`);
	const request = `${lines.join('\r\n')}\r\n\r\n${body}`;
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let settled = false;
		const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
		socket.setTimeout(10_000, () => socket.destroy(new Error(`No answer to ${method} ${path}`)));
		const settle = () => {
			if (settled) return;
			const raw = Buffer.concat(chunks);
			const split = raw.indexOf('\r\n\r\n');
			if (split === -1) return;
			const [status, ...fields] = raw.subarray(0, split).toString().split('\r\n');
			const parsed: Record<string, string> = {};
			for (const field of fields) {
				const at = field.indexOf(':');
				parsed[field.slice(0, at).toLowerCase()] = field.slice(at + 1).trim();
			}
			const answer = raw.subarray(split + 4);
			if (answer.length < Number(parsed['content-length'])) return;
			settled = true;
			resolve({ status: Number(status.split(' ')[1]), headers: parsed, body: answer.toString() });
			socket.destroy();
		};
		socket.on('data', (chunk) => {
			chunks.push(chunk);
			settle();
		});
		socket.on('close', () => {
			settle();
			if (!settled) reject(new Error(`The connection closed before ${method} ${path} was answered`));
		});
		socket.on('error', (error) => {
			if (!settled) reject(error);
		});
	});
}

/** Whether a handshake carrying these headers is accepted. */
function socketOpens(headers?: Record<string, string>): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=gates`, { headers });
		socket.onopen = () => {
			resolve(true);
			socket.close();
		};
		socket.onerror = () => resolve(false);
		socket.onclose = () => resolve(false);
	});
}

const ours = () => ({ Host: `127.0.0.1:${port}` });
const anotherSite = { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://evil.example' };
const login = JSON.stringify({ password: 'x' });

beforeAll(async () => {
	port = await bootServer();
});

afterAll(async () => {
	const diedAlone = child?.exitCode !== null;
	child?.kill();
	// Windows will not unlink a file another process still has open, and the child holds the
	// SQLite handle until it is actually gone.
	await child?.exited;
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			rmSync(scratch, { recursive: true, force: true });
			break;
		} catch {
			await Bun.sleep(100);
		}
	}
	if (diedAlone) throw new Error(`The server died during the file:\n${said}`);
});

describe('the host gate', () => {
	test('a name this install does not answer to is refused on every route', async () => {
		for (const path of ['/api/config', '/files/backgrounds/x.webp', '/ws']) {
			const answer = await exchange('GET', path, { Host: `evil.example:${port}` });
			expect(answer.status, path).toBe(403);
			expect(answer.body, path).toContain('does not answer to this name');
		}
		// A navigation gets a page naming the address it arrived with and the setting that admits it.
		const page = await exchange('GET', '/', { Host: `evil.example:${port}` });
		expect(page.status).toBe(403);
		expect(page.body).toContain(`evil.example:${port}`);
		expect(page.body).toContain('allowedHostnames');
	});

	test('the names that are its own by construction', async () => {
		for (const host of [
			`127.0.0.1:${port}`,
			`localhost:${port}`,
			`[::1]:${port}`,
			`${hostname()}:${port}`,
			`${hostname().toUpperCase()}:${port}`
		]) {
			expect((await exchange('GET', '/api/config', { Host: host })).status, host).toBe(200);
		}
	});
});

describe('the cross-site gate', () => {
	test('a mutation from another site is refused before the login sees it', async () => {
		const refused = await exchange('POST', '/api/auth/login', { ...ours(), ...anotherSite }, login);
		expect(refused.status).toBe(403);
		expect(refused.body).toContain('another site');
		// The same call from this app's own page reaches the login, which answers for itself.
		const reached = await exchange('POST', '/api/auth/login', { ...ours(), 'Sec-Fetch-Site': 'same-origin' }, login);
		expect(reached.status).toBe(401);
		expect((await exchange('POST', '/api/rpc/db', { ...ours(), ...anotherSite }, '{}')).status).toBe(403);
	});

	// A LAN phone through the dev proxy: plain HTTP carries no Sec-Fetch-Site, Host is the Bun
	// port, and the page's own host rides X-Forwarded-Host from the loopback peer.
	test('a phone behind the dev proxy reaches the bridge', async () => {
		const proxied = { Host: `localhost:${port}`, Origin: 'http://192.168.1.5:1420' };
		const call = JSON.stringify({ method: 'nope', args: [] });
		const reached = await exchange('POST', '/api/rpc/db', { ...proxied, 'X-Forwarded-Host': '192.168.1.5:1420' }, call);
		expect(reached.status).toBe(500);
		expect(reached.body).toContain('Unknown db method');
		const bare = await exchange('POST', '/api/rpc/db', proxied, call);
		expect(bare.status).toBe(403);
		expect(bare.body).toContain('another site');
	});

	test('a read from another site is answered, since that caller cannot read it', async () => {
		expect((await exchange('GET', '/api/config', { ...ours(), ...anotherSite })).status).toBe(200);
	});

	test('a caller sending neither header is not a browser and passes', async () => {
		// No such db method, so the bridge's own refusal is what proves the call reached it.
		const answer = await exchange('POST', '/api/rpc/db', ours(), JSON.stringify({ method: 'nope', args: [] }));
		expect(answer.status).toBe(500);
		expect(answer.body).toContain('Unknown db method');
	});

	test('the socket opens for a page on this host, whatever its port, and for no other', async () => {
		expect(await socketOpens({ Origin: 'http://127.0.0.1:1420' })).toBe(true);
		expect(await socketOpens({ Origin: `http://127.0.0.1:${port}` })).toBe(true);
		expect(await socketOpens()).toBe(true);
		expect(await socketOpens({ Origin: 'http://evil.example' })).toBe(false);
		expect(await socketOpens({ Origin: 'null' })).toBe(false);
	});
});

describe('/files/', () => {
	test('a stored picture is answered as its fixed type, and a stored document is not answered', async () => {
		const dir = join(scratch, 'data', 'images', 'characters');
		writeFileSync(join(dir, 'gate.PNG'), 'not a picture, and the type says png regardless');
		writeFileSync(join(dir, 'gate.html'), '<script>alert(1)</script>');
		const picture = await exchange('GET', '/files/images/characters/gate.PNG', ours());
		expect(picture.status).toBe(200);
		expect(picture.headers['content-type']).toBe('image/png');
		expect(picture.headers['x-content-type-options']).toBe('nosniff');
		expect(picture.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
		expect(picture.headers['cross-origin-resource-policy']).toBe('same-origin');
		expect((await exchange('GET', '/files/images/characters/gate.html', ours())).status).toBe(404);
		// A thumbnail nobody wrote is answered with the original beside it, typed as what answered.
		// Its own name is lowercase because every writer into the store lowercases one, and the
		// walk that finds it is spelled that way: an uppercase original is found on a filesystem
		// that ignores case and nowhere else, so asking for one here would pass on Windows alone.
		writeFileSync(join(dir, 'beside.png'), 'the original a thumbnail request falls back to');
		const fallback = await exchange('GET', '/files/images/characters/thumbnails/beside.webp', ours());
		expect(fallback.status).toBe(200);
		expect(fallback.headers['content-type']).toBe('image/png');
	});

	test('a bundled background carries the same headers', async () => {
		const { backgrounds } = JSON.parse((await exchange('GET', '/api/backgrounds', ours())).body) as {
			backgrounds: { path: string }[];
		};
		const bundled = await exchange('GET', `/files/${backgrounds[0].path}`, ours());
		expect(bundled.status).toBe(200);
		expect(bundled.headers['content-type']).toMatch(/^image\//);
		expect(bundled.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
		expect(bundled.headers['cross-origin-resource-policy']).toBe('same-origin');
	});
});
