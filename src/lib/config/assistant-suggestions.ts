/**
 * The tappable prompts on the assistant's empty screen.
 *
 * The panel draws them and Assistant Settings edits them, so the shipped set, the key they
 * are stored under and the rule for reading a stored value all live here: the two surfaces
 * can never disagree about what the defaults are, the reason $lib/config/assistant-approval
 * exists.
 *
 * A suggestion only fills the composer. It reaches no prompt and no tool list, so it is not
 * part of a session's frozen settings and changing one costs an open tab nothing.
 */

/** Global settings row, a JSON array of strings. Absent means nothing has been customized. */
export const SUGGESTED_PROMPTS_SETTING = 'assistantSuggestedPrompts';

/** How many the empty screen shows before Show more. */
export const SUGGESTED_PROMPTS_COLLAPSED = 4;

/** One suggestion is one composer line, and the button carrying it has to stay readable. */
export const SUGGESTED_PROMPT_MAX_LENGTH = 200;

/** The empty screen owes an agent with this much reach more than one sentence of
 *  self-explanation, so each of these points at a different corner of the workspace. */
export const DEFAULT_SUGGESTED_PROMPTS: readonly string[] = [
	"Clean up this character's card, fix the formatting but keep the voice",
	'Summarize what has happened in this chat so far',
	'Turn the recent events of this chat into lorebook entries',
	'Attribute the unassigned "You" messages to my persona'
];

/**
 * A stored list read back. An empty array is a real answer (every suggestion was deleted)
 * and stays empty; only a missing or unusable row falls back to the shipped set.
 */
export function readSuggestedPrompts(stored: unknown): string[] {
	if (!Array.isArray(stored)) return [...DEFAULT_SUGGESTED_PROMPTS];
	return stored
		.filter((p): p is string => typeof p === 'string')
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}
