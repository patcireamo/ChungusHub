<script lang="ts">
	/**
	 * What this story is running on, and the one place to change it.
	 *
	 * A chat can claim its own connection and its own character version. Claiming happens
	 * here, in the chat, because a chat can only claim things it can name; the Connections
	 * page and the Library keep speaking for the app. Every row's list opens with the entry
	 * that hands that row back to the app, so nothing has to be un-set some other way.
	 *
	 * The chip stands whenever a chat is open rather than appearing on divergence: it is a
	 * readout of the story's setup first and a control second, and a control that shows up
	 * only once something is odd is a control nobody knows exists.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { connectionStore } from '$lib/stores/connections.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { chatConnectionId, chatPersonaClaim, chatPersonaEntry } from '$lib/utils/chat-setup';

	let chat = $derived(chatStore.activeChat);

	// ===== You =====

	let personas = $derived(characterLibraryStore.personas);
	let claimedPersona = $derived(chatPersonaClaim(chat));
	let persona = $derived(chatPersonaEntry(chat));
	/** The chat named a persona that no longer exists, so it is speaking as the app's. */
	let lostPersona = $derived(
		claimedPersona !== null && !personas.some((p) => p.id === claimedPersona)
	);
	/** Which row wears the check: the claim while it is live, else the app entry. */
	let pickedPersona = $derived(lostPersona ? null : claimedPersona);

	// ===== Connection =====

	let claimedConnection = $derived(chat ? chatStore.featureState(chat.id).connection : null);
	let liveConnection = $derived(chatConnectionId(chat));
	/** A claim naming a connection that is gone. The story keeps sending on the app's, and
	 *  the popover says so rather than showing a row that quietly means something else. */
	let lostConnection = $derived(claimedConnection !== null && liveConnection === null);
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

	// ===== The chip itself =====

	let personaName = $derived(persona?.identity.name ?? 'You');
	let modelName = $derived(connection?.model.split('/').pop() || 'No model');

	let open = $state(false);
	let menuRef = $state<HTMLDivElement | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (menuRef && !menuRef.contains(e.target as Node)) open = false;
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	});

	async function pickPersona(id: string | null) {
		if (!chat || busy) return;
		open = false;
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
		open = false;
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
		open = false;
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
	<div class="relative" bind:this={menuRef}>
		<button
			type="button"
			class="setup-chip"
			class:is-open={open}
			onclick={() => (open = !open)}
			aria-haspopup="menu"
			aria-expanded={open}
			title={`Playing as ${personaName} on ${modelName}`}
		>
			<Icon name="sliders" class="w-3 h-3" />
			<span class="setup-chip-label">{personaName} · {modelName}</span>
		</button>

		{#if open}
			<div
				role="menu"
				class="absolute bottom-full left-0 mb-2 z-20 w-[264px] py-1.5 surface-float rounded-lg shadow-md"
			>
				<p class="setup-heading">You</p>
				{#if lostPersona}
					<p class="setup-note">The persona this chat named is gone. It is playing as the app's.</p>
				{/if}
				<div class="setup-list">
					<button
						type="button"
						role="menuitem"
						class="setup-row"
						class:is-picked={pickedPersona === null}
						disabled={busy}
						onclick={() => pickPersona(null)}
					>
						<span class="setup-check" class:is-visible={pickedPersona === null}>
							<Icon name="check" class="w-3.5 h-3.5" />
						</span>
						<span class="setup-row-name">Follow the app</span>
					</button>
					{#each personas as option (option.id)}
						{@const isPicked = option.id === pickedPersona}
						<button
							type="button"
							role="menuitem"
							class="setup-row"
							class:is-picked={isPicked}
							disabled={busy}
							onclick={() => pickPersona(option.id)}
						>
							<span class="setup-check" class:is-visible={isPicked}>
								<Icon name="check" class="w-3.5 h-3.5" />
							</span>
							<span class="setup-row-name">{option.identity.name}</span>
						</button>
					{/each}
				</div>

				<p class="setup-heading setup-heading-next">Connection</p>
				{#if lostConnection}
					<p class="setup-note">
						The connection this chat named is gone. It is sending on the app's.
					</p>
				{/if}
				<div class="setup-list">
					<button
						type="button"
						role="menuitem"
						class="setup-row"
						class:is-picked={liveConnection === null}
						disabled={busy}
						onclick={() => pickConnection(null)}
					>
						<span class="setup-check" class:is-visible={liveConnection === null}>
							<Icon name="check" class="w-3.5 h-3.5" />
						</span>
						<span class="setup-row-name">Follow the app</span>
					</button>
					{#each connectionStore.list() as conn (conn.id)}
						{@const isPicked = conn.id === liveConnection}
						<button
							type="button"
							role="menuitem"
							class="setup-row"
							class:is-picked={isPicked}
							disabled={busy}
							onclick={() => pickConnection(conn.id)}
						>
							<span class="setup-check" class:is-visible={isPicked}>
								<Icon name="check" class="w-3.5 h-3.5" />
							</span>
							<span class="setup-row-name">{conn.name}</span>
						</button>
					{/each}
				</div>

				{#if versions.length > 0}
					<p class="setup-heading setup-heading-next">Version</p>
					<div class="setup-list">
						{#each versions as version (version.id)}
							{@const isPicked = version.id === pinnedVersionId}
							<button
								type="button"
								role="menuitem"
								class="setup-row"
								class:is-picked={isPicked}
								disabled={busy}
								onclick={() => pickVersion(version.id)}
							>
								<span class="setup-check" class:is-visible={isPicked}>
									<Icon name="check" class="w-3.5 h-3.5" />
								</span>
								<span class="setup-row-name">{version.name}</span>
							</button>
						{/each}
					</div>
				{/if}

				<p class="setup-foot">Only this chat is affected.</p>
			</div>
		{/if}
	</div>
{/if}

<style>
	.setup-chip {
		height: 1.75rem;
		max-width: 13rem;
		padding: 0 0.5rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
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

	.setup-chip-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.setup-heading {
		padding: 0 0.75rem 0.25rem;
		font-family: var(--font-ui);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
	}

	.setup-heading-next {
		padding-top: 0.5rem;
		margin-top: 0.35rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.setup-note,
	.setup-foot {
		padding: 0 0.75rem;
		font-family: var(--font-ui);
		font-size: 10px;
		line-height: 1.4;
		color: var(--color-text-muted);
	}

	.setup-note {
		padding-bottom: 0.3rem;
	}

	.setup-foot {
		padding-top: 0.4rem;
	}

	.setup-list {
		max-height: 12rem;
		overflow-y: auto;
	}

	.setup-row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.42rem 0.65rem 0.42rem 0.5rem;
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

	.setup-row-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
