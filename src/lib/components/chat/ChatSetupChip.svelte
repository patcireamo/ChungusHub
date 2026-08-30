<script lang="ts">
	/**
	 * What this story is running on, and the one place to change it.
	 *
	 * A chat can claim its own persona, its own connection and its own character version.
	 * Claiming happens here, in the chat, because a chat can only claim things it can name;
	 * the Connections page and the Library keep speaking for the app.
	 *
	 * The panel is **two levels in one place**, and that is what makes it survive a library
	 * of forty personas and a fifth claimable thing landing next year. Level 1 is a summary
	 * with exactly one row per category, so its height is a function of how many categories
	 * exist and never of how many items any of them holds. Level 2 replaces the same panel's
	 * contents with one category's list, drilled in place rather than raised as a second
	 * floating layer, since a popover growing another popover has nowhere to go inside a
	 * composer. Everything a category needs to render at either level is declared once in
	 * `categories`: a new claimable thing is one entry there and nothing else.
	 *
	 * The chip stands whenever a chat is open rather than appearing on divergence: it is a
	 * readout of the story's setup first and a control second, and a control that shows up
	 * only once something is odd is a control nobody knows exists.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { connectionStore } from '$lib/stores/connections.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';
	import { chatConnectionId, chatPersonaClaim, chatPersonaEntry } from '$lib/utils/chat-setup';

	/** Past this a portrait+name list is mostly scrolling, so the persona list flips to a
	 *  three-across face grid: same rows of pixels, roughly twice the personas in them.
	 *  Personas are faces, and a name-only list throws away the one cue that makes a large
	 *  library scannable. */
	const PERSONA_GRID_THRESHOLD = 12;

	/** Below this a list is short enough to read whole, and a search field is a control that
	 *  costs more attention than the scrolling it saves. Same number and same reasoning as
	 *  the import plan's group filter. */
	const SEARCH_FROM = 8;

	type CategoryId = 'persona' | 'connection' | 'version';

	interface SetupOption {
		id: string;
		name: string;
		/** Portrait thumbnail and its framing. Personas only; nothing else has art. */
		thumb?: string | null;
		focus?: string;
	}

	interface SetupCategory {
		id: CategoryId;
		label: string;
		/** What the list holds, for the search placeholder. Always plural: the field only
		 *  appears once there are at least SEARCH_FROM of them. */
		noun: string;
		/** What is in force, printed on the level 1 row. */
		value: string;
		/** This story differs from what the app would hand it now. ONE rule for all three
		 *  rows, and the same one the Connections page's chip uses, so the pill answers
		 *  "has this story broken away" and never "was something written here once". The
		 *  wording differs by where the reader stands: active here, where the row IS the
		 *  chat's answer, and passive on a settings page, where it is the app's. */
		diverged: boolean;
		/** Said when the claim names something that no longer exists, or null. The story runs
		 *  on the app's value, and this is what stops the row pretending it was never
		 *  claimed. It belongs at level 2, where the reader is deciding about this category. */
		lost: string | null;
		options: SetupOption[];
		/** The option wearing the check. Null = following the app. */
		picked: string | null;
		/** What "Follow the app" would resolve to, or null where the category cannot follow
		 *  the app at all (a chat is pinned to a character version from birth; there is no
		 *  unpinned state to offer). */
		appValue: string | null;
		/** Render past the threshold as a grid of faces rather than as rows. */
		faces: boolean;
		pick: (id: string | null) => void;
	}

	let chat = $derived(chatStore.activeChat);

	// ===== You =====

	let personas = $derived(characterLibraryStore.personas);
	let claimedPersona = $derived(chatPersonaClaim(chat));
	let persona = $derived(chatPersonaEntry(chat));
	let appPersona = $derived(chatPersonaEntry(null));

	// ===== Connection =====

	let claimedConnection = $derived(chat ? chatStore.featureState(chat.id).connection : null);
	let liveConnection = $derived(chatConnectionId(chat));
	let appConnection = $derived(connectionStore.connectionFor('primary'));
	let connection = $derived(
		liveConnection ? connectionStore.get(liveConnection) ?? appConnection : appConnection
	);

	// ===== Character version =====

	let entry = $derived.by(() => {
		const cid = chat?.characterId;
		if (!cid) return null;
		return characterLibraryStore.entries.find((e) => e.id === cid && e.type === 'character') ?? null;
	});
	let versions = $derived(entry ? characterLibraryStore.versionsFor(entry.id) : []);
	// A null pin on a versioned character reads as the active variant, which is exactly
	// what generation does with it.
	let pinnedVersionId = $derived(chat?.characterVersionId ?? entry?.activeVersionId ?? null);
	// What a chat with this character is born on. The pill compares against this and not the
	// active version, so it answers "has this story broken away from what a new one would get"
	// rather than "is the library editing another variant right now".
	let versionSeed = $derived(entry ? characterLibraryStore.chatVersionSeed(entry.id) : null);

	// ===== The categories =====

	let categories = $derived.by<SetupCategory[]>(() => {
		const list: SetupCategory[] = [
			{
				id: 'persona',
				label: 'You',
				noun: 'personas',
				value: persona?.identity.name?.trim() || 'No persona',
				diverged: !!persona && persona.id !== appPersona?.id,
				lost:
					claimedPersona !== null && !personas.some((p) => p.id === claimedPersona)
						? "The persona this chat named is gone. It is playing as the app's."
						: null,
				options: personas.map((p) => ({
					id: p.id,
					name: p.identity.name?.trim() || 'Unnamed persona',
					thumb: imageService.thumbnailUrl(p.identity.imageUrl),
					focus: portraitFocusStyle(p.identity.portraitFocus)
				})),
				picked: personas.some((p) => p.id === claimedPersona) ? claimedPersona : null,
				appValue: appPersona?.identity.name?.trim() || 'No persona',
				faces: true,
				pick: pickPersona
			},
			{
				id: 'connection',
				label: 'Connection',
				noun: 'connections',
				value: connection?.name ?? 'No connection',
				diverged: liveConnection !== null && liveConnection !== connectionStore.assignmentFor('primary'),
				lost:
					claimedConnection !== null && liveConnection === null
						? "The connection this chat named is gone. It is sending on the app's."
						: null,
				options: connectionStore.list().map((c) => ({ id: c.id, name: c.name })),
				picked: liveConnection,
				appValue: appConnection?.name ?? 'No connection',
				faces: false,
				pick: pickConnection
			}
		];
		// Nothing to choose between on an unversioned character, so the row would be a drill
		// into a list of one. The old version chip hid itself the same way.
		if (versions.length > 0) {
			list.push({
				id: 'version',
				label: 'Version',
				noun: 'versions',
				value: versions.find((v) => v.id === pinnedVersionId)?.name ?? 'Unknown',
				diverged: !!chat?.characterVersionId && chat.characterVersionId !== versionSeed,
				lost: null,
				options: versions.map((v) => ({ id: v.id, name: v.name })),
				picked: pinnedVersionId,
				appValue: null,
				faces: false,
				pick: (id) => id && pickVersion(id)
			});
		}
		return list;
	});

	// ===== Panel state =====

	let open = $state(false);
	let drilled = $state<CategoryId | null>(null);
	let query = $state('');
	let menuRef = $state<HTMLDivElement | null>(null);
	let busy = $state(false);

	let active = $derived(categories.find((c) => c.id === drilled) ?? null);
	let shown = $derived.by(() => {
		if (!active) return [];
		const needle = query.trim().toLowerCase();
		if (!needle) return active.options;
		return active.options.filter((o) => o.name.toLowerCase().includes(needle));
	});
	let searchable = $derived((active?.options.length ?? 0) >= SEARCH_FROM);
	let asFaces = $derived(!!active?.faces && active.options.length > PERSONA_GRID_THRESHOLD);

	// The chip's own label names the two things a reader tracks turn to turn. It is
	// deliberately NOT derived from `categories`: a label that grew a segment per category
	// would push the composer's own controls off a narrow screen the moment one landed.
	let personaName = $derived(persona?.identity.name?.trim() || 'You');
	let modelName = $derived(connection?.model.split('/').pop() || 'No model');
	// The face, not a settings glyph: who the story is played by is what a reader tracks
	// turn to turn, and a portrait says it before the name beside it is read.
	let personaThumb = $derived(imageService.thumbnailUrl(persona?.identity.imageUrl));
	let personaFocus = $derived(portraitFocusStyle(persona?.identity.portraitFocus));

	function close() {
		open = false;
		drilled = null;
		query = '';
	}

	function drill(id: CategoryId) {
		drilled = id;
		query = '';
	}

	function goBack() {
		drilled = null;
		query = '';
	}

	$effect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (menuRef && !menuRef.contains(e.target as Node)) close();
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	});

	// Escape steps back out of a drilled category before it closes the panel, so leaving a
	// list the reader opened by mistake costs one press and does not throw away the panel
	// with it. Marked consumed either way, per the shell Esc contract
	// (architecture/ui-shell-settings.md).
	$effect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			if (drilled) goBack();
			else close();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	async function pickPersona(id: string | null) {
		if (!chat || busy) return;
		close();
		if (id === claimedPersona) return;
		busy = true;
		try {
			await chatStore.updateChatFeatureState(chat.id, { persona: id });
		} catch (error) {
			toastStore.failed('change who you play as in this chat', error);
		} finally {
			busy = false;
		}
	}

	async function pickConnection(id: string | null) {
		if (!chat || busy) return;
		close();
		if (id === claimedConnection) return;
		busy = true;
		try {
			await chatStore.updateChatFeatureState(chat.id, { connection: id });
		} catch (error) {
			toastStore.failed('change the connection this chat sends on', error);
		} finally {
			busy = false;
		}
	}

	async function pickVersion(versionId: string) {
		if (!chat || busy) return;
		close();
		if (versionId === chat.characterVersionId) return;
		busy = true;
		try {
			await chatStore.setChatCharacterVersion(chat.id, versionId);
		} catch (error) {
			toastStore.failed('switch this chat to that version', error);
		} finally {
			busy = false;
		}
	}
</script>

{#if chat}
	<!-- flex, not a bare block: a block wrapper around the button would reserve baseline
	     descender space under it and float the chip above the buttons it sits beside. -->
	<div class="relative flex" bind:this={menuRef}>
		<button
			type="button"
			class="setup-chip"
			class:is-open={open}
			onclick={() => (open ? close() : (open = true))}
			aria-haspopup="menu"
			aria-expanded={open}
			title={`Playing as ${personaName} on ${modelName}`}
		>
			<span class="setup-chip-face">
				{#if personaThumb}
					<img src={personaThumb} alt="" style={personaFocus} />
				{:else}
					<Icon name="user" class="w-3 h-3" />
				{/if}
			</span>
			<span class="setup-chip-label">{personaName} · {modelName}</span>
		</button>

		{#if open}
			<div role="menu" class="setup-panel absolute bottom-full left-0 mb-2 z-20 surface-float rounded-lg shadow-md">
				<!-- One header for both levels: the panel's title, or the category drilled into
				     and the way back out. -->
				<div class="setup-head" class:is-root={!active}>
					{#if active}
						<button type="button" class="setup-back" onclick={goBack} aria-label="Back">
							<Icon name="chevronLeft" class="w-3.5 h-3.5" />
						</button>
						<span class="setup-head-label">{active.label}</span>
					{:else}
						<span class="setup-head-label">Chat Overrides</span>
						<!-- The character step is invisible from here and cannot be inferred from the
						     rows, since a seeded claim looks exactly like one made by hand. -->
						<InfoTip
							text="This chat first, then the app. A character only decides how its new chats start."
						/>
					{/if}
				</div>

				{#if !active}
					<!-- Level 1: one row per category, whatever each of them holds. -->
					{#each categories as category (category.id)}
						<button
							type="button"
							role="menuitem"
							class="setup-summary"
							disabled={busy}
							onclick={() => drill(category.id)}
						>
							<span class="setup-summary-label">{category.label}</span>
							<span class="setup-summary-value">{category.value}</span>
							{#if category.diverged}
								<span class="scope-chip font-ui">Overrides the app</span>
							{/if}
							<Icon name="chevronRight" class="w-3.5 h-3.5 setup-summary-chevron" />
						</button>
					{/each}
				{:else}
					<!-- Level 2: the same panel, one category's list. -->
					{#if active.lost}
						<p class="setup-note">{active.lost}</p>
					{/if}

					{#if searchable}
						<div class="setup-search">
							<div class="brw-search">
								<Icon name="search" class="brw-search-icon w-3.5 h-3.5" />
								<input
									type="text"
									bind:value={query}
									placeholder="Search {active.options.length} {active.noun}…"
									aria-label="Search {active.noun}"
									class="input-base"
								/>
							</div>
						</div>
					{/if}

					<div class="setup-list" class:is-grid={asFaces}>
						<!-- The way back to the app, above the list rather than in it. It is not one
						     of the things being searched, so it stands down while a query is typed
						     rather than sitting unmatched inside a filtered list. -->
						{#if active.appValue !== null && !query.trim()}
							{@const following = active.picked === null}
							<button
								type="button"
								role="menuitem"
								class="setup-row is-follow"
								class:is-picked={following}
								disabled={busy}
								onclick={() => active?.pick(null)}
							>
								<span class="setup-check" class:is-visible={following}>
									<Icon name="check" class="w-3.5 h-3.5" />
								</span>
								<span class="setup-row-name">Follow the app ({active.appValue})</span>
							</button>
						{/if}

						{#if shown.length === 0}
							<p class="setup-note">Nothing matches that</p>
						{:else if asFaces}
							<div class="setup-grid">
								{#each shown as option (option.id)}
									{@const isPicked = option.id === active.picked}
									<button
										type="button"
										role="menuitem"
										class="setup-tile"
										class:is-picked={isPicked}
										title={option.name}
										disabled={busy}
										onclick={() => active?.pick(option.id)}
									>
										<span class="setup-tile-art">
											{#if option.thumb}
												<img src={option.thumb} alt="" loading="lazy" style={option.focus} />
											{:else}
												<Icon name="user" class="w-4 h-4" />
											{/if}
										</span>
										<span class="setup-tile-name">{option.name}</span>
									</button>
								{/each}
							</div>
						{:else}
							{#each shown as option (option.id)}
								{@const isPicked = option.id === active.picked}
								<button
									type="button"
									role="menuitem"
									class="setup-row"
									class:is-picked={isPicked}
									disabled={busy}
									onclick={() => active?.pick(option.id)}
								>
									<span class="setup-check" class:is-visible={isPicked}>
										<Icon name="check" class="w-3.5 h-3.5" />
									</span>
									{#if active.faces}
										<span class="setup-avatar">
											{#if option.thumb}
												<img src={option.thumb} alt="" loading="lazy" style={option.focus} />
											{:else}
												<Icon name="user" class="w-3 h-3" />
											{/if}
										</span>
									{/if}
									<span class="setup-row-name">{option.name}</span>
								</button>
							{/each}
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	/* Height, border tier and radius are the composer's icon buttons' (InputArea), including
	   their coarse-pointer size: this chip sits in that strip and any difference reads as a
	   misalignment rather than as a different kind of control. */
	.setup-chip {
		height: 1.9rem;
		max-width: 13rem;
		/* Tighter on the portrait's side: a circle carries its own edge, so equal padding
		   reads as a gap. */
		padding: 0 0.55rem 0 0.25rem;
		border: 1px solid var(--color-border-raised);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
		color: var(--color-text-muted);
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-family: var(--font-ui);
		font-size: 0.67rem;
		font-weight: 600;
		cursor: pointer;
		transition: color 140ms ease, border-color 140ms ease;
	}

	.setup-chip:hover,
	.setup-chip.is-open {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-accent) 34%, transparent);
	}

	.setup-chip-face {
		display: grid;
		place-items: center;
		width: 1.4rem;
		height: 1.4rem;
		flex-shrink: 0;
		border-radius: 999px;
		overflow: hidden;
		background: var(--color-bg-tertiary);
		color: var(--color-text-muted);
	}

	.setup-chip-face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	@media (pointer: coarse) {
		.setup-chip {
			height: 2.4rem;
		}

		.setup-chip-face {
			width: 1.8rem;
			height: 1.8rem;
		}
	}

	.setup-chip-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* One width for both levels: the panel's contents change, the panel does not, so a drill
	   never resizes the surface under the pointer. Wide enough for three faces per row,
	   which is what the grid needs to beat the list it replaces.
	   --brw-h is what the shared .brw-search recipe (app.css) sizes itself from; it is
	   declared on the browse container there, which this panel is not inside. */
	.setup-panel {
		width: 18.5rem;
		max-width: calc(100vw - 1rem);
		padding: 0.375rem 0;
		--brw-h: 1.9rem;
	}

	/* ===== The header, both levels ===== */

	.setup-head {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0 0.5rem 0.35rem;
		border-bottom: 1px solid var(--color-border-subtle);
		margin-bottom: 0.35rem;
	}

	/* With no back button in front of it the title would sit short of the rows below. */
	.setup-head.is-root {
		padding-left: 0.75rem;
	}

	.setup-head-label {
		font-family: var(--font-ui);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
	}

	.setup-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.4rem;
		height: 1.4rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.setup-back:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
		color: var(--color-text-primary);
	}

	/* ===== Level 1 ===== */

	.setup-summary {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.42rem 0.5rem 0.42rem 0.75rem;
		border: 0;
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.76rem;
		text-align: left;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.setup-summary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
		color: var(--color-text-primary);
	}

	.setup-summary-label {
		flex-shrink: 0;
		width: 5.25rem;
		color: var(--color-text-muted);
		font-size: 0.72rem;
	}

	/* The value takes whatever is left and truncates. The row never wraps: a two-line row
	   would make the summary's height depend on the names in it, which is the property the
	   whole panel is built to keep. */
	.setup-summary-value {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.setup-summary :global(.setup-summary-chevron) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	/* Same recipe the Interface page's governed cards and the Connections page wear. */
	.scope-chip {
		flex-shrink: 0;
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		font-size: 0.64rem;
		font-weight: 600;
		color: var(--color-accent);
		white-space: nowrap;
	}

	/* ===== Level 2 ===== */

	.setup-search {
		padding: 0 0.5rem 0.35rem;
	}

	.setup-note {
		padding: 0.15rem 0.75rem 0.35rem;
		font-family: var(--font-ui);
		font-size: 10px;
		line-height: 1.4;
		color: var(--color-text-muted);
	}

	/* The header and the search field sit outside this, so both stay put while the list
	   scrolls under them. */
	.setup-list {
		max-height: 15rem;
		overflow-y: auto;
	}

	.setup-list.is-grid {
		max-height: 18rem;
	}

	.setup-row {
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

	.setup-row:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
		color: var(--color-text-primary);
	}

	.setup-row.is-picked {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	/* Pinned above the list it belongs to, so scrolling forty personas never scrolls the way
	   back to the app off the top. */
	.setup-row.is-follow {
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--color-bg-elevated);
	}

	.setup-check {
		width: 0.9rem;
		flex-shrink: 0;
		display: inline-flex;
		color: var(--color-accent);
		visibility: hidden;
	}

	.setup-check.is-visible {
		visibility: visible;
	}

	.setup-avatar {
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

	.setup-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.setup-row-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The grid needs room for three faces per row; below that it reads as a worse list.
	   auto-fill keeps it honest if the panel is ever clamped narrower. */
	.setup-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(4.6rem, 1fr));
		gap: 0.25rem;
		padding: 0.15rem 0.5rem;
	}

	.setup-tile {
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

	.setup-tile:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-bg-tertiary) 85%, transparent);
		color: var(--color-text-primary);
	}

	.setup-tile.is-picked {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.setup-tile-art {
		display: grid;
		place-items: center;
		width: 2.6rem;
		height: 2.6rem;
		border-radius: 999px;
		overflow: hidden;
		background: var(--color-bg-tertiary);
		color: var(--color-text-muted);
	}

	.setup-tile-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* The picked mark is a ring on the portrait, not a check badge: a badge would be clipped
	   by the circle's own overflow, and the ring survives a dark thumbnail. */
	.setup-tile.is-picked .setup-tile-art {
		box-shadow: 0 0 0 2px var(--color-accent);
	}

	.setup-tile-name {
		width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: center;
	}
</style>
