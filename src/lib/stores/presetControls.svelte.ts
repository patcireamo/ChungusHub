/**
 * Each preset's control values, plus each preset's adopted setup.
 *
 * Preset authors expose friendly widgets (toggles, sliders, selects, …) bound to macros;
 * these are the reader's chosen values for them, and they belong to the PRESET. Every chat
 * running a preset shares them, which is right: they are the reader's settings for that
 * document. What they no longer cross is the gap between two presets. Values keyed by macro
 * name alone meant two presets declaring the same name (the normal case the moment one is
 * duplicated) shared one value, so tuning a knob for the chat on preset A silently rewrote
 * the prompt of the chat on preset B, with nothing on either screen saying so.
 *
 * `appliedSetups` is the reader's other piece of state: which of a preset's setting
 * kits they adopted as their baseline, by preset id. It is stored rather than derived
 * from value-matching, because a matched-derived selection collapses the moment one
 * knob moves and leaves "reset" pointing at two different configurations at once.
 */
import { db } from '$lib/services/database';
import { presetService } from '$lib/services/presets.svelte';

/** The flat app-wide map this install carried while values were global. Read once, by the
 *  carry-over below, and never written again. */
const GLOBAL_VALUES_KEY = 'presetControlValues';
const VALUES_BY_PRESET_KEY = 'presetControlValuesByPreset';
const APPLIED_SETUPS_KEY = 'presetAppliedSetups';

/** One shared object for "this preset has no values yet", so a read never allocates. */
const NO_VALUES: Record<string, unknown> = Object.freeze({});

type ValuesByPreset = Record<string, Record<string, unknown>>;

class PresetControlsStore {
	/** Preset id → that preset's values, keyed by the control's macro name. A preset with no
	 *  bucket has never been tuned and reads as every control on its author's default. */
	valuesByPreset = $state<ValuesByPreset>({});

	/** Preset id → the kit id whose configuration the reader adopted as their baseline.
	 *  Absent means the per-control defaults are the baseline. An id naming no existing
	 *  kit is kept, not pruned: the page derives it to the defaults baseline, and pruning
	 *  would turn an author's unsaved kit delete into permanent loss of the selection. */
	appliedSetups = $state<Record<string, string>>({});

	async initialize(): Promise<void> {
		await this.load();
	}

	async syncReload(): Promise<void> {
		await this.load();
	}

	/** One preset's values. A deleted preset's bucket is deliberately never swept, the same
	 *  rule `appliedSetups` follows: restoring the preset restores its tuning. */
	valuesFor(presetId: string | null): Record<string, unknown> {
		return (presetId ? this.valuesByPreset[presetId] : null) ?? NO_VALUES;
	}

	private async load(): Promise<void> {
		const raw = await db.getSetting(VALUES_BY_PRESET_KEY);
		this.valuesByPreset = raw ? parseValuesByPreset(raw) : await this.carryGlobalValuesOver();
		this.appliedSetups = await readAppliedSetups();
	}

	/**
	 * One-shot: hand every preset that exists its own copy of the values this install held
	 * while they were one app-wide set, so nothing anyone tuned is lost on any preset and
	 * the presets diverge only from here. Copying the whole map rather than each preset's
	 * own macros is what makes that exact: a macro no control owns was already inert, and a
	 * control added later picks the value up exactly as it did before.
	 *
	 * **Writing the row IS the marker, so this cannot re-fire.** It runs only where there is
	 * no row at all, which means it can never overwrite a bucket: there are none to
	 * overwrite. A preset made or imported afterwards therefore starts on its author's
	 * defaults instead of inheriting a stranger's tuning. The old flat row is left exactly
	 * where it is, because it is the reader's data and an older build still reads it.
	 */
	private async carryGlobalValuesOver(): Promise<ValuesByPreset> {
		const global = await readGlobalValues();
		const seeded: ValuesByPreset = {};
		if (Object.keys(global).length > 0) {
			for (const preset of presetService.getAllPresets()) seeded[preset.id] = { ...global };
		}
		await db.setSetting(VALUES_BY_PRESET_KEY, JSON.stringify(seeded));
		return seeded;
	}

	/** Set one control's value on one preset, keyed by the control's macro name, and persist. */
	setValue(presetId: string, macro: string, value: unknown): void {
		this.write(presetId, { ...this.valuesFor(presetId), [macro]: value });
	}

	/** Forget a control's value so it falls back to the author's default. Deleting the key
	 *  rather than writing the default in is what keeps "back to the author's" meaningful:
	 *  a stored copy would freeze today's default and stop tracking a preset update. */
	clearValue(presetId: string, macro: string): void {
		const { [macro]: _dropped, ...rest } = this.valuesFor(presetId);
		this.write(presetId, rest);
	}

	/** Adopt a configuration in one write and one settings broadcast: write the values a
	 *  kit names and clear every other macro the preset owns, so the result is exactly the
	 *  configuration being adopted rather than it layered over the reader's leftovers. */
	applyValues(presetId: string, values: Record<string, unknown>, clearMacros: string[] = []): void {
		const next = { ...this.valuesFor(presetId), ...values };
		for (const macro of clearMacros) delete next[macro];
		this.write(presetId, next);
	}

	/** Remember which setup a preset's reader adopted as their baseline; null means the
	 *  per-control defaults are. */
	setAppliedSetup(presetId: string, bundleId: string | null): void {
		const next = { ...this.appliedSetups };
		if (bundleId === null) delete next[presetId];
		else next[presetId] = bundleId;
		this.appliedSetups = next;
		void db.setSetting(APPLIED_SETUPS_KEY, JSON.stringify(next));
	}

	private write(presetId: string, values: Record<string, unknown>): void {
		this.valuesByPreset = { ...this.valuesByPreset, [presetId]: values };
		void db.setSetting(VALUES_BY_PRESET_KEY, JSON.stringify(this.valuesByPreset));
	}
}

export const presetControlsStore = new PresetControlsStore();

/**
 * One preset's control values straight from settings. The one reader of the row: the
 * generation path calls it directly (fresh), the store calls it to fill its cache.
 * A corrupt row throws rather than resolving to an empty set, which would send every control
 * at its author default and read as the preset being wrong.
 */
export async function readPresetControlValues(presetId: string | null): Promise<Record<string, unknown>> {
	const raw = await db.getSetting(VALUES_BY_PRESET_KEY);
	if (!raw || !presetId) return {};
	return parseValuesByPreset(raw)[presetId] ?? {};
}

function parseValuesByPreset(raw: string): ValuesByPreset {
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== 'object') {
		throw new Error(`${VALUES_BY_PRESET_KEY} is not an object`);
	}
	return parsed as ValuesByPreset;
}

/** The pre-split flat map, read only by the carry-over above. Same fail-loud contract: a
 *  corrupt row throws rather than quietly carrying nothing across. */
async function readGlobalValues(): Promise<Record<string, unknown>> {
	const raw = await db.getSetting(GLOBAL_VALUES_KEY);
	if (!raw) return {};
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== 'object') {
		throw new Error(`${GLOBAL_VALUES_KEY} is not an object`);
	}
	return parsed;
}

/** Same contract as the values row: a corrupt row throws rather than quietly resetting
 *  every preset's baseline to the defaults. Generation never reads this: the adopted
 *  setup shapes only what "reset" and "modified" mean on the reader's page. */
async function readAppliedSetups(): Promise<Record<string, string>> {
	const raw = await db.getSetting(APPLIED_SETUPS_KEY);
	if (!raw) return {};
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== 'object') {
		throw new Error(`${APPLIED_SETUPS_KEY} is not an object`);
	}
	return parsed;
}
