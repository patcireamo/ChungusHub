/**
 * The one place a notification tone is played.
 *
 * Web Audio rather than an `<audio>` element, for a reason that is not taste: the nine
 * bundled tones span 23 dB as published and the quiet ones have to be amplified to sit with
 * the rest, which `HTMLMediaElement.volume` cannot do at all (it only attenuates, capped at
 * 1). A `GainNode` can, and the corrections live with the tones in config/sound-events.ts.
 *
 * Every browser refuses to make noise until the reader has interacted with the page, and a
 * refusal is silent: the context simply stays suspended and nothing is heard. So the context
 * is resumed from any gesture while sounds are on, and a play that finds it still suspended
 * says so once rather than swallowing it.
 */
import { toastStore } from '$lib/stores/toast.svelte';
import { audioSettingsStore } from '$lib/stores/audio-settings.svelte';
import { toneGain, toneUrl, type SoundEventId, type ToneId } from '$lib/config/sound-events';

let ctx: AudioContext | null = null;
let bound = false;
let blockedWarned = false;
let loadWarned = false;
/** The tone still sounding, so the next one replaces it instead of piling on top. Auditioning
 *  is a run of taps and the longest tone here runs four and a half seconds, so without this
 *  the chip grid plays chords. */
let playing: AudioBufferSourceNode | null = null;
const buffers = new Map<ToneId, AudioBuffer>();
const loading = new Map<ToneId, Promise<AudioBuffer | null>>();

/** Created on the first gesture or the first play, never at boot: an AudioContext built
 *  before any interaction starts suspended and is noise in the console for a reader who
 *  never turns sounds on. */
function context(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (!ctx) ctx = new AudioContext();
	return ctx;
}

function wake(): void {
	// Nothing is created for a reader who has sounds off; enabling them is itself a press,
	// so the next gesture after that opens the context in time.
	if (!ctx && !audioSettingsStore.enabled) return;
	const ac = context();
	if (ac && ac.state !== 'running') void ac.resume();
}

/**
 * Called once at boot. The visibility arm is not decoration: a phone suspends the context
 * while the app is in the background and a page that comes back to a suspended context is
 * silent until the reader happens to touch something.
 */
export function initNotificationSounds(): void {
	if (bound || typeof document === 'undefined') return;
	bound = true;
	document.addEventListener('pointerdown', wake, { capture: true, passive: true });
	document.addEventListener('keydown', wake, { capture: true });
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') wake();
	});
}

/** An ID3v2 tag or a bare MPEG frame sync, which is how every file in `static/sounds/`
 *  starts. Enough to tell audio from the app shell, which is the only thing this has to
 *  tell apart; the decoder judges the rest. */
function looksLikeMp3(bytes: ArrayBuffer): boolean {
	if (bytes.byteLength < 3) return false;
	const head = new Uint8Array(bytes, 0, 3);
	if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true;
	return head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
}

function loadTone(ac: AudioContext, tone: ToneId): Promise<AudioBuffer | null> {
	const cached = buffers.get(tone);
	if (cached) return Promise.resolve(cached);

	let inflight = loading.get(tone);
	if (!inflight) {
		const url = toneUrl(tone);
		// `no-store` because a path that 404s is answered with the app shell at 200 (below),
		// and a browser that asked for a tone before it shipped would otherwise keep serving
		// itself that HTML from its own cache long after the file arrived.
		inflight = fetch(url, { cache: 'no-store' })
			.then(async (response) => {
				if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
				const bytes = await response.arrayBuffer();
				// The payload is checked rather than the content-type header: a missing file
				// does not 404 here, since both the Bun server and Vite answer an unknown path
				// with the app shell at 200, and the header is not reliably readable anyway.
				// Without this the decoder is handed HTML and blames the tone for a file that
				// was never there.
				if (!looksLikeMp3(bytes)) {
					const head = new TextDecoder().decode(bytes.slice(0, 32)).replace(/\s+/g, ' ').trim();
					throw new Error(
						`${url} answered ${response.status} with ${bytes.byteLength} bytes that are not MP3: "${head}"`
					);
				}
				return bytes;
			})
			.then((bytes) => ac.decodeAudioData(bytes))
			.then((buffer) => {
				buffers.set(tone, buffer);
				return buffer;
			})
			.catch((error: unknown) => {
				console.error(`Notification tone "${tone}" could not be loaded`, error);
				if (!loadWarned) {
					loadWarned = true;
					// The file ships with the app and is served from this same origin, so the one
					// thing that realistically stands between them is a download manager
					// extension, which claims media URLs before the page can read them.
					toastStore.error(
						`Couldn't load the "${tone}" sound. A download manager extension may be taking it before the app gets it.`
					);
				}
				return null;
			});
		loading.set(tone, inflight);
		void inflight.finally(() => loading.delete(tone));
	}
	return inflight;
}

async function playTone(tone: ToneId, volume: number): Promise<void> {
	const ac = context();
	if (!ac) return;
	if (ac.state !== 'running') {
		try {
			await ac.resume();
		} catch {
			// Reported below on the state, which is the condition that actually matters.
		}
	}
	if (ac.state !== 'running') {
		if (!blockedWarned) {
			blockedWarned = true;
			toastStore.warning('Your browser is blocking sound. Play a tone from Settings → Audio to allow it.');
		}
		return;
	}

	const buffer = await loadTone(ac, tone);
	if (!buffer) return;

	if (playing) {
		// Already ended is the common case, and stopping a finished node throws nothing, but
		// a node that never started does.
		try {
			playing.stop();
		} catch {
			// Nothing was sounding, which is the outcome this asked for anyway.
		}
	}

	const source = ac.createBufferSource();
	source.buffer = buffer;
	const gain = ac.createGain();
	// The tone's own correction and the reader's slider are one multiplication. Every tone's
	// peak stays under full scale at volume 1, so this never clips.
	gain.gain.value = volume * toneGain(tone);
	source.connect(gain).connect(ac.destination);
	source.onended = () => {
		if (playing === source) playing = null;
	};
	playing = source;
	source.start();
}

/**
 * Play `tone` because the reader asked to hear it. Always plays: it is a press, so it is
 * also the interaction that opens the audio context on a device that demands one, which is
 * why choosing a tone and hearing it are the same gesture on the Audio page.
 */
export function previewTone(tone: ToneId, volume: number): void {
	void playTone(tone, volume);
}

/**
 * Play whatever `event` is set to, if anything, and only if the reader is not looking.
 *
 * `hasFocus()` is read at the moment of the call rather than remembered, which is what makes
 * a frozen tab safe: a phone that suspended the page mid-reply resumes it after the reader
 * has already come back, and the window has focus by then, so the sound that would have
 * arrived minutes late does not arrive at all.
 */
export function notifySound(event: SoundEventId): void {
	if (typeof document === 'undefined') return;
	if (!audioSettingsStore.enabled) return;
	if (audioSettingsStore.timing === 'away' && document.hasFocus()) return;
	const tone = audioSettingsStore.toneFor(event);
	if (!tone) return;
	void playTone(tone, audioSettingsStore.volume);
}
