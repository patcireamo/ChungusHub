import {
	readSetting,
	registerSettingsReload,
	BurstSettingWriter
} from '$lib/services/syncedSetting';
import {
	SOUND_EVENTS,
	TONE_IDS,
	type SoundEventId,
	type ToneId
} from '$lib/config/sound-events';

/** Whether a sound waits for the window to lose focus, or plays whatever you are doing. */
export type SoundTiming = 'away' | 'always';

interface AudioSettings {
	/** The one switch over everything below, so a reader can go quiet without losing which
	 *  tone they picked for what. Off on a fresh install: an app that has never made a sound
	 *  must not start making one because it updated. */
	enabled: boolean;
	timing: SoundTiming;
	/** 0–1, multiplied by the tone's own loudness correction at playback. */
	volume: number;
	/** Per event, or null for an event that stays silent while the rest play. */
	tones: Record<SoundEventId, ToneId | null>;
}

const SETTINGS_KEY = 'audioSettings';

function defaultTones(): Record<SoundEventId, ToneId | null> {
	return Object.fromEntries(SOUND_EVENTS.map((e) => [e.id, e.defaultTone])) as Record<
		SoundEventId,
		ToneId | null
	>;
}

const DEFAULT_SETTINGS: AudioSettings = {
	enabled: false,
	timing: 'away',
	volume: 0.6,
	tones: defaultTones()
};

function clampVolume(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/** Coerce a raw settings blob into a valid config, dropping anything unexpected. A stored
 *  null is a real answer (that event is silent) and survives; only a missing or unknown
 *  entry falls back to the event's shipped tone. */
function normalize(raw: Partial<AudioSettings> | null): AudioSettings {
	const tones = defaultTones();
	for (const event of SOUND_EVENTS) {
		const stored = raw?.tones?.[event.id];
		if (stored === null) tones[event.id] = null;
		else if (typeof stored === 'string' && TONE_IDS.includes(stored as ToneId)) {
			tones[event.id] = stored as ToneId;
		}
	}
	return {
		enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
		timing: raw?.timing === 'always' || raw?.timing === 'away' ? raw.timing : DEFAULT_SETTINGS.timing,
		volume:
			typeof raw?.volume === 'number' && Number.isFinite(raw.volume)
				? clampVolume(raw.volume)
				: DEFAULT_SETTINGS.volume,
		tones
	};
}

class AudioSettingsStore {
	/** Every knob on this page is a slider, a pill or a chip, so the writes come in bursts:
	 *  a volume drag fires per pointer move, and auditioning tones is a run of taps. */
	private writer = new BurstSettingWriter<AudioSettings>(SETTINGS_KEY);

	settings = $state<AudioSettings>({ ...DEFAULT_SETTINGS, tones: defaultTones() });

	enabled = $derived(this.settings.enabled);
	timing = $derived(this.settings.timing);
	volume = $derived(this.settings.volume);

	/** How many events would actually make a sound right now: the Settings root row's line. */
	activeCount = $derived(SOUND_EVENTS.filter((e) => this.settings.tones[e.id] !== null).length);

	async initialize(): Promise<void> {
		this.settings = normalize(await readSetting<Partial<AudioSettings> | null>(SETTINGS_KEY, null));
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		// A write still owed is newer than anything the server can hand back, so taking the
		// reload would drag the slider backwards under the finger holding it.
		if (this.writer.busy) return;
		this.settings = normalize(await readSetting<Partial<AudioSettings> | null>(SETTINGS_KEY, null));
	}

	toneFor(event: SoundEventId): ToneId | null {
		return this.settings.tones[event] ?? null;
	}

	setEnabled(enabled: boolean): void {
		this.settings.enabled = enabled;
		this.persist();
	}

	setTiming(timing: SoundTiming): void {
		this.settings.timing = timing;
		this.persist();
	}

	setVolume(volume: number): void {
		this.settings.volume = clampVolume(volume);
		this.persist();
	}

	setTone(event: SoundEventId, tone: ToneId | null): void {
		this.settings.tones[event] = tone;
		this.persist();
	}

	private persist(): void {
		this.writer.write({ ...this.settings, tones: { ...this.settings.tones } });
	}
}

export const audioSettingsStore = new AudioSettingsStore();
