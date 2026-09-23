import { describe, expect, test } from 'bun:test';
import { encodeWav } from './wav';

function tag(view: DataView, offset: number): string {
	return String.fromCharCode(...Array.from({ length: 4 }, (_, i) => view.getUint8(offset + i)));
}

function samplesOf(buffer: ArrayBuffer): number[] {
	const view = new DataView(buffer);
	const out: number[] = [];
	for (let offset = 44; offset < buffer.byteLength; offset += 2) out.push(view.getInt16(offset, true));
	return out;
}

describe('encodeWav', () => {
	test('writes a canonical PCM header', () => {
		const buffer = encodeWav([new Float32Array(10), new Float32Array(10)], 48000);
		const view = new DataView(buffer);
		expect(buffer.byteLength).toBe(44 + 10 * 2 * 2);
		expect(tag(view, 0)).toBe('RIFF');
		expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
		expect(tag(view, 8)).toBe('WAVE');
		expect(tag(view, 12)).toBe('fmt ');
		expect(view.getUint32(16, true)).toBe(16);
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(2);
		expect(view.getUint32(24, true)).toBe(48000);
		expect(view.getUint32(28, true)).toBe(48000 * 4);
		expect(view.getUint16(32, true)).toBe(4);
		expect(view.getUint16(34, true)).toBe(16);
		expect(tag(view, 36)).toBe('data');
		expect(view.getUint32(40, true)).toBe(40);
	});

	test('interleaves channels frame by frame', () => {
		const left = Float32Array.from([0.1, 0.2, 0.3]);
		const right = Float32Array.from([-0.1, -0.2, -0.3]);
		const got = samplesOf(encodeWav([left, right], 44100));
		expect(got).toEqual([3277, -3277, 6553, -6553, 9830, -9830]);
	});

	test('a mono channel is written as it is', () => {
		const buffer = encodeWav([Float32Array.from([0, 1, -1])], 22050);
		expect(new DataView(buffer).getUint16(22, true)).toBe(1);
		expect(new DataView(buffer).getUint16(32, true)).toBe(2);
		expect(samplesOf(buffer)).toEqual([0, 32767, -32767]);
	});

	test('rounds to the nearest step', () => {
		const got = samplesOf(encodeWav([Float32Array.from([0.5, -0.5, 1 / 32767 / 3])], 48000));
		expect(got).toEqual([16384, -16383, 0]);
	});

	// A sample past full scale is a clip either way; wrapping around instead would be a crack.
	test('clamps past full scale instead of wrapping', () => {
		const got = samplesOf(encodeWav([Float32Array.from([1.5, -7, Infinity, -Infinity])], 48000));
		expect(got).toEqual([32767, -32767, 32767, -32767]);
	});

	test('NaN is written as silence', () => {
		expect(samplesOf(encodeWav([Float32Array.from([Number.NaN])], 48000))).toEqual([0]);
	});

	test('an empty loop is a header and nothing else', () => {
		const buffer = encodeWav([new Float32Array(0)], 48000);
		expect(buffer.byteLength).toBe(44);
		expect(new DataView(buffer).getUint32(40, true)).toBe(0);
	});

	test('refuses channels of different lengths', () => {
		expect(() => encodeWav([new Float32Array(3), new Float32Array(4)], 48000)).toThrow();
	});
});
