<script lang="ts">
	/**
	 * Version manager for a character: a calm chip in the editor header that opens the
	 * variant list. Fork-before-edit model: "New version" duplicates the current state
	 * and switches to it; the state you forked from stays parked exactly as it was.
	 * Chats pin variants, so the delete/switch guards here are what keeps old
	 * stories replayable.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { deleteGuard } from '$lib/stores/delete-guard.svelte';

	interface Props {
		entryId: string;
	}

	let { entryId }: Props = $props();

	let entry = $derived(characterLibraryStore.entries.find((e) => e.id === entryId));
	let versions = $derived(characterLibraryStore.versionsFor(entryId));
	let activeVersion = $derived(versions.find((v) => v.id === entry?.activeVersionId) ?? null);
	// The variant new chats are born on, which is the first one made until the editor's New
	// Chat Defaults names another. Badged here because that panel's Version row calls it
	// "Default" without naming it, and this list is where a reader finds out which one it is.
	let defaultVersionId = $derived(characterLibraryStore.chatVersionSeed(entryId));

	let open = $state(false);
	let menuRef = $state<HTMLDivElement | null>(null);
	let busy = $state(false);
	// Right-align the dropdown when the anchor sits too close to the viewport's
	// right edge for the fixed-width panel to fit.
	let alignRight = $state(false);

	// Chats pinned per version, fetched when the menu opens so rows can show which
	// variants anchor stories, and so delete can warn before the store refuses.
	let usage = $state<Record<string, number>>({});

	let creating = $state(false);
	let newName = $state('');
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let confirmingDeleteId = $state<string | null>(null);

	function closeMenu() {
		open = false;
		creating = false;
		renamingId = null;
		confirmingDeleteId = null;
		newName = '';
	}

	$effect(() => {
		if (!open) return;
		void characterLibraryStore.versionUsage(entryId).then((u) => (usage = u));
		if (menuRef) {
			alignRight = menuRef.getBoundingClientRect().left + 270 > window.innerWidth - 8;
		}
		const onDown = (e: MouseEvent) => {
			if (menuRef && !menuRef.contains(e.target as Node)) closeMenu();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				// Consume the press so the workspace's global Esc doesn't also
				// close the hosting Library panel.
				e.preventDefault();
				e.stopPropagation();
				closeMenu();
			}
		};
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});

	async function handleCreate() {
		const name = newName.trim();
		if (!name || busy) return;
		busy = true;
		try {
			const wasUnversioned = !entry?.activeVersionId;
			await characterLibraryStore.createVersion(entryId, name);
			// The first fork pins this character's existing chats to the baseline row
			// server-side; reload so open chat state reflects its new pin immediately.
			if (wasUnversioned) await chatStore.syncReload();
			usage = await characterLibraryStore.versionUsage(entryId);
			newName = '';
			creating = false;
		} catch (error) {
			toastStore.failed(`create the version "${name}"`, error);
		} finally {
			busy = false;
		}
	}

	async function handleSwitch(versionId: string) {
		if (busy || versionId === entry?.activeVersionId) return;
		busy = true;
		try {
			await characterLibraryStore.switchActiveVersion(entryId, versionId);
		} catch (error) {
			toastStore.failed('switch to that version', error);
		} finally {
			busy = false;
		}
	}

	function startRename(id: string, current: string) {
		renamingId = id;
		renameValue = current;
		confirmingDeleteId = null;
	}

	async function handleRename() {
		const id = renamingId;
		const name = renameValue.trim();
		if (!id || !name || busy) return;
		busy = true;
		try {
			await characterLibraryStore.renameVersion(id, name);
			renamingId = null;
		} catch (error) {
			toastStore.failed(`rename the version to "${name}"`, error);
		} finally {
			busy = false;
		}
	}

	async function handleDelete(versionId: string) {
		if (busy) return;
		// The arm is this surface's whole asking, so a rung with no asking left skips it.
		if (deleteGuard.asks && confirmingDeleteId !== versionId) {
			confirmingDeleteId = versionId;
			renamingId = null;
			return;
		}
		busy = true;
		try {
			await characterLibraryStore.deleteVersion(versionId);
			confirmingDeleteId = null;
		} catch (error) {
			toastStore.failed('delete that version', error);
			confirmingDeleteId = null;
		} finally {
			busy = false;
		}
	}
</script>

<div class="relative" bind:this={menuRef}>
	<button
		type="button"
		onclick={() => (open ? closeMenu() : (open = true))}
		class="version-chip"
		class:is-open={open}
		aria-haspopup="menu"
		aria-expanded={open}
		title={activeVersion ? `Version: ${activeVersion.name}` : 'Versions'}
	>
		<Icon name="branch" class="w-3.5 h-3.5" />
		<span class="version-chip-label">{activeVersion ? activeVersion.name : 'Versions'}</span>
		<Icon name="chevronDown" class="w-3 h-3" />
	</button>

	{#if open}
		<div
			role="menu"
			class="surface-float absolute top-full {alignRight ? 'right-0' : 'left-0'} mt-1 w-[270px] max-w-[calc(100vw-1rem)] py-1.5 rounded-[var(--radius-lg)] z-50"
			style="box-shadow: var(--shadow-md);"
		>
			{#if versions.length === 0}
				<p class="px-3 py-1.5 text-[11px] leading-relaxed font-ui text-text-muted">
					Fork the current state into a named version before reworking it. Chats keep
					the exact version they were played with; you can switch any time.
				</p>
			{:else}
				<div class="max-h-64 overflow-y-auto">
					{#each versions as version (version.id)}
						{@const isActive = version.id === entry?.activeVersionId}
						{@const pinned = usage[version.id] ?? 0}
						<div class="version-row" class:is-active={isActive}>
							{#if renamingId === version.id}
								<!-- svelte-ignore a11y_autofocus -- the input replaces the clicked name -->
								<input
									class="version-input mx-2 my-0.5"
									bind:value={renameValue}
									onkeydown={(e) => {
										if (e.key === 'Enter') void handleRename();
										if (e.key === 'Escape') {
											// Cancel just the rename, not the menu, not the panel.
											e.preventDefault();
											e.stopPropagation();
											renamingId = null;
										}
									}}
									placeholder="Version name"
									maxlength="60"
									autofocus
								/>
								<button type="button" class="version-action" title="Save name" onclick={handleRename}>
									<Icon name="check" class="w-3.5 h-3.5" />
								</button>
							{:else}
								<button
									type="button"
									class="version-pick"
									disabled={busy}
									onclick={() => handleSwitch(version.id)}
									title={isActive ? 'Currently editing' : `Switch to "${version.name}"`}
								>
									<span class="version-check" class:is-visible={isActive}>
										<Icon name="check" class="w-3.5 h-3.5" />
									</span>
									<span class="version-name">{version.name}</span>
									{#if version.id === defaultVersionId}
										<span class="version-default">Default</span>
									{/if}
									{#if pinned > 0}
										<span class="version-usage">{pinned} chat{pinned === 1 ? '' : 's'}</span>
									{/if}
								</button>
								<button
									type="button"
									class="version-action"
									title="Rename"
									onclick={() => startRename(version.id, version.name)}
								>
									<Icon name="pencil" class="w-3.5 h-3.5" />
								</button>
								{#if versions.length > 1}
									<button
										type="button"
										class="version-action"
										class:is-confirming={confirmingDeleteId === version.id}
										title={pinned > 0
											? `${pinned} chat${pinned === 1 ? ' is' : 's are'} pinned to this version`
											: confirmingDeleteId === version.id
												? 'Click again to delete'
												: 'Delete version'}
										disabled={pinned > 0 || busy}
										onclick={() => handleDelete(version.id)}
									>
										<Icon name={pinned > 0 ? 'pin' : 'trash'} class="w-3.5 h-3.5" />
									</button>
								{/if}
							{/if}
						</div>
					{/each}
				</div>
				<div class="mx-2 my-1 border-t border-border-subtle"></div>
			{/if}

			{#if creating || versions.length === 0}
				<div class="flex items-center gap-1.5 px-2 py-1">
					<!-- svelte-ignore a11y_autofocus -- opened by the user to type a name -->
					<input
						class="version-input flex-1"
						bind:value={newName}
						onkeydown={(e) => {
							if (e.key === 'Enter') void handleCreate();
							if (e.key === 'Escape') {
								// Cancel just the new-version input, not the menu, not the panel.
								e.preventDefault();
								e.stopPropagation();
								creating = false;
								newName = '';
							}
						}}
						placeholder='Name it: "pirate", "calmer", …'
						maxlength="60"
						autofocus
					/>
					<button
						type="button"
						class="version-action"
						title="Create version"
						disabled={!newName.trim() || busy}
						onclick={handleCreate}
					>
						<Icon name="check" class="w-3.5 h-3.5" />
					</button>
				</div>
			{:else}
				<button type="button" class="version-new" onclick={() => (creating = true)}>
					<Icon name="plus" class="w-3.5 h-3.5" />
					New version from current
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.version-chip {
		height: 2rem;
		max-width: 11rem;
		padding: 0 0.55rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
		color: var(--color-text-secondary);
		display: inline-flex;
		align-items: center;
		gap: 0.32rem;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		transition: color 140ms ease, border-color 140ms ease, background-color 140ms ease;
	}

	.version-chip:hover,
	.version-chip.is-open {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-accent) 36%, transparent);
	}

	.version-chip-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.version-row {
		display: flex;
		align-items: center;
		gap: 0.1rem;
		padding-right: 0.4rem;
	}

	/* Row actions stay invisible until the row is hovered: the list reads as names. */
	.version-row .version-action {
		opacity: 0;
	}

	.version-row:hover .version-action,
	.version-row:focus-within .version-action {
		opacity: 1;
	}

	.version-pick {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.42rem 0.3rem 0.42rem 0.55rem;
		border: 0;
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.76rem;
		cursor: pointer;
		text-align: left;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.version-row:hover .version-pick {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
		color: var(--color-text-primary);
	}

	.version-row.is-active .version-pick {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.version-check {
		width: 0.9rem;
		flex-shrink: 0;
		display: inline-flex;
		color: var(--color-accent);
		visibility: hidden;
	}

	.version-check.is-visible {
		visibility: visible;
	}

	.version-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.version-usage {
		flex-shrink: 0;
		font-size: 0.62rem;
		color: var(--color-text-muted);
	}

	/* The same accent pill the library wears on the persona new chats start as, since it
	   answers the same question about a different thing. */
	.version-default {
		flex-shrink: 0;
		padding: 0.05rem 0.35rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		font-size: 0.62rem;
		font-weight: 600;
		color: var(--color-accent);
	}

	.version-action {
		width: 1.7rem;
		height: 1.7rem;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease, background-color 120ms ease, opacity 120ms ease;
	}

	.version-action:hover:not(:disabled) {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 90%, transparent);
	}

	.version-action.is-confirming {
		color: var(--color-error);
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
		opacity: 1;
	}

	.version-action:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.version-input {
		height: 1.8rem;
		min-width: 0;
		padding: 0 0.5rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		font-family: var(--font-ui);
		font-size: 0.74rem;
	}

	.version-input:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
	}

	.version-new {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.42rem 0.65rem;
		border: 0;
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.version-new:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
		color: var(--color-text-primary);
	}
</style>
