/**
 * The composer's opening scene mode, shared by its doors in the transcript and the box they turn.
 * It lives in the composer because a phone keeps only that box above its keyboard (architecture/engines.md).
 */
import { shootStar } from '$lib/utils/shootingStar';
import { motionReduced } from '$lib/utils/motion';
import { viewport } from '$lib/stores/viewport.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

export interface OpeningComposerHost {
	box: HTMLTextAreaElement;
	/** Where a star from a door lands. */
	landing: HTMLElement;
	/** Why the box cannot take the question right now, or null. */
	refusal: () => string | null;
}

class OpeningComposerStore {
	active = $state(false);
	/** A star is on its way from a door; the mode opens when it lands. */
	flying = $state(false);
	#host: OpeningComposerHost | null = null;
	#flight = 0;

	attach(host: OpeningComposerHost): () => void {
		this.#host = host;
		return () => {
			if (this.#host === host) this.#host = null;
		};
	}

	/** Turn the composer into the question, from the door that asked. */
	open(door?: HTMLElement): void {
		const host = this.#host;
		if (!host || this.active || this.flying) return;
		const refused = host.refusal();
		if (refused) {
			toastStore.info(refused);
			return;
		}
		// On touch the box turns at once and waits for a tap, so the keyboard never jumps up on its own.
		const fly = door && !viewport.isTouch && !motionReduced();
		if (!fly) {
			this.active = true;
			if (!viewport.isTouch) host.box.focus();
			return;
		}
		this.flying = true;
		const flight = ++this.#flight;
		void shootStar(door, host.landing).finally(() => {
			this.flying = false;
			// A close in the air (a chat switch) cancels the landing, and so does the box going busy.
			if (flight !== this.#flight || this.#host !== host || host.refusal()) return;
			this.active = true;
			host.box.focus();
		});
	}

	close(): void {
		this.#flight++;
		this.active = false;
	}
}

export const openingComposer = new OpeningComposerStore();
