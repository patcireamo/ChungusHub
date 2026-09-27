/**
 * How the heavy rung of the destructive-act ladder is performed (architecture/ui-shell-settings.md).
 * `ui/HoldToConfirmButton` decides WHETHER a confirm is heavy (its `holdMs`); this file decides
 * what paying for it looks like under the press-twice gesture, as plain functions so it can be
 * tested without compiling a rune.
 *
 * A press and hold is the default. Pressing twice exists for devices where holding is not a
 * gesture the page ever sees: a pen or a touchscreen that turns a long press into a right click
 * cancels the hold before it can finish, which leaves the delete unreachable rather than slow.
 */

/** How the heavy rung is performed. */
export type ConfirmGesture = 'hold' | 'twice';

export const CONFIRM_GESTURES: readonly ConfirmGesture[] = ['hold', 'twice'];

/** How long a first press stays armed before the button lets go of it. */
export const TWICE_ARM_MS = 3000;

/** A second press sooner than this after the first is the same press bouncing, or a
 *  double-click, and is not a confirmation. It is what keeps muscle memory from firing the
 *  heavy rung in one motion, the job the hold does in the other gesture. */
export const TWICE_GUARD_MS = 300;

/**
 * What a press does under the press-twice gesture. `armedAt` is when the first press landed,
 * or null when the button is not armed.
 */
export function twiceStep(armedAt: number | null, now: number): 'arm' | 'ignore' | 'confirm' {
	if (armedAt === null || now - armedAt >= TWICE_ARM_MS) return 'arm';
	if (now - armedAt < TWICE_GUARD_MS) return 'ignore';
	return 'confirm';
}
