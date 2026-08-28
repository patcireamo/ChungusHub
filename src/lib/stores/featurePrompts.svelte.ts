/**
 * Feature prompts, the editable prompt templates for the app's built-in AI
 * features: the opening-scene generator, Steering, Spellcheck, Impersonate,
 * and the memory extract/promote pipeline, plus each engine's app-wide on/off
 * switch.
 *
 * Each feature is a prompt holder bolted onto bespoke UI (the memory panel, the
 * opening-scene popover, the composer menu) and surfaces its own settings button
 * on its own surface. Synced across devices via the shared `settings` spine.
 */
import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';
import { DEFAULT_EXTRACT_TEMPLATE, DEFAULT_PROMOTE_TEMPLATE } from '$lib/memory/prompts';
import { sanitizeMemoryDefaults } from '$lib/memory/config';
import type { MemoryConfig } from '$lib/memory/types';
import { clampSteeringDepth, STEERING_ROLES, type SteeringDefaults, type SteeringRole } from '$lib/types/steering';

const SETTINGS_KEY = 'featurePrompts';

export type FeaturePromptKey =
	| 'openingScene'
	| 'memoryExtract'
	| 'memoryPromote'
	| 'steeringWrapper'
	| 'spellcheck'
	| 'impersonate'
	| 'sprites';

const DEFAULT_OPENING_SCENE_PROMPT = `((OOC: Generate the opening scene. {{idea}}

Set the stage by describing the environment, atmosphere, and any NPCs present. Give NPCs dialogue to bring the scene to life. You may establish the protagonist's presence and situation from an external perspective (where they are, what they've walked into, how others perceive them), but do NOT write their explicit actions, dialogue, or internal thoughts. End at a moment where they can naturally step in.

Begin directly with narrative. No meta-commentary, no markdown formatting, no titles.))`;

const DEFAULT_STEERING_WRAPPER_PROMPT = `[Guidance: {{steering}}]`;

const DEFAULT_SPELLCHECK_PROMPT = `Correct the spelling, grammar, punctuation, and awkward phrasing in the draft below. Preserve its meaning, tone, voice, formatting, and markdown exactly. Do not add, remove, or rewrite content beyond what correctness requires. Reply with only the corrected text.

{{draft}}`;

// Sent as the FINAL user turn, after the chat history with its roles swapped (the service
// seats the model on the user's side structurally; see composerTransformService). Task and
// draft close the prompt so neither decays with chat length.
const DEFAULT_IMPERSONATE_PROMPT = `((OOC: You are playing {{user}} in this roleplay, and it is {{user}}'s turn. Expand the draft below into {{user}}'s next message, in {{perspective}} person: keep the draft's intent, match the voice of {{user}}'s earlier messages, and never write {{char}}'s dialogue, actions, or thoughts. Reply with only the message text.

Draft: {{draft}}))`;

// {{chatHistoryLast3}} rather than a hand-rolled excerpt: how much story the model reads is
// the author's call, and turning three into one is how this engine gets cheap.
const DEFAULT_SPRITES_PROMPT = `Read the roleplay excerpt below and decide which of {{char}}'s sprites fits the END of the last message. Judge {{char}}'s own state, not {{user}}'s and not the mood of the scene, and weigh how the last message finishes over how it began.

Choose exactly one label from this list, copied verbatim:
{{labels}}

Reply with only this JSON and nothing else: {"sprite": "<label>"}

{{chatHistoryLast3}}`;

/** Shipped default template per feature: the fallback when the user hasn't overridden it. */
export const FEATURE_PROMPT_DEFAULTS: Record<FeaturePromptKey, string> = {
	openingScene: DEFAULT_OPENING_SCENE_PROMPT,
	memoryExtract: DEFAULT_EXTRACT_TEMPLATE,
	memoryPromote: DEFAULT_PROMOTE_TEMPLATE,
	steeringWrapper: DEFAULT_STEERING_WRAPPER_PROMPT,
	spellcheck: DEFAULT_SPELLCHECK_PROMPT,
	impersonate: DEFAULT_IMPERSONATE_PROMPT,
	sprites: DEFAULT_SPRITES_PROMPT
};

interface FeaturePromptsState {
	/** Only true deviations from the shipped defaults. */
	overrides: Partial<Record<FeaturePromptKey, string>>;
	/** Per-engine app-wide on/off switches (Settings → Engines). All default on except
	 *  Sprites, since disabling an engine is the new capability, not the normal state:
	 *  Memory is the only other one with a standing per-turn cost, and the rest are on-demand
	 *  (steering rides the primary generation for free, the others only run when triggered).
	 *  Turning any off leaves that engine's stored data intact; only its runtime goes
	 *  inert. */
	memoryEnabled: boolean;
	openingSceneEnabled: boolean;
	steeringEnabled: boolean;
	spellcheckEnabled: boolean;
	impersonateEnabled: boolean;
	/** The one engine that ships OFF. It spends a call on every reply for as long as it is on,
	 *  and unlike Memory that call buys presentation rather than the story's own continuity,
	 *  so it is a cost the reader opts into, not one they discover. The Sprites section in the
	 *  character editor says so where the sprites are, which is where someone who uploaded
	 *  pictures and saw nothing happen is actually standing. */
	spritesEnabled: boolean;
	/**
	 * When a turn that has already been read should be read AGAIN, because its text changed
	 * under the reading. Both default **off**: a re-read is a second call on a turn the user
	 * already paid for, and only they know whether their edit moved the mood or fixed a comma.
	 * Off leaves the face exactly where it was, which is also what happens to a MINOR save
	 * either way: that one is the user asserting the turn still says what it said.
	 */
	spritesRereadOnEdit: boolean;
	spritesRereadOnContinue: boolean;
	/** The placement every steering note inherits until it overrides one (a note's own
	 *  `depth`/`role` are tri-state, `null` = inherit; see types/steering.ts). */
	steeringDefaultDepth: number;
	steeringDefaultRole: SteeringRole;
	/**
	 * The memory tunables a chat is given when memory is first switched on for it, holding
	 * only the fields moved off the shipped default (the `overrides` idiom above).
	 *
	 * Copied into the chat at that moment and never read again, so this is a starting point
	 * and not a live layer: a chat already running keeps the numbers it was enabled under,
	 * whatever happens here afterwards. That is the whole reason it is copied rather than
	 * resolved through: the layer caps are load-bearing for stored summaries, and lowering
	 * one here would otherwise silently owe merges on every chat that never touched it.
	 */
	memoryDefaults: Partial<MemoryConfig>;
}

function normalize(raw: Partial<FeaturePromptsState> | null): FeaturePromptsState {
	return {
		overrides: raw?.overrides ?? {},
		memoryEnabled: raw?.memoryEnabled ?? true,
		openingSceneEnabled: raw?.openingSceneEnabled ?? true,
		steeringEnabled: raw?.steeringEnabled ?? true,
		spellcheckEnabled: raw?.spellcheckEnabled ?? true,
		impersonateEnabled: raw?.impersonateEnabled ?? true,
		spritesEnabled: raw?.spritesEnabled ?? false,
		spritesRereadOnEdit: raw?.spritesRereadOnEdit ?? false,
		spritesRereadOnContinue: raw?.spritesRereadOnContinue ?? false,
		steeringDefaultDepth: clampSteeringDepth(raw?.steeringDefaultDepth ?? 0),
		steeringDefaultRole: STEERING_ROLES.includes(raw?.steeringDefaultRole as SteeringRole)
			? (raw?.steeringDefaultRole as SteeringRole)
			: 'system',
		memoryDefaults: sanitizeMemoryDefaults(raw?.memoryDefaults)
	};
}

class FeaturePromptsStore {
	state = $state<FeaturePromptsState>({
		overrides: {},
		memoryEnabled: true,
		openingSceneEnabled: true,
		steeringEnabled: true,
		spellcheckEnabled: true,
		impersonateEnabled: true,
		spritesEnabled: false,
		spritesRereadOnEdit: false,
		spritesRereadOnContinue: false,
		steeringDefaultDepth: 0,
		steeringDefaultRole: 'system',
		memoryDefaults: {}
	});
	loaded = $state(false);

	async initialize(): Promise<void> {
		this.state = normalize(await readSetting<Partial<FeaturePromptsState> | null>(SETTINGS_KEY, null));
		this.loaded = true;
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		this.state = normalize(await readSetting<Partial<FeaturePromptsState> | null>(SETTINGS_KEY, null));
	}

	private persist(): void {
		writeSetting(SETTINGS_KEY, this.state);
	}

	get memoryEnabled(): boolean {
		return this.state.memoryEnabled;
	}

	get openingSceneEnabled(): boolean {
		return this.state.openingSceneEnabled;
	}

	/** The tunables the next chat to switch memory on is given. Only the fields moved off the
	 *  shipped default are present; `resolveConfig` fills the rest. */
	get memoryDefaults(): Partial<MemoryConfig> {
		return this.state.memoryDefaults;
	}

	get steeringEnabled(): boolean {
		return this.state.steeringEnabled;
	}

	/** The placement a steering note inherits. One object so every resolver takes the
	 *  pair together and can't read a stale half. */
	get steeringDefaults(): SteeringDefaults {
		return { depth: this.state.steeringDefaultDepth, role: this.state.steeringDefaultRole };
	}

	get spellcheckEnabled(): boolean {
		return this.state.spellcheckEnabled;
	}

	get impersonateEnabled(): boolean {
		return this.state.impersonateEnabled;
	}

	get spritesEnabled(): boolean {
		return this.state.spritesEnabled;
	}

	get spritesRereadOnEdit(): boolean {
		return this.state.spritesRereadOnEdit;
	}

	get spritesRereadOnContinue(): boolean {
		return this.state.spritesRereadOnContinue;
	}

	/** The effective template for a feature: the user's override or the shipped default. */
	promptFor(key: FeaturePromptKey): string {
		return this.state.overrides[key] ?? FEATURE_PROMPT_DEFAULTS[key];
	}

	/** Whether the user has edited this feature's template away from its shipped default. */
	isCustomized(key: FeaturePromptKey): boolean {
		const ov = this.state.overrides[key];
		return ov !== undefined && ov !== FEATURE_PROMPT_DEFAULTS[key];
	}

	/** Save an edited template, or drop the override when it matches the default again. */
	setPrompt(key: FeaturePromptKey, value: string): void {
		const overrides = { ...this.state.overrides };
		if (value === FEATURE_PROMPT_DEFAULTS[key]) delete overrides[key];
		else overrides[key] = value;
		this.state = { ...this.state, overrides };
		this.persist();
	}

	resetPrompt(key: FeaturePromptKey): void {
		const overrides = { ...this.state.overrides };
		delete overrides[key];
		this.state = { ...this.state, overrides };
		this.persist();
	}

	setMemoryEnabled(value: boolean): void {
		this.state = { ...this.state, memoryEnabled: value };
		this.persist();
	}

	/** Move one memory default, or drop it when it lands back on the shipped number, which
	 *  is what the double-click reset on its slider does and what keeps an untouched set
	 *  stored as `{}`. */
	setMemoryDefault(key: keyof MemoryConfig, value: number): void {
		const memoryDefaults = sanitizeMemoryDefaults({ ...this.state.memoryDefaults, [key]: value });
		this.state = { ...this.state, memoryDefaults };
		this.persist();
	}

	setOpeningSceneEnabled(value: boolean): void {
		this.state = { ...this.state, openingSceneEnabled: value };
		this.persist();
	}

	setSteeringEnabled(value: boolean): void {
		this.state = { ...this.state, steeringEnabled: value };
		this.persist();
	}

	setSteeringDefaultDepth(value: number): void {
		this.state = { ...this.state, steeringDefaultDepth: clampSteeringDepth(value) };
		this.persist();
	}

	setSteeringDefaultRole(value: SteeringRole): void {
		this.state = { ...this.state, steeringDefaultRole: value };
		this.persist();
	}

	setSpellcheckEnabled(value: boolean): void {
		this.state = { ...this.state, spellcheckEnabled: value };
		this.persist();
	}

	setImpersonateEnabled(value: boolean): void {
		this.state = { ...this.state, impersonateEnabled: value };
		this.persist();
	}

	setSpritesEnabled(value: boolean): void {
		this.state = { ...this.state, spritesEnabled: value };
		this.persist();
	}

	setSpritesRereadOnEdit(value: boolean): void {
		this.state = { ...this.state, spritesRereadOnEdit: value };
		this.persist();
	}

	setSpritesRereadOnContinue(value: boolean): void {
		this.state = { ...this.state, spritesRereadOnContinue: value };
		this.persist();
	}
}

export const featurePromptsStore = new FeaturePromptsStore();
