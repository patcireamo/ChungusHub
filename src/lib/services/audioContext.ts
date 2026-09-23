/**
 * The app's one AudioContext, and the gesture that unlocks it.
 *
 * Both things that make sound through Web Audio (notification tones, and the soundscape outside
 * Gecko) share it: a browser caps how many contexts a page may open, and the unlock below is one
 * piece of behaviour, so a second copy of it would be a second thing to keep in step.
 *
 * Every browser refuses to make noise until the reader has interacted with the page, and the
 * refusal is silent: the context simply stays suspended and nothing is heard. `wakeAudio` is
 * bound to any gesture, and `ensureRunning` reports rather than swallows, so a caller can say
 * what is wrong instead of playing nothing.
 */

let ctx: AudioContext | null = null;
let bound = false;
/** Put to sleep on purpose by the soundscape, so a gesture anywhere in the app leaves it asleep. */
let resting = false;

/** Long enough for any real download from this same origin; past it the request has stalled. */
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Created on the first thing that actually needs it, never at boot: a context built before
 * any interaction starts suspended and is console noise for a reader who never turns sound on.
 *
 * `playback`, not the default: Chromium answers it with its deep-buffer output path, which has
 * tens of milliseconds of slack where the default has a few. Firefox ignores the hint entirely,
 * which is one reason the soundscape plays through media elements there instead.
 */
export function audioContext(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (!ctx) ctx = new AudioContext({ latencyHint: 'playback' });
	return ctx;
}

/**
 * iOS silences Web Audio under the ringer switch unless the page claims playback, so the mix
 * claims it while it runs and gives it back when it stops: left standing, a notification tone
 * would cut off the reader's music and ring on a phone set to silent. Only Safari has this.
 */
export function claimMediaPlayback(on: boolean): void {
	if (typeof navigator === 'undefined') return;
	const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
	if (!session) return;
	try {
		session.type = on ? 'playback' : 'auto';
	} catch {
		// A document with no page cannot hold a session, and had nothing to play anyway.
	}
}

/**
 * Resume a context that already exists, unless it was put to rest on purpose. Deliberately
 * never creates one: that is what keeps a reader who has all sound off from paying for an audio
 * graph on every click of the app.
 */
export function wakeAudio(): void {
	if (ctx && !resting && ctx.state !== 'running') void ctx.resume().catch(() => {});
}

/**
 * Resume the context from inside the press that asked for sound, synchronously: WebKit lets a
 * context start only within the gesture itself.
 */
export function resumeAudio(): void {
	resting = false;
	if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
}

/**
 * Let the context stop driving the audio hardware, which a phone otherwise keeps awake for as
 * long as the page lives. Resolves once it has stopped, or could not.
 */
export async function restAudio(): Promise<void> {
	if (!ctx) return;
	resting = true;
	try {
		await ctx.suspend();
	} catch {
		// A closed context is as quiet as a suspended one.
	}
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

/**
 * How much of a recording to decode, when the caller only wants the front of it.
 *
 * Time maps onto bytes by proportion, exactly for constant bitrate and closely enough for the
 * rest. The tag at the head of the file rides inside the same share, which is one of the two
 * reasons the caller asks for more seconds than it means to keep; the other is that a VBR file
 * can spend its bitrate unevenly.
 */
export interface DecodePrefix {
	keepSeconds: number;
	totalSeconds: number;
}

function prefixOf(bytes: ArrayBuffer, prefix: DecodePrefix | undefined): ArrayBuffer {
	if (!prefix || !(prefix.totalSeconds > prefix.keepSeconds) || prefix.keepSeconds <= 0) {
		return bytes;
	}
	const wanted = Math.ceil(bytes.byteLength * (prefix.keepSeconds / prefix.totalSeconds));
	return wanted < bytes.byteLength ? bytes.slice(0, wanted) : bytes;
}

/** An answer that is not MP3 at all, which here is the download manager's signature above
 *  rather than a broken file, so it is the one failure worth naming that way. */
export class NotMp3Error extends Error {
	name = 'NotMp3Error';
}

async function readBytes(url: string, mode?: RequestCache): Promise<ArrayBuffer> {
	const response = await fetch(url, {
		cache: mode,
		signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined
	});
	if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
	return response.arrayBuffer();
}

/**
 * Fetch one bundled MP3, throwing with the reason when it is not one.
 *
 * The response is allowed to cache, since these files ship with the build and never change
 * under their own name, and re-downloading megabytes on every play buys nothing. What a cache
 * costs is that a bad answer would be kept too: the resident half of a
 * download manager claims any URL ending in a media extension and answers with 204 and no body
 * at all, so a payload that is not MP3 is fetched again past the cache before it is reported.
 */
export async function fetchAudioBytes(url: string): Promise<ArrayBuffer> {
	let bytes = await readBytes(url);
	if (!looksLikeMp3(bytes)) bytes = await readBytes(url, 'reload');
	if (!looksLikeMp3(bytes)) {
		const head = new TextDecoder().decode(bytes.slice(0, 32)).replace(/\s+/g, ' ').trim();
		throw new NotMp3Error(`${url} answered ${bytes.byteLength} bytes that are not MP3: "${head}"`);
	}
	return bytes;
}

/** Decode `bytes`, or only the front of them when the caller keeps only the front. */
export async function decodeAudioPrefix(
	ac: BaseAudioContext,
	bytes: ArrayBuffer,
	prefix?: DecodePrefix
): Promise<AudioBuffer> {
	const front = prefixOf(bytes, prefix);
	if (front !== bytes) {
		try {
			return await ac.decodeAudioData(front);
		} catch {
			// A prefix ends mid-frame and a decoder is entitled to refuse it. Falling back costs
			// the memory the prefix existed to save, once, which beats losing the recording.
		}
	}
	return ac.decodeAudioData(bytes);
}

export async function fetchAudioBuffer(
	ac: BaseAudioContext,
	url: string,
	prefix?: DecodePrefix
): Promise<AudioBuffer> {
	return decodeAudioPrefix(ac, await fetchAudioBytes(url), prefix);
}
