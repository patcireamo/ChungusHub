<script lang="ts">
	/**
	 * The character editor's foot: what this card actually amounts to. Every figure is counted
	 * from live state rather than stored anywhere, so none of it can go stale under an edit.
	 *
	 * The two token figures answer different questions and neither replaces the other. The
	 * card's own text is what the author wrote; the prompt figure is what the ACTIVE preset
	 * places, so a field no macro reaches costs nothing, the same rule the editor's
	 * "Not sent to AI" badges are drawn from, asked here through the real macro engine so the
	 * number cannot drift from what assembly would produce.
	 */
	import { chatStore } from '$lib/stores/chat.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { personaStore } from '$lib/stores/persona.svelte';
	import { presetService } from '$lib/services/presets.svelte';
	import { chatPresetStore } from '$lib/stores/chatPreset.svelte';
	import { llmService } from '$lib/services/llm/provider';
	import { db } from '$lib/services/database';
	import { countTokens } from '$lib/tokenizer/count';
	import { extractMacroNames, resolveMacroValues, type MacroContext } from '$lib/macros';
	import { PERMANENT_TRAITS, BLOB_MACRO, type LibraryEntry } from '$lib/types/library';
	import type { ChatListStats } from '$lib/types/chat';

	let { entry }: { entry: LibraryEntry } = $props();

	/**
	 * Every macro that spends THIS card's text: the whole-sheet blob plus each field's own
	 * macro, derived from the trait registry so a new card field is priced the day it lands.
	 * `mesExamplesRaw` is the one name with no trait behind it (macros.ts resolves it from the
	 * example-dialogue field), so it is the only one written out here.
	 */
	const CARD_MACROS = new Set<string>([
		BLOB_MACRO.character,
		'mesExamplesRaw',
		...PERMANENT_TRAITS.character.map((t) => t.macro).filter((m): m is string => !!m)
	]);

	let model = $derived(llmService.getPrimaryModel());

	// ===== Chats and their messages =====

	let chats = $derived(chatStore.chats.filter((c) => c.characterId === entry.id));

	let chatStats = $state<Record<string, ChatListStats>>({});
	$effect(() => {
		// Re-read when the chat set moves (a chat deleted here, an import landing elsewhere).
		// Latest-wins guard: several reads can be in flight at once and resolve out of order.
		void chatStore.chats.length;
		let cancelled = false;
		db.getChatListStats().then((next) => {
			if (!cancelled) chatStats = next;
		});
		return () => {
			cancelled = true;
		};
	});

	// The branch each chat is actually open at, which is what the chats panel counts too. A
	// number that looked like that one but meant something else would be a trap.
	let messages = $derived(chats.reduce((n, c) => n + (chatStats[c.id]?.path ?? 0), 0));
	let messagesTotal = $derived(chats.reduce((n, c) => n + (chatStats[c.id]?.total ?? 0), 0));

	let versions = $derived(characterLibraryStore.versionsFor(entry.id).length);
	let greetings = $derived(entry.data.alternateGreetings?.length ?? 0);
	// Two counts, because they are two sets of pictures: the gallery is the character's art and
	// the sprites are what the engine picks between (architecture/library.md).
	let images = $derived(entry.identity.gallery?.length ?? 0);
	let sprites = $derived(entry.identity.sprites?.length ?? 0);

	// ===== Tokens =====

	// Summed per field rather than over one joined string: the join's own separators are not
	// part of anything the card sends.
	let cardTokens = $derived(
		PERMANENT_TRAITS.character.reduce((n, t) => n + countTokens(entry.data.traits[t.key] ?? '', model), 0)
	);

	let promptTokens = $derived.by(() => {
		const preset = chatPresetStore.resolvedPreset;
		if (!preset) return 0;
		// How many ENABLED items place each card macro. Counted, not deduped: a preset that
		// places one twice really does send that text twice.
		const uses = new Map<string, number>();
		for (const item of preset.items) {
			if (!item.enabled) continue;
			for (const name of extractMacroNames(item.content)) {
				if (CARD_MACROS.has(name)) uses.set(name, (uses.get(name) ?? 0) + 1);
			}
		}
		if (!uses.size) return 0;
		// Only the card's own macros are asked, against a context holding nothing but this
		// card: no lorebook is selected and no chat history is walked to price a character.
		const context: MacroContext = {
			resolvedCharacters: [{ name: entry.identity.name, traits: entry.data.traits }],
			resolvedPersona: personaStore.activeResolved,
			exampleSeparator: preset.exampleSeparator
		};
		const values = resolveMacroValues([...uses.keys()].map((name) => `{{${name}}}`).join('\n'), context);
		let total = 0;
		for (const [name, count] of uses) total += countTokens(values[name] ?? '', model) * count;
		return total;
	});

	function num(value: number): string {
		return value.toLocaleString();
	}
</script>

<div class="stats-bar">
	<span class="stat"><b>{num(chats.length)}</b> {chats.length === 1 ? 'chat' : 'chats'}</span>
	{#if messages > 0}
		<span
			class="stat"
			title="Counted on the branch each chat is open at. {num(messagesTotal)} in total, every branch and swipe included."
		>
			<b>{num(messages)}</b>
			{messages === 1 ? 'message' : 'messages'}
		</span>
	{/if}
	{#if versions > 0}
		<span class="stat"><b>{num(versions)}</b> {versions === 1 ? 'version' : 'versions'}</span>
	{/if}
	{#if greetings > 0}
		<span class="stat"><b>{num(greetings)}</b> alternate {greetings === 1 ? 'greeting' : 'greetings'}</span>
	{/if}
	{#if images > 0}
		<span class="stat"><b>{num(images)}</b> gallery {images === 1 ? 'image' : 'images'}</span>
	{/if}
	{#if sprites > 0}
		<span class="stat"><b>{num(sprites)}</b> {sprites === 1 ? 'sprite' : 'sprites'}</span>
	{/if}
	<span class="stat" title="Every field of this version, counted with the tokenizer of the model you generate with.">
		<b>{num(cardTokens)}</b> tokens on the card
	</span>
	<span class="stat" title="What the active preset actually places in the prompt. Fields no macro reaches cost nothing.">
		<b>{num(promptTokens)}</b> in the prompt
	</span>
</div>

<style>
	/* Head, body, foot: same frame as the editor's header so the panel reads as one thing. */
	.stats-bar {
		flex-shrink: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 0.4rem;
		padding: 0.4rem 1rem 0.4rem 1.5rem;
		border-top: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		line-height: 1.7;
		color: var(--color-text-muted);
	}

	.stat + .stat::before {
		content: '·';
		margin-right: 0.4rem;
		opacity: 0.55;
	}

	.stat b {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-secondary);
	}

	@media (max-width: 640px) {
		.stats-bar {
			padding: 0.35rem 0.6rem 0.35rem 0.9rem;
		}
	}
</style>
