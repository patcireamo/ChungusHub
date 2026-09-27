/**
 * Who decides how hard a destructive act is to fire (the destructive-act ladder,
 * architecture/ui-shell-settings.md). One rung is in force at a time and every asking
 * surface in the app reads it from here rather than deciding for itself.
 *
 * Two ways to leave the default, and the shapes are deliberately different. A **window**
 * lowers the rung for a stretch of this session and then puts it back on its own: it is
 * runtime state, never written anywhere, so it cannot survive a reload and cannot reach
 * another device. That is the whole point. A cleanup pass is a thing you are doing right
 * now on the screen in front of you, and a lowered guard that outlives it, on hardware you
 * are not even holding, is the failure this shape exists to prevent. A **kept** rung is the
 * other choice, an ordinary setting, and it stays until it is changed back.
 *
 * Deletion is final everywhere in this app: there is no undo channel, by decision. So a
 * lowered rung is a standing condition and says so on screen through `layout/DeleteGuardBar`
 * for as long as it holds. That row can be dismissed, and dismissal is scoped to the one
 * activation that raised it (`activation` below), which is what makes it "stop telling me
 * about this window" rather than "never mention this again".
 */
import { advancedSettingsStore, type DeleteConfirmRung } from './advanced-settings.svelte';
import { onReachabilityChange } from '$lib/services/transport';

/** How long a temporary drop can run. Offered instead of a free-form duration because the
 *  question being answered is "how long is this cleanup", not "how many minutes". */
export const WINDOW_CHOICES: readonly { ms: number; label: string }[] = [
	{ ms: 10 * 60_000, label: '10 minutes' },
	{ ms: 60 * 60_000, label: '1 hour' }
];

/** The window the in-dialog offer arms, so the copy there and the choice above agree. */
export const QUICK_WINDOW_MS = WINDOW_CHOICES[0].ms;

class DeleteGuardStore {
	private win = $state<{ rung: DeleteConfirmRung; endsAt: number; ms: number } | null>(null);
	private now = $state(0);
	private ticker: ReturnType<typeof setInterval> | null = null;
	private dismissedFor = $state<string | null>(null);

	/** A window past its end is over whether or not a tick has noticed yet. Background tabs
	 *  throttle timers to minutes, so the clock has to be part of the decision and not only
	 *  part of the cleanup, or a foregrounded tab spends its first second still unlocked. */
	private live = $derived(this.win !== null && this.now < this.win.endsAt);

	/** The rung in force right now. A live window wins over the kept setting. */
	rung: DeleteConfirmRung = $derived(
		this.live && this.win ? this.win.rung : advancedSettingsStore.deleteConfirm
	);

	/** Does a destructive act get an asking surface at all? */
	asks = $derived(this.rung !== 'off');

	/** Does that surface make the heavy case a press-and-hold? */
	holds = $derived(this.rung === 'hold');

	/** Which gesture pays for the heavy rung. A kept preference, never lowered by a window. */
	gesture = $derived(advancedSettingsStore.confirmGesture);

	/** Milliseconds left, for the standing row's countdown. Zero while no window runs. */
	remaining = $derived(this.live && this.win ? Math.max(0, this.win.endsAt - this.now) : 0);

	/** True while the drop is temporary, which is what the row's wording turns on. */
	timed = $derived(this.live);

	/** The length that was chosen, so the settings row can show which one is running. */
	windowMs = $derived(this.live && this.win ? this.win.ms : 0);

	/** One activation of a lowered rung. The standing row is dismissed against this string,
	 *  so changing the rung, opening a window or extending one all re-raise the row without
	 *  anything having to remember to reset a flag. */
	private activation = $derived(`${this.rung}@${this.live && this.win ? this.win.endsAt : 'kept'}`);

	barOpen = $derived(this.rung !== 'hold' && this.dismissedFor !== this.activation);

	initialize(): void {
		onReachabilityChange((reachable) => {
			// An outage ends a window. Every write fails while the server is gone, so the
			// minutes would burn down in an app that cannot delete anything anyway, and the
			// reader would come back to a guard they think is still lowered. The kept rung is
			// a setting and is deliberately left alone.
			if (!reachable) this.closeWindow();
		});
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', () => {
				if (!document.hidden) this.tick();
			});
		}
	}

	/** Lower the rung for a fixed stretch of this session. */
	openWindow(rung: DeleteConfirmRung, ms: number): void {
		this.win = { rung, endsAt: Date.now() + ms, ms };
		this.tick();
		if (!this.ticker) this.ticker = setInterval(() => this.tick(), 1000);
	}

	closeWindow(): void {
		this.win = null;
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = null;
		}
	}

	/** Set the rung that survives a reload. Any window in flight goes with it, so the two
	 *  can never disagree about what is in force. */
	keep(rung: DeleteConfirmRung): void {
		this.closeWindow();
		advancedSettingsStore.setDeleteConfirm(rung);
	}

	/** Back to asking and holding, from wherever the reader is standing. */
	restore(): void {
		this.keep('hold');
	}

	dismissBar(): void {
		this.dismissedFor = this.activation;
	}

	private tick(): void {
		this.now = Date.now();
		if (this.win && this.now >= this.win.endsAt) this.closeWindow();
	}
}

export const deleteGuard = new DeleteGuardStore();
