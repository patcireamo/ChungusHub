/**
 * The soundscape engine: what the mix actually sounds like.
 *
 * One voice per recording, all summing into one master:
 *
 *     source (loop) -> drift -> level -> master -> destination
 *
 * The two gains are separate on purpose. `level` is the reader's slider times the recording's
 * own loudness correction and is set outright; `drift` is a slow ramp the engine schedules.
 * Sharing one param would mean every slider move had to cancel and re-plan a ramp that is
 * already minutes into the future.
 *
 * The store is the only caller: it hands over a whole config and this reconciles against what
 * is already sounding, so nothing here has to trust a diff somebody else worked out.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { audioContext, fetchAudioBuffer } from '$lib/services/audioContext';
import { buildLoopBuffer } from '$lib/services/loopBuffer';
import { normalizeGain, soundById, soundUrl } from '$lib/config/soundscape';
import type { SoundscapeConfig } from '$lib/stores/soundscape.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

/** A voice fades rather than cuts, at every edge: joining, leaving, being replaced. */
const VOICE_FADE = 0.45;
/** The whole mix starting or stopping. Slower, because it is the scene arriving. */
const MIX_FADE = 0.9;

/** How far a drifting level wanders either side of where it was set, in dB. */
const DRIFT_DB = 3;
/** One leg of a wander. Randomized per leg so voices never fall into step with each other. */
const DRIFT_MIN_SECONDS = 8;
const DRIFT_MAX_SECONDS = 20;
/** How far ahead legs are planned. A background tab throttles timers to minutes while what is
 *  already scheduled keeps running on the audio thread, so planning ahead is what keeps the
 *  mix breathing while nobody is looking at it. */
const DRIFT_HORIZON = 25;
const DRIFT_TICK_MS = 5000;

/** A voice lives in the map only while it belongs to the mix: `stopVoice` drops it there and
 *  then lets the fade finish on its own, so the map always answers "what is in the mix". */
interface Voice {
	id: string;
	source: AudioBufferSourceNode;
	drift: GainNode;
	level: GainNode;
	/** Context time the scheduled drift legs reach. */
	driftUntil: number;
	/** Which loop shape this voice is playing, so a change of the switch is visible here. */
	seamless: boolean;
}

function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

class SoundscapePlayer {
	/** Recordings being fetched and decoded right now: the mixer draws those rows as loading. */
	loading = new SvelteSet<string>();
	/** Recordings that could not be loaded, with the reason already reported once. */
	failed = new SvelteSet<string>();
	/** True while the browser is refusing to let the context run, so the mixer can name the
	 *  missing gesture instead of showing a mix that is silently not playing. */
	blocked = $state(false);
	/**
	 * What each voice's drift is multiplying its level by at this instant, sampled only while
	 * something is drawing it (`watchDrift`).
	 *
	 * A ramping AudioParam reports its current value but never announces a change, so looking
	 * is the only way to show one. Sixteen times a second is far finer than a leg that runs
	 * for ten seconds, and the mixer's fill moves by well under a pixel per sample.
	 */
	liveDrift = new SvelteMap<string, number>();

	private ctx: AudioContext | null = null;
	private master: GainNode | null = null;
	private voices = new SvelteMap<string, Voice>();
	/** Prepared loop buffers, keyed by recording AND loop shape: the two shapes are different
	 *  audio, and the raw decode they come from is far too large to keep. */
	private buffers = new Map<string, AudioBuffer>();
	private inflight = new Map<string, Promise<AudioBuffer | null>>();
	private driftTimer: ReturnType<typeof setInterval> | null = null;
	private sampleTimer: ReturnType<typeof setInterval> | null = null;
	private watchers = 0;
	private config: SoundscapeConfig | null = null;
	private loadWarned = false;

	/**
	 * Start reporting live drift, and hand back the stop. The mixer is the only caller and
	 * only while it is on screen: a soundscape playing behind a closed Settings panel has
	 * nothing to draw, and paying for a sample loop then would be paying for nobody.
	 */
	watchDrift(): () => void {
		this.watchers++;
		if (this.watchers === 1 && typeof window !== 'undefined') {
			this.sampleTimer = setInterval(() => this.sampleDrift(), 60);
			this.sampleDrift();
		}
		return () => {
			this.watchers = Math.max(0, this.watchers - 1);
			if (this.watchers > 0) return;
			if (this.sampleTimer) clearInterval(this.sampleTimer);
			this.sampleTimer = null;
			this.liveDrift.clear();
		};
	}

	private sampleDrift(): void {
		for (const id of this.liveDrift.keys()) {
			if (!this.voices.has(id)) this.liveDrift.delete(id);
		}
		for (const [id, voice] of this.voices) {
			const value = voice.drift.gain.value;
			if (this.liveDrift.get(id) !== value) this.liveDrift.set(id, value);
		}
	}

	/** Take a whole config and make the graph match it. */
	apply(config: SoundscapeConfig): void {
		this.config = config;
		if (typeof window === 'undefined') return;

		const wanted = config.enabled ? Object.keys(config.levels) : [];
		// Never build a context for a reader who has the soundscape switched off, which is
		// every reader on a fresh install.
		if (wanted.length === 0 && !this.ctx) return;
		if (!this.context()) return;

		for (const [id, voice] of this.voices) {
			if (!wanted.includes(id)) this.stopVoice(voice);
		}
		for (const id of wanted) {
			const voice = this.voices.get(id);
			if (!voice || voice.seamless !== config.seamless) void this.startVoice(id);
		}

		this.applyLevels();
		this.applyMaster();
		this.applyDrift();
		this.evictBuffers();
	}

	/**
	 * Drop the prepared buffers of anything no longer in the mix.
	 *
	 * One is around 19 MB, so a reader auditioning their way through the catalog would retain
	 * every recording they had ever tried until the tab was closed. Re-adding one costs the
	 * fetch and decode again, which is a second on a local file and the right trade against
	 * hundreds of megabytes of recordings nobody is listening to. Anything still in the mix
	 * stays cached, so the loop switch and the level sliders remain free.
	 */
	private evictBuffers(): void {
		const levels = this.config?.levels ?? {};
		for (const key of this.buffers.keys()) {
			if (!(key.slice(0, key.lastIndexOf(':')) in levels)) this.buffers.delete(key);
		}
	}

	/** Re-read the level of every sounding voice, for a slider move or the normalize switch. */
	private applyLevels(): void {
		const ac = this.ctx;
		if (!ac) return;
		for (const id of this.voices.keys()) {
			this.voices.get(id)?.level.gain.setTargetAtTime(this.levelFor(id), ac.currentTime, 0.02);
		}
	}

	private levelFor(id: string): number {
		const config = this.config;
		const sound = soundById(id);
		if (!config || !sound) return 0;
		return (config.levels[id] ?? 0) * (config.normalize ? normalizeGain(sound) : 1);
	}

	private applyMaster(): void {
		const ac = this.ctx;
		const master = this.master;
		const config = this.config;
		if (!ac || !master || !config) return;
		const target = config.enabled ? config.volume : 0;
		master.gain.cancelScheduledValues(ac.currentTime);
		master.gain.setValueAtTime(master.gain.value, ac.currentTime);
		master.gain.linearRampToValueAtTime(target, ac.currentTime + MIX_FADE);
	}

	private context(): AudioContext | null {
		if (this.ctx) return this.ctx;
		const ac = audioContext();
		if (!ac) return null;
		this.ctx = ac;
		const master = ac.createGain();
		// Silent until applyMaster ramps it, so a mix restored at boot arrives rather than
		// slamming on at whatever volume it was left at.
		master.gain.value = 0;
		master.connect(ac.destination);
		this.master = master;
		this.blocked = ac.state !== 'running';
		// The gesture that unlocks audio lands anywhere in the app (services/audioContext.ts),
		// so what a restored mix waits on is this, not a press on the mixer.
		ac.addEventListener('statechange', () => {
			this.blocked = ac.state !== 'running';
		});
		return ac;
	}

	private loadBuffer(ac: AudioContext, id: string, seamless: boolean): Promise<AudioBuffer | null> {
		const key = `${id}:${seamless ? 'seamless' : 'raw'}`;
		const cached = this.buffers.get(key);
		if (cached) return Promise.resolve(cached);

		const pending = this.inflight.get(key);
		if (pending) return pending;

		const sound = soundById(id);
		if (!sound) return Promise.resolve(null);

		this.loading.add(id);
		const load = fetchAudioBuffer(ac, soundUrl(sound))
			.then((decoded) => {
				// The window is taken here and the full decode dropped with it: holding both is
				// the peak, and holding the second would cost the whole file's memory for as
				// long as the recording stays in the mix.
				const prepared = buildLoopBuffer(ac, decoded, seamless);
				this.buffers.set(key, prepared);
				this.failed.delete(id);
				return prepared;
			})
			.catch((error: unknown) => {
				console.error(`Ambient sound "${id}" could not be loaded`, error);
				this.failed.add(id);
				if (!this.loadWarned) {
					this.loadWarned = true;
					// It ships with the app and is served from this same origin, so the one thing
					// that realistically stands between them is a download manager, which claims
					// media URLs before the page can read them.
					toastStore.error(
						`Couldn't load the "${sound.label}" sound. A download manager extension may be taking it before the app gets it.`
					);
				}
				return null;
			})
			.finally(() => {
				this.loading.delete(id);
				this.inflight.delete(key);
				// A load that lands after its recording was dropped from the mix cached a buffer
				// the eviction pass had already been and gone for.
				this.evictBuffers();
			});
		this.inflight.set(key, load);
		return load;
	}

	private async startVoice(id: string): Promise<void> {
		const ac = this.ctx;
		const master = this.master;
		if (!ac || !master || !this.config) return;
		const seamless = this.config.seamless;
		const buffer = await this.loadBuffer(ac, id, seamless);

		// The mix can have moved on entirely while this was loading.
		const config = this.config;
		if (!buffer || !config.enabled || !(id in config.levels) || config.seamless !== seamless) {
			return;
		}
		const existing = this.voices.get(id);
		if (existing?.seamless === seamless) return;
		// The replacement fades in over the outgoing one rather than after it, so a change of
		// loop shape is a wash rather than a hole in the mix.
		if (existing) this.stopVoice(existing);

		const source = ac.createBufferSource();
		source.buffer = buffer;
		source.loop = true;
		const drift = ac.createGain();
		drift.gain.value = 1;
		const level = ac.createGain();
		level.gain.value = 0;
		source.connect(drift).connect(level).connect(master);
		// A random entry point, so a mix restored at boot does not replay every recording's
		// opening second in unison.
		source.start(0, Math.random() * buffer.duration);
		level.gain.linearRampToValueAtTime(this.levelFor(id), ac.currentTime + VOICE_FADE);

		this.voices.set(id, { id, source, drift, level, driftUntil: 0, seamless });
		// A voice that arrives after `apply` has been and gone still owes itself the timer.
		this.applyDrift();
	}

	private stopVoice(voice: Voice): void {
		const ac = this.ctx;
		if (!ac) return;
		if (this.voices.get(voice.id) === voice) this.voices.delete(voice.id);
		voice.level.gain.cancelScheduledValues(ac.currentTime);
		voice.level.gain.setValueAtTime(voice.level.gain.value, ac.currentTime);
		voice.level.gain.linearRampToValueAtTime(0, ac.currentTime + VOICE_FADE);
		voice.source.onended = () => {
			voice.source.disconnect();
			voice.drift.disconnect();
			voice.level.disconnect();
		};
		try {
			voice.source.stop(ac.currentTime + VOICE_FADE + 0.05);
		} catch {
			// Already stopped, which is the outcome this asked for anyway.
		}
	}

	private applyDrift(): void {
		const on = this.config?.drift === true && this.config.enabled;
		if (on && !this.driftTimer) {
			this.driftTimer = setInterval(() => this.topUpDrift(), DRIFT_TICK_MS);
		}
		if (!on && this.driftTimer) {
			clearInterval(this.driftTimer);
			this.driftTimer = null;
		}
		if (on) this.topUpDrift();
		else this.settleDrift();
	}

	private topUpDrift(): void {
		for (const voice of this.voices.values()) this.scheduleDrift(voice);
	}

	/** Plan wander legs until the horizon is covered. Each leg ramps to a fresh target over its
	 *  own length, so a level is always moving and never repeats a period. */
	private scheduleDrift(voice: Voice): void {
		const ac = this.ctx;
		if (!ac) return;
		const now = ac.currentTime;
		if (voice.driftUntil < now) {
			voice.drift.gain.cancelScheduledValues(now);
			voice.drift.gain.setValueAtTime(voice.drift.gain.value, now);
			voice.driftUntil = now;
		}
		while (voice.driftUntil < now + DRIFT_HORIZON) {
			const target = 10 ** (randomBetween(-DRIFT_DB, DRIFT_DB) / 20);
			voice.driftUntil += randomBetween(DRIFT_MIN_SECONDS, DRIFT_MAX_SECONDS);
			voice.drift.gain.linearRampToValueAtTime(target, voice.driftUntil);
		}
	}

	/** Hand every level back to exactly where its slider says, over one slow leg. */
	private settleDrift(): void {
		const ac = this.ctx;
		if (!ac) return;
		for (const voice of this.voices.values()) {
			voice.drift.gain.cancelScheduledValues(ac.currentTime);
			voice.drift.gain.setValueAtTime(voice.drift.gain.value, ac.currentTime);
			voice.drift.gain.linearRampToValueAtTime(1, ac.currentTime + 1.5);
			voice.driftUntil = 0;
		}
	}
}

export const soundscapePlayer = new SoundscapePlayer();
