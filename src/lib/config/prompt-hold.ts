/**
 * The request gates a prompt hold can sit on: the five story generations the chat fires by
 * hand. One declaration each of what the gate is called, what releasing it does and which
 * glyph it wears, so a gate reads identically in the settings card, in the review's head and
 * on the button that lets the request go.
 *
 * Background work (memory, sprites) is deliberately absent. It fires on its own schedule, so
 * holding it would build a queue of prompts nobody pressed anything to see. The Chungus
 * Assistant is out for a different reason: its turn runs server-side over a tool loop, not
 * over an assembled prompt this layer ever holds.
 *
 * Glyphs are SOURCED, not chosen: each is what its action already draws elsewhere (the
 * composer's send arrow, a turn's Retry, a turn's Continue, and the two engines' own registry
 * icons), so a row here reads the same as the control it stands in for. Send and Continue wear
 * the same forward arrow because the two controls do; the names beside them are what tell the
 * rows apart.
 */
import { engineById, type EngineDef } from '$lib/engines/registry';

/** An engine's glyph, or one of the two the non-engine gates wear. */
export type HoldGateIcon = EngineDef['icon'] | 'arrowRight' | 'refresh';

/** What every gate declares. The list below is the only place they are written down, and the
 *  two types under it are read back off it, so there is no second list to keep in step. */
interface HoldGateShape {
	id: string;
	/** The action being held, in the words it wears everywhere else. It is the settings row
	 *  and the review's own chip, so it names the press and never re-explains it. */
	name: string;
	/** What the review's confirm button does, in the words of the surface that asked. */
	confirm: string;
	icon: HoldGateIcon;
}

export const HOLD_GATES = [
	{
		id: 'send',
		name: 'Send',
		confirm: 'Send message',
		icon: 'arrowRight'
	},
	{
		// Both names, because the button says one on a reply and the other on a turn of the
		// reader's own, and a reader looking for either has to find this switch.
		id: 'regenerate',
		name: 'Retry / Regenerate',
		confirm: 'Regenerate',
		icon: 'refresh'
	},
	{
		id: 'continue',
		name: 'Continue',
		confirm: 'Continue',
		icon: 'arrowRight'
	},
	{
		id: 'spellcheck',
		name: engineById('spellcheck').name,
		confirm: 'Check the draft',
		icon: engineById('spellcheck').icon
	},
	{
		id: 'impersonate',
		name: engineById('impersonate').name,
		confirm: 'Ghostwrite',
		icon: engineById('impersonate').icon
	}
] as const satisfies readonly HoldGateShape[];

export type HoldGate = (typeof HOLD_GATES)[number]['id'];
export type HoldGateDef = (typeof HOLD_GATES)[number];

export function holdGateById(id: HoldGate): HoldGateDef {
	const def = HOLD_GATES.find((gate) => gate.id === id);
	if (!def) throw new Error(`Unknown prompt hold gate: ${id}`);
	return def;
}
