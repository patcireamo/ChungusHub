<script lang="ts">
	/**
	 * The foot of both library editors: what the entry on screen actually amounts to. Every
	 * figure is counted from live state rather than stored anywhere, so none of it can go stale
	 * under an edit, and the line's own shape is the shared `.editor-stats` recipe (app.css),
	 * which the open lorebook's foot wears too.
	 *
	 * **One component for two editors, because the expensive half is one question**: what the
	 * ACTIVE preset places in a prompt, asked through the real macro engine so the number cannot
	 * drift from what assembly would produce. What differs is what each thing HAS, and that is
	 * the only split below: a character has versions, greetings and art; a persona has one
	 * description and the stories it is played in.
	 *
	 * The two token figures answer different questions and neither replaces the other. The
	 * entry's own text is what the author wrote; the prompt figure is what the preset places, so
	 * a field no macro reaches costs nothing, the same rule the editor's "Not sent to AI" badges
	 * are drawn from.
	 */
	import { chatStore } from '$lib/stores/chat.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { personaStore } from '$lib/stores/persona.svelte';
	import { presetService } from '$lib/services/presets.svelte';
	import { llmService } from '$lib/services/llm/provider';
	import { db } from '$lib/services/database';
	import { countTokens } from '$lib/tokenizer/count';
	import { chatPersonaClaim, personaEntryFor } from '$lib/utils/chat-setup';
	import { extractMacroNames, resolveMacroValues, type MacroContext } from '$lib/macros';
	import { PERMANENT_TRAITS, BLOB_MACRO, type LibraryEntry } from '$lib/types/library';
	import type { ChatListStats } from '$lib/types/chat';

	let { entry }: { entry: LibraryEntry } = $props();

	let isPersona = $derived(entry.type === 'persona');

	/**
	 * Every macro that spends THIS entry's text: the whole-sheet blob plus each field's own
	 * macro, derived from the trait registry so a new field is priced the day it lands.
	 * `mesExamplesRaw` is the one name with no trait behind it (macros.ts resolves it from the
	 * example-dialogue field), and a character's alone, so it is the only one written out here.
	 */
	let cardMacros = $derived.by(() => {
		const names = new Set<string>([BLOB_MACRO[entry.type]]);
		for (const trait of PERMANENT_TRAITS[entry.type]) {
			if (trait.macro) names.add(trait.macro);
		}
		if (!isPersona) names.add('mesExamplesRaw');
		return names;
	});

	let model = $derived(llmService.getPrimaryModel());

	// ===== Chats and their messages =====

	/**
	 * A character's chats are the ones cast with it. A persona's are the ones PLAYED as it,
	 * which is a resolved question rather than a stored one: a chat that named this persona,
	 * and, while this is the app's default, every chat that named none. Asked through the one
	 * resolver a send uses, so this line cannot count a story the prompt plays differently.
	 */
	let chats = $derived.by(() => {
		if (!isPersona) return chatStore.chats.filter((c) => c.characterId === entry.id);
		// Resolved once rather than once per chat: what a story that named nobody plays as is
		// the same answer for every one of them, and most stories name nobody.
		const followsThis = personaEntryFor(null)?.id === entry.id;
		return chatStore.chats.filter((c) => {
			const claimed = chatPersonaClaim(c);
			return claimed ? personaEntryFor(claimed)?.id === entry.id : followsThis;
		});
	});

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

	// The four counts below are character-only fields, so a persona simply answers 0 to each
	// and the rows they draw stand down on their own.
	let versions = $derived(characterLibraryStore.versionsFor(entry.id).length);
	let greetings = $derived(entry.data.alternateGreetings?.length ?? 0);
	// Two counts, because they are two sets of pictures: the gallery is the character's art and
	// the sprites are what the engine picks between (architecture/library.md).
	let images = $derived(entry.identity.gallery?.length ?? 0);
	let sprites = $derived(entry.identity.sprites?.length ?? 0);

	// ===== Tokens =====

	// Summed per field rather than over one joined string: the join's own separators are not
	// part of anything the entry sends.
	let cardTokens = $derived(
		PERMANENT_TRAITS[entry.type].reduce(
			(n, t) => n + countTokens(entry.data.traits[t.key] ?? '', model),
			0
		)
	);

	let promptTokens = $derived.by(() => {
		const preset = presetService.getActiveEffectivePreset();
		if (!preset) return 0;
		// How many ENABLED items place each of this entry's macros. Counted, not deduped: a
		// preset that places one twice really does send that text twice.
		const uses = new Map<string, number>();
		for (const item of preset.items) {
			if (!item.enabled) continue;
			for (const name of extractMacroNames(item.content)) {
				if (cardMacros.has(name)) uses.set(name, (uses.get(name) ?? 0) + 1);
			}
		}
		if (!uses.size) return 0;
		// Only this entry's own macros are asked, against a context holding nothing but it: no
		// lorebook is selected and no chat history is walked to price a card. A persona is
		// priced as ITSELF rather than as whichever persona the app is currently set to, or the
		// figure would answer for somebody else the moment the default moves.
		const self = { name: entry.identity.name, traits: entry.data.traits };
		const context: MacroContext = {
			resolvedCharacters: isPersona ? [] : [self],
			resolvedPersona: isPersona ? self : personaStore.activeResolved,
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

<div class="editor-stats">
	<span
		class="editor-stat"
		title={isPersona
			? 'Chats that named this persona, plus every chat following the default while this is it.'
			: undefined}
	>
		<b>{num(chats.length)}</b>
		{chats.length === 1 ? 'chat' : 'chats'}
	</span>
	{#if messages > 0}
		<span
			class="editor-stat"
			title="Counted on the branch each chat is open at. {num(messagesTotal)} in total, every branch and swipe included."
		>
			<b>{num(messages)}</b>
			{messages === 1 ? 'message' : 'messages'}
		</span>
	{/if}
	{#if versions > 0}
		<span class="editor-stat"><b>{num(versions)}</b> {versions === 1 ? 'version' : 'versions'}</span>
	{/if}
	{#if greetings > 0}
		<span class="editor-stat"><b>{num(greetings)}</b> alternate {greetings === 1 ? 'greeting' : 'greetings'}</span>
	{/if}
	{#if images > 0}
		<span class="editor-stat"><b>{num(images)}</b> gallery {images === 1 ? 'image' : 'images'}</span>
	{/if}
	{#if sprites > 0}
		<span class="editor-stat"><b>{num(sprites)}</b> {sprites === 1 ? 'sprite' : 'sprites'}</span>
	{/if}
	<span
		class="editor-stat"
		title="Counted with the tokenizer of the model you generate with."
	>
		<b>{num(cardTokens)}</b>
		{isPersona ? 'tokens in the description' : 'tokens on the card'}
	</span>
	<span class="editor-stat" title="What the active preset actually places in the prompt. Fields no macro reaches cost nothing.">
		<b>{num(promptTokens)}</b> in the prompt
	</span>
</div>
