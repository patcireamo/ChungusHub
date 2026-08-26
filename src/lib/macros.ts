/**
 * The one macro module: registry and engine in a single file, so a macro is declared,
 * documented and substituted in exactly one place.
 *  - MACROS is the one list of what every macro means and where it resolves.
 *  - `substitute()` is the one string-substitution primitive every surface shares.
 *  - `expandMacros()` is the context-aware preset engine; it resolves its macro NAMES from
 *    MACROS too (see SYSTEM_MACROS) and defers the actual substitution to `substitute()`.
 *
 * Macros are GLOBAL: every macro-resolving surface (presets, the opening scene, the
 * composer transforms, memory templates) resolves the shared engine macros from the same
 * MacroContext, and each flow layers its own values on top (draft text, memory batches, …).
 * A macro whose data doesn't exist where it's used stays literal, visible in the prompt and
 * never silently gated. Flow values always win on a name collision.
 */

import type {
	CharacterTraits,
	PermanentTraitDef,
	TraitKey
} from '$lib/types/library';
import { PERMANENT_TRAITS } from '$lib/types/library';
import type { Message } from '$lib/types/chat';
import type { PromptControl } from '$lib/types/database';
import type { LorebookPlacedGroup, LorebookTrace } from '$lib/lorebook/types';
import { formatControlForPrompt } from '$lib/utils/prompt-controls';

// ============================================================================
// Registry: definitions + the shared substitution primitive
// ============================================================================

/** Display buckets for the macro reference, in the order the reference panel shows them. */
export type MacroGroup = 'names' | 'context' | 'time' | 'character-field' | 'memory';

/** Ordered group metadata for the macro reference UIs. */
export const MACRO_GROUPS: readonly { id: MacroGroup; label: string; hint: string }[] = [
	{ id: 'names', label: 'Names', hint: 'inline name references' },
	{ id: 'context', label: 'Story & context', hint: 'profiles, world info, history, memory' },
	{ id: 'time', label: 'Date & time', hint: "the reader's own clock, stamped once per prompt" },
	{ id: 'character-field', label: 'Character fields', hint: 'one card field at a time' },
	{ id: 'memory', label: 'Memory pipeline', hint: 'filled while the memory engine runs, literal anywhere else' }
];

export interface MacroDef {
	/** The macro name without braces, e.g. 'lastCharMessage'. */
	name: string;
	/** One-line description shown in the macro-reference UIs. */
	description: string;
	/**
	 * Structural macros inject native-role messages instead of inline text (the preset
	 * engine handles them specially). They can't be filled by a plain string substitution.
	 */
	structural?: boolean;
	/** Display bucket for the macro reference. */
	group: MacroGroup;
	/**
	 * Engine macros resolve from the shared MacroContext (story + chat state) on EVERY
	 * surface. The rest are flow macros: their value only exists while a specific flow
	 * runs (a memory pass) and is supplied by that flow.
	 */
	engine?: boolean;
	/**
	 * The registered name is a SHAPE, not a resolvable name: the author writes the numbered
	 * form ({{chatHistoryLast20}}) and a parser turns it into a value. Kept out of
	 * SYSTEM_MACROS so the lint warns on the placeholder, which resolves to nothing, rather
	 * than on the spelling that works.
	 */
	parameterized?: boolean;
}

/**
 * Every macro the app knows about. The one place to add/rename/document a macro.
 *
 * Names follow SillyTavern's wherever ST has a macro for the same thing, so a preset author
 * coming from ST writes what their fingers already know. The ones ST has no equivalent for
 * ({{character}}, {{lorebook}}, {{chatHistory}}, {{memory}}, the memory-flow set) keep the
 * same camelCase shape so the registry reads as one system rather than two conventions.
 */
export const MACROS: readonly MacroDef[] = [
	// ----- Engine-owned (resolved from real story + chat state, everywhere) -----
	{ name: 'user', description: 'Persona / protagonist name.', engine: true, group: 'names' },
	{ name: 'char', description: 'Character name (resolved per-character inside their own fields).', engine: true, group: 'names' },
	{ name: 'persona', description: "The active persona's description.", engine: true, group: 'context' },
	{ name: 'character', description: "The active character's full profile (the whole-sheet blob).", engine: true, group: 'context' },
	{ name: 'lorebook', description: 'Lorebook entries, keyword-matched against recent messages.', engine: true, group: 'context' },
	{ name: 'memory', description: 'Chat-memory recall block (episode summaries).', engine: true, group: 'context' },
	{ name: 'chatHistory', description: 'Every turn, as native-role messages. Prompt items only: anywhere else it resolves to nothing.', engine: true, structural: true, group: 'context' },
	{ name: 'chatHistoryLastN', description: 'Only the newest N turns, as a plain transcript. Write the number: {{chatHistoryLast20}}.', engine: true, parameterized: true, group: 'context' },
	{ name: 'lastMessage', description: 'The newest turn, as inline text. A copy: the turn itself still rides {{chatHistory}}.', engine: true, group: 'context' },
	{ name: 'lastUserMessage', description: 'The newest user turn, as inline text.', engine: true, group: 'context' },
	{ name: 'lastCharMessage', description: 'The newest character turn, as inline text.', engine: true, group: 'context' },

	{ name: 'time', description: 'Current local time, e.g. 6:02 PM.', engine: true, group: 'time' },
	{ name: 'date', description: 'Current local date, e.g. August 22, 2026.', engine: true, group: 'time' },
	{ name: 'weekday', description: 'Current day of the week, e.g. Saturday.', engine: true, group: 'time' },
	{ name: 'isotime', description: 'Current local time as 24-hour HH:MM:SS.', engine: true, group: 'time' },
	{ name: 'isodate', description: 'Current local date as YYYY-MM-DD.', engine: true, group: 'time' },

	// ----- Per-field character macros (place one card field individually) -----
	{ name: 'description', description: "The character's description field, on its own.", engine: true, group: 'character-field' },
	{ name: 'personality', description: "The character's personality-summary field, on its own.", engine: true, group: 'character-field' },
	{ name: 'charFirstMessage', description: "The character's opening message field, on its own.", engine: true, group: 'character-field' },
	{ name: 'mesExamples', description: "The character's example dialogue, block-formatted: <START> markers become the preset's example separator.", engine: true, group: 'character-field' },
	{ name: 'mesExamplesRaw', description: "The character's example dialogue exactly as the card wrote it, unformatted.", engine: true, group: 'character-field' },
	{ name: 'charPrompt', description: "The character card's own system-prompt override.", engine: true, group: 'character-field' },
	{ name: 'charInstruction', description: "The card's post-history instructions (jailbreak).", engine: true, group: 'character-field' },
	{ name: 'charVersion', description: "The character card's version tag.", engine: true, group: 'character-field' },
	{ name: 'charCreatorNotes', description: "The card's creator notes.", engine: true, group: 'character-field' },
	// SillyTavern names the notes macro but has none for the credit beside it, so this one
	// stays in the same char* family rather than inventing a second shape for one field.
	{ name: 'charCreator', description: "Who made the card (its Created by field).", engine: true, group: 'character-field' },
	// Belongs to the character card, and only to it. The opening-scene engine carries
	// its own typed direction in the call-site key {{idea}} precisely so it never
	// shadows this one (see generateOpeningScene in stores/messages.svelte.ts).
	{ name: 'scenario', description: "The character's scenario field.", engine: true, group: 'character-field' },

	// ----- Memory pipeline flow (extraction / promotion) -----
	{ name: 'deepMemory', description: 'Older, already-compacted arcs.', group: 'memory' },
	{ name: 'recentEpisodes', description: 'The newest raw episode summaries.', group: 'memory' },
	{ name: 'batch', description: "The new scene's messages to digest.", group: 'memory' },
	{ name: 'sceneLength', description: 'How long the episode should be, scaled to the batch.', group: 'memory' },
	{ name: 'mergeMode', description: 'Guidance on whether the merge continues a layer or starts fresh.', group: 'memory' },
	{ name: 'higherContext', description: 'Already-compacted context that must not be restated.', group: 'memory' },
	{ name: 'episodes', description: 'The episode summaries being merged.', group: 'memory' },
	{ name: 'recent', description: 'Recent episode summaries included in recall.', group: 'memory' }
] as const;

/** Names of the engine-owned macros that resolve exactly as written, derived so it can never
 *  drift from MACROS. Parameterized entries are excluded on purpose: only their numbered form
 *  resolves, so the bare placeholder is not a name anything provides. */
export const SYSTEM_MACROS: readonly string[] = MACROS.filter((m) => m.engine && !m.parameterized).map(
	(m) => m.name
);

/** Names of the structural macros, derived so it can never drift from MACROS. Every site
 *  that has to recognise them (the assembly tag scan, the nested-expansion fallback below)
 *  reads this list rather than spelling the names out again. */
export const STRUCTURAL_MACROS: readonly string[] = MACROS.filter((m) => m.structural).map(
	(m) => m.name
);

/** Matches {{name}} and {{name.sub}}, the one macro shape used everywhere. */
export const MACRO_REGEX = /\{\{(\w+(?:\.\w+)?)\}\}/g;

/** Heads each example-dialogue block when the preset names no `exampleSeparator` of its own
 *  (SillyTavern's <START> marker becomes this). An empty separator is a real choice, meaning
 *  no header line at all, so this is only ever the fallback for an ABSENT one. */
export const DEFAULT_EXAMPLE_SEPARATOR = '***';

/**
 * The one substitution primitive. Replaces every {{key}} from `values` in a single pass, so
 * a value containing {{...}} is never re-scanned, and through a function replacement so
 * literal $-sequences in a value aren't treated as replacement patterns.
 * Macros with no entry in `values` are left literal (so typos surface instead of vanishing).
 */
export function substitute(template: string, values: Record<string, string>): string {
	if (!template) return '';
	return template.replace(MACRO_REGEX, (match, name: string) =>
		name in values ? values[name] : match
	);
}

/** Parses a {{chatHistoryLastN}} macro name into N, or undefined for any other name.
 *  The one place the parameterized shape is defined. */
export function cappedHistoryTurns(name: string): number | undefined {
	const match = name.match(/^chatHistoryLast(\d+)$/);
	return match ? Number(match[1]) : undefined;
}

/** Plain-text transcript, "Name: content" per turn: the inline-text form of chat history.
 *  `lastN` keeps only the newest N turns; omitted means ALL turns. Backs
 *  {{chatHistoryLastN}} so the format can't drift. */
function renderTranscript(messages: Message[], user: string, char: string, lastN?: number): string {
	const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
	const kept = lastN === undefined ? turns : lastN > 0 ? turns.slice(-lastN) : [];
	return kept
		.map((m) => `${m.role === 'user' ? user : char}: ${expandSelfRefs(m.content, char, user)}`)
		.join('\n\n');
}

/** The unique macro names referenced in a piece of text (without braces). */
export function extractMacroNames(text: string): string[] {
	if (!text) return [];
	const names = new Set<string>();
	for (const match of text.matchAll(MACRO_REGEX)) {
		names.add(match[1]);
	}
	return [...names];
}

// ============================================================================
// Tag-block pruning: conditional framing without syntax
// ============================================================================
//
// A preset item can wrap a macro in a plain XML tag block (`<memory>{{memory}}</memory>`).
// When every macro a block carries resolves to empty, the whole block goes: tags, framing
// text and all, instead of being sent as a dangling empty shell. The rules, applied
// bottom-up so pruning cascades outward:
//   1. A block whose content is nothing but whitespace after pruning its children and
//      substituting known values is dropped (this is how an outer wrapper follows its
//      emptied children out).
//   2. A block whose OWN text references macros, all of them known and empty, is dropped
//      with its static framing, since the label exists for the content and dies with it,
//      but never while a surviving child block still holds content.
//   3. Blocks with no macros anywhere are static text and are never touched. Unknown
//      macro names stay literal (per `substitute`), so a typo keeps its block alive and
//      visible instead of silently vanishing.
// Only plain `<name>` tags (no attributes, no self-closing) form blocks; anything else,
// including unmatched tags, is left alone. Pruning runs on the item TEMPLATE before
// substitution, so tags arriving inside macro values can never form prunable blocks.

/** Plain opening tag, the only shape that forms a prunable block. */
const TAG_OPEN_RE_SRC = '<([A-Za-z][A-Za-z0-9_-]*)>';

interface PruneLevel {
	/** This level's text with pruned child blocks removed (template form, unsubstituted). */
	out: string;
	/** True when this level or anything below references a macro or pruned a block. */
	dynamic: boolean;
	/** Macro names referenced in this level's own text, outside surviving child blocks. */
	directMacros: string[];
	/** Child blocks kept at this level. */
	survivingChildren: number;
}

/** Index right after the close tag matching an open `<name>` whose content starts at `from`,
 *  or -1 when unbalanced. Depth-counted so same-name nesting pairs correctly. */
function findMatchingClose(text: string, name: string, from: number): number {
	const token = new RegExp(`</?${name}>`, 'g');
	token.lastIndex = from;
	let depth = 1;
	let m: RegExpExecArray | null;
	while ((m = token.exec(text)) !== null) {
		depth += m[0][1] === '/' ? -1 : 1;
		if (depth === 0) return m.index;
	}
	return -1;
}

function shouldPrune(block: PruneLevel, values: Record<string, string>): boolean {
	if (!block.dynamic) return false;
	// Emptied out entirely. Unknown macros stay literal in `substitute`, so a typo'd name
	// keeps the block non-empty and visible rather than silently pruned.
	if (!substitute(block.out, values).trim()) return true;
	// Framing case: the block's own macros all came back empty, so its static text is
	// framing for content that isn't there and goes with it. A surviving child always vetoes.
	if (block.survivingChildren > 0 || block.directMacros.length === 0) return false;
	return block.directMacros.every((name) => name in values && !values[name].trim());
}

/** One nesting level: recurse into child blocks, drop the ones that prune, and report
 *  what this level saw so the caller can judge the enclosing block. */
function pruneLevel(text: string, values: Record<string, string>): PruneLevel {
	// Local regex instance: recursion would corrupt a shared one's lastIndex.
	const openRe = new RegExp(TAG_OPEN_RE_SRC, 'g');
	let out = '';
	let ownText = '';
	let dynamic = false;
	let survivingChildren = 0;
	let pos = 0;

	let match: RegExpExecArray | null;
	while ((match = openRe.exec(text)) !== null) {
		const name = match[1];
		const innerStart = match.index + match[0].length;
		const closeAt = findMatchingClose(text, name, innerStart);
		if (closeAt === -1) continue; // unmatched tag: plain text, keep scanning after it

		const before = text.slice(pos, match.index);
		out += before;
		ownText += before;

		const child = pruneLevel(text.slice(innerStart, closeAt), values);
		if (shouldPrune(child, values)) {
			dynamic = true; // a pruned child alone can empty this block out
		} else {
			out += `<${name}>${child.out}</${name}>`;
			dynamic = dynamic || child.dynamic;
			survivingChildren++;
		}
		pos = closeAt + name.length + 3; // past `</name>`
		openRe.lastIndex = pos;
	}
	const rest = text.slice(pos);
	out += rest;
	ownText += rest;

	const directMacros = extractMacroNames(ownText);
	return { out, dynamic: dynamic || directMacros.length > 0, directMacros, survivingChildren };
}

/**
 * Remove tag blocks whose macros all resolved empty (see the rules above). Returns the
 * template ready for `substitute`: untouched when nothing prunes, whitespace-tidied
 * (gaps collapsed, ends trimmed) when something did.
 */
export function pruneEmptyTagBlocks(text: string, values: Record<string, string>): string {
	if (!text || !text.includes('<')) return text;
	const { out } = pruneLevel(text, values);
	if (out === text) return text;
	return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ============================================================================
// Engine: context-aware preset expansion
// ============================================================================

export interface MacroContext {
	resolvedPersona?: PromptCharacter | null;
	resolvedCharacters?: PromptCharacter[];
	/** The lorebook block injected at {{lorebook}}, already scanned and rendered by the context
	 *  builder (`resolveLorebooks`, lorebook/engine.ts). Empty when nothing fired. */
	lorebook?: string;
	/** Why that block holds what it holds. A resolution OUTPUT carried here so assembly can hand
	 *  it to the caller that stores it on the turn; no macro reads it. */
	lorebookTrace?: LorebookTrace;
	/** The lore that asked to sit at a depth inside the chat rather than in the block. Another
	 *  resolution OUTPUT, spliced by assembly the way steering is; no macro reads it either. */
	lorebookPlaced?: LorebookPlacedGroup[];
	chatMessages?: Message[]; // Full chat path for the history and last-turn macros
	/** Pre-rendered chat-memory recall block, injected via {{memory}} (empty when off). */
	memory?: string;
	/** Ids of messages folded into memory, excluded from {{chatHistory}} so they're not duplicated. */
	archivedMessageIds?: Set<string>;
	/** Ids of the oldest turns dropped by the context-size budget, excluded from {{chatHistory}}. */
	droppedMessageIds?: Set<string>;
	/** Whether the enabled preset injects {{chatHistory}}: the budget trim can only drop
	 *  turns that something actually renders. Absent = it doesn't, the empty-preset
	 *  fallback's answer. */
	injectsHistory?: boolean;
	/** Active preset's custom controls, binding macro names to user-facing widgets. */
	controls?: PromptControl[];
	/** Global values for the custom controls, keyed by control macro name. */
	customFields?: Record<string, unknown>;
	/** The active preset's opt-in for tag-block pruning (PromptPreset.pruneEmptyBlocks). */
	pruneEmptyBlocks?: boolean;
	/** Per-preset separator that replaces <START> in example dialogue; absent =
	 *  {@link DEFAULT_EXAMPLE_SEPARATOR}. */
	exampleSeparator?: string;
	/** Budget-trim signal: drop this many oldest example-dialogue blocks. */
	droppedExampleBlocks?: number;
	/**
	 * When this prompt was assembled, stamped ONCE by the context builder and read by every
	 * clock macro.
	 *
	 * Not `Date.now()` inside the resolver, for the same reason the lorebook is scanned once
	 * and carried: macros are re-resolved several times during one assembly (the budget trim
	 * re-runs them), so a resolver that read the clock could print 6:02 PM in one item and
	 * 6:03 PM in another, inside a single prompt. Absent - a preview surface that built no
	 * context - falls back to the clock, which is right for a preview and impossible in a
	 * prompt.
	 */
	now?: number;
}

/**
 * The clock macros' formatting, matched to what SillyTavern's own macros print so a preset
 * written there reads the same here: `{{time}}` is moment's `LT` (6:02 PM), `{{date}}` is
 * `LL` (August 22, 2026), `{{weekday}}` is `dddd` (Saturday).
 *
 * The locale is pinned to en-US rather than following the browser's, which is the one place
 * this deliberately does NOT do the locally-correct thing. A preset that says "the current
 * real time is {{time}}, {{weekday}} {{date}}" was written against a shape - 6:02 PM,
 * Saturday August 22, 2026 - and a reader on en-GB would silently get "6:02 pm, Saturday 22
 * August 2026" instead, changing what the model reads because of where the reader lives.
 * SillyTavern's default is the same shape, so a preset carries over unchanged.
 *
 * The TIME ZONE is still the reader's own: `Date`'s own accessors are local, so this is the
 * clock on their wall written in a fixed format, not a fixed clock. The ISO pair is not
 * localised either, for the stronger version of the same reason.
 */
function clockDate(now: number | undefined): Date {
	return new Date(now ?? Date.now());
}

function formatClock(now: number | undefined): string {
	return clockDate(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatLongDate(now: number | undefined): string {
	return clockDate(now).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatWeekday(now: number | undefined): string {
	return clockDate(now).toLocaleDateString('en-US', { weekday: 'long' });
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function formatIsoTime(now: number | undefined): string {
	const d = clockDate(now);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatIsoDate(now: number | undefined): string {
	const d = clockDate(now);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface PromptCharacter {
	name: string;
	traits: CharacterTraits;
	storyNotes?: string;
}

/**
 * Macros this module resolves itself instead of through the plain field map. `mesExamples`
 * lives in PERMANENT_TRAITS like any other field, but its value is block-formatted first
 * (SillyTavern `<START>` handling in `formatExampleDialogue`), so a plain map entry would
 * hand back the raw text and double-resolve it. `{{mesExamplesRaw}}` is the unformatted form
 * of the same field, resolved below: no trait of its own, so it never enters the map.
 */
const SPECIAL_FIELD_MACROS: readonly string[] = ['mesExamples'];

/**
 * Per-field character macros → the trait they resolve. A preset can place any card field on
 * its own with these (SillyTavern-style), independent of the whole-sheet {{character}} blob.
 * They resolve against the chat's bound character; {{persona}} covers the protagonist.
 *
 * Derived from PERMANENT_TRAITS: the trait definitions already pair each field with its
 * macro, so a field that gains, loses, or renames a macro reaches resolution with no second
 * edit here.
 */
const CHARACTER_FIELD_MACROS: Record<string, TraitKey> = Object.fromEntries(
	PERMANENT_TRAITS.character
		.filter((t): t is PermanentTraitDef & { macro: string } => !!t.macro)
		.filter((t) => !SPECIAL_FIELD_MACROS.includes(t.macro))
		.map((t) => [t.macro, t.key])
);

/**
 * Resolve the engine values for every macro a text references: the global half of any
 * substitution. Flow surfaces merge their own values OVER this record (flow wins on a
 * collision), then call `substitute` once, so injected values are never re-scanned.
 * Unknown macros get no entry and stay literal, so typos surface instead of vanishing.
 */
export function resolveMacroValues(text: string, context: MacroContext): Record<string, string> {
	const values: Record<string, string> = {};
	if (!text) return values;
	for (const name of extractMacroNames(text)) {
		const value = resolveMacro(name, context);
		if (value !== undefined) values[name] = value;
	}
	return values;
}

/**
 * Expand all macros in the given text using the provided context. Resolves each referenced
 * name to its value, then defers to the shared `substitute` primitive.
 */
export function expandMacros(text: string, context: MacroContext): string {
	if (!text) return '';
	return substitute(text, resolveMacroValues(text, context));
}

/**
 * Resolve a single macro name to its value, or undefined when nothing here answers it.
 *
 * Engine macros resolve FIRST and always win, so a preset control reusing an engine name (a
 * stray {{user}} control, say) is ignored rather than allowed to shadow the engine value.
 * The Prompt Builder flags such a control in the UI as well.
 */
function resolveMacro(name: string, context: MacroContext): string | undefined {
	const { resolvedPersona, resolvedCharacters } = context;

	// Structural macros belong to prompt-assembly, which preserves their native roles. Empty
	// here is the fallback for one reached through nested expansion.
	if (STRUCTURAL_MACROS.includes(name)) {
		return '';
	}

	// {{chatHistoryLastN}} is the EXPLICIT way to get a shortened history, as inline
	// transcript text. Nothing ever caps {{chatHistory}} behind the author's back.
	const lastN = cappedHistoryTurns(name);
	if (lastN !== undefined) {
		return renderTranscript(
			context.chatMessages ?? [],
			resolvedPersona?.name || 'User',
			resolvedCharacters?.[0]?.name || 'Narrator',
			lastN
		);
	}

	// Data system macros. With nothing resolved they resolve empty (still not shadowable).
	switch (name) {
		case 'user':
			return resolvedPersona?.name || '';
		case 'char':
			// The character the chat is bound to.
			return resolvedCharacters?.[0]?.name || '';
		case 'lastMessage':
			return lastTurnText(context);
		case 'lastUserMessage':
			return lastTurnText(context, 'user');
		case 'lastCharMessage':
			return lastTurnText(context, 'assistant');
		case 'persona':
			return formatPersona(resolvedPersona ?? null);
		case 'character':
			return formatCharacters(
				resolvedCharacters ?? [],
				resolvedPersona?.name || 'User',
				context.exampleSeparator ?? DEFAULT_EXAMPLE_SEPARATOR
			);
		case 'lorebook':
			// Scanned and rendered ONCE, when the context was built, so every re-resolve inside
			// one assembly prints the same block and the trace stored on the turn names exactly
			// the entries that shaped it. Rolling Trigger % here instead would give the budget
			// trim's re-resolves a fresh set of entries each pass.
			return context.lorebook ?? '';
		case 'memory':
			// Chat-memory recall, pre-rendered by the prompt builder. Empty when memory is
			// off, so the macro simply vanishes from the prompt.
			return context.memory ?? '';
		// The reader's own clock, because these resolve in the browser: a model told the time
		// should be told the time where the person typing is, not where the server happens to
		// be racked. Their locale is deliberately NOT followed - the formatters above say why.
		case 'time':
			return formatClock(context.now);
		case 'date':
			return formatLongDate(context.now);
		case 'weekday':
			return formatWeekday(context.now);
		case 'isotime':
			return formatIsoTime(context.now);
		case 'isodate':
			return formatIsoDate(context.now);
	}

	// {{mesExamples}} is block-formatted separately from the other per-field macros: <START>
	// markers split the raw field into blocks, each re-headered with the preset's separator,
	// so the budget trim can drop the oldest blocks the same way it drops history turns.
	// {{mesExamplesRaw}} is the same field with none of that: what the card wrote, self-refs
	// expanded and nothing else. Deliberately outside the trim, because raw means raw.
	if (name === 'mesExamples' || name === 'mesExamplesRaw') {
		const char = resolvedCharacters?.[0];
		const raw = char?.traits.exampleDialogue;
		if (!char || !raw) return '';
		const personaName = resolvedPersona?.name || 'User';
		if (name === 'mesExamplesRaw') return expandSelfRefs(raw, char.name, personaName);
		return formatExampleDialogue(raw, {
			separator: context.exampleSeparator ?? DEFAULT_EXAMPLE_SEPARATOR,
			dropOldest: context.droppedExampleBlocks ?? 0,
			charName: char.name,
			personaName
		});
	}

	// Per-field character macros: the bound character's raw field value (self-refs expanded),
	// with no labels or framing, so the preset author supplies the wrapping. Engine-resolved,
	// so a stray control can't shadow them.
	const fieldKey = CHARACTER_FIELD_MACROS[name];
	if (fieldKey) {
		const char = resolvedCharacters?.[0];
		if (!char) return '';
		const raw = char.traits[fieldKey];
		if (!raw) return '';
		return expandSelfRefs(raw, char.name, resolvedPersona?.name || 'User');
	}

	// Everything else is a preset macro: pov, genre, content_rating and anything an author
	// wires up, resolved from the active preset's controls. The default preset seeds these,
	// so it doubles as the reference example. Unknown names stay literal so typos surface.
	const custom = resolveCustomControl(name, context);
	if (custom !== undefined) return custom;

	return undefined;
}

/**
 * The newest turn's text, optionally the newest of one role: the shared body of
 * {{lastMessage}} / {{lastUserMessage}} / {{lastCharMessage}}. Inline text, never a
 * native turn: none of the three removes anything from {{chatHistory}}, so a preset that
 * uses one is quoting a turn the history also carries. Self-refs resolve live, exactly as
 * they do in an injected turn or a transcript.
 */
function lastTurnText(context: MacroContext, role?: 'user' | 'assistant'): string {
	const msgs = context.chatMessages ?? [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (role && msgs[i].role !== role) continue;
		return expandSelfRefs(
			msgs[i].content,
			context.resolvedCharacters?.[0]?.name || 'Narrator',
			context.resolvedPersona?.name || 'User'
		);
	}
	return '';
}

/**
 * Resolve a macro against the active preset's custom controls.
 * Returns undefined (macro stays literal) if no control binds to this name.
 */
function resolveCustomControl(name: string, context: MacroContext): string | undefined {
	const control = context.controls?.find((c) => c.macro === name);
	if (!control) return undefined;
	return formatControlForPrompt(control, context.customFields?.[name]);
}

/**
 * Expand the self-referential macros that live inside a character's own field values.
 * {{char}} becomes the character's name and {{user}} the persona's, done per-character
 * rather than in the global macro pass so imported cards keep their macros and a rename just
 * works. Case- and whitespace-tolerant to match the variants cards use.
 */
export function expandSelfRefs(text: string, charName: string, userName: string): string {
	if (!text) return text;
	return text
		.replace(/\{\{\s*char\s*\}\}/gi, charName)
		.replace(/\{\{\s*user\s*\}\}/gi, userName);
}

/** Split a raw example-dialogue field into individual blocks on <START> markers
 *  (SillyTavern's convention, case-insensitive). Trims each block and drops empties;
 *  a field with no markers is a single block. Empty/whitespace input yields []. */
export function splitExampleBlocks(raw: string): string[] {
	if (!raw?.trim()) return [];
	return raw
		.split(/<START>/gi)
		.map((block) => block.trim())
		.filter((block) => block.length > 0);
}

/**
 * Format a character's raw example-dialogue field into the form actually sent: split into
 * blocks on <START>, optionally drop the oldest `dropOldest` blocks (the context-budget
 * trim's signal), prefix each surviving block with the preset's separator as its own header
 * line (skipped when the separator is empty), join blocks with a blank line between them, and
 * finally expand {{char}}/{{user}} self-refs once over the whole result.
 */
function formatExampleDialogue(
	raw: string,
	opts: { separator: string; dropOldest?: number; charName: string; personaName: string }
): string {
	let blocks = splitExampleBlocks(raw);
	if (opts.dropOldest && opts.dropOldest > 0) blocks = blocks.slice(opts.dropOldest);
	if (blocks.length === 0) return '';
	const formatted = opts.separator ? blocks.map((block) => `${opts.separator}\n${block}`) : blocks;
	return expandSelfRefs(formatted.join('\n\n'), opts.charName, opts.personaName);
}

/**
 * Format a single character/persona into lines. The name leads as a plain field; the
 * enclosing preset tag (e.g. <Character> / <Protagonist>) supplies the framing, so no
 * markdown headers here.
 */
function formatSingleCharacter(
	name: string,
	traits: CharacterTraits,
	permanentTraits: PermanentTraitDef[],
	charName: string,
	userName: string,
	exampleSeparator: string,
	storyNotes?: string
): string[] {
	const lines: string[] = [`**Name:** ${name}`];

	// Only the descriptive sheet fields ride the blob; the opening message, instructions and
	// metadata are placed by their own macros, so they're never dumped here.
	for (const { key, label, inBlob } of permanentTraits) {
		if (!inBlob) continue;
		const raw = traits[key];
		if (!raw) continue;
		// The example-dialogue field is fixed text here (not trimmable), but still normalized:
		// <START> markers become the same separator-headed blocks the {{mesExamples}} macro emits.
		const value =
			key === 'exampleDialogue'
				? formatExampleDialogue(raw, { separator: exampleSeparator, charName, personaName: userName })
				: expandSelfRefs(raw, charName, userName);
		if (!value) continue;
		lines.push(`**${label}:** ${value}`);
	}

	if (storyNotes?.trim()) {
		lines.push(`**Story Notes:** ${expandSelfRefs(storyNotes.trim(), charName, userName)}`);
	}

	return lines;
}

/**
 * The active persona's description and nothing else, matching SillyTavern's {{persona}}. The
 * name is not part of it: {{user}} already places that, and a preset author who wants both
 * writes both. Personas are a single free-text field (PERMANENT_TRAITS.persona), so there is
 * no sheet to format here the way {{character}} has one.
 */
function formatPersona(activePersona: PromptCharacter | null): string {
	const description = activePersona?.traits.description;
	if (!description) return '';
	return expandSelfRefs(description, activePersona.name, activePersona.name);
}

/**
 * Format the active character into a single headerless sheet. A chat binds one character, so
 * this resolves to a single sheet; the array is walked defensively and would stack multiple
 * name-led sheets rather than lose any.
 */
function formatCharacters(characters: PromptCharacter[], userName: string, exampleSeparator: string): string {
	return characters
		.filter((char) => char.name)
		.map((char) =>
			formatSingleCharacter(
				char.name,
				char.traits,
				PERMANENT_TRAITS.character,
				char.name,
				userName,
				exampleSeparator,
				char.storyNotes
			).join('\n')
		)
		.join('\n\n');
}

/**
 * The turns `{{chatHistory}}` injects: the whole chat path minus `excludedIds`
 * (memory-archived + budget-trimmed). ONE function, because the injection and the budget
 * trim's history token count must never be able to disagree about which turns those are.
 *
 * `{{chatHistory}}` carries every turn, including the newest, and the three
 * `{{last*Message}}` macros are plain inline text that take nothing away from here. Handing
 * the newest turn to a second structural macro instead is what lets a turn fall between the
 * two and vanish, and what makes the trim price turns the other macro carried.
 * Messages are returned whole so an injection keeps its attachments.
 */
export function historyTurns(
	messages: Message[] | undefined,
	excludedIds: Set<string> | undefined
): Message[] {
	if (!messages || messages.length === 0) return [];
	return excludedIds?.size ? messages.filter((m) => !excludedIds.has(m.id)) : messages;
}
