<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';

	interface Props {
		onEdit: () => void;
		onDelete: () => void;
		onCopy: () => Promise<void>;
		onRegenerate?: () => void;
		showRegenerate?: boolean;
		/** Label for the regenerate button, and its accessible name: the word labels are
		 *  display:none on narrow screens, so a fixed one would name all three states wrong. */
		regenerateLabel?: string;
		/** Extend this reply from where it stopped. Sits beside Retry because the two are the
		 *  pair the hand reaches for after reading a reply: again, or more. */
		onContinue?: () => void;
		showContinue?: boolean;
		/** Fork this turn into a new branch, any role: a user turn forks into a different thing
		 *  said, a reply into a hand-written alternate you can swipe between. */
		onBranch?: () => void;
		showBranch?: boolean;
	}

	let {
		onEdit,
		onDelete,
		onCopy,
		onRegenerate,
		showRegenerate = false,
		regenerateLabel = 'Retry',
		onContinue,
		showContinue = false,
		onBranch,
		showBranch = false
	}: Props = $props();

	let justCopied = $state(false);

	// The checkmark waits for the copy: claiming it over an empty clipboard sends the
	// user off to paste nothing.
	async function handleCopy() {
		try {
			await onCopy();
		} catch {
			toastStore.error('Copy failed. Select the text and copy it by hand.');
			return;
		}
		justCopied = true;
		setTimeout(() => (justCopied = false), 1500);
	}
</script>

<div class="message-actions" role="toolbar" aria-label="Message actions">
	<button
		type="button"
		class="action-btn"
		onclick={onEdit}
		aria-label="Edit message"
		title="Edit"
	>
		<Icon name="edit" class="w-3.5 h-3.5" strokeWidth={1.75} />
		<span class="action-label">Edit</span>
	</button>

	<button
		type="button"
		class="action-btn"
		onclick={handleCopy}
		aria-label="Copy message"
		title={justCopied ? 'Copied!' : 'Copy'}
	>
		<Icon name={justCopied ? 'check' : 'copy'} class="w-3.5 h-3.5" strokeWidth={1.75} />
		<span class="action-label">{justCopied ? 'Copied' : 'Copy'}</span>
	</button>

	{#if showRegenerate && onRegenerate}
		<button
			type="button"
			class="action-btn"
			onclick={onRegenerate}
			aria-label={regenerateLabel}
			title={regenerateLabel}
		>
			<Icon name="refresh" class="w-3.5 h-3.5" strokeWidth={1.75} />
			<span class="action-label">{regenerateLabel}</span>
		</button>
	{/if}

	{#if showContinue && onContinue}
		<button
			type="button"
			class="action-btn"
			onclick={onContinue}
			aria-label="Continue this reply"
			title="Continue: extend this reply from where it stopped"
		>
			<Icon name="feather" class="w-3.5 h-3.5" strokeWidth={1.75} />
			<span class="action-label">Continue</span>
		</button>
	{/if}

	{#if showBranch && onBranch}
		<button
			type="button"
			class="action-btn"
			onclick={onBranch}
			aria-label="Branch this turn"
			title="Branch: fork this turn into a new take you can rewrite"
		>
			<Icon name="branch" class="w-3.5 h-3.5" strokeWidth={1.75} />
			<span class="action-label">Branch</span>
		</button>
	{/if}

	<button
		type="button"
		class="action-btn action-btn-danger"
		onclick={onDelete}
		aria-label="Delete message"
		title="Delete"
	>
		<Icon name="trash" class="w-3.5 h-3.5" strokeWidth={1.75} />
		<span class="action-label">Delete</span>
	</button>
</div>

<style>
	.message-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		padding: 0.16rem;
		border-radius: var(--radius-full);
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 92%, transparent);
		background: color-mix(in srgb, var(--color-bg-secondary) 76%, transparent);
	}

	/* Padding, gap and the word labels ride the Compact actions setting; the phone
	   rule below sets the same properties later in source, so narrow screens stay
	   icon-only whatever the setting says. */
	.action-btn {
		height: 1.6rem;
		min-width: 1.6rem;
		padding: var(--msg-action-pad, 0 0.5rem);
		border: 1px solid transparent;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--color-text-secondary);
		display: inline-flex;
		align-items: center;
		gap: var(--msg-action-gap, 0.3rem);
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		cursor: pointer;
		transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease;
	}

	.action-btn:hover {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		border-color: color-mix(in srgb, var(--color-border) 76%, transparent);
	}

	.action-btn:focus-visible {
		outline: 0;
		border-color: color-mix(in srgb, var(--color-accent) 85%, white 15%);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent-muted) 70%, transparent);
	}

	.action-btn-danger:hover {
		color: var(--color-error);
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
		border-color: color-mix(in srgb, var(--color-error) 45%, transparent);
	}

	.action-label {
		display: var(--msg-action-label, inline);
		line-height: 1;
		white-space: nowrap;
	}

	@media (max-width: 900px) {
		.action-btn {
			padding: 0 0.4rem;
			gap: 0;
		}

		.action-label {
			display: none;
		}
	}

	/* 26px buttons are unhittable with a thumb, so grow to ~40px on touch. The bar
	   is already icon-only there (rule above), so the wider row still fits. */
	@media (pointer: coarse) {
		.action-btn {
			height: 2.4rem;
			min-width: 2.4rem;
		}
	}
</style>
