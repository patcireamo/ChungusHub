/**
 * Chungus Assistant loop.
 *
 * Runs the multi-step read→act→observe loop server-side (keys never leave the
 * server), streaming reply text, reasoning, tool-call progress, and tool results over
 * the WebSocket, addressed to the SESSION, so every page showing that tab renders the
 * turn. Mirrors the shape of handleLlm but adds the tool iteration loop with
 * iteration/action caps and abort handling.
 */
import { completeWithTools, isProvider, type RoutingConfig } from '../llm/registry';
import type { GenerationTuning, LLMToolDef, LLMToolMessage, LLMToolResult, LLMToolStreamOptions } from '../llm/types';
import { imageFileExists } from '../llm/media';
import { branchStamp, buildTools, chatLorebooks, dispatch, getEntity, previewCall, readEntryImages, revokedToolNames, riskCeiling, versionSummary } from './registry';
import { stalenessNote, stampState } from './freshness';
import { claimKey, collectStateClaims, WORKSPACE_NOTE_PREFIX, type ClaimSource } from './freshness-core';
import type { SentAttachment } from '../../shared/assistant-attachments';
import { disabledGroupIds } from './registry/groups';
import { ESTIMATE_CHARS_PER_TOKEN, estimateTextTokens, estimateToolTokens, INLINE_CONTENT_TOKEN_LIMIT } from './registry/schema';
import type { RawChat, RawLibraryEntry, RawLorebookBook } from './rows';
import { assistantSystemPrompt } from './systemPrompt';
import { toolProgressText } from './toolProgress';
import { serverDb, type AssistantFileRow } from '../db';
import { fileKindLabel } from '../../shared/assistant-files';
import { riskAtLeast } from './types';
import type { ApprovalCall, ApprovalMode, ApprovalOutcome, AskQuestion, AssistantContext, AssistantPermissions, AssistantStep, AssistantToolResult, QuestionOutcome, RiskClass } from './types';
import { liveCapabilityGroups, settingsForTurn } from './sessionSettings';
import type { PromptLogEntry, PromptLogResult } from '../promptLog';
import type { SyncScope } from '../../shared/sync';

/** Model-call (reasoning step) budget per user turn. Generous on purpose: the real
 *  safety nets are the action cap below and the user's Stop button: a read-heavy
 *  job (inspect a thread, then edit 15 messages) must never die of step starvation. */
const MAX_ASSISTANT_ITERATIONS = 50;
/** Tool-call budget per user turn. */
const MAX_ASSISTANT_ACTIONS = 100;
/** With this many steps left, the model is told to land the turn (calmly). */
const ASSISTANT_BUDGET_WARN_REMAINING = 5;
/** LLM attempts per iteration: 1 + retries on transient provider errors. */
const MAX_LLM_ATTEMPTS = 3;
/** Marks the one-time note that tells the model a capability family was switched off
 *  mid-session. Matched as a prefix so the note is announced exactly once per conversation. */
const PERMISSION_REVOKED_PREFIX = '(capability change: the user switched a capability family off.';

/** Pull a numeric sampling value out of the merged params map (values arrive as string|number). */
function numParam(params: Record<string, string | number> | undefined, key: string): number | undefined {
	const v = params?.[key];
	if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

export interface AssistantRequest {
	id: string;
	/** The connection driving the Assistant surface: the server reads its key by this id. */
	connectionId: string;
	provider: string;
	model: string;
	/** The assistant conversation (tab) id: its full tool context persists here. */
	assistantSessionId: string;
	/** The user row this turn answers (inserted client-side before the request). The note
	 *  builder writes each attachment's RESOLVED mode back onto it, so the transcript states
	 *  what actually rode along, never what the composer intended. */
	userMessageId: string;
	/** The roleplay chat the user had open when they sent this turn; null if none. Not a
	 *  tool default: it is reported to the model in the turn's workspace note, and every
	 *  chat-scoped tool takes an explicit id. */
	chatId: string | null;
	/** The user's new turn. */
	userMessage: string;
	/** Images the user attached to this turn (server-relative paths). */
	images?: string[];
	/** Files the user attached to this turn, as `assistant_files` ids. Unlike images these
	 *  carry no content on the request: the row is already stored, and the turn only binds
	 *  it to the user message so the transcript can say which turn it arrived on. */
	files?: string[];
	/** Whether the assistant's provider/model takes images, resolved client-side like the
	 *  main chat's send gate. When false, image paths in the context are stripped
	 *  from each request (they stay persisted for when a vision model returns). */
	sendImages?: boolean;
	/** Re-run of a failed turn: don't append userMessage again if it is already the
	 *  last user turn in the persisted context. Continue from where it stopped. */
	retry?: boolean;
	/** Workspace items the user attached as context (resolved + injected each turn). */
	attachments?: {
		kind: string;
		refId: string;
		entryType?: string;
		full?: boolean;
		selection?: { anchorMessageId: string; text: string; truncated?: boolean; spanCount?: number };
	}[];
	/** Sampling knobs (top_p, penalties, service_tier, …) resolved from the Assistant connection
	 *  for its model, merged into the request body verbatim. max_tokens + temperature ride inside
	 *  here too; there are no separate top-level fields. */
	params?: Record<string, string | number>;
	/** Reasoning-effort / show-reasoning / verbosity / image-detail tuning for the assistant model,
	 *  resolved client-side from the Assistant connection like the main chat. */
	tuning?: GenerationTuning;
	/** The Assistant connection's OpenRouter routing (openrouter only; ignored elsewhere). */
	routing?: RoutingConfig | null;
	/** The Assistant connection's declared context size (tokens), resolved client-side like
	 *  everything else on this request. Drives the token-denominated context trim and the
	 *  pre-flight fit check. */
	contextSize: number;
	/** The Assistant connection's Stream response setting. False = one non-streamed request
	 *  per model step, so no reply/reasoning deltas and no tool-call progress reach the panel. */
	stream: boolean;
	/** How much this TAB wants to be asked before a call runs. Deliberately absent from the
	 *  system prompt and the tool list: approval is the app's business, the model is never
	 *  told, and switching modes therefore costs no prompt cache. */
	approvalMode: ApprovalMode;
}

export interface AssistantHelpers {
	/** Publishes one event of this turn. The caller addresses it to the SESSION, not to the
	 *  socket that asked: a page that reloaded mid-turn never issued this request, and the
	 *  socket that did may be long gone. */
	send: (event: Record<string, unknown>) => void;
	signal: AbortSignal;
	/** Broadcasts a live-sync hint to every connected client. */
	broadcast: (scope: SyncScope) => void;
	/** Captures one iteration's assembled prompt for the shared debug log. No-ops when
	 *  no client has the debug panel enabled; the server decides. */
	recordPrompt?: (entry: PromptLogEntry) => void;
	/** Patches the real result onto a previously recorded prompt. No-ops server-side
	 *  when that prompt was never captured. */
	recordResult?: (id: string, result: PromptLogResult) => void;
	/**
	 * Puts these pending calls in front of the user and waits (as long as it takes) for
	 * which of them may run. The wait is safe by construction: nothing has been written yet,
	 * so a server that dies here loses a turn that had no effects. An abort rejects.
	 */
	requestApproval: (calls: ApprovalCall[]) => Promise<ApprovalOutcome>;
	/**
	 * Puts the assistant's own questions to the user and waits for the answers. The same wait
	 * as the approval card, and safe for the same reason: the turn has stopped, so a server
	 * that dies here loses nothing that happened. An abort answers `stopped`.
	 */
	askQuestions: (questions: AskQuestion[]) => Promise<QuestionOutcome>;
}

export async function handleAssistant(msg: AssistantRequest, helpers: AssistantHelpers): Promise<void> {
	const { send, signal, broadcast, recordPrompt, recordResult, requestApproval, askQuestions } = helpers;

	if (!isProvider(msg.provider)) {
		send({ t: 'assistant-error', message: `Unknown provider: ${msg.provider}` });
		return;
	}
	if (!msg.connectionId) {
		send({ t: 'assistant-error', message: 'No connection drives the Assistant. Assign one in Settings → Connections.' });
		return;
	}
	if (!msg.model) {
		send({ t: 'assistant-error', message: "The Assistant's connection has no model. Pick one in Settings → Connections." });
		return;
	}
	// The gate this turn runs under, checked before anything else. An unknown value is refused
	// rather than read as "no threshold": a page whose build predates the current mode set must
	// get an error naming the fix, never a silently unreviewed turn.
	if (!(msg.approvalMode in APPROVAL_THRESHOLD)) {
		send({ t: 'assistant-error', message: `This page sent an unknown approval mode (${msg.approvalMode}). Reload the page and try again.` });
		return;
	}

	// The settings this session froze on its first turn. Everything they feed (the system
	// prompt and the tool list) is the cached prefix of every request, so reading them
	// live would re-price the whole conversation the moment the user edited a setting.
	// The user re-syncs deliberately with "Apply settings" (sessionSettings.ts).
	const settings = settingsForTurn(msg.assistantSessionId);
	const offered: AssistantPermissions = { groups: new Set(settings.groups) };
	// …with one asymmetry: a family switched OFF bites now. The tool list still carries its
	// tools (moving it would cost the cache), but dispatch asks this set and refuses.
	const live = new Set(liveCapabilityGroups());
	const effective: AssistantPermissions = { groups: new Set(settings.groups.filter((g) => live.has(g))) };
	const tools = buildTools(offered);
	const userImages = collectUserImages(msg.assistantSessionId);
	const turnImages = msg.images ?? [];
	const chatId = msg.chatId || null;
	const sendImages = !!msg.sendImages;
	const windowTokens = typeof msg.contextSize === 'number' && msg.contextSize > 0 ? Math.floor(msg.contextSize) : null;
	const systemPrompt = assistantSystemPrompt({
		// Named, not hidden: a model that never heard of the lorebook tools answers "add this
		// to the lorebook" by improvising around them instead of saying it cannot.
		disabledGroups: disabledGroupIds(offered.groups),
		skillIndex: settings.skillIndex,
		customInstructions: settings.instructions,
		budget: { iterations: MAX_ASSISTANT_ITERATIONS, actions: MAX_ASSISTANT_ACTIONS }
	});
	/**
	 * The fixed head of EVERY request: the system prompt plus the tool schemas. The tool
	 * block is normally the larger of the two, and leaving it out of the accounting is
	 * what let a small connection pass the fit check below and then 400 at the provider on
	 * that turn and every turn after it. Both the pre-flight check and the trim budget
	 * measure against it, so the conversation is only ever given what is actually left.
	 */
	const overheadTokens = estimateTextTokens(systemPrompt) + estimateToolTokens(tools);
	/** What the persisted conversation may occupy: the window minus that fixed head. Clamped
	 *  at zero rather than allowed to go negative, and zero is a real budget: a head that fills
	 *  the whole window leaves the conversation nothing, and the trim below has to read it that
	 *  way instead of as "no window given" (`null`). That state is reachable: the pre-flight
	 *  throws on it, and the catch still persists. */
	const conversationWindow = windowTokens === null ? null : Math.max(0, windowTokens - overheadTokens);
	// The numbering edit_character_images speaks, stated once per request rather than left
	// for the model to count off the transcript (which trimming would eventually break).
	// Not persisted: it is recomputed every turn, so it can never go stale.
	const attachmentRoster = describeAttachments(userImages, turnImages, sendImages);

	// Replay this assistant session's full prior context (assistant tool_calls + tool
	// results from earlier turns), then append the new user turn, so the assistant
	// remembers what it already found and did, like a continuous conversation.
	// A retry re-runs the last turn instead: the failed attempt already persisted
	// the user message (and any partial work), so appending it again would lie.
	const prior = serverDb.getAssistantContext(msg.assistantSessionId) as LLMToolMessage[];
	// Skip the loop's own image-injection user messages here: a turn that failed right
	// after one would otherwise mismatch, and the retry would re-append the real user
	// message, the exact duplication this match exists to prevent.
	const lastUser = [...prior].reverse().find((m) => m.role === 'user' && !isInternalUserMessage(m));
	const isRetry = !!msg.retry && lastUser?.content === msg.userMessage;
	const userTurn: LLMToolMessage = { role: 'user', content: msg.userMessage, ...(msg.images?.length ? { images: msg.images } : {}) };

	// Resolve what the user had open into a compact context note and pin it into the
	// conversation as a system message right AFTER the user turn, frozen with that turn.
	// (A later edit to an attached entry surfaces in the NEXT turn's fresh note; it never
	// rewrites this one.) Persisting it keeps the assembled prompt byte-identical turn to
	// turn, so the whole prior conversation stays a cacheable prefix, instead of a volatile
	// block wedged ahead of the history invalidating the cache on every turn. Its `system`
	// role also keeps it out of the retry user-turn match below. A retry reuses the note
	// already attached to the last turn rather than resolving a new one, and leaves the
	// user row's persisted attachment record alone, since that note IS what rode.
	// The claim check inside reads `prior`: the claims live in earlier turns' results and
	// notes, and what the trim dropped from the persisted context is gone from both.
	const noteBuild = isRetry ? null : buildWorkspaceNote(msg.attachments ?? [], prior);
	const attachmentBlock = noteBuild?.note ?? '';
	const conversation: LLMToolMessage[] = isRetry ? [...prior] : [...prior, userTurn];
	if (attachmentBlock) conversation.push({ role: 'system', content: attachmentBlock });
	/**
	 * Room left in the conversation before the trim ceiling, asked LIVE by the attached-file
	 * reads (registry/files.ts): it reads the conversation as it stands at the moment of the
	 * call, so two reads inside one model step cannot both spend the same room.
	 *
	 * The ceiling is the TRIM's, not the raw window. That fraction is the headroom this loop
	 * already lives by, and a read allowed to fill the window outright would hand the next
	 * persist a conversation it can only fit by dropping every earlier turn: the memory of
	 * the whole tab spent on one file. A null window means the connection reported none, so
	 * nothing here is measurable and the reads fall back to their own inline limit.
	 */
	const roomTokens =
		conversationWindow === null
			? undefined
			: () => Math.max(0, Math.floor(conversationWindow * CONTEXT_WINDOW_CEILING) - estimateConversationTokens(conversation));
	/** Persisted-context save. A failure is NOT silent: it surfaces as a warning on the
	 *  committed turn, because a lost save means the next turn quietly forgets this one. */
	let persistFailed = false;
	const persist = () => {
		try {
			serverDb.setAssistantContext(msg.assistantSessionId, trimConversation(balanceToolCalls(conversation), conversationWindow));
		} catch (e) {
			persistFailed = true;
			console.error('[assistant] failed to persist the conversation context:', e instanceof Error ? e.message : e);
		}
	};

	// Heal references to image files that no longer exist (an entry deleted from the
	// library, a swept chat attachment): drop the dead paths from the PRIOR context and
	// tell the model, instead of letting one dead path fail every future request of this
	// tab. THIS turn's fresh attachments stay strict: missing means a real upload bug,
	// and the request build fails loudly naming the file.
	const healed = healMissingImages(conversation, new Set(turnImages));
	if (healed.length) {
		conversation.push({
			role: 'system',
			content: `(note: ${healed.length} previously attached image file${healed.length === 1 ? '' : 's'} no longer exist on disk and ${healed.length === 1 ? 'was' : 'were'} removed from this conversation: ${healed.join(', ')}. If one was an entry's portrait, it may have been deleted from the library.)`
		});
	}

	// A capability family the user switched off mid-session: its tools are still listed (the
	// frozen list is what keeps the cache alive) but dispatch now refuses them, so the model
	// is told once, in the conversation itself. Announced ONLY on withdrawal: switching one
	// back on says nothing, which is the safe direction to be wrong in, and the announcement
	// being persisted means it never repeats. If trimming ever drops it, it simply comes back.
	const revoked = revokedToolNames(offered, effective);
	if (revoked.length && !conversation.some((m) => m.role === 'system' && m.content.startsWith(PERMISSION_REVOKED_PREFIX))) {
		conversation.push({
			role: 'system',
			content: `${PERMISSION_REVOKED_PREFIX} These tools no longer work for the rest of this conversation: ${revoked.join(', ')}. Don't call them; if the task needs one, say so plainly and point at Assistant Settings → Capabilities.)`
		});
	}

	// What the model read earlier that has since moved under it: the user editing in
	// the app, another device or tab, a version switch, the roleplay carrying on. Tool
	// results stamp what they hand over (freshness.ts); this compares every one of those
	// claims against the workspace and pins ONE note naming what drifted, or nothing
	// (the common case, which costs nothing). It rides after the user turn like the
	// workspace note (no cache disturbed), persists with the turn, and each named item
	// carries its new revision, so a change is announced exactly once. Runs on retries
	// too: the app may have moved between the failed attempt and this one.
	const staleNote = stalenessNote(conversation);
	if (staleNote) conversation.push({ role: 'system', content: staleNote });

	const actions: AssistantToolResult[] = [];
	/** The rung this turn asks from, fixed for its whole life: a switch moved mid-turn belongs
	 *  to the next one, never to work already in flight. Null in Auto, which asks nothing. */
	const threshold = APPROVAL_THRESHOLD[msg.approvalMode];
	/** The turn's chronological timeline, assembled here: the panel renders EXACTLY this,
	 *  and the server commits it, so a dropped socket cannot lose the transcript. */
	const steps: AssistantStep[] = [];
	let finalContent = '';
	const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
	/** The last iteration's prompt+completion tokens ≈ the context this tab now occupies. */
	let contextTokens = 0;
	/** The model's reply (or a tool call) was cut by the output-token limit. */
	let lengthCut = false;
	/** The provider flagged an abnormal finish (content filter, refusal, unknown reason)
	 *  on an iteration that still produced something: the reply may be incomplete. */
	let abnormalFinish = false;
	/** What the final iteration reported. Names the failure when a turn ends empty. */
	let lastFinishReason: LLMToolResult['finishReason'] = 'stop';
	/** The turn ended by choice of the model (no more tool calls) rather than a budget. */
	let finishedNaturally = false;

	/** This turn's row id, claimed before the first iteration so every write below targets
	 *  the same row: one turn is one row from 'running' to 'done'. */
	const turnId = crypto.randomUUID();
	/** Stamped by the row's insert below: the transcript's clock is the database's, never
	 *  this side's or the browser's (db.ts). Read by commitTurn, which only ever runs once
	 *  that insert has succeeded. */
	let turnCreatedAt = 0;

	/**
	 * Writes the turn's row as it stands right now, still marked running. Called at every
	 * step boundary, so a server that dies mid-turn leaves every step it already took in the
	 * transcript, instead of durable edits nothing accounts for. Boot marks a surviving
	 * 'running' row interrupted (db.ts).
	 * A gone row means the session was deleted mid-turn; commitTurn reports that.
	 */
	const flushTurnRow = (): void => {
		serverDb.updateAssistantTurn({ id: turnId, content: finalContent.trim(), steps, status: 'running' });
	};

	/** Records one executed or refused tool call in all four places it has to land: the
	 *  turn's action list, its timeline, the live event every watching page renders, and
	 *  the row on disk, so a crash right after a mutation still leaves the step naming it. */
	const recordTool = (uiResult: AssistantToolResult): void => {
		const index = actions.length;
		actions.push(uiResult);
		steps.push({ kind: 'tool', tool: uiResult });
		send({ t: 'assistant-tool-result', index, result: uiResult });
		flushTurnRow();
	};

	/** Finalizes the turn's row (single writer), bumps the session, and hands the persisted
	 *  message back so the done/error event can carry it to the requesting client. Owning
	 *  the row here (not in the client) is what makes a turn survive a dropped socket.
	 *  Returns null when the session vanished mid-turn (deleted on another device). */
	const commitTurn = (opts: { error?: string; stopped?: boolean; capped?: boolean }): Record<string, unknown> | null => {
		const warnings: string[] = [];
		if (lengthCut) warnings.push('_⚠ The output-token limit cut this turn short at least once. Raise “Max tokens” on the Assistant’s connection (Settings → Connections) if this keeps happening._');
		if (abnormalFinish) warnings.push('_⚠ The provider flagged an abnormal finish (possibly a content filter). The reply may be incomplete._');
		if (persistFailed) warnings.push('_⚠ Saving this tab’s working memory failed. The next turn may not remember this one._');
		if (opts.capped) warnings.push('_⏸ Turn budget reached. The work may be unfinished._');
		if (opts.stopped) warnings.push('_⏹ Stopped by you._');
		let content = finalContent.trim();
		if (warnings.length) {
			const suffix = warnings.join('\n');
			content = content ? `${content}\n\n${suffix}` : suffix;
			steps.push({ kind: 'text', text: (steps.length ? '\n\n' : '') + suffix });
		}
		const usageBlob = {
			...totalUsage,
			...(contextTokens > 0 ? { contextTokens } : {}),
			...(opts.capped ? { capped: true } : {})
		};
		const usage = usageBlob.totalTokens > 0 || usageBlob.contextTokens || usageBlob.capped ? usageBlob : undefined;
		const message = {
			id: turnId,
			sessionId: msg.assistantSessionId,
			role: 'assistant',
			content,
			...(steps.length ? { steps } : {}),
			// capped alone matters (Continue button) even when a provider reports no usage.
			...(usage ? { usage } : {}),
			...(opts.error ? { error: opts.error } : {}),
			createdAt: turnCreatedAt
		};
		let written: boolean;
		try {
			written = serverDb.updateAssistantTurn({ id: turnId, content, steps, usage, error: opts.error, status: 'done' });
		} catch (e) {
			// A write that THREW is a real lost transcript (disk full, a locked db) and
			// must surface rather than be shrugged off.
			throw new Error(`The turn ran, but saving its transcript failed: ${e instanceof Error ? e.message : e}`);
		}
		if (!written) {
			// The row is gone. Only a session deleted mid-turn (on another device) takes it
			// with it; anything else means the row was removed under a running turn, which
			// nothing is allowed to do.
			if (!serverDb.getAssistantSession(msg.assistantSessionId)) {
				console.warn('[assistant] turn finished on a deleted session; transcript not recorded.');
				return null;
			}
			throw new Error(`The turn ran, but its transcript row (${turnId}) disappeared while it was running.`);
		}
		// The session remembers which chat it most recently worked against (latest
		// non-null wins): history rows can answer "which chat was this about".
		serverDb.updateAssistantSession({ id: msg.assistantSessionId, updatedAt: Date.now(), ...(chatId ? { chatId } : {}) });
		broadcast('assistant');
		return message as unknown as Record<string, unknown>;
	};

	// The debug-log id of the iteration prompt still awaiting its result, so the
	// catch below can settle it instead of leaving an eternally in-flight entry.
	let pendingPromptId: string | null = null;
	// The image attachment this turn injected that no request has carried yet. A provider
	// that refuses an image refuses it every later turn too, so persisting it would leave
	// the tab dead. The catch below strips it.
	let unsentImages: LLMToolMessage | null = null;

	try {
		// Claim the turn's row before anything runs. From here on the transcript exists on
		// disk and grows with the turn, so nothing the assistant does can happen without a
		// row that names it: a failure below commits this same row with its error.
		turnCreatedAt = serverDb.insertAssistantMessage({
			id: turnId,
			sessionId: msg.assistantSessionId,
			role: 'assistant',
			content: '',
			status: 'running'
		});

		// Stamp the RESOLVED attachment modes onto the user row the client inserted, and
		// tell every watching page: the truth of what rode with the message, decided only
		// here (the size limit and the already-in-context check both live in the builder).
		// Skipped on a matched retry: the original note rode again, so the row already
		// states it. The event is deliberately not folded into the live snapshot: the row
		// is persisted before any page could ask for one, so a reload reads it from the db.
		if (noteBuild) {
			const wrote = serverDb.setAssistantMessageAttachments(msg.userMessageId, msg.assistantSessionId, noteBuild.sent);
			if (!wrote && serverDb.getAssistantSession(msg.assistantSessionId)) {
				throw new Error(`The user message row (${msg.userMessageId}) for this turn is missing, so the turn cannot be recorded honestly.`);
			}
			send({ t: 'assistant-attachments', messageId: msg.userMessageId, attachments: noteBuild.sent });
		}

		// Bind this turn's attached files to the user row, so the transcript says which turn
		// each one arrived on. The write only touches rows still unbound, so a retry (which
		// re-runs a turn whose files were bound the first time) cannot re-home anything.
		if (msg.files?.length) serverDb.stampAssistantFiles(msg.assistantSessionId, msg.files, msg.userMessageId);
		// Every file this tab holds, read AFTER the stamp so this turn's are in it. Staged
		// but unsent files are excluded: the user has not handed them over yet.
		const attachedFiles = serverDb.listAssistantFiles(msg.assistantSessionId).filter((f) => f.messageId !== null);

		// A model switch can shrink the window under a tab's stored context: fit the
		// conversation to the CURRENT window before the first iteration, not only at
		// persist time. When even trimming can't fit it (one giant turn), refuse HERE
		// with the way out, instead of letting the provider 400 on this turn and
		// every turn after it.
		if (windowTokens) {
			// The fixed head alone can outgrow a small window, and no amount of trimming
			// touches it. Say so instead of blaming the conversation.
			if (overheadTokens >= windowTokens) {
				throw new Error(
					`The assistant's fixed prompt head (~${Math.round(overheadTokens / 1000)}k tokens: its instructions plus ${tools.length} tool definitions) does not fit the Assistant connection's ${Math.round(windowTokens / 1000)}k-token context size, so no message can be sent at all. Raise Context Size on that connection in Settings → Connections, or point the Assistant surface at a larger model.`
				);
			}
			const fitted = trimConversation(balanceToolCalls(conversation), conversationWindow);
			conversation.length = 0;
			conversation.push(...fitted);
			const estimated = estimateConversationTokens(conversation) + overheadTokens;
			if (estimated > windowTokens) {
				throw new Error(
					`This tab's working memory (~${Math.round(estimated / 1000)}k tokens estimated, including a ~${Math.round(overheadTokens / 1000)}k fixed prompt head) no longer fits the Assistant connection's ${Math.round(windowTokens / 1000)}k-token context size, and nothing more can be trimmed safely. Open a new assistant tab for further work, or raise Context Size on that connection in Settings → Connections.`
				);
			}
		}
		/**
		 * The turn's LIVE claims ledger: what this conversation claims about each tracked
		 * thing, read by the overwrite gate (assertClaimFresh, registry/util.ts) through the
		 * tool context. Seeded AFTER the fit above, from the context exactly as this request
		 * sends it, so a trim that dropped a claim drops it here too: the ledger and the
		 * model forget together. Kept current below as each tool result lands: a ledger
		 * frozen at the turn's start would refuse the model's second write to a thing its
		 * own first write just re-stamped.
		 */
		const claims = collectStateClaims(conversation);
		for (let iteration = 0; iteration < MAX_ASSISTANT_ITERATIONS; iteration += 1) {
			if (signal.aborted) break;

			const messages: LLMToolMessage[] = [{ role: 'system', content: systemPrompt }];
			// Image paths ride the request only when the provider/model takes them; the
			// persisted context keeps them either way, so switching to a vision model
			// later makes past attachments visible again instead of losing them.
			messages.push(...(sendImages ? conversation : conversation.map(({ images: _images, ...m }) => m)));
			if (attachmentRoster) messages.push({ role: 'system', content: attachmentRoster });
			// Rebuilt per step so its room figure is true when the model reads it, the whole
			// reason it is not persisted with the conversation.
			const fileRoster = describeAttachedFiles(attachedFiles, roomTokens ? roomTokens() : null);
			if (fileRoster) messages.push({ role: 'system', content: fileRoster });
			const remaining = MAX_ASSISTANT_ITERATIONS - iteration;
			if (remaining <= ASSISTANT_BUDGET_WARN_REMAINING) {
				messages.push({
					role: 'user',
					content: `(internal: ${remaining} of ${MAX_ASSISTANT_ITERATIONS} steps remain this turn. Finish the piece of work in progress and stop cleanly. If work remains, end with a short list of what is left. The user can press Continue to resume.)`
				});
			}
			if (iteration > 0) send({ t: 'assistant-iteration', iteration: iteration + 1 });

			// Providers report the FULL accumulated arguments on every tool-call delta, which
			// is quadratic wire traffic over a big edit (a 100KB rewrite would push hundreds
			// of MB through the WS). Throttle per call and forward only the single readable
			// line the panel puts in the running row (toolProgress.ts). The real arguments
			// arrive with the result, verbatim, on the same step.
			const progressSent = new Map<number, { at: number; text: string }>();
			const sendToolProgress = (progress: { index: number; name: string; argumentsSoFar: string }) => {
				const nowMs = Date.now();
				const last = progressSent.get(progress.index);
				if (last && nowMs - last.at < 150) return;
				const text = toolProgressText(progress.argumentsSoFar);
				progressSent.set(progress.index, { at: nowMs, text });
				// The FIRST frame of a call always goes out: it is what puts the running row on
				// screen. After that only a changed line earns one: a call whose long value has
				// closed would otherwise repaint the same text for the rest of its arguments.
				if (last && text === last.text) return;
				send({ t: 'assistant-tool-progress', progress: { index: progress.index, name: progress.name, text } });
			};

			// Capture the exact prompt + tool defs this iteration sends, so the debug panel
			// shows the assistant's real assembled query, not the user's typed line alone. The
			// recorder no-ops server-side when no client is debugging.
			pendingPromptId = `${msg.id}:${iteration + 1}`;
			recordPrompt?.({
				id: pendingPromptId,
				source: 'assistant',
				kind: 'assistant',
				provider: msg.provider,
				model: msg.model,
				messages: messages.map((m) => ({ ...m })) as PromptLogEntry['messages'],
				params: msg.params,
				// max_tokens/temperature live in params; surface the effective values for the log.
				maxTokens: numParam(msg.params, 'max_tokens') ?? numParam(msg.params, 'max_completion_tokens'),
				temperature: numParam(msg.params, 'temperature'),
				stream: msg.stream,
				tuning: msg.tuning,
				routing: msg.routing,
				tools,
				iteration: iteration + 1,
				assistantSessionId: msg.assistantSessionId,
				startedAt: Date.now(),
				status: 'pending'
			});

			const result = await completeWithTransientRetry(
				msg.connectionId,
				msg.provider,
				{
					model: msg.model,
					messages,
					tools,
					params: msg.params,
					tuning: msg.tuning,
					routing: msg.routing,
					signal,
					// The Assistant connection's Stream response setting decides this, the same
					// way it decides a chat send: the providers read "streaming" off the presence
					// of onToken, so withholding the callbacks IS the non-streamed request. The
					// step then lands whole: no reply deltas, no running tool rows.
					onToken: msg.stream ? (token) => send({ t: 'assistant-reply', delta: token }) : undefined,
					onThinkingToken: msg.stream ? (token) => send({ t: 'assistant-thinking', delta: token }) : undefined,
					onToolCallDelta: msg.stream ? sendToolProgress : undefined
				},
				signal
			);
			// The provider took this request, so whatever it carried is provably sendable.
			unsentImages = null;

			// The wire-shape tool calls (raw arguments preserved): patched onto the debug
			// entry here and replayed to the model on the next iteration below.
			const wireToolCalls: NonNullable<LLMToolMessage['tool_calls']> = result.toolCalls.map((c) => ({
				id: c.id,
				type: 'function',
				function: { name: c.name, arguments: c.rawArguments || JSON.stringify(c.arguments) }
			}));
			// Settle the debug entry with the real envelope BEFORE any turn-level throw:
			// what the provider returned (even an empty abnormal finish) is exactly what
			// the panel exists to show.
			recordResult?.(pendingPromptId, {
				// A stopped iteration RESOLVES with what it streamed (architecture/llm-providers.md),
				// so the finish reason is what says whether this step was cancelled.
				status: result.finishReason === 'cancelled' ? 'cancelled' : 'done',
				endedAt: Date.now(),
				usage: result.usage,
				finishReason: result.finishReason,
				responseContent: result.content || undefined,
				responseThinking: result.thinking ?? undefined,
				responseToolCalls: wireToolCalls.length ? wireToolCalls : undefined
			});
			pendingPromptId = null;

			totalUsage.promptTokens += result.usage.promptTokens;
			totalUsage.completionTokens += result.usage.completionTokens;
			totalUsage.totalTokens += result.usage.totalTokens;
			totalUsage.cachedTokens += result.usage.cachedTokens ?? 0;
			contextTokens = result.usage.promptTokens + result.usage.completionTokens;
			lastFinishReason = result.finishReason;
			if (result.finishReason === 'length') lengthCut = true;
			// An abnormal finish with nothing usable is an error, not a silent empty turn.
			if (result.finishReason === 'error' && !result.content.trim() && !result.toolCalls.length) {
				throw new Error('The model produced no usable output (the provider reported an abnormal finish). Try again or check the provider.');
			}
			// An abnormal finish WITH partial output commits, but flagged: presenting a
			// filtered or truncated reply as a clean finish would be a silent lie.
			if (result.finishReason === 'error') abnormalFinish = true;
			if (result.thinking) steps.push({ kind: 'thinking', text: result.thinking });
			// Blank-line join, not concatenation: a preamble ("Reading the character…") and
			// the final reply come from separate iterations and must not run together.
			if (result.content) {
				steps.push({ kind: 'text', text: result.content });
				finalContent = finalContent ? `${finalContent}\n\n${result.content}` : result.content;
			}
			flushTurnRow();

			// Record the assistant turn (with any tool calls) for the next iteration.
			const assistantMessage: LLMToolMessage = { role: 'assistant', content: result.content };
			if (wireToolCalls.length) assistantMessage.tool_calls = wireToolCalls;
			conversation.push(assistantMessage);

			if (!result.toolCalls.length) {
				finishedNaturally = true;
				break;
			}

			// What the user refused when shown this step's calls. Asked ONCE per model step,
			// before anything runs: the whole point of approval is that the moment to say
			// "not that one" is the moment before it happens.
			const toolContext: AssistantContext = {
				permissions: effective,
				broadcast,
				sendImages,
				userImages,
				turnImages,
				ask: askQuestions,
				claims,
				assistantSessionId: msg.assistantSessionId,
				roomTokens
			};
			const refusedByUser = new Set<string>();
			const runnable = result.toolCalls.filter((c) => !signal.aborted && (!c.rawArguments?.trim() || parseable(c.rawArguments)));
			const needing = threshold ? runnable.filter((c) => needsApproval(msg.approvalMode, c.name)) : [];
			if (needing.length) {
				const calls = needing.map((c) => previewCall(result.toolCalls.indexOf(c), c.name, c.arguments, toolContext));
				// The same threshold again, now against where each call ACTUALLY landed: the pass
				// above had to assume the worst for a tool whose rung lives in its arguments, and
				// this one drops the ones whose preview came back below the line.
				const asked = calls.filter((c) => riskAtLeast(c.risk, threshold!));
				if (asked.length) {
					const outcome = await requestApproval(asked);
					const approved = new Set(outcome.approved);
					for (const c of asked) if (!approved.has(c.index)) refusedByUser.add(result.toolCalls[c.index].id);
				}
			}

			// Images a tool asked to show the model this iteration. They must be attached
			// AFTER every tool result is pushed: a user message wedged between an
			// assistant tool_calls turn and its tool results is a protocol violation.
			const pendingImages: string[] = [];
			for (const call of result.toolCalls) {
				// Every tool_call the assistant just made MUST get a matching tool result,
				// or the persisted conversation is unbalanced and the provider rejects the
				// next turn (Anthropic 400: dangling tool_use). On abort we don't run the
				// tool, but we still record a result so replay stays valid.
				if (signal.aborted) {
					conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ ok: false, error: 'Stopped by user before this tool ran.' }) });
					continue;
				}
				if (actions.length >= MAX_ASSISTANT_ACTIONS) {
					conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ ok: false, error: 'Action cap reached for this turn.' }) });
					continue;
				}
				// Arguments that failed to parse were silently downgraded to {} by the stream
				// layer. For tools whose params are all optional that would mean "run the
				// default read" instead of what the model asked for, a silent wrong answer.
				// Detect it here and refuse loudly so the model re-issues the call.
				if (call.rawArguments?.trim() && !parseable(call.rawArguments)) {
					const message = `The arguments of this ${call.name} call arrived as invalid JSON, so the tool did NOT run (this usually means the output-token limit cut the call short). Re-issue the call with complete arguments; split large edits if needed.`;
					const uiResult: AssistantToolResult = { type: call.name, label: `${call.name}: invalid arguments`, error: message };
					recordTool(uiResult);
					conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ ok: false, error: message }) });
					continue;
				}
				if (refusedByUser.has(call.id)) {
					const message = 'The user reviewed this call and refused it, so it did NOT run. Do not retry it. Carry on with the rest of the work and say plainly, at the end, what you did not do.';
					const uiResult: AssistantToolResult = { type: call.name, label: `${call.name}: refused by you`, error: message };
					recordTool(uiResult);
					conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ ok: false, error: message }) });
					continue;
				}
				const { uiResult, toolMessage, injectImages } = await dispatch(call.name, call.arguments, toolContext);
				// Auditability: the panel can expand any step to see what was asked (args) and
				// what came back. This display copy is stored whole, like the model's copy below:
				// a cut audit trail cannot answer "what did it actually read", which is the
				// only reason the copy exists, and the panel scrolls it anyway. args are skipped
				// when a diff already carries the payload (whole-field edits).
				if (!uiResult.diff && call.arguments && Object.keys(call.arguments).length) uiResult.args = call.arguments;
				if (!uiResult.error) uiResult.resultPreview = toolMessage;
				recordTool(uiResult);
				// Stored VERBATIM, deliberately: tool results are never shortened or cut, at any
				// size. The panel's context meter makes the cost visible; managing it (or opening
				// a new tab) is the user's call. A cut here corrupts the JSON the model reads back
				// and silently degrades every later turn, the original sin this loop had once.
				conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: toolMessage });
				// Fold the result's stamps into the live ledger the moment they exist, through
				// the same scan the per-turn check reads, so the gate and the state note can
				// never disagree about what a claim is.
				for (const [key, rev] of collectStateClaims([{ role: 'tool', content: toolMessage }])) claims.set(key, rev);
				if (injectImages?.length) pendingImages.push(...injectImages);
			}
			if (pendingImages.length) {
				// An image already in the conversation is already visible to the model:
				// re-attaching it would just re-inline the same bytes on every request
				// (auto-attached portraits would otherwise duplicate on every read).
				const already = new Set(conversation.flatMap((m) => m.images ?? []));
				const fresh = [...new Set(pendingImages)].filter((p) => !already.has(p));
				const injected: LLMToolMessage = fresh.length
					? { role: 'user', content: '(automatic attachment: the requested/portrait images)', images: fresh }
					: { role: 'user', content: '(the requested image(s) are already attached earlier in this conversation)' };
				conversation.push(injected);
				if (fresh.length) unsentImages = injected;
			}

			if (actions.length >= MAX_ASSISTANT_ACTIONS) break;
			// No break on finish_reason here: we already stopped above when the model made
			// no tool calls. When it DID call tools, we loop back so it can see the results,
			// even if the provider tagged the turn "stop" instead of "tool_calls" (some
			// OpenRouter backends do), because otherwise the model never sees what it asked for
			// and the user gets a bare "Done." with the real answer stranded.
		}

		persist();

		if (signal.aborted) {
			const committed = commitTurn({ stopped: true });
			send({ t: 'assistant-done', content: String(committed?.content ?? ''), actions, usage: totalUsage, contextTokens, stopped: true, ...(committed ? { committed } : {}) });
			return;
		}

		// A turn with no reply AND no action is a failure, not a shrug: name the finish
		// reason so the user sees WHY (and gets Retry) instead of a bare "No reply."
		// (A stream that closed truncated already threw in the provider with its own cause;
		// this branch is the model genuinely ending an empty turn.)
		if (!finalContent.trim() && !actions.length) {
			throw new Error(
				lastFinishReason === 'length'
					? 'The model spent its whole output budget without producing a reply (long reasoning can do this). Raise “Max tokens” on the Assistant’s connection (Settings → Connections) or lower the reasoning effort.'
					: `The model ended its turn (finish reason: ${lastFinishReason}) without a reply or a tool call. This usually means the assistant model doesn’t properly support tool-calling, or a local endpoint returned an empty completion. Try a model with solid tool support, or press Retry.`
			);
		}

		// The loop ended by budget, not by the model's choice. The work may be
		// unfinished. The flag drives the panel's Continue button.
		const capped = !finishedNaturally;
		const committed = commitTurn({ capped });
		send({
			t: 'assistant-done',
			content: String(committed?.content ?? finalContent.trim()),
			actions,
			usage: totalUsage,
			contextTokens,
			...(capped ? { capped: true } : {}),
			...(committed ? { committed } : {})
		});
	} catch (e) {
		// A rejected request never reached the model, and its images would be rejected the
		// same way every later turn: persisting them dead-ends the tab. Keep the message,
		// drop the bytes, name the files. An abort is not a rejection.
		if (unsentImages?.images && !(e instanceof Error && e.name === 'AbortError')) {
			const dropped = unsentImages.images;
			unsentImages.content = `(note: ${dropped.length} image${dropped.length === 1 ? '' : 's'} could not be sent to this model and ${dropped.length === 1 ? 'was' : 'were'} left out of this conversation: ${dropped.join(', ')}. The request they rode was refused: the model's provider may not read that image format.)`;
			delete unsentImages.images;
		}
		persist();
		// An iteration prompt whose completion never returned: settle its debug entry
		// so the log doesn't show an eternally in-flight request.
		if (pendingPromptId) {
			recordResult?.(pendingPromptId, {
				status: e instanceof Error && e.name === 'AbortError' ? 'cancelled' : 'error',
				endedAt: Date.now(),
				error: e instanceof Error ? e.message : String(e)
			});
			pendingPromptId = null;
		}
		if (e instanceof Error && e.name === 'AbortError') {
			const committed = commitTurn({ stopped: true });
			send({ t: 'assistant-done', content: String(committed?.content ?? ''), actions, usage: totalUsage, contextTokens, stopped: true, ...(committed ? { committed } : {}) });
			return;
		}
		// The failed turn is committed WITH its partial steps and the error, so the
		// transcript stays honest on every device (and Retry has a row to replace);
		// the context reading rides along so the meter never goes stale.
		const message = e instanceof Error ? e.message : String(e);
		const committed = commitTurn({ error: message });
		send({ t: 'assistant-error', message, actions, contextTokens, ...(committed ? { committed } : {}) });
	}
}

/**
 * Where each mode draws its line on the read < write < delete ladder: the whole approval
 * policy, as two entries. Manual asks about everything that changes anything and lets reads
 * run untouched; Auto asks about nothing.
 *
 * A mode is one line and nothing else. That is what makes it predictable: no per-tool list to
 * remember, no size at which a write quietly becomes a question, and (since the card's mark is
 * drawn from the same rung) no call that reads as permanent yet was never shown.
 */
const APPROVAL_THRESHOLD: Record<ApprovalMode, RiskClass | null> = { manual: 'write', auto: null };

/**
 * Whether this call has to be seen before it runs, judged by NAME alone, the cheap pass that
 * runs before anything is priced. A tool whose rung depends on its arguments answers `delete`
 * here so it reaches the preview at all; the caller then re-asks the same question against
 * where the call actually landed.
 *
 * Exported for the registry smoke script: this is the whole safety policy, and a wrong answer
 * here means a call runs without ever being shown.
 */
export function needsApproval(mode: ApprovalMode, tool: string): boolean {
	const threshold = APPROVAL_THRESHOLD[mode];
	return threshold ? riskAtLeast(riskCeiling(tool), threshold) : false;
}

/**
 * Drops image paths whose files no longer exist from the conversation's messages,
 * except `strict` paths (this turn's fresh uploads), which must fail loudly instead.
 * Returns the healed paths. Mutates in place; the caller persists, so the healing
 * sticks and the dead path can never fail another request.
 */
function healMissingImages(conversation: LLMToolMessage[], strict: Set<string>): string[] {
	const healed = new Set<string>();
	for (const message of conversation) {
		if (!message.images?.length) continue;
		const alive = message.images.filter((p) => strict.has(p) || imageFileExists(p) || (healed.add(p), false));
		if (alive.length !== message.images.length) {
			if (alive.length) message.images = alive;
			else delete message.images;
		}
	}
	return [...healed];
}

// ===== LLM call resilience =====

function parseable(raw: string): boolean {
	try {
		JSON.parse(raw);
		return true;
	} catch {
		return false;
	}
}

/** Errors worth retrying: rate limits, gateway/server blips, network timeouts. */
function isTransientLlmError(e: unknown): boolean {
	if (!(e instanceof Error) || e.name === 'AbortError') return false;
	if (/\b(408|425|429|500|502|503|504|522|524)\b/.test(e.message)) return true;
	return /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|fetch failed|socket|overloaded|temporarily unavailable|too many requests/i.test(
		e.message
	);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			const err = new Error('Aborted');
			err.name = 'AbortError';
			reject(err);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * completeWithTools with a small backoff retry on transient provider errors, so a
 * single 429/5xx/network blip doesn't kill a whole multi-step turn. Retries ONLY
 * while nothing of this attempt has streamed to the client: once tokens or
 * tool-call deltas went out, a silent re-run would duplicate them; the error
 * surfaces instead (the panel's Retry continues the turn).
 */
async function completeWithTransientRetry(
	connectionId: string,
	provider: string,
	options: LLMToolStreamOptions & { routing?: RoutingConfig | null },
	signal: AbortSignal
): Promise<LLMToolResult> {
	for (let attempt = 1; ; attempt += 1) {
		let streamed = false;
		const tap =
			<A extends unknown[]>(fn?: (...args: A) => void) =>
			fn
				? (...args: A) => {
						streamed = true;
						fn(...args);
					}
				: undefined;
		try {
			return await completeWithTools(connectionId, provider as never, {
				...options,
				onToken: tap(options.onToken),
				onThinkingToken: tap(options.onThinkingToken),
				onToolCallDelta: tap(options.onToolCallDelta)
			});
		} catch (e) {
			if (attempt >= MAX_LLM_ATTEMPTS || streamed || signal.aborted || !isTransientLlmError(e)) throw e;
			await sleep(attempt === 1 ? 1000 : 3000, signal);
		}
	}
}

// ===== The user's image attachments (addressable by number) =====

/**
 * Every image the user has attached in this assistant tab, oldest first: the numbering
 * `edit_character_images` resolves "attachment N" against.
 *
 * Read from the persisted transcript, not the model-facing context: the context is
 * trimmed at ~120 messages, which would silently renumber the roster and hand the assistant
 * the wrong picture. A user turn is never deleted (only a failed ASSISTANT turn is, on
 * retry), so this list is append-only and a number keeps its meaning for the tab's life.
 * This turn's user message is already inserted by the time the turn runs, so it's here.
 */
function collectUserImages(assistantSessionId: string): string[] {
	const rows = serverDb.getAssistantMessages(assistantSessionId) as { role: string; images?: string[] }[];
	const out: string[] = [];
	for (const m of rows) {
		if (m.role === 'user' && Array.isArray(m.images)) out.push(...m.images);
	}
	return out;
}

/**
 * The per-request note that teaches the model the attachment numbering and, when the
 * model has no eyes, says so. Stripping images silently would leave the assistant confidently
 * describing a picture it never received; it can still file one by number, blind.
 */
function describeAttachments(userImages: string[], turnImages: string[], sendImages: boolean): string {
	if (!userImages.length) return '';
	const total = userImages.length;
	const parts = [
		`(internal: the user has attached ${total} image${total === 1 ? '' : 's'} in this conversation. edit_character_images addresses them as "attachment 1"–"attachment ${total}", oldest first; the numbering never shifts.`
	];
	if (turnImages.length) {
		const first = total - turnImages.length + 1;
		parts.push(
			turnImages.length === 1
				? ` This turn's is attachment ${total}: a bare "attachment" means it.`
				: ` This turn's are attachments ${first}–${total}.`
		);
	} else {
		parts.push(' Nothing is attached to this turn.');
	}
	if (!sendImages) {
		parts.push(' The current assistant model CANNOT receive images: never guess what any of them show. Say it is not vision-capable and point the user at Settings → Connection → Assistant Model. You can still file them by number.');
	}
	return parts.join('') + ')';
}

// ===== The user's attached files (read with tools, never injected) =====

/**
 * The per-request note that says which files this tab holds, what each one is, what reading
 * one would cost, and how much room is left to spend.
 *
 * Rebuilt on every model step and never persisted, which is what makes the room figure
 * usable at all: a number written into the stored context would still be claiming "48k
 * left" ten turns after it was true. Contents never ride here: a file is read with
 * `read_file`, in ranges the room can actually pay for.
 */
function describeAttachedFiles(files: AssistantFileRow[], room: number | null): string {
	if (!files.length) return '';
	const lines = files.map(
		(f) => `- ${f.name} (id: ${f.id}): ${fileKindLabel(f.kind)}, ${f.lines} lines, ~${f.tokenEstimate} tokens to read whole`
	);
	const budget =
		room === null
			? ''
			: ` This conversation has ~${room} tokens of room left, so anything larger has to be searched and read in ranges rather than read whole.`;
	return `(internal: ${files.length} file${files.length === 1 ? ' is' : 's are'} attached to this conversation as read-only reference material.${budget}\n${lines.join('\n')})`;
}

// ===== Context growth control =====

/** Persisted context stays bounded: once it passes this many messages, oldest turns drop. */
const MAX_CONTEXT_MESSAGES = 120;
/** When trimming fires it drops down to here, not just under the cap, so the prefix a
 *  prompt cache keys on shifts once every ~40 turns instead of on every single turn. */
const CONTEXT_TRIM_TARGET = 80;
/** The token-denominated ceiling/target, as fractions of the space the conversation
 *  actually has: the reported window MINUS the request's fixed head (system prompt +
 *  tool schemas; see `overheadTokens`). A heavy tab (big lorebook reads) hits the token
 *  wall long before 120 messages, so the count rule alone let it grow until every turn
 *  died on a provider 400 with no recovery. Past ceiling×budget the oldest whole turns
 *  drop (the same real-user-boundary cut as the count trim; a surviving tool result is
 *  still never shortened) down to target×budget, so the wall is approached with headroom
 *  and the cache prefix shifts rarely, not every turn. */
const CONTEXT_WINDOW_CEILING = 0.7;
const CONTEXT_WINDOW_TARGET = 0.55;
/** Flat token estimate per attached image, bounded by the loop's dedupe + view caps. */
const IMAGE_TOKEN_ESTIMATE = 1000;

function estimateMessageTokens(m: LLMToolMessage): number {
	let chars = m.content.length;
	if (m.tool_calls) {
		for (const c of m.tool_calls) chars += c.function.name.length + c.function.arguments.length;
	}
	return Math.ceil(chars / ESTIMATE_CHARS_PER_TOKEN) + 8 + (m.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
}

function estimateConversationTokens(conversation: LLMToolMessage[]): number {
	return conversation.reduce((n, m) => n + estimateMessageTokens(m), 0);
}
/**
 * Guarantees every assistant tool_call has a matching tool result before the context is saved.
 * The happy path already pairs them inline; this only bites when a turn died BETWEEN the
 * assistant's tool_calls and its results (e.g. a mid-loop network throw), which would otherwise
 * persist a dangling tool_use that the provider rejects on the next turn (Anthropic 400),
 * turning one failed turn into a permanently stuck conversation that every retry re-breaks.
 */
function balanceToolCalls(conversation: LLMToolMessage[]): LLMToolMessage[] {
	const answered = new Set<string>();
	for (const m of conversation) {
		if (m.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id);
	}
	const out: LLMToolMessage[] = [];
	for (const m of conversation) {
		out.push(m);
		if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
		for (const call of m.tool_calls) {
			if (answered.has(call.id)) continue;
			answered.add(call.id);
			out.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify({ ok: false, error: 'No result: the turn ended before this tool ran.' }) });
		}
	}
	return out;
}

/** Matches the trim note this module prepends, capturing the cumulative dropped count. */
const TRIM_NOTE_RE = /^\(memory note: (\d+) older messages/;

/** User-role messages the LOOP wedged in (image injections), not real turn boundaries. */
function isInternalUserMessage(m: LLMToolMessage): boolean {
	return m.role === 'user' && (m.content.startsWith('(automatic attachment:') || m.content.startsWith('(the requested image'));
}

/**
 * Bounds the persisted assistant context so a long-lived tab can't grow without limit,
 * in BOTH units that matter: message count (MAX_CONTEXT_MESSAGES → CONTEXT_TRIM_TARGET)
 * and, when the connection reports a window, estimated tokens (ceiling → target
 * fractions above). `budgetTokens` is the space the CONVERSATION has, i.e. the window
 * minus the request's fixed head; the caller subtracts that head, so nothing here has to
 * know about prompts or tool schemas. Either ceiling breached drops the OLDEST whole
 * turns, always cutting at a REAL user-message boundary (never at an image-injection
 * message the loop itself wedged in, which would open the context mid-turn) so an
 * assistant tool_call is never split from its tool results, and a surviving tool result
 * is still never shortened. A trim is never silent: a leading system note carries the
 * cumulative dropped count.
 */
function trimConversation(conversation: LLMToolMessage[], budgetTokens: number | null): LLMToolMessage[] {
	let out = conversation;
	let dropped = 0;
	// Peel off a prior trim note (and its count) so it never blocks the boundary search.
	const prior = out[0]?.role === 'system' ? TRIM_NOTE_RE.exec(out[0].content) : null;
	if (prior) {
		dropped = Number(prior[1]);
		out = out.slice(1);
	}
	// null means the connection reported no window, so only the message count bounds this.
	// A budget of ZERO is not that: it means the fixed head fills the whole window and the
	// conversation is allowed nothing, so it must trim as far as the boundary rule permits.
	const ceiling = budgetTokens === null ? Infinity : Math.floor(budgetTokens * CONTEXT_WINDOW_CEILING);
	const target = budgetTokens === null ? Infinity : Math.floor(budgetTokens * CONTEXT_WINDOW_TARGET);
	let estimate = estimateConversationTokens(out);
	if (out.length > MAX_CONTEXT_MESSAGES || estimate > ceiling) {
		while (out.length > CONTEXT_TRIM_TARGET || estimate > target) {
			const nextTurn = out.findIndex((m, i) => i > 0 && m.role === 'user' && !isInternalUserMessage(m));
			if (nextTurn === -1) break; // one giant turn: nothing safe to drop
			dropped += nextTurn;
			for (let i = 0; i < nextTurn; i += 1) estimate -= estimateMessageTokens(out[i]);
			out = out.slice(nextTurn);
		}
	}
	if (dropped > 0) {
		out = [
			{ role: 'system', content: `(memory note: ${dropped} older messages of this conversation were trimmed from working memory. Earlier context may be missing.)` },
			...out
		];
	}
	return out;
}

// ===== Workspace-context injection =====

/** The most a full attachment may occupy, in estimated tokens. It is `INLINE_CONTENT_TOKEN_LIMIT`
 *  (registry/schema.ts), shared with the file reads because it answers the same question:
 *  how much may land unasked. Flat by owner decision, with no second ceiling against the
 *  connection's window, since the fixed prompt head already presumes a real context size.
 *  Over it, the item degrades to an honest pointer; it is never cut, because a half-injected
 *  card the model believes it has read whole is the worst possible outcome. */
const ATTACHMENT_FULL_TOKEN_LIMIT = INLINE_CONTENT_TOKEN_LIMIT;

/** One workspace attachment as the request carries it (mirrored in transport.ts). */
interface RequestAttachment {
	kind: string;
	refId: string;
	full?: boolean;
	selection?: { anchorMessageId: string; text: string; truncated?: boolean; spanCount?: number };
}

/**
 * The turn's workspace note (what the user had open or attached when they sent the
 * message) plus the RESOLVED record of how each item actually went, which the caller
 * writes onto the user row so the transcript's chips state what happened. The note is the
 * ONLY place a workspace id appears: the system prompt is the cached prefix of every
 * request, so nothing that moves as the user navigates may live there.
 *  - Auto-attached "open" items, and every chat or lorebook however attached, go as
 *    one-line pointers with the id: the assistant reads the details with a tool at need.
 *  - An item the user added by hand (`full: true`) goes as the full data inline, and the
 *    header line carries the same freshness claim a read stamps (see WORKSPACE_NOTE_PREFIX)
 *    so the model treats it as read instead of reading it again. Over the size limit, or
 *    already held by this conversation at its current revision, it degrades to a pointer
 *    that says so plainly, claiming nothing, re-sending nothing.
 * Built from the attachments alone: nothing attached (nothing open, or the chip muted)
 * means no note, since a line announcing an absence is a claim the model can act on and
 * costs tokens every turn. The prompt states the rule for working without one.
 */
export function buildWorkspaceNote(
	attachments: RequestAttachment[],
	prior: ClaimSource[]
): { note: string; sent: SentAttachment[] } {
	const pointers: string[] = [];
	const fulls: string[] = [];
	const selections: string[] = [];
	/** The header line's claim tokens, one per full block. Pointers never claim. */
	const claims: string[] = [];
	const sent: SentAttachment[] = [];
	const seen = new Set<string>();
	// What the conversation already holds, for the not-re-sent check below. Only full-mode
	// entries consult it, but one scan up front is cheaper than one per attachment.
	const held = collectStateClaims(prior);
	// Full-mode items resolve FIRST so they win the key dedupe: the auto slot can pointer
	// the same entity the user hand-attached (open its editor while the chip is staged),
	// and first-wins on arrival order would quietly discard the full block.
	const ordered = [...attachments].sort((a, b) => Number(!!b.full) - Number(!!a.full));
	for (const att of ordered) {
		const key = `${att.kind}:${att.refId}`;
		if (!att.refId || seen.has(key)) continue;
		seen.add(key);
		if (att.kind === 'selection') {
			const r = renderSelectionBlock(att.refId, att.selection);
			if (!r) continue;
			selections.push(r.block);
			// A highlight past the client's cap arrives already clipped, and the block says so
			// to the model. The chip must say it too, or the record overstates what went.
			sent.push({
				kind: 'selection',
				refId: att.refId,
				anchorMessageId: att.selection!.anchorMessageId,
				label: r.label,
				mode: att.selection!.truncated ? 'clipped' : 'full'
			});
		} else if (att.kind === 'entry' && att.full) {
			const r = resolveEntryFull(att.refId, held);
			if (!r) continue;
			if (r.mode === 'full') {
				fulls.push(r.text);
				claims.push(r.claim);
			} else {
				pointers.push(r.text);
			}
			sent.push({ kind: 'entry', refId: att.refId, entryType: r.entryType, label: r.label, mode: r.mode });
		} else if (att.kind === 'entry') {
			const r = renderEntryPointer(att.refId);
			if (!r) continue;
			pointers.push(r.line);
			sent.push({ kind: 'entry', refId: att.refId, entryType: r.entryType, label: r.label, mode: 'pointer' });
		} else if (att.kind === 'chat') {
			// A chat never goes in full, hand-added or not: any real thread blows the size
			// limit anyway, and a prose dump would break the seq/branch discipline
			// read_chat_messages pages with. The pointer carries the metadata instead.
			const r = renderChatPointer(att.refId);
			if (!r) continue;
			pointers.push(r.line);
			sent.push({ kind: 'chat', refId: att.refId, label: r.label, mode: 'pointer' });
		} else if (att.kind === 'lorebook') {
			const r = renderLorebookPointer(att.refId);
			if (!r) continue;
			pointers.push(r.line);
			sent.push({ kind: 'lorebook', refId: att.refId, label: r.label, mode: 'pointer' });
		}
	}
	const blocks: string[] = [];
	if (selections.length) blocks.push(selections.join('\n\n'));
	if (pointers.length) blocks.push(pointers.join('\n'));
	if (fulls.length) {
		// The read-equivalence rule rides the section header: one line for the whole
		// section, present exactly when a full block is, instead of a standing sentence in
		// the cached prompt about a note most turns never carry.
		blocks.push(
			`Attached in full. Treat these as already read, exactly as current as a fresh read; do not re-read them unless a state note names them:\n\n${fulls.join('\n\n')}`
		);
	}
	if (!blocks.length) return { note: '', sent: [] };
	// Claim tokens live on the HEADER LINE and nowhere else: the body quotes user content
	// (a selection, card fields), and collectStateClaims deliberately reads only this line
	// of a workspace note so forged tokens in story text can never register a claim.
	return {
		note: `${WORKSPACE_NOTE_PREFIX}${claims.length ? ' ' + claims.join(' ') : ''}
What the user had open or attached when they sent this message; their request most likely concerns it. Use these ids verbatim. Read the details with a tool only if you need them.

${blocks.join('\n\n')}`,
		sent
	};
}

/**
 * The user's live highlight in the chat, the single most important pointer when present.
 * Gives the assistant the exact text and the message it sits in, and tells it to read a window
 * around that message rather than dragging in the whole thread.
 */
function renderSelectionBlock(
	chatId: string,
	selection?: { anchorMessageId: string; text: string; truncated?: boolean; spanCount?: number }
): { block: string; label: string } | null {
	if (!selection?.text?.trim() || !selection.anchorMessageId) return null;
	const chat = serverDb.getChat(chatId) as { title: string } | null;
	const where = chat ? `chat "${chat.title}" (id: ${chatId})` : `chat id ${chatId}`;
	const span = selection.spanCount && selection.spanCount > 1 ? ` spanning ~${selection.spanCount} messages` : '';
	const cut = selection.truncated ? '\n(the highlight is longer than shown: read the full message if you need the rest)' : '';
	return {
		block: [
			`## Highlighted selection: act on THIS`,
			`The user has highlighted text in ${where}, anchored in message id \`${selection.anchorMessageId}\`${span}. Their request almost certainly concerns exactly this passage. To edit it, target that message id; read a window around it with read_chat_messages \`aroundMessageId\`. Do NOT load the whole thread.`,
			'',
			'> ' + selection.text.trim().replace(/\n/g, '\n> ') + cut
		].join('\n'),
		label: chat ? `Selection in "${chat.title}"` : 'Selection'
	};
}

function renderEntryPointer(entryId: string): { line: string; label: string; entryType: 'character' | 'persona' } | null {
	const entry = serverDb.getLibraryEntry(entryId) as RawLibraryEntry | null;
	if (!entry || (entry.type !== 'character' && entry.type !== 'persona')) return null;
	const kind = entry.type === 'persona' ? 'Persona' : 'Character';
	const notes = entry.data?.traits?.creatorNotes?.trim();
	return {
		line: `- ${kind} "${entry.identity.name}" (id: ${entry.id})${notes ? `: ${notes}` : ''}`,
		label: entry.identity.name || 'Untitled',
		entryType: entry.type
	};
}

/** A chat that vanished between the send and this build simply drops out of the note (and
 *  out of the sent record), rather than pointing the model at an id that no longer
 *  resolves. The one line carries what the retired full block did: title, id, bound
 *  character, lorebooks, branch stamp. */
function renderChatPointer(chatId: string): { line: string; label: string } | null {
	const chat = serverDb.getChat(chatId) as RawChat | null;
	if (!chat) return null;
	const details: string[] = [];
	if (chat.characterId) {
		const character = serverDb.getLibraryEntry(chat.characterId) as RawLibraryEntry | null;
		if (character) details.push(`character: ${character.identity.name} (id: ${chat.characterId})`);
	}
	// Through the resolver, never off the character's link list: three of the four layers reach
	// a prompt with no card naming them, and a mute takes one back out.
	const names = chatLorebooks(chat).map((b) => b.name.trim() || 'Untitled lorebook');
	if (names.length) details.push(`lorebooks: ${names.join(', ')}`);
	const meta = details.length ? `: ${details.join('; ')}` : '';
	return { line: `- Chat "${chat.title}" (id: ${chatId})${meta}${describeBranch(chatId)}`, label: chat.title };
}

/** Pointer only, by design: a book's entries can be enormous, and read_lorebook_entries
 *  reads them properly by id. */
function renderLorebookPointer(bookId: string): { line: string; label: string } | null {
	const book = serverDb.getLorebook(bookId) as RawLorebookBook | null;
	if (!book) return null;
	const name = book.name.trim() || 'Untitled lorebook';
	const n = Array.isArray(book.entries) ? book.entries.length : 0;
	return {
		line: `- Lorebook "${name}" (id: ${bookId}): ${n} entr${n === 1 ? 'y' : 'ies'}; read them with read_lorebook_entries`,
		label: name
	};
}

/**
 * Which branch of the chat tree the user is actually reading, stamped into the note. It
 * sits AFTER the user turn, so it costs no cache and (this is the point) the model watches
 * it change in its own context the moment the user swipes or jumps branches, instead of
 * carrying a seq from ten turns ago that now names a different message.
 */
function describeBranch(chatId: string): string {
	const { activeLeafId, branchMessages } = branchStamp(chatId);
	if (!activeLeafId) return '';
	return `. Active branch: ${branchMessages} message${branchMessages === 1 ? '' : 's'}, leaf ${activeLeafId}`;
}

/**
 * One hand-attached entry, resolved to what ACTUALLY goes. The full block is a genuine
 * read (it claims the entry's current revision, so the freshness machinery re-checks it
 * every turn like any read), with two honest degradations, both pointers: over the size
 * limit (never a cut block), and already held by this conversation at its current revision
 * (a deliberate re-attach of unchanged content costs one line, not the whole card).
 */
function resolveEntryFull(
	entryId: string,
	held: Map<string, string>
):
	| { mode: 'full'; text: string; claim: string; label: string; entryType: 'character' | 'persona' }
	| { mode: 'oversize' | 'known'; text: string; label: string; entryType: 'character' | 'persona' }
	| null {
	const entry = serverDb.getLibraryEntry(entryId) as RawLibraryEntry | null;
	if (!entry || (entry.type !== 'character' && entry.type !== 'persona')) return null;
	const block = renderEntryBlock(entry);
	if (!block) return null;
	const kind = entry.type === 'persona' ? 'Persona' : 'Character';
	const label = entry.identity.name || 'Untitled';
	const tokens = estimateTextTokens(block);
	if (tokens > ATTACHMENT_FULL_TOKEN_LIMIT) {
		return {
			mode: 'oversize',
			text: `- ${kind} "${label}" (id: ${entry.id}): the user attached this in full, but at ~${Math.round(tokens / 1000)}k tokens it is over the ${ATTACHMENT_FULL_TOKEN_LIMIT / 1000}k inline limit. None of it is included here; read what you need with read_entity.`,
			label,
			entryType: entry.type
		};
	}
	const key = claimKey(entry.type, entry.id);
	const rev = stampState([entry.type, entry.id]).stateRevs[key];
	if (held.get(key) === rev) {
		return {
			mode: 'known',
			text: `- ${kind} "${label}" (id: ${entry.id}): the user attached this in full, and this conversation already holds it unchanged: use what you have, no re-read needed.`,
			label,
			entryType: entry.type
		};
	}
	return { mode: 'full', text: block, claim: `[${key} rev:${rev}]`, label, entryType: entry.type };
}

function renderEntryBlock(entry: RawLibraryEntry): string {
	// Pull the field list + values from the registry, so this block can never drift from
	// the assistant's own view of an entry. The single source of truth lives in entities.ts.
	const def = getEntity(entry.type);
	const flat = def.read?.(entry.id, { broadcast: () => {} });
	if (!flat) return '';
	const lines: string[] = [];
	for (const field of def.fields) {
		if (field.key === 'name') continue;
		const value = flat.fields[field.key];
		const v = typeof value === 'string' ? value.trim() : '';
		if (v) lines.push(`${field.key}: ${v}`);
	}
	// Read parity: read_entity also reports the entry's art counts and version roster, and
	// "treat this as already read" is only honest if the block carries them too. The empty
	// permission set keeps the portrait bytes out: this builder has no injection channel.
	const art = readEntryImages(entry.id, { permissions: { groups: new Set<string>() }, broadcast: () => {} });
	if (art) lines.push(`images: ${describeEntryArt(art.images)}`);
	const versions = versionSummary(entry.id) as { versions?: { list: { name: string; active: boolean }[] } };
	if (versions.versions) {
		const roster = versions.versions.list.map((v) => (v.active ? `${v.name} (active)` : v.name)).join(', ');
		lines.push(`versions: ${roster} (the fields above are the active variant)`);
	}
	const head = `## ${entry.type === 'persona' ? 'Persona' : 'Character'}: "${flat.title}" (id: ${entry.id})`;
	return lines.length ? `${head}\n${lines.join('\n')}` : head;
}

function describeEntryArt(images: { portrait: boolean; gallery: number }): string {
	if (!images.portrait && !images.gallery) return 'none';
	const parts: string[] = [];
	if (images.portrait) parts.push('portrait');
	if (images.gallery) parts.push(`${images.gallery} gallery image${images.gallery === 1 ? '' : 's'}`);
	return parts.join(' + ');
}
