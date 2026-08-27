<script lang="ts">
	/**
	 * Find in chat: a floating bar over the message list.
	 *
	 * It replaces the browser's find for this surface, because the browser's can only ever
	 * see what a page happens to be: it can't tell a message from the chrome around it,
	 * can't count hits per turn, can't be reached from the composer, and can't see past the
	 * one branch that happens to be rendered. This one searches the rendered story text only
	 * (`[data-search-text]` in Message.svelte), so the meta rows, token readouts and toolbars
	 * never produce phantom hits. It reports the off-path branches separately, since
	 * reaching one means switching the transcript, which no navigation key should do on its
	 * own. Clicking a branch row is the deliberate act that moves the view.
	 *
	 * The transcript window is a rendering budget, not a scope: a query loads back through its
	 * oldest match (see "Reaching past the transcript window" below), so everything the
	 * counter and the ∧/∨ cycle say is about the whole branch.
	 *
	 * Matches are DOM Ranges painted through the CSS Custom Highlight API. See
	 * utils/chat-search.ts for why nothing here touches the message markup, and app.css
	 * ("Find in chat") for the two ::highlight() rules.
	 */
	import { untrack } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { chatSearch } from '$lib/stores/chatSearch.svelte';
	import { chatCursor } from '$lib/stores/chatCursor.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { messageStore } from '$lib/stores/messages.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { chatPersonaStore } from '$lib/stores/chatPersona.svelte';
	import { expandSelfRefs } from '$lib/macros';
	import { branchColorHex } from '$lib/utils/branch-labels';
	import {
		buildSearchRegex,
		findBranchHits,
		findMatchRanges,
		MAX_BRANCH_HITS,
		MAX_MATCHES
	} from '$lib/utils/chat-search';
	import type { Message } from '$lib/types/chat';

	interface Props {
		/** The message-list scroller: both the search root and what we scroll to a hit. */
		container: HTMLElement | undefined;
		/** The rendered transcript. Read as a change signal only: an edit, a branch switch
		 *  or a new turn replaces the array, which re-runs the match pass against the DOM
		 *  Svelte has just updated. */
		messages: Message[];
		/** Every turn in the chat, on-path and off. The off-path remainder is what the
		 *  branch list searches. */
		allMessages: Message[];
		/** How many turns at the START of the path the transcript window is holding back.
		 *  0 = the whole branch is rendered and nothing below applies. */
		windowStart: number;
		/** Load earlier turns until the turn at this path index is rendered. */
		loadThrough: (index: number) => void;
	}

	let { container, messages, allMessages, windowStart, loadThrough }: Props = $props();

	/** Registry keys, paired with the ::highlight() rules in app.css. */
	const HL_ALL = 'chat-find';
	const HL_CURRENT = 'chat-find-current';
	const canHighlight = typeof CSS !== 'undefined' && !!CSS.highlights;

	let matches = $state<Range[]>([]);
	let current = $state(-1);
	let inputEl = $state<HTMLInputElement | undefined>(undefined);
	let branchListOpen = $state(false);

	// ===== Off-path branches =====
	// Same live expansion Message.svelte does, so a greeting's raw {{char}}/{{user}} is
	// searchable by the name actually on screen (architecture/chat-sessions.md coupling 6).
	let selfRefChar = $derived(
		characterLibraryStore.entries.find((e) => e.id === chatStore.activeChat?.characterId)?.identity
			.name || 'Character'
	);
	let selfRefUser = $derived(chatPersonaStore.resolved?.name || 'You');

	let branchHits = $derived.by(() => {
		const regex = buildSearchRegex(chatSearch.query, {
			matchCase: chatSearch.matchCase,
			wholeWord: chatSearch.wholeWord
		});
		if (!regex) return [];
		const onPath = new Set(messages.map((m) => m.id));
		const offPath = allMessages
			.filter((m) => !onPath.has(m.id))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((m) => ({
				id: m.id,
				role: m.role,
				text: expandSelfRefs(m.content, selfRefChar, selfRefUser)
			}));
		return findBranchHits(offPath, regex, MAX_BRANCH_HITS);
	});

	/** Branch names by message id, so a row's tag is a lookup rather than a scan of the
	 *  whole chat per render. Rows without one fall back to the speaker. */
	let branchLabels = $derived(
		new Map(allMessages.filter((m) => m.branchLabel).map((m) => [m.id, m.branchLabel!]))
	);

	let capped = $derived(matches.length >= MAX_MATCHES);
	let countLabel = $derived.by(() => {
		if (!chatSearch.query) return '';
		if (matches.length) return `${current + 1} / ${matches.length}${capped ? '+' : ''}`;
		// Until the scan behind the window has come back, any verdict would be a claim about
		// turns the search has not reached yet.
		if (!earlierChecked) return 'Searching…';
		// "No matches" would be a lie while the branch list holds some; say where they aren't.
		return branchHits.length ? 'None on this branch' : 'No matches';
	});

	// ===== Reaching past the transcript window =====
	// The window renders the newest stretch of a long branch (architecture/chat-sessions.md
	// coupling 14). A search that quietly stopped at its top edge would answer "no matches"
	// about a story that has them, so a query loads back through its OLDEST match and every
	// hit above then becomes an ordinary on-screen one, counted and cycled like the rest.
	//
	// The scan reads the stored rows, since an unrendered turn has no DOM: the same asymmetry
	// the branch list lives with, so a hit that exists only once a display regex rule has run
	// is not seen from here. It is debounced because find-as-you-type walks through prefixes
	// ("h", "ha", …) that match far more of the story than the word being typed.
	const EARLIER_SCAN_MS = 250;
	/** False while a scan is owed: the counter must not call a search empty before then. */
	let earlierChecked = $state(true);
	/** Set beside a load this bar asked for, so the pass that sees those turns knows nothing
	 *  else has placed the view. */
	let pendingGrowth = false;

	$effect(() => {
		const hidden = windowStart;
		const path = messages;
		const char = selfRefChar;
		const user = selfRefUser;
		const regex = buildSearchRegex(chatSearch.query, {
			matchCase: chatSearch.matchCase,
			wholeWord: chatSearch.wholeWord
		});
		if (!regex || hidden <= 0) {
			earlierChecked = true;
			return;
		}
		earlierChecked = false;
		const timer = setTimeout(() => {
			for (let i = 0; i < hidden; i++) {
				// Global regex: its cursor has to be rewound per turn.
				regex.lastIndex = 0;
				if (regex.test(expandSelfRefs(path[i].content, char, user))) {
					pendingGrowth = true;
					loadThrough(i);
					return;
				}
			}
			earlierChecked = true;
		}, EARLIER_SCAN_MS);
		return () => clearTimeout(timer);
	});

	// Both plain lets, not $state: bookkeeping the effect below reads, where reactivity
	// would only buy it a redundant re-run.
	//
	// What the current `matches` were computed for.
	let searchKey = '';
	// A branch row was clicked and the transcript is being switched to it. The pass that
	// sees the new DOM claims this and lands the cursor on that turn's first hit.
	let pendingTargetId: string | null = null;

	$effect(() => {
		// Flags first, at fixed width, then the raw query: no separator can be ambiguous
		// because the first two characters are always the flags.
		const key = `${chatSearch.matchCase ? 'C' : 'c'}${chatSearch.wholeWord ? 'W' : 'w'}${chatSearch.query}`;
		const root = container;
		void messages;
		// Earlier turns arriving is a DOM change like any other, and their hits are ours.
		void windowStart;
		// Nothing rendered yet. Leave searchKey alone so the first real pass still counts
		// as a new search and jumps to its first hit.
		if (!root) return;

		// The cursor follows the HIT, not its number: turns loading above prepend ranges, so
		// a cursor kept by index would silently slide onto an older match. The turns already
		// on screen keep their nodes across a load (the each block is keyed and renderedHtml
		// patches in place), so node identity is what survives.
		const anchor = untrack(() => (current >= 0 ? (matches[current] ?? null) : null));

		const regex = buildSearchRegex(chatSearch.query, {
			matchCase: chatSearch.matchCase,
			wholeWord: chatSearch.wholeWord
		});
		const found: Range[] = [];
		if (regex) {
			for (const turn of root.querySelectorAll('[data-search-text]')) {
				found.push(...findMatchRanges(turn, regex, MAX_MATCHES - found.length));
				if (found.length >= MAX_MATCHES) break;
			}
		}

		const isNewSearch = key !== searchKey;
		const anchored = anchor
			? found.findIndex(
					(r) => r.startContainer === anchor.startContainer && r.startOffset === anchor.startOffset
				)
			: -1;
		searchKey = key;
		matches = found;
		// Untracked: the cursor is an OUTPUT of this pass, and reading it as a dependency
		// would make every write re-run the whole DOM walk a second time per keystroke.
		untrack(() => {
			// A branch jump has landed: aim at the turn the user actually clicked, whatever
			// its position in the freshly rendered path. Cleared either way, so a jump that
			// found nothing can't fire on some later transcript change.
			const target = pendingTargetId;
			pendingTargetId = null;
			// Earlier turns were loaded for this bar, so nothing else has placed the view and
			// the stretch that arrived sits above the reader.
			const grown = pendingGrowth;
			pendingGrowth = false;
			if (target) {
				const host = root.querySelector(`#msg-${CSS.escape(target)}`);
				const landed = host ? found.findIndex((r) => host.contains(r.startContainer)) : -1;
				if (landed >= 0) {
					current = landed;
					// Instant when the turn arrived with a load: the view is a whole loaded
					// stretch away from it, and a glide would travel every turn of it.
					reveal(found[landed], grown ? 'instant' : 'smooth');
					return;
				}
				// No row at all: the branch switch landed, but the turn sits behind the window.
				// Load back through it and keep the claim for the pass that will see it.
				const at = host ? -1 : messages.findIndex((m) => m.id === target);
				if (at >= 0 && at < windowStart) {
					pendingTargetId = target;
					pendingGrowth = true;
					loadThrough(at);
					return;
				}
			}
			if (isNewSearch) {
				// Find-as-you-type: land on the first hit the moment one exists.
				current = found.length ? 0 : -1;
				if (found.length) reveal(found[0], grown ? 'instant' : 'smooth');
				return;
			}
			if (anchored >= 0) current = anchored;
			else if (current < 0 || current >= found.length) {
				// The transcript changed under us; keep a valid cursor without moving the view.
				current = found.length ? Math.min(Math.max(current, 0), found.length - 1) : -1;
			}
			// Park back on the hit the reader is on, instantly: the scroller's CSS glide would
			// otherwise travel the whole stretch that just loaded above it.
			if (grown && current >= 0) reveal(found[current], 'instant');
		});
	});

	$effect(() => {
		if (!canHighlight) return;
		const all = matches;
		const active = current >= 0 ? all[current] : undefined;
		if (all.length) CSS.highlights.set(HL_ALL, new Highlight(...all));
		else CSS.highlights.delete(HL_ALL);
		if (active) {
			const one = new Highlight(active);
			// Explicit, not registration order: the current hit always paints over the wash.
			one.priority = 1;
			CSS.highlights.set(HL_CURRENT, one);
		} else {
			CSS.highlights.delete(HL_CURRENT);
		}
		return () => {
			CSS.highlights.delete(HL_ALL);
			CSS.highlights.delete(HL_CURRENT);
		};
	});

	// The hit the reader is on is also where the KEYBOARD is in the story. MARKED and never
	// taken: this runs while they are still typing in the field above, and a mark that moved
	// focus would empty that box on the first match. Closing the bar is what hands the keyboard
	// over (`close` below), and that is what makes find-and-edit one gesture instead of a
	// search followed by a hunt: type, Escape, E.
	$effect(() => {
		const active = current >= 0 ? matches[current] : undefined;
		if (!active) return;
		const start = active.startContainer;
		const from = start.nodeType === Node.TEXT_NODE ? start.parentElement : (start as Element);
		const host = from?.closest<HTMLElement>('[id^="msg-"]');
		if (host) chatCursor.mark(host.id.slice('msg-'.length));
	});

	/** Closing hands the keyboard to the turn the search left the reader on, so the transcript's
	 *  own keys act on what was found rather than on wherever the story happens to end. */
	function close(): void {
		chatSearch.close();
		chatCursor.take();
	}

	// Every open request focuses the field and selects what's in it, so re-triggering the
	// bar while it is already up behaves like a fresh open instead of doing nothing.
	$effect(() => {
		void chatSearch.openNonce;
		inputEl?.focus();
		inputEl?.select();
	});

	/** Scroll a hit into the reading zone. The scroller carries `scroll-behavior: smooth`, so
	 *  the default glides exactly like the list's own jump-to-latest; `instant` is for the one
	 *  case that must not glide, re-parking after earlier turns have loaded above, and it is
	 *  the only value that overrides that CSS (`auto` defers to it). */
	function reveal(range: Range, behavior: ScrollBehavior = 'smooth') {
		if (!container) return;
		const hit = range.getBoundingClientRect();
		const host = container.getBoundingClientRect();
		// Parked above centre: this bar floats over the top of the list, and reading
		// continues downward from the match.
		const target = container.scrollTop + (hit.top - host.top) - container.clientHeight * 0.38;
		container.scrollTo({
			top: Math.max(0, Math.min(target, container.scrollHeight - container.clientHeight)),
			behavior
		});
	}

	function go(direction: 1 | -1) {
		if (!matches.length) return;
		current = (current + direction + matches.length) % matches.length;
		reveal(matches[current]);
		// The buttons never take the caret: Enter has to keep cycling after a click, and a
		// click that quietly disarmed the keyboard would be the worse surprise.
		inputEl?.focus();
	}

	/** Switch the transcript to an off-path hit's branch. Deliberately a click, never part
	 *  of the ∧/∨ cycle: this rewrites what the reader is looking at. */
	async function jumpToBranch(messageId: string) {
		branchListOpen = false;
		pendingTargetId = messageId;
		// navigateToBranch self-guards on warnIfBusy and no-ops mid-stream, which leaves the
		// pending id for the next pass, which is harmless: that pass clears it unconditionally.
		await messageStore.navigateToBranch(messageId);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			go(e.shiftKey ? -1 : 1);
		} else if (e.key === 'Escape') {
			// Consume it: the workspace's global Escape would otherwise also close the
			// panel hosting this chat (shell Esc contract, architecture/ui-shell-settings.md).
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	}
</script>

<div class="find-bar surface-float shadow-md fade-in" role="search" aria-label="Find in chat">
	<div class="find-row">
		<Icon name="search" class="w-4 h-4 shrink-0 text-text-muted" />
		<input
			bind:this={inputEl}
			bind:value={chatSearch.query}
			type="text"
			class="find-input"
			placeholder="Find in this chat…"
			aria-label="Find in this chat"
			autocomplete="off"
			spellcheck="false"
			onkeydown={onKeydown}
		/>
		<span
			class="find-count"
			class:find-count--none={!!chatSearch.query &&
				earlierChecked &&
				!matches.length &&
				!branchHits.length}
			aria-live="polite"
		>
			{countLabel}
		</span>
		<button
			type="button"
			class="find-btn"
			disabled={!matches.length}
			aria-label="Previous match"
			title="Previous match (Shift+Enter)"
			onclick={() => go(-1)}
		>
			<Icon name="chevronUp" class="w-4 h-4" />
		</button>
		<button
			type="button"
			class="find-btn"
			disabled={!matches.length}
			aria-label="Next match"
			title="Next match (Enter)"
			onclick={() => go(1)}
		>
			<Icon name="chevronDown" class="w-4 h-4" />
		</button>
		<button
			type="button"
			class="find-btn"
			aria-label="Close search"
			title="Close (Esc)"
			onclick={close}
		>
			<Icon name="close" class="w-4 h-4" />
		</button>
	</div>

	<div class="find-opts">
		<button
			type="button"
			class="find-pill"
			class:find-pill--on={chatSearch.matchCase}
			aria-pressed={chatSearch.matchCase}
			title="Distinguish upper and lower case"
			onclick={() => (chatSearch.matchCase = !chatSearch.matchCase)}
		>
			Match case
		</button>
		<button
			type="button"
			class="find-pill"
			class:find-pill--on={chatSearch.wholeWord}
			aria-pressed={chatSearch.wholeWord}
			title="Only match complete words"
			onclick={() => (chatSearch.wholeWord = !chatSearch.wholeWord)}
		>
			Whole words
		</button>
		{#if !canHighlight}
			<span class="find-note">Highlighting needs a newer browser. Hits still scroll into view.</span>
		{/if}

		{#if branchHits.length}
			<button
				type="button"
				class="find-branch-toggle"
				aria-expanded={branchListOpen}
				title="Turns on swipes, alternates and forks that aren't in view"
				onclick={() => (branchListOpen = !branchListOpen)}
			>
				<Icon
					name="chevronRight"
					class="w-3 h-3 transition-transform {branchListOpen ? 'rotate-90' : ''}"
				/>
				{branchHits.length}{branchHits.length >= MAX_BRANCH_HITS ? '+' : ''} on other branches
			</button>
		{/if}
	</div>

	{#if branchListOpen && branchHits.length}
		<ul class="find-branches">
			{#each branchHits as hit (hit.messageId)}
				{@const label = branchLabels.get(hit.messageId)}
				<li>
					<button type="button" class="find-branch-row" title={hit.snippet} onclick={() => jumpToBranch(hit.messageId)}>
						{#if label}
							<span class="find-branch-tag" style="--bc: {branchColorHex(label.color)};">
								{label.name}
							</span>
						{:else}
							<span class="find-branch-role">{hit.role === 'user' ? 'You' : hit.role === 'assistant' ? 'Reply' : hit.role}</span>
						{/if}
						<span class="find-branch-snippet">{hit.snippet}</span>
						{#if hit.count > 1}<span class="find-branch-count">{hit.count}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	/* Centred by auto margins between pinned edges, NOT left:50% + translateX(-50%): the
	   .fade-in entry animation animates `transform`, which would override the centring
	   translate for its whole duration and slide the bar in from half a width to the
	   right before snapping into place. */
	.find-bar {
		position: absolute;
		top: 0.6rem;
		left: 0;
		right: 0;
		margin-inline: auto;
		z-index: 12;
		width: min(30rem, calc(100% - 1.2rem));
		padding: 0.4rem 0.45rem 0.42rem 0.6rem;
		border-radius: var(--radius-lg);
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.find-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.find-input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.82rem;
		color: var(--color-text-primary);
		outline: none;
	}

	.find-input::placeholder {
		color: var(--color-text-muted);
	}

	.find-count {
		flex-shrink: 0;
		padding-right: 0.15rem;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.find-count--none {
		color: var(--color-error);
	}

	.find-btn {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, transform 90ms ease;
	}

	.find-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	/* Cycling to the next hit can be invisible (one match, or a hit already on screen),
	   so the press itself has to answer. Accent tint plus a real depress. */
	.find-btn:active:not(:disabled) {
		background: color-mix(in srgb, var(--color-accent) 20%, transparent);
		color: var(--color-accent);
		transform: scale(0.88);
		transition-duration: 0ms;
	}

	.find-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	@media (pointer: coarse) {
		.find-btn {
			width: 2.3rem;
			height: 2.3rem;
		}
	}

	.find-opts {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.3rem;
		padding-top: 0.32rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.find-pill {
		padding: 0.16rem 0.5rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.66rem;
		font-weight: 600;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
	}

	.find-pill:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
	}

	/* Local copy of the active-tint recipe, declared after :hover so source order wins the
	   tie: a scoped rule always beats the layered global .is-active-tint (see app.css). */
	.find-pill--on {
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		color: var(--color-accent);
	}

	.find-note {
		font-family: var(--font-ui);
		font-size: 0.62rem;
		line-height: 1.3;
		color: var(--color-warning);
	}

	/* ===== Off-path branches ===== */

	/* Takes the free end of the options row, so the bar stays two rows tall until the
	   reader actually opens the list. */
	.find-branch-toggle {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 0.22rem;
		padding: 0.16rem 0.4rem 0.16rem 0.28rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.66rem;
		font-weight: 600;
		color: var(--color-accent);
		cursor: pointer;
		transition: background-color 120ms ease;
	}

	.find-branch-toggle:hover {
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
	}

	.find-branches {
		margin: 0;
		padding: 0.28rem 0 0;
		list-style: none;
		border-top: 1px solid var(--color-border-subtle);
		max-height: 11rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.find-branch-row {
		width: 100%;
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.26rem 0.4rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		text-align: left;
		cursor: pointer;
		transition: background-color 120ms ease;
	}

	.find-branch-row:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
	}

	.find-branch-role,
	.find-branch-tag {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
	}

	.find-branch-tag {
		max-width: 6rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0.02rem 0.3rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--bc) 45%, transparent);
		background: color-mix(in srgb, var(--bc) 13%, transparent);
		color: var(--color-text-primary);
		text-transform: none;
	}

	.find-branch-snippet {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-body);
		font-size: 0.74rem;
		color: var(--color-text-secondary);
	}

	.find-branch-count {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.62rem;
		font-weight: 600;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}
</style>
