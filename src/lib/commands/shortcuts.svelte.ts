/**
 * Shortcuts: the app's actions reached by a key instead of by a control.
 *
 * The sibling of `registry.ts`, one list for the same reason: a binding is declared,
 * documented and matched in exactly one place. This file is the registry AND the matcher, so
 * `Workspace` asks it what a press means rather than spelling the keys a second time, and the
 * shortcuts sheet renders from it rather than a third. A key written in a keydown chain and
 * again in the sheet that documents it drifts silently in both directions at once: an
 * undocumented key, and a documented key that does nothing.
 *
 * Three rules, each load-bearing:
 *
 *  - **No shortcut implements behaviour.** Every `run` is one call into a store, exactly like
 *    a command's, so a key and the control it stands in for are the same call and not a
 *    second copy of it.
 *  - **A row without `run` is documentation.** Enter in the composer, the arrows on a turn and
 *    the layered Escape belong to whatever has focus; they are listed because the sheet is the
 *    one place a reader looks for a key, and they are matched nowhere.
 *  - **A `run` may decline**, by returning false, and the key then reaches the browser
 *    untouched. Find in chat leaves Ctrl+F alone while no chat is on screen.
 *
 * See architecture/ui-shell-settings.md, "Keyboard".
 */
import { chatCursor } from '$lib/stores/chatCursor.svelte';
import { chatSearch } from '$lib/stores/chatSearch.svelte';
import { chatStore } from '$lib/stores/chat.svelte';
import { lorebookStore } from '$lib/lorebook/store.svelte';
import { moveFocus } from '$lib/services/spatial-focus';
import { uiStore } from '$lib/stores/ui.svelte';
import type { Direction } from '$lib/utils/spatial-nav';

/**
 * The two surfaces the keyboard raises that belong to no panel: the sheet listing these keys,
 * and the hint labels drawn over the screen.
 *
 * Both flags live with the registry rather than inside the components that draw them, and for
 * one reason: those components read this list (the sheet renders it, the hint layer asks
 * `matchShortcut` what a press means), so a flag over there would leave this file importing
 * the very components that import it. Both stay deliberately outside uiStore's panel
 * choreography all the same, for the reason they always were: neither a glance at the keys nor
 * a look at the labels may disturb whichever panel is open.
 */
class KeyboardSurface {
	open = $state(false);

	toggle(): void {
		this.open = !this.open;
	}

	close(): void {
		this.open = false;
	}
}

export const shortcutsSheet = new KeyboardSurface();
export const hintMode = new KeyboardSurface();

export type ShortcutGroup = 'reach' | 'panels' | 'turns' | 'composer' | 'help';

/** Group order and headings in the sheet. Display only; nothing derives behaviour here. */
export const SHORTCUT_GROUPS: { id: ShortcutGroup; label: string }[] = [
	{ id: 'reach', label: 'Getting around' },
	{ id: 'panels', label: 'Panels' },
	{ id: 'turns', label: 'On a turn' },
	{ id: 'composer', label: 'In the composer' },
	{ id: 'help', label: 'Help' }
];

export interface ShortcutBinding {
	/** ⌘ on macOS, Ctrl everywhere else. The one platform difference, resolved at drawing time. */
	mod?: boolean;
	shift?: boolean;
	alt?: boolean;
	/**
	 * Matched against `KeyboardEvent.key`, case-insensitively: the letter MEANS something, so
	 * what matters is the character the reader typed. Several of them where a row is one action
	 * with several spellings; `run` is handed the one that was pressed, and the sheet draws them
	 * as one row rather than several saying nearly the same thing.
	 */
	key?: string | string[];
	/**
	 * Matched against `KeyboardEvent.code` instead, for a row whose keys are a SHAPE on the
	 * keyboard rather than letters that mean anything.
	 *
	 * Not a nicety: Option on macOS composes characters, so ⌥W arrives as `key: '∑'` and a row
	 * spelling itself `'w'` never fires at all. Position is also the truer reading of a cluster
	 * like WASD, which is a place under the hand and not four initials.
	 */
	code?: string | string[];
}

export interface ShortcutDef {
	id: string;
	group: ShortcutGroup;
	/** One line: what it does. The only copy the sheet shows. */
	label: string;
	/** What to press. The sheet draws its chips from this, so a key cannot be documented as
	 *  one thing and bound as another. Absent on a row the workspace does not match. */
	binding?: ShortcutBinding;
	/** Chips for a row with no binding of its own, where the key belongs to whatever has
	 *  focus. Exactly one of `binding` and `chips` is set; the sheet throws on a row carrying
	 *  neither rather than drawing a labelled blank. `'mod'` draws as ⌘/Ctrl: the platform's
	 *  spelling lives in the sheet, which this file cannot import without a cycle. */
	chips?: string[];
	/** One call into a store or a service, handed the key that was pressed. False declines it
	 *  and leaves the press to the browser. */
	run?: (key: string) => boolean | void;
}

/** Panel swaps flush pending lorebook edits, the same call every other navigation makes. */
const flush = () => lorebookStore.flush();

/** Which way each focus key points, by POSITION (see `ShortcutBinding.code`). Declared here
 *  beside the row that binds them: where the keys are is a keyboard fact, and the directions
 *  they stand for are not the service's to guess. */
const FOCUS_KEYS: Record<string, Direction> = {
	KeyW: 'up',
	KeyA: 'left',
	KeyS: 'down',
	KeyD: 'right'
};

/** A chat genuinely on screen, which is what the transcript's own keys need: the story map
 *  and the other overlays cover the column and carry their own search, and so does either
 *  centered editor, which is why the two ids are read here and not only `activeOverlay`.
 *  Without them Ctrl+F opens find in a chat nobody can see and takes the caret with it. */
const chatOnScreen = () =>
	Boolean(chatStore.activeChatId) &&
	!uiStore.activeOverlay &&
	!uiStore.libraryEditorId &&
	!uiStore.lorebookEditorId;

export const SHORTCUTS: ShortcutDef[] = [
	// ===== Getting around =====
	{
		id: 'chats',
		group: 'reach',
		label: 'Chats',
		binding: { mod: true, key: 'k' },
		run: () => uiStore.toggleOverlay('chats', flush)
	},
	{
		id: 'hints',
		group: 'reach',
		label: 'Label every control on screen',
		binding: { mod: true, shift: true, key: 'f' },
		run: () => hintMode.toggle()
	},
	{
		id: 'find',
		group: 'reach',
		label: 'Find in chat',
		// Takes the key off the browser's own find, which cannot tell a message from the
		// chrome around it, and only while there is a transcript to search.
		binding: { mod: true, key: 'f' },
		run: () => {
			if (!chatOnScreen()) return false;
			chatSearch.show();
		}
	},
	{
		id: 'transcript',
		group: 'reach',
		label: 'Step through the story',
		// Both ways, and a step every time rather than a door that only enters: the gesture a
		// reader reaches for is the modifier held and the arrow tapped, so a press that landed
		// back where it already was would read as the key being dead. By position like every
		// other ⌥ row, since that is the modifier which composes characters on macOS.
		binding: { alt: true, code: ['ArrowUp', 'ArrowDown'] },
		run: (pressed) => {
			if (!chatOnScreen()) return false;
			chatCursor.step(pressed === 'ArrowDown' ? 1 : -1);
		}
	},
	{
		id: 'move-focus',
		group: 'reach',
		label: 'Move the keyboard one control',
		// A modifier rather than the bare letters, and it is what keeps this out of a mode: the
		// composer holds the caret nearly all the time, so bare WASD would need a state to be
		// switched into and switched back out of at every text box on the screen. The arrows
		// are deliberately not an alias either: they belong to the control the keyboard is
		// already ON (a slider's value, a list's selection, the caret), which is exactly the
		// separation this row exists to keep. By position, since ⌥ composes characters on
		// macOS and this cluster is a place under the hand rather than four initials.
		binding: { alt: true, code: ['KeyW', 'KeyA', 'KeyS', 'KeyD'] },
		run: (pressed) => moveFocus(FOCUS_KEYS[pressed])
	},
	{
		id: 'escape',
		group: 'reach',
		label: 'Close the top surface, or go back to the composer',
		chips: ['Esc']
	},

	// ===== Panels =====
	{
		id: 'settings',
		group: 'panels',
		label: 'Settings',
		binding: { mod: true, key: ',' },
		run: () => uiStore.toggleSettings(flush)
	},
	{
		id: 'lorebook',
		group: 'panels',
		label: 'Library: Lorebooks',
		binding: { mod: true, key: 'b' },
		run: () => uiStore.toggleLorebooks(flush)
	},
	{
		id: 'library',
		group: 'panels',
		label: 'Library: Characters',
		binding: { mod: true, key: 'l' },
		run: () => {
			// Through setLibraryTab rather than a bare assignment: that is the one door that
			// lowers whichever centered editor the shelf being left had raised.
			uiStore.setLibraryTab('characters', flush);
			uiStore.toggleLibrary(flush);
		}
	},
	{
		id: 'personas',
		group: 'panels',
		label: 'Library: Personas',
		binding: { mod: true, shift: true, key: 'p' },
		run: () => {
			uiStore.setLibraryTab('personas', flush);
			uiStore.openLibrary(flush);
		}
	},
	{
		id: 'prompt-builder',
		group: 'panels',
		label: 'Prompt Builder',
		binding: { mod: true, shift: true, key: 'b' },
		run: () => {
			uiStore.gotoSettingsPage('prompt-builder');
			uiStore.openSettings(flush);
		}
	},
	{
		id: 'assistant',
		group: 'panels',
		label: 'Chungus Assistant',
		// The assistant's other door, and the ONLY one once its floating button is switched
		// off in Settings → General.
		binding: { mod: true, key: 'j' },
		run: () => uiStore.toggleAssistant()
	},
	{
		id: 'new-chat',
		group: 'panels',
		label: 'New chat',
		binding: { mod: true, key: 'n' },
		run: () => uiStore.startNewChat(flush)
	},

	// ===== On a turn =====
	// Every row here is owned by the focused turn itself (`Message.svelte`), which is what
	// lets them be bare letters: the keyboard is on a card, not in a box that takes text.
	{ id: 'turn-move', group: 'turns', label: 'Move between turns', chips: ['↑', '↓'] },
	{ id: 'turn-swipe', group: 'turns', label: "Swipe this turn's alternates", chips: ['←', '→'] },
	{ id: 'turn-edit', group: 'turns', label: 'Edit', chips: ['E'] },
	{ id: 'turn-branch', group: 'turns', label: 'Branch', chips: ['B'] },
	{ id: 'turn-regenerate', group: 'turns', label: 'Regenerate', chips: ['R'] },
	{ id: 'turn-copy', group: 'turns', label: 'Copy', chips: ['C'] },
	{ id: 'turn-delete', group: 'turns', label: 'Delete', chips: ['Del'] },

	// ===== In the composer =====
	{ id: 'send', group: 'composer', label: 'Send message', chips: ['Enter'] },
	{ id: 'newline', group: 'composer', label: 'New line', chips: ['Shift', 'Enter'] },
	// Owned by the composer rather than bound here: Enter belongs to whatever box has focus, so
	// a window-level match would also fire from the assistant's composer, a rename field or a
	// dialog. Living there is also what lets it read the menu row's own gate.
	{ id: 'regenerate-last', group: 'composer', label: 'Regenerate the newest reply', chips: ['mod', 'Enter'] },
	{ id: 'commands', group: 'composer', label: 'Commands (empty composer)', chips: ['/'] },
	{ id: 'history', group: 'composer', label: 'Input history (empty composer)', chips: ['↑', '↓'] },

	// ===== Help =====
	{
		id: 'shortcuts',
		group: 'help',
		label: 'Keyboard shortcuts (this sheet)',
		binding: { mod: true, key: '/' },
		run: () => shortcutsSheet.toggle()
	}
];

/** A row this file will actually match: it says what to press and what that does. */
export type BoundShortcut = ShortcutDef & {
	binding: ShortcutBinding;
	run: (pressed: string) => boolean | void;
};

/**
 * The shortcut a press means and which of its spellings answered, or null.
 *
 * Modifiers are compared exactly, never "at least": without that, Ctrl+Shift+F would also
 * answer to the Ctrl+F row and find in chat would open on top of the labels. The spelling is
 * handed back rather than left for the caller to work out, because a row bound by position
 * cannot read its own key off the event: on macOS ⌥W says `∑`.
 */
export function matchShortcut(
	event: KeyboardEvent
): { shortcut: BoundShortcut; pressed: string } | null {
	const mod = event.metaKey || event.ctrlKey;
	const key = event.key.toLowerCase();
	for (const shortcut of SHORTCUTS) {
		const binding = shortcut.binding;
		if (!binding || !shortcut.run) continue;
		if (mod !== Boolean(binding.mod)) continue;
		if (event.shiftKey !== Boolean(binding.shift)) continue;
		if (event.altKey !== Boolean(binding.alt)) continue;
		const pressed = spellingFor(binding, event, key);
		if (!pressed) continue;
		return { shortcut: shortcut as BoundShortcut, pressed };
	}
	return null;
}

/** Which spelling of a binding this press is, or null when it is none of them. */
function spellingFor(binding: ShortcutBinding, event: KeyboardEvent, key: string): string | null {
	if (binding.key !== undefined) {
		const keys = Array.isArray(binding.key) ? binding.key : [binding.key];
		return keys.find((bound) => bound.toLowerCase() === key) ?? null;
	}
	if (binding.code !== undefined) {
		const codes = Array.isArray(binding.code) ? binding.code : [binding.code];
		return codes.find((bound) => bound === event.code) ?? null;
	}
	// A binding naming neither is a row nothing can ever press, and a silent one at that.
	throw new Error('a shortcut binding declares neither key nor code');
}
