<script lang="ts">
	/**
	 * Assistant Settings: the in-panel view for everything the user configures about
	 * the Chungus Assistant. ONE scrollable page: sections stacked under headers
	 * (Instructions, Suggested Prompts, Skills, Approval, Capabilities). A handful of controls
	 * never needed a nav rail, and a single page means nothing is ever hidden behind an
	 * unvisited tab.
	 *
	 * Nothing about the assistant's generation lives here. Which model serves it, what
	 * sampling it rides, its output cap, its context size and whether it streams are all
	 * fields of the connection assigned to the Assistant surface (Settings → Connections),
	 * exactly like every other call the app makes.
	 */
	import { onMount } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import AssistantSuggestionsSection from './AssistantSuggestionsSection.svelte';
	import AssistantSkillsSection from './AssistantSkillsSection.svelte';
	import AssistantApprovalSection from './AssistantApprovalSection.svelte';
	import AssistantCapabilitiesSection from './AssistantCapabilitiesSection.svelte';
	import { db } from '$lib/services/database';
	import { registerSettingsReload } from '$lib/services/syncedSetting';
	import { toastStore } from '$lib/stores/toast.svelte';

	let { onClose }: { onClose: () => void } = $props();
	let backButton: HTMLButtonElement | undefined = $state();

	// ===== Instructions =====
	// The user's standing instructions for the assistant ride in the system prompt on
	// every turn, so they cost context each step; hence the cap and the live counter.
	// Stored in the shared settings table (key `assistantCustomInstructions`); each session
	// freezes the row at its first turn (server/assistant/sessionSettings.ts), so an edit
	// here lands on new sessions and on any open one the user applies it to.
	const CUSTOM_INSTRUCTIONS_MAX = 4000;
	let instructionsSaved = $state('');
	let instructionsDraft = $state('');
	let instructionsLoaded = $state(false);

	async function loadInstructions(): Promise<void> {
		try {
			const stored = (await db.getSetting('assistantCustomInstructions')) ?? '';
			// Also the re-read path for a remote edit, so a half-typed draft survives it:
			// only an untouched box follows the stored value.
			if (instructionsDraft === instructionsSaved) instructionsDraft = stored;
			instructionsSaved = stored;
			instructionsLoaded = true;
		} catch (e) {
			toastStore.failed('load the assistant instructions', e);
		}
	}

	async function commitInstructions(): Promise<void> {
		const next = instructionsDraft.trim();
		if (next === instructionsSaved) return;
		try {
			await db.setSetting('assistantCustomInstructions', next);
			instructionsSaved = next;
			instructionsDraft = next;
			toastStore.success(next ? 'Instructions saved, in effect for new sessions' : 'Instructions cleared');
		} catch (e) {
			instructionsDraft = instructionsSaved;
			toastStore.failed('save the assistant instructions', e);
		}
	}

	onMount(() => {
		void loadInstructions();
		// The instructions live in the shared settings table and this page reads them straight
		// from the db, so it needs its own re-read: a page left open on a second device would
		// otherwise show a stale draft and re-save it over the newer one. The Capabilities and
		// Skills sections register their own, for the same reason.
		const disposeSettingsReload = registerSettingsReload(loadInstructions);
		requestAnimationFrame(() => backButton?.focus());
		// Capture before portal dialogs handle Escape. If a confirmation is open, it
		// owns that press; otherwise Settings consumes it before Workspace can react.
		window.addEventListener('keydown', handleKeydown, true);
		return () => {
			window.removeEventListener('keydown', handleKeydown, true);
			disposeSettingsReload();
		};
	});

	async function handleKeydown(e: KeyboardEvent): Promise<void> {
		if (e.key !== 'Escape' || document.querySelector('.dialog-portal')) return;
		e.preventDefault();
		e.stopPropagation();
		if (instructionsDraft.trim() !== instructionsSaved) {
			await commitInstructions();
		}
		onClose();
	}
</script>

<section class="assistant-settings-view" aria-label="Assistant settings">
	<header class="assistant-settings-header">
		<button bind:this={backButton} type="button" class="assistant-settings-back" onclick={onClose} aria-label="Back to assistant chat" title="Back to assistant chat">
			<Icon name="arrowLeft" class="w-4 h-4" />
		</button>
		<div class="assistant-settings-title">
			<Icon name="settings" class="w-4 h-4 text-accent" />
			<h2>Assistant Settings</h2>
		</div>
	</header>

	<div class="assistant-settings-body panel-scroll">
		<section class="as-section">
			<div class="as-section-head">
				<h3 class="as-section-title">
					<Icon name="scroll" class="w-3.5 h-3.5" />
					Instructions
				</h3>
				<InfoTip
					text="Standing instructions that ride the assistant's prompt on every turn, so they cost a little context and outrank its built-in tone, though never the approval rules below. An edit reaches new sessions and any open one you Apply it to."
				/>
			</div>

			<textarea
				class="instructions-input"
				bind:value={instructionsDraft}
				onblur={commitInstructions}
				maxlength={CUSTOM_INSTRUCTIONS_MAX}
				disabled={!instructionsLoaded}
				placeholder="e.g. Always reply in my language. Keep character voices distinct. Never touch lorebook entries without asking first."
				aria-label="Assistant custom instructions"
			></textarea>
			<div class="instructions-meta">
				<span class:instructions-count--full={instructionsDraft.length >= CUSTOM_INSTRUCTIONS_MAX}>
					{instructionsDraft.length.toLocaleString()} / {CUSTOM_INSTRUCTIONS_MAX.toLocaleString()}
				</span>
			</div>
		</section>

		<section class="as-section">
			<div class="as-section-head">
				<h3 class="as-section-title">
					<Icon name="sparkles" class="w-3.5 h-3.5" />
					Suggested Prompts
				</h3>
				<InfoTip
					text="The lines the assistant's empty screen offers, in this order. The first four show on their own and Show more reveals the rest. Tapping one fills the composer instead of sending it, and none of them reach the model, so an open session needs no Apply."
				/>
			</div>
			<AssistantSuggestionsSection />
		</section>

		<section class="as-section">
			<div class="as-section-head">
				<h3 class="as-section-title">
					<Icon name="bookOpen" class="w-3.5 h-3.5" />
					Skills
				</h3>
				<InfoTip
					text="Guides the assistant reads before specialized work. Only a skill's title and description cost prompt space; it pulls the full guide when a task matches one."
				/>
			</div>
			<AssistantSkillsSection />
		</section>

		<section class="as-section">
			<div class="as-section-head">
				<h3 class="as-section-title">
					<Icon name="check" class="w-3.5 h-3.5" />
					Approval
				</h3>
				<InfoTip
					text="A reviewed call is shown with the change it would make, and refusing one drops that call alone: the assistant carries on with the rest of its work. This sets what a new tab starts with; the pill beside the composer moves any tab on its own."
				/>
			</div>
			<AssistantApprovalSection />
		</section>

		<section class="as-section">
			<div class="as-section-head">
				<h3 class="as-section-title">
					<Icon name="shield" class="w-3.5 h-3.5" />
					Capabilities
				</h3>
				<InfoTip
					text="Every enabled family's tool descriptions ride the front of every request, so switching one off makes the assistant cheaper as well as narrower. Off bites every open session at once; on reaches new sessions and any open one you Apply the settings to."
				/>
			</div>
			<AssistantCapabilitiesSection />
		</section>
	</div>
</section>

<style>
	.assistant-settings-view {
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: transparent;
	}

	.assistant-settings-header {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.55rem;
		height: 2.6rem;
		padding: 0 0.55rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.assistant-settings-back {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.8rem;
		height: 1.8rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.assistant-settings-back:hover {
		background: color-mix(in srgb, var(--color-accent) 16%, transparent);
		color: var(--color-text-primary);
	}

	.assistant-settings-title {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
	}

	.assistant-settings-title h2 {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.85rem;
		font-weight: 650;
		color: var(--color-text-primary);
	}

	.assistant-settings-body {
		flex: 1;
		min-height: 0;
		overscroll-behavior: contain;
		padding: 0.8rem 0.75rem 1rem;
	}

	.as-section + .as-section {
		margin-top: 1.1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	/* The InfoTip rides beside the heading, not inside it: its trigger carries the
	   whole explanation as a label, which would otherwise be read out as part of
	   the section heading itself. */
	.as-section-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0.6rem;
	}

	.as-section-title {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 650;
		color: var(--color-text-primary);
	}

	.as-section-title :global(svg) {
		color: var(--color-accent);
	}

	.instructions-input {
		width: 100%;
		min-height: 11rem;
		resize: vertical;
		padding: 0.6rem 0.7rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: var(--color-input-bg, var(--color-bg-tertiary));
		color: var(--color-text-primary);
		font-family: var(--font-ui);
		font-size: 0.8rem;
		line-height: 1.55;
	}

	.instructions-input:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
	}

	.instructions-input:disabled {
		opacity: 0.6;
	}

	.instructions-meta {
		display: flex;
		justify-content: flex-end;
		margin-top: 0.4rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.instructions-count--full {
		color: var(--color-danger, #e5484d);
	}

</style>
