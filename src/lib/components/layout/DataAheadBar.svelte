<script module lang="ts">
	/**
	 * The standing channel's first rung (architecture/ui-shell-settings.md): this workspace was
	 * last written by a newer ChungusHub than the one now serving it.
	 *
	 * It sits above the connection row because an outage stops writes, which is the safe
	 * failure, while this one lets every write through into a shape this build was never
	 * written against. It is also the only condition on the channel that cannot resolve on its
	 * own: nothing the reader does inside the app clears it, and nothing here pretends
	 * otherwise by offering a control.
	 *
	 * A module-level flag rather than a store, the WelcomeDialog pattern: the fact arrives once
	 * with the boot config and never changes while the page is up.
	 */
	let ahead = $state(false);

	export function setDataAhead(value: boolean): void {
		ahead = value;
	}
</script>

<script lang="ts">
	import { slide } from 'svelte/transition';
	import Icon from '$lib/components/ui/Icon.svelte';
</script>

{#if ahead}
	<div class="ahead-bar font-ui" role="status" transition:slide={{ duration: 180 }}>
		<Icon name="warning" class="w-4 h-4 shrink-0" strokeWidth={1.75} />
		<span>This data was last used by a newer ChungusHub. Writing with this older one can damage it.</span>
		<span class="ahead-fix">Update this copy.</span>
	</div>
{/if}

<style>
	.ahead-bar {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.4rem 0.75rem;
		background: color-mix(in srgb, var(--color-warning) 16%, var(--color-bg-secondary));
		border-bottom: 1px solid color-mix(in srgb, var(--color-warning) 40%, transparent);
		color: var(--color-warning);
		font-size: 0.76rem;
		font-weight: 600;
		line-height: 1.3;
		text-align: center;
	}

	.ahead-fix {
		flex-shrink: 0;
		color: color-mix(in srgb, var(--color-warning) 70%, var(--color-text-muted));
		font-weight: 500;
	}

	/* Narrow screens keep the condition and drop the instruction beside it. */
	@media (max-width: 560px) {
		.ahead-fix {
			display: none;
		}
	}
</style>
