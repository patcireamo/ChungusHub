/**
 * The prompt hold: the gate a request passes through between being assembled and being sent.
 *
 * Armed, `review` parks the request and hands back whatever the reader approves, which is
 * then what goes on the wire, byte for byte. Disarmed, it hands the messages straight back in
 * the same tick, so a gate nobody armed costs the send nothing.
 *
 * **The caller must not have written anything yet.** Cancelling resolves to null, and every
 * call site's contract is that null leaves the chat exactly as the reader found it: no turn
 * inserted, no reply deleted, no stream opened. That is why the hold sits above the tree
 * mutations rather than beside the LLM call (architecture/chat-sessions.md).
 *
 * The pending request lives here and nowhere else, and it is per device: the prompt is
 * assembled in this browser and has not left it, unlike the assistant's approval card, whose
 * turn is already running on the server and so is broadcast to every page.
 *
 * Which gates are armed rides the settings sync spine, so a device agrees with the rest.
 */
import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';
import { HOLD_GATES, holdGateById, type HoldGate, type HoldGateDef } from '$lib/config/prompt-hold';
import type { CallTarget, LLMMessage } from '$lib/types/llm';

const SETTINGS_KEY = 'promptHold';

type GateSwitches = Record<HoldGate, boolean>;

/** Every gate off: a hold is something the reader turns on, never something they meet. */
function allOff(): GateSwitches {
	return Object.fromEntries(HOLD_GATES.map((gate) => [gate.id, false])) as GateSwitches;
}

function normalize(raw: Partial<GateSwitches> | null): GateSwitches {
	const gates = allOff();
	for (const gate of HOLD_GATES) {
		if (typeof raw?.[gate.id] === 'boolean') gates[gate.id] = raw[gate.id] as boolean;
	}
	return gates;
}

export interface PendingHold {
	/** New per hold: the review surface rebuilds its working copy on this identity alone. */
	id: string;
	gate: HoldGateDef;
	/** Whose connection serves this request. The review prices and names that model. */
	target: CallTarget;
	/** The request as assembled, never mutated: the review's Reset compares against it. */
	messages: LLMMessage[];
}

class PromptHoldStore {
	private gates = $state<GateSwitches>(allOff());
	pending = $state<PendingHold | null>(null);

	/** Resolves the promise `review` handed its caller. Cleared with the pending request. */
	private settle: ((messages: LLMMessage[] | null) => void) | null = null;

	/** A request is parked on the reader. Read by `warnIfBusy` so the app says which of the
	 *  two kinds of busy it is in. */
	get holding(): boolean {
		return this.pending !== null;
	}

	armed(gate: HoldGate): boolean {
		return this.gates[gate];
	}

	async initialize(): Promise<void> {
		this.gates = normalize(await readSetting<Partial<GateSwitches> | null>(SETTINGS_KEY, null));
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		this.gates = normalize(await readSetting<Partial<GateSwitches> | null>(SETTINGS_KEY, null));
	}

	setGate(gate: HoldGate, armed: boolean): void {
		this.gates[gate] = armed;
		writeSetting(SETTINGS_KEY, this.gates);
	}

	/**
	 * Put an assembled request through this gate. Resolves to the messages to send (the
	 * reader's, edits and all) or to null when they cancelled it.
	 */
	async review(gate: HoldGate, messages: LLMMessage[], target: CallTarget): Promise<LLMMessage[] | null> {
		if (!this.gates[gate]) return messages;
		// One request at a time by construction: every gate's caller is already behind a
		// busy guard, and the review is modal. Two would leave the first one's promise
		// with nothing left to resolve it.
		if (this.pending) throw new Error('A prompt is already waiting for review.');
		return new Promise<LLMMessage[] | null>((resolve) => {
			this.settle = resolve;
			this.pending = { id: crypto.randomUUID(), gate: holdGateById(gate), target, messages };
		});
	}

	/** Let the request go, carrying exactly what the reader approved. */
	approve(messages: LLMMessage[]): void {
		this.close(messages);
	}

	/** Drop the request. The caller writes nothing and the reader keeps their draft. */
	cancel(): void {
		this.close(null);
	}

	private close(result: LLMMessage[] | null): void {
		const settle = this.settle;
		this.settle = null;
		this.pending = null;
		settle?.(result);
	}
}

export const promptHoldStore = new PromptHoldStore();
