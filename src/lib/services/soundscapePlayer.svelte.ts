/**
 * The soundscape engine: what the mix actually sounds like.
 *
 * Every recording is prepared before it plays, one after another: fetched, decoded (only the
 * front of it), cut into a loop, and rendered offline with its placement and loudness boost
 * baked into the samples (services/soundscapeBake.ts). What plays the result depends on the
 * browser:
 *
 *     media output:   <audio loop> playing the loop as a WAV, one element per voice
 *     engine output:  AudioBufferSourceNode (loop) -> GainNode -> destination
 *
 * Neither output automates anything. Every voice's loudness (the reader's knobs, its drift, its
 * fades) is worked out here by one function (services/soundscapeMix.ts) and pushed to the
 * element's volume or the node's gain, by a tick that runs only while something is moving.
 *
 * The store is the only caller: it hands over a whole config and this reconciles against what
 * is already sounding, so nothing here has to trust a diff somebody else worked out.
 */
import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	NotMp3Error,
	audioContext,
	claimMediaPlayback,
	decodeAudioPrefix,
	fetchAudioBytes,
	restAudio,
	resumeAudio
} from '$lib/services/audioContext';
import { CROSSFADE_SECONDS, LOOP_SECONDS, buildLoopBuffer } from '$lib/services/loopBuffer';
import { bakeLoop } from '$lib/services/soundscapeBake';
import {
	DRIFT_MIN_SECONDS,
	driftAt,
	fadeAt,
	fadeDone,
	fadeTo,
	holdAt,
	nextDriftLeg,
	steadyDrift,
	voiceLoudness,
	type DriftLeg,
	type Fade
} from '$lib/services/soundscapeMix';
import { encodeWav } from '$lib/services/wav';
import { normalizeGain, soundById, soundUrl } from '$lib/config/soundscape';
import type { SoundscapeConfig } from '$lib/stores/soundscape.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

// Gecko loops a media element gaplessly and keeps it sounding under page load that starves its
// Web Audio; Chromium leaves a ~10 ms hole at every media loop, and WebKit ignores a set volume.
const MEDIA_OUTPUT = typeof navigator !== 'undefined' && /\bFirefox\/\d/.test(navigator.userAgent);

/** An element's volume never reaches a true zero: Firefox lets a silent element start without a
 *  gesture, then pauses it itself once it turns audible, which would read as the reader pausing. */
const MEDIA_FLOOR = 1e-4;

/** A voice fades rather than cuts, at every edge: joining, leaving, being replaced. */
const VOICE_FADE = 0.45;
/** The whole mix starting or stopping. Slower, because it is the scene arriving. */
const MIX_FADE = 0.9;
/** Drift switched off hands every level back over one slow leg rather than a jump. */
const DRIFT_SETTLE = 1.5;
/** Fine enough that a fade reads as a glide. The tick stops whenever nothing is moving. */
const TICK_MS = 30;
/** A wander moves at most 6 dB over eight seconds, so between fades a step this far apart is still
 *  far under anything audible, and every element volume set is one message to the audio process. */
const DRIFT_TICK_MS = 250;
/** How often the mixer's drift marks are re-read. A leg runs for at least eight seconds, so this
 *  is far finer than the motion and a mark moves imperceptibly between samples. */
const SAMPLE_MS = 100;
/** Smooths each tick's step on the audio thread, well inside one tick. */
const GAIN_SMOOTHING = 0.015;
/** A context still not running this long after the press is being held, not merely starting. */
const BLOCKED_GRACE_SECONDS = 0.4;
/** What the media output decodes and bakes at: the rate a phone's audio hardware runs. */
const MEDIA_SAMPLE_RATE = 48000;

/**
 * Asked for on top of what is actually kept, because the prefix is cut by proportion of the
 * file's bytes: the tag at the head of an MP3 rides inside that share, and a variable bitrate
 * spends itself unevenly, so a share cut to the exact second can land short of it. Coming up
 * short only costs a shorter loop, and the decode falls back to the whole file if a prefix
 * ending mid-frame is refused outright, so this is margin rather than a guarantee.
 */
const PREFIX_MARGIN_SECONDS = 8;

/** One recording prepared for one loop shape and one placement. */
interface Job {
	key: string;
	id: string;
	seamless: boolean;
	muffled: boolean;
	distant: boolean;
}

type Asset =
	| { kind: 'media'; key: string; bakedGain: number; url: string }
	| { kind: 'engine'; key: string; bakedGain: number; buffer: AudioBuffer };

interface Voice {
	id: string;
	key: string;
	asset: Asset;
	normalizeGain: number;
	/** The recording's level, remembered for the fade out after it has left the mix. */
	level: number;
	/** Audible: the element's first `playing`, or the node's start. */
	started: boolean;
	dead: boolean;
	fade: Fade;
	drift: DriftLeg;
	/** The loudness last pushed, so an unchanged one is never pushed again. */
	pushed: number;
	el: HTMLAudioElement | null;
	/** Drops every listener on `el` at once. */
	listeners: AbortController | null;
	/** Its random entry point is set, so a play() now starts where it should. */
	primed: boolean;
	/** Its last play() was refused for want of a gesture. */
	blocked: boolean;
	/** A play() or pause() this player asked for, so the element's own events can be told
	 *  apart from the operating system's media controls. */
	selfPlay: boolean;
	selfPause: boolean;
	nodes: { source: AudioBufferSourceNode; gain: GainNode } | null;
}

const clock = (): number => performance.now() / 1000;

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message || error.name : String(error);
}

/** Bring `target` to `next`, writing only what changed. Untracked, since iterating it would
 *  otherwise make a calling effect depend on the set it is writing. */
function publish(target: SvelteSet<string>, next: ReadonlySet<string>): void {
	untrack(() => {
		for (const id of target) if (!next.has(id)) target.delete(id);
		for (const id of next) target.add(id);
	});
}

class SoundscapePlayer {
	/** Recordings in a playing mix with nothing of them sounding yet: queued, being prepared, or
	 *  waiting on their element. The mixer draws those rows as loading. */
	loading = new SvelteSet<string>();
	/** Recordings in the mix whose last preparation failed. Only leaving the mix clears it, so
	 *  removing and re-adding one is the retry. */
	failed = new SvelteSet<string>();
	/** Recordings with a voice that has started and has not been told to leave, paused or not. */
	sounding = new SvelteSet<string>();
	/** Recordings still sounding while their replacement (a new placement or loop shape) is
	 *  being prepared. */
	updating = new SvelteSet<string>();
	/** Set by the store: the operating system's media controls paused or resumed the mix. */
	onExternalPlaying(handler: (playing: boolean) => void): void {
		this.externalPlaying = handler;
	}
	private externalPlaying: ((playing: boolean) => void) | null = null;
	/** True while the browser refuses to let a playing mix be heard, so the mixer can name the
	 *  missing gesture instead of showing a mix that is silently not playing. */
	blocked = $state(false);
	/** What each recording's drift multiplies its level by now, sampled only while something
	 *  draws it (`watchDrift`): the drift runs on this player's clock and announces nothing. */
	liveDrift = new SvelteMap<string, number>();

	private config: SoundscapeConfig | null = null;
	/** Whether the reader has pressed play. The store owns the reactive copy. */
	private playing = false;
	/** The voice each recording is heard through, or is about to be. */
	private live = new Map<string, Voice>();
	/** A replacement, silent until it is heard and takes over from the live voice. */
	private incoming = new Map<string, Voice>();
	/** Fading out, destroyed once the fade lands. */
	private leaving = new Set<Voice>();
	private assets = new Map<string, Asset>();
	private queue: Job[] = [];
	private preparing: Job | null = null;
	private pumping = false;
	/** What `failed` publishes. Nothing here reads its own reactive state. */
	private failedIds = new Set<string>();
	private mixFade: Fade = holdAt(0);
	/** The mix has faded out and its outputs are paused or suspended. */
	private rested = true;
	private pausedAt: number | null = null;
	private graceUntil = 0;
	private restToken = 0;
	private ctx: AudioContext | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private tickEvery = 0;
	private sampleTimer: ReturnType<typeof setInterval> | null = null;
	private watchers = 0;
	private gestureArmed = false;
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
			const now = clock();
			for (const id of this.liveDrift.keys()) {
				if (!this.live.get(id)?.started) this.liveDrift.delete(id);
			}
			for (const [id, voice] of this.live) {
				if (!voice.started) continue;
				const value = driftAt(voice.drift, now);
				// A level that is not drifting reports the same number every tick, so an idle
				// mix writes nothing at all and redraws nothing.
				if (this.liveDrift.get(id) !== value) this.liveDrift.set(id, value);
			}
		});
	}

	/** Take a whole config plus whether the mix is running, and make the outputs match. */
	apply(config: SoundscapeConfig, playing: boolean): void {
		const drifted = this.config?.drift === true;
		const wasPlaying = this.playing;
		this.config = config;
		this.playing = playing;
		if (typeof window === 'undefined') return;

		const now = clock();
		for (const id of this.failedIds) {
			if (!(id in config.levels)) this.failedIds.delete(id);
		}
		if (playing && !wasPlaying) this.start(now);
		if (!playing && wasPlaying) this.stop(now);
		if (drifted && !config.drift) this.settleDrift(now);
		this.reconcile();
		this.tick();
	}

	/** Runs inside the press that starts the mix: WebKit starts a context only within the gesture
	 *  itself, and the iOS claim goes first so the ringer switch cannot silence the opening. */
	private start(now: number): void {
		if (this.pausedAt !== null) {
			// Drift stood still while the mix was paused, and picks up where it was.
			const paused = now - this.pausedAt;
			for (const voice of this.live.values()) {
				const leg = voice.drift;
				voice.drift = { ...leg, start: leg.start + paused, end: leg.end + paused };
			}
			this.pausedAt = null;
		}
		this.rested = false;
		this.mixFade = fadeTo(fadeAt(this.mixFade, now), 1, now, MIX_FADE);
		if (MEDIA_OUTPUT) {
			for (const voice of this.live.values()) this.playElement(voice);
			return;
		}
		if (!this.context()) return;
		claimMediaPlayback(true);
		resumeAudio();
		this.graceUntil = now + BLOCKED_GRACE_SECONDS;
		setTimeout(() => this.updateBlocked(), BLOCKED_GRACE_SECONDS * 1000 + 20);
	}

	/** The mix fades out first and `rest` pauses the outputs once it has. A voice nobody has
	 *  heard yet goes at once: its prepared loop stays cached for the next start. */
	private stop(now: number): void {
		this.mixFade = fadeTo(fadeAt(this.mixFade, now), 0, now, MIX_FADE);
		for (const voice of [...this.live.values(), ...this.incoming.values()]) {
			if (!voice.started) this.destroy(voice);
		}
		this.disarmGesture();
	}

	/** Voices stay alive through a pause, so the next start is a fade in rather than a reload. */
	private rest(): void {
		this.rested = true;
		this.pausedAt = clock();
		for (const voice of this.leaving) this.destroy(voice);
		if (MEDIA_OUTPUT) {
			for (const voice of this.live.values()) this.pauseElement(voice);
			return;
		}
		// The claim is handed back only once the context has stopped: sooner, a phone on silent
		// would cut the end of the fade off.
		const token = ++this.restToken;
		void restAudio().then(() => {
			if (!this.playing && token === this.restToken) claimMediaPlayback(false);
		});
	}

	/** Once, on the switch going off: every level heads back to where its slider says. */
	private settleDrift(now: number): void {
		for (const voice of this.live.values()) {
			voice.drift = this.rested
				? steadyDrift()
				: { from: driftAt(voice.drift, now), to: 1, start: now, end: now + DRIFT_SETTLE };
		}
	}

	/** Make the voices match the config: drop what left the mix, start or replace what is
	 *  ready, and queue what is not. */
	private reconcile(): void {
		const config = this.config;
		if (!config) return;
		const now = clock();
		for (const voice of this.incoming.values()) {
			if (voice.key !== this.desiredKey(voice.id)) this.destroy(voice);
		}
		for (const voice of this.live.values()) {
			if (!(voice.id in config.levels)) this.retire(voice, now);
		}
		if (this.playing) {
			for (const id of Object.keys(config.levels)) {
				if (this.failedIds.has(id) || this.incoming.has(id)) continue;
				const job = this.jobFor(id, config);
				const live = this.live.get(id);
				if (live?.key === job.key) continue;
				const asset = this.assets.get(job.key);
				if (!asset) {
					this.enqueue(job);
					continue;
				}
				if (live && !live.started) this.destroy(live);
				this.createVoice(id, asset);
			}
		}
		this.queue = this.queue.filter((job) => this.wants(job));
		this.evict();
		this.syncStatus();
	}

	/** A voice whose recording left the mix fades out if anyone can hear it, and goes at once
	 *  if nobody can. */
	private retire(voice: Voice, now: number): void {
		if (!voice.started || fadeAt(this.mixFade, now) === 0) {
			this.destroy(voice);
			return;
		}
		this.live.delete(voice.id);
		voice.fade = fadeTo(fadeAt(voice.fade, now), 0, now, VOICE_FADE);
		this.leaving.add(voice);
	}

	private jobFor(id: string, config: SoundscapeConfig): Job {
		const placed = config.effects[id];
		const muffled = placed?.muffled === true;
		const distant = placed?.distant === true;
		const key = [id, config.seamless ? 'seamless' : 'raw', muffled && 'muffled', distant && 'distant']
			.filter(Boolean)
			.join(':');
		return { key, id, seamless: config.seamless, muffled, distant };
	}

	/** What `id` should be heard as now, or null while nothing of it should be prepared. */
	private desiredKey(id: string): string | null {
		const config = this.config;
		if (!config || !this.playing || !(id in config.levels) || this.failedIds.has(id)) return null;
		return this.jobFor(id, config).key;
	}

	private wants(job: Job): boolean {
		return this.desiredKey(job.id) === job.key;
	}

	private enqueue(job: Job): void {
		if (this.preparing?.key !== job.key && !this.queue.some((queued) => queued.key === job.key)) {
			this.queue.push(job);
		}
		void this.pump();
	}

	/** Recordings are prepared one after another: four at once is four downloads, decodes and
	 *  renders asked of a phone in one breath, collected as memory under the mix already playing. */
	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			for (let job = this.queue.shift(); job; job = this.queue.shift()) {
				if (!this.wants(job)) continue;
				this.preparing = job;
				try {
					const asset = await this.prepare(job);
					if (asset) this.assets.set(job.key, asset);
				} catch (error) {
					console.error(`Ambient sound "${job.id}" could not be prepared`, error);
					if (this.wants(job)) this.fail(job.id, error);
				}
				this.preparing = null;
				this.reconcile();
			}
		} finally {
			this.pumping = false;
			this.preparing = null;
		}
	}

	/** Fetch, decode, loop and bake one recording, giving up between stages once nobody wants it,
	 *  and letting each intermediate go once the next has it: a decode is tens of megabytes. */
	private async prepare(job: Job): Promise<Asset | null> {
		const sound = soundById(job.id);
		if (!sound) throw new Error(`No recording is called "${job.id}"`);
		let bytes: ArrayBuffer | null = await fetchAudioBytes(soundUrl(sound));
		if (!this.wants(job)) return null;

		// Only the front of a recording is ever kept, so only the front is decoded, and offline,
		// so the media output never opens a realtime context at all.
		const decoder = new OfflineAudioContext(1, 1, this.decodeRate());
		let decoded: AudioBuffer | null = await decodeAudioPrefix(decoder, bytes, {
			keepSeconds: LOOP_SECONDS + CROSSFADE_SECONDS + PREFIX_MARGIN_SECONDS,
			totalSeconds: sound.seconds
		});
		bytes = null;
		if (!this.wants(job)) return null;

		let loop: AudioBuffer | null = buildLoopBuffer(decoder, decoded, job.seamless);
		decoded = null;
		// Baked whatever the normalize switch says, so flipping it only ever moves a volume.
		const baked = await bakeLoop(loop, job, Math.max(normalizeGain(sound), 1));
		loop = null;
		if (!this.wants(job)) return null;

		const sampleRate = baked.owner.sampleRate;
		if (MEDIA_OUTPUT) {
			const wav = encodeWav(baked.channels, sampleRate);
			const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
			return { kind: 'media', key: job.key, bakedGain: baked.bakedGain, url };
		}
		const length = baked.channels[0].length;
		let buffer = baked.owner;
		if (buffer.length !== length) {
			const loopOnly = new AudioBuffer({ numberOfChannels: baked.channels.length, length, sampleRate });
			baked.channels.forEach((data, ch) => loopOnly.getChannelData(ch).set(data));
			buffer = loopOnly;
		}
		return { kind: 'engine', key: job.key, bakedGain: baked.bakedGain, buffer };
	}

	private decodeRate(): number {
		return MEDIA_OUTPUT ? MEDIA_SAMPLE_RATE : (this.ctx?.sampleRate ?? MEDIA_SAMPLE_RATE);
	}

	private fail(id: string, error: unknown): void {
		this.failedIds.add(id);
		if (this.loadWarned) return;
		this.loadWarned = true;
		const label = soundById(id)?.label ?? id;
		toastStore.error(
			error instanceof NotMp3Error
				? `Couldn't load the "${label}" sound. A download manager extension may be taking it before the app gets it.`
				: `Couldn't load the "${label}" sound: ${reasonOf(error)}`
		);
	}

	private createVoice(id: string, asset: Asset): void {
		const sound = soundById(id);
		const voice: Voice = {
			id,
			key: asset.key,
			asset,
			normalizeGain: sound ? normalizeGain(sound) : 1,
			level: this.config?.levels[id] ?? 0,
			started: false,
			dead: false,
			fade: holdAt(0),
			drift: steadyDrift(),
			pushed: -1,
			el: null,
			listeners: null,
			primed: false,
			blocked: false,
			selfPlay: false,
			selfPause: false,
			nodes: null
		};
		if (this.live.get(id)?.started) this.incoming.set(id, voice);
		else this.live.set(id, voice);
		if (asset.kind === 'media') this.mountElement(voice, asset.url);
		else this.mountNodes(voice, asset.buffer);
	}

	private mountElement(voice: Voice, url: string): void {
		const el = new Audio();
		const listeners = new AbortController();
		const signal = listeners.signal;
		voice.el = el;
		voice.listeners = listeners;
		el.loop = true;
		el.preload = 'auto';
		el.volume = MEDIA_FLOOR;
		el.addEventListener(
			'loadedmetadata',
			() => {
				// A random entry point, so recordings starting together do not replay their
				// opening second in unison.
				if (Number.isFinite(el.duration)) el.currentTime = Math.random() * el.duration;
				voice.primed = true;
				if (this.playing) this.playElement(voice);
			},
			{ once: true, signal }
		);
		el.addEventListener(
			'playing',
			() => (this.rested ? this.pauseElement(voice) : this.voiceStarted(voice)),
			{ signal }
		);
		el.addEventListener('play', () => this.elementPlayed(voice), { signal });
		el.addEventListener('pause', () => this.elementPaused(voice), { signal });
		el.addEventListener(
			'error',
			() => this.voiceFailed(voice, new Error(el.error?.message || 'The recording could not be played')),
			{ signal }
		);
		el.src = url;
	}

	private mountNodes(voice: Voice, buffer: AudioBuffer): void {
		const ac = this.context();
		if (!ac) {
			this.voiceFailed(voice, new Error('There is no audio output to play through'));
			return;
		}
		const source = ac.createBufferSource();
		source.buffer = buffer;
		source.loop = true;
		const gain = ac.createGain();
		gain.gain.value = 0;
		source.connect(gain).connect(ac.destination);
		source.start(0, Math.random() * buffer.duration);
		voice.nodes = { source, gain };
		this.voiceStarted(voice);
	}

	private voiceStarted(voice: Voice): void {
		if (voice.started || voice.dead) return;
		voice.started = true;
		const now = clock();
		voice.fade = fadeTo(0, 1, now, VOICE_FADE);
		if (this.incoming.get(voice.id) === voice) {
			this.incoming.delete(voice.id);
			const outgoing = this.live.get(voice.id);
			this.live.set(voice.id, voice);
			if (outgoing) {
				// The replacement already carries its placement, so the two simply trade places
				// and nothing unplaced is heard while one settles.
				voice.drift = { ...outgoing.drift };
				voice.fade = fadeTo(0, 1, now, VOICE_FADE, 'in');
				outgoing.fade = fadeTo(fadeAt(outgoing.fade, now), 0, now, VOICE_FADE, 'out');
				this.leaving.add(outgoing);
			}
		}
		this.syncStatus();
		this.tick();
	}

	private voiceFailed(voice: Voice, error: unknown): void {
		if (voice.dead) return;
		console.error(`Ambient sound "${voice.id}" could not be played`, error);
		const wanted = voice.key === this.desiredKey(voice.id);
		this.destroy(voice);
		if (wanted) this.fail(voice.id, error);
		this.reconcile();
	}

	private destroy(voice: Voice): void {
		if (voice.dead) return;
		voice.dead = true;
		voice.blocked = false;
		if (this.live.get(voice.id) === voice) this.live.delete(voice.id);
		if (this.incoming.get(voice.id) === voice) this.incoming.delete(voice.id);
		this.leaving.delete(voice);
		voice.listeners?.abort();
		const el = voice.el;
		if (el) {
			el.pause();
			el.removeAttribute('src');
			el.load();
		}
		const nodes = voice.nodes;
		const ac = this.ctx;
		if (nodes && ac) {
			const release = (): void => {
				nodes.source.disconnect();
				nodes.gain.disconnect();
			};
			// A running context gets a moment for the gain to finish settling at zero first.
			if (ac.state === 'running') {
				nodes.source.onended = release;
				nodes.source.stop(ac.currentTime + 0.1);
			} else {
				nodes.source.stop();
				release();
			}
		}
		this.evict();
	}

	/** Keep only the loops something can still use: a voice's (sounding, paused or fading) and
	 *  what each recording in the mix is set to now, so a switch flipped twice never holds both. */
	private evict(): void {
		const keep = new Set<string>();
		for (const voice of this.voices()) keep.add(voice.key);
		const config = this.config;
		if (config) {
			for (const id of Object.keys(config.levels)) keep.add(this.jobFor(id, config).key);
		}
		for (const [key, asset] of this.assets) {
			if (keep.has(key)) continue;
			this.assets.delete(key);
			if (asset.kind === 'media') URL.revokeObjectURL(asset.url);
		}
	}

	private *voices(): IterableIterator<Voice> {
		yield* this.live.values();
		yield* this.incoming.values();
		yield* this.leaving;
	}

	/** Push every voice's loudness for now. On a timer only while something moves (a fade, a
	 *  drifting level); `apply` calls it directly, so a slider moves the sound on the same frame. */
	private tick(): void {
		const config = this.config;
		if (!config) return;
		const now = clock();
		const mix = fadeAt(this.mixFade, now);
		let fading = !fadeDone(this.mixFade, now);
		let drifting = false;
		if (config.drift && this.playing) {
			for (const voice of this.live.values()) {
				if (voice.started && now >= voice.drift.end) {
					voice.drift = nextDriftLeg(driftAt(voice.drift, now), now);
				}
			}
		}
		for (const voice of this.voices()) {
			if (voice.id in config.levels) voice.level = config.levels[voice.id];
			this.push(
				voice,
				voiceLoudness({
					level: voice.level,
					volume: config.volume,
					drift: driftAt(voice.drift, now),
					fade: fadeAt(voice.fade, now) * mix,
					normalize: config.normalize,
					normalizeGain: voice.normalizeGain,
					bakedGain: voice.asset.bakedGain
				})
			);
			if (!fadeDone(voice.fade, now)) fading = true;
			if (this.playing && now < voice.drift.end) {
				// A settling leg is short and steep, so it glides at the fade's pace.
				if (voice.drift.end - voice.drift.start < DRIFT_MIN_SECONDS) fading = true;
				else drifting = true;
			}
		}
		for (const voice of this.leaving) {
			if (fadeDone(voice.fade, now)) this.destroy(voice);
		}
		if (!this.playing && !this.rested && fadeDone(this.mixFade, now)) this.rest();
		this.scheduleTick(fading ? TICK_MS : drifting ? DRIFT_TICK_MS : 0);
	}

	private scheduleTick(every: number): void {
		if (every === this.tickEvery) return;
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = every > 0 ? setInterval(() => this.tick(), every) : null;
		this.tickEvery = every;
	}

	private push(voice: Voice, value: number): void {
		if (value === voice.pushed) return;
		voice.pushed = value;
		if (voice.el) voice.el.volume = Math.max(value, MEDIA_FLOOR);
		const ac = this.ctx;
		if (voice.nodes && ac) voice.nodes.gain.gain.setTargetAtTime(value, ac.currentTime, GAIN_SMOOTHING);
	}

	private playElement(voice: Voice): void {
		const el = voice.el;
		if (!el || voice.dead || !voice.primed || !el.paused) return;
		voice.selfPlay = true;
		voice.blocked = false;
		el.play().then(
			() => {
				voice.blocked = false;
				this.updateBlocked();
			},
			(error: unknown) => {
				// Refused outright, so no `play` event is coming to take the flag back. Every other
				// refusal comes after that event has already been and gone.
				if ((error as { name?: unknown } | null)?.name !== 'NotAllowedError') return;
				voice.selfPlay = false;
				if (voice.dead) return;
				voice.blocked = true;
				this.updateBlocked();
				if (this.playing) this.armGesture();
			}
		);
	}

	private pauseElement(voice: Voice): void {
		const el = voice.el;
		if (!el || el.paused) return;
		voice.selfPause = true;
		el.pause();
	}

	/** Firefox puts a playing page's media in the notification shade, and a play pressed there
	 *  is the reader starting the mix just as surely as the button on the card. */
	private elementPlayed(voice: Voice): void {
		if (voice.selfPlay) {
			voice.selfPlay = false;
			return;
		}
		if (this.playing) return;
		this.externalPlaying?.(true);
		// Nobody took the mix up, and a stopped mix may not go on playing underneath.
		if (!this.playing) this.pauseElement(voice);
	}

	private elementPaused(voice: Voice): void {
		if (voice.selfPause) {
			voice.selfPause = false;
			return;
		}
		if (this.playing && !voice.el?.error) this.externalPlaying?.(false);
	}

	/** An element refused for want of a gesture retries on the next one anywhere in the app, in
	 *  the capture phase so nothing that stops the event can keep the mix silent. A click rather
	 *  than a pointerdown: a finger grants activation only as it lifts. */
	private armGesture(): void {
		if (this.gestureArmed || typeof document === 'undefined') return;
		this.gestureArmed = true;
		document.addEventListener('click', this.retryInGesture, { capture: true });
		document.addEventListener('keydown', this.retryInGesture, { capture: true });
	}

	private disarmGesture(): void {
		if (!this.gestureArmed) return;
		this.gestureArmed = false;
		document.removeEventListener('click', this.retryInGesture, { capture: true });
		document.removeEventListener('keydown', this.retryInGesture, { capture: true });
	}

	private retryInGesture = (): void => {
		this.disarmGesture();
		if (!this.playing) return;
		for (const voice of [...this.live.values(), ...this.incoming.values()]) this.playElement(voice);
	};

	private context(): AudioContext | null {
		if (this.ctx) return this.ctx;
		const ac = audioContext();
		if (!ac) return null;
		this.ctx = ac;
		// The gesture that unlocks audio lands anywhere in the app (services/audioContext.ts),
		// so what a held mix waits on is this, not a press on the mixer.
		ac.addEventListener('statechange', () => this.updateBlocked());
		return ac;
	}

	private updateBlocked(): void {
		if (!this.playing) {
			this.blocked = false;
		} else if (MEDIA_OUTPUT) {
			this.blocked = [...this.live.values(), ...this.incoming.values()].some((voice) => voice.blocked);
		} else if (this.ctx?.state === 'running') {
			this.blocked = false;
		} else if (clock() >= this.graceUntil) {
			// Not before the grace is out: a context resuming takes a moment, and naming a block
			// for that moment would flash the warning on every press.
			this.blocked = true;
		}
	}

	/** Publish what the mixer reads. Only a change of membership is written, so an `apply` on
	 *  every pointer frame of a drag redraws nothing. */
	private syncStatus(): void {
		const config = this.config;
		const sounding = new Set<string>();
		const loading = new Set<string>();
		const updating = new Set<string>();
		for (const [id, voice] of this.live) {
			if (voice.started) sounding.add(id);
		}
		if (config && this.playing) {
			for (const id of Object.keys(config.levels)) {
				if (this.failedIds.has(id)) continue;
				const live = this.live.get(id);
				if (!live?.started) loading.add(id);
				else if (live.key !== this.jobFor(id, config).key) updating.add(id);
			}
		}
		publish(this.sounding, sounding);
		publish(this.loading, loading);
		publish(this.updating, updating);
		publish(this.failed, this.failedIds);
		this.updateBlocked();
	}
}

export const soundscapePlayer = new SoundscapePlayer();
