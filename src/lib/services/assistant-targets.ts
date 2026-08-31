/**
 * Where the app takes you for something the assistant touched, or is about to.
 *
 * Two surfaces need identical routing and neither may own a private copy: the timeline's
 * settled rows (after the fact) and the approval card's pending rows (before it, which is the
 * moment that actually matters: a delete can only be looked at while it is still pending).
 * The timeline derives a target from a tool RESULT; the card is handed one by the capability's
 * own preview.
 */
import { tick } from 'svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import { viewport } from '$lib/stores/viewport.svelte';
import { lorebookStore } from '$lib/lorebook/store.svelte';
import { messageStore } from '$lib/stores/messages.svelte';
import { navigateTo } from '$lib/services/navigation';
import type { AssistantToolResult } from '$lib/services/transport';

/** Mirrors `ApprovalTarget` in server/assistant/types.ts. */
export type AssistantTarget = { kind: 'character' | 'persona' | 'message' | 'lorebook' | 'chat'; id: string };

// Single-id entity ops carry their entity `kind`, so results route by that. Explicit
// `navigate` results carry a full nav target and go through the shared service instead.
const ENTITY_NAV = new Set(['read_entity', 'create_entity', 'edit_entity', 'set_entity', 'edit_character_images', 'manage_entry_lorebooks', 'set_active_persona']);
const LOREBOOK_NAV = new Set(['create_lorebook_entry', 'edit_lorebook_entry']);

/** The place a settled tool row points at, or null when it points nowhere. */
export function targetOfToolResult(tool: AssistantToolResult): AssistantTarget | null {
	if (tool.error) return null;
	const id = typeof tool.id === 'string' ? tool.id : '';
	const kind = typeof tool.kind === 'string' ? tool.kind : '';
	if (ENTITY_NAV.has(tool.type) && id && (kind === 'character' || kind === 'persona' || kind === 'message')) {
		return { kind, id };
	}
	if (LOREBOOK_NAV.has(tool.type) && id) return { kind: 'lorebook', id };
	return null;
}

/** Reveal the chat and put this message on screen, switching branches if it sits off the
 *  one being read. Best effort: a message from another chat simply does not scroll. */
async function scrollToMessage(id: string): Promise<void> {
	if (uiStore.activeOverlay) uiStore.closeOverlay(() => lorebookStore.flush());
	await tick();
	await messageStore.revealMessage(id);
}

/**
 * Take the user to a target. Every destination renders BELOW the full-screen mobile widget,
 * so the panel is minimized first on phones or the tap looks dead; on desktop the widget
 * floats beside the app and stays where it is.
 */
export async function goToTarget(target: AssistantTarget): Promise<void> {
	if (uiStore.assistantOpen && viewport.isMobile) uiStore.closeAssistant();
	const flush = () => lorebookStore.flush();
	if (target.kind === 'message') return scrollToMessage(target.id);
	if (target.kind === 'character' || target.kind === 'persona') {
		uiStore.openLibraryEntry(target.id, target.kind, flush);
		return;
	}
	if (target.kind === 'lorebook') {
		// A BOOK id opens that book (the shelf consumes the one-shot and drops an id it
		// cannot resolve: some tool rows carry an entry id here, which leaves them on the
		// shelf rather than on an editor over nothing).
		uiStore.openLorebook(target.id, flush);
		return;
	}
	await navigateTo({ kind: 'chat', id: target.id, label: '' });
}
