/**
 * Which requests count as this app's own.
 *
 * The failure it pins is the whole chain: with no check, a page the reader happens to have
 * open in another tab can post to the API and open the socket, because the server sits at a
 * guessable address on that same machine and the browser attaches whatever it holds for it.
 *
 * The two rules differ in one thing only, and the dev proxy is why. `/api/` goes through it,
 * which rewrites `Host` to the Bun port and leaves `Origin` on Vite's, so what answers there
 * is `Sec-Fetch-Site` when the browser sent one and the proxied host otherwise. The socket
 * skips the proxy and lands on the Bun port from a page served on another one, so it is
 * legitimately cross-origin and can ask for no more than the same host.
 */
import { describe, test, expect } from 'bun:test';
import { fromOurOwnHost, fromOurOwnOrigin, hostnameEntry, isKnownHost } from './same-origin';

const OURS = 'app.local:4242';

function headers(values: Record<string, string>): Headers {
	return new Headers({ host: OURS, ...values });
}

describe('fromOurOwnOrigin: what may change something over /api/', () => {
	test('the browser says same-origin', () => {
		expect(fromOurOwnOrigin(headers({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
	});

	test('another site, however it is dressed', () => {
		for (const site of ['cross-site', 'same-site', 'none']) {
			expect(fromOurOwnOrigin(headers({ 'sec-fetch-site': site }))).toBe(false);
		}
	});

	// The dev shape: Vite forwards the page's own origin and rewrites Host to the Bun port.
	// Trusting the comparison over the header here would refuse every request in dev.
	test('the dev proxy passes on what the browser computed', () => {
		expect(
			fromOurOwnOrigin(
				new Headers({
					host: 'localhost:4242',
					origin: 'http://192.168.1.5:1420',
					'sec-fetch-site': 'same-origin'
				})
			)
		).toBe(true);
	});

	// Browsers send Fetch Metadata only to HTTPS and localhost, so a phone on a plain-HTTP LAN
	// address always arrives here, and the comparison has to be exact.
	test('no Sec-Fetch-Site means an exact origin', () => {
		expect(fromOurOwnOrigin(headers({ origin: `http://${OURS}` }))).toBe(true);
		expect(fromOurOwnOrigin(headers({ origin: `https://${OURS}` }))).toBe(true);
		expect(fromOurOwnOrigin(headers({ origin: `HTTP://${OURS.toUpperCase()}` }))).toBe(true);
		expect(fromOurOwnOrigin(headers({ origin: 'http://app.local:1420' }))).toBe(false);
		expect(fromOurOwnOrigin(headers({ origin: 'http://app.local' }))).toBe(false);
		expect(fromOurOwnOrigin(headers({ origin: 'http://app.local.evil.example' }))).toBe(false);
	});

	// The phone in dev: no Sec-Fetch-Site, Host rewritten by the proxy, the page's own host in
	// X-Forwarded-Host. That header is only believed when the caller vouches for the proxy.
	test('behind a trusted proxy the forwarded host is the one compared', () => {
		const phone = new Headers({
			host: 'localhost:4242',
			origin: 'http://192.168.1.5:1420',
			'x-forwarded-host': '192.168.1.5:1420'
		});
		expect(fromOurOwnOrigin(phone, true)).toBe(true);
		expect(fromOurOwnOrigin(phone)).toBe(false);
		const forged = new Headers({
			host: 'localhost:4242',
			origin: 'http://evil.example',
			'x-forwarded-host': '192.168.1.5:1420'
		});
		expect(fromOurOwnOrigin(forged, true)).toBe(false);
		// A trusted peer that forwarded no host is a browser on the machine itself.
		expect(fromOurOwnOrigin(headers({ origin: `http://${OURS}` }), true)).toBe(true);
	});

	// A sandboxed frame is the shape an injected iframe takes, and it sends the literal string.
	test('an opaque origin is not ours', () => {
		expect(fromOurOwnOrigin(headers({ origin: 'null' }))).toBe(false);
		expect(fromOurOwnOrigin(headers({ origin: 'not a url' }))).toBe(false);
	});

	// Nothing ambient to confuse: no cookie is riding along and no browser sent it.
	test('a caller that is not a browser', () => {
		expect(fromOurOwnOrigin(headers({}))).toBe(true);
	});

	test('an origin with no host to check it against', () => {
		expect(fromOurOwnOrigin(new Headers({ origin: `http://${OURS}` }))).toBe(false);
	});
});

describe('fromOurOwnHost: what may open the socket', () => {
	test('the same host, whatever port the page came from', () => {
		expect(fromOurOwnHost(headers({ origin: `http://${OURS}` }))).toBe(true);
		expect(fromOurOwnHost(headers({ origin: 'http://app.local:1420' }))).toBe(true);
		expect(fromOurOwnHost(headers({ origin: 'https://app.local' }))).toBe(true);
	});

	test('another host', () => {
		expect(fromOurOwnHost(headers({ origin: 'http://evil.example' }))).toBe(false);
		expect(fromOurOwnHost(headers({ origin: 'http://app.local.evil.example' }))).toBe(false);
		expect(fromOurOwnHost(headers({ origin: 'null' }))).toBe(false);
	});

	test('an address rather than a name, on either side', () => {
		const ipv4 = new Headers({ host: '192.168.1.5:4242', origin: 'http://192.168.1.5:1420' });
		expect(fromOurOwnHost(ipv4)).toBe(true);
		const ipv6 = new Headers({ host: '[::1]:4242', origin: 'http://[::1]:1420' });
		expect(fromOurOwnHost(ipv6)).toBe(true);
		const mixed = new Headers({ host: '[::1]:4242', origin: 'http://192.168.1.5:1420' });
		expect(fromOurOwnHost(mixed)).toBe(false);
	});

	// Sec-Fetch-Site reads `same-site` for the dev socket, so it can only ever refuse
	// something the host comparison already allows. It is not consulted.
	test('what the browser calls it does not decide', () => {
		expect(
			fromOurOwnHost(headers({ origin: 'http://app.local:1420', 'sec-fetch-site': 'same-site' }))
		).toBe(true);
		expect(
			fromOurOwnHost(headers({ origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' }))
		).toBe(false);
	});

	test('a caller that is not a browser', () => {
		expect(fromOurOwnHost(headers({}))).toBe(true);
		expect(fromOurOwnHost(new Headers({ origin: `http://${OURS}` }))).toBe(false);
	});
});

describe('isKnownHost: which names this server answers to', () => {
	const allowed = new Set(['desk-pc', 'workshop.tail1234.ts.net']);

	test('an address is always ours, since no attacker can be handed one', () => {
		for (const host of ['127.0.0.1:4242', '192.168.0.10:4242', '100.64.0.3', '[::1]:4242', '[fe80::1]']) {
			expect(isKnownHost(host, allowed)).toBe(true);
		}
	});

	test('the names nobody can register', () => {
		for (const host of ['localhost:4242', 'localhost', 'chungus.localhost', 'desk-pc.local:4242']) {
			expect(isKnownHost(host, allowed)).toBe(true);
		}
	});

	test('a name the settings file adds, however it is capitalized', () => {
		expect(isKnownHost('desk-pc:4242', allowed)).toBe(true);
		expect(isKnownHost('WORKSHOP.Tail1234.TS.NET', allowed)).toBe(true);
	});

	// The whole point: from the browser's side this request is honest, so nothing else catches it.
	test('a name somebody registered and pointed here', () => {
		for (const host of [
			'preset-pack.example',
			'preset-pack.example:4242',
			'desk-pc.evil.example',
			'evil.example'
		]) {
			expect(isKnownHost(host, allowed)).toBe(false);
		}
	});

	// A name whose last label is a number is not one a registrar will sell, and the URL parser
	// refuses to read it as either a name or an address.
	test('a name dressed up as an address', () => {
		expect(isKnownHost('192.168.0.10.evil.example', allowed)).toBe(false);
		expect(isKnownHost('evil.1.2.3.4', allowed)).toBe(false);
		expect(isKnownHost('not a host', allowed)).toBe(false);
		expect(isKnownHost('', allowed)).toBe(false);
	});

	// The URL parser canonicalizes an address before the check sees it, so every spelling a
	// browser would turn into one is an address here, and one it refuses is not a host at all.
	test('an address in any spelling the browser canonicalizes', () => {
		for (const host of ['0x7f000001:4242', '127.1', '2130706433', '[0:0:0:0:0:0:0:1]:4242']) {
			expect(isKnownHost(host, allowed)).toBe(true);
		}
		for (const host of ['999.1.1.1', '[evil]:4242']) {
			expect(isKnownHost(host, allowed)).toBe(false);
		}
	});

	// A trailing dot is another name to the browser, so it is another name here.
	test('a known name dressed as another', () => {
		for (const host of ['workshop.tail1234.ts.net.', 'desk-pc.:4242', 'localhost.evil.example']) {
			expect(isKnownHost(host, allowed)).toBe(false);
		}
	});

	test('no name sent at all', () => {
		expect(isKnownHost(null, allowed)).toBe(true);
	});

	test('an empty settings list still leaves the install reachable', () => {
		const none: ReadonlySet<string> = new Set();
		expect(isKnownHost('192.168.0.10:4242', none)).toBe(true);
		expect(isKnownHost('localhost:4242', none)).toBe(true);
		expect(isKnownHost('workshop.tail1234.ts.net', none)).toBe(false);
	});
});

describe('hostnameEntry: a settings entry, spelled the way a browser will send it', () => {
	test('a name, however it is written', () => {
		expect(hostnameEntry(' Workshop.Tail1234.TS.NET ')).toBe('workshop.tail1234.ts.net');
		expect(hostnameEntry('wörkshop.example')).toBe('xn--wrkshop-90a.example');
		expect(hostnameEntry('[0:0:0:0:0:0:0:1]')).toBe('[::1]');
	});

	// Each of these matches no Host header, so kept it would be a line doing nothing.
	test('anything that is more than a name', () => {
		for (const entry of [
			'https://workshop.example',
			'workshop.example:4242',
			'workshop.example/app',
			'user@workshop.example',
			'a b',
			''
		]) {
			expect(hostnameEntry(entry)).toBeNull();
		}
	});

	// The whole point: an international name typed as written meets the punycode the browser sends.
	test('what it answers is what the gate will meet', () => {
		const allowed = new Set([hostnameEntry('wörkshop.example') as string]);
		expect(isKnownHost('XN--WRKSHOP-90A.example:4242', allowed)).toBe(true);
	});
});
