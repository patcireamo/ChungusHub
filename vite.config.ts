import { readFileSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { normalizeIp } from './server/access';
import { ALLOWLIST_ENV, ALLOWLIST_PATH, OPEN_BROWSER, PORT, SECURITY_PATH } from './server/config';

// Read from the server's own config, so the proxy cannot drift off the port it serves.
const BACKEND = `http://localhost:${PORT}`;

// Dev-only mirror of the Bun server's access gates (server/access.ts, server/security.ts).
// Vite serves the client itself and proxies /api, /files and /ws from localhost, so the Bun
// server sees every proxied request as loopback and its own gates can never block a device
// that comes in through :1420. Enforce the same ones here instead. Every state file is
// re-read per request, so a switch flipped in the app UI (which writes through the Bun
// process) takes effect here without restarting Vite.
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const envAllow = new Set(ALLOWLIST_ENV.map(normalizeIp));

function securityState(): { networkAccessEnabled?: boolean; ipAllowlistEnabled?: boolean } {
	try {
		return JSON.parse(readFileSync(SECURITY_PATH, 'utf8'));
	} catch {
		// No security file yet: the shipped defaults stand (network access off).
		return {};
	}
}

function networkAccessOn(): boolean {
	return securityState().networkAccessEnabled === true;
}

function isAllowed(ip: string | undefined): boolean {
	if (!ip) return false;
	const norm = normalizeIp(ip);
	// The host machine is exempt from every gate, same as the Bun server.
	if (LOOPBACK.has(norm) || envAllow.has(norm)) return true;
	// Honor the Settings → Security allowlist toggle: allowlist off = open LAN.
	if (securityState().ipAllowlistEnabled === false) return true;
	try {
		const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as unknown;
		return Array.isArray(parsed) && parsed.some((v) => normalizeIp(String(v)) === norm);
	} catch {
		// No allowlist file yet (or unreadable): only loopback/env devices get in.
		return false;
	}
}

// Dev mirror of the Bun server's password gate, for top-level page loads only.
// Assets and HMR stay open (the client source is not a secret); every /api,
// /files and /ws request is proxied to Bun, which enforces the real gate using
// the X-Forwarded-For the proxy attaches (xfwd below). Sessions and their
// sliding idle window live in security.json, written only by the Bun process.
// This just reads it per navigation. The idle window, its default and its 0-means-never
// rule all mirror server/security.ts.
const DEFAULT_SESSION_IDLE_MINUTES = 60;

function needsUnlock(req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }): boolean {
	const ip = req.socket.remoteAddress;
	if (ip && LOOPBACK.has(normalizeIp(ip))) return false;
	let sec: {
		passwordEnabled?: boolean;
		passwordHash?: unknown;
		sessionIdleMinutes?: unknown;
		sessions?: Record<string, number>;
	};
	try {
		sec = JSON.parse(readFileSync(SECURITY_PATH, 'utf8'));
	} catch {
		return false; // no security file = no password set
	}
	if (typeof sec.passwordHash !== 'string') return false;
	// The lock switch (server/security.ts): a stored hash with the lock off asks nothing.
	if (sec.passwordEnabled === false) return false;
	const cookie = String(req.headers.cookie ?? '');
	const token = cookie.match(/(?:^|;\s*)chungus_session=([a-f0-9]+)/)?.[1];
	const lastSeen = token ? sec.sessions?.[token] : undefined;
	if (lastSeen === undefined) return true;
	const minutes = sec.sessionIdleMinutes;
	const idle =
		typeof minutes === 'number' && Number.isSafeInteger(minutes) && minutes >= 0
			? minutes
			: DEFAULT_SESSION_IDLE_MINUTES;
	if (idle === 0) return false;
	return Date.now() - lastSeen > idle * 60_000;
}

// Dev twin of the Bun server's forbidden() page: shows the IP to allow and
// retries itself, so a device allowed from Settings → Security falls straight
// through. The allowlist is re-read per request, so the retry is enough.
function deniedPage(shown: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="5" />
<title>Access denied · ChungusHub</title>
<style>
  body{display:grid;place-items:center;min-height:100vh;margin:0;background:#1a1714;color:#e7e2da;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:1.5rem;text-align:center}
  h1{font-size:1.2rem;margin:0 0 .6rem}
  p{margin:.4rem 0;line-height:1.5;color:#b8b0a4;font-size:.92rem}
  code{background:#15120f;border:1px solid #3a342d;border-radius:8px;padding:.35rem .6rem;
    display:inline-block;margin-top:.4rem;color:#f0a868;font-size:1.05rem}
</style></head><body><div>
  <h1>This device isn't allowed</h1>
  <p>Ask the host to add this address:</p>
  <code>${shown}</code>
  <p>This page retries on its own, so once allowed, you're in.</p>
</div></body></html>`;
}

function allowlistGate(): Plugin {
	return {
		name: 'chungus-allowlist-gate',
		configureServer(server) {
			// The network-access switch, enforced the only way a dev server can enforce it.
			// A listening address is fixed for the life of a process, so Vite cannot move
			// its socket the way the Bun server does; if it followed the switch at startup
			// instead, turning the switch on would leave :1420 stuck on loopback with no
			// way back short of restarting dev. So it always binds the LAN and hangs up
			// here, at the socket, before a byte of HTTP is read: a device on the network
			// gets a dead connection either way, and the switch works live in both
			// directions. It must never answer with a page instead, not even one refusing
			// the device, because saying "ChungusHub is not open to you" still says
			// ChungusHub is here, and having nothing to find is the whole point of the
			// switch. A device it closed the door on is not a knock worth recording either.
			server.httpServer?.on('connection', (socket) => {
				const ip = socket.remoteAddress;
				if (!ip || LOOPBACK.has(normalizeIp(ip))) return;
				if (!networkAccessOn()) socket.destroy();
			});
			// Middlewares added here run before Vite's internal ones, including the
			// /api, /files, /ws proxy, so nothing is served or proxied past this check.
			server.middlewares.use((req, res, next) => {
				const ip = req.socket.remoteAddress;
				if (!isAllowed(ip)) {
					const shown = ip ? normalizeIp(ip) : 'unknown';
					// A device Vite turns away never reaches the Bun process, so report
					// the knock and the Settings → Security waiting list sees it in dev
					// too. Fire-and-forget: the 403 must render even with Bun down.
					fetch(`${BACKEND}/api/access/record-denied`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ ip: shown })
					}).catch(() => {});
					res.statusCode = 403;
					res.setHeader('content-type', 'text/html');
					res.end(deniedPage(shown));
					return;
				}
				// Bounce locked page loads to Bun's unlock page (proxied below). Only
				// top-level documents; /unlock, /api, /files and /ws answer to Bun itself.
				const url = req.url ?? '/';
				const isDoc = req.headers['sec-fetch-dest']
					? req.headers['sec-fetch-dest'] === 'document'
					: String(req.headers.accept ?? '').includes('text/html');
				const proxied = ['/unlock', '/api', '/files', '/ws'].some((p) => url.startsWith(p));
				if (isDoc && !proxied && needsUnlock(req)) {
					res.statusCode = 302;
					res.setHeader('location', '/unlock');
					res.end();
					return;
				}
				next();
			});
			// WebSocket upgrades (Vite HMR and the proxied /ws) bypass the middleware
			// stack, so gate them on the raw HTTP server.
			server.httpServer?.prependListener('upgrade', (req, socket) => {
				if (!isAllowed(req.socket.remoteAddress)) socket.destroy();
			});
		}
	};
}

// package.json is the only place a version is stated and it is never served to
// the browser, so the number is baked into the client bundle here and read back through
// src/lib/version.ts. Unlike the compiled server (server/version.ts) the client always goes
// through a build, dev included, so there is no state in which it has to guess.
const appVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }).version;
if (!appVersion) throw new Error('package.json has no "version"');

export default defineConfig({
	define: {
		CHUNGUS_VERSION: JSON.stringify(appVersion),
		// Dev only: the client opens its socket straight at the Bun server rather than through
		// the proxy below, and this is the only way it can know which port that is. See `wsUrl`
		// in src/lib/services/transport.ts for why that request skips the proxy.
		CHUNGUS_SERVER_PORT: JSON.stringify(PORT)
	},
	plugins: [
		tailwindcss(),
		sveltekit(),
		allowlistGate()
	],
	clearScreen: false,
	// Every runtime dependency, so the prebundle happens at server startup. Left to be
	// discovered, a bare import is found mid page load: Vite holds those requests until
	// esbuild is done and then force-reloads the page under whatever was already running.
	optimizeDeps: {
		include: [
			'dompurify',
			'gpt-tokenizer/encoding/cl100k_base',
			'gpt-tokenizer/encoding/o200k_base',
			'marked',
			'svelte-dnd-action'
		]
	},
	server: {
		port: 1420,
		strictPort: true,
		// The settings file's `openBrowser`, honoured here rather than by the Bun server: in dev
		// the app somebody looks at is this port (hot reload, no build step), and Vite opens it
		// once it is actually listening. The Bun half runs under `--watch` and deliberately opens
		// nothing (server/index.ts), so a launcher start is one tab at the right address.
		open: OPEN_BROWSER,
		// Always bound to the LAN so a phone can load the live, hot-reloading app at
		// http://<this-PC-ip>:1420 (no build step). Who actually gets served is
		// allowlistGate()'s business: the network-access switch and the IP allowlist
		// both live there, and both answer live. See the note in configureServer for
		// why this one cannot follow the switch itself.
		host: true,
		// From source both of these sit inside the repo, so Vite's recursive watcher picks
		// them up: every image upload and every snapshot would churn thousands of file
		// events through a watcher that has nothing to do with them, and a watched folder
		// is also a folder Windows will not let anything rename. Neither holds a module.
		watch: { ignored: ['**/user-data/**', '**/backups/**'] },
		// In dev the frontend is served by Vite (instant HMR, no build step).
		// The backend (DB / files / LLM / live-sync WebSocket) still runs on the
		// Bun server; these routes are proxied there so the app behaves exactly
		// like production, which serves everything from one origin.
		// xfwd forwards the device's real IP so the Bun server's allowlist and
		// password gates work identically through the dev proxy.
		proxy: {
			'/api': { target: BACKEND, changeOrigin: true, xfwd: true },
			'/files': { target: BACKEND, changeOrigin: true, xfwd: true },
			'/unlock': { target: BACKEND, changeOrigin: true, xfwd: true },
			// Here so :1420 answers the app's whole route surface, not because the client
			// rides it: in dev the socket goes straight at the Bun port (`wsUrl`).
			'/ws': { target: BACKEND, changeOrigin: true, ws: true, xfwd: true }
		}
	}
});
