/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

/**
 * Minimal app-shell service worker: it makes the PWA installable and lets the
 * static assets load offline. API/WS/file requests always go to the network;
 * those are live data and must never be served stale.
 *
 * The bundled ambient recordings are the one exception under `/files/`, and they
 * are the exception because they are not the reader's data: they ship with the
 * build and cannot change under their own name while it is running. Treated as
 * live, a mix re-downloads megabytes on every play, which a phone hears as the
 * sound stuttering as it starts.
 */
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `chungushub-${version}`;
const PRECACHE = [...build, ...files];
const SOUNDS = '/files/sounds/';

/**
 * Cache-first, storing only an answer that is a whole recording.
 *
 * The resident half of a download manager claims any URL ending in a media
 * extension and answers with 204 and no body at all. Kept, that emptiness is
 * what every later play gets, with nothing left to ask the network: the
 * recording is then silent for good. So the status and the type are both
 * checked before anything is written, and never the fact that a response
 * arrived.
 */
async function soundFromCache(request: Request): Promise<Response> {
	const cache = await caches.open(CACHE);
	const cached = await cache.match(request);
	if (cached) return cached;

	const response = await fetch(request);
	const type = response.headers.get('content-type') ?? '';
	if (response.status === 200 && type.startsWith('audio/')) {
		await cache.put(request, response.clone());
	}
	return response;
}

sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	// Ahead of the never-cache list, since it sits under one of its prefixes.
	if (url.pathname.startsWith(SOUNDS)) {
		event.respondWith(soundFromCache(request));
		return;
	}

	// Never cache live data. Let it hit the network and fail loud if offline.
	if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/') || url.pathname === '/ws') {
		return;
	}

	// Cache-first for precached build assets; network-first for everything else.
	if (PRECACHE.includes(url.pathname)) {
		event.respondWith(
			caches.match(request).then((cached) => cached ?? fetch(request))
		);
		return;
	}

	event.respondWith(
		fetch(request).catch(() => caches.match(request).then((cached) => cached ?? caches.match('/')) as Promise<Response>)
	);
});
