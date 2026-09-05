/**
 * Engines are the app's built-in AI machinery: Chat Memory, Opening Scene,
 * Steering, Spellcheck, Impersonate, Corrections, Sprites. Each engine is its own deep
 * system; this registry is their shared identity for the Engines settings
 * page: what the engine does, whether it makes model calls (every
 * calling engine is a routing point with its own concrete connection on the
 * Connections page, with no roles and no defaults-following), which editable
 * templates drive it, and its app-wide on/off switch.
 *
 * Pure data plus tiny accessors: no engine logic lives here. An engine's id
 * doubles as its debug-panel source label (`sourceColor` in debug/format.ts).
 * The prompt field descriptors are the single source for the inline prompt
 * editor in the Engines settings page.
 *
 * There is no fixed-sampling table here: an engine runs on its connection's own
 * generation settings, because overriding the settings of a connection you
 * deliberately assigned makes assigning it pointless.
 *
 * A feature that needs bespoke UI or a bespoke pipeline is an engine. See
 * architecture/engines.md.
 */
import { featurePromptsStore, type FeaturePromptKey } from '$lib/stores/featurePrompts.svelte';

export type EngineId =
	| 'memory'
	| 'opening-scene'
	| 'steering'
	| 'spellcheck'
	| 'corrections'
	| 'impersonate'
	| 'sprites';

export interface EnginePromptField {
	key: FeaturePromptKey;
	label: string;
	hint: string;
	/**
	 * Macros the template is useless without: the editor warns when an edit drops one.
	 *
	 * Not every missing macro matters (a template that stops mentioning {{char}} is a style
	 * choice), so this lists only the ones whose absence makes the call meaningless while
	 * still returning something plausible. The engine that owns the template throws on the
	 * same condition; this is the earlier, gentler half of the same rule.
	 */
	requires?: string[];
}

export interface EngineDef {
	/** Also the engine's `source` label on LLM calls in the prompt debug panel. */
	id: EngineId;
	name: string;
	icon: 'brain' | 'sparkles' | 'compass' | 'checkCircle' | 'mask' | 'image' | 'pencil';
	/** One line for the engine's row: what it does, nothing about cost or trigger. */
	summary: string;
	/** The tooltip beside the engine's name in the detail view: what it does and when it fires. */
	description: string;
	/**
	 * Whether this engine makes model calls of its own. Every calling engine is a
	 * routing point: its connection is assigned directly and visibly on the
	 * Connections page (`connectionStore.assignments`), with no role or default
	 * behind it. `false` only for Steering, whose text rides the story generation
	 * without a call of its own: it has nothing to assign.
	 */
	makesCalls: boolean;
	/** Editable templates, in the inline prompt-editor field format. */
	prompts: EnginePromptField[];
	/** The engine's app-wide on/off switch. Off leaves stored data intact and only makes
	 *  the runtime inert (no recall/extraction, no on-demand run, no per-turn sidecar). */
	enabled: { get(): boolean; set(value: boolean): void };
}

export const ENGINES: EngineDef[] = [
	{
		id: 'memory',
		name: 'Chat Memory',
		icon: 'brain',
		summary: 'Summarizes old scenes and recalls them later',
		description:
			'Summarizes scenes once they fall out of the context window and recalls them into later prompts, so a long chat keeps its thread at a flat cost. It runs on its own as the story grows.',
		makesCalls: true,
		prompts: [
			{
				key: 'memoryExtract',
				label: 'Summarizing',
				hint: 'Turns a batch of old turns into one scene summary.',
				requires: ['{{batch}}']
			},
			{
				key: 'memoryPromote',
				label: 'Compaction',
				hint: 'Merges older scene summaries into tighter ones.',
				requires: ['{{episodes}}']
			}
		],
		enabled: {
			get: () => featurePromptsStore.memoryEnabled,
			set: (value) => featurePromptsStore.setMemoryEnabled(value)
		}
	},
	{
		id: 'opening-scene',
		name: 'Opening Scene',
		icon: 'sparkles',
		summary: 'Writes another way for a story to open',
		description:
			'Writes an opening scene through the full story pipeline, with preset, character, persona, lorebooks and memory all in place. It lands beside the card’s own greetings as one more beginning to swipe between, and fires only when you ask for it.',
		makesCalls: true,
		prompts: [
			{
				key: 'openingScene',
				label: 'Opening scene direction',
				hint: "Directs the opening scene. {{idea}} is the direction you typed, or a request to surprise you when you left it empty; {{scenario}} stays the character card's own field."
			}
		],
		enabled: {
			get: () => featurePromptsStore.openingSceneEnabled,
			set: (value) => featurePromptsStore.setOpeningSceneEnabled(value)
		}
	},
	{
		id: 'steering',
		name: 'Steering',
		icon: 'compass',
		summary: 'Injects your composer guidance into the story prompt',
		description:
			'Injects the guidance you type in the composer straight into the story prompt. It makes no call of its own, the text rides the generation you were already sending.',
		makesCalls: false,
		prompts: [
			{
				key: 'steeringWrapper',
				label: 'Guidance wrapper',
				hint: 'Wraps your composer guidance before it goes into the story prompt. {{steering}} is the text you typed.'
			}
		],
		enabled: {
			get: () => featurePromptsStore.steeringEnabled,
			set: (value) => featurePromptsStore.setSteeringEnabled(value)
		}
	},
	{
		id: 'spellcheck',
		name: 'Spellcheck',
		icon: 'checkCircle',
		summary: 'Fixes your composer draft, keeping its voice',
		description:
			'Fixes spelling, grammar and awkward phrasing in your composer draft, keeping its meaning and voice. Runs only when you trigger it.',
		makesCalls: true,
		prompts: [
			{
				key: 'spellcheck',
				label: 'Correction prompt',
				hint: 'Sent to fix your draft. {{draft}} is the composer text being corrected.'
			}
		],
		enabled: {
			get: () => featurePromptsStore.spellcheckEnabled,
			set: (value) => featurePromptsStore.setSpellcheckEnabled(value)
		}
	},
	{
		id: 'impersonate',
		name: 'Impersonate',
		icon: 'mask',
		summary: 'Expands a short draft into a full message',
		description:
			'Expands a short composer draft into a full in-character message written from your perspective. Runs only when you trigger it.',
		makesCalls: true,
		prompts: [
			{
				key: 'impersonate',
				label: 'Expansion prompt',
				hint: 'Sent as the final user turn after the chat history, which arrives with its roles swapped so the model already sits in your seat. {{draft}} is the composer text, {{perspective}} is first, second or third person.'
			}
		],
		enabled: {
			get: () => featurePromptsStore.impersonateEnabled,
			set: (value) => featurePromptsStore.setImpersonateEnabled(value)
		}
	},
	{
		id: 'corrections',
		name: 'Corrections',
		icon: 'pencil',
		summary: 'Rewrites a reply you have read, to your direction',
		description:
			"Rewrites a reply you have already read, following a direction you type: fix a detail it got wrong, change the tone, cut a line that did not land. It runs from that reply's own Retry menu, and builds the very prompt the reply was written from, so the rewrite keeps the same history, lorebooks and memory the original had. Runs only when you trigger it.",
		makesCalls: true,
		prompts: [
			{
				key: 'corrections',
				label: 'Correction prompt',
				hint: 'Sent as the final user turn, after the reply being rewritten -- which rides ahead of it verbatim, so this template does not need to repeat it. {{instruction}} is the direction you typed.',
				requires: ['{{instruction}}']
			}
		],
		enabled: {
			get: () => featurePromptsStore.correctionsEnabled,
			set: (value) => featurePromptsStore.setCorrectionsEnabled(value)
		}
	},
	{
		id: 'sprites',
		name: 'Sprites',
		icon: 'image',
		summary: "Shows one of the character's sprites for the newest reply",
		description:
			"Reads the newest reply and picks one of the character's sprites for it, which is the picture shown beside the story. It spends a call on every reply, so it is off until you switch it on, and it stays idle for characters with no sprites.",
		makesCalls: true,
		prompts: [
			{
				key: 'sprites',
				label: 'Sprite prompt',
				hint: "Sent to read the newest reply. {{labels}} is this character's own sprite labels. How much story goes with it is yours: {{chatHistoryLast3}} for three turns, {{lastMessage}} for the reply alone.",
				requires: ['{{labels}}']
			}
		],
		enabled: {
			get: () => featurePromptsStore.spritesEnabled,
			set: (value) => featurePromptsStore.setSpritesEnabled(value)
		}
	}
];

export function engineById(id: EngineId): EngineDef {
	const def = ENGINES.find((e) => e.id === id);
	if (!def) throw new Error(`Unknown engine: ${id}`);
	return def;
}

