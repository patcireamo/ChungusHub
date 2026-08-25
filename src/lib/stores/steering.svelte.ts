/**
 * Steering store: the client-side source of truth for steering notes.
 *
 * Notes are first-class rows (`steering_notes`), so this store is the lorebook store's
 * sibling: hold every note reactively, write through to the server, and `flush()`
 * pending keystrokes before anything builds a prompt. What it deliberately does NOT
 * own is resolution: which notes apply to a chat and what placement they inherit
 * lives in the pure `types/steering.ts`, because the generation path resolves the same
 * question against fresh db rows and the two must agree exactly.
 */
import { db } from '$lib/services/database';
import { DebouncedWriter } from '$lib/utils/debounced-write';
import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
import {
	activeSteeringNotes,
	createSteeringNote,
	resolveSteeringForPrompt,
	scopedSteeringNotes,
	type ResolvedSteeringNote,
	type SteeringMode,
	type SteeringNote,
	type SteeringRole,
	type SteeringScope,
	type SteeringTarget
} from '$lib/types/steering';

/** Text typing debounce: collapse keystrokes into one write, but keep the window short
 *  enough that a build can never read a stale note. */
const SAVE_DEBOUNCE_MS = 400;

class SteeringStore {
	private _notes = $state<SteeringNote[]>([]);
	private _initialized = $state(false);
	private writer = new DebouncedWriter(SAVE_DEBOUNCE_MS, (id) => this.writeNote(id));

	get notes(): SteeringNote[] {
		return this._notes;
	}

	get initialized(): boolean {
		return this._initialized;
	}

	async load(): Promise<void> {
		if (this._initialized) return;
		this._notes = await db.getAllSteeringNotes();
		this._initialized = true;
	}

	async refresh(): Promise<void> {
		// Commit local keystrokes first: a sync-triggered reload must not discard them,
		// and no leftover timer may re-save a note over the refetched copy.
		await this.flush();
		this._notes = await db.getAllSteeringNotes();
	}

	syncReload(): Promise<void> {
		return this.refresh();
	}

	getNote(id: string): SteeringNote | null {
		return this._notes.find((n) => n.id === id) ?? null;
	}

	// ===== reads (all through the pure resolvers) =====

	/** The app-wide placement notes inherit, set in Settings → Engines → Steering. */
	private get defaults() {
		return featurePromptsStore.steeringDefaults;
	}

	/** Every note that will inject into this target's next prompt, in injection order. */
	activeFor(target: SteeringTarget): SteeringNote[] {
		return activeSteeringNotes(this._notes, target);
	}

	/** Notes bound to a target regardless of `enabled`/blankness: what the note lists
	 *  render, so a rule you switched off stays visible instead of vanishing. */
	scopedFor(target: SteeringTarget): SteeringNote[] {
		return scopedSteeringNotes(this._notes, target);
	}

	/** The chat meter's AssembleInput.steering. Must stay identical to what
	 *  prompt-builder resolves on the generation side (prompt-pipeline coupling 8). */
	resolveForPrompt(target: SteeringTarget): ResolvedSteeringNote[] {
		return resolveSteeringForPrompt(this._notes, target, this.defaults);
	}

	// ===== mutations =====

	/** Create a note and persist it immediately. Returns it so a caller can open its editor. */
	async create(fields: {
		text: string;
		scope: SteeringScope;
		scopeId: string | null;
		title?: string;
		mode?: SteeringMode;
		depth?: number | null;
		role?: SteeringRole | null;
	}): Promise<SteeringNote> {
		const note = createSteeringNote(fields);
		this._notes = [...this._notes, note];
		await db.insertSteeringNote(note);
		return note;
	}

	/** Apply a discrete change (a toggle, a scope re-bind, a placement pick) and write it
	 *  through at once: a click must not sit in a debounce window. Text and title typing
	 *  goes through `scheduleEdit` instead. */
	async update(
		id: string,
		patch: Partial<Pick<SteeringNote, 'title' | 'text' | 'scope' | 'scopeId' | 'enabled' | 'mode' | 'depth' | 'role'>>
	): Promise<void> {
		const note = this.getNote(id);
		if (!note) return;
		this.writer.cancel(id);
		Object.assign(note, patch, { updatedAt: Date.now() });
		this._notes = [...this._notes];
		await db.updateSteeringNote(note);
	}

	async remove(id: string): Promise<void> {
		this.writer.cancel(id);
		this._notes = this._notes.filter((n) => n.id !== id);
		await db.deleteSteeringNote(id);
	}

	/** Debounced edit for the note editor's text/title fields. The in-memory note updates
	 *  at once (so the meter reprices as you type); only the write is deferred. */
	scheduleEdit(id: string, patch: Partial<Pick<SteeringNote, 'title' | 'text'>>): void {
		const note = this.getNote(id);
		if (!note) return;
		Object.assign(note, patch, { updatedAt: Date.now() });
		this._notes = [...this._notes];
		this.writer.schedule(id);
	}

	private async writeNote(id: string): Promise<void> {
		const note = this.getNote(id);
		if (!note) return;
		await db.updateSteeringNote(note);
	}

	/** Commit every pending write NOW and wait for it. Prompt building calls this before
	 *  reading the db, so a note typed inside the debounce window can never miss its own
	 *  send. */
	flush(): Promise<void> {
		return this.writer.flush();
	}

	/**
	 * Consume named one-shot notes after a persisted success, answering the ids actually
	 * spent so the caller can record only those in the chat's reuse history.
	 *
	 * By id, and never by re-resolving the scope, because the generation that is spending
	 * them finished some time ago: a note added while it ran never rode its prompt, and one
	 * edited to permanent meanwhile is no longer the reader's to throw away. Both are left
	 * standing, which is why an id absent from the answer is not an error. Called ONLY after
	 * a persisted success: an abort or an error must leave a one-shot armed for the retry.
	 */
	async consumeById(ids: string[]): Promise<Set<string>> {
		const spent = this.notes.filter((n) => ids.includes(n.id) && n.mode === 'once');
		await Promise.all(spent.map((n) => this.remove(n.id)));
		return new Set(spent.map((n) => n.id));
	}
}

export const steeringStore = new SteeringStore();
