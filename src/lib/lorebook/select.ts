/**
 * Picking a selection of entries: stretching one press across the rows between it and the one
 * pressed before it.
 *
 * Pure, and tested in select.test.ts.
 */

/**
 * The selection after a press that stretches from the last row pressed: every row between the
 * two, both ends included, takes the state the pressed row takes, the way a checklist's
 * Shift-click works. Read in the order the list shows its rows, since that is the stretch the
 * reader sees, and a last row no longer on screen leaves the press an ordinary toggle.
 */
export function extendSelection(
	shown: readonly string[],
	selected: ReadonlySet<string>,
	anchor: string | null,
	target: string
): Set<string> {
	const on = !selected.has(target);
	const from = anchor === null ? -1 : shown.indexOf(anchor);
	const to = shown.indexOf(target);
	const stretch =
		from < 0 || to < 0 ? [target] : shown.slice(Math.min(from, to), Math.max(from, to) + 1);
	const next = new Set(selected);
	for (const id of stretch) {
		if (on) next.add(id);
		else next.delete(id);
	}
	return next;
}
