/**
 * Turning a recording into something that can loop forever.
 *
 * Pure arithmetic over sample arrays, kept out of the player so it can be tested against a
 * buffer whose every sample is known (services/soundscapePlayer.svelte.ts owns the graph).
 */

/**
 * How much of a recording is looped.
 *
 * A decoded buffer is raw float samples, so one minute of stereo at 48 kHz is 23 MB and the
 * longest recording the app ships would be 114 MB on its own. A mix of five would be a phone
 * running out of memory, so the loop is a window rather than the whole file. Sixteen of the
 * shipped recordings are shorter than this and are used whole.
 */
export const LOOP_SECONDS = 60;

/** Long enough that the join is inaudible over broadband ambience, short enough that the
 *  recording is still mostly heard untouched. Capped at a quarter of short recordings. */
export const CROSSFADE_SECONDS = 2;

/** Below this a fade is too few samples to be a fade, and the seam is better left alone. */
const MIN_FADE_SAMPLES = 64;

/** What `buildLoopBuffer` needs of an AudioContext, so a test can hand it sample arrays. */
export interface BufferFactory {
	createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

function sliceBuffer(factory: BufferFactory, src: AudioBuffer, length: number): AudioBuffer {
	const out = factory.createBuffer(src.numberOfChannels, length, src.sampleRate);
	for (let ch = 0; ch < src.numberOfChannels; ch++) {
		out.getChannelData(ch).set(src.getChannelData(ch).subarray(0, length));
	}
	return out;
}

/**
 * The buffer a voice loops, built once per recording per loop shape.
 *
 * Seamless joins the window's end to its own beginning. The body is the source shifted past
 * its first `fade` samples, and the last `fade` samples hand over from the window's tail back
 * to that skipped head, so the final sample sits one sample before the first and the wrap is
 * continuous. Equal power (cos/sin) rather than linear, because two different moments of an
 * ambient recording are uncorrelated and a linear pair dips audibly halfway through every
 * wrap.
 *
 * Without seamless the window is taken as it is, and where the recording is longer than the
 * window the wrap is whatever those two moments happen to be: that audible join IS the
 * difference the switch names.
 */
export function buildLoopBuffer(
	factory: BufferFactory,
	src: AudioBuffer,
	seamless: boolean
): AudioBuffer {
	const windowLength = Math.min(src.length, Math.floor(LOOP_SECONDS * src.sampleRate));
	const fade = Math.min(
		Math.floor(CROSSFADE_SECONDS * src.sampleRate),
		Math.floor(windowLength / 4)
	);

	if (!seamless || fade < MIN_FADE_SAMPLES) {
		return windowLength === src.length ? src : sliceBuffer(factory, src, windowLength);
	}

	const loopLength = windowLength - fade;
	const out = factory.createBuffer(src.numberOfChannels, loopLength, src.sampleRate);
	for (let ch = 0; ch < src.numberOfChannels; ch++) {
		const from = src.getChannelData(ch);
		const to = out.getChannelData(ch);
		to.set(from.subarray(fade, fade + loopLength));
		// The curve spans the fade end to end: at k=0 it is entirely the tail, which is what
		// the body already wrote there, and at the last sample it is entirely the head. Anything
		// short of those two leaves a step at one edge of the fade or the other.
		for (let k = 0; k < fade; k++) {
			const x = (k / (fade - 1)) * (Math.PI / 2);
			to[loopLength - fade + k] = from[loopLength + k] * Math.cos(x) + from[k] * Math.sin(x);
		}
	}
	return out;
}
