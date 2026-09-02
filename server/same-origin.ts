/**
 * Whether a request is one of this app's own pages talking to it, or another site's.
 *
 * The server listens on a guessable address on the machine its reader browses from, and a
 * browser attaches whatever it holds for that address (the session cookie, the loopback
 * reachability itself) to a cross-site request as readily as to a same-site one. Without a
 * check here every page open in that browser can drive the API and the socket: the answer
 * stays unreadable to the caller, but the write lands.
 *
 * Three questions, in the order something has to get past them: which page sent this, which
 * host that page thinks it reached, and whether that host is a name this server answers to at
 * all. The last one is here because it is the same defence: it catches the case where the first
 * two are satisfied honestly and still wrong.
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

/**
 * Whether the name a request was addressed to is one this server answers as.
 *
 * This closes what neither rule above can. A name the attacker registered and pointed at this
 * machine is same-origin to the browser as well: `Sec-Fetch-Site` says `same-origin`, `Origin`
 * and `Host` agree, and every comparison passes, because from the browser's side nothing is
 * being faked. What gives it away is the name itself, which the browser sends verbatim and a
 * page cannot choose.
 *
 * An address is always ours. A browser sends one only because the reader typed it or a page
 * asked for it directly, and neither is a name somebody registered; a page that fetches this
 * address instead is refused by `fromOurOwnOrigin` before it gets here. `localhost` and `.local`
 * cannot be registered either. Everything else is a real name somebody owns, and the only one
 * that can be trusted is a name this install was told to answer to.
 */
export function isKnownHost(host: string | null, allowed: ReadonlySet<string>): boolean {
	// No name was sent, so nothing was claimed: not a browser, and not this attack.
	if (host === null) return true;
	const name = parse(`http://${host}`)?.hostname?.toLowerCase();
	if (!name) return false;
	// An IPv6 literal arrives bracketed; an IPv4 one is the only shape a hostname cannot take,
	// since a name whose last label is a number is not a name a registrar will sell.
	if (name.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
	if (name === 'localhost' || name.endsWith('.localhost')) return true;
	if (name.endsWith('.local')) return true;
	return allowed.has(name);
}
