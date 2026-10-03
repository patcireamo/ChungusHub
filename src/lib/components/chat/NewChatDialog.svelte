<script lang="ts">
	/**
	 * What the composer menu's New chat does with the chat you are leaving: keep it, or delete
	 * it once the new one has started. This one dialog is also the delete's asking (the
	 * destructive-act ladder, architecture/ui-shell-settings.md): it names the chat and states
	 * its real message count, and `holdMs` turns the delete into the same press-and-hold
	 * every big delete uses, so the choice needs no second dialog behind it.
	 */
	import Dialog from '$lib/components/ui/Dialog.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import HoldToConfirmButton from '$lib/components/ui/HoldToConfirmButton.svelte';

	interface Props {
		open: boolean;
		/** The chat being left, named in the question. */
		title: string;
		/** Its message count, branches included; null when the count could not be read. */
		messages: number | null;
		/** > 0 makes the delete choice a press-and-hold (pass `holdMsForBlast(messages)`). */
		holdMs: number;
		onNew: () => void;
		onNewAndDelete: () => void;
		onCancel: () => void;
	}

	let { open, title, messages, holdMs, onNew, onNewAndDelete, onCancel }: Props = $props();

	let count = $derived(messages === null ? '' : ` (${messages} message${messages === 1 ? '' : 's'})`);
</script>

<Dialog {open} onClose={onCancel} title="New chat" size="sm">
	<p class="new-lead">
		Start a new chat with this character. Keep <strong>{title}</strong>{count}, or delete it
		once the new one has started? Deleting cannot be undone.
	</p>

	<div class="new-actions">
		<Button variant="primary" onclick={onNew}>New chat</Button>
		{#if holdMs > 0}
			<HoldToConfirmButton {holdMs} shape="inline" onconfirm={onNewAndDelete}>
				New chat &amp; delete current
			</HoldToConfirmButton>
		{:else}
			<Button variant="danger" onclick={onNewAndDelete}>New chat &amp; delete current</Button>
		{/if}
	</div>
	<div class="new-cancel">
		<Button variant="ghost" onclick={onCancel}>Cancel</Button>
	</div>
</Dialog>

<style>
	.new-lead {
		font-family: var(--font-ui);
		font-size: 0.85rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.new-lead strong {
		color: var(--color-text-primary);
	}

	/* The two choices share a row and Cancel sits under them on its own, so the layout is
	   the same at every width rather than decided by where the delete label happens to wrap.
	   The choices still wrap on a screen too narrow for both. */
	.new-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.2rem;
	}

	.new-cancel {
		display: flex;
		justify-content: flex-end;
		margin-top: 0.5rem;
	}
</style>
