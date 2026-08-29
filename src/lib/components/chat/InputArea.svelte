<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { countTokens, tokenCalibration } from '$lib/tokenizer';
	import Icon from '$lib/components/ui/Icon.svelte';
	import ChatVersionChip from './ChatVersionChip.svelte';
	import ChatPersonaDialog from './ChatPersonaDialog.svelte';
	import TransformPanel from './TransformPanel.svelte';
	import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
	import { presetService } from '$lib/services/presets.svelte';
	import { chatPresetStore } from '$lib/stores/chatPreset.svelte';
	import { chatPersonaStore } from '$lib/stores/chatPersona.svelte';
	import { presetControlsStore } from '$lib/stores/presetControls.svelte';
	import { regexRulesStore } from '$lib/stores/regex-rules.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { chatSearch } from '$lib/stores/chatSearch.svelte';
	import { chatCursor } from '$lib/stores/chatCursor.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { messageStore } from '$lib/stores/messages.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { memoryStore } from '$lib/memory/store.svelte';
	import { inputDraftStore } from '$lib/stores/inputDraft.svelte';
	import { inputHistoryStore } from '$lib/stores/inputHistory.svelte';
	import { generalSettingsStore } from '$lib/stores/general-settings.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { assemblePrompt } from '$lib/utils/prompt-assembly';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';
	import { relativeClock } from '$lib/utils/time-format.svelte';
	import { llmService } from '$lib/services/llm/provider';
	import { imageService, imageRejectionReason, isImageFile } from '$lib/services/imageService';
	import { duplicateAsksAboutMemory } from '$lib/types/chat';
	import type { Chat, ChatMemoryFootprint, Message, MessageAttachment } from '$lib/types/chat';
	import SteeringPopover from '$lib/components/chat/SteeringPopover.svelte';
	import CommandPalette from './CommandPalette.svelte';
	import DuplicateChatDialog from '$lib/components/sidebar/DuplicateChatDialog.svelte';
	import { db } from '$lib/services/database';
	import { steeringStore } from '$lib/stores/steering.svelte';
	import { noteLabel, steeringTargetForChat } from '$lib/types/steering';
	import {
		COMMAND_GROUPS,
		argSatisfied,
		commandByName,
		matchCommands,
		parseCommandInput,
		runCommand,
		type CommandContext,
		type CommandDef,
		type CommandHost
	} from '$lib/commands/registry';

	interface Props {
		/** `onCommit` fires once the send is certain to proceed, which is what empties the box. */
		onSend: (content: string, attachments?: MessageAttachment[], onCommit?: () => void) => void;
		onCancel?: () => void;
		onInsertDummy?: (role: 'user' | 'assistant') => void;
		onContinue?: () => void;
		onRegenerateLast?: () => void;
		/** Retry's non-destructive half, reached only by `/swipe`. */
		onSwipeLast?: () => void;
		/** A generation is in flight anywhere in the app, which is the composer's whole busy
		 *  state: Send becomes Stop, and every row that would start or rewrite a turn goes
		 *  dead. */
		isStreaming?: boolean;
		/** When a reply this page never started began, or null. The composer is busy either
		 *  way; this is the case where nothing else on screen says why, since there is no
		 *  stream here to paint. */
		generatingSince?: number | null;
	}

	let {
		onSend,
		onCancel,
		onInsertDummy,
		onContinue,
		onRegenerateLast,
		onSwipeLast,
		isStreaming = false,
		generatingSince = null
	}: Props = $props();

	// Typing is harmless while a reply is being written, and a reader who came back to one they
	// cannot even see has the most reason to want the box: they are deciding whether to wait it
	// out or stop it, and a dead box makes that decision in the corner. Only the rows that would
	// START a turn stay disabled, and Send is already Stop. (A reply this page is writing keeps
	// the older rule, where the tokens arriving are the thing to look at.)
	let draftLocked = $derived(isStreaming && generatingSince === null);

	// How long it has run is the whole point of the line: it is what tells a model that is
	// merely slow apart from an endpoint that has stopped answering, and that judgement is
	// the reader's to make. Floored, and never finer than a minute: a second-by-second count
	// invites watching rather than deciding.
	let generatingLine = $derived.by(() => {
		if (generatingSince === null) return '';
		const minutes = Math.floor(Math.max(0, relativeClock.now - generatingSince) / 60_000);
		if (minutes < 1) return 'A reply is generating for this chat.';
		if (minutes < 60) return `A reply has been generating for ${minutes} minute${minutes === 1 ? '' : 's'}.`;
		const hours = Math.floor(minutes / 60);
		return `A reply has been generating for ${hours} hour${hours === 1 ? '' : 's'}.`;
	});

	let content = $state('');
	let inputTokens = $derived(countTokens(content));
	let textareaElement: HTMLTextAreaElement;

	let menuOpen = $state(false);
	let personaDialogOpen = $state(false);

	// The persona currently bound to this chat's user turns (from any user message,
	// since they're uniform once set). Feeds the picker's active mark; null reads as "You".
	let currentChatPersonaId = $derived.by(() => {
		const msgs = chatStore.currentChatState?.allMessages ?? [];
		return msgs.find((m) => m.role === 'user')?.personaId ?? null;
	});

	function openPersonaDialog() {
		menuOpen = false;
		personaDialogOpen = true;
	}

	// Active preset (read-only here; switching lives in the Prompt Builder)
	let currentPresetId = $derived(chatPresetStore.resolvedId);
	let currentPreset = $derived(currentPresetId ? presetService.getEffective(currentPresetId) : null);

	// The token breakdown popup opens on hover/focus-within via CSS (.token-anchor), with no
	// JS state, so there is no race where crossing the gap to the popup dismisses it.

	// Back to the welcome landing. This is a real exit, not just raising the layer: the
	// chat closes to the boot zero state (story map / memory show no chat).
	// Refused mid-generation: the stream writes into the state this tears down.
	function handleGoHome() {
		menuOpen = false;
		if (messageStore.warnIfBusy()) return;
		void chatStore.goHome();
	}

	// The Chats browser. With a chat open it lists this character's chats and can
	// start another one. The composer menu is its only entry point from inside a story.
	function handleOpenChats() {
		menuOpen = false;
		uiStore.openChats();
	}

	// The stats screen covers the whole library rather than this story, so it sits with
	// Home and Chats rather than with the rows that act on the open chat. This and the
	// welcome landing are its only two doors: the TitleBar cluster is for chat tools.
	function handleOpenStats() {
		menuOpen = false;
		uiStore.openOverlay('stats');
	}

	// Another chat with this story's character, greeting and all: the Chats panel's own
	// New chat button without the trip through the panel. Refused mid-generation for the
	// same reason Home is: createChat opens the chat it makes, which swaps out the state
	// the stream writes into. The row is disabled without a resolvable character, so the
	// throw is unreachable and stays loud rather than minting a characterless chat.
	function handleNewChat() {
		menuOpen = false;
		if (messageStore.warnIfBusy()) return;
		const entry = activeCharacterEntry;
		if (!entry) throw new Error('New chat: this story has no library character');
		void chatStore.createChat({ characterId: entry.id });
	}

	// Raises the find-in-chat bar over the message list (MessageList owns the mount).
	// Never disabled: reading back through the story is legal mid-stream.
	function handleFindInChat() {
		menuOpen = false;
		chatSearch.show();
	}

	// The chat's bound character, its lorebook, and the global persona: the world
	// context that the preset macros expand against.
	let activeCharacterEntry = $derived.by(() => {
		const cid = chatStore.activeChat?.characterId;
		if (!cid) return null;
		return characterLibraryStore.entries.find((e) => e.id === cid && e.type === 'character') ?? null;
	});

	// The data this chat actually plays against: its pinned version's, not necessarily
	// the entry's live data. The meter must count exactly what the generation path sends.
	let activeCharacterData = $derived(
		activeCharacterEntry
			? characterLibraryStore.dataForVersion(
					activeCharacterEntry,
					chatStore.activeChat?.characterVersionId ?? null
				)
			: null
	);

	// The live token breakdown is computed from the SAME assembler the real prompt uses
	// (assemblePrompt), so the meter can never drift from what is actually sent. Inputs are
	// sourced reactively from stores here; the generation path sources them from the db.
	let activePath = $derived(chatStore.currentChatState?.activePath ?? []);

	// Steering reads live up here because the meter's assembly below consumes
	// steeringForPrompt. The popover that edits the notes lives in its own component.
	let steeringTarget = $derived(steeringTargetForChat(chatStore.activeChat));
	let activeSteering = $derived(steeringStore.activeFor(steeringTarget));
	let steeringActive = $derived(activeSteering.length > 0);
	let steeringTitle = $derived.by(() => {
		if (activeSteering.length === 0) return 'Steering: guide the next reply';
		const first = noteLabel(activeSteering[0]);
		if (activeSteering.length === 1) return `Steering: ${first}`;
		return `Steering: ${first} (+${activeSteering.length - 1} more)`;
	});

	// The meter's steering input, resolved through the SAME pure resolver prompt-builder
	// uses on the generation side, under the same engine gate, so the meter prices exactly
	// the stack a send would inject (prompt-pipeline coupling 8).
	let steeringForPrompt = $derived.by(() => {
		if (!featurePromptsStore.steeringEnabled) return undefined;
		const notes = steeringStore.resolveForPrompt(steeringTarget);
		if (notes.length === 0) return undefined;
		return { notes, wrapper: featurePromptsStore.promptFor('steeringWrapper') };
	});

	/**
	 * The path a send would assemble against: the thread plus the turn about to be added.
	 *
	 * Sending inserts the user's turn first, so a meter priced against the resting path is one
	 * turn short of what the send injects. The placeholder stands in for that turn, so the
	 * injected history (and the budget trim measured against it) match the real send.
	 *
	 * The placeholder is deliberately EMPTY. The draft's own tokens are the meter's separate
	 * "your message" number; putting them here would count them twice.
	 */
	let pricedPath = $derived.by<Message[]>(() => {
		const last = activePath[activePath.length - 1];
		if (!last) return activePath;
		return [
			...activePath,
			{
				...last,
				id: '__composer_draft__',
				parentId: last.id,
				role: 'user',
				content: '',
				attachments: null,
				thinking: null
			}
		];
	});

	let assembly = $derived(
		currentPreset
			? assemblePrompt({
					preset: currentPreset,
					resolvedPersona: chatPersonaStore.resolved,
					resolvedCharacters: activeCharacterEntry && activeCharacterData
						? [
								{
									name: activeCharacterEntry.identity.name,
									traits: activeCharacterData.traits
								}
							]
						: [],
					lorebooks: lorebookStore.resolveBooks([
						...(activeCharacterData?.lorebookIds ?? []),
						...(chatPersonaStore.resolvedEntry?.data.lorebookIds ?? [])
					]),
					lorebookSettings: lorebookSettingsStore.settings,
					controls: currentPreset.controls ?? [],
					customFields: presetControlsStore.values,
					chatMessages: pricedPath,
					recall: { text: memoryStore.recall || null, archivedIds: memoryStore.archivedMessageIds },
					model: llmService.getPrimaryModel(),
					postProcessing: { mode: llmService.getPromptPostProcessing(), placeholder: llmService.getPromptPlaceholder() },
					contextBudget: llmService.getPromptTokenBudget(),
					regexRules: regexRulesStore.effective,
					steering: steeringForPrompt
				})
			: null
	);

	// The breakdown is a model-aware base estimate; scale it by the active model's learned
	// calibration factor so the meter predicts the provider's real prompt_tokens. One factor
	// applied to every bucket keeps the bar proportional and the parts summing to the total.
	let ratio = $derived(tokenCalibration.ratioFor(llmService.getPrimaryModel()));
	let modelLabel = $derived(llmService.getPrimaryModel());
	let presetTokens = $derived(Math.round((assembly?.breakdown.preset ?? 0) * ratio));
	let contextTokens = $derived(Math.round((assembly?.breakdown.context ?? 0) * ratio));
	let memoryTokens = $derived(Math.round((assembly?.breakdown.memory ?? 0) * ratio));
	let chatTokens = $derived(Math.round((assembly?.breakdown.chat ?? 0) * ratio));
	let totalContextTokens = $derived(Math.round((assembly?.breakdown.total ?? 0) * ratio));
	let trimmedMessages = $derived(assembly?.trimmedMessages ?? 0);
	let overBudget = $derived(assembly?.overBudget ?? false);

	// ===== Persisted draft (per chat, survives reloads and device switches) =====

	// Restore the saved draft when a chat opens or switches. The previous chat's
	// pending write is keyed to its own id in the store, so nothing is lost here.
	let draftChatId: string | null = null;
	$effect(() => {
		const chatId = chatStore.activeChatId;
		if (chatId === draftChatId) return;
		draftChatId = chatId;
		historyPos = null;
		content = '';
		// Chat switched under the composer: close the steering popover and any transform
		// dialog, since both edit the OLD chat's state. A pending steering debounce self-flushes
		// via its own timer (it captured its chat id at schedule time). Command mode goes with
		// them: its gates were resolved against the chat that just left the screen.
		steeringOpen = false;
		transformKind = null;
		commandArmed = false;
		if (!chatId) return;
		void inputDraftStore.load(chatId).then(async (draft) => {
			// The user may have switched again (or started typing) while the
			// draft was in flight; never stomp what's already in the box.
			if (chatStore.activeChatId !== chatId || !draft || content !== '') return;
			content = draft;
			await tick();
			handleInput();
		});
	});

	// The keyboard coming back from the story: Escape with nothing left to close, or stepping
	// down past the newest turn (architecture/chat-sessions.md, "The message cursor"). Read
	// against the nonce this component started at, or the box would grab focus on mount and
	// every chat open would pop a phone's keyboard.
	let seenComposerNonce = chatCursor.composerNonce;
	$effect(() => {
		const nonce = chatCursor.composerNonce;
		if (nonce === seenComposerNonce) return;
		seenComposerNonce = nonce;
		textareaElement?.focus();
	});

	// A draft changed on another device: adopt it, unless the user is mid-typing
	// here (an empty box always takes the remote text).
	$effect(() => {
		const remote = inputDraftStore.remote;
		if (!remote) return;
		untrack(() => {
			inputDraftStore.remote = null; // consume: each push applies at most once
			if (remote.chatId !== chatStore.activeChatId) return;
			if (document.activeElement === textareaElement && content !== '') return;
			if (remote.content === content) return;
			content = remote.content;
			void tick().then(() => handleInput());
		});
	});

	function scheduleDraftSave() {
		const chatId = chatStore.activeChatId;
		if (chatId) inputDraftStore.schedule(chatId, content);
	}

	// ===== Input history (↑/↓ recalls previously sent messages) =====

	// The store holds everything ever sent (capped); the chat scope setting is
	// only a filter over it. Consecutive duplicates collapse for navigation.
	let sentHistory = $derived.by(() => {
		const chatOnly = generalSettingsStore.inputHistoryScope === 'chat';
		const chatId = chatStore.activeChatId;
		const items: string[] = [];
		for (const entry of inputHistoryStore.entries) {
			if (chatOnly && entry.chatId !== chatId) continue;
			if (items[items.length - 1] !== entry.content) items.push(entry.content);
		}
		return items;
	});

	// Index into sentHistory while navigating; null = not in history mode. Editing
	// the recalled text (any input event) leaves history mode.
	let historyPos = $state<number | null>(null);

	function navigateHistory(direction: -1 | 1): boolean {
		if (viewport.isTouch || !generalSettingsStore.inputHistory) return false;
		const history = sentHistory;
		let next: number;
		if (historyPos === null) {
			// Only an empty composer enters history mode, so ↑ never fights the
			// caret moving through multi-line text.
			if (direction !== -1 || content !== '' || !history.length) return false;
			next = history.length - 1;
		} else {
			next = historyPos + direction;
			if (next < 0) return true; // already at the oldest, so swallow the key
			if (next >= history.length) {
				// Walked past the newest: leave history mode with an empty box.
				historyPos = null;
				applyRecall('');
				return true;
			}
		}
		historyPos = next;
		applyRecall(history[next]);
		return true;
	}

	function applyRecall(text: string) {
		content = text;
		scheduleDraftSave();
		void tick().then(() => {
			handleInput();
			textareaElement?.setSelectionRange(text.length, text.length);
		});
	}

	function handleInsertDummy(role: 'user' | 'assistant') {
		menuOpen = false;
		onInsertDummy?.(role);
	}

	let lastTurn = $derived(activePath[activePath.length - 1] ?? null);

	// Continue extends the newest turn in place, so it only makes sense when that turn is an
	// AI reply. The button for it lives on that reply (MessageActions); what is left here is
	// the gate `/continue` runs behind.
	let canContinue = $derived(lastTurn?.role === 'assistant');

	// Same target as Continue (the newest turn), but what it does depends on whose turn that is:
	// a reply gets re-rolled, your own turn gets the reply it doesn't have yet. One store call
	// covers both, because 'replace' on a user turn finds nothing below to delete and goes
	// straight to generating. Reached by ⌘/Ctrl+Enter and `/retry`, both behind this gate.
	let canRegenerateLast = $derived.by(() => {
		const last = lastTurn;
		if (!last) return false;
		// A seeded greeting has no prompt behind it to re-roll.
		if (last.role === 'assistant') return last.parentId !== null;
		if (last.role !== 'user') return false;
		// A user turn holding replies would make 'replace' a subtree delete. The transcript's own
		// button puts that behind a counted confirm, so the composer must not fire it uncounted.
		return !(chatStore.currentChatState?.allMessages ?? []).some((m) => m.parentId === last.id);
	});

	let regenerateLastHint = $derived(
		!canRegenerateLast
			? 'The newest turn must be a reply, or a turn of yours with no reply yet'
			: lastTurn?.role === 'user'
				? 'Generate a reply to your last turn'
				: 'Delete the last reply and generate a new one'
	);

	// Swipe is the same act with the non-destructive action ('branch' keeps what is there and
	// adds a sibling), so its gate is Retry's WITHOUT the one exclusion that exists purely
	// because 'replace' would be a subtree delete. A user turn that already holds replies is
	// not the case swipe has to refuse; it is the case swipe is FOR.
	let canSwipeLast = $derived.by(() => {
		const last = lastTurn;
		if (!last) return false;
		// A seeded greeting has no prompt behind it, the same reason Retry refuses one.
		if (last.role === 'assistant') return last.parentId !== null;
		return last.role === 'user';
	});

	// ===== Steering (guidance injected into the prompt, never into the chat) =====

	// The panel is SteeringPopover's job; what stays here is the trigger's open state and
	// the commit-and-flush-on-close, so no outside interaction can build a prompt against a
	// note edit still sitting in the store's debounce window, or against a quick-box line
	// the user typed and never got to commit.
	let steeringOpen = $state(false);
	let steeringPopover = $state<SteeringPopover | null>(null);

	function closeSteering() {
		// Before the unmount, not after: the popover's quick box is component state.
		steeringPopover?.commitQuick();
		steeringOpen = false;
		void steeringStore.flush();
	}

	function toggleSteering() {
		if (steeringOpen) closeSteering();
		else steeringOpen = true;
	}

	// ===== Persona quick switch =====

	// Switches the ONE global active persona (personaStore), not this chat's message
	// attribution: from here on, new user turns are stamped with it and prompt assembly
	// speaks as it. Past turns keep the persona they were sent with; rebinding those is
	// the menu's "Relabel your messages…" (ChatPersonaDialog), a different job. The two labels
	// deliberately share no words: they sit centimetres apart and both show a persona list.
	// Past a dozen personas a portrait+name list is mostly scrolling, so the popover
	// flips to a face grid: same rows of pixels, roughly twice the personas in them.
	const PERSONA_GRID_THRESHOLD = 12;

	let personaMenuOpen = $state(false);
	let personaMenuRef = $state<HTMLDivElement | null>(null);
	// One prepared list both popover layouts render from.
	let personaOptions = $derived(
		characterLibraryStore.personas.map((p) => ({
			id: p.id,
			name: p.identity.name?.trim() || 'Unnamed persona',
			thumb: imageService.thumbnailUrl(p.identity.imageUrl),
			focus: portraitFocusStyle(p.identity.portraitFocus)
		}))
	);
	let personaGrid = $derived(personaOptions.length > PERSONA_GRID_THRESHOLD);
	let activePersona = $derived(chatPersonaStore.resolvedEntry);
	let activePersonaThumb = $derived(imageService.thumbnailUrl(activePersona?.identity.imageUrl));
	let activePersonaFocus = $derived(portraitFocusStyle(activePersona?.identity.portraitFocus));
	let personaTitle = $derived(
		activePersona
			? `You are ${activePersona.identity.name?.trim() || 'an unnamed persona'}. Click to switch`
			: 'No persona. Click to pick one'
	);

	$effect(() => {
		if (!personaMenuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (personaMenuRef && !personaMenuRef.contains(e.target as Node)) personaMenuOpen = false;
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	});

	// Switching only. Clearing the persona is deliberately not offered here: an
	// unset persona is a library-level state, not a story move.
	function pickPersona(id: string) {
		personaMenuOpen = false;
		// Compared against what this chat is ACTUALLY playing as, and only a no-op while the
		// chat is already following the app: picking the persona an override happens to have
		// pinned still has work to do, namely standing that override down.
		if (id === chatPersonaStore.resolvedId && chatPersonaStore.scope === 'global') return;
		void chatPersonaStore.switchGlobal(id);
		const name = personaOptions.find((p) => p.id === id)?.name ?? 'persona';
		// Switching by hand is an app-wide act and clears this chat's override, so the word
		// "everywhere" is the literal truth rather than a simplification.
		toastStore.success(`Now playing as ${name} everywhere`);
	}

	// ===== Composer transforms (Spellcheck / Impersonate) =====

	// The strip that opens above the composer owns the run; what stays here is which one is
	// open and what that does to the box underneath it. While a proposal is on screen the
	// composer is frozen: the proposal is against the draft as it stood at the press, so
	// approving over an edited box would throw that edit away without saying so.
	let transformKind = $state<'spellcheck' | 'impersonate' | null>(null);
	let transformOriginal = $state('');
	let transformOpen = $derived(transformKind !== null);

	function startTransform(kind: 'spellcheck' | 'impersonate') {
		menuOpen = false;
		transformOriginal = content;
		transformKind = kind;
	}

	// Approve path: the original goes into the ↑ input history first, so even an
	// approved replacement stays recoverable. Rejecting never touches the box at all.
	async function applyTransform(proposed: string) {
		inputHistoryStore.record(chatStore.activeChatId, transformOriginal);
		transformKind = null;
		content = proposed;
		scheduleDraftSave();
		await tick();
		handleInput();
		textareaElement?.focus();
	}

	// ===== Commands =====

	// Typing "/" into an EMPTY composer arms command mode: from there the box is filling in a
	// call rather than holding a message, which is what lets an argument be the rest of the
	// line verbatim with nothing to escape. Arming only from empty is what keeps a story line
	// that happens to contain a slash out of the mode (what counts as empty is decided at the
	// arming site in handleComposerInput, and it includes attachments), and Escape or a line
	// naming no command drops straight back to prose, so the box is never a trap.
	let commandArmed = $state(false);
	let commandIndex = $state(0);

	let parsedCommand = $derived(commandArmed ? parseCommandInput(content) : null);
	let commandMatches = $derived(parsedCommand ? matchCommands(parsedCommand) : []);
	// The palette hides itself when nothing matches, so an unrecognised line behaves exactly
	// like prose: Enter sends it. There is no dead state to back out of.
	let commandOpen = $derived(commandMatches.length > 0);
	let activeCommand = $derived(commandMatches[Math.min(commandIndex, commandMatches.length - 1)] ?? null);
	// Headings are for BROWSING, so they appear only on a bare "/" where the list is the whole
	// vocabulary. The moment a letter is typed the list is a ranked answer, and grouping it
	// would reorder that ranking back into registry order: the best match would render under a
	// heading below a worse one, with the highlight on a row that is not the first on screen.
	let paletteGrouped = $derived(parsedCommand !== null && !parsedCommand.settled && parsedCommand.name === '');
	let paletteGroups = $derived(
		paletteGrouped
			? COMMAND_GROUPS.map((group) => ({
					id: group.id as string,
					label: group.label,
					commands: commandMatches.filter((c) => c.group === group.id)
				})).filter((group) => group.commands.length > 0)
			: [{ id: 'ranked', label: '', commands: commandMatches }]
	);

	const commandHost: CommandHost = {
		continueMessage: () => onContinue?.(),
		regenerateLast: () => onRegenerateLast?.(),
		swipeLast: () => onSwipeLast?.(),
		requestDuplicate: () => void startDuplicate()
	};

	// The gates a command runs behind are the composer's OWN deriveds, handed over rather than
	// recomputed: a command and the menu row that does the same thing then read one answer, so
	// neither can end up more permissive than the other.
	let commandContext = $derived<CommandContext>({
		chatId: chatStore.activeChatId,
		activeLeafId: chatStore.activeChat?.activeLeafId ?? null,
		canonLeafId: chatStore.activeChat?.canonLeafId ?? null,
		characterEntryId: activeCharacterEntry?.id ?? null,
		personaEntryId: chatPersonaStore.resolvedEntry?.id ?? null,
		lastTurnId: lastTurn?.id ?? null,
		canContinue,
		canRegenerateLast,
		canSwipeLast,
		regenerateLastHint,
		host: commandHost
	});

	/** Why a row cannot run, for the row's own line. */
	function refusalFor(command: CommandDef): string | null {
		return command.unavailable?.(commandContext) ?? null;
	}

	/**
	 * Whether Enter (and the Send button, which is the same door) would actually do something.
	 *
	 * The button sits over the box in both modes, so it has to answer this: one that looks
	 * live over a name still being typed, a refused command or a missing argument is a press
	 * that silently does nothing, which is the exact failure the disabled state exists for.
	 */
	let commandReady = $derived.by(() => {
		const parsed = parsedCommand;
		if (!commandOpen || !parsed) return false;
		if (!parsed.settled) {
			// Completing the name IS an action, so an argument-taking command counts here.
			return activeCommand !== null && refusalFor(activeCommand) === null;
		}
		const picked = commandByName(parsed.name);
		return picked !== null && refusalFor(picked) === null && argSatisfied(picked, parsed.arg);
	});

	function moveCommandSelection(delta: 1 | -1) {
		const count = commandMatches.length;
		if (!count) return;
		commandIndex = (Math.min(commandIndex, count - 1) + delta + count) % count;
	}

	/** Put the name in the box and leave the caret where the argument goes. */
	async function completeCommandName(command: CommandDef) {
		content = `/${command.name}${command.arg ? ' ' : ''}`;
		commandIndex = 0;
		await tick();
		handleInput();
		textareaElement?.focus();
		textareaElement?.setSelectionRange(content.length, content.length);
	}

	async function executeCommand(command: CommandDef, arg: string) {
		// The mode ends on the press, not on the work: the command is accepted or refused here
		// and runs on its own from there, so a long one never leaves the box locked around a
		// half-typed line.
		const ok = runCommand(command, arg, commandContext);
		// A refusal leaves the line alone: the text is still the fastest way to fix it.
		if (!ok) return;
		content = '';
		commandArmed = false;
		commandIndex = 0;
		historyPos = null;
		if (chatStore.activeChatId) inputDraftStore.clear(chatStore.activeChatId);
		await tick();
		handleInput();
	}

	/** A click on a palette row: finish naming it, or run it when it is already named. */
	function pickCommand(command: CommandDef) {
		if (refusalFor(command)) return;
		const parsed = parsedCommand;
		if (command.arg && !(parsed?.settled && commandByName(parsed.name) === command)) {
			void completeCommandName(command);
			return;
		}
		void executeCommand(command, parsed?.settled ? parsed.arg : '');
	}

	/**
	 * Enter in command mode. An unfinished name completes rather than guessing, and a command
	 * still missing its required argument does nothing at all: the row on screen already says
	 * what it wants, and a toast on every keystroke-in-progress would be noise.
	 */
	function submitCommand() {
		const parsed = parsedCommand;
		if (!parsed) return;
		if (!parsed.settled) {
			const picked = activeCommand;
			if (!picked || refusalFor(picked)) return;
			if (picked.arg) void completeCommandName(picked);
			else void executeCommand(picked, '');
			return;
		}
		const picked = commandByName(parsed.name);
		if (!picked || refusalFor(picked) || !argSatisfied(picked, parsed.arg)) return;
		void executeCommand(picked, parsed.arg);
	}

	// ===== Duplicate this chat =====

	// `/duplicate` raises the Chats panel's own dialog rather than copying on the spot, so the
	// one question a copy cannot answer for itself (does the memory come too?) is asked here as
	// well. It differs from the panel in one deliberate way: this door lands you IN the copy,
	// because the command was typed from inside the story and that is where the next turn goes.
	let duplicateTarget = $state<{ chat: Chat; footprint: ChatMemoryFootprint } | null>(null);
	let duplicating = $state(false);

	async function startDuplicate() {
		const chat = chatStore.activeChat;
		if (!chat || duplicating) return;
		// The copy opens the chat it makes, which swaps out the state a stream writes into.
		if (messageStore.warnIfBusy()) return;
		duplicating = true;
		try {
			const footprint = await db.getChatMemoryFootprint(chat.id);
			if (!duplicateAsksAboutMemory(footprint)) {
				await runDuplicate(chat, false);
				return;
			}
			duplicateTarget = { chat, footprint };
		} catch (error) {
			toastStore.failed(`duplicate "${chat.title}"`, error);
		} finally {
			// Released here so the dialog's own buttons are live; the copy re-raises it.
			duplicating = false;
		}
	}

	async function runDuplicate(chat: Chat, includeMemory: boolean) {
		duplicating = true;
		try {
			const newChatId = await chatStore.duplicateChat(chat.id, { includeMemory });
			duplicateTarget = null;
			await chatStore.selectChat(newChatId);
			toastStore.success(includeMemory ? 'Chat duplicated with its memory' : 'Chat duplicated');
		} catch (error) {
			toastStore.failed(`duplicate "${chat.title}"`, error);
		} finally {
			duplicating = false;
		}
	}

	// ===== Image attachments =====

	let pendingImages = $state<{ path: string; url: string }[]>([]);
	let uploadingImages = $state(0);
	let fileInput: HTMLInputElement | undefined = $state();
	/** The attach menu. One row today; the button is a menu because the next attachable
	 *  kind shouldn't have to re-teach the composer's toolbar what that button does. */
	let attachOpen = $state(false);

	function pickImage() {
		attachOpen = false;
		fileInput?.click();
	}

	async function attachImageFiles(files: File[]): Promise<void> {
		const images: File[] = [];
		for (const file of files) {
			const refused = imageRejectionReason(file);
			if (refused) toastStore.error(refused);
			else images.push(file);
		}
		if (!images.length) return;
		// Attaching is always possible; whether the images actually ride the prompt
		// depends on the provider/model + the Send images setting, so say so up front
		// instead of silently dropping them at generation time.
		if (!llmService.sendsImages()) {
			toastStore.warning(
				'This model does not take images, or sending images is off. The picture stays in the chat but never reaches the model.'
			);
		}
		uploadingImages += images.length;
		for (const file of images) {
			try {
				const path = await imageService.saveImage(file, 'chat');
				const url = imageService.thumbnailUrl(path) ?? (await imageService.getImageUrl(path)) ?? '';
				pendingImages = [...pendingImages, { path, url }];
			} catch (error) {
				toastStore.failed(`attach "${file.name}"`, error);
			} finally {
				uploadingImages -= 1;
			}
		}
	}

	function handlePaste(e: ClipboardEvent) {
		const files = Array.from(e.clipboardData?.files ?? []).filter(isImageFile);
		if (files.length) {
			e.preventDefault();
			void attachImageFiles(files);
		}
	}

	function handleFilePick(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		void attachImageFiles(Array.from(input.files ?? []));
		input.value = '';
	}

	// ===== Dropping a picture on the composer =====
	// Pictures only. A story turn has nowhere to put a text file (the assistant panel is
	// what reads those), so one dropped here is refused by name rather than silently ignored,
	// which would read as the drop having failed.

	/** Depth-counted so a drag crossing a child element doesn't flicker the overlay off. */
	let dragDepth = $state(0);

	function handleDragEnter(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		dragDepth += 1;
	}

	function handleDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		// Without this the browser navigates away to the dropped file.
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
	}

	function handleDragLeave() {
		dragDepth = Math.max(0, dragDepth - 1);
	}

	function handleDrop(e: DragEvent) {
		const dropped = Array.from(e.dataTransfer?.files ?? []);
		dragDepth = 0;
		if (!dropped.length) return;
		e.preventDefault();
		const images = dropped.filter(isImageFile);
		for (const file of dropped.filter((f) => !isImageFile(f))) {
			toastStore.error(`"${file.name}" is not a picture. Attach a file to the Chungus Assistant instead, which can read it.`);
		}
		if (images.length) void attachImageFiles(images);
	}

	function removePendingImage(path: string) {
		pendingImages = pendingImages.filter((img) => img.path !== path);
		// The upload is already on the server; drop the file too so abandoned
		// attachments don't pile up in images/chat/.
		void imageService.deleteImage(path);
	}

	function handleSubmit() {
		// The Send button is the palette's other door, which is what makes command mode work
		// on touch, where Enter is a newline.
		if (commandOpen) {
			submitCommand();
			return;
		}
		// Enter reaches here with the box still typable while a reply this page did not start
		// is being written, and a press that consumed the key and produced neither a send nor
		// a newline would just look broken. The store owns the sentence, so the composer and
		// every other refused mutation say the same thing.
		if (isStreaming && messageStore.warnIfBusy()) return;
		const trimmed = content.trim();
		if ((trimmed || pendingImages.length) && !isStreaming && !uploadingImages) {
			const attachments: MessageAttachment[] = pendingImages.map((img) => ({ kind: 'image', path: img.path }));
			// The box empties when the send COMMITS, not when it is asked for. With a prompt
			// hold on this gate those are different moments, and a review the reader cancels
			// has to hand back exactly what they typed, pictures and all. The chat is named
			// here rather than read again later, so the draft cleared is the one sent.
			const chatId = chatStore.activeChatId;
			onSend(trimmed, attachments.length ? attachments : undefined, () => releaseDraft(chatId, trimmed));
		}
	}

	/** The draft is the message's now: record it for ↑ recall and clear the box. */
	function releaseDraft(chatId: string | null, sent: string) {
		if (sent) inputHistoryStore.record(chatId, sent);
		content = '';
		pendingImages = [];
		historyPos = null;
		// The message is sent, so the draft's job is done.
		if (chatId) inputDraftStore.clear(chatId);
		if (textareaElement) {
			textareaElement.style.height = 'auto';
		}
	}

	// Token popup: hover/focus reveal is dead on touch, so a tap on the trigger pins
	// it open; outside taps and Escape (consumed, per the workspace Esc contract)
	// release the pin. The popup is portaled to <body> and fixed-positioned off the
	// trigger's box: the chat column is its own stacking context (isolation on
	// .chat-center-shell), so an in-place popup can never paint over fixed overlays
	// like the assistant launcher, whatever its z-index.
	let tokenPopupPinned = $state(false);
	let tokenPopupHovered = $state(false);
	let tokenPopupFocused = $state(false);
	let tokenAnchorEl = $state<HTMLDivElement | null>(null);
	let tokenPopupEl = $state<HTMLDivElement | null>(null);
	let tokenPopupLeft = $state(0);
	let tokenPopupBottom = $state(0);
	let tokenPopupReady = $state(false);
	let tokenPopupOpen = $derived(tokenPopupPinned || tokenPopupHovered || tokenPopupFocused);

	// Grace delay so the pointer can cross the gap between trigger and popup
	// without the popup collapsing.
	let tokenHoverTimer: ReturnType<typeof setTimeout> | undefined;
	function tokenHoverIn() {
		clearTimeout(tokenHoverTimer);
		tokenPopupHovered = true;
	}
	function tokenHoverOut() {
		clearTimeout(tokenHoverTimer);
		tokenHoverTimer = setTimeout(() => (tokenPopupHovered = false), 140);
	}

	function placeTokenPopup() {
		if (!tokenAnchorEl || !tokenPopupEl) return;
		const a = tokenAnchorEl.getBoundingClientRect();
		const w = tokenPopupEl.offsetWidth;
		const EDGE = 8;
		// Right-aligned to the trigger, clamped inside the viewport. Anchored by
		// bottom so the popup grows upward as its content does.
		tokenPopupLeft = Math.min(Math.max(a.right - w, EDGE), window.innerWidth - w - EDGE);
		tokenPopupBottom = window.innerHeight - a.top + 7;
	}

	$effect(() => {
		if (!tokenPopupOpen || !tokenPopupEl) {
			tokenPopupReady = false;
			return;
		}
		placeTokenPopup();
		tokenPopupReady = true;
		const reflow = () => placeTokenPopup();
		window.addEventListener('scroll', reflow, true);
		window.addEventListener('resize', reflow);
		return () => {
			window.removeEventListener('scroll', reflow, true);
			window.removeEventListener('resize', reflow);
		};
	});

	function portalToBody(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}

	$effect(() => {
		if (!tokenPopupPinned) return;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (tokenAnchorEl?.contains(t) || tokenPopupEl?.contains(t)) return;
			tokenPopupPinned = false;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				tokenPopupPinned = false;
			}
		};
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('keydown', onKey);
		};
	});

	function handleKeydown(e: KeyboardEvent) {
		// Frozen under an open transform strip: the box is readonly-in-effect, so neither
		// Enter-to-send nor history recall may rewrite the draft the proposal is about.
		if (transformOpen) return;
		// Ctrl/⌘+Enter regenerates, above command mode because the palette owns plain Enter and
		// nothing modified. Same gate as the newest turn's own Retry, so the key can never
		// outreach the button.
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (!isStreaming && canRegenerateLast) onRegenerateLast?.();
			return;
		}
		// Command mode owns the keys the palette needs and nothing else. It sits above the
		// history recall below, which reads the same arrows, and above the touch branch: in
		// command mode Enter runs the call on every device, since a newline in a command line
		// is prose the mode has already stood down for.
		if (commandOpen) {
			// Unmodified only, the same rule the history recall below follows: Alt+↑ takes the
			// keyboard up into the story, and a palette that also claimed it would move its
			// highlight on the way out.
			if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
				e.preventDefault();
				moveCommandSelection(e.key === 'ArrowDown' ? 1 : -1);
				return;
			}
			if (e.key === 'Tab') {
				e.preventDefault();
				if (activeCommand) void completeCommandName(activeCommand);
				return;
			}
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				submitCommand();
				return;
			}
			// Consumed per the shell Esc contract, so leaving the palette never also closes a
			// panel behind it. The text stays: this is the escape hatch for a line that really
			// does start with a slash.
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				commandArmed = false;
				// The line is prose from here on, so it becomes a draft like any other. Nothing
				// else fires: leaving the mode is not an input event.
				scheduleDraftSave();
				return;
			}
		}
		if (
			(e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
			!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
		) {
			if (navigateHistory(e.key === 'ArrowUp' ? -1 : 1)) {
				e.preventDefault();
				return;
			}
		}
		// On touch there is no Shift key, so Enter inserts a newline and the send
		// button submits. Only pointer devices submit on Enter.
		if (e.key === 'Enter' && !e.shiftKey && !viewport.isTouch) {
			e.preventDefault();
			handleSubmit();
		}
	}

	function handleInput() {
		if (textareaElement) {
			textareaElement.style.height = 'auto';
			textareaElement.style.height = Math.min(textareaElement.scrollHeight, 200) + 'px';
		}
	}

	// Real typing (as opposed to programmatic content changes): resize, leave
	// history mode, and keep the persisted draft in step.
	function handleComposerInput() {
		handleInput();
		historyPos = null;
		// A lone "/" in an otherwise empty composer arms command mode; anything that stops
		// being a command line (a newline, a deleted slash) drops it. Typing always returns
		// the highlight to the first row, so the selection can never point at a command that
		// has scrolled out of the list.
		// A composer holding a picture is not empty, whatever the text box says: arming there
		// would let `/say` land a turn while the attachment sat behind it, silently dropped.
		if (!commandArmed && content === '/' && !pendingImages.length && !uploadingImages)
			commandArmed = true;
		else if (commandArmed && !parseCommandInput(content)) commandArmed = false;
		commandIndex = 0;
		// A command line is not a draft. Persisting one syncs it to every device and restores
		// it later as ordinary text, so a command typed and abandoned would come back as a
		// message that sends itself on the next Enter.
		if (!commandArmed) scheduleDraftSave();
	}

</script>

<div class="input-shell">
	<div class="input-inner">
		<!-- Spellcheck / Impersonate open here, directly over the box they rewrite: in flow,
		     so the transcript shortens and nothing about the story is covered. -->
		{#if transformKind && chatStore.activeChatId}
			<TransformPanel
				kind={transformKind}
				original={transformOriginal}
				chatId={chatStore.activeChatId}
				chatMessages={activePath}
				onClose={() => (transformKind = null)}
				onApprove={applyTransform}
			/>
		{/if}

		<!-- A reply nobody on this screen started. In flow above the box, because it explains a
		     Stop button standing where Send usually is, and because there is no streaming
		     bubble to carry it: this page is not watching those tokens, only naming them. -->
		{#if generatingSince !== null}
			<div class="composer-elsewhere">
				<Icon name="refresh" class="w-3.5 h-3.5 shrink-0 animate-spin" />
				<span>{generatingLine}</span>
			</div>
		{/if}

		<!-- The composer is the drop target for pictures. Files are the assistant's business,
		     so one dropped here is refused by name rather than quietly ignored. -->
		<div
			class="composer-shell input-base"
			class:composer-shell--frozen={transformOpen}
			class:composer-shell--command={commandOpen}
			style="box-shadow: var(--shadow-sm);"
			ondragenter={handleDragEnter}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
			role="presentation"
		>
			{#if dragDepth > 0}
				<div class="composer-drop">Drop a picture to attach it</div>
			{/if}

			<!-- What "/" turned the box into. The list is its own surface; the mode, the gates
			     and the keys stay here, because all three are about the box being typed into. -->
			{#if commandOpen}
				<CommandPalette
					groups={paletteGroups}
					active={activeCommand}
					{refusalFor}
					onPick={pickCommand}
				/>
			{/if}
			{#if pendingImages.length || uploadingImages > 0}
				<div class="attach-strip">
					{#each pendingImages as img (img.path)}
						<div class="attach-thumb">
							<img src={img.url} alt="Attached" />
							<button
								type="button"
								class="attach-remove"
								onclick={() => removePendingImage(img.path)}
								aria-label="Remove image"
								title="Remove"
							>
								<Icon name="x" class="w-3 h-3" strokeWidth={2.5} />
							</button>
						</div>
					{/each}
					{#if uploadingImages > 0}
						<div class="attach-thumb attach-uploading" title="Uploading…">
							<Icon name="refresh" class="w-4 h-4 animate-spin text-text-muted" />
						</div>
					{/if}
				</div>
			{/if}
			<div class="composer-main">
				<textarea
					bind:this={textareaElement}
					bind:value={content}
					onkeydown={handleKeydown}
					oninput={handleComposerInput}
					onpaste={handlePaste}
				placeholder="Type your message…"
				disabled={draftLocked || transformOpen}
					rows="1"
					class="composer-textarea bg-transparent font-body text-text-primary resize-none
				       focus:outline-none placeholder:text-text-muted
				       disabled:opacity-50 disabled:cursor-not-allowed
				       text-base leading-relaxed"
					style="max-height: 200px; min-height: 2rem;"
				></textarea>

				<div class="flex items-center gap-1 self-end">
					{#if isStreaming}
						<button
							type="button"
							onclick={onCancel}
							class="icon-btn text-error hover:bg-error/10"
							aria-label="Stop generating"
							title="Stop"
						>
							<Icon name="stop" class="w-5 h-5" />
						</button>
					{:else}
						<button
							type="button"
							onclick={handleSubmit}
							disabled={uploadingImages > 0 ||
							transformOpen ||
							(commandOpen ? !commandReady : !content.trim() && !pendingImages.length)}
							class="flex items-center justify-center w-9 h-9 rounded-full
						       bg-accent text-on-accent
						       hover:bg-accent-hover
						       disabled:opacity-30 disabled:cursor-not-allowed
						       transition-all duration-150"
						style="box-shadow: var(--shadow-sm);"
							aria-label={commandOpen ? 'Run command' : 'Send message'}
							title={commandOpen ? 'Run command' : 'Send'}
						>
							<Icon name="arrowRight" class="w-4 h-4" strokeWidth={2.5} />
						</button>
					{/if}
				</div>
			</div>

			<div class="composer-meta">
				<div class="composer-feature-group">
					<div class="composer-menu-wrap relative">
						<button
							type="button"
							onclick={() => (menuOpen = !menuOpen)}
							class="composer-icon-btn"
							class:composer-icon-btn--active={menuOpen}
							aria-label="Insert options"
							title="Insert options"
						>
							<Icon name="menu" class="w-4 h-4" />
						</button>

						{#if menuOpen}
							<!-- Backdrop to close menu -->
							<button
								type="button"
								class="fixed inset-0 z-10"
								onclick={() => (menuOpen = false)}
								aria-label="Close menu"
							></button>

							<!-- Dropdown menu. The engine entries wear their engine's own registry
							     icon (feather / checkCircle / mask) and the two Insert rows wear the
							     role glyphs MessageAvatar draws, so a row reads the same here as it
							     does in the transcript. -->
							<div class="composer-dropdown absolute bottom-full left-0 mb-2 z-20 surface-float rounded-lg shadow-md py-1 min-w-[210px]">
								<button type="button" class="composer-menu-item" onclick={handleGoHome}>
									<Icon name="home" class="w-4 h-4" />
									Home
								</button>
								<button
									type="button"
									class="composer-menu-item"
									title="Browse and search this character's chats"
									onclick={handleOpenChats}
								>
									<Icon name="chat" class="w-4 h-4" />
									Chats
								</button>
								<!-- Directly under Chats: this is that panel's own New chat button
								     surfaced as a shortcut, so it reads as one beside the row that
								     opens the panel. -->
								<button
									type="button"
									class="composer-menu-item"
									disabled={!activeCharacterEntry}
									title={activeCharacterEntry
										? undefined
										: "This story's character is gone from the library"}
									onclick={handleNewChat}
								>
									<Icon name="plus" class="w-4 h-4" />
									New chat
								</button>
								<button
									type="button"
									class="composer-menu-item"
									title="Search this story's messages"
									onclick={handleFindInChat}
								>
									<Icon name="search" class="w-4 h-4" />
									Find in chat…
								</button>
								<button
									type="button"
									class="composer-menu-item"
									title="Everything you have written here, counted"
									onclick={handleOpenStats}
								>
									<Icon name="chart" class="w-4 h-4" />
									Your stats
								</button>
								<div class="composer-menu-sep"></div>
								<button
									type="button"
									class="composer-menu-item"
									onclick={() => handleInsertDummy('user')}
								>
									<Icon name="user" class="w-4 h-4" />
									Insert user message
								</button>
								<button
									type="button"
									class="composer-menu-item"
									onclick={() => handleInsertDummy('assistant')}
								>
									<Icon name="sparkles" class="w-4 h-4" />
									Insert LLM message
								</button>
								{#if featurePromptsStore.spellcheckEnabled || featurePromptsStore.impersonateEnabled}
									<div class="composer-menu-sep"></div>
									{#if featurePromptsStore.spellcheckEnabled}
										<button
											type="button"
											class="composer-menu-item"
											disabled={isStreaming || transformOpen || !content.trim()}
											title={transformOpen
												? 'Finish the one already open first'
												: content.trim()
													? 'Fix spelling and grammar, then review the changes before they apply'
													: 'Type a draft first'}
											onclick={() => startTransform('spellcheck')}
										>
											<Icon name="checkCircle" class="w-4 h-4" />
											Spellcheck draft
										</button>
									{/if}
									{#if featurePromptsStore.impersonateEnabled}
										<button
											type="button"
											class="composer-menu-item"
											disabled={isStreaming || transformOpen || !content.trim()}
											title={transformOpen
												? 'Finish the one already open first'
												: content.trim()
													? 'Expand the draft into a full in-character message, then review it'
													: 'Type a draft first'}
											onclick={() => startTransform('impersonate')}
										>
											<Icon name="mask" class="w-4 h-4" />
											Impersonate draft
										</button>
									{/if}
								{/if}
								<div class="composer-menu-sep"></div>
								<button
									type="button"
									class="composer-menu-item"
									title="Show every message you have sent in this chat as a different persona"
									onclick={openPersonaDialog}
								>
									<Icon name="tag" class="w-4 h-4" />
									Relabel your messages…
								</button>
							</div>
						{/if}
					</div>

					<div class="composer-menu-wrap relative">
						<button
							type="button"
							onclick={() => (attachOpen = !attachOpen)}
							class="composer-icon-btn"
							class:composer-icon-btn--active={attachOpen}
							disabled={isStreaming}
							aria-label="Attach"
							title="Attach"
							aria-haspopup="menu"
							aria-expanded={attachOpen}
						>
							<Icon name="paperclip" class="w-4 h-4" />
						</button>

						{#if attachOpen}
							<!-- Backdrop to close menu -->
							<button
								type="button"
								class="fixed inset-0 z-10"
								onclick={() => (attachOpen = false)}
								aria-label="Close menu"
							></button>

							<!-- The Insert menu's recipe, down to the width: the two triggers sit side
							     by side, so two dropdowns of different builds would read as an accident.
							     One row for now: images are simply the only kind we take yet. -->
							<div class="composer-dropdown absolute bottom-full left-0 mb-2 z-20 surface-float rounded-lg shadow-md py-1 min-w-[210px]">
								<button
									type="button"
									class="composer-menu-item"
									title="PNG, JPEG, WebP or GIF"
									onclick={pickImage}
								>
									<Icon name="image" class="w-4 h-4" />
									Image…
								</button>
							</div>
						{/if}
					</div>
					<!-- Outside the menu on purpose: picking a row closes it, and an input that
					     unmounts in the same tick never gets to open its file dialog. -->
					<input
						bind:this={fileInput}
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif"
						multiple
						class="hidden"
						onchange={handleFilePick}
					/>

					{#if featurePromptsStore.steeringEnabled && chatStore.activeChatId}
						<div class="composer-menu-wrap relative">
							<!-- Deliberately never disabled while streaming: steering is next-turn
							     state, and lining up guidance mid-stream is the whole point. -->
							<button
								type="button"
								onclick={toggleSteering}
								class="composer-icon-btn steering-trigger"
								class:steering-trigger--active={steeringActive}
								aria-label="Steering"
								aria-expanded={steeringOpen}
								title={steeringTitle}
							>
								<Icon name="compass" class="w-4 h-4" />
								{#if steeringActive}
									<span class="steering-dot" aria-hidden="true"></span>
								{/if}
							</button>

							{#if steeringOpen}
								<!-- Backdrop: any outside click closes AND flushes the pending note
								     write, so no interaction can build a prompt against a stale edit. -->
								<button
									type="button"
									class="fixed inset-0 z-10"
									onclick={closeSteering}
									aria-label="Close steering"
								></button>

								<div class="absolute bottom-full left-0 mb-2 z-20">
									<SteeringPopover bind:this={steeringPopover} />
								</div>
							{/if}
						</div>
					{/if}

					{#if generalSettingsStore.personaSwitcher}
						<div class="composer-menu-wrap relative" bind:this={personaMenuRef}>
							<button
								type="button"
								onclick={() => (personaMenuOpen = !personaMenuOpen)}
								class="composer-icon-btn persona-trigger"
								class:composer-icon-btn--active={personaMenuOpen}
								aria-label="Switch persona"
								aria-haspopup="menu"
								aria-expanded={personaMenuOpen}
								title={personaTitle}
							>
								{#if activePersonaThumb}
									<img class="persona-trigger-art" src={activePersonaThumb} alt="" style={activePersonaFocus} />
								{:else}
									<Icon name="user" class="w-4 h-4" />
								{/if}
							</button>

							{#if personaMenuOpen}
								<div
									role="menu"
									class="persona-menu absolute bottom-full left-0 mb-2 z-20 py-1.5 surface-float rounded-lg shadow-md"
									class:is-grid={personaGrid}
								>
									<p class="px-3 pb-1 text-[10px] font-ui uppercase tracking-wide text-text-muted">
										Persona
									</p>
									{#if personaGrid}
										<div class="persona-grid">
											{#each personaOptions as persona (persona.id)}
												<button
													type="button"
													role="menuitem"
													class="persona-tile"
													class:is-active={persona.id === chatPersonaStore.resolvedId}
													title={persona.name}
													onclick={() => pickPersona(persona.id)}
												>
													<span class="persona-tile-art">
														{#if persona.thumb}
															<img src={persona.thumb} alt="" loading="lazy" style={persona.focus} />
														{:else}
															<Icon name="user" class="w-4 h-4" />
														{/if}
													</span>
													<span class="persona-tile-name">{persona.name}</span>
												</button>
											{/each}
										</div>
									{:else}
										<div class="max-h-56 overflow-y-auto">
											{#each personaOptions as persona (persona.id)}
												{@const isActive = persona.id === chatPersonaStore.resolvedId}
												<button
													type="button"
													role="menuitem"
													class="persona-row"
													class:is-active={isActive}
													onclick={() => pickPersona(persona.id)}
												>
													<span class="persona-check" class:is-visible={isActive}>
														<Icon name="check" class="w-3.5 h-3.5" />
													</span>
													<span class="persona-avatar">
														{#if persona.thumb}
															<img src={persona.thumb} alt="" loading="lazy" style={persona.focus} />
														{:else}
															<Icon name="user" class="w-3 h-3" />
														{/if}
													</span>
													<span class="persona-row-name">{persona.name}</span>
												</button>
											{/each}
										</div>
									{/if}
									{#if personaOptions.length === 0}
										<p class="px-3 pt-1 text-[10px] leading-snug font-ui text-text-muted">
											No personas yet. Create one in the Personas tab.
										</p>
									{/if}
								</div>
							{/if}
						</div>
					{/if}

					<div class="composer-feature-divider" aria-hidden="true"></div>

					<ChatVersionChip />
				</div>

				<div class="composer-right-group">
					{#if inputTokens > 0 || totalContextTokens > 0}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="token-anchor"
							bind:this={tokenAnchorEl}
							onpointerenter={tokenHoverIn}
							onpointerleave={tokenHoverOut}
							onfocusin={() => (tokenPopupFocused = true)}
							onfocusout={() => (tokenPopupFocused = false)}
						>
							<button
								type="button"
								class="token-trigger"
								class:is-trimmed={trimmedMessages > 0 || overBudget}
								aria-label="Show token usage breakdown"
								aria-expanded={tokenPopupPinned}
								onclick={() => (tokenPopupPinned = !tokenPopupPinned)}
							>
								{#if inputTokens > 0}
									<span>{inputTokens} input</span>
								{/if}
								{#if totalContextTokens > 0}
									<span>~{totalContextTokens.toLocaleString()} total</span>
								{/if}
								<!-- Trimming drops the OLDEST live turns, and turns that are live are by
								     definition not covered by a memory summary, so a silent trim is the one
								     way story text leaves the prompt with nothing recalling it. It cannot
								     live only inside a popover nobody opened. -->
								{#if trimmedMessages > 0 || overBudget}
									<span
										class="inline-flex"
										title={overBudget
											? 'Prompt exceeds the context size even with all history trimmed'
											: `${trimmedMessages} older ${trimmedMessages === 1 ? 'message is' : 'messages are'} being dropped to fit the context size`}
									>
										<Icon name="warning" class="w-3 h-3" />
									</span>
								{/if}
							</button>

							{#if tokenPopupOpen && totalContextTokens > 0}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="token-popup surface-float"
									class:token-popup-ready={tokenPopupReady}
									use:portalToBody
									bind:this={tokenPopupEl}
									style="left: {tokenPopupLeft}px; bottom: {tokenPopupBottom}px"
									onpointerenter={tokenHoverIn}
									onpointerleave={tokenHoverOut}
								>
									<div class="token-popup-head">
										<span class="token-popup-title">Prompt tokens</span>
										<span class="token-popup-tag">estimate</span>
									</div>

									<div class="token-bar">
										{#if presetTokens > 0}
											<div class="token-bar-seg bg-accent" style="width: {(presetTokens / totalContextTokens) * 100}%"></div>
										{/if}
										{#if contextTokens > 0}
											<div class="token-bar-seg bg-orange-400" style="width: {(contextTokens / totalContextTokens) * 100}%"></div>
										{/if}
										{#if memoryTokens > 0}
											<div class="token-bar-seg bg-violet-400" style="width: {(memoryTokens / totalContextTokens) * 100}%"></div>
										{/if}
										{#if chatTokens > 0}
											<div class="token-bar-seg bg-emerald-500" style="width: {(chatTokens / totalContextTokens) * 100}%"></div>
										{/if}
									</div>

									<div class="token-rows">
										<div class="token-row" title="System instructions & format from your preset">
											<span class="token-dot bg-accent"></span>
											<span class="token-row-name">Preset</span>
											<span class="token-row-val">{presetTokens.toLocaleString()}</span>
										</div>
										<div class="token-row" title="Persona, characters, lorebook, steering & preset controls">
											<span class="token-dot bg-orange-400"></span>
											<span class="token-row-name">Context</span>
											<span class="token-row-val">{contextTokens.toLocaleString()}</span>
										</div>
										{#if memoryTokens > 0}
											<div class="token-row" title="Chat memory recall: the scene summaries in play on this branch">
												<span class="token-dot bg-violet-400"></span>
												<span class="token-row-name">Memory</span>
												<span class="token-row-val">{memoryTokens.toLocaleString()}</span>
											</div>
										{/if}
										<div class="token-row" title="Conversation history included in the prompt">
											<span class="token-dot bg-emerald-500"></span>
											<span class="token-row-name">Chat</span>
											<span class="token-row-val">{chatTokens.toLocaleString()}</span>
										</div>
									</div>

									{#if trimmedMessages > 0}
										<div class="token-trim" title="Oldest chat turns dropped so the prompt fits the context size set on the Connection page">
											<Icon name="warning" class="w-3 h-3" strokeWidth={2} />
											{trimmedMessages} older {trimmedMessages === 1 ? 'message' : 'messages'} trimmed to fit the context size
										</div>
									{/if}
									{#if overBudget}
										<div class="token-trim over">
											<Icon name="warning" class="w-3 h-3" strokeWidth={2} />
											Prompt exceeds the context size even with all history trimmed
										</div>
									{/if}

									<div class="token-total">
										<span>Total context</span>
										<span class="token-total-val">~{totalContextTokens.toLocaleString()}</span>
									</div>
									{#if inputTokens > 0}
										<div class="token-total token-total-sub">
											<span>+ your message</span>
											<span>{inputTokens.toLocaleString()}</span>
										</div>
									{/if}

									<div class="token-foot">
										{#if modelLabel}Estimated for <b>{modelLabel}</b>, auto-calibrated from real usage.{:else}Estimate: calibrates from real usage.{/if}
									</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>

{#if chatStore.activeChatId}
	<ChatPersonaDialog
		open={personaDialogOpen}
		onClose={() => (personaDialogOpen = false)}
		chatId={chatStore.activeChatId}
		currentPersonaId={currentChatPersonaId}
	/>
{/if}

{#if duplicateTarget}
	<DuplicateChatDialog
		open={true}
		title={duplicateTarget.chat.title}
		footprint={duplicateTarget.footprint}
		busy={duplicating}
		onConfirm={(includeMemory) => runDuplicate(duplicateTarget!.chat, includeMemory)}
		onCancel={() => (duplicateTarget = null)}
	/>
{/if}

<style>
	.input-shell {
		border-top: 0;
		background: transparent;
		padding: clamp(0.55rem, 0.45rem + 0.55vw, 0.92rem) 0.7rem;
		/* Keep the composer above the home-bar inset. */
		padding-bottom: calc(clamp(0.55rem, 0.45rem + 0.55vw, 0.92rem) + env(safe-area-inset-bottom, 0px));
	}

	/* The composer tracks the transcript's content column (--chat-content-max,
	   app.css), not the chat shell: above the dock breakpoint the shell is a share
	   of the screen, and the box you type into has to sit exactly over the text it
	   feeds rather than stretch to the share. */
	.input-inner {
		width: 100%;
		max-width: var(--chat-content-max);
		margin: 0 auto;
	}

	/* One quiet line above the box, in the composer's own secondary voice. Muted on purpose:
	   it reports a state rather than asking for anything, and the answer to it (Stop) is the
	   button already sitting in the box below. */
	.composer-elsewhere {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0 0.3rem 0.4rem;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.composer-shell {
		padding: 0.48rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		border-radius: var(--radius-xl);
		position: relative;
	}

	/* Covers the composer while a drag is over it, and never interactive: the drop is
	   handled by the shell underneath, so this must not become the event target. */
	.composer-drop {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		border: 2px dashed var(--color-accent);
		border-radius: var(--radius-xl);
		background: color-mix(in srgb, var(--color-bg-solid) 88%, transparent);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	.composer-main {
		display: flex;
		gap: 0.42rem;
		align-items: flex-end;
		min-width: 0;
	}

	/* ===== Image attachments ===== */
	.attach-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		padding: 0.15rem 0.15rem 0;
	}

	.attach-thumb {
		position: relative;
		width: 3.4rem;
		height: 3.4rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 80%, transparent);
		overflow: hidden;
		background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
	}

	.attach-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.attach-uploading {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.attach-remove {
		position: absolute;
		top: 2px;
		right: 2px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.1rem;
		height: 1.1rem;
		border: none;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-bg-primary) 75%, transparent);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.attach-remove:hover {
		background: var(--color-bg-primary);
	}

	/* 17px is unhittable with a thumb, so grow the hit area and keep the visual size. */
	@media (pointer: coarse) {
		.attach-remove {
			width: 1.75rem;
			height: 1.75rem;
		}
	}

	.composer-textarea {
		flex: 1;
		min-width: 0;
		/* The row is just textarea + send now; give the text a little breathing room
		   and center it against the send button. */
		padding: 0.3rem 0.15rem 0.3rem 0.35rem;
	}

	/* Frozen under an open transform strip. The box is disabled, but it still holds the
	   draft that strip's proposal is about, so it keeps its text legible instead of fading
	   to the shared disabled 50%. Secondary text is muted enough to read as inert, never
	   as unreadable. */
	.composer-shell--frozen .composer-textarea:disabled {
		opacity: 1;
		color: var(--color-text-secondary);
	}

	/* Nowrap on purpose: with wrap, flexbox drops the whole right group to a second
	   line (where space-between lands it flush left, pushing the token popup
	   off-screen) before letting the feature group wrap internally. */
	.composer-meta {
		padding-top: 0.45rem;
		border-top: 1px solid var(--color-border-raised);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.composer-feature-group {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		flex-wrap: wrap;
	}

	/* The dropdown anchor must be a flex box: a block wrapper around an inline-flex
	   button reserves baseline descender space below it, which is exactly the
	   "one button sits lower" misalignment the old layout had. */
	.composer-menu-wrap {
		display: flex;
	}

	/* Compact tool buttons (insert menu, attach) sized to the meta-row chips so the
	   whole bottom row reads as one aligned strip. */
	.composer-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.9rem;
		height: 1.9rem;
		padding: 0;
		/* Same raised tier as the rule and the pips beside it: on the composer's own
		   surface `--color-border-subtle` measures ~1.2:1, so these outlines were a
		   hairline away from not being drawn at all, in every palette. */
		border: 1px solid var(--color-border-raised);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
	}

	.composer-icon-btn:hover:not(:disabled),
	.composer-icon-btn--active {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	@media (pointer: coarse) {
		.composer-icon-btn {
			width: 2.4rem;
			height: 2.4rem;
		}
	}

	.composer-icon-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.composer-feature-divider {
		width: 1px;
		height: 1.15rem;
		margin: 0 0.2rem;
		background: var(--color-border-raised);
		flex-shrink: 0;
	}

	.composer-right-group {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		justify-content: flex-end;
		flex-shrink: 0;
	}

	.composer-dropdown {
		max-width: min(16rem, calc(100vw - 1rem));
	}

	/* Menu rows: a fixed icon column then the label, in the same font-ui/secondary →
	   primary language as the persona popover beside it and the Library's entry menu.
	   The icon inherits currentColor, so one hover rule lifts the whole row. */
	.composer-menu-item {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 0;
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		text-align: left;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.composer-menu-item:hover:not(:disabled) {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.composer-menu-item:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.composer-menu-sep {
		margin: 0.25rem 0;
		border-top: 1px solid var(--color-border-subtle);
	}

	/* The box says what it has become, in the one colour the whole app uses for "this is
	   yours": nothing about the composer moves, so the change reads without costing a reflow
	   of the story above it. The list itself is CommandPalette.svelte. */
	.composer-shell--command {
		border-color: var(--color-accent);
	}

	/* ===== Persona quick switch ===== */

	/* The trigger doubles as the readout of who you currently are, so the portrait
	   fills it edge to edge (the icon fallback keeps the normal button padding). */
	.persona-trigger {
		overflow: hidden;
	}

	.persona-trigger-art {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.persona-menu {
		width: 15rem;
		max-width: calc(100vw - 1rem);
	}

	/* The grid needs room for three faces per row; below that it reads as a
	   worse list. auto-fill keeps it honest if the clamp ever narrows it. */
	.persona-menu.is-grid {
		width: 18.5rem;
	}

	.persona-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(4.6rem, 1fr));
		gap: 0.25rem;
		padding: 0.15rem 0.5rem;
		max-height: 17rem;
		overflow-y: auto;
	}

	.persona-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		padding: 0.4rem 0.25rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.66rem;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.persona-tile:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
		color: var(--color-text-primary);
	}

	.persona-tile.is-active {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.persona-tile-art {
		display: grid;
		place-items: center;
		width: 2.6rem;
		height: 2.6rem;
		border-radius: 999px;
		overflow: hidden;
		background: var(--color-bg-tertiary);
		color: var(--color-text-muted);
	}

	.persona-tile-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* The active mark is a ring on the portrait, not a check badge: a badge would be
	   clipped by the circle's own overflow, and the ring survives a dark thumbnail. */
	.persona-tile.is-active .persona-tile-art {
		box-shadow: 0 0 0 2px var(--color-accent);
	}

	.persona-tile-name {
		width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: center;
	}

	.persona-row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.65rem 0.35rem 0.5rem;
		border: 0;
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.76rem;
		text-align: left;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.persona-row:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
		color: var(--color-text-primary);
	}

	.persona-row.is-active {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.persona-check {
		width: 0.9rem;
		flex-shrink: 0;
		display: inline-flex;
		color: var(--color-accent);
		visibility: hidden;
	}

	.persona-check.is-visible {
		visibility: visible;
	}

	.persona-avatar {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		border-radius: 999px;
		overflow: hidden;
		background: var(--color-bg-tertiary);
		color: var(--color-text-muted);
	}

	.persona-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.persona-row-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ===== Steering trigger (the panel's own styles live in SteeringPopover) ===== */

	.steering-trigger {
		position: relative;
	}

	.steering-trigger--active {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	.steering-dot {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 999px;
		background: var(--color-accent);
	}

	.token-trigger {
		height: 1.75rem;
		padding: 0 0.52rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		font-family: var(--font-ui);
		font-size: 0.67rem;
		color: var(--color-text-muted);
		cursor: pointer;
	}
	/* History being dropped is the one prompt change with no other tell on screen. */
	.token-trigger.is-trimmed {
		color: var(--color-warning);
		border-color: color-mix(in srgb, var(--color-warning) 45%, transparent);
	}

	.token-trigger:hover {
		color: var(--color-text-primary);
	}

	/* Portaled to <body>, fixed off the trigger's box. That puts it above every fixed
	   overlay (assistant launcher is z 200) and immune to the chat column's stacking context.
	   Carries .surface-float in markup. */
	.token-popup {
		position: fixed;
		z-index: 1000;
		width: min(17.5rem, calc(100vw - 2rem));
		padding: 0.7rem;
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		/* Hidden until the placement effect has measured and positioned it. */
		visibility: hidden;
	}

	.token-popup-ready {
		visibility: visible;
	}

	.token-popup-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.55rem;
	}

	.token-popup-title {
		font-family: var(--font-ui);
		font-size: 0.76rem;
		font-weight: 640;
		color: var(--color-text-primary);
	}

	.token-popup-tag {
		font-family: var(--font-ui);
		font-size: 0.56rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
		padding: 0.04rem 0.32rem;
	}

	.token-bar {
		height: 0.5rem;
		border-radius: 9999px;
		overflow: hidden;
		display: flex;
		background: var(--color-bg-tertiary);
		margin-bottom: 0.62rem;
	}

	.token-bar-seg {
		height: 100%;
	}

	.token-rows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.token-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.token-dot {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: var(--radius-sm);
		flex-shrink: 0;
	}

	.token-row-name {
		flex: 1;
		min-width: 0;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-primary);
		line-height: 1.2;
	}

	.token-row-val {
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 640;
		color: var(--color-text-primary);
		font-variant-numeric: tabular-nums;
	}

	.token-total {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 0.6rem;
		padding-top: 0.55rem;
		border-top: 1px solid var(--color-border-subtle);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-secondary);
	}

	.token-total-val {
		font-weight: 720;
		color: var(--color-text-primary);
		font-variant-numeric: tabular-nums;
	}

	.token-total-sub {
		margin-top: 0.2rem;
		padding-top: 0;
		border-top: 0;
		font-size: 0.66rem;
		color: var(--color-text-muted);
	}

	.token-trim {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.55rem;
		padding: 0.35rem 0.5rem;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-warning) 12%, transparent);
		color: var(--color-warning);
		font-family: var(--font-ui);
		font-size: 0.68rem;
		line-height: 1.35;
	}

	.token-trim.over {
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
		color: var(--color-error);
	}

	.token-foot {
		margin-top: 0.55rem;
		font-family: var(--font-ui);
		font-size: 0.6rem;
		line-height: 1.35;
		color: var(--color-text-muted);
	}

	@media (max-width: 900px) {
		.input-shell {
			padding-inline: 0.45rem;
		}
	}

	@media (max-width: 560px) {
		.input-shell {
			padding-inline: 0.45rem;
		}

		.composer-shell {
			padding: 0.4rem;
		}

		.composer-main {
			gap: 0.32rem;
		}

		.token-popup {
			width: min(15rem, calc(100vw - 1rem));
		}
	}
</style>
