import { describe, expect, test } from 'bun:test';
import {
	buildLoopBuffer,
	CROSSFADE_SECONDS,
	LOOP_SECONDS,
	type BufferFactory
} from './loopBuffer';

/**
 * Enough of an AudioBuffer for the arithmetic: the function reads channel counts, lengths and
 * sample arrays and nothing else. A real one only exists inside a browser's audio thread, and
 * what has to be right here is which sample lands where.
 */
function fakeBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
	const data = Array.from({ length: channels }, () => new Float32Array(length));
	return {
		numberOfChannels: channels,
		length,
		sampleRate,
		duration: length / sampleRate,
		getChannelData: (ch: number) => data[ch]
	} as unknown as AudioBuffer;
}

const factory: BufferFactory = { createBuffer: fakeBuffer };

const RATE = 1000;
const FADE = CROSSFADE_SECONDS * RATE;

/** A ramp, so every sample says exactly which source index it came from. */
function ramp(length: number, channels = 1): AudioBuffer {
	const buffer = fakeBuffer(channels, length, RATE);
	for (let ch = 0; ch < channels; ch++) {
		const data = buffer.getChannelData(ch);
		for (let i = 0; i < length; i++) data[i] = i;
	}
	return buffer;
}

describe('buildLoopBuffer', () => {
	test('a seamless loop is one fade shorter than its window', () => {
		const out = buildLoopBuffer(factory, ramp(10_000), true);
		expect(out.length).toBe(10_000 - FADE);
	});

	// The whole point of the switch: play the result end to end and the wrap must be as
	// continuous as any other pair of samples. With a ramp source that is checkable exactly,
	// since the last sample has to land one step below the first.
	test('a seamless loop wraps without a step', () => {
		const out = buildLoopBuffer(factory, ramp(10_000), true).getChannelData(0);
		const wrap = out[0] - out[out.length - 1];
		expect(wrap).toBeGreaterThan(0.5);
		expect(wrap).toBeLessThan(1.5);
	});

	// Everything before the crossfade is the recording untouched, just started later. A body
	// that drifted by a sample would be a resampling bug hiding behind a correct-looking wrap.
	test('the body is the source shifted past the fade', () => {
		const out = buildLoopBuffer(factory, ramp(10_000), true).getChannelData(0);
		const bodyEnd = out.length - FADE;
		expect(out[0]).toBe(FADE);
		expect(out[1]).toBe(FADE + 1);
		expect(out[bodyEnd - 1]).toBe(FADE + bodyEnd - 1);
	});

	test('both channels are built, not just the first', () => {
		const out = buildLoopBuffer(factory, ramp(10_000, 2), true);
		expect(out.numberOfChannels).toBe(2);
		expect(Array.from(out.getChannelData(1).slice(0, 3))).toEqual(
			Array.from(out.getChannelData(0).slice(0, 3))
		);
	});

	// Equal power costs at most 3 dB where the two halves happen to agree, which is the trade
	// for not dipping where they do not. Anything past that would be a curve that clips.
	test('the crossfade never gains more than 3 dB', () => {
		const flat = fakeBuffer(1, 10_000, RATE);
		flat.getChannelData(0).fill(1);
		const out = buildLoopBuffer(factory, flat, true).getChannelData(0);
		expect(Math.max(...out)).toBeLessThanOrEqual(Math.SQRT2 + 1e-6);
	});

	test('a recording longer than the window is cut down to it', () => {
		const out = buildLoopBuffer(factory, ramp(LOOP_SECONDS * RATE * 3), true);
		expect(out.length).toBe(LOOP_SECONDS * RATE - FADE);
	});

	// Off, the recording is handed over as it is. A file inside the window is not copied at
	// all, which is what keeps the switch from costing memory it does not need.
	test('without seamless a short recording is passed straight through', () => {
		const src = ramp(10_000);
		expect(buildLoopBuffer(factory, src, false)).toBe(src);
	});

	test('without seamless a long recording is only trimmed to the window', () => {
		const out = buildLoopBuffer(factory, ramp(LOOP_SECONDS * RATE * 3), false).getChannelData(0);
		expect(out.length).toBe(LOOP_SECONDS * RATE);
		expect(out[0]).toBe(0);
		expect(out[out.length - 1]).toBe(LOOP_SECONDS * RATE - 1);
	});

	// Too few samples to fade across: crossfading there would be a click of its own rather
	// than a cure for one.
	test('a recording too short to fade is left alone', () => {
		const src = ramp(200);
		expect(buildLoopBuffer(factory, src, true)).toBe(src);
	});
});
