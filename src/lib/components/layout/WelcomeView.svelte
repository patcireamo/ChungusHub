<script lang="ts">
	import BrandGlyph from '$lib/components/ui/BrandGlyph.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { MOD_KEY } from '$lib/components/ui/ShortcutsSheet.svelte';
	import { LINKS } from '$lib/config/links';
	import ChatAvatars from '$lib/components/sidebar/ChatAvatars.svelte';
	import { formatRelativeTime } from '$lib/utils/date';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { chatCastStore } from '$lib/stores/chatCast.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';

	let chats = $derived(chatStore.sortedChats);
	// Only chats that have actually been written in are worth resuming: a fresh
	// blank chat (rootMessageId === null) isn't. Newest first, three until expanded.
	let resumable = $derived(chats.filter((c) => c.rootMessageId !== null));
	let expanded = $state(false);
	let visibleCount = $state(3);
	let recent = $derived(resumable.slice(0, expanded ? visibleCount : 3));

	// Free room under the content, measured off the flexible spacer while collapsed.
	// Expanding fills that room instead of scrolling; ROW_PX ≈ card height + list gap,
	// and RESERVE_PX keeps air above the community links instead of crowding them.
	let spareHeight = $state(0);
	const ROW_PX = 75;
	const RESERVE_PX = 96;

	function toggleExpand() {
		if (expanded) {
			expanded = false;
			return;
		}
		// Always reveal at least two more so the button never no-ops when cramped.
		visibleCount = 3 + Math.max(2, Math.floor((spareHeight - RESERVE_PX) / ROW_PX));
		expanded = true;
	}

	// Opening a chat is what retires the landing, and chatStore handles the dismissal.
	function continueStory(chatId: string) {
		chatStore.selectChat(chatId);
	}

	// The two-step New chat flow: the Library opens on Characters, then Personas,
	// then a fresh chat is created for the picked pair (uiStore.startNewChat).
	function newChat() {
		uiStore.startNewChat(() => lorebookStore.flush());
	}

	// Same flush the Workspace shortcuts pass: a docked panel over the welcome may
	// hold unsaved lorebook edits.
	function openChats() {
		uiStore.toggleOverlay('chats', () => lorebookStore.flush());
	}

	// Stats belong to the library rather than to any one chat, so this landing and the
	// composer's menu are its doors: the TitleBar cluster is the open chat's own tools.
	function openStats() {
		uiStore.toggleOverlay('stats', () => lorebookStore.flush());
	}

	// A toggle, not an open: the docked Library leaves this landing visible and
	// clickable, so a second press on the button has to put it away again. The tab is
	// only forced on the way in: closing must not rewrite which half reopens.
	function toggleLibrary() {
		if (uiStore.libraryOpen) {
			uiStore.closeLibrary();
			return;
		}
		uiStore.setLibraryTab('characters', () => lorebookStore.flush());
		uiStore.openLibrary(() => lorebookStore.flush());
	}

	const modKey = MOD_KEY;

	// Community links. They leave the app, so they open in a new tab: the workspace
	// is a running session with unsaved composer drafts, and navigating it away to
	// read a repo page is never what the click meant.
	const socials = [
		{ key: 'github', label: 'GitHub', href: LINKS.repo },
		{ key: 'discord', label: 'Discord', href: LINKS.discord }
	] as const;
</script>

<div class="welcome panel-scroll">
	<div class="welcome-inner">
		<div class="welcome-top">
			<header class="hero">
				<div class="logo-shell" aria-hidden="true">
					<div class="logo-halo"></div>
					<img class="logo-mark" src="/mark.svg" alt="" />
				</div>

				<p class="eyebrow">
					<span class="eyebrow-rule" aria-hidden="true"></span>
					<span>Story Workspace</span>
					<span class="eyebrow-rule" aria-hidden="true"></span>
				</p>
				<h1 class="brand">ChungusHub</h1>
			</header>

			<div class="actions">
				<button type="button" class="action action-primary" onclick={newChat}>
					<Icon name="plus" class="w-4 h-4" />
					<span>New chat</span>
					<kbd class="action-kbd action-kbd-primary">{modKey} N</kbd>
				</button>
				<button type="button" class="action action-ghost" onclick={openChats}>
					<Icon name="chat" class="w-4 h-4" />
					<span>Chats</span>
					<kbd class="action-kbd">{modKey} K</kbd>
				</button>
				<button type="button" class="action action-ghost" onclick={toggleLibrary}>
					<Icon name="bookOpen" class="w-4 h-4" />
					<span>Library</span>
					<kbd class="action-kbd">{modKey} L</kbd>
				</button>
				<button type="button" class="action action-ghost" onclick={openStats}>
					<Icon name="chart" class="w-4 h-4" />
					<span>Your stats</span>
				</button>
			</div>

			{#if recent.length}
				<section class="recent" aria-label="Recent chats">
					<div class="section-head">
						<h2 class="section-title">Continue</h2>
						<span class="section-rule" aria-hidden="true"></span>
						<button type="button" class="section-link" onclick={openChats}>
							All chats
						</button>
					</div>

					<div class="recent-list">
						{#each recent as chat (chat.id)}
							{@const cast = chatCastStore.charactersForChat(chat.id)}
							{@const persona = chatCastStore.personaForChat(chat.id)}
							<button type="button" class="recent-card" onclick={() => continueStory(chat.id)}>
								<div class="recent-faces">
									{#if cast.length}
										<ChatAvatars members={cast} size={40} max={3} />
									{:else}
										<div class="recent-icon"><Icon name="chat" class="w-5 h-5" /></div>
									{/if}
								</div>
								<div class="recent-text">
									<span class="recent-title">{chat.title}</span>
									<span class="recent-meta">
										{formatRelativeTime(chat.updatedAt)}{#if persona}<span class="recent-meta-sep" aria-hidden="true">·</span>as {persona.name}{/if}
									</span>
								</div>
								<Icon name="arrowRight" class="w-4 h-4 recent-arrow" />
							</button>
						{/each}
					</div>

					{#if resumable.length > 3}
						<button type="button" class="recent-expand" onclick={toggleExpand}>
							<Icon name={expanded ? 'chevronUp' : 'chevronDown'} class="w-3.5 h-3.5" />
							<span>{expanded ? 'Show less' : 'Show more'}</span>
						</button>
					{/if}
				</section>
			{:else}
				<section class="empty" aria-label="No chats yet">
					<p class="empty-text">No chats yet</p>
				</section>
			{/if}
		</div>

		<!-- Flexible spacer: keeps the community links pinned to the bottom and doubles
		     as the measure of how much room an expanded recent list may fill. -->
		<div class="welcome-grow" bind:clientHeight={spareHeight} aria-hidden="true"></div>

		<nav class="socials" aria-label="Community">
			{#each socials as s (s.key)}
				<a
					class="social-link"
					href={s.href}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={s.label}
				>
					<BrandGlyph name={s.key} class="social-glyph" />
					<span>{s.label}</span>
				</a>
			{/each}
		</nav>
	</div>
</div>

<style>
	.welcome {
		height: 100%;
		min-height: 0;
		background: transparent;
	}

	/* Fills the column so the hero block can center itself vertically (auto margins)
	   and the community links sit pinned at the bottom. */
	.welcome-inner {
		min-height: 100%;
		max-width: 44rem;
		margin: 0 auto;
		padding: clamp(2rem, 1.4rem + 2.6vw, 3.4rem) clamp(1.1rem, 0.8rem + 1.6vw, 2.4rem)
			clamp(1.4rem, 1.1rem + 1vw, 2rem);
		display: flex;
		flex-direction: column;
	}

	.welcome-top {
		display: flex;
		flex-direction: column;
		gap: clamp(1.7rem, 1.3rem + 1.4vw, 2.5rem);
	}

	/* Eats the leftover height: pushes the community links to the bottom, and its
	   measured size is the room the expanded recent list may fill. */
	.welcome-grow {
		flex: 1 1 0;
		min-height: 0;
	}

	/* Staggered entrance: one orchestrated rise on load. */
	.hero,
	.actions,
	.recent,
	.empty,
	.socials {
		animation: welcome-rise 460ms cubic-bezier(0.22, 1, 0.36, 1) both;
	}

	.actions {
		animation-delay: 70ms;
	}

	.recent,
	.empty {
		animation-delay: 140ms;
	}

	.socials {
		animation-delay: 220ms;
	}

	@keyframes welcome-rise {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	/* ===== Hero ===== */
	.hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.45rem;
	}

	.logo-shell {
		position: relative;
		width: clamp(4.4rem, 3.9rem + 2vw, 5.8rem);
		height: clamp(4.4rem, 3.9rem + 2vw, 5.8rem);
		display: grid;
		place-items: center;
		margin-bottom: 0.65rem;
	}

	/* A soft blurred glow rather than a hard-edged disc. */
	.logo-halo {
		position: absolute;
		inset: -16%;
		border-radius: var(--radius-full);
		background: radial-gradient(
			circle at 50% 42%,
			color-mix(in srgb, var(--color-accent) 58%, transparent),
			transparent 72%
		);
		filter: blur(16px);
		opacity: 0.5;
	}

	.logo-mark {
		position: relative;
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: drop-shadow(0 6px 16px color-mix(in srgb, var(--color-accent) 30%, transparent));
	}

	/* Frontispiece eyebrow: the label sits between two fading hairlines. */
	.eyebrow {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.8rem;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.2em;
		color: var(--color-text-muted);
	}

	.eyebrow-rule {
		width: 2.6rem;
		height: 1px;
		background: linear-gradient(
			to right,
			transparent,
			color-mix(in srgb, var(--color-text-muted) 55%, transparent)
		);
	}

	.eyebrow-rule:last-child {
		transform: scaleX(-1);
	}

	.brand {
		/* The bottom margin stands in for the removed tagline, keeping the original
		   distance between the brand and the actions row. */
		margin: 0 0 2.5rem;
		font-family: var(--font-ui);
		font-size: clamp(2rem, 1.6rem + 1.8vw, 2.9rem);
		font-weight: 740;
		line-height: 1.04;
		letter-spacing: 0.01em;
		color: var(--color-text-primary);
	}

	/* ===== Quick actions ===== */
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.55rem;
	}

	.action {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		height: 2.4rem;
		padding: 0 1rem;
		border-radius: var(--radius-full);
		font-family: var(--font-ui);
		font-size: 0.84rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		transition: filter 140ms ease, background-color 140ms ease, border-color 140ms ease,
			color 140ms ease, box-shadow 140ms ease;
	}

	.action-primary {
		background: var(--color-accent);
		color: var(--color-on-accent);
		box-shadow: 0 4px 18px color-mix(in srgb, var(--color-accent) 24%, transparent);
	}

	.action-primary:hover {
		filter: brightness(1.08);
	}

	.action-ghost {
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
		color: var(--color-text-secondary);
	}

	.action-ghost:hover {
		color: var(--color-text-primary);
		border-color: var(--color-border);
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
	}

	.action-kbd {
		font-family: var(--font-ui);
		font-size: 0.62rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		line-height: 1;
		padding: 0.22rem 0.38rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-primary) 55%, transparent);
		border: 1px solid var(--color-border-subtle);
		color: var(--color-text-muted);
	}

	.action-kbd-primary {
		background: color-mix(in srgb, var(--color-on-accent) 14%, transparent);
		border-color: color-mix(in srgb, var(--color-on-accent) 26%, transparent);
		color: var(--color-on-accent);
		opacity: 0.85;
	}

	/* Shortcut chips only make sense with a keyboard and enough width. */
	@media (max-width: 639px), (hover: none) and (pointer: coarse) {
		.action-kbd {
			display: none;
		}
	}

	/* ===== Recent stories ===== */
	.section-head {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		margin-bottom: 0.75rem;
	}

	.section-title {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: var(--color-text-muted);
	}

	.section-rule {
		flex: 1;
		height: 1px;
		background: var(--color-border-subtle);
	}

	.section-link {
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-muted);
		padding: 0.2rem 0.35rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		transition: color 140ms ease;
	}

	.section-link:hover {
		color: var(--color-accent);
	}

	.recent-list {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.recent-card {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		width: 100%;
		text-align: left;
		padding: 0.75rem 1rem;
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-card-bg) 72%, transparent);
		cursor: pointer;
		transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
	}

	.recent-card:hover {
		background: var(--color-card-bg);
		border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
		box-shadow: var(--shadow-sm);
	}

	.recent-faces {
		flex-shrink: 0;
	}

	.recent-icon {
		width: 40px;
		height: 40px;
		border-radius: var(--radius-full);
		display: grid;
		place-items: center;
		color: var(--color-text-muted);
		background: color-mix(in srgb, var(--color-bg-tertiary) 88%, transparent);
	}

	.recent-text {
		display: flex;
		flex-direction: column;
		gap: 0.16rem;
		min-width: 0;
		flex: 1;
	}

	.recent-title {
		font-family: var(--font-ui);
		font-size: 0.92rem;
		font-weight: 620;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.recent-meta {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.recent-meta-sep {
		opacity: 0.6;
	}

	:global(.recent-arrow) {
		flex-shrink: 0;
		color: var(--color-text-muted);
		opacity: 0.55;
		transition: transform 150ms ease, color 150ms ease, opacity 150ms ease;
	}

	.recent-card:hover :global(.recent-arrow) {
		color: var(--color-accent);
		opacity: 1;
		transform: translateX(3px);
	}

	/* Reads as the ghost quick actions above: a resting pill, not a hover-only one. */
	.recent-expand {
		display: flex;
		width: fit-content;
		align-items: center;
		gap: 0.35rem;
		margin: 0.7rem auto 0;
		padding: 0.3rem 0.8rem;
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
	}

	.recent-expand:hover {
		color: var(--color-text-primary);
		border-color: var(--color-border);
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
	}

	/* ===== Empty state (no resumable chats yet) ===== */
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		/* Enough air that the line reads as its own zone rather than a caption
		   hanging off the action buttons above it. */
		padding-top: 3.9rem;
		text-align: center;
	}

	.empty-text {
		margin: 0;
		max-width: 26rem;
		font-family: var(--font-body);
		font-style: italic;
		font-size: 0.98rem;
		color: var(--color-text-muted);
	}

	/* ===== Community links (pinned bottom) ===== */
	.socials {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.35rem;
		padding-top: clamp(2rem, 1.6rem + 1.4vw, 3rem);
	}

	.social-link {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.42rem 0.75rem;
		border-radius: var(--radius-full);
		color: var(--color-text-muted);
		text-decoration: none;
		font-family: var(--font-ui);
		font-size: 0.76rem;
		font-weight: 600;
		transition: background-color 140ms ease, color 140ms ease;
	}

	/* The mark is drawn by ui/BrandGlyph, so the selector has to leave the scoping alone:
	   a plain descendant rule would be pruned as unused, this component's markup holding
	   no <svg> of its own. */
	.social-link :global(.social-glyph) {
		width: 0.95rem;
		height: 0.95rem;
	}

	.social-link:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
	}

	/* ===== Narrow screens ===== */
	@media (max-width: 560px) {
		.actions {
			flex-direction: column;
			align-items: stretch;
		}

		.action {
			justify-content: center;
			height: 2.6rem;
		}

		.recent-card {
			padding: 0.7rem 0.85rem;
			gap: 0.75rem;
		}
	}
</style>
