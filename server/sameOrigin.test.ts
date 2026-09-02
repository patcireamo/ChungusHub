/**
 * Which requests count as this app's own.
 *
 * The failure it pins is the whole chain: with no check, a page the reader happens to have
 * open in another tab can post to the API and open the socket, because the server sits at a
 * guessable address on that same machine and the browser attaches whatever it holds for it.
 *
 * The two rules differ in one thing only, and the dev proxy is why. `/api/` goes through it,
 * which rewrites `Host` to the Bun port and leaves `Origin` on Vite's, so `Sec-Fetch-Site` is
 * the only header that still answers truthfully there. The socket skips the proxy and lands
 * on the Bun port from a page served on another one, so it is legitimately cross-origin and
 * can ask for no more than the same host.
 */
import { describe, test, expect } from 'bun:test';
import { fromOurOwnHost, fromOurOwnOrigin } from './same-origin';

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

	test('a browser too old to send the header falls back to an exact origin', () => {
		expect(fromOurOwnOrigin(headers({ origin: `http://${OURS}` }))).toBe(true);
		expect(fromOurOwnOrigin(headers({ origin: `https://${OURS}` }))).toBe(true);
		expect(fromOurOwnOrigin(headers({ origin: 'http://app.local:1420' }))).toBe(false);
		expect(fromOurOwnOrigin(headers({ origin: 'http://app.local' }))).toBe(false);
		expect(fromOurOwnOrigin(headers({ origin: 'http://app.local.evil.example' }))).toBe(false);
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
