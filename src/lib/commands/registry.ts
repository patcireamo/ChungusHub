/**
 * Commands: the app's actions reached from the composer instead of from a control.
 *
 * This file is the single registry AND the single parser, one file on purpose: a command
 * is declared, documented, gated and matched in exactly one place. `COMMANDS` is the one
 * list, and the palette renders from it, so what the user can type can never drift from
 * what exists.
 *
 * Three rules hold everywhere and each is load-bearing:
 *
 *  - **A command is not a language.** There are no variables, no pipes, no closures, no
 *    chaining. A command has a name and at most ONE argument, and that argument is the rest
 *    of the line verbatim: no quoting, no escaping, no evaluation. Anything that would need
 *    a second argument gets a picker or stays a control.
 *  - **A command never gets a weaker gate than the control that does the same thing.** The
 *    gates that already exist are passed IN through `CommandContext` (the composer's own
 *    deriveds) rather than recomputed here, so a row in the composer menu and the command
 *    that stands in for it can never disagree about being available.
 *  - **No command implements behaviour.** Every `run` is one call into a store or into the
 *    composer's own door. A command that needed new logic would be a feature wearing a
 *    slash, and the logic belongs where its button already lives.
 *
 * See architecture/chat-sessions.md for the composer's command mode.
 */
import type { ComponentProps } from 'svelte';
import type Icon from '$lib/components/ui/Icon.svelte';
import { chatCursor } from '$lib/stores/chatCursor.svelte';
import { chatStore } from '$lib/stores/chat.svelte';
import { chatSearch } from '$lib/stores/chatSearch.svelte';
import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
import { lorebookStore } from '$lib/lorebook/store.svelte';
import { messageStore } from '$lib/stores/messages.svelte';
import { steeringStore } from '$lib/stores/steering.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { uiStore } from '$lib/stores/ui.svelte';

/** Read off the icon component itself, so a name that does not draw is a build error. */
type CommandIcon = ComponentProps<typeof Icon>['name'];

export type CommandGroup = 'write' | 'story' | 'chat' | 'open';

/** Group order and headings in the palette. Display only; nothing derives behaviour here. */
export const COMMAND_GROUPS: { id: CommandGroup; label: string }[] = [
	{ id: 'write', label: 'Write' },
	{ id: 'story', label: 'Story' },
	{ id: 'chat', label: 'Chat' },
	{ id: 'open', label: 'Open' }
];

/**
 * The composer's own doors. Three commands stand in for controls the composer already owns
 * rather than for a store call: Continue and Retry are wrapped by `ChatContainer` (one with
 * a try/catch, one without, because retry toasts its own failures), and Duplicate raises a
 * dialog that has to be mounted somewhere. Routing them back through the host is what keeps
 * a command and its menu row the SAME call instead of a second copy of it.
 */
export interface CommandHost {
	continueMessage(): void;
	regenerateLast(): void;
	swipeLast(): void;
	requestDuplicate(): void;
}

/** Everything a command may ask about the workspace, resolved once by the composer. */
export interface CommandContext {
	chatId: string | null;
	activeLeafId: string | null;
	canonLeafId: string | null;
	/** The chat's library character while it still resolves; null once it is deleted. */
	characterEntryId: string | null;
	/** The app-wide active persona's library entry, or null when none is set. */
	personaEntryId: string | null;
	/** The newest turn on the visible path. */
	lastTurnId: string | null;
	/** The composer's own gate deriveds, passed in rather than recomputed. */
	canContinue: boolean;
	canRegenerateLast: boolean;
	canSwipeLast: boolean;
	regenerateLastHint: string;
	host: CommandHost;
}

export interface CommandArg {
	/** Placeholder shown after the name in the palette and in the composer's hint. */
	label: string;
	/** A command whose argument is required cannot run on an empty one. */
	required: boolean;
}

export interface CommandDef {
	/** Typed without the slash. Lowercase, no spaces. */
	name: string;
	/** Extra spellings that resolve to this command, mostly SillyTavern muscle memory. */
	aliases?: string[];
	group: CommandGroup;
	icon: CommandIcon;
	/** One line: what it does. The only copy any UI shows. */
	describe: string;
	arg?: CommandArg;
	/** Why this command cannot run right now, or null when it can. Shown on the row. */
	unavailable?(ctx: CommandContext): string | null;
	run(arg: string, ctx: CommandContext): void | Promise<void>;
}

/** Panel swaps flush pending lorebook edits, the same call every other navigation makes. */
const flush = () => lorebookStore.flush();

const NO_CHAT = 'Open a chat first';

export const COMMANDS: CommandDef[] = [
	// ===== Write =====
	{
		name: 'say',
		aliases: ['send'],
		group: 'write',
		icon: 'user',
		describe: 'Add a turn of yours without asking for a reply',
		arg: { label: 'text', required: true },
		unavailable: (ctx) => (ctx.chatId ? null : NO_CHAT),
		run: (text) => messageStore.insertDummyMessage('user', text)
	},

	// ===== Story =====
	{
		name: 'continue',
		group: 'story',
		icon: 'arrowRight',
		describe: 'Extend the newest reply where it stops',
		unavailable: (ctx) => (ctx.canContinue ? null : 'The newest turn must be a reply'),
		run: (_arg, ctx) => ctx.host.continueMessage()
	},
	{
		name: 'retry',
		aliases: ['regenerate'],
		group: 'story',
		icon: 'refresh',
		describe: 'Generate the newest turn again',
		unavailable: (ctx) => (ctx.canRegenerateLast ? null : ctx.regenerateLastHint),
		run: (_arg, ctx) => ctx.host.regenerateLast()
	},
	{
		// Retry's non-destructive half, so it wears Retry's own glyph: the two are the rows
		// behind one button in the transcript, and drawing them alike is what says so.
		name: 'swipe',
		group: 'story',
		icon: 'refresh',
		describe: 'Add an alternate reply to swipe between',
		unavailable: (ctx) =>
			ctx.canSwipeLast ? null : 'The newest turn must be a reply, or a turn of yours',
		run: (_arg, ctx) => ctx.host.swipeLast()
	},
	{
		name: 'opening',
		aliases: ['scene'],
		group: 'story',
		icon: 'sparkles',
		describe: 'Write another opening scene beside the ones already there',
		// Optional: an empty direction is the surprise, which is the whole reason the popover
		// this stands in for needs no Random button.
		arg: { label: 'direction', required: false },
		unavailable: (ctx) => {
			if (!ctx.chatId) return NO_CHAT;
			return featurePromptsStore.openingSceneEnabled
				? null
				: 'Opening Scene is switched off in Settings → Engines';
		},
		run: (direction) => {
			// Same guard as the sparkle's disabled state: one generation holds the one abort
			// controller.
			if (messageStore.warnIfBusy()) return;
			return messageStore.generateOpeningScene(direction);
		}
	},
	{
		name: 'branch',
		group: 'story',
		icon: 'branch',
		describe: 'Write an alternate of the newest turn by hand',
		unavailable: (ctx) => (ctx.lastTurnId ? null : 'This chat has no turns yet'),
		run: (_arg, ctx) => {
			messageStore.branchTargetId = ctx.lastTurnId;
		}
	},
	{
		name: 'canon',
		group: 'story',
		icon: 'crown',
		describe: 'Mark this timeline canon, or unmark it',
		unavailable: (ctx) => (ctx.activeLeafId ? null : NO_CHAT),
		run: async (_arg, ctx) => {
			const already = ctx.canonLeafId === ctx.activeLeafId;
			await chatStore.setCanonLeaf(already ? null : ctx.activeLeafId);
			toastStore.success(already ? 'Canon cleared' : 'This timeline is canon');
		}
	},
	{
		name: 'steer',
		aliases: ['note', 'inject'],
		group: 'story',
		icon: 'compass',
		describe: 'Guide the next reply once, then it is spent',
		arg: { label: 'guidance', required: true },
		unavailable: () =>
			featurePromptsStore.steeringEnabled ? null : 'Steering is switched off in Settings → Engines',
		run: async (text, ctx) => {
			// One-shot and inherited placement, exactly what the composer's quick box writes:
			// this is that box reached from the keyboard, not a second kind of note.
			await steeringStore.create({
				text,
				scope: ctx.chatId ? 'chat' : 'global',
				scopeId: ctx.chatId,
				mode: 'once'
			});
			toastStore.success('Steering the next reply');
		}
	},

	// ===== Chat =====
	{
		name: 'new',
		group: 'chat',
		icon: 'plus',
		describe: 'Start another chat with this character',
		unavailable: (ctx) =>
			ctx.characterEntryId ? null : "This story's character is gone from the library",
		run: (_arg, ctx) => {
			// Same guard as the menu row: createChat opens the chat it makes, which swaps out
			// the state a running stream writes into.
			if (messageStore.warnIfBusy()) return;
			void chatStore.createChat({ characterId: ctx.characterEntryId! });
		}
	},
	{
		name: 'rename',
		aliases: ['renamechat'],
		group: 'chat',
		icon: 'pencil',
		describe: "Change this chat's title",
		arg: { label: 'title', required: true },
		unavailable: (ctx) => (ctx.chatId ? null : NO_CHAT),
		run: async (title, ctx) => {
			await chatStore.updateChatTitle(ctx.chatId!, title.trim());
			toastStore.success('Chat renamed');
		}
	},
	{
		name: 'duplicate',
		group: 'chat',
		icon: 'copy',
		describe: 'Copy this chat whole and open the copy',
		unavailable: (ctx) => (ctx.chatId ? null : NO_CHAT),
		run: (_arg, ctx) => ctx.host.requestDuplicate()
	},
	{
		name: 'home',
		group: 'chat',
		icon: 'home',
		describe: 'Close the chat and go back to the landing screen',
		run: () => {
			if (messageStore.warnIfBusy()) return;
			void chatStore.goHome();
		}
	},

	// ===== Open =====
	{
		name: 'find',
		group: 'open',
		icon: 'search',
		describe: "Search this story's messages",
		arg: { label: 'text', required: false },
		unavailable: (ctx) => (ctx.chatId ? null : NO_CHAT),
		run: (text) => {
			if (text.trim()) chatSearch.query = text.trim();
			chatSearch.show();
		}
	},
	{
		// The transcript's third door, beside stepping and find in chat: an address. Every turn
		// already wears its number under its portrait, so the story is numbered whether or not
		// anyone reaches it this way (architecture/chat-sessions.md, "The message cursor").
		name: 'go',
		aliases: ['turn'],
		group: 'open',
		icon: 'target',
		describe: 'Put the keyboard on a turn by its number',
		arg: { label: 'number', required: true },
		unavailable: (ctx) => (ctx.chatId ? null : NO_CHAT),
		run: (text) => {
			const ordinal = Number(text.trim());
			if (Number.isInteger(ordinal) && chatCursor.goToOrdinal(ordinal)) return;
			toastStore.warning(`This story runs from turn 1 to ${chatCursor.turnCount}`);
		}
	},
	{
		name: 'character',
		group: 'open',
		icon: 'user',
		describe: "Open this story's character in the Library editor",
		unavailable: (ctx) =>
			ctx.characterEntryId ? null : "This story's character is gone from the library",
		run: (_arg, ctx) => uiStore.openLibraryEntry(ctx.characterEntryId!, 'character', flush)
	},
	{
		name: 'persona',
		group: 'open',
		icon: 'userCheck',
		describe: 'Open the persona you are playing in the Library editor',
		unavailable: (ctx) => (ctx.personaEntryId ? null : 'You have no persona set'),
		run: (_arg, ctx) => uiStore.openLibraryEntry(ctx.personaEntryId!, 'persona', flush)
	},
	{
		name: 'map',
		group: 'open',
		icon: 'sitemap',
		describe: 'Open the Story Map',
		run: () => uiStore.openOverlay('storymap', flush)
	},
	{
		name: 'chats',
		group: 'open',
		icon: 'chat',
		describe: 'Open the Chats browser',
		run: () => uiStore.openChats()
	},
	{
		name: 'memory',
		group: 'open',
		icon: 'brain',
		describe: 'Open Chat Memory',
		run: () => uiStore.openOverlay('memory', flush)
	},
	{
		name: 'lorebook',
		aliases: ['world'],
		group: 'open',
		icon: 'bookOpen',
		describe: 'Open Lorebooks',
		run: () => uiStore.openOverlay('lorebook', flush)
	},
	{
		name: 'library',
		group: 'open',
		icon: 'users',
		describe: 'Open the Library',
		run: () => uiStore.openLibrary(flush)
	},
	{
		name: 'assistant',
		group: 'open',
		icon: 'sparkles',
		describe: 'Open the Chungus Assistant',
		run: () => uiStore.openAssistant()
	},
	{
		name: 'settings',
		group: 'open',
		icon: 'settings',
		describe: 'Open Settings',
		run: () => uiStore.openSettings(flush)
	},
	{
		name: 'debug',
		group: 'open',
		icon: 'flask',
		describe: 'Open the prompt debug panel',
		run: () => uiStore.openDebugPanel(flush)
	}
];

/** Name and alias lookup, built once. */
const BY_NAME = new Map<string, CommandDef>();
for (const command of COMMANDS) {
	BY_NAME.set(command.name, command);
	for (const alias of command.aliases ?? []) BY_NAME.set(alias, command);
}

export function commandByName(name: string): CommandDef | null {
	return BY_NAME.get(name.toLowerCase()) ?? null;
}

/**
 * What the composer's text currently means.
 *
 * The shape is deliberately trivial: a leading slash, a name up to the first space, and
 * everything after that space as ONE verbatim argument. That is the whole grammar, and it
 * is why nothing in a command's argument ever needs escaping.
 */
export interface ParsedCommand {
	/** The typed name, without the slash, lowercased. */
	name: string;
	/** The rest of the line after the first space, exactly as typed. */
	arg: string;
	/** True once a space has been typed: the name is settled and the argument is being filled. */
	settled: boolean;
}

export function parseCommandInput(text: string): ParsedCommand | null {
	if (!text.startsWith('/')) return null;
	// A newline means the box is being used for prose that happens to start with a slash.
	if (text.includes('\n')) return null;
	const space = text.indexOf(' ');
	if (space === -1) return { name: text.slice(1).toLowerCase(), arg: '', settled: false };
	return { name: text.slice(1, space).toLowerCase(), arg: text.slice(space + 1), settled: true };
}

/**
 * Commands offered for what has been typed so far, best first.
 *
 * Once a space is typed the name is settled, so the list collapses to the one command it
 * names (or nothing, which is what lets an unrecognised line fall back to being prose).
 * Before that it is a match over names, aliases and descriptions, so someone who knows what
 * they want but not what it is called still finds it: "narrate" reaches `/say`.
 *
 * **Ranked, not filtered**, and that is the whole reason this is not a one-line `filter`.
 * Descriptions are full of the words other commands are NAMED after ("Start another chat
 * with this character" contains "chara"), so a flat match puts a command the user is not
 * spelling above the one they are, and the highlight sits on the wrong row while the right
 * one is on screen. Spelling the name beats spelling part of it, which beats hitting a
 * description; registry order decides inside a tier, and `sort` is stable, so it holds.
 */
export function matchCommands(parsed: ParsedCommand): CommandDef[] {
	if (parsed.settled) {
		const exact = commandByName(parsed.name);
		return exact ? [exact] : [];
	}
	const typed = parsed.name;
	if (!typed) return COMMANDS;
	const ranked: { command: CommandDef; tier: number }[] = [];
	for (const command of COMMANDS) {
		const spellings = [command.name, ...(command.aliases ?? [])];
		if (spellings.some((spelling) => spelling.startsWith(typed))) ranked.push({ command, tier: 0 });
		else if (spellings.some((spelling) => spelling.includes(typed))) ranked.push({ command, tier: 1 });
		else if (command.describe.toLowerCase().includes(typed)) ranked.push({ command, tier: 2 });
	}
	return ranked.sort((a, b) => a.tier - b.tier).map((entry) => entry.command);
}

/** Whether this command can run on the argument as typed. */
export function argSatisfied(command: CommandDef, arg: string): boolean {
	if (!command.arg?.required) return true;
	return arg.trim().length > 0;
}

/**
 * Run one command, reporting a refusal rather than doing nothing.
 *
 * The palette already disables an unavailable row, so this path is the second guard: it is
 * what keeps a command that became unavailable between the keystroke and the Enter from
 * running anyway.
 *
 * **The verdict is the acceptance, never the work.** A `run` can be a whole generation
 * (`/continue`), and a caller that waited on it would hold the composer in command mode for
 * the length of that generation: the line still reading `/conti`, the palette still listing
 * matches, the box locked behind a press that already landed. Both refusals are decided
 * before any work starts, so they are still the caller's to act on; everything after them is
 * the command's own business, and a throw there is a failure rather than a refusal and says
 * so itself.
 */
export function runCommand(command: CommandDef, arg: string, ctx: CommandContext): boolean {
	const refused = command.unavailable?.(ctx) ?? null;
	if (refused) {
		toastStore.warning(refused);
		return false;
	}
	if (!argSatisfied(command, arg)) {
		toastStore.warning(`/${command.name} needs ${command.arg?.label ?? 'an argument'}`);
		return false;
	}
	void (async () => {
		try {
			await command.run(arg, ctx);
		} catch (error) {
			toastStore.failed(`run /${command.name}`, error);
		}
	})();
	return true;
}
