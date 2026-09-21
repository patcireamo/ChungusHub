/**
 * The soundscape engine: what the mix actually sounds like.
 *
 * One voice per recording, all summing into one master:
 *
 *     source (loop) -> drift -> tone -> level -> dry  -> master -> destination
 *                                             -> send -> reverb -> master
 *
 * `tone` is whatever is in the way and is open until something is; `dry` and `send` are the two
 * paths a placed recording takes, straight here and around by way of the room. The reverb is one
 * shared bus rather than one per voice, and is built only once something asks for it.
 *
 * The two gains are separate on purpose. `level` is the reader's slider times the recording's
 * own loudness correction and is set outright; `drift` is a slow ramp the engine schedules.
 * Sharing one param would mean every slider move had to cancel and re-plan a ramp that is
 * already minutes into the future.
 *
 * The store is the only caller: it hands over a whole config and this reconciles against what
 * is already sounding, so nothing here has to trust a diff somebody else worked out.
 */
import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { audioContext, claimMediaPlayback, fetchAudioBuffer } from '$lib/services/audioContext';
import { CROSSFADE_SECONDS, LOOP_SECONDS, buildLoopBuffer } from '$lib/services/loopBuffer';
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
/** How often the mixer's dots are re-read. A leg runs for at least eight seconds, so this is
 *  far finer than the motion and the dot moves imperceptibly between samples. */
const SAMPLE_MS = 100;

/**
 * A wall, a window or a hull takes the top off a sound without taking it away: the highs arrive
 * weakened rather than gone. That is the whole difference between something heard through a
 * wall and something heard underwater, so this is a shelf that leans on everything above it and
 * never a lowpass that stops passing: cut the top end off outright and every recording turns
 * into the same submerged rumble whatever it started as.
 */
const WALL_HZ = 1000;
const WALL_CUT_DB = -15;
/** What open ground between here and there takes off the sound that arrives straight, and what
 *  it hands back as the space in between. Distance is the ratio far more than it is the level:
 *  cutting the direct path alone just makes a recording quiet. */
const DISTANT_DRY = 0.42;
const DISTANT_SEND = 0.5;
/** Placement settles rather than switches, so a press is a move and not a cut. */
const PLACE_SETTLE = 0.12;

/**
 * Asked for on top of what is actually kept, because the prefix is cut by proportion of the
 * file's bytes: the tag at the head of an MP3 rides inside that share, and a variable bitrate
 * spends itself unevenly, so a share cut to the exact second can land short of it. Coming up
 * short only costs a shorter loop, and the decode falls back to the whole file if a prefix
 * ending mid-frame is refused outright, so this is margin rather than a guarantee.
 */
const PREFIX_MARGIN_SECONDS = 8;

/**
 * A reverb tail built rather than shipped: a couple of seconds of decaying noise, which is all
 * a convolver needs and which costs nothing to carry, where a recorded impulse would be another
 * megabyte in every build for a room nobody is trying to identify. The two channels are drawn
 * independently, so the tail has width instead of sitting as a point in the middle of the head.
 */
function buildImpulse(ac: AudioContext, seconds: number, decay: number): AudioBuffer {
	const length = Math.max(1, Math.floor(ac.sampleRate * seconds));
	const buffer = ac.createBuffer(2, length, ac.sampleRate);
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const data = buffer.getChannelData(channel);
		for (let i = 0; i < length; i++) {
			data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
		}
	}
	return buffer;
}

/** A voice lives in the map only while it belongs to the mix: `stopVoice` drops it there and
 *  then lets the fade finish on its own, so the map always answers "what is in the mix". */
interface Voice {
	id: string;
	source: AudioBufferSourceNode;
	drift: GainNode;
	/** The thing in the way: a high shelf leaning on the top end, flat until something is. */
	tone: BiquadFilterNode;
	level: GainNode;
	/** The two paths out of `level`: straight here, and around by way of the room. */
	dry: GainNode;
	send: GainNode;
	/** Whether `send` has ever been joined to the reverb bus. It stays joined once it has been,
	 *  since its gain going to zero is silence and re-patching a live graph is not. */
	sendWired: boolean;
	/** What the graph was last told, so a reconciliation landing on every pointer frame of a
	 *  drag re-plans only the automation that actually changed. */
	applied: { level: number; muffled: boolean; distant: boolean };
	/** Context time the scheduled drift legs reach. */
	driftUntil: number;
	/** Which loop shape this voice is playing, so a change of the switch is visible here. */
	seamless: boolean;
}

function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

class SoundscapePlayer {
	/** Recordings queued to start or being fetched and decoded: the mixer draws those rows as
	 *  loading, from the moment they are asked for until the voice sounds or fails. */
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
	/** Built the first time a recording is put at a distance, and kept for the context's life.
	 *  A convolver runs whether or not anything is feeding it, so one is never made for a mix
	 *  that has nothing standing away from the reader. */
	private reverbIn: ConvolverNode | null = null;
	private voices = new SvelteMap<string, Voice>();
	/** Prepared loop buffers, keyed by recording AND loop shape: the two shapes are different
	 *  audio, and the raw decode they come from is far too large to keep. */
	private buffers = new Map<string, AudioBuffer>();
	private inflight = new Map<string, Promise<AudioBuffer | null>>();
	/**
	 * Recordings start one after another rather than all at once. Four starting together is
	 * four downloads, four decodes and four buffers asked of a phone in one breath, which it
	 * answers by collecting memory underneath the mix that is already sounding, heard as the
	 * stutter that lands hardest on the press that starts everything.
	 */
	private loadChain: Promise<void> = Promise.resolve();
	/** Queued or running, so an `apply` landing per pointer frame through a drag cannot ask for
	 *  the same recording sixty times over. */
	private starting = new Set<string>();
	private driftTimer: ReturnType<typeof setInterval> | null = null;
	private sampleTimer: ReturnType<typeof setInterval> | null = null;
	private watchers = 0;
	/** What the master was last told, so a volume move is told apart from the mix starting. */
	private masterOn = false;
	private masterTarget = 0;
	private config: SoundscapeConfig | null = null;
	/** Whether the reader has pressed play. The store owns the reactive copy. */
	private playing = false;
	private loadWarned = false;

	/**
	 * Start reporting live drift, and hand back the stop. The mixer is the only caller and
	 * only while it is on screen: a soundscape playing behind a closed Settings panel has
	 * nothing to draw, and paying for a sample loop then would be paying for nobody.
	 */
	watchDrift(): () => void {
		this.watchers++;
		// **Nothing reactive may be touched here.** This is called from an effect, and reading
		// the voices while writing `liveDrift` inside one makes that effect depend on state it
		// just changed, which Svelte stops as an update loop and which freezes the whole page.
		// The first sample therefore waits for the timer, a tenth of a second nobody can see.
		if (this.watchers === 1 && typeof window !== 'undefined') {
			this.sampleTimer = setInterval(() => this.sampleDrift(), SAMPLE_MS);
		}
		return () => {
			this.watchers = Math.max(0, this.watchers - 1);
			if (this.watchers > 0) return;
			if (this.sampleTimer) clearInterval(this.sampleTimer);
			this.sampleTimer = null;
			// The teardown runs inside that same effect, so this write is untracked for the
			// same reason.
			untrack(() => this.liveDrift.clear());
		};
	}

	/** Runs from the timer alone, never from a render or an effect. Untracked anyway, so a
	 *  future caller cannot turn it back into a loop without noticing. */
	private sampleDrift(): void {
		untrack(() => {
			for (const id of this.liveDrift.keys()) {
				if (!this.voices.has(id)) this.liveDrift.delete(id);
			}
			for (const [id, voice] of this.voices) {
				const value = voice.drift.gain.value;
				// A level that is not drifting reports the same number every tick, so an idle
				// mix writes nothing at all and redraws nothing.
				if (this.liveDrift.get(id) !== value) this.liveDrift.set(id, value);
			}
		});
	}

	/** Take a whole config plus whether the mix is running, and make the graph match. */
	apply(config: SoundscapeConfig, playing: boolean): void {
		this.config = config;
		this.playing = playing;
		if (typeof window === 'undefined') return;

		const wanted = playing ? Object.keys(config.levels) : [];
		// Never build a context for a mix nobody has started, which is every mix at page load.
		if (wanted.length === 0 && !this.ctx) return;
		if (!this.context()) return;

		for (const [id, voice] of this.voices) {
			if (!wanted.includes(id)) this.stopVoice(voice);
		}
		for (const id of wanted) {
			const voice = this.voices.get(id);
			if (!voice || voice.seamless !== config.seamless) this.queueStart(id);
		}

		this.applyLevels();
		this.applyPlacement();
		this.applyMaster();
		this.applyDrift();
		this.evictBuffers();
	}

	/** The one reverb every distant voice shares. Built on the first one that asks. */
	private reverbBus(ac: AudioContext, master: GainNode): ConvolverNode {
		if (this.reverbIn) return this.reverbIn;
		const convolver = ac.createConvolver();
		convolver.buffer = buildImpulse(ac, 2.4, 2.6);
		// A bare noise tail is brighter than any room it stands for, and brighter than the
		// recording arriving through it, which reads as hiss laid over the mix rather than as
		// space around it.
		const tone = ac.createBiquadFilter();
		tone.type = 'lowpass';
		tone.frequency.value = 2400;
		convolver.connect(tone).connect(master);
		this.reverbIn = convolver;
		return convolver;
	}

	/** Put every voice where its two switches say it is standing. */
	private applyPlacement(): void {
		const ac = this.ctx;
		const master = this.master;
		const config = this.config;
		if (!ac || !master || !config) return;
		const now = ac.currentTime;
		for (const [id, voice] of this.voices) {
			const placed = config.effects[id];
			const muffled = placed?.muffled === true;
			const distant = placed?.distant === true;
			if (muffled === voice.applied.muffled && distant === voice.applied.distant) continue;
			voice.applied.muffled = muffled;
			voice.applied.distant = distant;

			voice.tone.gain.setTargetAtTime(muffled ? WALL_CUT_DB : 0, now, PLACE_SETTLE);
			voice.dry.gain.setTargetAtTime(distant ? DISTANT_DRY : 1, now, PLACE_SETTLE);
			if (distant && !voice.sendWired) {
				voice.send.connect(this.reverbBus(ac, master));
				voice.sendWired = true;
			}
			voice.send.gain.setTargetAtTime(distant ? DISTANT_SEND : 0, now, PLACE_SETTLE);
		}
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
		for (const [id, voice] of this.voices) {
			const level = this.levelFor(id);
			if (level === voice.applied.level) continue;
			voice.applied.level = level;
			this.steer(voice.level.gain, level, ac.currentTime);
		}
	}

	/**
	 * Take a param to `target` from wherever it is, dropping whatever was still planned for it.
	 * A target merely added under a ramp still running (a voice joining, the mix arriving) is
	 * overtaken by that ramp, and a slider dragged inside its window lands back where it was.
	 */
	private steer(param: AudioParam, target: number, now: number): void {
		param.cancelScheduledValues(now);
		param.setValueAtTime(param.value, now);
		param.setTargetAtTime(target, now, 0.02);
	}

	private levelFor(id: string): number {
		const config = this.config;
		const sound = soundById(id);
		if (!config || !sound) return 0;
		return (config.levels[id] ?? 0) * (config.normalize ? normalizeGain(sound) : 1);
	}

	/**
	 * The slow fade belongs to the mix arriving or leaving, never to the volume slider.
	 *
	 * Dragging it calls this on every pointer frame, and restarting a near-second ramp sixty
	 * times a second means the level never reaches any of them: the sound trails the slider by
	 * most of a second and reads as a control that is not working.
	 */
	private applyMaster(): void {
		const ac = this.ctx;
		const master = this.master;
		const config = this.config;
		if (!ac || !master || !config) return;
		const target = this.playing ? config.volume : 0;
		if (this.playing === this.masterOn) {
			if (target === this.masterTarget) return;
			this.masterTarget = target;
			this.steer(master.gain, target, ac.currentTime);
			return;
		}
		this.masterOn = this.playing;
		this.masterTarget = target;
		claimMediaPlayback(this.playing);
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

		// Only the front of a recording is ever kept, so only the front of it is decoded. Whole,
		// the longest of these is a hundred and twenty megabytes of raw samples to hold for the
		// instant it takes to cut a minute out of it, which is what a phone runs out of memory
		// doing.
		const load = fetchAudioBuffer(ac, soundUrl(sound), {
			keepSeconds: LOOP_SECONDS + CROSSFADE_SECONDS + PREFIX_MARGIN_SECONDS,
			totalSeconds: sound.seconds
		})
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
				this.inflight.delete(key);
				// A load that lands after its recording was dropped from the mix cached a buffer
				// the eviction pass had already been and gone for.
				this.evictBuffers();
			});
		this.inflight.set(key, load);
		return load;
	}

	/**
	 * Put one recording at the back of the load queue.
	 *
	 * A loop shape flipped while a recording was already loading is picked up on the way out
	 * rather than lost, but only for a voice that exists and is playing the other shape. A
	 * MISSING voice is one whose load failed, already reported, and re-queueing that would be a
	 * retry loop with nothing between its turns.
	 */
	private queueStart(id: string): void {
		if (this.starting.has(id)) return;
		this.starting.add(id);
		// Loading from the moment it is asked for: a row waiting its turn behind another's
		// download is not sounding either, and a row that says nothing reads as one that is.
		this.loading.add(id);
		this.loadChain = this.loadChain
			.then(() => this.startVoice(id))
			.catch((error: unknown) => {
				console.error(`Ambient voice "${id}" could not be started`, error);
			})
			.finally(() => {
				this.starting.delete(id);
				this.loading.delete(id);
				const config = this.config;
				if (!config || !this.playing || !(id in config.levels)) return;
				const voice = this.voices.get(id);
				if (voice && voice.seamless !== config.seamless) this.queueStart(id);
			});
	}

	private async startVoice(id: string): Promise<void> {
		const ac = this.ctx;
		const master = this.master;
		if (!ac || !master || !this.config) return;
		const seamless = this.config.seamless;
		const buffer = await this.loadBuffer(ac, id, seamless);

		// The mix can have moved on entirely while this was loading.
		const config = this.config;
		if (!buffer || !this.playing || !(id in config.levels) || config.seamless !== seamless) {
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
		const tone = ac.createBiquadFilter();
		tone.type = 'highshelf';
		tone.frequency.value = WALL_HZ;
		tone.gain.value = 0;
		const level = ac.createGain();
		level.gain.value = 0;
		const dry = ac.createGain();
		dry.gain.value = 1;
		const send = ac.createGain();
		send.gain.value = 0;
		source.connect(drift).connect(tone).connect(level);
		level.connect(dry).connect(master);
		// A random entry point, so several recordings starting together do not replay their
		// opening second in unison.
		source.start(0, Math.random() * buffer.duration);
		const target = this.levelFor(id);
		level.gain.linearRampToValueAtTime(target, ac.currentTime + VOICE_FADE);

		this.voices.set(id, {
			id,
			source,
			drift,
			tone,
			level,
			dry,
			send,
			sendWired: false,
			applied: { level: target, muffled: false, distant: false },
			driftUntil: 0,
			seamless
		});
		// A voice that arrives after `apply` has been and gone still owes itself both of these.
		this.applyPlacement();
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
			voice.tone.disconnect();
			voice.level.disconnect();
			voice.dry.disconnect();
			voice.send.disconnect();
		};
		try {
			voice.source.stop(ac.currentTime + VOICE_FADE + 0.05);
		} catch {
			// Already stopped, which is the outcome this asked for anyway.
		}
	}

	private applyDrift(): void {
		const on = this.config?.drift === true && this.playing;
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
