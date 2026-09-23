import { describe, expect, test } from 'bun:test';
import {
	DRIFT_DB,
	DRIFT_MAX_SECONDS,
	DRIFT_MIN_SECONDS,
	driftAt,
	fadeAt,
	fadeDone,
	fadeTo,
	holdAt,
	nextDriftLeg,
	steadyDrift,
	voiceLoudness,
	type VoiceGain
} from './soundscapeMix';

const plain: VoiceGain = {
	level: 0.5,
	volume: 0.8,
	drift: 1,
	fade: 1,
	normalize: false,
	normalizeGain: 1,
	bakedGain: 1
};

describe('voiceLoudness', () => {
	test('is the product of the knobs when nothing is corrected', () => {
		expect(voiceLoudness(plain)).toBeCloseTo(0.4, 12);
		expect(voiceLoudness({ ...plain, drift: 1.2, fade: 0.5 })).toBeCloseTo(0.24, 12);
	});

	test('normalize off ignores the correction', () => {
		expect(voiceLoudness({ ...plain, normalizeGain: 0.25 })).toBeCloseTo(0.4, 12);
	});

	test('normalize on pulls a loud recording down by its correction', () => {
		expect(voiceLoudness({ ...plain, normalize: true, normalizeGain: 0.25 })).toBeCloseTo(0.1, 12);
	});

	// A quiet recording's boost is already in its samples, so with normalize on the element
	// plays it at the slider's own value, and with normalize off it undoes the boost exactly.
	test('a boost baked into the samples is divided back out', () => {
		const boosted = { ...plain, normalizeGain: 3, bakedGain: 3 };
		expect(voiceLoudness({ ...boosted, normalize: true })).toBeCloseTo(0.4, 12);
		expect(voiceLoudness({ ...boosted, normalize: false })).toBeCloseTo(0.4 / 3, 12);
	});

	// The peak ceiling can leave less boost in the samples than the correction asked for, and
	// the element then makes up the rest.
	test('a boost the ceiling cut short is made up by the volume', () => {
		const got = voiceLoudness({ ...plain, normalize: true, normalizeGain: 3, bakedGain: 2 });
		expect(got).toBeCloseTo(0.6, 12);
	});

	test('never leaves the 0-1 a media element accepts', () => {
		expect(voiceLoudness({ ...plain, level: 1, volume: 1, drift: 1.41 })).toBe(1);
		expect(voiceLoudness({ ...plain, normalize: true, normalizeGain: 4 })).toBe(1);
		expect(voiceLoudness({ ...plain, fade: -0.2 })).toBe(0);
	});

	test('something that is not a number is silence rather than a throw', () => {
		expect(voiceLoudness({ ...plain, drift: Number.NaN })).toBe(0);
		expect(voiceLoudness({ ...plain, bakedGain: 0 })).toBe(0);
	});
});

describe('fades', () => {
	test('a linear fade runs straight between its ends', () => {
		const fade = fadeTo(0, 1, 10, 2);
		expect(fadeAt(fade, 9)).toBe(0);
		expect(fadeAt(fade, 10)).toBe(0);
		expect(fadeAt(fade, 10.5)).toBeCloseTo(0.25, 12);
		expect(fadeAt(fade, 11)).toBeCloseTo(0.5, 12);
		expect(fadeAt(fade, 12)).toBe(1);
		expect(fadeAt(fade, 50)).toBe(1);
	});

	test('a fade can start from wherever the last one left off', () => {
		const fade = fadeTo(0.6, 0, 0, 1);
		expect(fadeAt(fade, 0)).toBeCloseTo(0.6, 12);
		expect(fadeAt(fade, 0.5)).toBeCloseTo(0.3, 12);
	});

	test('both halves of a crossfade land exactly on their ends', () => {
		const rising = fadeTo(0, 1, 0, 0.45, 'in');
		const falling = fadeTo(1, 0, 0, 0.45, 'out');
		expect(fadeAt(rising, 0)).toBe(0);
		expect(fadeAt(falling, 0)).toBe(1);
		expect(fadeAt(rising, 0.45)).toBe(1);
		expect(fadeAt(falling, 0.45)).toBe(0);
	});

	// The whole reason for the curves: summed as power, the pair never dips.
	test('an equal-power crossfade holds its power all the way through', () => {
		const rising = fadeTo(0, 1, 0, 0.45, 'in');
		const falling = fadeTo(1, 0, 0, 0.45, 'out');
		for (let t = 0; t <= 0.45; t += 0.05) {
			expect(fadeAt(rising, t) ** 2 + fadeAt(falling, t) ** 2).toBeCloseTo(1, 9);
		}
		expect(fadeAt(rising, 0.225)).toBeCloseTo(Math.SQRT1_2, 9);
	});

	test('the falling half starts from the level the outgoing voice was at', () => {
		const falling = fadeTo(0.5, 0, 0, 1, 'out');
		expect(fadeAt(falling, 0)).toBe(0.5);
		expect(fadeAt(falling, 0.5)).toBeCloseTo(0.5 * Math.SQRT1_2, 9);
	});

	test('a hold is a fade that is already over', () => {
		expect(fadeAt(holdAt(0.3), 0)).toBe(0.3);
		expect(fadeDone(holdAt(0.3), 0)).toBe(true);
		expect(fadeDone(fadeTo(0, 1, 5, 1), 5.5)).toBe(false);
		expect(fadeDone(fadeTo(0, 1, 5, 1), 6)).toBe(true);
	});
});

describe('drift', () => {
	test('a leg moves linearly in amplitude and holds at its end', () => {
		const leg = { from: 1, to: 1.2, start: 100, end: 110 };
		expect(driftAt(leg, 99)).toBe(1);
		expect(driftAt(leg, 100)).toBe(1);
		expect(driftAt(leg, 105)).toBeCloseTo(1.1, 12);
		expect(driftAt(leg, 110)).toBe(1.2);
		expect(driftAt(leg, 1000)).toBe(1.2);
	});

	test('a steady drift is flat', () => {
		expect(driftAt(steadyDrift(), 0)).toBe(1);
		expect(driftAt(steadyDrift(), 12345)).toBe(1);
		expect(driftAt(steadyDrift(0.8), 5)).toBe(0.8);
	});

	test('the next leg starts where the last one left the level', () => {
		const leg = nextDriftLeg(0.9, 42, () => 0.5);
		expect(leg.from).toBe(0.9);
		expect(leg.start).toBe(42);
		expect(driftAt(leg, 42)).toBe(0.9);
		expect(leg.to).toBe(1);
	});

	test('legs stay inside their range at both extremes of the draw', () => {
		const low = nextDriftLeg(1, 0, () => 0);
		const high = nextDriftLeg(1, 0, () => 1);
		expect(low.to).toBeCloseTo(10 ** (-DRIFT_DB / 20), 12);
		expect(high.to).toBeCloseTo(10 ** (DRIFT_DB / 20), 12);
		expect(low.end).toBe(DRIFT_MIN_SECONDS);
		expect(high.end).toBe(DRIFT_MAX_SECONDS);
	});

	test('random legs never wander past the range', () => {
		for (let i = 0; i < 500; i++) {
			const leg = nextDriftLeg(1, 0);
			expect(Math.abs(20 * Math.log10(leg.to))).toBeLessThanOrEqual(DRIFT_DB + 1e-9);
			expect(leg.end).toBeGreaterThanOrEqual(DRIFT_MIN_SECONDS);
			expect(leg.end).toBeLessThanOrEqual(DRIFT_MAX_SECONDS);
		}
	});
});
