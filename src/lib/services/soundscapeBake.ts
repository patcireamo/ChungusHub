/**
 * Baking a recording's placement and loudness boost into its loop, so whatever plays it has no
 * filter, no reverb and no gain above one left to run (services/soundscapePlayer.svelte.ts).
 *
 * The render keeps only what comes out after a preroll as long as the reverb tail, rotated back
 * to the loop's own start, so what crosses the wrap is already inside the loop and the result
 * loops as seamlessly as its source. The render's first pass would drop the tail at every wrap.
 */
import type { BufferFactory } from '$lib/services/loopBuffer';

/** A wall takes the top off a sound without taking it away: a shelf, never a lowpass, which
 *  would turn every recording into the same submerged rumble whatever it started as. */
const WALL_HZ = 1000;
const WALL_CUT_DB = -15;
/** Open ground takes level off the sound that arrives straight and hands it back as space:
 *  distance is that ratio far more than it is loudness. */
const DISTANT_DRY = 0.42;
const DISTANT_SEND = 0.5;
/** The room is seconds of decaying noise drawn per channel, so its tail has width, and it is
 *  lowpassed on the way out because bare noise is brighter than any room and reads as hiss. */
const ROOM_SECONDS = 2.4;
const ROOM_DECAY = 2.6;
const ROOM_TONE_HZ = 2400;
/** Long enough for the shelf and the lowpass to forget that the render began in silence. */
const SETTLE_SECONDS = 0.01;
/** What a baked loop is held under, so encoding it to 16 bits can never clip. */
export const PEAK_CEILING = 0.97;

export interface Placement {
	muffled: boolean;
	distant: boolean;
}

export function roomLength(sampleRate: number): number {
	return Math.max(1, Math.floor(sampleRate * ROOM_SECONDS));
}

export function buildImpulse(factory: BufferFactory, sampleRate: number, length: number): AudioBuffer {
	const buffer = factory.createBuffer(2, length, sampleRate);
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const data = buffer.getChannelData(channel);
		for (let i = 0; i < length; i++) {
			data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** ROOM_DECAY;
		}
	}
	return buffer;
}

/** Rotate the `length` samples after `preroll` in place, `out[(i + p) % length] = data[preroll + i]`
 *  with `p = preroll % length`, so index k holds what came out while the source was at k. */
export function rotateToLoopStart(data: Float32Array, preroll: number, length: number): Float32Array {
	const span = data.subarray(preroll, preroll + length);
	const shift = length > 0 ? preroll % length : 0;
	if (shift === 0) return span;
	const tail = span.slice(length - shift);
	span.copyWithin(shift, 0, length - shift);
	span.set(tail, 0);
	return span;
}

/** Multiply every channel by `gain`, or by less where that would take a sample past `ceiling`,
 *  and return the gain actually applied. */
export function applyGainWithin(
	channels: readonly Float32Array[],
	gain: number,
	ceiling = PEAK_CEILING
): number {
	let peak = 0;
	for (const data of channels) {
		for (let i = 0; i < data.length; i++) {
			const magnitude = Math.abs(data[i]);
			if (magnitude > peak) peak = magnitude;
		}
	}
	const applied = peak * gain > ceiling ? ceiling / peak : gain;
	if (applied !== 1) {
		for (const data of channels) {
			for (let i = 0; i < data.length; i++) data[i] *= applied;
		}
	}
	return applied;
}

export interface BakedLoop {
	/** The buffer the channels live in, which after a render is longer than the loop. */
	owner: AudioBuffer;
	/** Exactly one loop per channel. */
	channels: Float32Array[];
	/** What the samples were multiplied by in the end, the ceiling included. */
	bakedGain: number;
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
	return Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
}

/** A loop standing nowhere in particular is not rendered at all: its samples are scaled in place. */
export async function bakeLoop(loop: AudioBuffer, placement: Placement, boost: number): Promise<BakedLoop> {
	if (!placement.muffled && !placement.distant) {
		const channels = channelsOf(loop);
		return { owner: loop, channels, bakedGain: applyGainWithin(channels, boost) };
	}

	const rate = loop.sampleRate;
	const length = loop.length;
	const room = placement.distant ? roomLength(rate) : 0;
	const preroll = room + Math.ceil(rate * SETTLE_SECONDS);
	// The room has width of its own, so a mono recording standing far off comes back stereo.
	const channelCount = placement.distant ? Math.max(2, loop.numberOfChannels) : loop.numberOfChannels;
	const ctx = new OfflineAudioContext(channelCount, preroll + length, rate);

	const source = ctx.createBufferSource();
	source.buffer = loop;
	source.loop = true;
	const boosted = ctx.createGain();
	boosted.gain.value = boost;
	if (placement.muffled) {
		const wall = ctx.createBiquadFilter();
		wall.type = 'highshelf';
		wall.frequency.value = WALL_HZ;
		wall.gain.value = WALL_CUT_DB;
		source.connect(wall).connect(boosted);
	} else {
		source.connect(boosted);
	}
	const dry = ctx.createGain();
	dry.gain.value = placement.distant ? DISTANT_DRY : 1;
	boosted.connect(dry).connect(ctx.destination);
	if (placement.distant) {
		const send = ctx.createGain();
		send.gain.value = DISTANT_SEND;
		const reverb = ctx.createConvolver();
		reverb.buffer = buildImpulse(ctx, rate, room);
		const tone = ctx.createBiquadFilter();
		tone.type = 'lowpass';
		tone.frequency.value = ROOM_TONE_HZ;
		boosted.connect(send).connect(reverb).connect(tone).connect(ctx.destination);
	}
	source.start(0);

	const rendered = await ctx.startRendering();
	const channels = channelsOf(rendered).map((data) => rotateToLoopStart(data, preroll, length));
	return { owner: rendered, channels, bakedGain: boost * applyGainWithin(channels, 1) };
}
