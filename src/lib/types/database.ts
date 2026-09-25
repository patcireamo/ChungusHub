/** Database schema types - direct mapping to SQLite tables */

// Type-only: a preset carries its own find & replace rules, and they are the same rules
// the Regex settings page edits. No runtime import, so the layering stays one-way.
import type { RegexRule } from '$lib/utils/regex-rules';

export interface DbChat {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
	root_message_id: string | null;
	active_leaf_id: string | null;
	settings_json: string | null;
}

export interface DbMessage {
	id: string;
	chat_id: string;
	parent_id: string | null;
	role: 'user' | 'assistant' | 'system';
	content: string;
	persona_id: string | null;
	thinking: string | null;
	created_at: number;
	edited_at: number | null;
	model: string | null;
	provider: string | null;
	tokens_prompt: number | null;
	tokens_completion: number | null;
	finish_reason: string | null;
	generation_ms: number | null;
	sibling_index: number;
}

export interface DbSetting {
	key: string;
	value: string;
}

export interface DbProviderCredential {
	provider: string;
	api_key_encrypted: string;
	base_url: string | null;
	updated_at: number;
}

export interface DbCharacterLibrary {
	id: string;
	type: string;
	data_json: string;
	is_favorite: number;
	created_at: number;
	updated_at: number;
}

export interface DbCharacterLibraryDraft {
	entry_id: string;
	data_json: string;
	updated_at: number;
}

// Prompt preset types (stored as JSON files)
export type PromptRole = 'system' | 'user' | 'assistant';

export interface PromptItem {
	id: string;
	name: string;
	role: PromptRole;
	content: string;
	enabled: boolean;
	/** The author's own annotation about this item. Lives in the Prompt Builder and NOWHERE
	 *  else: assembly never reads it, so it is the one place an author can write "only touch
	 *  this if you know what it does" without the model reading the warning too. */
	note?: string;
}

/**
 * Custom controls let a preset author expose friendly widgets in the Preset Controls
 * panel (toggles, sliders, selects, …) that bind to a macro. Non-power users fill in the
 * widgets; the preset's prompt items reference the bound macro to inject their value.
 */
export type PromptControlType =
	| 'text'
	| 'textarea'
	| 'toggle'
	| 'slider'
	| 'range'
	| 'select'
	| 'radio'
	| 'tags';

/** The author's standing counsel on a control, shown as a badge beside its label. */
export type PromptControlAdvice = 'recommended' | 'optional' | 'advanced' | 'troubleshooting';

export interface PromptControlOption {
	id: string;
	label: string;
	/** Text injected into the prompt when this option is selected. */
	injectedText: string;
	/** Why a reader would pick this one over its siblings ("faster, but looser"). Shown
	 *  under the option in the reader's UI; never part of the prompt. */
	description?: string;
}

export interface PromptControl {
	id: string;
	/** Macro name this control binds to, referenced as {{macro}} in prompt items. */
	macro: string;
	label: string;
	/** Free prose explaining the control to the reader. Multi-line: line breaks survive to
	 *  the Preset Controls card, so a paragraph is as valid as a sentence. */
	help?: string;
	/** Where {@link help} is read. Absent/false hides it behind the info icon beside the
	 *  label, so a section of cards stays scannable however much the author wrote; true
	 *  prints it on the card, for the control whose prose a reader has to meet before
	 *  touching it. No help at all draws neither. */
	helpInline?: boolean;
	/** How strongly the author recommends touching this. Absent = no badge. */
	advice?: PromptControlAdvice;
	/** The id of the {@link PromptSection} this control belongs to. A value with no declared
	 *  section still groups under itself, so the string doubles as the heading, which is
	 *  what lets a preset that never declares sections keep working untouched. */
	group?: string;
	type: PromptControlType;
	// text / textarea
	defaultText?: string;
	placeholder?: string;
	/** Template with a {{value}} placeholder, applied only when the reader typed something;
	 *  empty text injects nothing (so a framing label can never dangle in the prompt).
	 *  Absent/empty template = inject the raw text. */
	textTemplate?: string;
	// toggle
	defaultOn?: boolean;
	onText?: string;
	offText?: string;
	// slider
	min?: number;
	max?: number;
	step?: number;
	defaultNumber?: number;
	/** Template with a {{value}} placeholder; if empty, the raw number is injected. */
	sliderTemplate?: string;
	// range: a span between two numbers ("400 to 600 words"). Shares the slider's
	// min/max/step as the track it moves along; only the value and template differ.
	/** The two ends the reader starts on, low first. Absent = the whole track. */
	defaultRange?: [number, number];
	/** Template with {{min}} and {{max}} placeholders; if empty, "min–max" is injected. */
	rangeTemplate?: string;
	// select / radio (single) / tags (multi)
	options?: PromptControlOption[];
	/** select / radio: default selected option id. */
	defaultOptionId?: string;
	/** tags: default selected option ids. */
	defaultOptionIds?: string[];
	/** tags: separator joining injected texts (default ", "). */
	tagSeparator?: string;
	/** tags: let the reader add entries the author never listed. Their text is injected
	 *  verbatim, so a suggested list and a personal list live in one control. */
	allowCustom?: boolean;
	/** tags: placeholder for the add-your-own field. */
	customPlaceholder?: string;
}

/**
 * A named division of the Preset Controls page. Sections are declared by the preset and
 * ordered by this array, so the author decides what a reader meets first, what it is for,
 * and what stays folded away until asked for.
 */
export interface PromptSection {
	/** Matches the `group` its controls declare. */
	id: string;
	title: string;
	/** A sentence under the heading, in the author's voice. */
	description?: string;
	/** Icon registry name shown beside the title. */
	icon?: string;
	/** Start folded, for the sections a reader only opens on purpose. */
	collapsed?: boolean;
}

/**
 * A named set of control values the author vouches for ("Slow burn romance"). One click
 * writes every value in it, which is what stops an author from shipping the same preset
 * five times over just to ship five configurations of it.
 */
export interface PromptPresetBundle {
	id: string;
	name: string;
	description?: string;
	/** Macro name → the raw stored value, exactly as `presetControlValues` holds it. */
	values: Record<string, unknown>;
}

/** Everything a preset says about itself: the byline a reader sees before any control. */
export interface PromptPresetMeta {
	author?: string;
	/** The author's own version string; free-form, never parsed. */
	version?: string;
	/** The paragraph that opens the Preset Controls page. */
	description?: string;
	/** Stored cover path (images/presets/…). Install-local, so it travels as the PNG
	 *  card's own art rather than inside the JSON. */
	cover?: string;
	/** One honest line about what the preset was tuned on ("Written against Claude Opus
	 *  at 1.0 temperature"), so a reader knows what they are deviating from. */
	writtenFor?: string;
}

export interface PromptPreset {
	id: string;
	name: string;
	items: PromptItem[];
	controls?: PromptControl[];
	/** Declared sections, in the order the reader meets them. Controls whose `group`
	 *  matches nothing here still render, under their own name, after the declared ones. */
	sections?: PromptSection[];
	/** One-click value sets the author vouches for. */
	bundles?: PromptPresetBundle[];
	/** The preset's byline. */
	meta?: PromptPresetMeta;
	/** Find & replace the preset carries itself, so the output looks the way the author
	 *  designed it the moment it is imported. They apply on top of the user's own rules
	 *  while this preset is active and withdraw with it; the user can mute one but never
	 *  edit it, because an edited copy would no longer be the preset's. */
	regexRules?: RegexRule[];
	/** Opt-in: prune tag blocks whose macros all resolve empty (see pruneEmptyTagBlocks in
	 *  $lib/macros). Per-preset because it changes what the authored template means.
	 *  Absent/false leaves imported and hand-rolled presets exactly as written. */
	pruneEmptyBlocks?: boolean;
	/** Separator that replaces <START> markers between example-dialogue blocks (SillyTavern-style). Empty = no header line. */
	exampleSeparator?: string;
	/** Instruction appended after the reply being extended by Continue (see
	 *  AssembleInput.continuation). Absent = the shipped DEFAULT_CONTINUE_PROMPT; an empty
	 *  string sends no instruction, leaving the reply as a native assistant prefill. */
	continuePrompt?: string;
	/** The instruction a rewrite sends after the reply it rewrites (see AssembleInput.rewrite).
	 *  Absent = the shipped DEFAULT_REWRITE_PROMPT. It must carry {{note}}: without it a rewrite
	 *  refuses to run rather than ignore the note. */
	rewritePrompt?: string;
}
