/**
 * The ambient recordings, in ONE place: what ships, what shelf each sits on, and the two
 * loudness figures measured off every file. Pure data, no imports, the same shape
 * config/sound-events.ts has for the notification tones.
 *
 * The files live in `defaults/sounds/<category>/<id>.mp3` and are served from there
 * (architecture/build-packaging.md). A recording added to the folder is an entry here with
 * its two measurements taken, and nothing else; contracts.test.ts refuses a registry entry
 * with no file and a file with no entry.
 */

export const SOUND_CATEGORIES = [
	{ id: 'nature', label: 'Nature' },
	{ id: 'rain', label: 'Rain' },
	{ id: 'places', label: 'Places' },
	{ id: 'transport', label: 'Transport' },
	{ id: 'urban', label: 'Urban' }
] as const;

export type SoundCategory = (typeof SOUND_CATEGORIES)[number]['id'];

export interface AmbientSoundDef {
	/** Also the filename, and the key this sound wears in a stored mix. */
	id: string;
	label: string;
	category: SoundCategory;
	/**
	 * Integrated loudness (EBU R128) and true peak, both dB, measured off the shipped file
	 * with `ffmpeg -af ebur128=peak=true`. They are recorded rather than a finished gain
	 * because the target and the ceiling below are policy, not measurement: tuning either
	 * must not mean measuring 42 files again.
	 */
	lufs: number;
	peak: number;
	/**
	 * How long the recording runs, whole seconds, from
	 * `ffprobe -show_entries format=duration`.
	 *
	 * It is what lets the player decode a PREFIX of the file instead of all of it: only the
	 * first `LOOP_SECONDS` are ever kept, and decoding five minutes to keep one costs a phone
	 * a hundred megabytes of raw samples it drops again immediately. Time maps onto bytes by
	 * proportion, which is exact for constant bitrate and close enough for the rest, so this
	 * plus the file's own length is the whole of what the budget needs.
	 */
	seconds: number;
}

/**
 * What a normalized recording is brought to. The set spans 29 dB as published, which no
 * single volume slider can reconcile: at one slider position the loudest is painful while
 * the quietest is inaudible. -28 LUFS is the set's own median, so normalizing moves the
 * fewest files the furthest.
 */
export const TARGET_LUFS = -28;

/** No file is raised past this true peak, so normalization can never make one clip. */
export const PEAK_CEILING_DB = -1;

/** Past this a boost is amplifying the recording's own noise floor, not the recording. */
const MAX_BOOST_DB = 12;

export const AMBIENT_SOUNDS: AmbientSoundDef[] = [
	{ id: 'campfire', label: 'Campfire', category: 'nature', lufs: -36.6, peak: 0.2, seconds: 125 },
	{ id: 'droplets', label: 'Droplets', category: 'nature', lufs: -34.8, peak: -14.8, seconds: 52 },
	{ id: 'howling-wind', label: 'Howling Wind', category: 'nature', lufs: -23.6, peak: -1.7, seconds: 56 },
	{ id: 'jungle', label: 'Jungle', category: 'nature', lufs: -20.2, peak: -8.2, seconds: 267 },
	{ id: 'river', label: 'River', category: 'nature', lufs: -28.0, peak: -8.2, seconds: 113 },
	{ id: 'waterfall', label: 'Waterfall', category: 'nature', lufs: -21.9, peak: -11.8, seconds: 23 },
	{ id: 'waves', label: 'Waves', category: 'nature', lufs: -31.9, peak: -9.1, seconds: 99 },
	{ id: 'wind-in-trees', label: 'Wind in Trees', category: 'nature', lufs: -23.9, peak: -3.7, seconds: 58 },
	{ id: 'wind', label: 'Wind', category: 'nature', lufs: -27.3, peak: -7.6, seconds: 73 },

	{ id: 'heavy-rain', label: 'Heavy Rain', category: 'rain', lufs: -19.5, peak: -1.0, seconds: 22 },
	{ id: 'light-rain', label: 'Light Rain', category: 'rain', lufs: -30.3, peak: -0.3, seconds: 150 },
	{ id: 'rain-on-car-roof', label: 'Rain on a Car Roof', category: 'rain', lufs: -25.3, peak: -7.3, seconds: 10 },
	{ id: 'rain-on-leaves', label: 'Rain on Leaves', category: 'rain', lufs: -42.5, peak: -7.7, seconds: 42 },
	{ id: 'rain-on-tent', label: 'Rain on a Tent', category: 'rain', lufs: -31.2, peak: -1.1, seconds: 83 },
	{ id: 'rain-on-umbrella', label: 'Rain on an Umbrella', category: 'rain', lufs: -34.4, peak: -3.6, seconds: 27 },
	{ id: 'rain-on-window', label: 'Rain on a Window', category: 'rain', lufs: -16.5, peak: -1.5, seconds: 33 },
	{ id: 'thunder', label: 'Thunder', category: 'rain', lufs: -21.3, peak: -0.2, seconds: 69 },

	{ id: 'airport', label: 'Airport', category: 'places', lufs: -29.0, peak: 0, seconds: 312 },
	{ id: 'church', label: 'Church', category: 'places', lufs: -34.2, peak: -13.9, seconds: 70 },
	{ id: 'construction-site', label: 'Construction Site', category: 'places', lufs: -23.0, peak: -3.8, seconds: 125 },
	{ id: 'crowded-bar', label: 'Crowded Bar', category: 'places', lufs: -30.1, peak: -14.9, seconds: 59 },
	{ id: 'laboratory', label: 'Laboratory', category: 'places', lufs: -21.8, peak: -3.2, seconds: 21 },
	{ id: 'laundry-room', label: 'Laundry Room', category: 'places', lufs: -25.1, peak: -3.9, seconds: 32 },
	{ id: 'library', label: 'Library', category: 'places', lufs: -43.4, peak: -17.4, seconds: 177 },
	{ id: 'night-village', label: 'Night Village', category: 'places', lufs: -32.0, peak: -11.5, seconds: 106 },
	{ id: 'office', label: 'Office', category: 'places', lufs: -40.6, peak: -4.4, seconds: 140 },
	{ id: 'restaurant', label: 'Restaurant', category: 'places', lufs: -31.3, peak: -10.2, seconds: 171 },
	{ id: 'subway-station', label: 'Subway Station', category: 'places', lufs: -29.8, peak: -7.3, seconds: 171 },
	{ id: 'supermarket', label: 'Supermarket', category: 'places', lufs: -22.6, peak: -0.1, seconds: 175 },
	{ id: 'temple', label: 'Temple', category: 'places', lufs: -14.1, peak: -1.6, seconds: 92 },
	{ id: 'underwater', label: 'Underwater', category: 'places', lufs: -29.7, peak: -11.0, seconds: 43 },

	{ id: 'airplane', label: 'Airplane', category: 'transport', lufs: -30.4, peak: -19.2, seconds: 60 },
	{ id: 'inside-a-train', label: 'Inside a Train', category: 'transport', lufs: -27.9, peak: -6.3, seconds: 67 },
	{ id: 'rowing-boat', label: 'Rowing Boat', category: 'transport', lufs: -22.1, peak: 0, seconds: 26 },
	{ id: 'sailboat', label: 'Sailboat', category: 'transport', lufs: -38.2, peak: -1.2, seconds: 161 },
	{ id: 'submarine', label: 'Submarine', category: 'transport', lufs: -20.3, peak: -3.5, seconds: 46 },
	{ id: 'train', label: 'Train', category: 'transport', lufs: -14.7, peak: -0.1, seconds: 61 },

	{ id: 'busy-street', label: 'Busy Street', category: 'urban', lufs: -27.1, peak: -10.6, seconds: 175 },
	{ id: 'crowd', label: 'Crowd', category: 'urban', lufs: -34.2, peak: -19.5, seconds: 73 },
	{ id: 'highway', label: 'Highway', category: 'urban', lufs: -23.0, peak: -2.3, seconds: 133 },
	{ id: 'road', label: 'Road', category: 'urban', lufs: -19.2, peak: -0.1, seconds: 102 },
	{ id: 'traffic', label: 'Traffic', category: 'urban', lufs: -32.8, peak: -12.0, seconds: 40 }
];

const BY_ID = new Map(AMBIENT_SOUNDS.map((sound) => [sound.id, sound]));

export function soundById(id: string): AmbientSoundDef | null {
	return BY_ID.get(id) ?? null;
}

export function soundsIn(category: SoundCategory): AmbientSoundDef[] {
	return AMBIENT_SOUNDS.filter((sound) => sound.category === category);
}

export function soundUrl(sound: AmbientSoundDef): string {
	return `/files/sounds/${sound.category}/${sound.id}.mp3`;
}

/**
 * The multiplier that brings one recording to `TARGET_LUFS`, bounded so it can neither clip
 * nor amplify hiss. Pulling a loud file down always lands on the target exactly; raising a
 * quiet one stops where its own peak runs out of headroom, which is why the nine most
 * dynamic recordings stay below the target however far the boost is allowed to go. Squashing
 * them into line would need a compressor, and a compressor is audible on an ambient bed.
 */
export function normalizeGain(sound: AmbientSoundDef): number {
	const wanted = TARGET_LUFS - sound.lufs;
	const headroom = PEAK_CEILING_DB - sound.peak;
	const allowed = Math.min(MAX_BOOST_DB, headroom);
	return 10 ** (Math.min(wanted, allowed) / 20);
}
