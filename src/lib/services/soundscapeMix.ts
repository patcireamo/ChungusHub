/**
 * The soundscape mixer's arithmetic: every voice's loudness, its fades and its drift, as plain
 * functions of time so they can be tested without a browser
 * (services/soundscapePlayer.svelte.ts runs them on its tick).
 */

/** How far a drifting level wanders either side of where it was set, in dB. */
export const DRIFT_DB = 3;
/** One leg of a wander. Randomized per leg so voices never fall into step with each other. */
export const DRIFT_MIN_SECONDS = 8;
export const DRIFT_MAX_SECONDS = 20;

export interface VoiceGain {
	/** The recording's slider, 0-1. */
	level: number;
	/** The whole mix's slider, 0-1. */
	volume: number;
	drift: number;
	/** Every fade the voice is under, multiplied together. */
	fade: number;
	normalize: boolean;
	normalizeGain: number;
	/** What the preparation multiplied the samples by, divided back out here. */
	bakedGain: number;
}

/**
 * What one voice plays at, as the 0-1 a media element's volume accepts. Anything outside that
 * range throws there, so a value that is not a number at all is silence rather than an error.
 */
export function voiceLoudness(gain: VoiceGain): number {
	const value =
		(gain.level *
			gain.volume *
			gain.drift *
			gain.fade *
			(gain.normalize ? gain.normalizeGain : 1)) /
		gain.bakedGain;
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * `in` and `out` are the two halves of an equal-power crossfade (sine up, cosine down): two
 * moments of ambience are uncorrelated, so a linear pair dips audibly halfway through.
 */
export type FadeShape = 'linear' | 'in' | 'out';

export interface Fade {
	from: number;
	to: number;
	start: number;
	duration: number;
	shape: FadeShape;
}

export function holdAt(value: number): Fade {
	return { from: value, to: value, start: 0, duration: 0, shape: 'linear' };
}

export function fadeTo(
	from: number,
	to: number,
	start: number,
	duration: number,
	shape: FadeShape = 'linear'
): Fade {
	return { from, to, start, duration, shape };
}

export function fadeDone(fade: Fade, now: number): boolean {
	return now >= fade.start + fade.duration;
}

export function fadeAt(fade: Fade, now: number): number {
	if (fadeDone(fade, now)) return fade.to;
	const x = Math.max(0, (now - fade.start) / fade.duration);
	if (fade.shape === 'in') return fade.from + (fade.to - fade.from) * Math.sin((x * Math.PI) / 2);
	if (fade.shape === 'out') return fade.to + (fade.from - fade.to) * Math.cos((x * Math.PI) / 2);
	return fade.from + (fade.to - fade.from) * x;
}

/** One straight stretch of a wander, linear in amplitude, holding at `to` once it is over. */
export interface DriftLeg {
	from: number;
	to: number;
	start: number;
	end: number;
}

export function steadyDrift(value = 1): DriftLeg {
	return { from: value, to: value, start: 0, end: 0 };
}

export function driftAt(leg: DriftLeg, now: number): number {
	if (now >= leg.end) return leg.to;
	if (now <= leg.start) return leg.from;
	return leg.from + (leg.to - leg.from) * ((now - leg.start) / (leg.end - leg.start));
}

/** The next leg, starting where the last one left the level. */
export function nextDriftLeg(from: number, now: number, random: () => number = Math.random): DriftLeg {
	const to = 10 ** (((random() * 2 - 1) * DRIFT_DB) / 20);
	const seconds = DRIFT_MIN_SECONDS + random() * (DRIFT_MAX_SECONDS - DRIFT_MIN_SECONDS);
	return { from, to, start: now, end: now + seconds };
}
