<script lang="ts">
	/**
	 * Settings → This chat → Overrides: what the open chat does differently from the app.
	 *
	 * One card per overridable setting, each asking the same three things in the same order:
	 * what is in force, where it came from, and which layer should decide. Persona is the
	 * first; Connection and Preset are the ones this shape exists to make room for. Background
	 * and ambient effects keep their own switch on the Interface page instead, beside the
	 * controls that edit them: a scene is tuned in place, so its scope belongs where the
	 * tuning is.
	 *
	 * **Nothing on this page picks a value.** A persona is chosen where it has always been
	 * chosen (the composer's picker, or the Library), and this page only decides which layer
	 * remembers that choice. The split is the whole design: a second picker here would be a
	 * second place a persona can be set, and the two would disagree the first time either was
	 * used. It is also why switching persona by hand CLEARS the override rather than writing
	 * into it (stores/chatPersona.svelte.ts): a picker that silently loses to a pin is a
	 * control that looks broken.
	 *
	 * Each pill therefore reads as "make this the layer that decides", and pressing one is
	 * seeded from whatever is already in force, so the press itself never changes who you
	 * are playing as, only where that answer is written down.
	 */
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import PillRow from '$lib/components/ui/PillRow.svelte';
	import { chatPersonaStore, type PersonaScope } from '$lib/stores/chatPersona.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';

	let entry = $derived(chatPersonaStore.resolvedEntry);
	let scope = $derived(chatPersonaStore.scope);
	let canScope = $derived(chatPersonaStore.canScope);
	let canScopeCharacter = $derived(chatPersonaStore.canScopeCharacter);
	let characterName = $derived(chatPersonaStore.characterName);
	let others = $derived(chatPersonaStore.otherChatsFollowingCharacter);

	let personaName = $derived(entry?.identity.name?.trim() || 'No persona');
	let thumb = $derived(imageService.thumbnailUrl(entry?.identity.imageUrl));
	let focus = $derived(portraitFocusStyle(entry?.identity.portraitFocus));

	// Where the value in force came from, in the reader's terms rather than as a scope name:
	// a highlighted "Chat" pill says which one is on, not what being on means.
	let fromLine = $derived.by(() => {
		if (!canScope) return 'Open a chat to give it a persona of its own.';
		if (scope === 'chat') return 'Pinned to this chat.';
		if (scope === 'character') return `The default for ${characterName ?? 'this character'}.`;
		return "Following the app's active persona.";
	});

	// The one thing the pills cannot show: how far the layer in force actually reaches.
	// Chats carrying a pin of their own are already excluded from the count upstream, since
	// they would not feel a change to the character's default.
	let note = $derived.by(() => {
		if (!canScope) return '';
		if (scope === 'character') {
			if (others === 0) return 'No other chat with this character is following it yet.';
			return others === 1
				? 'One other chat with this character follows it too.'
				: `${others} other chats with this character follow it too.`;
		}
		if (scope === 'chat') return 'No other chat is affected.';
		return 'Switching persona from the composer or the Library always lands back here.';
	});

	let scopes = $derived([
		{
			value: 'chat',
			label: 'Chat',
			title: 'This chat alone plays as the persona above.',
			disabled: !canScope
		},
		{
			value: 'character',
			label: 'Character',
			title: canScopeCharacter
				? `Every chat with ${characterName ?? 'this character'} opens on this persona, unless it pins its own.`
				: 'This chat has no character bound, so there is no card to hang a default on.',
			disabled: !canScope || !canScopeCharacter
		},
		{
			value: 'global',
			label: 'Global',
			title: "Drop the override: this chat follows the app's active persona again.",
			disabled: !canScope
		}
	]);

	function pick(value: string): void {
		const next = value as PersonaScope;
		if (next === scope) return;
		if (next === 'chat') void chatPersonaStore.pinToChat();
		else if (next === 'character') void chatPersonaStore.pinToCharacter();
		else void chatPersonaStore.resetToGlobal();
	}
</script>

<div class="overrides">
	<section class="card" data-setting="override-persona">
		<div class="card-head">
			<span class="card-title">Persona</span>
			<InfoTip
				text="Who you play as in this story. Pick the persona itself from the composer or the Library; this only decides whether that choice sticks to this chat, to the character, or to the whole app."
			/>
			{#if scope !== 'global'}
				<span class="scope-chip font-ui">{scope === 'chat' ? 'This chat' : 'Character'}</span>
			{/if}
		</div>

		<div class="card-body">
			<div class="current">
				<div class="portrait">
					{#if thumb}
						<img class="portrait-img" src={thumb} alt="" style={focus} />
					{/if}
				</div>
				<div class="current-text">
					<span class="current-name font-ui">Currently: {personaName}</span>
					<span class="current-from font-ui">{fromLine}</span>
				</div>
			</div>

			<div class="control">
				<span class="control-label font-ui">Override</span>
				<PillRow
					options={scopes}
					current={scope}
					onpick={pick}
					label="Which layer decides this chat's persona"
				/>
			</div>

			{#if note}<p class="scope-note font-ui">{note}</p>{/if}
		</div>
	</section>
</div>

<style>
	.overrides {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	/* The value in force is stated before the controls that move it: the first question a
	   reader brings to this page is "who am I in this story", not "which layer is on". */
	.current {
		display: flex;
		align-items: center;
		gap: 0.6rem;
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
