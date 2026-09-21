/**
 * The soundscape: which recordings are in the mix, how loud each one is, and the three
 * switches over the whole thing.
 *
 * The store is the only writer. Every mutation goes through `sync`, which persists to the
 * settings spine and hands the same config to the player, so what is stored and what is
 * sounding can never be two different answers. The player holds no subscription of its own
 * for that reason: a second reader of this state would be a second thing to keep in step.
 */
import {
	BurstSettingWriter,
	readSetting,
	registerSettingsReload
} from '$lib/services/syncedSetting';
import { AMBIENT_SOUNDS, soundById } from '$lib/config/soundscape';
import { soundscapePlayer } from '$lib/services/soundscapePlayer.svelte';

const SETTINGS_KEY = 'soundscapeConfig';

/** Where a recording joins the mix: loud enough to hear, with room to go either way. */
export const DEFAULT_LEVEL = 0.5;
export const DEFAULT_VOLUME = 0.5;

/**
 * Where one recording is standing, relative to the reader.
 *
 * The two are different things rather than two strengths of one, which is what makes them
 * independent: `muffled` is something in the way (a wall, a window, a hull) eating the top of
 * the sound, `distant` is open ground between here and there, which costs level and hands back
 * the space in between. Both at once is a real place to be, the far side of a wall and some way
 * off down the street.
 */
export interface SoundEffects {
	muffled: boolean;
	distant: boolean;
}

export const NO_EFFECTS: SoundEffects = { muffled: false, distant: false };

export interface SoundscapeConfig {
	/** 0-1 over the whole mix. */
	volume: number;
	/** 0-1 per recording. A key here IS membership of the mix. */
	levels: Record<string, number>;
	/** Per recording, and only for the ones standing somewhere other than here: a recording
	 *  with nothing on is absent, so the ordinary mix stores nothing at all. */
	effects: Record<string, SoundEffects>;
	/** Join each recording's end to its own beginning, so the loop has no seam. */
	seamless: boolean;
	/** Bring every recording to one measured loudness (config/soundscape.ts). */
	normalize: boolean;
	/** Let each level wander slowly around where it was set. */
	drift: boolean;
}

const DEFAULT_CONFIG: SoundscapeConfig = {
	volume: DEFAULT_VOLUME,
	levels: {},
	effects: {},
	seamless: true,
	normalize: true,
	drift: false
};

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerce a raw blob into a valid config, the settings-store convention.
 *
 * A level naming a recording this build does not ship is dropped rather than kept: the player
 * would fetch a file that is not there, and a mix cannot hold something nobody can hear.
 */
function normalize(raw: Partial<SoundscapeConfig> | null): SoundscapeConfig {
	const levels: Record<string, number> = {};
	const stored = raw?.levels;
	if (stored && typeof stored === 'object') {
		for (const [id, value] of Object.entries(stored)) {
			if (!soundById(id)) continue;
			if (typeof value !== 'number' || !Number.isFinite(value)) continue;
			levels[id] = clamp01(value);
		}
	}

	// Placement only survives for a recording that is still in the mix, and only while it says
	// something: an all-false entry is the default written out longhand, and one whose recording
	// left the mix is a setting for a sound nobody can hear.
	const effects: Record<string, SoundEffects> = {};
	const storedEffects = raw?.effects;
	if (storedEffects && typeof storedEffects === 'object') {
		for (const [id, value] of Object.entries(storedEffects)) {
			if (!(id in levels) || !value || typeof value !== 'object') continue;
			const one: SoundEffects = {
				muffled: bool((value as Partial<SoundEffects>).muffled, false),
				distant: bool((value as Partial<SoundEffects>).distant, false)
			};
			if (one.muffled || one.distant) effects[id] = one;
		}
	}

	return {
		volume:
			typeof raw?.volume === 'number' && Number.isFinite(raw.volume)
				? clamp01(raw.volume)
				: DEFAULT_CONFIG.volume,
		levels,
		effects,
		seamless: bool(raw?.seamless, DEFAULT_CONFIG.seamless),
		normalize: bool(raw?.normalize, DEFAULT_CONFIG.normalize),
		drift: bool(raw?.drift, DEFAULT_CONFIG.drift)
	};
}

class SoundscapeStore {
	config = $state<SoundscapeConfig>({ ...DEFAULT_CONFIG, levels: {}, effects: {} });

	/**
	 * Whether the reader has pressed play, and **deliberately not persisted**.
	 *
	 * A mix is a room somebody chose to be in, not a preference the install carries: restored
	 * from storage it starts held by the browser's gesture gate and then bursts into sound at
	 * whatever later click happens to release it, which lands nowhere near the press that
	 * caused it. Starting from silence means the sound only ever begins on the press that asks
	 * for it. It is per-page for the same reason, so one device is never started from another.
	 */
	private started = $state(false);

	/** Every recording in the mix, in registry order rather than insertion order, so the
	 *  list on screen does not reshuffle itself as it is built. */
	activeIds = $derived(AMBIENT_SOUNDS.filter((s) => s.id in this.config.levels).map((s) => s.id));

	/** The Settings root row's line. */
	activeCount = $derived(this.activeIds.length);

	/** Whether anything is actually sounding: played AND something to play. */
	playing = $derived(this.started && this.activeIds.length > 0);

	private writer = new BurstSettingWriter<SoundscapeConfig>(SETTINGS_KEY);

	async initialize(): Promise<void> {
		this.config = normalize(await readSetting<Partial<SoundscapeConfig> | null>(SETTINGS_KEY, null));
		registerSettingsReload(() => this.syncReload());
		soundscapePlayer.apply(this.config, this.started);
	}

	async syncReload(): Promise<void> {
		const next = normalize(await readSetting<Partial<SoundscapeConfig> | null>(SETTINGS_KEY, null));
		// A write still owed is newer than anything the server can hand back, so taking this
		// would drag a slider out from under the finger holding it.
		if (this.writer.busy) return;
		this.take(next);
	}

	levelOf(id: string): number {
		return this.config.levels[id] ?? DEFAULT_LEVEL;
	}

	isActive(id: string): boolean {
		return id in this.config.levels;
	}

	effectsOf(id: string): SoundEffects {
		return this.config.effects[id] ?? NO_EFFECTS;
	}

	setEffect(id: string, key: keyof SoundEffects, on: boolean): void {
		if (!this.isActive(id)) return;
		const next = { ...this.effectsOf(id), [key]: on };
		const effects = { ...this.config.effects };
		if (next.muffled || next.distant) effects[id] = next;
		else delete effects[id];
		this.write({ ...this.config, effects });
	}

	/** Start or stop the mix. Runtime only: nothing about this reaches storage. */
	setPlaying(playing: boolean): void {
		this.started = playing && this.activeIds.length > 0;
		soundscapePlayer.apply(this.config, this.started);
	}

	setVolume(volume: number): void {
		this.write({ ...this.config, volume: clamp01(volume) });
	}

	setSeamless(seamless: boolean): void {
		this.write({ ...this.config, seamless });
	}

	setNormalize(normalizeLevels: boolean): void {
		this.write({ ...this.config, normalize: normalizeLevels });
	}

	setDrift(drift: boolean): void {
		this.write({ ...this.config, drift });
	}

	setLevel(id: string, level: number): void {
		if (!soundById(id) || !this.isActive(id)) return;
		this.write({ ...this.config, levels: { ...this.config.levels, [id]: clamp01(level) } });
	}

	/** Add or remove one recording. Its placement leaves with it, or a recording added back
	 *  later would arrive already standing somewhere the reader has long forgotten choosing. */
	toggleSound(id: string): void {
		if (!soundById(id)) return;
		const levels = { ...this.config.levels };
		const effects = { ...this.config.effects };
		if (id in levels) {
			delete levels[id];
			delete effects[id];
		} else {
			levels[id] = DEFAULT_LEVEL;
		}
		this.write({ ...this.config, levels, effects });
	}

	clear(): void {
		this.write({ ...this.config, levels: {}, effects: {} });
	}

	private write(next: SoundscapeConfig): void {
		this.take(next);
		this.writer.write(next);
	}

	/** Make `next` the mix, on screen and in the graph, whichever device it came from. An
	 *  emptied mix takes the press back with it, so the next recording added lands in a
	 *  stopped mix rather than starting to sound the instant it is picked. */
	private take(next: SoundscapeConfig): void {
		if (Object.keys(next.levels).length === 0) this.started = false;
		this.config = next;
		soundscapePlayer.apply(next, this.started);
	}
}

export const soundscapeStore = new SoundscapeStore();
