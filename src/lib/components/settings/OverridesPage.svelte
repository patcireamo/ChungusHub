<script lang="ts">
	/**
	 * Settings → This chat → Overrides: what the open chat does differently from the app.
	 *
	 * One card per overridable setting (Persona, Connection, Prompt), each asking the same
	 * three things in the same order: what is in force, where it came from, and which layer
	 * should decide. The card itself is `OverrideCard.svelte`, rendered three times over the
	 * shared surface the three stores expose, so the three can never answer the same question
	 * differently. This file only supplies what each one IS and what it is called.
	 *
	 * Background and ambient effects are deliberately NOT here. Their existing App / This
	 * chat switch stays on Interface, beside the two cards that edit them: a scene is tuned
	 * in place, so its scope belongs with the tuning rather than in a list of names.
	 *
	 * Why no picker lives on this page, and why a manual switch anywhere else lands a chat
	 * back on Global, is written down in OverrideCard.svelte.
	 */
	import OverrideCard from './OverrideCard.svelte';
	import { chatPersonaStore } from '$lib/stores/chatPersona.svelte';
	import { chatConnectionStore } from '$lib/stores/chatConnection.svelte';
	import { chatPresetStore } from '$lib/stores/chatPreset.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';

	let personaEntry = $derived(chatPersonaStore.resolvedEntry);
	let personaName = $derived(personaEntry?.identity.name?.trim() || 'No persona');
	let thumb = $derived(imageService.thumbnailUrl(personaEntry?.identity.imageUrl));
	let focus = $derived(portraitFocusStyle(personaEntry?.identity.portraitFocus));

	let connectionName = $derived(chatConnectionStore.resolvedName || 'No connection');
	// The model, not the provider: it is the half of a connection a reader actually feels,
	// and the same shortening the Connections page uses so the two read as the same thing.
	let connectionModel = $derived.by(() => {
		const model = chatConnectionStore.resolvedModel;
		return model ? (model.split('/').pop() ?? model) : 'No model';
	});

	let presetName = $derived(chatPresetStore.resolvedName || 'No preset');
</script>

<div class="overrides">
	<OverrideCard
		anchor="override-persona"
		title="Persona"
		tip="Who you play as in this story. Pick the persona itself from the composer or the Library; this only decides whether that choice sticks to this chat, to the character, or to the whole app."
		noun="persona"
		value={personaName}
		switchHint="Switching persona from the composer or the Library always lands back here."
		store={chatPersonaStore}
	>
		{#snippet portrait()}
			<div class="portrait">
				{#if thumb}
					<img class="portrait-img" src={thumb} alt="" style={focus} />
				{/if}
			</div>
		{/snippet}
	</OverrideCard>

	<OverrideCard
		anchor="override-connection"
		title="Connection"
		tip="Which connection this chat's turns are sent on. Only the story: the Assistant and the calling engines keep the app-wide routing. Pick the connection itself on the Connections page; this only decides which layer remembers that choice."
		noun="connection"
		value={connectionName}
		detail={connectionModel}
		switchHint="Choosing Primary on the Connections page always lands back here."
		store={chatConnectionStore}
	/>

	<OverrideCard
		anchor="override-preset"
		title="Prompt"
		tip="Which prompt preset this chat is assembled with, unsaved Prompt Builder drafts included. Pick the preset itself in the Prompt Builder or on Preset controls; this only decides which layer remembers that choice."
		noun="prompt preset"
		value={presetName}
		switchHint="Switching preset in the Prompt Builder always lands back here."
		store={chatPresetStore}
	/>
</div>

<style>
	.overrides {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.portrait {
		width: 2.4rem;
		height: 2.4rem;
		flex: none;
		border-radius: var(--radius-md);
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
		background: color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent);
	}

	.portrait-img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
