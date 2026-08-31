/** Domain types for chat and messages */

import type { LorebookTrace } from '$lib/lorebook/types';
import type { AmbientConfig } from '$lib/types/ambient';
import { normalizeAmbientConfig } from '$lib/types/ambient';
import type { BackgroundConfig } from '$lib/types/background';
import { normalizeBackgroundConfig } from '$lib/types/background';

export interface Chat {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	rootMessageId: string | null;
	activeLeafId: string | null;
	/** The tip of the canonical timeline: the single branch the author has blessed as
	 *  "the real story". Null until one is marked. The story map draws root→here as the
	 *  gold spine; independent of activeLeafId (where you currently are). */
	canonLeafId: string | null;
	settings: ChatSettings | null;
	/** The library character this chat is bound to (ST-style: one chat, one character). */
	characterId: string | null;
	/** The character version this chat plays against: the ONLY input to which variant
	 *  every request from this chat uses, whatever the library's active version happens
	 *  to be. Per-chat and durable: switching is an explicit, reversible act made from
	 *  the composer's setup chip. Null = follow the entry's live data (unversioned
	 *  characters and legacy chats). */
	characterVersionId: string | null;
	/** Starred in the chats panel, which floats favorites into their own section above
	 *  the time groups. Same meaning as a library entry's favorite flag. */
	isFavorite: boolean;
	/** Steering + impersonate state, as an opaque JSON string (or null). The server
	 *  never parses this column (see server/db.ts mapChat), so it round-trips exactly
	 *  as written. Always go through `normalizeChatFeatureState` to read it; never
	 *  inspect the string directly. */
	featureState: string | null;
}

/** Everything the chats panel shows about a chat that isn't on the chat row itself,
 *  aggregated server-side so no message text crosses the wire (see
 *  server/db.ts `getChatListStats`). `path` is the branch a reader would actually
 *  read; `total` counts every row in the tree, swipes and dead forks included;
 *  `lastAt` is when that branch was last written to. */
export interface ChatListStats {
	path: number;
	total: number;
	lastAt: number | null;
}

/** A chat's memory weight, asked for before a duplicate offers to carry it along. */
export interface ChatMemoryFootprint {
	enabled: boolean;
	episodes: number;
}

/**
 * Whether duplicating this chat has a question to ask at all.
 *
 * A chat with no memory in any form is copied on the spot; anything else raises the dialog.
 * Both doors that duplicate (the Chats panel's row and the composer's `/duplicate`) read
 * this, because two spellings of the same rule end with one door asking and the other
 * quietly deciding for the user.
 */
export function duplicateAsksAboutMemory(footprint: ChatMemoryFootprint): boolean {
	return footprint.enabled || footprint.episodes > 0;
}

/** A user-given name + color for a branch, anchored on the message that heads it.
 *  `color` is a palette key (see branch-labels.ts), not a raw CSS color, so it stays
 *  theme-independent. */
export interface BranchLabel {
	name: string;
	color: string;
}

export interface ChatSettings {
	model?: string;
	systemPrompt?: string;
	temperature?: number;
	maxTokens?: number;
}

/** Grammatical person the Impersonate feature writes the user's turn in. */
export type ImpersonatePerspective = 'first' | 'second' | 'third';

/**
 * A chat's own background and ambient mix: a whole scene rather than a patch over the
 * app's, so nothing has to say which half of it is inherited.
 *
 * `enabled` false keeps the scene the reader built while the app's is back in force, so
 * the Scene switch is a switch and not a way to lose an afternoon's tuning.
 */
export interface ChatScene {
	enabled: boolean;
	background: BackgroundConfig;
	ambient: AmbientConfig;
}

/** Per-chat state for the composer's steering + impersonate features and this chat's own
 *  scene. Persisted on Chat.featureState as an opaque JSON string. Always read through
 *  normalizeChatFeatureState, never constructed by hand except via
 *  DEFAULT_CHAT_FEATURE_STATE.
 *
 *  A stored blob may still carry a `steering` object. Steering notes live in their own rows
 *  (`steering_notes`, src/lib/types/steering.ts) because one object has no room for a scope,
 *  so that key is simply not parsed: the blob still reads fine and drops it on the chat's
 *  next write. */
export interface ChatFeatureState {
	/** The last 10 consumed one-shot steering texts, most-recent first, for quick reuse
	 *  from the composer's popover. */
	steeringHistory: string[];
	impersonatePerspective: ImpersonatePerspective;
	/** Null while this chat has never been given a scene of its own. */
	scene: ChatScene | null;
	/** The connection this story sends on, claimed from the composer's setup chip. A plain
	 *  connection id, or null to follow whatever the Connections page routes Primary to.
	 *  It covers the story's own calls and nothing else: the assistant and every engine
	 *  stay app-wide. An id naming a connection that no longer exists resolves to the app's
	 *  too, rather than throwing or being swept (see utils/chat-setup.ts). */
	connection: string | null;
	/** The persona this story plays as, or null to follow the app's. Stamped at birth only
	 *  from a real choice (the character's defaultPersonaId seed, or the persona step of the
	 *  New chat flow); every other door leaves it null, so a chat minted as a side effect of
	 *  something else never carries a pin nobody made. Resolved like `connection`: a deleted
	 *  persona reads as no claim. */
	persona: string | null;
	/** The preset this story's prompt is built from, or null to follow the app's active one.
	 *  A preset is one document, so the claim carries all of it: the items, the controls the
	 *  macros expand against, the regex rules it ships and its own prompt options. Stamped at
	 *  birth from the character's defaultPresetId seed and otherwise only from the setup chip.
	 *  Resolved like `connection`: a deleted preset reads as no claim. */
	preset: string | null;
	/** Lorebooks this story attached for itself, claimed from the setup chip. **The one claim
	 *  that ADDS rather than replaces**: these ride on top of the books the shelf switched into
	 *  every chat and the ones this chat's character and persona link, so an empty list is a
	 *  chat that adds nothing and never a chat with no lore. Nothing stamps it at birth.
	 *  Resolved like every other lorebook link: an id naming a deleted book is skipped rather
	 *  than swept (architecture/lorebook.md). */
	lorebooks: string[];
	/** Lorebooks this story leaves out, the other half of the claim above: a book switched
	 *  into every chat, or linked by this chat's character or persona, plays here unless its
	 *  id sits in this list. Nothing else can exempt one story from a book the wider setup
	 *  brings. Applied last, so it outranks every layer including the list above it. */
	mutedLorebooks: string[];
}

function defaultChatFeatureState(): ChatFeatureState {
	return {
		steeringHistory: [],
		impersonatePerspective: 'first',
		scene: null,
		connection: null,
		persona: null,
		preset: null,
		lorebooks: [],
		mutedLorebooks: []
	};
}

export const DEFAULT_CHAT_FEATURE_STATE: ChatFeatureState = defaultChatFeatureState();

function normalizeSteeringHistory(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, 10);
}

function normalizeImpersonatePerspective(raw: unknown): ImpersonatePerspective {
	return raw === 'first' || raw === 'second' || raw === 'third' ? raw : 'first';
}

/** A claimed id, or null for "follow the app". Absent in every blob written before a chat
 *  could claim anything, which is why this needs no migration: missing reads as null. */
function normalizeClaimedId(raw: unknown): string | null {
	return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** A claimed id list, empty for "adds nothing". Absent in every blob written before a chat
 *  could attach lorebooks, which is why this needs no migration either. */
function normalizeClaimedIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** A chat with no scene of its own reads as null, which is what "follows the app's" is.
 *  A stored one is coerced through the same two normalizers the settings stores use. */
export function normalizeChatScene(raw: unknown): ChatScene | null {
	if (!raw || typeof raw !== 'object') return null;
	const stored = raw as Partial<ChatScene>;
	return {
		enabled: stored.enabled === true,
		background: normalizeBackgroundConfig(stored.background),
		ambient: normalizeAmbientConfig(stored.ambient)
	};
}

/** Parse + sanitize a chat's feature_state column value: a JSON string (the normal
 *  wire shape), an already-parsed object (tests, or a caller that unwrapped it
 *  already), or null. Whitelists enums, clamps depth, caps history. Anything
 *  corrupt or missing degrades to DEFAULT_CHAT_FEATURE_STATE rather than throwing.
 *  This is the sanctioned exception to fail-loud (same convention as the settings
 *  stores' readSetting): pure and store-import-free so the generation path
 *  (reading straight from the db) and chatStore's reactive path agree exactly. */
export function normalizeChatFeatureState(raw: unknown): ChatFeatureState {
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			return defaultChatFeatureState();
		}
	}
	if (value === null || typeof value !== 'object') {
		return defaultChatFeatureState();
	}
	const obj = value as Record<string, unknown>;
	return {
		steeringHistory: normalizeSteeringHistory(obj.steeringHistory),
		impersonatePerspective: normalizeImpersonatePerspective(obj.impersonatePerspective),
		scene: normalizeChatScene(obj.scene),
		connection: normalizeClaimedId(obj.connection),
		persona: normalizeClaimedId(obj.persona),
		preset: normalizeClaimedId(obj.preset),
		lorebooks: normalizeClaimedIds(obj.lorebooks),
		mutedLorebooks: normalizeClaimedIds(obj.mutedLorebooks)
	};
}

/** Move `text` to the front of a steering history (deduping an exact repeat instead
 *  of adding a second copy), capped at 10 entries. Pure. Used when a one-shot note
 *  is consumed (see chatStore.pushSteeringHistory). */
export function pushSteeringHistoryEntry(history: string[], text: string): string[] {
	return [text, ...history.filter((entry) => entry !== text)].slice(0, 10);
}

/**
 * Attach one book to a chat's own claim, or take it off. Pure, so the rule below is testable
 * without a store (see chatStore.toggleChatLorebook).
 *
 * **Attaching clears a mute on the same book.** The two lists answer one question from
 * opposite ends, and an id sitting in both would read on screen as a book this story attached
 * while the resolver, which subtracts last, left it out of every prompt.
 */
export function withLorebookClaim(
	state: ChatFeatureState,
	bookId: string,
	on: boolean
): ChatFeatureState {
	if (!on) return { ...state, lorebooks: state.lorebooks.filter((id) => id !== bookId) };
	return {
		...state,
		lorebooks: state.lorebooks.includes(bookId) ? state.lorebooks : [...state.lorebooks, bookId],
		mutedLorebooks: state.mutedLorebooks.filter((id) => id !== bookId)
	};
}

/** One file the user attached to a chat message. Images only for now; the kind
 *  field leaves room for other media without another schema change. */
export interface MessageAttachment {
	kind: 'image';
	/** Server-relative path (images/chat/<file>). Render via imageService/fileUrl. */
	path: string;
}

export interface Message {
	id: string;
	chatId: string;
	parentId: string | null;
	role: 'user' | 'assistant' | 'system';
	content: string;
	/** The persona this message was sent with, captured at send time. Locks attribution
	 *  so changing the global active persona never re-labels past messages. User messages
	 *  only; null for assistant/system and for messages created before this was tracked. */
	personaId: string | null;
	/** A name+color for the branch this message heads, shown on the story map. Null for
	 *  unlabeled messages (the vast majority). Story-map metadata only. */
	branchLabel: BranchLabel | null;
	thinking: string | null;
	/** Images the user sent with this turn (paths under images/chat/ on the server).
	 *  Null for text-only messages. Vision-capable providers inline them at request time. */
	attachments: MessageAttachment[] | null;
	createdAt: number;
	/** Last rewrite that changed what this turn says. Chat memory compares its summaries
	 *  against this stamp, so a minor edit deliberately leaves it alone (see below). */
	editedAt: number | null;
	/** Last rewrite the user marked as minor: a typo, punctuation, nothing a summary of the
	 *  turn would record differently. Kept apart from `editedAt` so the transcript can still
	 *  show the turn as edited without costing the summary that covers it. */
	minorEditedAt: number | null;
	/** The sprite label the Sprites engine read this turn as, or null when it has not been read
	 *  (every user/system turn, and every assistant turn written while the engine was off or the
	 *  character had no sprites). Deliberately the LABEL and not an image path: a sprite can be
	 *  re-pointed or removed without falsifying what the turn was read as, and a label with no
	 *  sprite behind it is simply inert. */
	spriteLabel: string | null;
	model: string | null;
	provider: string | null;
	tokensPrompt: number | null;
	tokensCompletion: number | null;
	finishReason: string | null;
	/** Wall-clock duration of the live generation that produced this assistant turn
	 *  (request start → stream complete), in ms. Null for user/system turns, seeded
	 *  greetings, and pre-feature messages. An imported turn carries it when the source
	 *  file recorded start and finish stamps. */
	generationMs: number | null;
	/** The wait before the model said anything: request start → the first streamed token of
	 *  either kind, in ms. Null wherever nobody measured it, which includes every
	 *  non-streamed call, since no token arrives to be the first one. A continuation never
	 *  rewrites it: this turn started speaking once. */
	firstTokenMs: number | null;
	/** How long this turn spent reasoning, in ms, accumulated across continuations the way
	 *  `generationMs` is. Null for a model that does not reason and for every turn nobody
	 *  measured. Measured here as the span the reasoning stream occupied; an imported turn
	 *  carries the exporter's own figure instead, which is a different measurement of the
	 *  same thing (architecture/sillytavern-interchange.md). */
	reasoningMs: number | null;
	/** What the lorebook scan decided for the generation that produced this turn: which entries
	 *  reached the prompt, the keys that pulled them in and the turn they matched in, and why an
	 *  entry that could have fired did not. Null for every turn nobody scanned for (user and
	 *  system rows, seeded greetings, imported chats, anything written before this was kept).
	 *  A continuation deliberately leaves it alone: it records the scan that opened the turn. */
	lorebook: LorebookTrace | null;
	siblingIndex: number;
}

/** Current state of an active chat.
 *
 *  Both message fields are FLAT, and deliberately so: every surface reads either the
 *  branch on screen (`activePath`) or the whole forest (`allMessages`), and each resolves
 *  the parent links it needs for itself. A materialized tree here would be rebuilt on
 *  every open, every landed reply and every sync, for readers that do not exist. */
export interface ChatState {
	chat: Chat;
	activePath: Message[];
	allMessages: Message[];
	/** The message revision `allMessages` stands at, from the server's per-chat counter.
	 *  What the next `getMessagesDelta` call hands back as `sinceRev`, so a refresh costs
	 *  the rows that changed instead of the transcript. */
	messagesRev: number;
}

/** What changed in a chat after the rev the client already holds, or the whole transcript
 *  when there is no usable baseline (`sinceRev` null, or a rev this database never issued). */
export type MessagesDelta =
	| { rev: number; full: true; messages: Message[] }
	| { rev: number; full: false; upserts: Message[]; deletedIds: string[] };

/** The generation in flight, and the chat that owns it.
 *
 *  Deliberately NOT a field of ChatState: a stream belongs to the chat that started it,
 *  never to whatever the reader happens to be looking at. Move it back inside the chat
 *  state and a mid-generation chat switch does two things at once: the running reply's
 *  tokens spill into the transcript the reader just opened, and the rest of the app reads
 *  as idle, which unlocks a second generation over the same abort controller. */
export interface ChatStream {
	chatId: string;
	content: string;
	thinking: string;
	/** Assistant turn a continue is streaming into: its bubble renders the live tail
	 *  instead of the streaming indicator. Null while a fresh reply streams. */
	continuingMessageId: string | null;
	/** Set while an opening scene is being written. The transcript paints the streaming
	 *  bubble ALONE: an opening is a new beginning beside the ones already there, not a
	 *  turn after them, so leaving the path on screen would read as a reply to it. */
	openingScene: boolean;
}

/** Action to take after editing a message */
/** The two things an edit can mean, chosen before the editor opens (Edit vs Branch): rewrite
 *  the turn in place, or leave it alone and write the text as a new sibling. There is no
 *  third "rewrite and delete everything below" action any more: a branch reaches the same
 *  outcome without destroying the timeline it forks from. */
export type EditAction = 'save_only' | 'create_branch';

/** Action to take when deleting a message */
export type DeleteAction = 'this_only' | 'with_descendants';

/** Action to take when regenerating a response */
export type RegenerateAction = 'replace' | 'branch';
