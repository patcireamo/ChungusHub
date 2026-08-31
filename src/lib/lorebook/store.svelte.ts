/**
 * Lorebook store: the client-side source of truth for standalone lorebooks.
 *
 * Holds every book reactively, mirrors edits straight onto the in-memory book, and debounces
 * the write-through to the server through the shared `DebouncedWriter` (keyed per book, so a
 * pending write for one book survives editing another). `flush()` forces those writes out
 * before navigation.
 */
import { db } from '$lib/services/database';
import { imageService } from '$lib/services/imageService';
import { DebouncedWriter } from '$lib/utils/debounced-write';
import type { PortraitFocus } from '$lib/utils/portrait-focus';
import type { Lorebook, LorebookEntry, LorebookLinks } from './types';
import {
	createEmptyLorebook,
	createEmptyLorebookEntry,
	resolveLinkedBooks,
	resolveLorebookLinks
} from './types';

class LorebookStore {
	private static readonly SAVE_DEBOUNCE_MS = 500;

	private _books = $state<Lorebook[]>([]);
	private _loading = $state(false);
	private _initialized = $state(false);
	private writer = new DebouncedWriter(LorebookStore.SAVE_DEBOUNCE_MS, (id) => this.writeBook(id));

	get books() { return this._books; }
	get loading() { return this._loading; }
	get initialized() { return this._initialized; }

	async load(): Promise<void> {
		if (this._initialized) return;
		this._loading = true;
		try {
			this._books = await db.getAllLorebooks();
			this._initialized = true;
		} finally {
			this._loading = false;
		}
	}

	async refresh(): Promise<void> {
		this._loading = true;
		try {
			// Commit pending debounced edits first: a sync-triggered reload must not silently
			// discard local keystrokes, and no leftover timer may re-save a refetched copy.
			await this.flush();
			const rows = await db.getAllLorebooks();
			// Typing carries on while the flush and the refetch are in flight, so a book
			// touched since can be newer than the row that comes back. The local copy wins,
			// or the reload rewinds an open entry under the caret; that copy's own write is
			// already scheduled, so the server still gets it.
			this._books = rows.map((row) => {
				const live = this.getBook(row.id);
				return live && live.updatedAt > row.updatedAt ? live : row;
			});
		} finally {
			this._loading = false;
		}
	}

	syncReload(): Promise<void> {
		return this.refresh();
	}

	getBook(id: string): Lorebook | null {
		return this._books.find((b) => b.id === id) ?? null;
	}

	/**
	 * What a chat plays with: the books switched into every chat, then what its cards link,
	 * then what the chat attached for itself. The live token meters and the real generation
	 * path (which resolves the same way, over a fresh server read) can never diverge, because
	 * both go through `resolveLorebookLinks`.
	 */
	booksForChat(links: LorebookLinks): Lorebook[] {
		return resolveLorebookLinks(this._books, links);
	}

	/**
	 * Which of these links still name a book. What a COUNT of an entry's links asks, and never
	 * `booksForChat`: that one answers with books nothing links, so a chip reading it would
	 * claim links the card has not made.
	 */
	resolveLinks(ids: string[] | undefined | null): Lorebook[] {
		return resolveLinkedBooks(this._books, ids);
	}

	async createBook(name = 'New Lorebook'): Promise<Lorebook> {
		const book = createEmptyLorebook(name);
		this._books = [book, ...this._books];
		await db.insertLorebook(book);
		return book;
	}

	/** Insert a fully-formed book (from import). */
	async addBook(book: Lorebook): Promise<void> {
		this._books = [book, ...this._books];
		await db.insertLorebook(book);
	}

	async deleteBook(id: string): Promise<void> {
		return this.deleteBooks([id]);
	}

	/** Every delete goes through here, one reassignment of the reactive list however many
	 *  books go: a per-book assignment turns a fifty-book selection into fifty re-renders
	 *  of the shelf that is showing them. */
	async deleteBooks(ids: string[]): Promise<void> {
		const gone = new Set(ids);
		for (const id of ids) this.writer.cancel(id);
		this._books = this._books.filter((b) => !gone.has(b.id));
		for (const id of ids) await db.deleteLorebook(id);
	}

	// ===== mutations (debounced write-through) =====

	private touch(book: Lorebook): void {
		book.updatedAt = Date.now();
		this._books = [...this._books];
		this.writer.schedule(book.id);
	}

	updateBookMeta(
		id: string,
		updates: Partial<
			Pick<
				Lorebook,
				'name' | 'scanDepth' | 'recursiveScanning' | 'maxRecursionSteps' | 'caseSensitive' | 'matchWholeWords'
			>
		>
	): void {
		const book = this.getBook(id);
		if (!book) return;
		Object.assign(book, updates);
		this.touch(book);
	}

	/**
	 * Put a cover on the book, or take it off with `null`. A discrete act, so it writes at
	 * once rather than sitting in the typing debounce, and the file it replaces goes only
	 * after the row naming the new one has landed.
	 *
	 * The framing is dropped either way: coordinates chosen for one picture mean nothing on
	 * the next, which is the rule the library's portraits follow (architecture/library.md).
	 */
	async setCover(id: string, file: File | null): Promise<void> {
		const book = this.getBook(id);
		if (!book) return;
		const previous = book.cover;
		const next = file ? await imageService.saveImage(file, 'lorebooks') : undefined;
		book.cover = next;
		book.coverFocus = undefined;
		await this.writeNow(book);
		if (previous && previous !== next) await imageService.deleteImage(previous);
	}

	/** Switch the book into every chat, or back out. A discrete act, so it writes at once, and
	 *  off stores as nothing: a book nobody switched on keeps the row it always had. */
	async setGlobal(id: string, on: boolean): Promise<void> {
		const book = this.getBook(id);
		if (!book) return;
		book.global = on || undefined;
		await this.writeNow(book);
	}

	/** Aim the cover. Discrete too, and the centred default stores as nothing. */
	async setCoverFocus(id: string, focus: PortraitFocus | null): Promise<void> {
		const book = this.getBook(id);
		if (!book) return;
		book.coverFocus = focus ?? undefined;
		await this.writeNow(book);
	}

	addEntry(bookId: string): LorebookEntry | null {
		const book = this.getBook(bookId);
		if (!book) return null;
		const entry = createEmptyLorebookEntry();
		book.entries = [...book.entries, entry];
		this.touch(book);
		return entry;
	}

	/** Insert a copy of an entry right after the original. Returns the copy. */
	duplicateEntry(bookId: string, entryId: string): LorebookEntry | null {
		const book = this.getBook(bookId);
		const source = book?.entries.find((e) => e.id === entryId);
		if (!book || !source) return null;
		// A deep snapshot, not a field-by-field spread: entries carry nested maps and arrays
		// (keyRules' rule objects, rest's preserved SillyTavern values), and a hand-kept copy
		// list silently starts sharing state the day a field is added without it.
		const copy: LorebookEntry = {
			...($state.snapshot(source) as LorebookEntry),
			id: crypto.randomUUID(),
			comment: source.comment ? `${source.comment} (copy)` : ''
		};
		const at = book.entries.findIndex((e) => e.id === entryId);
		book.entries = [...book.entries.slice(0, at + 1), copy, ...book.entries.slice(at + 1)];
		this.touch(book);
		return copy;
	}

	removeEntry(bookId: string, entryId: string): void {
		const book = this.getBook(bookId);
		if (!book) return;
		book.entries = book.entries.filter((e) => e.id !== entryId);
		this.touch(book);
	}

	updateEntry(bookId: string, entryId: string, updates: Partial<Omit<LorebookEntry, 'id'>>): void {
		const book = this.getBook(bookId);
		const entry = book?.entries.find((e) => e.id === entryId);
		if (!book || !entry) return;
		Object.assign(entry, updates);
		this.touch(book);
	}

	/** Send the whole book now and cancel its pending write: this call carries every field,
	 *  so a timer left standing would repeat the same row to every device a moment later. */
	private async writeNow(book: Lorebook): Promise<void> {
		this.writer.cancel(book.id);
		book.updatedAt = Date.now();
		this._books = [...this._books];
		await db.updateLorebook(book);
	}

	private async writeBook(bookId: string): Promise<void> {
		const book = this.getBook(bookId);
		if (!book) return;
		await db.updateLorebook(book);
	}

	/** Commit every pending save now. Call before leaving the lorebook view. */
	flush(): Promise<void> {
		return this.writer.flush();
	}
}

export const lorebookStore = new LorebookStore();
