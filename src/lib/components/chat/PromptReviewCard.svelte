<script lang="ts">
	/**
	 * One message of a held request, open for editing.
	 *
	 * A deliberate sibling of the debug panel's `PromptMessageCard` rather than a mode of it:
	 * that card's whole contract is showing what a request WAS, and this one changes what a
	 * request will be. They share a visual language (the role's colour down the left edge, the
	 * size on the right) so the two read as one family, and nothing else.
	 *
	 * Editing changes what a message SAYS. Everything structural (adding one, reordering,
	 * changing a role) belongs to the JSON view, which is the whole request rather than a
	 * message at a time. Attachments are shown and not editable here for the same reason: a
	 * file path is not prose.
	 *
	 * Folding is CONTROLLED by the panel, so its expand-all control and this chevron can never
	 * disagree about whether a card is open.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import { autoResize } from '$lib/actions/autoResize';
	import { imageService } from '$lib/services/imageService';
	import { roleColor } from '$lib/debug/format';
	import type { LLMMessage } from '$lib/types/llm';

	interface Props {
		message: LLMMessage;
		/** Position in the request, as the JSON view numbers it. */
		index: number;
		/** This message's size, already calibrated: the panel counts every card in one pass. */
		tokens: number;
		collapsed: boolean;
		edited: boolean;
		onToggle: () => void;
		onEdit: (content: string) => void;
		onRemove: () => void;
	}

	let { message, index, tokens, collapsed, edited, onToggle, onEdit, onRemove }: Props = $props();

	let color = $derived(roleColor(message.role));
	let lineCount = $derived(message.content ? message.content.split('\n').length : 0);
	let images = $derived(message.images ?? []);

	/** A thumbnail that fails to load means the PREVIEW is gone, not the attachment: the path
	 *  in this message is what rides the request. Say that rather than leave a broken tile. */
	let previewFailed = $state<string[]>([]);

	function fileName(path: string): string {
		return path.slice(path.lastIndexOf('/') + 1);
	}
</script>

<div class="msg" class:msg--edited={edited} style={`--role-color: ${color}`}>
	<div class="head">
		<button class="toggle" type="button" onclick={onToggle} aria-expanded={!collapsed}>
			<Icon name={collapsed ? 'chevronRight' : 'chevronDown'} class="w-3 h-3 shrink-0" strokeWidth={2.25} />
			<span class="role">{message.role}</span>
			<span class="num">#{index + 1}</span>
			{#if images.length}
				<span class="img-chip" title={`${images.length} attachment(s) on this message`}>
					<Icon name="image" class="w-3 h-3 shrink-0" strokeWidth={1.75} />
					{images.length}
				</span>
			{/if}
			{#if edited}<span class="edited">edited</span>{/if}
			<span class="meta">{lineCount.toLocaleString()} ln · ~{tokens.toLocaleString()} tok</span>
		</button>
		<button
			class="drop"
			type="button"
			onclick={onRemove}
			title="Leave this message out of the request"
			aria-label={`Leave message ${index + 1} out of the request`}
		>
			<Icon name="trash" class="w-3.5 h-3.5" />
		</button>
	</div>

	{#if !collapsed}
		{#if images.length}
			<div class="images">
				{#each images as path (path)}
					<div class="shot" title={path}>
						{#if previewFailed.includes(path)}
							<span class="shot-fallback"><Icon name="image" class="w-4 h-4" strokeWidth={1.5} /></span>
						{:else}
							<img
								src={imageService.thumbnailUrl(path)}
								alt=""
								loading="lazy"
								onerror={() => (previewFailed = [...previewFailed, path])}
							/>
						{/if}
						<span class="shot-name">{fileName(path)}</span>
						{#if previewFailed.includes(path)}<span class="shot-note">preview unavailable</span>{/if}
					</div>
				{/each}
			</div>
		{/if}

		<textarea
			class="body"
			value={message.content}
			spellcheck="false"
			aria-label={`Message ${index + 1}, ${message.role}`}
			oninput={(e) => onEdit(e.currentTarget.value)}
			use:autoResize={{ maxHeight: 520, value: message.content }}
		></textarea>
	{/if}
</div>

<style>
	.msg {
		border-left: 2px solid var(--role-color);
		border-bottom: 1px solid var(--color-border-subtle);
		min-width: 0;
	}

	/* The one card in a long list the reader changed has to be findable without reading it. */
	.msg--edited {
		background: color-mix(in srgb, var(--color-accent) 5%, transparent);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding-right: 0.35rem;
	}

	.toggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.32rem 0.5rem;
		border: 0;
		background: transparent;
		cursor: pointer;
		text-align: left;
		color: var(--color-text-muted);
		transition: background-color 110ms ease;
	}

	.toggle:hover {
		background: color-mix(in srgb, var(--role-color) 8%, transparent);
	}

	.role {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-weight: 700;
		font-size: 0.66rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--role-color);
	}

	.num {
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: 0.64rem;
		color: var(--color-text-muted);
		opacity: 0.7;
	}

	.img-chip {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.64rem;
		color: var(--role-color);
	}

	.edited {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.6rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-accent);
	}

	.meta {
		margin-left: auto;
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: 0.64rem;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.drop {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.65rem;
		height: 1.65rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-muted);
		opacity: 0.55;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
	}

	.drop:hover {
		opacity: 1;
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
		color: var(--color-error);
	}

	.images {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		padding: 0.15rem 0.6rem 0.5rem 0.95rem;
	}

	.shot {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		width: 7rem;
		padding: 0.3rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-tertiary) 35%, transparent);
	}

	.shot img,
	.shot-fallback {
		width: 100%;
		height: 4.5rem;
		border-radius: calc(var(--radius-sm) - 0.2rem);
		object-fit: cover;
		background: color-mix(in srgb, var(--color-bg-secondary) 70%, transparent);
	}

	.shot-fallback {
		display: grid;
		place-items: center;
		color: var(--color-text-muted);
	}

	.shot-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, monospace);
		font-size: 0.6rem;
		color: var(--color-text-secondary);
	}

	.shot-note {
		font-family: var(--font-ui);
		font-size: 0.58rem;
		color: var(--color-warning);
	}

	/* The editor sits where the debug panel's <pre> sits, in the same mono voice: this is the
	   text as the model receives it, not prose being written. */
	.body {
		display: block;
		width: calc(100% - 1.55rem);
		margin: 0 0.6rem 0.55rem 0.95rem;
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-tertiary) 30%, transparent);
		font-family: var(--font-mono, monospace);
		font-size: 0.76rem;
		line-height: 1.55;
		color: var(--color-text-primary);
		overflow-wrap: anywhere;
	}

	.body:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border));
	}

	@media (pointer: coarse) {
		.drop {
			width: 2.3rem;
			height: 2.3rem;
			opacity: 1;
		}
	}
</style>
