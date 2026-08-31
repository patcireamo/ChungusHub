<script lang="ts">
	/**
	 * The body of the open book's "Bind to…" popover, and the mirror image of
	 * LorebookLinkPicker: that one asks one character which books it carries, this one asks
	 * one book what carries IT, over the three things that can. A character or a persona
	 * links it (`data.lorebookIds`), and a chat attaches it for itself
	 * (`ChatFeatureState.lorebooks`, architecture/lorebook.md).
	 *
	 * **It writes through the doors those surfaces already use** and never near the rows
	 * itself: `characterLibraryStore.updateData` for a card's link list, and
	 * `chatStore.toggleChatLorebook` for a chat's claim. So a binding made from the book is
	 * the same row, the same sync scope and the same resolution as one made from the card's
	 * editor or from the composer's setup chip, and there is one answer in this app to what
	 * carries a book rather than one per surface.
	 *
	 * The panel stays open across presses: binding a book to three chats is a run of them.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import { foldForSearch } from '$lib/components/library/browse';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';
	import { chatLorebookClaim } from '$lib/utils/chat-setup';
	import type { LibraryEntry } from '$lib/types/library';

	interface Props {
		/** The open book. Everything here is asked about this one id. */
		bookId: string;
	}

	let { bookId }: Props = $props();

	/** Below this the list is short enough to read whole and a search field costs more
	 *  attention than the scrolling it saves. The number the setup chip's lists use. */
	const SEARCH_FROM = 8;

	interface BindRow {
		id: string;
		name: string;
		bound: boolean;
		/** The card's own face, aimed by its own framing. A chat has none and wears the group's
		 *  glyph in the same frame, so one list stays one shape. */
		thumb?: string | null;
		focus?: string;
	}

	interface BindGroup {
		id: string;
		label: string;
		icon: 'users' | 'user' | 'chat';
		rows: BindRow[];
		toggle: (id: string) => void;
	}

	let query = $state('');
	let needle = $derived(foldForSearch(query.trim()));

	/** Cards are scanned by name here, so they are ordered by it rather than by the shelf's
	 *  own sort: this is a picker, not a second view of the Library. */
	const byName = (a: { name: string }, b: { name: string }) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

	function cardRows(entries: LibraryEntry[]): BindRow[] {
		return entries
			.map((entry) => ({
				id: entry.id,
				name: entry.identity.name?.trim() || 'Unnamed',
				bound: entry.data.lorebookIds?.includes(bookId) ?? false,
				thumb: imageService.thumbnailUrl(entry.identity.imageUrl),
				focus: portraitFocusStyle(entry.identity.portraitFocus)
			}))
			.sort(byName);
	}

	let groups = $derived.by<BindGroup[]>(() => [
		{
			id: 'characters',
			label: 'Characters',
			icon: 'users',
			rows: cardRows(characterLibraryStore.characters),
			toggle: toggleCard
		},
		{
			id: 'personas',
			label: 'Personas',
			icon: 'user',
			rows: cardRows(characterLibraryStore.personas),
			toggle: toggleCard
		},
		{
			id: 'chats',
			label: 'Chats',
			icon: 'chat',
			// Newest first, which is the order the Chats panel lists them in: the story
			// somebody is binding a book for is almost always one they were just in.
			rows: chatStore.sortedChats.map((chat) => ({
				id: chat.id,
				name: chat.title?.trim() || 'Untitled chat',
				bound: chatLorebookClaim(chat).includes(bookId)
			})),
			toggle: toggleChat
		}
	]);

	let shown = $derived(
		groups
			.map((group) => ({
				...group,
				rows: needle ? group.rows.filter((row) => foldForSearch(row.name).includes(needle)) : group.rows
			}))
			.filter((group) => group.rows.length > 0)
	);
	let total = $derived(groups.reduce((sum, group) => sum + group.rows.length, 0));

	async function toggleCard(id: string) {
		const entry = characterLibraryStore.entries.find((e) => e.id === id);
		if (!entry) return;
		const ids = entry.data.lorebookIds ?? [];
		const next = ids.includes(bookId) ? ids.filter((x) => x !== bookId) : [...ids, bookId];
		try {
			await characterLibraryStore.updateData(id, { lorebookIds: next });
		} catch (error) {
			toastStore.failed('change what carries this lorebook', error);
		}
	}

	async function toggleChat(id: string) {
		try {
			await chatStore.toggleChatLorebook(id, bookId);
		} catch (error) {
			toastStore.failed('change what carries this lorebook', error);
		}
	}
</script>

{#if total >= SEARCH_FROM}
	<div class="bp-search">
		<div class="brw-search">
			<Icon name="search" class="brw-search-icon w-3.5 h-3.5" />
			<input
				type="text"
				bind:value={query}
				placeholder="Search characters and chats…"
				aria-label="Search what this lorebook can be bound to"
				class="input-base"
			/>
		</div>
	</div>
{/if}

<div class="bp-list">
	{#if shown.length === 0}
		<p class="bp-note">Nothing matches that</p>
	{:else}
		{#each shown as group (group.id)}
			<p class="section-label bp-group">{group.label}</p>
			{#each group.rows as row (row.id)}
				<button
					type="button"
					class="brw-menu-item bp-row"
					class:is-bound={row.bound}
					aria-pressed={row.bound}
					onclick={() => group.toggle(row.id)}
				>
					<span class="bp-face">
						{#if row.thumb}
							<img src={row.thumb} alt="" loading="lazy" style={row.focus} />
						{:else}
							<Icon name={group.icon} class="w-3.5 h-3.5" />
						{/if}
					</span>
					<span class="bp-name">{row.name}</span>
					<span class="bp-check" aria-hidden="true">
						<Icon name="check" class="w-3.5 h-3.5" />
					</span>
				</button>
			{/each}
		{/each}
	{/if}
</div>

<style>
	.bp-search {
		padding: 0.5rem 0.5rem 0.35rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	/* The search field stays put while the list scrolls under it, the split every list in a
	   popover here draws. dvh rather than vh: a static one over-measures under a phone
	   browser's chrome and clips the last rows. */
	.bp-list {
		padding: 0.35rem;
		max-height: min(20rem, 50dvh);
		overflow-y: auto;
	}

	.bp-group {
		padding: 0.4rem 0.5rem 0.25rem;
	}

	.bp-group:first-child {
		padding-top: 0.15rem;
	}

	.bp-note {
		padding: 0.9rem 0.5rem 1rem;
		text-align: center;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-muted);
	}

	/* The shared popover row plus what a toggle needs: a name that truncates instead of
	   pushing the check off the end, and the check itself. */
	.bp-row {
		white-space: normal;
	}

	.bp-row.is-bound {
		color: var(--color-text-primary);
	}

	/* One frame for a portrait and for the glyph standing in where there is none. */
	.bp-face {
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

	.bp-face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.bp-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bp-check {
		flex-shrink: 0;
		display: inline-flex;
		color: var(--color-accent);
		opacity: 0;
		transform: scale(0.6);
		transition: opacity 130ms ease, transform 130ms ease;
	}

	.bp-row.is-bound .bp-check {
		opacity: 1;
		transform: scale(1);
	}
</style>
