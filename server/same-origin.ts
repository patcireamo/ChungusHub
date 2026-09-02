/**
 * Whether a request is one of this app's own pages talking to it, or another site's.
 *
 * The server listens on a guessable address on the machine its reader browses from, and a
 * browser attaches whatever it holds for that address (the session cookie, the loopback
 * reachability itself) to a cross-site request as readily as to a same-site one. Without a
 * check here every page open in that browser can drive the API and the socket: the answer
 * stays unreadable to the caller, but the write lands.
 */

function parse(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

/**
 * The rule for a state-changing `/api/` call: it must come from a page on this exact origin.
 *
 * `Sec-Fetch-Site` is what answers it, because the browser computes it against the URL the
 * page actually asked for and the dev proxy cannot disturb that. Comparing `Origin` to `Host`
 * directly would refuse every request in dev: the proxy rewrites `Host` to the Bun port
 * (`changeOrigin`) and forwards `Origin` still pointing at Vite's. That comparison is the
 * fallback for a browser too old to send the header, and it is exact, port included.
 *
 * Neither header means the caller is not a browser: there is nothing ambient to confuse, so
 * there is nothing to refuse. A present but opaque `Origin` (a sandboxed frame sends the
 * literal `null`) parses to nothing and matches nothing.
 */
export function fromOurOwnOrigin(headers: Headers): boolean {
	const site = headers.get('sec-fetch-site');
	if (site !== null) return site === 'same-origin';
	const origin = headers.get('origin');
	if (origin === null) return true;
	const host = headers.get('host');
	return !!host && parse(origin)?.host === host;
}

/**
 * The rule for the WebSocket upgrade, which is port-blind where the one above is not: in dev
 * the socket deliberately skips the proxy and connects straight to the Bun port from a page
 * Vite serves on another one (`wsUrl` in src/lib/services/transport.ts), so it is legitimately
 * cross-origin and `Sec-Fetch-Site` says so. Same host is the most this can ask for, and it is
 * enough for what it refuses: a page served by another host.
 *
 * The residue is a page served by this same host on another port, which on a LAN install means
 * another service on the machine ChungusHub runs on.
 */
export function fromOurOwnHost(headers: Headers): boolean {
	const origin = headers.get('origin');
	if (origin === null) return true;
	const host = headers.get('host');
	if (host === null) return false;
	const asked = parse(`http://${host}`)?.hostname;
	return !!asked && asked === parse(origin)?.hostname;
}
