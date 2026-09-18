/**
 * The app's one AudioContext, and the gesture that unlocks it.
 *
 * Both things that make sound (notification tones, the ambient soundscape) share it: a
 * browser caps how many contexts a page may open, and the unlock below is one piece of
 * behaviour, so a second copy of it would be a second thing to keep in step.
 *
 * Every browser refuses to make noise until the reader has interacted with the page, and the
 * refusal is silent: the context simply stays suspended and nothing is heard. `wakeAudio` is
 * bound to any gesture, and `ensureRunning` reports rather than swallows, so a caller can say
 * what is wrong instead of playing nothing.
 */

let ctx: AudioContext | null = null;
let bound = false;

/**
 * Created on the first thing that actually needs it, never at boot: a context built before
 * any interaction starts suspended and is console noise for a reader who never turns sound on.
 */
export function audioContext(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (!ctx) ctx = new AudioContext();
	return ctx;
}

/**
 * Resume a context that already exists. Deliberately never creates one: that is what keeps a
 * reader who has all sound off from paying for an audio graph on every click of the app.
 */
export function wakeAudio(): void {
	if (ctx && ctx.state !== 'running') void ctx.resume();
}

/**
 * Called once at boot. The visibility arm is not decoration: a phone suspends the context
 * while the app is in the background, and a page that comes back to a suspended context is
 * silent until the reader happens to touch something.
 */
export function initAudioUnlock(): void {
	if (bound || typeof document === 'undefined') return;
	bound = true;
	document.addEventListener('pointerdown', wakeAudio, { capture: true, passive: true });
	document.addEventListener('keydown', wakeAudio, { capture: true });
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') wakeAudio();
	});
}

/** The context, running, or null when the browser is still refusing to let it. */
export async function ensureRunning(): Promise<AudioContext | null> {
	const ac = audioContext();
	if (!ac) return null;
	if (ac.state !== 'running') {
		try {
			await ac.resume();
		} catch {
			// The state below is the condition that actually matters, resolved or not.
		}
	}
	return ac.state === 'running' ? ac : null;
}

/**
 * An ID3v2 tag or a bare MPEG frame sync, which is how every MP3 the app ships starts.
 *
 * Every one of them is served from this same origin, so the realistic reason a fetch comes
 * back as something else is a download manager: the resident half of one claims any URL
 * ending in a media extension, `fetch` to localhost included, and answers with 204 and no
 * body at all. The payload is therefore judged by its bytes and never by the content-type
 * header, which such an answer does not carry either.
 */
export function looksLikeMp3(bytes: ArrayBuffer): boolean {
	if (bytes.byteLength < 3) return false;
	const head = new Uint8Array(bytes, 0, 3);
	if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true;
	return head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
}

/** Fetch and decode one bundled MP3, throwing with the reason when it is not one. */
export async function fetchAudioBuffer(ac: AudioContext, url: string): Promise<AudioBuffer> {
	const response = await fetch(url, { cache: 'no-store' });
	if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
	const bytes = await response.arrayBuffer();
	if (!looksLikeMp3(bytes)) {
		const head = new TextDecoder().decode(bytes.slice(0, 32)).replace(/\s+/g, ' ').trim();
		throw new Error(
			`${url} answered ${response.status} with ${bytes.byteLength} bytes that are not MP3: "${head}"`
		);
	}
	return ac.decodeAudioData(bytes);
}
