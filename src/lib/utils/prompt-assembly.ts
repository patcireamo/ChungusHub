/**
 * Pure prompt assembly: the single source of truth for turning a preset + story/chat
 * context into the messages we send AND the token breakdown every surface displays.
 *
 * Three primitives, used everywhere so values can never drift between surfaces:
 *   - buildMacroContext(input): the ONE place a MacroContext is constructed.
 *   - resolveItem(item, ctx):   the ONE place a prompt item is resolved to its messages +
 *                               token attribution (preset / context / chat).
 *   - assemblePrompt(input):    iterates the enabled items through resolveItem to produce
 *                               the final messages + aggregate breakdown.
 *
 * This module is intentionally pure (no db, no stores, no Svelte runes): the generation path
 * ({@link ./prompt-builder}) sources inputs from the db and the live token meters source them
 * reactively from stores, but both feed these same functions, so the meter always matches
 * what is actually sent, and the logic stays unit-testable.
 */

import type { LLMMessage, PromptPostProcessingMode } from '$lib/types/llm';
import { DEFAULT_PROMPT_PLACEHOLDER } from '$lib/types/llm';
import type { Message } from '$lib/types/chat';
import type { ResolvedSteeringNote, SteeringRole } from '$lib/types/steering';
import type { PromptControl, PromptItem, PromptPreset } from '$lib/types/database';
import type { Lorebook, LorebookGlobalSettings, LorebookTrace, LorebookTrigger } from '$lib/lorebook/types';
import { EMPTY_LOREBOOK_TRACE, lorebookHistory, lorebookScanFields } from '$lib/lorebook/types';
import { resolveLorebooks } from '$lib/lorebook/engine';
import {
	expandMacros,
	expandSelfRefs,
	historyTurns,
	pruneEmptyTagBlocks,
	resolveMacroValues,
	splitExampleBlocks,
	STRUCTURAL_MACROS,
	substitute,
	type MacroContext,
	type PromptCharacter
} from '$lib/macros';
import { countTokens } from '$lib/tokenizer/count';
import { applyPromptRegex, type RegexRule } from './regex-rules';

export const DEFAULT_SYSTEM_PROMPT =
	'You are a helpful, creative assistant for interactive fiction and storytelling. Respond naturally and engagingly to the user.';

/** The instruction Continue appends after the reply it extends, when the preset carries no
 *  `continuePrompt` of its own. A preset that sets it to an empty string sends nothing. */
export const DEFAULT_CONTINUE_PROMPT =
	'((OOC: Continue your previous message. Your reply will be appended to the end of that message exactly as you send it, so write only the new text: no repetition, no rephrasing, no lead-in, and do not acknowledge this instruction. If the message broke off mid-sentence, finish that sentence first. If it already ends cleanly, continue the scene from that exact moment with what happens next. Keep the same tense, point of view, and voice.))';

/** Resolved chat-memory recall: the {{memory}} text plus the ids it folded away. */
export interface PromptRecall {
	text: string | null;
	archivedIds: Set<string>;
}

/** Everything the assembly primitives need, sourced from the db for the real prompt, or
 *  reactively from stores for the live token meters. */
export interface AssembleInput {
	preset: PromptPreset | null;
	resolvedCharacters: PromptCharacter[];
	resolvedPersona: PromptCharacter | null;
	lorebooks: Lorebook[];
	/** Global lorebook activation settings; absent = the engine's stock defaults. */
	lorebookSettings?: LorebookGlobalSettings;
	/** Which generation this prompt is for, so entries limited to some kinds sit the rest out.
	 *  Absent = a plain send, which is what the token meters price. */
	lorebookTrigger?: LorebookTrigger;
	controls: PromptControl[];
	customFields: Record<string, unknown>;
	chatMessages: Message[];
	recall: PromptRecall;
	/** Model id whose encoding the token counts use (meters pass the active model). */
	model?: string;
	/** Connection-level prompt reshaping ({@link applyPostProcessing}); defaults to 'merge'. */
	postProcessing?: { mode: PromptPostProcessingMode; placeholder?: string };
	/** Max prompt tokens (base-estimate space). When the assembly exceeds it, the oldest
	 *  {{chatHistory}} turns are dropped until it fits. null/undefined = unlimited. */
	contextBudget?: number | null;
	/** User regex rules; the prompt-scope ones rewrite chat messages on their way
	 *  into the context (display-scope application lives in the chat components).
	 *  Applied once, in {@link buildMacroContext}: stored rows are never touched. */
	regexRules?: RegexRule[];
	/** Continue-in-place: the assistant turn being extended. It is appended after every
	 *  preset item as the trailing assistant message (prompt regex and live self-refs
	 *  applied exactly like an injected history turn), followed by the preset's own
	 *  `continuePrompt` as a final user instruction, macro-expanded here, against the
	 *  same context as everything else in the prompt. A blank instruction is skipped,
	 *  leaving the assistant turn closing the prompt, prefill-style for providers that
	 *  continue it natively.
	 *  `chatMessages` must NOT include the turn; pass the path up to its parent. */
	continuation?: Message;
	/** Corrections: the assistant turn being rewritten, and the filled instruction that says
	 *  how. Same tail shape as `continuation` (see {@link actionTail}) and mutually exclusive
	 *  with it, but the turn is sent as its STORED bytes rather than as an injected history
	 *  turn: a correction's output replaces the row, so anything a prompt-scope regex rule or
	 *  a macro expansion rewrote on the way out would be silently baked into storage on the
	 *  way back. What is sent is exactly what will be overwritten.
	 *  `instruction` arrives already filled (the engine substitutes {{instruction}} into the
	 *  authored template, the same call-site substitution as the opening scene's {{idea}});
	 *  the global macros in it are expanded here like any other instruction. It must not be
	 *  blank: an empty instruction leaves the assistant turn closing the prompt as a prefill,
	 *  and the model would continue the message instead of rewriting it. The engine refuses
	 *  that before assembly is ever reached.
	 *  `chatMessages` must NOT include the turn; pass the path up to its parent. */
	correction?: { message: Message; instruction: string };
	/** Steering: guidance injected into the prompt without ever becoming a chat row. The
	 *  caller passes the notes that already resolved as active for this chat, with their
	 *  inherited placement filled in (`resolveSteeringForPrompt`, types/steering.ts).
	 *  Scope matching and inheritance are deliberately not assembly's business.
	 *
	 *  Notes sharing a role AND a depth are joined (blank line between) and wrapped ONCE,
	 *  so a stack of five notes is not five system turns littered through the prompt; a
	 *  single note therefore produces exactly what one steering ever produced.
	 *
	 *  `depth` counts back from the end of the injected chat: {{chatHistory}}'s turns. 0 (the
	 *  default) lands right after the newest turn, N lands N turns before it, and a depth
	 *  deeper than the injected chat clamps to the front. The guidance therefore always rides
	 *  inside the story rather than after the preset's post-history blocks. A position nothing
	 *  renders (no {{chatHistory}} in the preset, or nothing left to inject) falls back to the
	 *  end of the assembly, never silently. `wrapper` wraps each group's joined text; {{steering}} is an ad-hoc, call-site
	 *  substitution key layered over the wrapper's own macro values, same pattern as the
	 *  opening scene's {{idea}}, not a macros.ts entry.
	 *
	 *  Unlike `continuation` (a one-shot action the meters never pass), steering IS
	 *  standing prompt state, so the chat meter passes it too, under the same engine
	 *  gate as prompt-builder, or the meter would price a block the send won't send. */
	steering?: { notes: ResolvedSteeringNote[]; wrapper: string };
}

/** One item's contribution to the final prompt, with tokens attributed by provenance:
 *  - preset:  the authored template text of the item
 *  - context: what world macros pulled in (persona / character / lorebook / controls)
 *  - memory:  the {{memory}} chat-recall block (its own category, not part of context)
 *  - chat:    the injected {{chatHistory}} turns
 *  `raw` is the literal item text (no expansion): what the "Raw" token view shows. */
export interface ResolvedItem {
	messages: LLMMessage[];
	raw: number;
	preset: number;
	context: number;
	memory: number;
	chat: number;
}

/** Aggregate token attribution across all enabled items. */
export interface PromptTokenBreakdown {
	preset: number;
	context: number;
	memory: number;
	chat: number;
	total: number;
}

export interface PromptAssembly {
	messages: LLMMessage[];
	breakdown: PromptTokenBreakdown;
	/** History turns dropped to fit the context budget (0 when it fits or no budget is set). */
	trimmedMessages: number;
	/** Example-dialogue blocks dropped to fit the budget (0 when none). */
	trimmedExampleBlocks: number;
	/** True when the prompt still exceeds the budget with all history dropped: the fixed
	 *  blocks (preset/world/memory) alone don't fit and the user must be warned. */
	overBudget: boolean;
	/** Which lorebook entries shaped this prompt, and why. The generation path stores it on the
	 *  turn it produced; every other surface is free to ignore it. */
	lorebook: LorebookTrace;
	/** The extended turn's text as the model receives it (prompt regex applied, self-refs
	 *  expanded), set only when the input carries a continuation. The join compares the
	 *  model's reply against THIS, not the stored bytes: a turn holding literal {{user}} is
	 *  restated by the model in its expanded form, and comparing against the stored text
	 *  waves that copy through to be appended twice (continuation.ts). */
	continuationSent?: string;
}

/**
 * Construct the MacroContext from resolved inputs. The single place this happens, so macro
 * resolution is identical at every surface (real prompt, chat meter, Prompt Builder).
 */
export function buildMacroContext(input: AssembleInput): MacroContext {
	// Prompt-scope regex rules rewrite the chat turns HERE, before anything derives
	// from them: structural injection, lorebook scanning and the budget trim all
	// read ctx.chatMessages, so every surface prices exactly what is sent.
	const chatMessages = applyPromptRegex(input.chatMessages, input.regexRules);
	// What the ENABLED preset actually injects. Two behaviors hang off this: archived turns
	// only leave {{chatHistory}} when {{memory}} recalls them somewhere, and only turns
	// {{chatHistory}} renders can be dropped by the budget trim.
	const injects = (macro: string) => !!input.preset?.items.some((it) => it.enabled && it.content.includes(macro));
	const memoryReferenced = injects('{{memory}}');
	// Lorebook token budget: a share of the same context budget the assembly trims against,
	// counted with the same encoding, so the block the meter prices is the block that is sent.
	const budgetPercent = input.lorebookSettings?.budgetPercent ?? 0;
	const lorebookBudget =
		input.contextBudget != null && budgetPercent > 0
			? {
					maxTokens: Math.floor((input.contextBudget * budgetPercent) / 100),
					count: (text: string) => countTokens(text, input.model)
				}
			: undefined;
	const base: MacroContext = {
		resolvedPersona: input.resolvedPersona,
		resolvedCharacters: input.resolvedCharacters,
		chatMessages,
		controls: input.controls,
		customFields: input.customFields,
		memory: input.recall.text ?? '',
		archivedMessageIds: memoryReferenced ? input.recall.archivedIds : undefined,
		injectsHistory: injects('{{chatHistory}}'),
		pruneEmptyBlocks: input.preset?.pruneEmptyBlocks ?? false,
		exampleSeparator: input.preset?.exampleSeparator ?? undefined
	};
	// The lorebook is scanned and rendered once, here, against a context that has no lore in it
	// yet: that is what makes a stray {{lorebook}} inside an entry resolve to nothing instead of
	// recursing, and it leaves ONE roll of the probabilistic entries per assembly.
	const lore = resolveLorebooks({
		books: input.lorebooks,
		// An at-depth entry needs a chat to sit inside. Without {{chatHistory}} in the enabled
		// preset there is no such sequence, so those entries join the block instead of landing
		// in a position nothing renders. Decided here, once, where the preset is already known.
		placeAtDepth: base.injectsHistory,
		messages: chatMessages.map((m) => m.content),
		fields: lorebookScanFields(input.resolvedCharacters, input.resolvedPersona),
		trigger: input.lorebookTrigger,
		// Sticky and cooldown read the traces the path's own turns stored, so a swipe measures
		// them against the branch it lives on rather than against the attempt it replaced.
		history: lorebookHistory(chatMessages),
		settings: input.lorebookSettings,
		expand: (text) => expandMacros(text, base),
		budget: lorebookBudget
	});
	return { ...base, lorebook: lore.text, lorebookTrace: lore.trace, lorebookPlaced: lore.placed };
}

/** Tokens a macro-expanded template segment contributes: raw text → preset, the delta → context. */
function expandedSegment(raw: string, expanded: string, model?: string): { preset: number; context: number } {
	const rawTokens = countTokens(raw, model);
	return { preset: rawTokens, context: Math.max(0, countTokens(expanded, model) - rawTokens) };
}

/**
 * Resolve one prompt item into the messages it contributes plus its token attribution.
 * The structural macro ({{chatHistory}}) injects native-role messages around the surrounding
 * template text; everything else is a single macro-expanded message.
 */
export function resolveItem(item: PromptItem, ctx: MacroContext, model?: string): ResolvedItem {
	const raw = countTokens(item.content, model);

	if (STRUCTURAL_TAG_RE.test(item.content)) {
		return resolveStructural(item, ctx, raw, model);
	}

	// Prune-then-substitute: when the preset opts in, tag blocks whose macros all resolved
	// empty are dropped from the template before expansion, so conditional framing never
	// dangles (see macros.ts). Off = the template is expanded exactly as written.
	const values = resolveMacroValues(item.content, ctx);
	const template = ctx.pruneEmptyBlocks ? pruneEmptyTagBlocks(item.content, values) : item.content;
	const expanded = substitute(template, values);
	if (!expanded.trim()) return { messages: [], raw, preset: 0, context: 0, memory: 0, chat: 0 };

	// The preset bucket counts the SURVIVING template: pruned framing is never sent, so
	// it must not weigh in (the budget trim relies on buckets summing to what's sent).
	const presetTokens = countTokens(template, model);
	const expandedTokens = countTokens(expanded, model);
	let context = Math.max(0, expandedTokens - presetTokens);
	let memory = 0;
	// Chat-memory recall is its own category, not part of Context. Isolate exactly what
	// the {{memory}} text contributed by re-substituting the same surviving template with
	// it blanked (the template stays fixed so the block's framing stays in Preset).
	if (ctx.memory && item.content.includes('{{memory}}')) {
		const withoutMemory = countTokens(substitute(template, { ...values, memory: '' }), model);
		memory = Math.max(0, expandedTokens - withoutMemory);
		context = Math.max(0, context - memory);
	}
	return { messages: [{ role: item.role, content: expanded }], raw, preset: presetTokens, context, memory, chat: 0 };
}

/** Ids excluded from {{chatHistory}}: memory-archived turns plus budget-trimmed ones. */
function historyExcludedIds(ctx: MacroContext): Set<string> | undefined {
	const { archivedMessageIds: archived, droppedMessageIds: dropped } = ctx;
	if (!archived?.size) return dropped;
	if (!dropped?.size) return archived;
	return new Set([...archived, ...dropped]);
}

/** The structural macros that inject native-role chat messages rather than expand inline,
 *  built from the registry's `structural` flag, so declaring one there is the only edit.
 *  {{chatHistory}} is the only one today; the alternation keeps that a registry fact. */
const STRUCTURAL_ALTERNATION = STRUCTURAL_MACROS.join('|');
const STRUCTURAL_TAG_RE = new RegExp(`\\{\\{(?:${STRUCTURAL_ALTERNATION})\\}\\}`);

/** A chat Message as an injected LLM turn: native role + attachment images.
 *  Self-refs ({{char}}/{{user}}) are resolved live against the active persona/character
 *  here, never baked into the stored row, so changing persona reflows old turns too. */
function toInjectedMessage(m: Message, ctx: MacroContext): LLMMessage {
	const images = m.attachments?.filter((a) => a.kind === 'image').map((a) => a.path);
	const content = expandSelfRefs(
		m.content,
		ctx.resolvedCharacters?.[0]?.name || 'Narrator',
		ctx.resolvedPersona?.name || 'User'
	);
	return { role: m.role, content, ...(images?.length ? { images } : {}) };
}

/** MacroContext plus the depth placements (steering groups and at-depth lorebook entries),
 *  carried on the ctx used for a given resolution so the trim passes in assemblePrompt (which
 *  rebuild ctx and re-run resolveEnabled) carry the splices forward automatically, always
 *  against THAT resolution's own filtered/dropped chat. Local to this module:
 *  {{steering}} is a call-site substitution key, never a macros.ts-registered macro. */
type SplicedContext = MacroContext & {
	splices?: DepthSplice[];
};

/** One turn that rides inside the chat rather than at a preset item: the built message, the
 *  depth it wants, and its price. Steering and at-depth lore are the same shape on purpose,
 *  so one placement rule serves both and neither can drift. */
type DepthSplice = { message: LLMMessage; depth: number; tokens: number };

/**
 * The chat turns THIS resolution injects: one sequence, all of it {{chatHistory}}'s, and
 * the sequence a splice's depth is measured against. Injected whole so a turn's attachment
 * images ride along; an image-only turn has empty content but must still be sent.
 */
function injectedTurns(ctx: SplicedContext): LLMMessage[] {
	return historyTurns(ctx.chatMessages, historyExcludedIds(ctx)).map((m) => toInjectedMessage(m, ctx));
}

/**
 * Splice the depth placements into the injected chat.
 *
 * Depth counts back from the end: 0 lands after the newest turn, N lands N turns before it,
 * clamped to the front once N runs deeper than the injected chat. Every position is measured
 * against the UNSPLICED sequence and the result rebuilt in one pass, so several splices can't
 * shift each other's target and groups landing on the same slot keep their own order, which is
 * the order the caller built them in: lore first, then steering, so the reader's own direction
 * sits closest to the turn it is steering.
 */
function placeSplices(injected: LLMMessage[], splices: DepthSplice[] | undefined): LLMMessage[] {
	if (!splices?.length) return injected;
	const placements = splices.map((s) => ({
		at: Math.max(0, injected.length - s.depth),
		message: s.message
	}));
	const out: LLMMessage[] = [];
	for (let i = 0; i <= injected.length; i++) {
		for (const p of placements) if (p.at === i) out.push(p.message);
		if (i < injected.length) out.push(injected[i]);
	}
	return out;
}

/** Messages the structural tag injects at its position: the history turns with the depth
 *  placements spliced in. */
function structuralInjection(ctx: SplicedContext): LLMMessage[] {
	return placeSplices(injectedTurns(ctx), ctx.splices);
}

/**
 * Resolve an item that contains one or more structural macros, in order:
 * [text] + [injected messages] + [text] + [injected messages] + …
 * A degenerate preset naming the tag twice injects the chat twice, exactly as written:
 * every occurrence is resolved, never just the first.
 */
function resolveStructural(item: PromptItem, ctx: SplicedContext, raw: number, model?: string): ResolvedItem {
	type Part = { type: 'text'; value: string } | { type: 'inject'; msgs: LLMMessage[] };
	const parts: Part[] = [];
	const re = new RegExp(`\\{\\{(?:${STRUCTURAL_ALTERNATION})\\}\\}`, 'g');
	let lastIndex = 0;
	let anyInjected = false;
	let match: RegExpExecArray | null;
	while ((match = re.exec(item.content)) !== null) {
		if (match.index > lastIndex) parts.push({ type: 'text', value: item.content.slice(lastIndex, match.index) });
		const msgs = structuralInjection(ctx);
		if (msgs.length) anyInjected = true;
		parts.push({ type: 'inject', msgs });
		lastIndex = match.index + match[0].length;
	}
	if (lastIndex < item.content.length) parts.push({ type: 'text', value: item.content.slice(lastIndex) });

	// Nothing structural to inject (e.g. an empty-history wrapper) → drop the whole item,
	// preserving the original single-macro behavior.
	if (!anyInjected) return { messages: [], raw, preset: 0, context: 0, memory: 0, chat: 0 };

	const messages: LLMMessage[] = [];
	let preset = 0;
	let context = 0;
	let memory = 0;
	let chat = 0;

	for (const part of parts) {
		if (part.type === 'text') {
			// Prune-then-substitute, exactly as the non-structural path does. An item is not
			// exempt from the preset's own pruning just because it also injects chat turns, and
			// the structural tags have already split the template into runs that can each be
			// pruned on their own.
			const values = resolveMacroValues(part.value, ctx);
			const template = ctx.pruneEmptyBlocks ? pruneEmptyTagBlocks(part.value, values) : part.value;
			const expanded = substitute(template, values).trim();
			if (!expanded) continue;
			const seg = expandedSegment(template, expanded, model);
			preset += seg.preset;
			// Chat-memory recall is its own category, never part of Context: the same split the
			// non-structural path makes. Putting {{memory}} in the same item as {{chatHistory}}
			// is ordinary authoring, and pricing it as Context made the meter's Memory row
			// disappear on exactly those presets.
			if (ctx.memory && template.includes('{{memory}}')) {
				const withoutMemory = countTokens(substitute(template, { ...values, memory: '' }).trim(), model);
				const mem = Math.max(0, countTokens(expanded, model) - withoutMemory);
				memory += mem;
				context += Math.max(0, seg.context - mem);
			} else {
				context += seg.context;
			}
			messages.push({ role: item.role, content: expanded });
		} else {
			for (const msg of part.msgs) {
				messages.push(msg);
				// A spliced message (steering, or lore that asked for a depth) is fixed cost,
				// priced once in assemblePrompt's `context` bucket. Never let it double-count
				// here as an ordinary history turn. Matched by identity, so a coincidental text
				// match can't fool it.
				if (ctx.splices?.some((s) => s.message === msg)) continue;
				chat += countTokens(msg.content, model);
			}
		}
	}

	return { messages, raw, preset, context, memory, chat };
}

/** Build the steering messages (see {@link AssembleInput.steering}) once, so the splice and
 *  the end-of-assembly fallback send and price the exact same objects.
 *
 *  Notes sharing a role AND a depth become ONE message: their texts are joined and the
 *  wrapper is applied to the join, not per note. Groups keep first-appearance order,
 *  which is the caller's injection order (broad scope → narrow). A group whose join or
 *  whose wrapped result is blank is dropped: steering never sends a dangling empty turn. */
function buildSteeringMessages(input: AssembleInput, ctx: MacroContext, model?: string): DepthSplice[] {
	const steering = input.steering;
	if (!steering) return [];

	const groups = new Map<string, { role: SteeringRole; depth: number; texts: string[] }>();
	for (const note of steering.notes) {
		if (!note.text.trim()) continue;
		const key = `${note.role} ${note.depth}`;
		const group = groups.get(key);
		if (group) group.texts.push(note.text);
		else groups.set(key, { role: note.role, depth: note.depth, texts: [note.text] });
	}

	const builds: DepthSplice[] = [];
	for (const group of groups.values()) {
		// The guidance may itself reference {{char}}/{{user}}. Expanded after the join so a
		// note can't be swallowed by another's trailing macro.
		const expandedText = expandMacros(group.texts.join('\n\n'), ctx);
		if (!expandedText.trim()) continue;
		// {{steering}} is an ad-hoc, call-site-supplied key layered over the wrapper's own
		// macro values (flow wins on collision), the same pattern the opening scene uses
		// for {{idea}}; it is deliberately not a macros.ts entry.
		const content = substitute(steering.wrapper, {
			...resolveMacroValues(steering.wrapper, ctx),
			steering: expandedText
		});
		if (!content.trim()) continue;
		builds.push({
			message: { role: group.role, content },
			depth: group.depth,
			tokens: countTokens(content, model)
		});
	}
	return builds;
}

/** The at-depth lorebook groups as splices. Already grouped, expanded and budget-checked by
 *  the engine (`resolveLorebooks`), so this only prices them and gives them their role. */
function buildLoreSplices(ctx: MacroContext, model?: string): DepthSplice[] {
	return (ctx.lorebookPlaced ?? []).map((group) => ({
		message: { role: group.role, content: group.text },
		depth: group.depth,
		tokens: countTokens(group.text, model)
	}));
}

/**
 * The tail a one-shot action closes the prompt with: the assistant turn it acts on, followed
 * by the instruction saying what to do with it. Continue and Corrections are the same shape
 * and differ only in how that turn is rendered and which instruction follows, so they share
 * one builder -- and therefore share the pricing below, which is the half neither can afford
 * to get wrong. The tail is fixed cost (see `fixedExtra` in assemblePrompt): history yields
 * room for it and it is never itself trimmed, because a correction whose target was trimmed
 * away is a correction of nothing.
 *
 * The two render their turn differently on purpose. Continue APPENDS to the stored row, so it
 * sends the turn as an injected history turn (prompt regex applied, self-refs expanded) and
 * `continuationSent` anchors the join against exactly what the model saw. Corrections REPLACES
 * the row, so it sends the stored bytes untouched: a prompt-scope rule hides text from the
 * model without changing storage, and rewriting the hidden-from version would delete what it
 * hid, for good. Empty when the input carries neither.
 */
function actionTail(input: AssembleInput, ctx: MacroContext): { messages: LLMMessage[]; tokens: number } {
	if (input.correction) {
		const messages: LLMMessage[] = [{ role: 'assistant', content: input.correction.message.content }];
		const instruction = expandMacros(input.correction.instruction, ctx).trim();
		if (instruction) messages.push({ role: 'user', content: instruction });
		return { messages, tokens: messages.reduce((sum, m) => sum + countTokens(m.content, input.model), 0) };
	}
	if (!input.continuation) return { messages: [], tokens: 0 };
	const [target] = applyPromptRegex([input.continuation], input.regexRules);
	const messages = [toInjectedMessage(target, ctx)];
	const nudge = expandMacros(input.preset?.continuePrompt ?? DEFAULT_CONTINUE_PROMPT, ctx).trim();
	if (nudge) messages.push({ role: 'user', content: nudge });
	return { messages, tokens: messages.reduce((sum, m) => sum + countTokens(m.content, input.model), 0) };
}

/**
 * Pure assembly: resolved inputs → final messages + aggregate token breakdown.
 * No db, no async. The live meters can therefore call it on every reactive change.
 */
export function assemblePrompt(input: AssembleInput): PromptAssembly {
	const mode = input.postProcessing?.mode ?? 'merge';
	const placeholder = input.postProcessing?.placeholder;
	const { preset } = input;
	if (!preset || preset.items.length === 0) {
		// The tail and steering must survive even without a preset: a continue/steering
		// against the bare fallback prompt still has to carry what it carries.
		let fallbackTail: { messages: LLMMessage[]; tokens: number } | undefined;
		let fallbackSteering: DepthSplice[] = [];
		if (input.continuation || input.correction || input.steering) {
			const fallbackCtx = buildMacroContext(input);
			fallbackTail =
				input.continuation || input.correction ? actionTail(input, fallbackCtx) : undefined;
			fallbackSteering = buildSteeringMessages(input, fallbackCtx, input.model);
		}
		return systemFallback(mode, placeholder, fallbackTail, fallbackSteering, !!input.continuation);
	}

	let ctx: SplicedContext = buildMacroContext(input);
	// Two kinds of turn ride inside the chat, and they share one placement rule. Lore is built
	// first so that at a shared slot the background sits ahead of the reader's own direction.
	const splices = [...buildLoreSplices(ctx, input.model), ...buildSteeringMessages(input, ctx, input.model)];
	// Every group splices into the injected chat, whatever its depth. Carrying them on ctx
	// (instead of threading them through by hand) means the example-trim and history-trim
	// re-resolves below (which rebuild ctx and re-run resolveEnabled) carry the splices
	// forward automatically, always against that resolution's own filtered/dropped chat.
	if (splices.length) ctx = { ...ctx, splices };
	const tail = actionTail(input, ctx);
	// A splice is fixed cost like the tail: priced once, added to every budget comparison
	// below so history yields room for it and it is never itself trimmed. resolveStructural
	// never counts a spliced message into a bucket of its own (see its ctx.splices check), so
	// this is the ONLY place those tokens are added, whichever path ends up landing each
	// group. No double-counting either way.
	const spliceTokens = splices.reduce((sum, b) => sum + b.tokens, 0);
	const fixedExtra = tail.tokens + spliceTokens;

	let { messages, breakdown } = resolveEnabled(preset, ctx, input.model);

	let trimmedMessages = 0;
	let trimmedExampleBlocks = 0;
	let overBudget = false;
	const budget = input.contextBudget;

	// Example-block trim pass: examples are pushed out before chat history. Only relevant
	// when the preset actually injects {{mesExamples}} and the bound character has blocks to
	// drop; the trim works purely by re-resolving with fewer blocks, no separate token bucket.
	// {{mesExamplesRaw}} is deliberately not trimmable and deliberately not counted here.
	const injectsExamples = preset.items.some((it) => it.enabled && it.content.includes('{{mesExamples}}'));
	const exampleBlocks = splitExampleBlocks(ctx.resolvedCharacters?.[0]?.traits.exampleDialogue ?? '');
	if (budget != null && breakdown.total + fixedExtra > budget && injectsExamples && exampleBlocks.length > 0) {
		for (let dropOldest = 1; dropOldest <= exampleBlocks.length; dropOldest++) {
			({ messages, breakdown } = resolveEnabled(preset, { ...ctx, droppedExampleBlocks: dropOldest }, input.model));
			trimmedExampleBlocks = dropOldest;
			if (breakdown.total + fixedExtra <= budget) break;
		}
	}

	// Context-budget trim: when the assembly still exceeds the budget, drop the oldest
	// {{chatHistory}} turns (never the preset/world/memory blocks), then re-resolve so
	// messages and breakdown both reflect what is actually sent. Only {{chatHistory}} is
	// trimmable. Without it in the enabled preset, dropping history ids does nothing, so
	// reporting a trim count would be a lie.
	const injectsHistory = !!ctx.injectsHistory;
	if (budget != null && breakdown.total + fixedExtra > budget) {
		// Over budget is over budget whether or not history is trimmable; report it either way.
		overBudget = true;
		if (injectsHistory) {
			// ctx.chatMessages, not input.chatMessages: the trim must count the same
			// regex-transformed turns that resolveStructural actually injects, hence the
			// same call. The continuation tail and steering are fixed cost, so they weigh
			// against history's budget.
			const history = historyTurns(ctx.chatMessages, ctx.archivedMessageIds);
			const historyTokens = history.reduce((sum, m) => sum + countTokens(m.content, input.model), 0);
			const historyBudget = budget - (breakdown.total + fixedExtra - historyTokens);
			// Keep the newest contiguous run that fits: a gapped keep would break the conversation.
			let oldestKept = history.length;
			let kept = 0;
			for (let i = history.length - 1; i >= 0; i--) {
				const t = countTokens(history[i].content, input.model);
				if (kept + t > historyBudget) break;
				kept += t;
				oldestKept = i;
			}
			if (oldestKept > 0) {
				const dropped = new Set(history.slice(0, oldestKept).map((m) => m.id));
				// Carry the example-block drop count along so this re-resolve doesn't
				// undo the example trim pass above.
				({ messages, breakdown } = resolveEnabled(
					preset,
					{ ...ctx, droppedMessageIds: dropped, droppedExampleBlocks: trimmedExampleBlocks },
					input.model
				));
				trimmedMessages = dropped.size;
			}
			overBudget = breakdown.total + fixedExtra > budget;
		}
	}

	if (messages.length === 0) return systemFallback(mode, placeholder, tail, splices);

	// The fallback net for any group whose position no structural tag rendered: neither
	// tag in the preset, or nothing left to inject after the trim. Tracked by object
	// identity, never content, so a coincidental text match can't fool it. A splice must
	// never silently vanish: the meter has already priced it.
	const unplaced = splices.filter((b) => !messages.includes(b.message));
	if (unplaced.length) messages = [...messages, ...unplaced.map((b) => b.message)];
	if (spliceTokens > 0) {
		breakdown.context += spliceTokens;
		breakdown.total += spliceTokens;
	}

	// The action tail rides after every preset item AND steering (post-history
	// instructions included), so the turn being extended and its nudge always close the prompt.
	if (tail.messages.length > 0) {
		messages = [...messages, ...tail.messages];
		breakdown.chat += tail.tokens;
		breakdown.total += tail.tokens;
	}

	return {
		messages: applyPostProcessing(messages, mode, placeholder),
		breakdown,
		trimmedMessages,
		trimmedExampleBlocks,
		overBudget,
		lorebook: ctx.lorebookTrace ?? EMPTY_LOREBOOK_TRACE,
		// Continue's anchor only. A correction replaces its turn rather than joining onto it,
		// so handing back an anchor would invite a join that must never happen.
		continuationSent: input.continuation ? tail.messages[0]?.content : undefined
	};
}

/** Resolve every enabled item against a context, the shared body for both assembly passes. */
function resolveEnabled(
	preset: PromptPreset,
	ctx: MacroContext,
	model?: string
): { messages: LLMMessage[]; breakdown: PromptTokenBreakdown } {
	const messages: LLMMessage[] = [];
	const breakdown: PromptTokenBreakdown = { preset: 0, context: 0, memory: 0, chat: 0, total: 0 };

	for (const item of preset.items) {
		if (!item.enabled) continue;
		const r = resolveItem(item, ctx, model);
		messages.push(...r.messages);
		breakdown.preset += r.preset;
		breakdown.context += r.context;
		breakdown.memory += r.memory;
		breakdown.chat += r.chat;
	}

	breakdown.total = breakdown.preset + breakdown.context + breakdown.memory + breakdown.chat;
	return { messages, breakdown };
}

function systemFallback(
	mode: PromptPostProcessingMode = 'merge',
	placeholder?: string,
	tail?: { messages: LLMMessage[]; tokens: number },
	splices: DepthSplice[] = [],
	/** Whether `tail` is a continuation's, the only kind that yields a join anchor. */
	isContinuation = false
): PromptAssembly {
	const preset = countTokens(DEFAULT_SYSTEM_PROMPT);
	const steeringMessages = splices.map((b) => b.message);
	const steeringTokens = splices.reduce((sum, b) => sum + b.tokens, 0);
	const tailMessages = tail?.messages ?? [];
	const tailTokens = tail?.tokens ?? 0;
	return {
		messages: applyPostProcessing(
			[{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }, ...steeringMessages, ...tailMessages],
			mode,
			placeholder
		),
		breakdown: {
			preset,
			context: steeringTokens,
			memory: 0,
			chat: tailTokens,
			total: preset + steeringTokens + tailTokens
		},
		trimmedMessages: 0,
		trimmedExampleBlocks: 0,
		overBudget: false,
		// The fallback prompt is the default system message and nothing else: no item resolved,
		// so no lore reached this prompt whatever the scan decided.
		lorebook: EMPTY_LOREBOOK_TRACE,
		continuationSent: isContinuation ? tailMessages[0]?.content : undefined
	};
}

/**
 * Reshape assembled messages for APIs that restrict prompt structure. From least to most
 * restrictive:
 *   - none:        send exactly what was assembled
 *   - merge:       fold consecutive same-role messages into one (the default)
 *   - semi-strict: merge + at most one system message, at the top; any system message
 *                  after the first non-system turn is demoted to user
 *   - strict:      semi-strict + the first turn must be from the user; a placeholder user
 *                  turn is inserted when the prompt would open with the assistant
 *   - single-user: the entire prompt collapses into one user message
 */
export function applyPostProcessing(
	messages: LLMMessage[],
	mode: PromptPostProcessingMode,
	placeholder: string = DEFAULT_PROMPT_PLACEHOLDER
): LLMMessage[] {
	if (messages.length === 0 || mode === 'none') return messages;

	if (mode === 'single-user') {
		const images = messages.flatMap((m) => m.images ?? []);
		return [
			{
				role: 'user',
				content: messages.map((m) => m.content).join('\n\n'),
				...(images.length ? { images } : {})
			}
		];
	}

	if (mode === 'merge') return mergeConsecutiveRoles(messages);

	// semi-strict / strict: demote any system message that appears after the first
	// non-system turn, so merging leaves a single system message at the top.
	let seenNonSystem = false;
	const demoted = messages.map((m): LLMMessage => {
		if (m.role !== 'system') {
			seenNonSystem = true;
			return m;
		}
		return seenNonSystem ? { role: 'user', content: m.content } : m;
	});
	const merged = mergeConsecutiveRoles(demoted);

	if (mode === 'strict') {
		const firstTurn = merged.findIndex((m) => m.role !== 'system');
		if (firstTurn === -1) {
			merged.push({ role: 'user', content: placeholder });
		} else if (merged[firstTurn].role !== 'user') {
			merged.splice(firstTurn, 0, { role: 'user', content: placeholder });
		}
	}
	return merged;
}

/**
 * Merge consecutive messages that share the same role into one.
 * Uses double newline as separator between merged content.
 */
export function mergeConsecutiveRoles(messages: LLMMessage[]): LLMMessage[] {
	if (messages.length === 0) return messages;

	const result: LLMMessage[] = [];

	for (const msg of messages) {
		const last = result[result.length - 1];
		if (last && last.role === msg.role) {
			last.content += '\n\n' + msg.content;
			if (msg.images?.length) last.images = [...(last.images ?? []), ...msg.images];
		} else {
			result.push({ role: msg.role, content: msg.content, ...(msg.images?.length ? { images: msg.images } : {}) });
		}
	}

	return result;
}
