/**
 * The composer's questions (an opening scene's direction, a rewrite's note), shared by their
 * doors and the box they turn. They live in the composer because a phone keeps only that box
 * above its keyboard (architecture/engines.md).
 */
import { shootStar } from '$lib/utils/shootingStar';
import { motionReduced } from '$lib/utils/motion';
import { viewport } from '$lib/stores/viewport.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

/** A rewrite is bound to the turn its reply answers, not to the reply, so every version of that
 *  reply shares one question and one note. */
export type ComposerQuestion = { kind: 'opening' } | { kind: 'rewrite'; parentId: string };

export interface ComposerQuestionHost {
	box: HTMLTextAreaElement;
	/** Where a star from a door lands. */
	landing: HTMLElement;
	/** Why the box cannot take a question right now, or null. */
	refusal: () => string | null;
}

function sameQuestion(a: ComposerQuestion, b: ComposerQuestion): boolean {
	if (a.kind === 'opening' || b.kind === 'opening') return a.kind === b.kind;
	return a.parentId === b.parentId;
}

class ComposerQuestionStore {
	question = $state<ComposerQuestion | null>(null);
	/** A star is on its way from a door; the question opens when it lands. */
	flying = $state(false);
	#host: ComposerQuestionHost | null = null;
	#flight = 0;

	asking(kind: ComposerQuestion['kind']): boolean {
		return this.question?.kind === kind;
	}

	attach(host: ComposerQuestionHost): () => void {
		this.#host = host;
		return () => {
			if (this.#host === host) this.#host = null;
		};
	}

	/** Turn the composer into the question, from the door that asked. */
	open(question: ComposerQuestion, door?: HTMLElement): void {
		const host = this.#host;
		if (!host || this.flying) return;
		const standing = this.question;
		if (standing && sameQuestion(standing, question)) {
			if (!viewport.isTouch) host.box.focus();
			return;
		}
		const refused = host.refusal();
		if (refused) {
			toastStore.info(refused);
			return;
		}
		// On touch the box turns at once and waits for a tap, so the keyboard never jumps up on its own.
		// A question already standing is swapped in place with no star: the box has already turned.
		const fly = !standing && door && !viewport.isTouch && !motionReduced();
		if (!fly) {
			this.question = question;
			if (!viewport.isTouch) host.box.focus();
			return;
		}
		this.flying = true;
		const flight = ++this.#flight;
		void shootStar(door, host.landing).finally(() => {
			this.flying = false;
			// A close in the air (a chat switch) cancels the landing, and so does the box going busy.
			if (flight !== this.#flight || this.#host !== host || host.refusal()) return;
			this.question = question;
			host.box.focus();
		});
	}

	close(): void {
		this.#flight++;
		this.question = null;
	}
}

export const composerQuestion = new ComposerQuestionStore();
