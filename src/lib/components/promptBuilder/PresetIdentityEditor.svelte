<!--
  The preset's byline, authored. Everything here is what a reader meets before any control:
  the cover, who made it, which version they are holding, the paragraph that opens the page,
  and the one honest sentence about what it was tuned against.

  The cover is the only field that is not text. It is stored as an image file like any other
  art, and it travels by being the picture a PNG card IS, which is why a `.json` export
  leaves it behind and says so.
-->
<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import { autoResize } from '$lib/actions/autoResize';
	import { imageRejectionReason, imageService } from '$lib/services/imageService';
	import { toastStore } from '$lib/stores/toast.svelte';
	import type { PromptPresetMeta } from '$lib/types/database';

	interface Props {
		meta: PromptPresetMeta | undefined;
		onChange: (meta: PromptPresetMeta | undefined) => void;
	}

	let { meta, onChange }: Props = $props();

	let fileInput = $state<HTMLInputElement | null>(null);
	let busy = $state(false);

	let coverUrl = $derived(meta?.cover ? imageService.thumbnailUrl(meta.cover) : null);

	/** Write one field, and drop the whole block once nothing is left in it: an empty
	 *  `meta` object would export as a byline the preset does not actually have. */
	function set(field: keyof PromptPresetMeta, value: string | undefined): void {
		const next: PromptPresetMeta = { ...meta, [field]: value || undefined };
		onChange(Object.values(next).some((v) => v !== undefined) ? next : undefined);
	}

	/**
	 * Uploading writes the new path and nothing else. Deleting the file it replaced belongs
	 * to Save and Discard, not here: the replaced file may be the COMMITTED preset's cover,
	 * and deleting it the moment a draft points elsewhere would leave Discard restoring a
	 * preset whose picture is already gone.
	 */
	async function pickCover(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || busy) return;
		const refused = imageRejectionReason(file);
		if (refused) {
			toastStore.error(refused);
			return;
		}
		busy = true;
		try {
			set('cover', await imageService.saveImage(file, 'presets'));
		} catch (error) {
			toastStore.failed('read that image', error);
		} finally {
			busy = false;
		}
	}

	function removeCover(): void {
		set('cover', undefined);
	}
</script>

<input
	bind:this={fileInput}
	type="file"
	accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
	class="hidden"
	onchange={pickCover}
/>

<div class="pi">
	<div class="pi-cover-row">
		<button
			type="button"
			class="pi-cover"
			class:has-art={!!coverUrl}
			disabled={busy}
			onclick={() => fileInput?.click()}
			title={coverUrl ? 'Replace the cover' : 'Choose a cover image'}
		>
			{#if coverUrl}
				<img src={coverUrl} alt="" />
			{:else}
				<Icon name="image" class="w-5 h-5" strokeWidth={1.5} />
			{/if}
		</button>
		<div class="pi-cover-text">
			<span class="pi-cover-title">Cover</span>
			<p class="pi-cover-hint">
				The face of the preset, and the picture a PNG card is. Framed 3:4 portrait, anything
				else is centre-cropped to fit. A JSON export has nowhere to keep it.
			</p>
			{#if coverUrl}
				<button type="button" class="pi-cover-clear" disabled={busy} onclick={removeCover}>Remove</button>
			{/if}
		</div>
	</div>

	<div class="pi-grid">
		<div class="pi-field">
			<label for="preset-author" class="pi-label">Author</label>
			<input
				id="preset-author"
				type="text"
				value={meta?.author ?? ''}
				oninput={(e) => set('author', (e.target as HTMLInputElement).value)}
				placeholder="Your name or handle"
				class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm"
			/>
		</div>
		<div class="pi-field">
			<label for="preset-version" class="pi-label">Version</label>
			<input
				id="preset-version"
				type="text"
				value={meta?.version ?? ''}
				oninput={(e) => set('version', (e.target as HTMLInputElement).value)}
				placeholder="e.g. 2.1"
				class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm"
			/>
		</div>
	</div>

	<div class="pi-field">
		<label for="preset-description" class="pi-label">Description</label>
		<textarea
			id="preset-description"
			value={meta?.description ?? ''}
			oninput={(e) => set('description', (e.target as HTMLTextAreaElement).value)}
			use:autoResize={260}
			placeholder="The paragraph that opens Preset Controls. What it does, who it's for, what it expects."
			class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm resize-none"
		></textarea>
	</div>

	<div class="pi-field">
		<label for="preset-written-for" class="pi-label">Written against</label>
		<input
			id="preset-written-for"
			type="text"
			value={meta?.writtenFor ?? ''}
			oninput={(e) => set('writtenFor', (e.target as HTMLInputElement).value)}
			placeholder="e.g. Tuned on Claude Opus at 1.0 temperature, 32k context"
			class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm"
		/>
		<p class="pi-hint">
			The model and settings you actually tuned this on, so a reader knows what they are
			deviating from when their results differ.
		</p>
	</div>
</div>

<style>
	.pi {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.pi-cover-row {
		display: flex;
		align-items: flex-start;
		gap: 0.85rem;
	}

	/* Same 3:4 portrait the reader's page and the exported card use, so what an author
	   frames here is what everyone else sees. */
	.pi-cover {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 6rem;
		aspect-ratio: 3 / 4;
		padding: 0;
		overflow: hidden;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
		color: var(--color-text-muted);
		cursor: pointer;
		transition: border-color 140ms ease, color 140ms ease;
	}

	.pi-cover:hover:not(:disabled) {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.pi-cover.has-art {
		border-style: solid;
		border-color: var(--color-border-subtle);
	}

	.pi-cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.pi-cover:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.pi-cover-text {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.pi-cover-title {
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.pi-cover-hint,
	.pi-hint {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	.pi-cover-clear {
		align-self: flex-start;
		margin-top: 0.15rem;
		padding: 0;
		border: 0;
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-muted);
		text-decoration: underline;
		text-underline-offset: 0.18em;
		cursor: pointer;
	}

	.pi-cover-clear:hover {
		color: var(--color-error);
	}

	.pi-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.75rem;
	}

	@container builder (min-width: 430px) {
		.pi-grid {
			grid-template-columns: 1fr 1fr;
		}
	}

	.pi-field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}

	.pi-label {
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}
</style>
