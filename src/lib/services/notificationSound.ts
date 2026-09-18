/**
 * The one place a notification tone is played.
 *
 * Web Audio rather than an `<audio>` element, for a reason that is not taste: the nine
 * bundled tones span 23 dB as published and the quiet ones have to be amplified to sit with
 * the rest, which `HTMLMediaElement.volume` cannot do at all (it only attenuates, capped at
 * 1). A `GainNode` can, and the corrections live with the tones in config/sound-events.ts.
 *
 * The context and the gesture that unlocks it are shared with the soundscape
 * (services/audioContext.ts); a play that finds it still suspended says so once rather than
 * swallowing it.
 */
import { toastStore } from '$lib/stores/toast.svelte';
import { audioSettingsStore } from '$lib/stores/audio-settings.svelte';
import { ensureRunning, fetchAudioBuffer } from '$lib/services/audioContext';
import { toneGain, toneUrl, type SoundEventId, type ToneId } from '$lib/config/sound-events';

let blockedWarned = false;
let loadWarned = false;
/** The tone still sounding, so the next one replaces it instead of piling on top. Auditioning
 *  is a run of taps and the longest tone here runs four and a half seconds, so without this
 *  the chip grid plays chords. */
let playing: AudioBufferSourceNode | null = null;
const buffers = new Map<ToneId, AudioBuffer>();
const loading = new Map<ToneId, Promise<AudioBuffer | null>>();

function loadTone(ac: AudioContext, tone: ToneId): Promise<AudioBuffer | null> {
	const cached = buffers.get(tone);
	if (cached) return Promise.resolve(cached);

	let inflight = loading.get(tone);
	if (!inflight) {
		// A tone lives under `static/`, where a path that 404s is answered with the app shell
		// at 200 instead, which is why `fetchAudioBuffer` judges the payload by its bytes.
		inflight = fetchAudioBuffer(ac, toneUrl(tone))
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
	const ac = await ensureRunning();
	if (!ac) {
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
