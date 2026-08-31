<script lang="ts">
	/**
	 * What this story is running on, and the one place to change it.
	 *
	 * A chat can claim its own persona, its own preset, its own connection and its own
	 * character version, and it can attach lorebooks of its own on top of the ones its cards
	 * already bring, or leave out one the wider setup brings it.
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
	import OverrideMark from '$lib/components/ui/OverrideMark.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { connectionStore } from '$lib/stores/connections.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { imageService } from '$lib/services/imageService';
	import { presetService } from '$lib/services/presets.svelte';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';
	import { foldForSearch } from '$lib/components/library/browse';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { sortLorebooks } from '$lib/lorebook/types';
	import { lorebookViewPrefs } from '$lib/stores/lorebookViewPrefs.svelte';
	import {
		chatConnectionClaim,
		chatConnectionId,
		chatLorebookClaim,
		chatMutedLorebookClaim,
		chatPersonaClaim,
		chatPersonaEntry,
		chatPreset,
		chatPresetClaim,
		chatPresetId
	} from '$lib/utils/chat-setup';

	/** Past this a portrait+name list is mostly scrolling, so the persona list flips to a
	 *  three-across face grid: same rows of pixels, roughly twice the personas in them.
	 *  Personas are faces, and a name-only list throws away the one cue that makes a large
	 *  library scannable. */
	const PERSONA_GRID_THRESHOLD = 12;

	/** Below this a list is short enough to read whole, and a search field is a control that
	 *  costs more attention than the scrolling it saves. Same number and same reasoning as
	 *  the import plan's group filter. */
	const SEARCH_FROM = 8;

	type CategoryId = 'persona' | 'preset' | 'connection' | 'version' | 'lorebook';

	interface SetupOption {
		id: string;
		name: string;
		/** Portrait thumbnail and its framing. Personas only; nothing else has art. */
		thumb?: string | null;
		focus?: string;
		/** Something OTHER than this chat already brings it, named: the row wears the word and
		 *  draws its check from it, and a press mutes it rather than doing nothing, since a
		 *  reader pointing at a row is asking about THIS story. Multi-select categories only;
		 *  nothing else has a second source. */
		held?: string;
		/** This chat took it back out. The row states that instead of who brings it: what
		 *  matters about a muted book is that it is not in this story. */
		muted?: boolean;
	}

	interface SetupCategory {
		id: CategoryId;
		label: string;
		/** What the list holds, for the search placeholder. Always plural: the field only
		 *  appears once there are at least SEARCH_FROM of them. */
		noun: string;
		/** What is in force, printed on the level 1 row. */
		value: string;
		/** This story differs from what the app would hand it now. ONE rule for every row, and
		 *  the same one the app-side notices read, so the star answers "has this story broken
		 *  away" and never "was something written here once". */
		diverged: boolean;
		/** Said when the claim names something that no longer exists, or null. The story runs
		 *  on the app's value, and this is what stops the row pretending it was never
		 *  claimed. It belongs at level 2, where the reader is deciding about this category. */
		lost: string | null;
		options: SetupOption[];
		/** What this chat claimed, so the rows can wear their checks. Empty = following the
		 *  app, or, where the category adds rather than replaces, adding nothing. */
		picked: Set<string>;
		/** Several may be claimed at once, so a press toggles one row and leaves the list open.
		 *  Such a category adds to what the app already gives this chat instead of standing in
		 *  for it, which is why it has no app row to fall back to. */
		multi: boolean;
		/** The app's own answer as its row states it, or null where the category cannot follow
		 *  the app at all (a chat is pinned to a character version from birth; there is no
		 *  unpinned state to offer).
		 *
		 *  `label` is the word for "nothing set here", and it is the SAME word the character
		 *  editor's New Chat Defaults row uses, because the two lists offer the same choice
		 *  over the same library and a reader meeting two names for it has to work out whether
		 *  they mean one thing. **Default** where nothing in the list can wear that name, and
		 *  **Global** for connections and presets, where something can and an option naming one
		 *  of the rows under it is a trap. `detail` is what that word resolves to right now,
		 *  which no row from the library can say. */
		app: { label: string; detail: string } | null;
		/** Render past the threshold as a grid of faces rather than as rows. */
		faces: boolean;
		pick: (id: string | null) => void;
	}

	let chat = $derived(chatStore.activeChat);

	// ===== Persona =====

	let personas = $derived(characterLibraryStore.personas);
	let claimedPersona = $derived(chatPersonaClaim(chat));
	let persona = $derived(chatPersonaEntry(chat));
	let appPersona = $derived(chatPersonaEntry(null));

	// ===== Preset =====

	let claimedPreset = $derived(chatPresetClaim(chat));
	let livePreset = $derived(chatPresetId(chat));
	let preset = $derived(chatPreset(chat));
	let appPreset = $derived(presetService.getActiveEffectivePreset());

	// ===== Connection =====

	let claimedConnection = $derived(chatConnectionClaim(chat));
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
	/** The pin names a version that is gone. Said once: the Version row reports it, and
	 *  nothing else in this panel may read the card THROUGH a pin like that. */
	let versionLost = $derived(
		!!chat?.characterVersionId && !versions.some((v) => v.id === chat.characterVersionId)
	);
	// A null pin on a versioned character reads as the active variant, which is exactly
	// what generation does with it.
	let pinnedVersionId = $derived(chat?.characterVersionId ?? entry?.activeVersionId ?? null);
	// What a chat with this character is born on. The pill compares against this and not the
	// active version, so it answers "has this story broken away from what a new one would get"
	// rather than "is the library editing another variant right now".
	let versionSeed = $derived(entry ? characterLibraryStore.chatVersionSeed(entry.id) : null);

	// ===== Lorebooks =====

	let books = $derived(lorebookStore.books);
	let claimedBooks = $derived(chatLorebookClaim(chat));
	let claimedBookIds = $derived(new Set(claimedBooks));
	let mutedBooks = $derived(chatMutedLorebookClaim(chat));
	let mutedBookIds = $derived(new Set(mutedBooks));
	/** The card sheet this chat PLAYS, which carries its linked books as well as its traits
	 *  (architecture/prompt-pipeline.md 3b), or null while the pin names nothing: that read
	 *  throws by design, and this panel is where a lost pin is repinned. */
	let playedCard = $derived(
		entry && !versionLost
			? characterLibraryStore.dataForVersion(entry, chat?.characterVersionId ?? null)
			: null
	);
	let characterBookIds = $derived(new Set(playedCard?.lorebookIds ?? []));
	let personaBookIds = $derived(new Set(persona?.data.lorebookIds ?? []));
	/** Everything this story actually plays with, through the one resolver the send runs, so
	 *  the row states the same set the prompt carries. */
	let booksInPlay = $derived(
		lorebookStore.booksForChat({
			cards: [...characterBookIds, ...personaBookIds],
			chat: claimedBooks,
			muted: mutedBooks
		})
	);

	/** Who brings a book if this chat had not, in the words of the door that would take it
	 *  back off again. Undefined where only this chat carries it. */
	function heldBy(book: { id: string; global?: boolean }): string | undefined {
		if (book.global) return 'Every chat';
		if (characterBookIds.has(book.id)) return 'Character';
		if (personaBookIds.has(book.id)) return 'Persona';
		return undefined;
	}

	// ===== The categories =====

	/** A single-claim category's picked set: the one thing it claimed, or nothing. */
	function only(id: string | null): Set<string> {
		return new Set(id ? [id] : []);
	}

	let categories = $derived.by<SetupCategory[]>(() => {
		const list: SetupCategory[] = [
			{
				id: 'persona',
				// The word the New Chat Defaults row uses for the same choice over the same
				// library, so the two lists cannot read as two different things.
				label: 'Persona',
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
				picked: only(personas.some((p) => p.id === claimedPersona) ? claimedPersona : null),
				multi: false,
				app: { label: 'Default', detail: appPersona?.identity.name?.trim() || 'No persona' },
				faces: true,
				pick: pickPersona
			},
			{
				id: 'preset',
				label: 'Preset',
				noun: 'presets',
				// The effective name, so a renamed draft reads here as it does in Preset Controls.
				value: preset?.name ?? 'No preset',
				diverged: livePreset !== null && livePreset !== presetService.getActivePresetId(),
				lost:
					claimedPreset !== null && livePreset === null
						? "The preset this chat named is gone. It is running the app's."
						: null,
				options: presetService.getAllPresets().map((p) => ({ id: p.id, name: p.name })),
				picked: only(livePreset),
				multi: false,
				app: { label: 'Global', detail: appPreset?.name ?? 'No preset' },
				faces: false,
				pick: pickPreset
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
				picked: only(liveConnection),
				multi: false,
				app: { label: 'Global', detail: appConnection?.name ?? 'No connection' },
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
				// The one claim with no app value to fall back on, so this row says what the
				// others cannot: the story stops sending until it is repinned, which is the
				// throw the next send raises (utils/prompt-builder.ts) said before it happens.
				lost: versionLost
					? 'The version this chat was pinned to is gone. It cannot send until you pick another.'
					: null,
				options: versions.map((v) => ({ id: v.id, name: v.name })),
				picked: only(pinnedVersionId),
				multi: false,
				app: null,
				faces: false,
				pick: (id) => id && pickVersion(id)
			});
		}
		// Last, and apart from the four above it: this is the one row that CHANGES what the app
		// hands this story rather than standing in for it, adding books of its own and leaving
		// out ones the wider setup brings, so it trails the claims that answer "instead of the
		// app's". Hidden on an empty shelf, the rule the Version row follows too: a drill into
		// a list of nothing.
		if (books.length > 0) {
			list.push({
				id: 'lorebook',
				label: 'Lorebooks',
				noun: 'lorebooks',
				// What the story really plays with, cards and globals included and mutes taken
				// out, since that is what "in force" means on every other row here. One book is
				// named; several are counted, because a row that listed them would wrap.
				value:
					booksInPlay.length === 0
						? 'No lorebooks'
						: booksInPlay.length === 1
							? booksInPlay[0].name.trim() || 'Untitled lorebook'
							: `${booksInPlay.length} books`,
				// Only what THIS chat decided, in either direction: the star says the story broke
				// away, and a book its character carries is what every chat with that character
				// gets. A mute counts, since leaving a book out is as much a break as adding one.
				diverged:
					lorebookStore.resolveLinks(claimedBooks).length > 0 ||
					lorebookStore.resolveLinks(mutedBooks).length > 0,
				// A dangling id is inert here and swept by nobody, exactly as it is on a card
				// (architecture/lorebook.md), so there is no lost claim to report.
				lost: null,
				options: sortLorebooks(books, lorebookViewPrefs.order).map((book) => ({
					id: book.id,
					name: book.name.trim() || 'Untitled lorebook',
					held: heldBy(book),
					muted: mutedBookIds.has(book.id)
				})),
				picked: claimedBookIds,
				multi: true,
				app: null,
				faces: false,
				pick: (id) => id && pressLorebook(id)
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
		// The library's own casing rule, not a bare lowercase: the dotted/dotless I family folds
		// together, so a name found in one list here cannot be missed in the next.
		const needle = foldForSearch(query.trim());
		if (!needle) return active.options;
		return active.options.filter((o) => foldForSearch(o.name).includes(needle));
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

	async function pickPreset(id: string | null) {
		if (!chat || busy) return;
		close();
		if (id === claimedPreset) return;
		busy = true;
		try {
			await chatStore.updateChatFeatureState(chat.id, { preset: id });
		} catch (error) {
			toastStore.failed('change the preset this chat is built from', error);
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

	/**
	 * The one press that neither closes the panel nor takes the list out of the reader's hands:
	 * setting a story's lore up is a run of presses, and both a close and a busy flag would cost
	 * the second one. Every write is computed inside the store's own queue, so two presses
	 * landing in a single round trip cannot drop each other.
	 *
	 * One row, three answers, and which one it is follows from what the row already says: a book
	 * this chat added comes back off, a muted one comes back in, and one the wider setup brings
	 * is muted for this story alone. Muting a book the chat itself attached would be a second
	 * way to write the same absence, so that row detaches instead.
	 */
	async function pressLorebook(bookId: string) {
		if (!chat) return;
		const book = books.find((b) => b.id === bookId);
		const heldElsewhere = !!book && !!heldBy(book) && !claimedBookIds.has(bookId);
		try {
			if (mutedBookIds.has(bookId) || heldElsewhere) {
				await chatStore.toggleChatLorebookMute(chat.id, bookId);
			} else {
				await chatStore.toggleChatLorebook(chat.id, bookId);
			}
		} catch (error) {
			toastStore.failed('change the lorebooks this chat carries', error);
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
						<!-- Setup, never "Overrides": most rows on most chats are following the app,
						     and a title naming them an override describes the state the panel is
						     usually not in. -->
						<span class="setup-head-label">Chat Setup</span>
						<InfoTip text="Anything set here applies to this chat only. The rest follows the app." />
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
							<!-- The app's one mark for "this has left what it would inherit", the same
							     star the lorebook and steering wear. A mark rather than the revert
							     button those get: the row IS a button, and the way back is already the
							     first item in the list it opens. -->
							<OverrideMark
								overridden={category.diverged}
								label="Set for this chat, so the app's has no say here"
							/>
							<Icon name="chevronRight" class="w-3.5 h-3.5 setup-summary-chevron" />
						</button>
					{/each}
				{:else}
					<!-- Level 2: the same panel, one category's list. -->
					{#if active.lost}
						<p class="setup-note is-lost">{active.lost}</p>
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

					<!-- The app's answer and the heading over the library both sit OUTSIDE the
					     scrolling list, the same build as the New Chat Defaults picker: the two offer
					     the same choice over the same library, so scrolling forty personas must not
					     scroll either of them away in one place and not the other. The app row is
					     not one of the things being searched, so it stands down while a query is
					     typed rather than sitting unmatched inside a filtered list. -->
					{#if active.app && !query.trim()}
						{@const following = active.picked.size === 0}
						<button
							type="button"
							role="menuitem"
							class="setup-row setup-app-row"
							class:is-picked={following}
							disabled={busy}
							onclick={() => active?.pick(null)}
						>
							<span class="setup-check" class:is-visible={following}>
								<Icon name="check" class="w-3.5 h-3.5" />
							</span>
							<span class="setup-app-main">
								<span class="setup-app-name">{active.app.label}</span>
								<span class="setup-app-detail">{active.app.detail}</span>
							</span>
						</button>
					{/if}

					<p class="setup-group">{active.noun}</p>

					<div class="setup-list" class:is-grid={asFaces}>
						{#if shown.length === 0}
							<p class="setup-note">Nothing matches that</p>
						{:else if asFaces}
							<div class="setup-grid">
								{#each shown as option (option.id)}
									{@const isPicked = active.picked.has(option.id)}
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
								{@const isPicked = active.picked.has(option.id)}
								<!-- The check is what is in force, a different question from what this chat
								     claimed: a row something else brings is in the story too, and a
								     muted one is out of it however it got there. -->
								{@const inPlay = (isPicked || !!option.held) && !option.muted}
								<!-- A row that toggles announces itself as one: its check is a state the press
								     changes, not a pick that answers the panel and dismisses it. -->
								<button
									type="button"
									role={active.multi ? 'menuitemcheckbox' : 'menuitem'}
									aria-checked={active.multi ? inPlay : undefined}
									class="setup-row"
									class:is-picked={isPicked && !option.muted}
									class:is-held={!!option.held && !isPicked && !option.muted}
									class:is-muted={option.muted}
									disabled={busy}
									onclick={() => active?.pick(option.id)}
								>
									<span class="setup-check" class:is-visible={inPlay}>
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
									<!-- One word, and while it is muted that word is the state rather than
									     whoever brings it: the struck name already says the rest, and two
									     words here would squeeze the name they are about. -->
									{#if option.muted}
										<span class="setup-held">Muted</span>
									{:else if option.held}
										<span class="setup-held">{option.held}</span>
									{/if}
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

	/* A claim naming something deleted, in the colour the New Chat Defaults row says the same
	   thing in: one state, one reading, wherever the reader meets it. */
	.setup-note.is-lost {
		color: var(--color-warning);
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

	/* Above the rule and away from the group under it: the separation is what says this row is
	   not one of them. Same recipe as the New Chat Defaults picker's own app row. */
	.setup-app-row {
		align-items: flex-start;
		padding-bottom: 0.45rem;
		margin-bottom: 0.25rem;
		border-bottom: 1px solid color-mix(in srgb, var(--color-border-subtle) 60%, transparent);
	}

	.setup-app-main {
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		min-width: 0;
	}

	.setup-app-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* What the app is answering with right now. A row from the library can never carry this,
	   which is the whole point of drawing it. */
	.setup-app-detail {
		font-size: 0.68rem;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Left edge shared with the rows it labels and with the search field above them, which is
	   0.5rem here rather than the panel's own 0.75rem gutter. */
	.setup-group {
		padding: 0.15rem 0.5rem 0.2rem;
		font-family: var(--font-ui);
		font-size: 0.64rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
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

	/* A row held by something other than this chat: checked, because it really is in the
	   story, and quiet, because this story is not what put it there. */
	.setup-row.is-held {
		color: var(--color-text-muted);
	}

	.setup-row.is-held .setup-check {
		color: var(--color-text-muted);
	}

	/* Taken out of this story. The strike is the state: an unchecked row says only that this
	   chat did not add the book, while a struck one says the chat decided against it. */
	.setup-row.is-muted .setup-row-name {
		text-decoration: line-through;
		text-decoration-thickness: 1px;
		color: var(--color-text-muted);
	}

	/* Who holds it, in the word for the door that would take it back off, or the word for
	   what this chat did to it. */
	.setup-held {
		flex-shrink: 0;
		font-size: 0.64rem;
		color: var(--color-text-muted);
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
