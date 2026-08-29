<script lang="ts">
	/**
	 * One row of Settings → This chat → Overrides: what the open chat does differently about
	 * one otherwise app-wide setting.
	 *
	 * Every card asks the same three things in the same order (what is in force, where it
	 * came from, and which layer should decide), so it is one component rendered three times
	 * rather than three cards free to drift apart. Only what the value IS and what it is
	 * called differ, so only those are props; the layering itself comes in through
	 * `OverrideSurface`, which all three stores satisfy.
	 *
	 * **Nothing here picks a value.** A persona is chosen from the composer or the Library, a
	 * connection on the Connections page, a preset in the Prompt Builder, and this card only
	 * decides which layer remembers that choice. The split is the whole design: a second
	 * picker here would be a second place the value can be set, and the two would disagree
	 * the first time either was used. It is also why switching by hand moves THIS chat to
	 * Global rather than writing into whatever layer is armed: a picker that silently loses
	 * to a pin is a control that looks broken.
	 *
	 * Each pill therefore reads as "make this the layer that decides", and pressing one is
	 * seeded from whatever is already in force, so the press itself never changes the value,
	 * only where that answer is written down.
	 */
	import type { Snippet } from 'svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import PillRow from '$lib/components/ui/PillRow.svelte';
	import type { OverrideSurface } from '$lib/stores/chatOverride.svelte';
	import type { OverrideScope } from '$lib/types/chat';

	interface Props {
		/** The assistant's deep-link anchor for this card. */
		anchor: string;
		title: string;
		tip: string;
		/** The setting in the reader's words, lowercase, for the sentences below ("persona"). */
		noun: string;
		/** The value in force, named. */
		value: string;
		/** The other half of the answer where there is one, such as a connection's model. */
		detail?: string;
		/** Where this value is picked, for the sentence shown while the chat follows the app. */
		switchHint: string;
		store: OverrideSurface;
		/** Persona has a portrait; nothing else does. */
		portrait?: Snippet;
	}

	let { anchor, title, tip, noun, value, detail, switchHint, store, portrait }: Props = $props();

	let scope = $derived(store.scope);
	let characterName = $derived(store.characterName);
	let others = $derived(store.otherChatsFollowingCharacter);
	let ignoring = $derived(store.ignoringCharacterDefault);

	// Where the value in force came from, in the reader's terms rather than as a scope name:
	// a highlighted "Chat" pill says which one is on, not what being on means.
	let fromLine = $derived.by(() => {
		if (!store.canScope) return `Open a chat to give it a ${noun} of its own.`;
		if (scope === 'chat') return 'Pinned to this chat.';
		if (scope === 'character') return `The default for ${characterName ?? 'this character'}.`;
		if (ignoring) return `Following the app's ${noun}, not this character's default.`;
		return `Following the app's ${noun}.`;
	});

	// The one thing the pills cannot show: how far the layer in force actually reaches.
	// Chats carrying a pin of their own are already excluded from the count upstream, since
	// they would not feel a change to the character's default.
	let note = $derived.by(() => {
		if (!store.canScope) return '';
		if (scope === 'character') {
			if (others === 0) return 'No other chat with this character is following it yet.';
			return others === 1
				? 'One other chat with this character follows it too.'
				: `${others} other chats with this character follow it too.`;
		}
		if (scope === 'chat') return 'No other chat is affected.';
		if (ignoring) return `${characterName ?? 'This character'} keeps its default for its other chats.`;
		return switchHint;
	});

	let scopes = $derived([
		{
			value: 'chat',
			label: 'Chat',
			title: `This chat alone uses the ${noun} above.`,
			disabled: !store.canScope
		},
		{
			value: 'character',
			label: 'Character',
			title: store.canScopeCharacter
				? `Every chat with ${characterName ?? 'this character'} opens on this ${noun}, unless it pins its own.`
				: 'This chat has no character bound, so there is no card to hang a default on.',
			disabled: !store.canScope || !store.canScopeCharacter
		},
		{
			value: 'global',
			label: 'Global',
			title: `This chat follows the app's ${noun}, ignoring any default its character carries. No other chat changes.`,
			disabled: !store.canScope
		}
	]);

	function pick(next: string): void {
		if (next === scope) return;
		if (next === ('chat' satisfies OverrideScope)) void store.pinToChat();
		else if (next === ('character' satisfies OverrideScope)) void store.pinToCharacter();
		else void store.resetToGlobal();
	}
</script>

<section class="card" data-setting={anchor}>
	<div class="card-head">
		<span class="card-title">{title}</span>
		<InfoTip text={tip} />
		{#if scope !== 'global'}
			<span class="scope-chip font-ui">{scope === 'chat' ? 'This chat' : 'Character'}</span>
		{/if}
	</div>

	<div class="card-body">
		<div class="current">
			{#if portrait}{@render portrait()}{/if}
			<div class="current-text">
				<span class="current-name font-ui">Currently: {value}</span>
				{#if detail}<span class="current-detail font-ui">{detail}</span>{/if}
				<span class="current-from font-ui">{fromLine}</span>
			</div>
		</div>

		<div class="control">
			<span class="control-label font-ui">Override</span>
			<PillRow
				options={scopes}
				current={scope}
				onpick={pick}
				label="Which layer decides this chat's {noun}"
			/>
		</div>

		{#if note}<p class="scope-note font-ui">{note}</p>{/if}
	</div>
</section>

<style>
	/* The value in force is stated before the controls that move it: the first question a
	   reader brings to this page is "what is my story on", not "which layer is on". */
	.current {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.current-text {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.current-name {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.current-detail {
		font-size: 0.7rem;
		color: var(--color-text-secondary);
	}

	.current-from {
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.control {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.control-label {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.scope-note {
		font-size: 0.7rem;
		line-height: 1.4;
		color: var(--color-text-muted);
	}

	/* Same recipe as the Interface page's scope chip, for the same reason: what it qualifies
	   is the card's title, so it rides beside it rather than in the body. */
	.scope-chip {
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-accent) 13%, transparent);
		font-size: 0.64rem;
		font-weight: 600;
		color: var(--color-accent);
		white-space: nowrap;
	}
</style>
