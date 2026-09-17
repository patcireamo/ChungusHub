/**
 * The notification sounds, in ONE place: the bundled tones and the moments that can play
 * one. Pure data. The Audio settings page renders a row per event and a chip per tone, so a
 * sixth surface that deserves a sound is an entry here and a `notify` call at the moment it
 * describes, with nothing else to keep in step.
 *
 * The tone files live in `static/sounds/` under their own licenses and are credited in
 * `static/sounds/CREDITS.txt` (architecture/build-packaging.md).
 */

export type ToneId =
	| 'alert'
	| 'bell'
	| 'blip'
	| 'complete'
	| 'confirm'
	| 'fanfare'
	| 'message'
	| 'pop'
	| 'success';

export interface ToneDef {
	id: ToneId;
	label: string;
	/**
	 * Playback multiplier that brings this tone to the same perceived loudness as the others.
	 * The nine came from nine authors and span 23 dB as published, which no single volume
	 * slider can reconcile: set so the quietest is audible and the loudest makes you jump.
	 * Measured as max momentary loudness (EBU R128) against a -18 LUFS target, and applied at
	 * playback rather than baked into the files, which would make every tone a modified work
	 * under its CC BY license and would have to be re-stated in CREDITS.txt. Every tone's peak
	 * stays under 0 dBFS at full volume, so none of them clips.
	 */
	gain: number;
}

export const TONES: ToneDef[] = [
	{ id: 'alert', label: 'Alert', gain: 1.55 },
	{ id: 'bell', label: 'Bell', gain: 6.76 },
	{ id: 'blip', label: 'Blip', gain: 0.48 },
	{ id: 'complete', label: 'Complete', gain: 0.92 },
	{ id: 'confirm', label: 'Confirm', gain: 0.57 },
	{ id: 'fanfare', label: 'Fanfare', gain: 0.65 },
	{ id: 'message', label: 'Message', gain: 1.02 },
	{ id: 'pop', label: 'Pop', gain: 1.07 },
	{ id: 'success', label: 'Success', gain: 1.24 }
];

export const TONE_IDS: ToneId[] = TONES.map((t) => t.id);

export function toneGain(id: ToneId): number {
	return TONES.find((t) => t.id === id)?.gain ?? 1;
}

export function toneLabel(id: ToneId): string {
	return TONES.find((t) => t.id === id)?.label ?? id;
}

export function toneUrl(id: ToneId): string {
	return `/sounds/${id}.mp3`;
}

export type SoundEventId = 'reply-done' | 'assistant-done' | 'assistant-ask' | 'failed';

export interface SoundEventDef {
	id: SoundEventId;
	/** The row's own line on the Audio page. A sentence, since it states a moment. */
	label: string;
	/** What actually fires it, under the label. */
	description: string;
	/** Assigned on a fresh install. Nothing plays until the page's switch is turned on, so
	 *  this is what makes that one press enough. */
	defaultTone: ToneId;
}

export const SOUND_EVENTS: SoundEventDef[] = [
	{
		id: 'reply-done',
		label: 'A reply finished',
		description: 'A story reply, a continuation or an opening scene stopped writing.',
		defaultTone: 'pop'
	},
	{
		id: 'assistant-done',
		label: 'The assistant finished',
		description: 'A Chungus Assistant turn ran to its end.',
		defaultTone: 'complete'
	},
	{
		id: 'assistant-ask',
		label: 'The assistant needs an answer',
		description: 'It stopped to ask for approval or to put a question, and waits there until you answer.',
		defaultTone: 'alert'
	},
	{
		id: 'failed',
		label: 'Something failed',
		description: 'A reply or an assistant turn ended in an error instead of an answer.',
		defaultTone: 'confirm'
	}
];

export const SOUND_EVENT_IDS: SoundEventId[] = SOUND_EVENTS.map((e) => e.id);
