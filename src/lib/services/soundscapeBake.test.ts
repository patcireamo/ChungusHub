import { describe, expect, test } from 'bun:test';
import { applyGainWithin, buildImpulse, PEAK_CEILING, roomLength, rotateToLoopStart } from './soundscapeBake';
import type { BufferFactory } from './loopBuffer';

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

function noise(length: number): Float32Array {
	return Float32Array.from({ length }, () => Math.random() * 2 - 1);
}

describe('rotateToLoopStart', () => {
	test('follows its formula for every sample', () => {
		for (const [preroll, length] of [
			[7, 20],
			[20, 20],
			[53, 20],
			[0, 20],
			[1, 1]
		]) {
			const rendered = noise(preroll + length);
			const original = rendered.slice();
			const out = rotateToLoopStart(rendered, preroll, length);
			const p = preroll % length;
			expect(out.length).toBe(length);
			for (let i = 0; i < length; i++) expect(out[(i + p) % length]).toBe(original[preroll + i]);
		}
	});

	// A looping source rendered with nothing in the way comes back as the source itself,
	// whatever the preroll: the rotation lines the render up with the loop's own start.
	test('a render of the bare loop comes back as the loop', () => {
		const length = 100;
		const source = noise(length);
		for (const preroll of [0, 1, 37, 100, 250, 999]) {
			const rendered = Float32Array.from({ length: preroll + length }, (_, t) => source[t % length]);
			expect(Array.from(rotateToLoopStart(rendered, preroll, length))).toEqual(Array.from(source));
		}
	});

	// The reason for the preroll: a filter carries state across the wrap, and a loop cut from
	// the render's first pass would start that state from silence every time around.
	test('what a filter carries across the wrap is already inside the loop', () => {
		const length = 500;
		const preroll = 2123;
		const a = 0.9;
		const source = noise(length);
		const filter = (count: number): Float32Array => {
			const out = new Float32Array(count);
			let state = 0;
			for (let t = 0; t < count; t++) {
				state = a * state + (1 - a) * source[t % length];
				out[t] = state;
			}
			return out;
		};
		const loop = rotateToLoopStart(filter(preroll + length), preroll, length);
		const steady = filter(length * 20).subarray(length * 19);
		for (let k = 0; k < length; k++) expect(loop[k]).toBeCloseTo(steady[k], 6);
		expect(loop[0]).toBeCloseTo(a * loop[length - 1] + (1 - a) * source[0], 6);
	});

	test('hands back a view on the render rather than a copy', () => {
		const rendered = noise(30);
		const out = rotateToLoopStart(rendered, 10, 20);
		expect(out.buffer).toBe(rendered.buffer);
		expect(out.byteOffset).toBe(10 * Float32Array.BYTES_PER_ELEMENT);
	});
});

describe('applyGainWithin', () => {
	test('applies the whole gain where there is headroom for it', () => {
		const data = Float32Array.from([0.4, -0.2, 0.1]);
		expect(applyGainWithin([data], 2)).toBe(2);
		expect(Array.from(data)).toEqual(Array.from(Float32Array.from([0.8, -0.4, 0.2])));
	});

	test('stops where the loudest sample meets the ceiling', () => {
		const data = Float32Array.from([0.8, -0.5]);
		const applied = applyGainWithin([data], 2);
		expect(applied).toBeCloseTo(PEAK_CEILING / 0.8, 6);
		expect(Math.max(...Array.from(data, Math.abs))).toBeCloseTo(PEAK_CEILING, 6);
	});

	// The seamless crossfade and the reverb can both push a loop past full scale on their own.
	test('pulls a loop already over the ceiling down even at unity', () => {
		const data = Float32Array.from([1.3, -0.6]);
		const applied = applyGainWithin([data], 1);
		expect(applied).toBeLessThan(1);
		expect(data[0]).toBeCloseTo(PEAK_CEILING, 6);
	});

	test('leaves a loop under the ceiling untouched at unity', () => {
		const data = Float32Array.from([0.5, -0.9]);
		const before = Array.from(data);
		expect(applyGainWithin([data], 1)).toBe(1);
		expect(Array.from(data)).toEqual(before);
	});

	test('reads the peak off every channel', () => {
		const left = Float32Array.from([0.1, 0.1]);
		const right = Float32Array.from([0.1, -0.5]);
		const applied = applyGainWithin([left, right], 4);
		expect(applied).toBeCloseTo(PEAK_CEILING / 0.5, 6);
		expect(left[0]).toBeCloseTo(0.1 * applied, 6);
	});

	test('silence takes any gain without dividing by zero', () => {
		const data = new Float32Array(4);
		expect(applyGainWithin([data], 3)).toBe(3);
		expect(Array.from(data)).toEqual([0, 0, 0, 0]);
	});
});

describe('buildImpulse', () => {
	test('is two independent channels decaying to nothing', () => {
		const rate = 8000;
		const impulse = buildImpulse(factory, rate, roomLength(rate));
		expect(impulse.numberOfChannels).toBe(2);
		expect(impulse.length).toBe(roomLength(rate));
		const left = impulse.getChannelData(0);
		const right = impulse.getChannelData(1);
		expect(Array.from(left.subarray(0, 64))).not.toEqual(Array.from(right.subarray(0, 64)));
		const energy = (data: Float32Array) => data.reduce((sum, s) => sum + s * s, 0);
		const quarter = Math.floor(impulse.length / 4);
		expect(energy(left.subarray(0, quarter))).toBeGreaterThan(energy(left.subarray(-quarter)) * 100);
	});
});
