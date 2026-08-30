/**
 * Generation-path prompt builder.
 *
 * Gathers the real inputs from the db / preset service and defers to the pure assembler in
 * {@link ./prompt-assembly}, the single source of truth for the messages we send and the
 * token breakdown the live meters display. Keeping the IO here and the logic there lets both
 * the generation path and the (reactive, store-sourced) meters share one assembly.
 */

import type { CallTarget, LLMMessage } from '$lib/types/llm';
import type { Message } from '$lib/types/chat';
import { activeSteeringNotes, resolveSteeringForPrompt, steeringTargetForChat } from '$lib/types/steering';
import type { PromptPreset } from '$lib/types/database';
import type { Lorebook, LorebookTrace, LorebookTrigger } from '$lib/lorebook/types';
import { resolveLorebookLinks } from '$lib/lorebook/types';
import { db } from '$lib/services/database';
import { presetService } from '$lib/services/presets.svelte';
import { readPresetControlValues } from '$lib/stores/presetControls.svelte';
import { memoryStore } from '$lib/memory/store.svelte';
import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
import { regexRulesStore } from '$lib/stores/regex-rules.svelte';
import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
import { chatPersonaClaim, resolvePersonaId, resolvePromptTarget, toPromptCharacter } from './chat-setup';
import { assemblePrompt, type PromptRecall } from './prompt-assembly';

const ACTIVE_PERSONA_KEY = 'activePersonaId';

export interface PromptBuildContext {
	chatId: string | null;
	chatMessages: Message[]; // Full chat path for history and last_message macros
	/** Continue-in-place: the assistant turn being extended (see AssembleInput.continuation;
	 *  the instruction that follows it comes from the preset). `chatMessages` then carries
	 *  the path up to that turn's parent, the same prompt that would regenerate it. */
	continuation?: Message;
	/** Which generation this is, for lorebook entries limited to some kinds. Defaults to a send. */
	lorebookTrigger?: LorebookTrigger;
	/** Who this prompt is being built FOR: model, token budget, and post-processing all
	 *  resolve from this target's connection, so an Opening Scene pinned to its own
	 *  connection is assembled in that connection's terms, not primary's.
	 *  Defaults to the primary chat send. */
	target?: CallTarget;
}

/** A built prompt: what goes on the wire, and the lorebook scan that shaped it. */
export interface BuiltPrompt {
	messages: LLMMessage[];
	/** The connection this prompt was assembled for, and the one it must be sent on. Carried
	 *  out rather than re-derived by each caller, so the review dialog names the model the
	 *  budget was counted against. */
	target: CallTarget;
	/** Stored on the turn this prompt produces, so the reply can say afterwards which entries
	 *  were in it and why. The scan happens once, inside assembly, so this is the record of
	 *  what was actually sent rather than a second guess at it. */
	lorebook: LorebookTrace;
	/** Continue builds only: the extended turn's text as the model receives it, the anchor
	 *  the join trims restatements against (see PromptAssembly.continuationSent). */
	continuationSent?: string;
	/** The 'once' steering notes this prompt actually resolved. The ids ride the request so
	 *  the turn's commit spends exactly what rode it, and the texts stay here for the chat's
	 *  reuse list, which is per-chat state the server does not author (architecture/engines.md). */
	oneShotSteering: { id: string; text: string }[];
}

/**
 * Build prompt messages for the real generation path. Sources the inputs from the db /
 * preset service, then defers to the shared assembler.
 */
export async function buildPromptMessages(context: PromptBuildContext): Promise<BuiltPrompt> {
	const { chatId, chatMessages } = context;

	// Load active preset: the effective copy (unsaved draft if there is one).
	await presetService.initialize();
	const preset: PromptPreset | null = presetService.getActiveEffectivePreset();

	// Resolve the chat's bound character, the persona it plays as, and that character's
	// lorebook + the global preset-control values for macro expansion.
	const chat = chatId ? await db.getChat(chatId) : null;
	const libraryEntries = chat ? await db.getAllLibraryEntries() : [];
	let character = chat?.characterId
		? libraryEntries.find((entry) => entry.id === chat.characterId && entry.type === 'character') ?? null
		: null;

	// A pinned chat plays against its pinned variant's row, always: the library's
	// active version has no say here, so a chat's prompt never shifts because the user
	// switched variants somewhere else. A missing row means the pin dangles: surface
	// it, never silently fall back to a different variant of the character.
	if (character && chat?.characterVersionId) {
		const version = await db.getCharacterVersion(chat.characterVersionId);
		if (!version || version.entryId !== character.id) {
			throw new Error(
				`This chat is pinned to a character version that no longer exists. Repin it from the version menu.`
			);
		}
		character = { ...character, data: version.data };
	}
	// The chat's own persona while it names one that still exists, else the app's. Same
	// resolver the meter and the transcript run, against the rows read here rather than the
	// store's copy (architecture/prompt-pipeline.md coupling 3c).
	const personaId = resolvePersonaId(
		chatPersonaClaim(chat),
		libraryEntries,
		(await db.getSetting(ACTIVE_PERSONA_KEY)) || null
	);
	const personaEntry = personaId
		? libraryEntries.find((entry) => entry.id === personaId && entry.type === 'persona') ?? null
		: null;

	// Active lorebooks = those linked by the bound character + the active persona, resolved IN
	// LINK ORDER (deduped). The two reactive token meters run the same resolver over the
	// store's books (lorebookStore.resolveBooks), so the meter can never render a different
	// block than is sent. Generation reads the books fresh instead of trusting the store.
	const linkedBookIds = [
		...(character?.data.lorebookIds ?? []),
		...(personaEntry?.data.lorebookIds ?? [])
	];
	const lorebooks: Lorebook[] = linkedBookIds.length
		? resolveLorebookLinks(await db.getAllLorebooks(), linkedBookIds)
		: [];

	const recall: PromptRecall = chatId
		? await memoryStore.getRecall(chatId, chatMessages)
		: { text: null, archivedIds: new Set<string>() };

	// Steering: guidance that never becomes a chat row (see AssembleInput.steering). Notes
	// are read FRESH from the db rather than the store's cache (the same doctrine as the
	// lorebooks above) and resolved through the shared pure resolver, so the chat meter
	// (which resolves the store's copy) can never price a different stack than this sends.
	// assemblePrompt alone decides placement and pricing; this is only the gate and the
	// scope match.
	const steeringNotes = featurePromptsStore.steeringEnabled ? await db.getAllSteeringNotes() : [];
	const steeringTarget = steeringTargetForChat(chat);
	const resolvedSteering = resolveSteeringForPrompt(
		steeringNotes,
		steeringTarget,
		featurePromptsStore.steeringDefaults
	);
	// The one-shots by id, from the same rows and the same gate as the stack above, because
	// what a turn spends must be what a turn sent. The pure resolver deliberately drops ids
	// (assembly has no use for them), so the set is taken again rather than threaded through it.
	const oneShotSteering = activeSteeringNotes(steeringNotes, steeringTarget)
		.filter((note) => note.mode === 'once')
		.map((note) => ({ id: note.id, text: note.text }));

	// Model, budget and prompt shape all come off this one resolution, the same one the
	// composer's meter runs, so the price on screen is the price of the request.
	const promptTarget = resolvePromptTarget(chat, context.target ?? 'primary');

	const { messages, lorebook, continuationSent } = assemblePrompt({
		preset,
		resolvedCharacters: character ? [toPromptCharacter(character)!] : [],
		resolvedPersona: toPromptCharacter(personaEntry),
		lorebooks,
		lorebookSettings: lorebookSettingsStore.settings,
		lorebookTrigger: context.lorebookTrigger,
		controls: preset?.controls ?? [],
		customFields: await readPresetControlValues(),
		chatMessages,
		recall,
		model: promptTarget.model,
		postProcessing: promptTarget.postProcessing,
		contextBudget: promptTarget.contextBudget,
		regexRules: regexRulesStore.effective,
		continuation: context.continuation,
		steering: resolvedSteering.length
			? { notes: resolvedSteering, wrapper: featurePromptsStore.promptFor('steeringWrapper') }
			: undefined
	});

	return { messages, target: promptTarget.target, lorebook, continuationSent, oneShotSteering };
}
