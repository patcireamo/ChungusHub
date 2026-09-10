/**
 * Steering notes: the Steering engine's domain model (architecture/engines.md).
 *
 * A note is guidance text that rides the story prompt without ever becoming a chat
 * message. What makes it more than a textarea is `scope`: one note applies app-wide,
 * to one character, to one character *version*, or to a single chat, and several
 * notes stack on one reply. The scope is data ON the row, which is the only reason
 * four scopes cost the same as one.
 *
 * Everything here is pure and import-free by design: the generation path (reading
 * rows straight from the db) and the client store's reactive path resolve through the
 * exact same functions, so the token meter can never disagree with what is sent.
 */

/** Where a note applies. Ordered broad → narrow; see SCOPE_RANK. */
export type SteeringScope = 'global' | 'character' | 'version' | 'chat';

/** The prompt role a note is injected as. */
export type SteeringRole = 'system' | 'user' | 'assistant';

/** 'once' is consumed by the next successful primary generation (the note deletes
 *  itself and its text lands in the chat's reuse history); 'pinned' keeps injecting
 *  until the note is disabled or deleted. */
export type SteeringMode = 'once' | 'pinned';

export interface SteeringNote {
	id: string;
	/** Short label for the note lists. Blank = derive one from `text` (see noteLabel). */
	title: string;
	text: string;
	scope: SteeringScope;
	/** null for 'global'; otherwise the character / character-version / chat id this
	 *  note is bound to. A dangling id makes the note inert, never an error. It is the
	 *  same doctrine as a dangling lorebook link (architecture/lorebook.md). */
	scopeId: string | null;
	enabled: boolean;
	mode: SteeringMode;
	/** Placement overrides, `null` = inherit the app-wide default (Settings → Engines →
	 *  Steering). The entry→book→global tri-state idiom from architecture/lorebook.md. */
	depth: number | null;
	role: SteeringRole | null;
	createdAt: number;
	updatedAt: number;
}

/** The app-wide placement every note inherits until it overrides one of these. */
export interface SteeringDefaults {
	depth: number;
	role: SteeringRole;
}

/** What a note's scope is matched against: the chat a prompt is being built for. A
 *  null field can never match: no chat open means only global notes apply. */
export interface SteeringTarget {
	chatId: string | null;
	characterId: string | null;
	characterVersionId: string | null;
}

/** The target a chat row represents. One helper so the generation path, the chat meter,
 *  the composer readout and the manager can't spell the same three fields differently:
 *  a mismatch there is a note that injects on one surface and not the other. Null chat
 *  (the welcome landing, a chatless meter) resolves to the global-only target. */
export function steeringTargetForChat(
	chat: { id: string; characterId: string | null; characterVersionId: string | null } | null | undefined
): SteeringTarget {
	return {
		chatId: chat?.id ?? null,
		characterId: chat?.characterId ?? null,
		characterVersionId: chat?.characterVersionId ?? null
	};
}

/** A note with its inheritance resolved, ready for prompt assembly. */
export interface ResolvedSteeringNote {
	text: string;
	depth: number;
	role: SteeringRole;
}

export const STEERING_SCOPES: readonly SteeringScope[] = ['global', 'character', 'version', 'chat'];

export const STEERING_ROLES: readonly SteeringRole[] = ['system', 'user', 'assistant'];

/** Injection order: broad first, so the most specific guidance sits closest to the
 *  reply. Also the grouping order of every note list in the UI. */
const SCOPE_RANK: Record<SteeringScope, number> = {
	global: 0,
	character: 1,
	version: 2,
	chat: 3
};

export const MAX_STEERING_DEPTH = 100;

export function clampSteeringDepth(raw: number): number {
	if (!Number.isFinite(raw)) return 0;
	return Math.min(MAX_STEERING_DEPTH, Math.max(0, Math.round(raw)));
}

/** The single factory for a well-formed note. Rows are taken from the db as-is (the
 *  lorebook precedent: no load-time normalization), so every write starts here. */
export function createSteeringNote(fields: {
	text: string;
	scope: SteeringScope;
	scopeId: string | null;
	title?: string;
	mode?: SteeringMode;
	enabled?: boolean;
	depth?: number | null;
	role?: SteeringRole | null;
}): SteeringNote {
	const now = Date.now();
	return {
		id: crypto.randomUUID(),
		title: fields.title ?? '',
		text: fields.text,
		scope: fields.scope,
		scopeId: fields.scopeId,
		enabled: fields.enabled ?? true,
		mode: fields.mode ?? 'pinned',
		depth: fields.depth ?? null,
		role: fields.role ?? null,
		createdAt: now,
		updatedAt: now
	};
}

/** The list label: the given title, else the note's own first line, trimmed to fit. */
export function noteLabel(note: SteeringNote): string {
	const title = note.title.trim();
	if (title) return title;
	const firstLine = note.text.trim().split('\n', 1)[0].trim();
	if (!firstLine) return 'Empty steering';
	return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

/** Whether a note's binding matches the chat a prompt is being built for. Scope-only:
 *  says nothing about `enabled` or blank text (see activeSteeringNotes). */
export function noteApplies(note: SteeringNote, target: SteeringTarget): boolean {
	switch (note.scope) {
		case 'global':
			return true;
		case 'character':
			return target.characterId !== null && note.scopeId === target.characterId;
		case 'version':
			return target.characterVersionId !== null && note.scopeId === target.characterVersionId;
		case 'chat':
			return target.chatId !== null && note.scopeId === target.chatId;
	}
}

/** Sort a note list into injection order: scope broad → narrow, then oldest first so
 *  the stack a user built up keeps a stable, explainable order. */
export function sortSteeringNotes(notes: SteeringNote[]): SteeringNote[] {
	return [...notes].sort(
		(a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || a.createdAt - b.createdAt
	);
}

/** Every note that will actually inject into this target's next prompt, in injection
 *  order. The ONE definition of "active", shared by the generation path, the token
 *  meter and the composer's readout. */
export function activeSteeringNotes(notes: SteeringNote[], target: SteeringTarget): SteeringNote[] {
	return sortSteeringNotes(notes.filter((n) => n.enabled && n.text.trim() && noteApplies(n, target)));
}

/** Every note BOUND to this target, injecting or not: what the note lists render, so a
 *  rule you switched off stays on screen instead of vanishing the moment it stops
 *  mattering. `activeSteeringNotes` is the subset that actually injects. */
export function scopedSteeringNotes(notes: SteeringNote[], target: SteeringTarget): SteeringNote[] {
	return sortSteeringNotes(notes.filter((n) => noteApplies(n, target)));
}

/** Fill a note's inherited placement from the app-wide defaults. */
export function resolvePlacement(note: SteeringNote, defaults: SteeringDefaults): { depth: number; role: SteeringRole } {
	return {
		depth: note.depth === null ? defaults.depth : clampSteeringDepth(note.depth),
		role: note.role ?? defaults.role
	};
}

/** The prompt-assembly input for a target: active notes with inheritance resolved.
 *  Both AssembleInput sites (generation + chat meter) must build their list through
 *  here, or the meter starts pricing something else than the send injects. */
export function resolveSteeringForPrompt(
	notes: SteeringNote[],
	target: SteeringTarget,
	defaults: SteeringDefaults
): ResolvedSteeringNote[] {
	return activeSteeringNotes(notes, target).map((note) => ({
		text: note.text,
		...resolvePlacement(note, defaults)
	}));
}

/** The text a lorebook entry reads when it opts into the Steering scan source: every note
 *  that will actually inject, joined, and NOTHING else. Deliberately not the wrapper: that
 *  is preset furniture the same on every turn, so a word in it would wake its entries on
 *  every reply and never say why. Takes resolved notes so all three context builders feed
 *  the scan exactly what they feed assembly (architecture/lorebook.md coupling #6). */
export function steeringScanText(notes: readonly ResolvedSteeringNote[] | undefined): string {
	if (!notes?.length) return '';
	return notes
		.map((n) => n.text.trim())
		.filter((t) => t.length > 0)
		.join('\n');
}
