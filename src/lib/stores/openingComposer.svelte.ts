/**
 * The composer's opening scene mode: the box asks for a scene's direction instead of holding
 * a message. The doors (a root turn's sparkle, the empty chat's button) sit in the transcript
 * and the box does not, so this is the one thing they share.
 *
 * The question lives in the composer because a phone keeps that box above its keyboard and
 * keeps nothing else there: a field inside the transcript's scroller ends up under the
 * keyboard, with no scroll left to bring it back. See architecture/engines.md, Opening Scene.
 */
import { shootStar } from '$lib/utils/shootingStar';
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
		// The flight bridges the distance between a door and the box on a pointer screen; on touch
		// the box turns at once and waits for a tap, so the keyboard never jumps up on its own.
		const still =
			document.documentElement.dataset.motion === 'reduced' ||
			matchMedia('(prefers-reduced-motion: reduce)').matches;
		const fly = door && !viewport.isTouch && !still;
		if (!fly) {
			this.active = true;
			if (!viewport.isTouch) host.box.focus();
			return;
		}
		this.flying = true;
		void shootStar(door, host.landing).finally(() => {
			this.flying = false;
			// The composer may have gone busy or been refused while the star was in the air.
			if (this.#host !== host || host.refusal()) return;
			this.active = true;
			host.box.focus();
		});
	}

	close(): void {
		this.active = false;
	}
}

export const openingComposer = new OpeningComposerStore();
