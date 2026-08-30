/**
 * What a chat is running on: the persona it plays as, and the connection its prompt is
 * priced, shaped and sent in.
 *
 * Every surface that assembles or renders this story asks here, so one chat has one answer.
 * The rule is the whole design and it is one line: the chat's own claim when the thing it
 * names still exists, otherwise the app's. No layer between the two, and no third state.
 *
 * The chat is handed in rather than reached for: the generation path imports this module, and
 * a reach into `chatStore` would close the import cycle documented in live-macro-context.ts.
 */

import type { Chat } from '$lib/types/chat';
import { normalizeChatFeatureState } from '$lib/types/chat';
import type { LibraryEntry } from '$lib/types/library';
import type { CallTarget, PromptPostProcessingMode } from '$lib/types/llm';
import type { PromptCharacter } from '$lib/macros';
import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
import { connectionStore } from '$lib/stores/connections.svelte';
import { personaStore } from '$lib/stores/persona.svelte';
import { llmService } from '$lib/services/llm/provider';

export interface PromptTarget {
	/** The call this prompt rides. Every surface that names the model names this one's, so
	 *  the review dialog and the meter can never label a request the send did not make. */
	target: CallTarget;
	model: string;
	postProcessing: { mode: PromptPostProcessingMode; placeholder: string };
	contextBudget: number;
}

/**
 * The connection a chat claimed for itself, or null when it follows the app.
 *
 * A claim naming a connection that has since been deleted reads as no claim: the story keeps
 * sending on the app's connection instead of failing, and the chip says the claim is gone.
 * Sweeping the stored id instead would throw away a pin the user could still want back by
 * restoring the connection.
 */
export function chatConnectionId(chat: Chat | null): string | null {
	if (!chat) return null;
	const claimed = normalizeChatFeatureState(chat.featureState).connection;
	return claimed && connectionStore.get(claimed) ? claimed : null;
}

/**
 * Resolve the connection terms a chat's prompt is assembled in.
 *
 * `base` is the routing point the caller would ride without a chat in hand: the story send
 * and every meter beside it pass `primary`, while an engine passes its own target so its
 * assigned connection applies to assembly exactly as it does to the call. **Only `primary`
 * can be claimed by a chat**: the assistant and every engine stay app-wide, which is what
 * keeps the Connections page honest about the rows it does own.
 */
export function resolvePromptTarget(chat: Chat | null, base: CallTarget = 'primary'): PromptTarget {
	const claimed = base === 'primary' ? chatConnectionId(chat) : null;
	const target: CallTarget = claimed ? { connection: claimed } : base;
	return {
		target,
		model: llmService.modelFor(target),
		postProcessing: {
			mode: llmService.getPromptPostProcessing(target),
			placeholder: llmService.getPromptPlaceholder(target)
		},
		contextBudget: llmService.getPromptTokenBudget(target)
	};
}

/** The persona id a chat claimed, before any liveness check. The chip reads this beside
 *  the resolved one to tell "follows the app" from "the persona it named is gone". */
export function chatPersonaClaim(chat: Chat | null): string | null {
	return chat ? normalizeChatFeatureState(chat.featureState).persona : null;
}

/**
 * The persona a claim resolves to, against a persona list and the app's own choice. A claim
 * naming a persona that no longer exists reads as no claim.
 *
 * The db-sourced generation path passes the entries it read; every reactive surface goes
 * through `personaEntryFor` below, which passes the store's. Same doctrine as the lorebooks
 * and the steering notes: one rule, two sources.
 */
export function resolvePersonaId(
	claimed: string | null,
	personas: LibraryEntry[],
	appPersonaId: string | null
): string | null {
	if (claimed && personas.some((e) => e.id === claimed && e.type === 'persona')) return claimed;
	return appPersonaId;
}

/** Store-sourced twin of `resolvePersonaId`, by claim: what a surface holding only the id
 *  speaks as (the memory store's ChatCtx carries the claim the way it carries the version pin). */
export function personaEntryFor(claimed: string | null): LibraryEntry | null {
	const entries = characterLibraryStore.entries;
	const id = resolvePersonaId(claimed, entries, personaStore.activeId);
	return id ? entries.find((e) => e.id === id && e.type === 'persona') ?? null : null;
}

/** The entry a reactive surface holding the chat speaks as. */
export function chatPersonaEntry(chat: Chat | null): LibraryEntry | null {
	return personaEntryFor(chatPersonaClaim(chat));
}

/** A library entry as prompt assembly sees it. One spelling, so the meters and the send
 *  cannot describe the same persona differently. */
export function toPromptCharacter(entry: LibraryEntry | null | undefined): PromptCharacter | null {
	if (!entry) return null;
	return { name: entry.identity.name, traits: entry.data.traits, storyNotes: '' };
}
