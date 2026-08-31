/**
 * Chat-memory store: the bridge between the pure engine and the running app.
 *
 * Holds the active chat's episodes reactively for the panel and the ghost rendering, and
 * drives the engine with the real RPC db + LLM. It deliberately does NOT import the chat
 * store (which imports this one); callers hand it the messages/leaf/character they have.
 *
 * The archive boundary is **derived, not stored**: `coverage` resolves the episodes
 * against whatever path the chat store last handed over, every time anything it depends on
 * changes. That is what makes the ghosts, the panel and the prompt agree by construction:
 * flipping the app-wide engine switch, swapping to a preset without {{memory}}, dragging
 * the verbatim tail or walking to another branch all move the boundary in the same tick,
 * with no write, no round trip and nothing to go stale.
 */

import type { Message } from '$lib/types/chat';
import type { LLMCompletionResult, LLMMessage } from '$lib/types/llm';
import { llmService } from '$lib/services/llm/provider';
import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
import { personaEntryFor, presetForClaim, toPromptCharacter } from '$lib/utils/chat-setup';
import { lorebookStore } from '$lib/lorebook/store.svelte';
import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
import { resolveLorebooks } from '$lib/lorebook/engine';
import { lorebookHistory, lorebookScanFields } from '$lib/lorebook/types';
import { presetControlsStore } from '$lib/stores/presetControls.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { findActivePath } from '$lib/utils/message-tree';
import { expandMacros, resolveMacroValues, type MacroContext, type PromptCharacter } from '$lib/macros';

import { createMemoryDb } from './db-adapter';
import {
	assertTemplates,
	plannedPromotions,
	plannedWork,
	processChat,
	rebuildChat,
	syncCoverage,
	type EngineDeps,
	type ProcessProgress
} from './engine';
import {
	activePath,
	changeImpact,
	episodeSeqRanges,
	nextBatch,
	pendingCount,
	resolveCoverage,
	EMPTY_IMPACT,
	type ChangeImpact,
	type Coverage
} from './branching';
import { buildRecall } from './recall';
import { AUTO_MAX_BATCHES, resolveConfig } from './config';
import type { Episode, LlmFn, MemoryConfig, MemoryMessage } from './types';

export interface ChatCtx {
	chatId: string;
	allMessages: Message[];
	leafId: string | null;
	characterId: string | null;
	/** The chat's pinned character version. Memory builds its own MacroContext (it can
	 *  never import chatStore or live-macro-context), so the pin has to travel with the
	 *  ctx. Without it the card sheet memory extracts against silently becomes the
	 *  library's active variant instead of the one this chat is actually playing. */
	characterVersionId: string | null;
	/** The persona this chat claimed, travelling with the ctx for the same reason the version
	 *  pin does. Null is "follow the app", which is what memory extracts against unless the
	 *  chat named someone else. */
	personaId: string | null;
	/** The preset this chat claimed, travelling with the ctx for the same reason. It decides
	 *  both whether {{memory}} is placed at all and the controls a template expands against,
	 *  so reading the app's here would let the engine run for a chat whose own preset never
	 *  injects recall. Null is "follow the app". */
	presetId: string | null;
	/** The lorebooks this chat attached for itself, travelling for the same reason as the
	 *  three above. They are a layer on top of what the cards link, so an empty list means
	 *  the chat adds nothing, never that it has no lore. */
	lorebookIds: string[];
}

export type MemoryStatus = 'idle' | 'processing' | 'building' | 'rebuilding' | 'error';

/** How memory reads to a person right now, in four states. `behind` is the one with no
 *  other surface: it is not a phase of a run, it is work sitting still and waiting for a
 *  trigger that may not come for the rest of the session. */
export type MemoryStanding = 'idle' | 'working' | 'behind' | 'error';

export interface MemoryStandingState {
	kind: MemoryStanding;
	/** The one line both surfaces show: the panel's status row, the nav button's tooltip. */
	label: string;
	/** Model calls the backlog still owes. Zero when there is nothing worth quoting. */
	outstanding: number;
}

const memoryDb = createMemoryDb();

/**
 * Merge calls the *automatic* post-turn pass may spend at once, the same doctrine as
 * AUTO_MAX_BATCHES, for the same reason. Promotion answers to the layer caps rather than the
 * backlog, so dragging `maxPerLayer` from 60 to 3 owes seventy merges; uncapped, the next
 * ordinary reply paid for all of them, with no confirm, no toast and no number. The debt is
 * worked off a few calls per turn instead, and the panel's Summarise (priced and confirmed)
 * is there for anyone who wants it now.
 */
const AUTO_MAX_PROMOTIONS = 3;

const EMPTY_COVERAGE: Coverage = {
	cursorMessageId: null,
	archivedIds: new Set<string>(),
	onPathCoveredIds: new Set<string>(),
	active: [],
	dormant: [],
	dead: [],
	foldCeilingIndex: null
};

/**
 * Why a reply carries no content. The cause lives in the two channels the pure core
 * never sees, so only the port can name it: a reasoning model that never closes its
 * thinking inside the output cap leaves the whole answer in the thinking channel.
 */
function emptyReplyReason(result: LLMCompletionResult): string {
	const capped = result.finishReason === 'length';
	if (result.thinking) {
		return capped
			? 'The model spent its entire output on reasoning and never answered. Raise Max tokens on the connection Chat Memory uses, or turn reasoning off there.'
			: 'The model returned reasoning and no answer.';
	}
	return capped
		? 'The model reached its output cap before writing anything.'
		: 'The model returned an empty reply.';
}

/** The LLM port: memory side-tasks ride the Memory engine's connection and that
 *  connection's own generation settings, non-streaming. */
const llm: LlmFn = async (messages, signal) => {
	const result = await llmService.complete(
		{ engine: 'memory' },
		{ messages: messages as LLMMessage[], source: 'memory', signal }
	);
	// Thrown here rather than left to the parser: retrying an empty reply spends a
	// second identical call, and the quoted "" names nothing.
	if (!result.content.trim()) throw new Error(emptyReplyReason(result));
	return result.content;
};

class MemoryStore {
	activeChatId = $state<string | null>(null);
	loaded = $state(false);
	enabled = $state(false);
	/** false = extraction only fires from the panel's Summarise. Reaping still runs. */
	autoExtract = $state(true);
	configOverride = $state<Partial<MemoryConfig> | null>(null);

	episodes = $state<Episode[]>([]);

	status = $state<MemoryStatus>('idle');
	progress = $state<ProcessProgress | null>(null);
	lastError = $state<string | null>(null);

	/**
	 * The freshest tree the chat store has handed us. `$state.raw` on purpose: this holds
	 * the chat's whole message array, and deep-proxying it on every refresh would cost more
	 * than everything derived from it. Replaced wholesale, never mutated in place.
	 */
	private ctx = $state.raw<ChatCtx | null>(null);

	private abort: AbortController | null = null;

	config = $derived<MemoryConfig>(resolveConfig(this.configOverride));

	/** Whether the active preset actually injects {{memory}}. Recall reaches the model
	 *  only through that macro, so without it nothing is archived, nothing is recalled and
	 *  nothing is extracted, the same condition prompt assembly uses to decide whether to
	 *  filter {{chatHistory}}, so the panel, the ghosts and the prompt never disagree. */
	macroPlaced = $derived.by(() => {
		const p = presetForClaim(this.ctx?.presetId ?? null);
		return !!p?.items?.some((it) => it.enabled && it.content.includes('{{memory}}'));
	});

	/** The engine does anything only when this chat's own switch, the app-wide Chat Memory
	 *  switch (Settings → Engines) and the preset's {{memory}} placement all hold. Turning
	 *  any of them off leaves stored episodes and the per-chat flag untouched: recall,
	 *  extraction and the archive ghosts just go inert. Because everything below derives
	 *  from this rather than caching a snapshot of it, flipping any of the three updates
	 *  the whole surface in the same tick. */
	active = $derived(this.enabled && featurePromptsStore.memoryEnabled && this.macroPlaced);

	/** The whole tree, projected onto the engine's slice, plus the leaf. One shared derived
	 *  rather than a projection per consumer: this is O(messages) and four surfaces read it
	 *  every time anything below changes. */
	private tree = $derived.by<{ all: MemoryMessage[]; leafId: string | null }>(() => {
		const ctx = this.ctx;
		if (!this.active || !ctx || ctx.chatId !== this.activeChatId) return { all: [], leafId: null };
		return { all: this.toMemory(ctx), leafId: ctx.leafId };
	});

	private path = $derived(activePath(this.tree.all, this.tree.leafId));

	/**
	 * Where every stored episode stands against the path currently on screen. The single
	 * source of truth for the ghosts, the panel and the composer meter.
	 *
	 * Resolved against the WHOLE tree, not just the active path. That is what separates
	 * "belongs to another branch" (dormant, and the panel says so) from "the turn is gone"
	 * (dead). Handing it the path alone would classify every off-branch summary as dead and
	 * the panel's "N summaries belong to other branches" would always read zero.
	 *
	 * `dead` is still not acted on here: reaping is a write, and writes belong to the engine.
	 */
	coverage = $derived.by<Coverage>(() => {
		const t = this.tree;
		if (t.all.length === 0) return EMPTY_COVERAGE;
		return resolveCoverage(t.all, t.leafId, this.episodes, this.config.verbatimTail);
	});

	/** Ids of active-path messages folded into memory, which drives the ghost rendering. */
	archivedMessageIds = $derived(this.coverage.archivedIds);

	/**
	 * The 1-based turn span each episode was written from, keyed by episode id.
	 *
	 * The same numbers the chat prints as `#N` and `read_memory_state` reports to the
	 * assistant, from the same derivation, so "this summary covers #12–24" means one thing
	 * in the panel, in the transcript and in a tool result. An episode with a turn off this
	 * path gets no entry: there is no span to name.
	 */
	episodeRanges = $derived(episodeSeqRanges(this.path, this.episodes));

	/** Archivable-but-still-live messages waiting for the next extraction pass. */
	pending = $derived(
		pendingCount(this.path, this.coverage.cursorMessageId, this.config.verbatimTail, this.coverage.foldCeilingIndex)
	);

	/**
	 * How the turns on this path stand, in three bands that always sum to its length, the
	 * panel's one-glance answer to "how much of this story is folded".
	 *
	 * `verbatim` is a **remainder**, never the configured tail, and that is what makes the
	 * three add up: `effectiveTail` raises that tail on a path ending in assistant turns, and
	 * turns stranded behind a hole are neither folded nor reachable by the next pass. Every
	 * one of those is sent word-for-word, which is exactly what the band claims. Quoting
	 * `config.verbatimTail` here instead would print the slider's value back at the reader and
	 * disagree with the bar it labels the moment either case is live.
	 */
	composition = $derived.by<{ archived: number; waiting: number; verbatim: number; total: number }>(() => {
		const total = this.path.length;
		const archived = this.coverage.archivedIds.size;
		const waiting = this.pending;
		return { archived, waiting, verbatim: Math.max(0, total - archived - waiting), total };
	});

	/** Merge calls the layer caps owe right now, before any new batch lands. Zero in ordinary
	 *  play; it goes positive the moment a layer slider is dragged down, which is exactly
	 *  when the panel must stop reading "Up to date" over a ladder that violates the setting
	 *  the user just chose. */
	pendingPromotions = $derived(this.active ? plannedPromotions(this.coverage.active, this.config, 0) : 0);

	/** Whether a pass would spend a model call now: what the Summarise button means.
	 *  Not `pending >= batchSize`: a hole left by a deleted turn is narrower than a batch and
	 *  is still foldable (and must be, or everything after it stays dormant forever). Merges
	 *  count too: with nothing left to extract they were unreachable until the next reply. */
	canSummarise = $derived(
		nextBatch(
			this.path,
			this.coverage.cursorMessageId,
			this.config.batchSize,
			this.config.verbatimTail,
			this.coverage.foldCeilingIndex
		) !== null || this.pendingPromotions > 0
	);

	/**
	 * Model calls the backlog still owes: extraction passes plus the merges they trigger,
	 * the same arithmetic Enable / Summarise are priced with. Resolved off the coverage this
	 * store already derives, rather than through `plannedWork` below, which does its own
	 * resolve for the one moment memory is priced while `active` is still false.
	 *
	 * Read only by the branches of `standing` that have work to quote, so an up-to-date chat
	 * never pays for the walk.
	 */
	private outstandingCalls = $derived(
		this.active ? plannedWork(this.tree.all, this.tree.leafId, this.coverage, this.config).total : 0
	);

	/**
	 * What memory is doing for the chat on screen: one line, and one of four standings.
	 *
	 * It lives here because it has two consumers (the panel's status row and the Memory
	 * button's indicator in the TitleBar), and a second hand-kept copy of this text parts
	 * from the first the moment either changes, leaving the button saying something the panel
	 * disagrees with.
	 *
	 * "Up to date" while a full batch sits waiting was the panel's worst lie: after a branch
	 * change the boundary retreats and nothing reported it. Merges owed by a lowered layer cap
	 * are the second, since they have no batch to ride in on.
	 *
	 * The three gates (`active`) silence everything: with the chat's own switch, the app-wide
	 * engine, or the preset's {{memory}} item missing, the engine folds nothing and owes
	 * nothing, so a chat with memory off must never read as behind. A run in flight is
	 * reported *before* them on purpose: it re-asks `active` only between model calls, so for
	 * the length of one call it is genuinely spending money the gates cannot take back, and a
	 * panel that showed a Stop button over "Up to date" would be the contradiction instead.
	 */
	standing = $derived.by<MemoryStandingState>(() => {
		if (this.status === 'processing') {
			return { kind: 'working', label: 'Reading new turns…', outstanding: this.outstandingCalls };
		}
		if (this.status === 'building') {
			return { kind: 'working', label: 'Reading the story…', outstanding: this.outstandingCalls };
		}
		if (this.status === 'rebuilding') {
			return { kind: 'working', label: 'Re-reading from the start…', outstanding: this.outstandingCalls };
		}
		const idle: MemoryStandingState = { kind: 'idle', label: 'Up to date', outstanding: 0 };
		if (!this.active) return idle;
		if (this.status === 'error') return { kind: 'error', label: 'Something went wrong', outstanding: 0 };
		if (this.pending > 0 && this.canSummarise) {
			return {
				kind: 'behind',
				label: `${this.pending} turns waiting to be summarized`,
				outstanding: this.outstandingCalls
			};
		}
		if (this.pendingPromotions > 0) {
			const n = this.pendingPromotions;
			return {
				kind: 'behind',
				label: `${n} ${n === 1 ? 'summary' : 'summaries'} waiting to be merged`,
				outstanding: this.outstandingCalls
			};
		}
		return idle;
	});

	/**
	 * What rewriting or deleting these turns would cost this chat's memory, priced against
	 * the path on screen: the numbers a confirmation states before the user commits.
	 *
	 * Gated on `enabled`, NOT on `active`, and resolved directly instead of reading
	 * `this.coverage` (the same reason `plannedWork` does): the reap that destroys these
	 * summaries answers to the per-chat flag alone. `messageStore.editMessage` calls
	 * `invalidateMessage` off `memoryStore.enabled`, and the systemic `edited_at` rule needs
	 * no flag at all. Reading the derived coverage would report zero with the app-wide engine
	 * off or `{{memory}}` out of the preset, which is precisely the state where the cost is
	 * still paid and nothing else on screen would mention it.
	 */
	impactOf(messageIds: string[], opts: { removed: boolean }): ChangeImpact {
		const ctx = this.ctx;
		if (!ctx || !this.enabled) return EMPTY_IMPACT;
		const mem = this.toMemory(ctx);
		const coverage = resolveCoverage(mem, ctx.leafId, this.episodes, this.config.verbatimTail);
		return changeImpact(activePath(mem, ctx.leafId), coverage, messageIds, {
			removed: opts.removed,
			batchSize: this.config.batchSize,
			verbatimTail: this.config.verbatimTail
		});
	}

	/** The recall block as injected via {{memory}}, or '' when inactive or empty. Built from
	 *  the ACTIVE episodes only, the same set `getRecall` renders at generation time, so
	 *  the panel's preview and the input meter can never price another branch's summaries. */
	recall = $derived(this.active ? buildRecall(this.coverage.active) ?? '' : '');

	get busy(): boolean {
		return this.status === 'processing' || this.status === 'building' || this.status === 'rebuilding';
	}

	/** Model calls Enable / Summarise will cost, extraction and merges both. */
	get plannedWork(): { extractions: number; promotions: number; total: number } {
		const ctx = this.ctx;
		if (!ctx) return { extractions: 0, promotions: 0, total: 0 };
		const mem = this.toMemory(ctx);
		// Deliberately NOT this.coverage: enabling is the one moment the engine is asked to
		// price work while `active` is still false, so resolve directly.
		const coverage = resolveCoverage(mem, ctx.leafId, this.episodes, this.config.verbatimTail);
		return plannedWork(mem, ctx.leafId, coverage, this.config);
	}

	/** Model calls Forget and rebuild will cost. Every summary is discarded first, so the whole
	 *  path is read again from the root, never the smaller number the waiting-turns pass
	 *  would quote. */
	get plannedRebuildWork(): { extractions: number; promotions: number; total: number } {
		const ctx = this.ctx;
		if (!ctx) return { extractions: 0, promotions: 0, total: 0 };
		const mem = this.toMemory(ctx);
		return plannedWork(mem, ctx.leafId, EMPTY_COVERAGE, this.config);
	}

	private async deps(ctx: ChatCtx): Promise<EngineDeps> {
		const macroCtx = this.macroContext(ctx);
		return {
			db: memoryDb,
			llm,
			templates: {
				extract: featurePromptsStore.promptFor('memoryExtract'),
				promote: featurePromptsStore.promptFor('memoryPromote')
			},
			// The card sheets ride as explicit flow values (they carry the "(no character
			// sheet bound)" fallbacks the templates rely on) and win over the globals.
			cards: {
				character: expandMacros('{{character}}', macroCtx),
				persona: expandMacros('{{persona}}', macroCtx)
			},
			globals: (template) => resolveMacroValues(template, macroCtx)
		};
	}

	/**
	 * The global MacroContext for this chat: the same resolution every other surface
	 * uses, built from the ChatCtx instead of the chat store (which imports this module).
	 */
	private macroContext(ctx: ChatCtx): MacroContext {
		const entry = ctx.characterId
			? characterLibraryStore.entries.find((e) => e.id === ctx.characterId && e.type === 'character')
			: null;
		// The chat's pinned variant, same rule as the generation path and the meters:
		// card sheet AND linked lorebooks both come from it.
		const data = entry ? characterLibraryStore.dataForVersion(entry, ctx.characterVersionId) : null;
		const character: PromptCharacter | null = entry && data
			? {
					name: entry.identity.name,
					traits: data.traits,
					storyNotes: ''
				}
			: null;
		const chatMessages = ctx.leafId ? findActivePath(ctx.allMessages, ctx.leafId) : [];
		// The persona this chat plays as, same rule and same resolver as the prompt.
		const persona = personaEntryFor(ctx.personaId);
		// One resolution for both halves: a preset's controls and the values they expand
		// against belong to the same document, so reading them apart could price this chat
		// against one preset's knobs while another's controls decide what they mean.
		const preset = presetForClaim(ctx.presetId);
		const base: MacroContext = {
			resolvedCharacters: character ? [character] : [],
			resolvedPersona: toPromptCharacter(persona),
			chatMessages,
			controls: preset?.controls ?? [],
			customFields: presetControlsStore.valuesFor(preset?.id ?? null),
			memory: this.recall
		};
		// One scan, through the same resolver as the prompt and the meters. No budget here: a
		// memory template is its own request, priced against its own engine connection.
		const lore = resolveLorebooks({
			books: lorebookStore.booksForChat({
				cards: [...(data?.lorebookIds ?? []), ...(persona?.data.lorebookIds ?? [])],
				chat: ctx.lorebookIds
			}),
			messages: chatMessages.map((m) => m.content),
			fields: lorebookScanFields(base.resolvedCharacters ?? [], base.resolvedPersona),
			history: lorebookHistory(chatMessages),
			settings: lorebookSettingsStore.settings,
			expand: (text) => expandMacros(text, base)
		});
		return { ...base, lorebook: lore.text, lorebookTrace: lore.trace };
	}

	// ===== Loading / lifecycle (driven by the chat store) =====

	/** Load a chat's memory into the store. Called when a chat is opened. */
	async loadForChat(chatId: string): Promise<void> {
		this.cancel();
		this.activeChatId = chatId;
		this.ctx = null;
		this.loaded = false;
		this.status = 'idle';
		this.lastError = null;
		// Clear the previous chat's state synchronously so its panel data doesn't flash on
		// the new chat during the async refresh below. The ghost boundary needs no clearing:
		// it derives from ctx, which is already null.
		this.enabled = false;
		this.autoExtract = true;
		this.configOverride = null;
		this.episodes = [];
		await this.refresh(chatId);
		this.loaded = true;
	}

	/** Clear when no chat is open. */
	clear(): void {
		this.cancel();
		this.activeChatId = null;
		this.ctx = null;
		this.loaded = false;
		this.enabled = false;
		this.autoExtract = true;
		this.configOverride = null;
		this.episodes = [];
		this.status = 'idle';
		this.progress = null;
	}

	/** Re-pull state + episodes from the db for a chat. */
	private async refresh(chatId: string): Promise<void> {
		const [state, episodes] = await Promise.all([memoryDb.getState(chatId), memoryDb.listEpisodes(chatId)]);
		if (this.activeChatId !== chatId) return; // a newer chat won the race
		this.enabled = state?.enabled ?? false;
		this.autoExtract = state?.autoExtract ?? true;
		this.configOverride = state?.config ?? null;
		this.episodes = episodes;
	}

	/**
	 * Hand the store the current tree. Called after every chat refresh.
	 *
	 * The boundary itself needs nothing from this beyond the assignment: it is derived, so
	 * a branch switch, a swipe or a fresh reply repaints the ghosts synchronously. The
	 * async half only reaps episodes whose turns were deleted or rewritten, which is the
	 * one thing a path change can genuinely destroy.
	 */
	async syncForPath(ctx: ChatCtx): Promise<void> {
		if (ctx.chatId !== this.activeChatId) return;
		this.ctx = ctx;
		if (!this.enabled) return;
		// A run in flight re-reads the tree between batches and reaps on its own; letting a
		// second reaper delete rows underneath it buys nothing.
		if (this.busy) return;
		try {
			const { reaped } = await syncCoverage({ db: memoryDb }, ctx.chatId, this.toMemory(ctx), ctx.leafId);
			if (!reaped) return;
			await this.refresh(ctx.chatId);
			// A reap hands every turn it uncovered straight back to the live prompt: one
			// deleted turn measured at 47 of them in a single tick, none covered by anything,
			// and a tight budget silently trims the overflow. Nothing else triggers extraction
			// on a delete, so without this the chat sends the lot verbatim until enough replies
			// happen to work it off a few batches at a time. Capped and gated like any other
			// automatic pass.
			this.maintainAfterTurn(ctx);
		} catch (e) {
			console.error('[memory] syncForPath failed:', e);
		}
	}

	/**
	 * Per-batch progress from the engine. Each batch is already committed, so pull the
	 * fresh episodes right away: the panel and ghosts update live as the build runs, and a
	 * mid-run failure (dropped connection, API limit) keeps everything folded so far
	 * instead of discarding it.
	 */
	private async handleProgress(chatId: string, signal: AbortSignal, p: ProcessProgress): Promise<void> {
		// A tick from a run whose chat is no longer active must not touch state, and neither
		// may one from a SUPERSEDED run on the same chat. A cancelled pass keeps emitting until
		// its await unwinds, and its stale counts would overwrite the newer run's panel.
		if (chatId !== this.activeChatId || this.abort?.signal !== signal) return;
		this.progress = p;
		try {
			await this.refresh(chatId);
		} catch (e) {
			console.error('[memory] live refresh failed:', e);
		}
	}

	// ===== Recall (consumed by the prompt builder) =====

	/**
	 * The recall block + archived-message set for the given active path. Returns an empty
	 * result when memory is disabled, so the prompt is byte-identical to today.
	 *
	 * Reads fresh from the db and resolves coverage against the path it is handed, rather
	 * than trusting the store's reactive copy: the chat-load that primes the store is
	 * fire-and-forget, and generation must never assemble against a half-loaded snapshot.
	 */
	async getRecall(chatId: string, path: Message[]): Promise<{ text: string | null; archivedIds: Set<string> }> {
		const empty = { text: null, archivedIds: new Set<string>() };
		// The app-wide Chat Memory switch (Settings → Engines) gates every chat at once:
		// while off, nothing is recalled and no turns are archived, so the prompt keeps the
		// full live history. Stored episodes stay in the db, untouched.
		if (!featurePromptsStore.memoryEnabled) return empty;
		const state = await memoryDb.getState(chatId);
		if (!state?.enabled) return empty;

		const episodes = await memoryDb.listEpisodes(chatId);
		const config = resolveConfig(state.config);
		const mem = path.map((m): MemoryMessage => ({ id: m.id, parentId: m.parentId, role: m.role, content: m.content, speaker: '', editedAt: m.editedAt }));
		const leafId = mem.length > 0 ? mem[mem.length - 1].id : null;
		// Coverage resolves against THIS path, so a branch change moments ago is already
		// accounted for: there is no persisted boundary that could still be catching up.
		// Resolved against the path alone, which is all the caller has. That makes the
		// active/dormant/dead split coarser here (an off-branch summary reads as dead rather
		// than dormant), and it does not matter: this call consumes only `active` and
		// `archivedIds`, and both are identical either way: a summary that doesn't apply to
		// this path is excluded whichever bucket it lands in. Nothing is reaped from here.
		const coverage = resolveCoverage(mem, leafId, episodes, config.verbatimTail);
		// Recall framing is fixed in code (it's macro resolution, not an editable LLM helper).
		return { text: buildRecall(coverage.active), archivedIds: coverage.archivedIds };
	}

	// ===== Extraction / maintenance =====

	/** After an assistant turn: fire-and-forget extraction of any newly-eligible batches.
	 *  No-op in manual mode: there the panel's Summarise is the only extraction trigger
	 *  (reaping still runs via syncForPath, so consistency never waits). */
	maintainAfterTurn(ctx: ChatCtx): void {
		if (!this.active || !this.autoExtract || this.busy || ctx.chatId !== this.activeChatId) return;
		void this.run(ctx, 'processing', (deps, signal) =>
			processChat(deps, ctx.chatId, this.toMemory(ctx), ctx.leafId, {
				signal,
				stillActive: () => this.active,
				maxBatches: AUTO_MAX_BATCHES,
				maxPromotions: AUTO_MAX_PROMOTIONS,
				latest: () => this.latestTree(ctx.chatId),
				onProgress: (p) => this.handleProgress(ctx.chatId, signal, p)
			})
		);
	}

	/** Foreground build over the whole backlog (after enabling, or the panel's Summarise). */
	async build(ctx: ChatCtx): Promise<void> {
		if (ctx.chatId !== this.activeChatId) return;
		await this.run(ctx, 'building', (deps, signal) =>
			processChat(deps, ctx.chatId, this.toMemory(ctx), ctx.leafId, {
				signal,
				stillActive: () => this.active,
				latest: () => this.latestTree(ctx.chatId),
				onProgress: (p) => this.handleProgress(ctx.chatId, signal, p)
			})
		);
	}

	/** Wipe stored memory and rebuild from scratch along the active path. */
	async rebuild(ctx: ChatCtx): Promise<void> {
		if (ctx.chatId !== this.activeChatId) return;
		await this.run(ctx, 'rebuilding', (deps, signal) =>
			rebuildChat(deps, ctx.chatId, this.toMemory(ctx), ctx.leafId, {
				signal,
				stillActive: () => this.active,
				latest: () => this.latestTree(ctx.chatId),
				onProgress: (p) => this.handleProgress(ctx.chatId, signal, p)
			})
		);
	}

	/**
	 * The tree as it stands right now, for a run that started minutes ago.
	 *
	 * An EMPTY tree when the chat has changed under the run, which is deliberate and not a
	 * fallback: the engine treats every turn of a batch as gone and refuses to commit it, so
	 * a run that outlives its chat writes nothing instead of folding against a snapshot of a
	 * story nobody is reading. It is about to be cancelled anyway.
	 */
	private latestTree(chatId: string): { allMessages: MemoryMessage[]; leafId: string | null } {
		const ctx = this.ctx;
		if (!ctx || ctx.chatId !== chatId) return { allMessages: [], leafId: null };
		return { allMessages: this.toMemory(ctx), leafId: ctx.leafId };
	}

	/**
	 * Drop the summary of one turn because its text changed under it.
	 *
	 * Coverage-based reconciliation catches this on its own (every content update stamps
	 * `edited_at`, and an episode created before that stamp is dead), but two callers need
	 * it to have happened *by the time they return*: the editor, so its toast is truthful,
	 * and Continue, which deliberately never stamps `edited_at`. Nothing else is touched:
	 * the episodes after this one simply go dormant until the freed turns re-fold, and come
	 * back when they do. Returns whether anything was actually dropped.
	 */
	async invalidateMessage(chatId: string, messageId: string): Promise<boolean> {
		if (chatId !== this.activeChatId) return false;
		const state = await memoryDb.getState(chatId);
		if (!state?.enabled) return false;
		const episodes = await memoryDb.listEpisodes(chatId);
		const doomed = episodes.filter((e) => (e.sourceMessageIds ?? []).includes(messageId));
		if (doomed.length === 0) return false;
		// Only now is stopping a run justified: it may be mid-fold on ground this rewrite
		// invalidates. A live turn (the common case) never gets here, so an ordinary edit no
		// longer kills a build for nothing.
		this.cancel();
		await memoryDb.reapEpisodes(chatId, doomed.map((e) => e.id));
		await this.refresh(chatId);
		return true;
	}

	private async run(
		ctx: ChatCtx,
		status: MemoryStatus,
		fn: (deps: EngineDeps, signal: AbortSignal) => Promise<unknown>
	): Promise<void> {
		if (this.busy) return;
		this.cancel();
		const controller = new AbortController();
		this.abort = controller;
		this.status = status;
		this.progress = null;
		this.lastError = null;
		// Once cancel() (chat switch, Stop, invalidateMessage) detaches this controller, a
		// newer run may own the store: a superseded run must not stomp its status/progress.
		const owns = () => this.abort === controller;
		try {
			const deps = await this.deps(ctx);
			await fn(deps, controller.signal);
			if (owns()) this.status = 'idle';
			if (this.activeChatId === ctx.chatId) await this.refresh(ctx.chatId);
		} catch (e) {
			if (owns()) {
				if (e instanceof Error && e.name === 'AbortError') {
					this.status = 'idle';
				} else if (e instanceof Error && e.message.includes('mem-op-superseded')) {
					// A concurrent writer (another device, a raced run) already covered this
					// ground and the db rejected the write whole. Not an error: the refresh
					// below picks up the winner's state and the next pass carries on from it.
					this.status = 'idle';
				} else {
					this.status = 'error';
					this.lastError = e instanceof Error ? e.message : String(e);
					console.error('[memory] processing failed:', e);
					toastStore.failed('update this chat memory', this.lastError);
				}
			}
			// Per-batch commits are durable, so surface whatever was folded before the failure
			// (or cancel) rather than leaving the panel + ghosts stale. Safe for a superseded
			// run too: it only re-reads the db for the still-active chat.
			if (this.activeChatId === ctx.chatId) {
				try {
					await this.refresh(ctx.chatId);
				} catch (refreshErr) {
					console.error('[memory] post-failure refresh failed:', refreshErr);
				}
			}
		} finally {
			if (owns()) {
				this.progress = null;
				this.abort = null;
			}
		}
	}

	/** Stop any in-flight processing (chat switch, panel stop). */
	cancel(): void {
		this.abort?.abort();
		this.abort = null;
		if (this.busy) this.status = 'idle';
	}

	/** Remote 'memory' sync hint: another device changed this chat's memory rows. Re-pull
	 *  the episodes; the boundary redraws itself from them. A local in-flight run is left
	 *  alone: its own teardown re-reads everything. */
	async syncReload(): Promise<void> {
		const chatId = this.activeChatId;
		if (!chatId || this.busy) return;
		await this.refresh(chatId);
	}

	// ===== Panel actions =====

	async enable(ctx: ChatCtx): Promise<void> {
		if (ctx.chatId !== this.activeChatId) return;
		// Fail before the first paid call rather than after it: a template edited past the
		// point of usefulness would otherwise fold real turns behind summaries of nothing.
		// Throws: the caller has to surface it, or enabling silently does nothing at all.
		assertTemplates(featurePromptsStore.promptFor('memoryExtract'), featurePromptsStore.promptFor('memoryPromote'));
		await memoryDb.setState(ctx.chatId, { enabled: true });
		// The user can switch chats through that round trip.
		if (ctx.chatId !== this.activeChatId) return;
		this.enabled = true;
		await this.build(ctx);
	}

	async disable(chatId: string): Promise<void> {
		await memoryDb.setState(chatId, { enabled: false });
		this.cancel();
		this.enabled = false;
	}

	/** Forget means forget: every stored episode goes, for every branch of this chat. */
	async forget(chatId: string): Promise<void> {
		this.cancel();
		await memoryDb.reset(chatId);
		await this.refresh(chatId);
	}

	async updateConfig(chatId: string, patch: Partial<MemoryConfig>): Promise<void> {
		// Optimistic first: the boundary derives from this, so the ghosts and the panel move
		// with the slider rather than after the round trip.
		this.configOverride = { ...(this.configOverride ?? {}), ...patch };
		// Send ONLY what changed and let the server merge it onto the stored row. Sending the
		// whole cached object made every slider release a read-merge-write from a snapshot
		// that could be minutes old, so two devices editing different sliders each wrote the
		// other's change away, with nothing to show for it.
		await memoryDb.setState(chatId, { config: patch });
	}

	/** Rewrite one episode's text. Episodes are the whole store, so a single bad summary
	 *  must be fixable in place: the alternative is re-reading the entire thread to repair
	 *  one paragraph. Coverage is untouched, so nothing is invalidated. */
	async editEpisode(chatId: string, episodeId: string, content: string): Promise<void> {
		const trimmed = content.trim();
		if (!trimmed) return;
		await memoryDb.updateEpisodeContent(chatId, episodeId, trimmed);
		await this.refresh(chatId);
	}

	/** Switch between automatic (fold after every reply) and manual (Summarise only). */
	async setAutoExtract(chatId: string, value: boolean): Promise<void> {
		await memoryDb.setState(chatId, { autoExtract: value });
		if (this.activeChatId === chatId) this.autoExtract = value;
	}

	// ===== Helpers =====

	/** Project app messages onto the engine's slice, resolving speaker names. */
	private toMemory(ctx: ChatCtx): MemoryMessage[] {
		const charName =
			(ctx.characterId && characterLibraryStore.entries.find((e) => e.id === ctx.characterId)?.identity.name?.trim()) ||
			'Narrator';
		// Who an unstamped user turn belongs to: the persona this chat plays as. Imported and
		// pre-feature rows carry no persona of their own, so they read as whoever the story
		// is being played by rather than as whoever the app happens to be.
		const userName = personaEntryFor(ctx.personaId)?.identity.name?.trim() || 'User';
		return ctx.allMessages.map((m) => ({
			id: m.id,
			parentId: m.parentId,
			role: m.role,
			content: m.content,
			speaker: this.speakerFor(m, charName, userName),
			editedAt: m.editedAt
		}));
	}

	private speakerFor(m: Message, charName: string, userName: string): string {
		if (m.role === 'assistant') return charName;
		if (m.role === 'system') return 'System';
		if (m.personaId) {
			const p = characterLibraryStore.entries.find((e) => e.id === m.personaId && e.type === 'persona');
			if (p?.identity.name?.trim()) return p.identity.name.trim();
		}
		return userName;
	}
}

export const memoryStore = new MemoryStore();
