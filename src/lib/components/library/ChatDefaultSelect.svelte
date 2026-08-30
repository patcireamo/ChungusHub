<script lang="ts">
	/**
	 * The picker for one New Chat Defaults row.
	 *
	 * A native `<select>` draws every option alike, and an install genuinely has a connection
	 * called Default, so the app's own answer sat in the list looking like one more thing
	 * somebody had made. Here that answer is a row of its own above the rule, and it names
	 * what it currently resolves to, which no row from the library can do.
	 *
	 * Same shape as the model picker on the Connections page (`settings/ModelPicker.svelte`):
	 * a trigger wearing the input recipe, a floating list, hover and highlight tracked
	 * together so the pointer and the keyboard never disagree about which row is next.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';

	interface Option {
		id: string;
		name: string;
	}

	interface Props {
		id: string;
		/** The stored seed, or null while this row follows the app. */
		value: string | null;
		/** What the app's own answer is called here ("Default", "Global"). */
		fallbackLabel: string;
		/** What that answer resolves to right now, or null when it resolves to nobody. */
		fallbackDetail: string | null;
		/** Heading over the rows that come from the library. */
		groupLabel: string;
		options: Option[];
		/** Set when `value` names something that no longer exists. */
		lost: boolean;
		onpick: (id: string | null) => void;
	}

	let { id, value, fallbackLabel, fallbackDetail, groupLabel, options, lost, onpick }: Props =
		$props();

	let open = $state(false);
	let highlighted = $state(0);
	let rootEl = $state<HTMLDivElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);

	let picked = $derived(options.find((option) => option.id === value) ?? null);
	let triggerText = $derived(lost ? 'No longer here' : (picked?.name ?? fallbackLabel));
	/** The app's answer first, then the library's rows: one list for the keyboard, in the
	 *  order they are drawn. A lost seed is not in it, since it is already the value. */
	let navigable = $derived<(string | null)[]>([null, ...options.map((option) => option.id)]);

	function toggle() {
		if (open) {
			open = false;
			return;
		}
		highlighted = Math.max(
			0,
			navigable.findIndex((candidate) => candidate === value)
		);
		open = true;
	}

	function choose(next: string | null) {
		open = false;
		if (next !== value) onpick(next);
	}

	function scrollHighlightedIntoView() {
		listEl
			?.querySelector(`[data-index="${highlighted}"]`)
			?.scrollIntoView({ block: 'nearest' });
	}

	$effect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (rootEl && !rootEl.contains(event.target as Node)) open = false;
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	});

	// On `window` rather than the trigger: a button is not focused by a click everywhere, and
	// a menu that answers the arrow keys only after a keyboard-opened press is a menu that
	// half works. Escape is consumed either way, per the shell Esc contract
	// (architecture/ui-shell-settings.md).
	$effect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				open = false;
			} else if (event.key === 'ArrowDown') {
				event.preventDefault();
				highlighted = Math.min(highlighted + 1, navigable.length - 1);
				scrollHighlightedIntoView();
			} else if (event.key === 'ArrowUp') {
				event.preventDefault();
				highlighted = Math.max(highlighted - 1, 0);
				scrollHighlightedIntoView();
			} else if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				choose(navigable[highlighted] ?? null);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div class="picker" bind:this={rootEl}>
	<button
		type="button"
		{id}
		class="input-base trigger"
		class:is-open={open}
		class:is-lost={lost}
		onclick={toggle}
		aria-haspopup="listbox"
		aria-expanded={open}
	>
		<span class="trigger-label">{triggerText}</span>
		<Icon name="chevronDown" class="trigger-chevron" />
	</button>

	{#if open}
		<div class="menu" role="listbox">
			<!-- The app's answer, apart from the list and naming what it resolves to: the one
			     row here that is not a thing anybody made. -->
			<button
				type="button"
				role="option"
				aria-selected={value === null}
				class="row app-row"
				class:is-picked={value === null}
				class:is-highlighted={highlighted === 0}
				data-index="0"
				onmouseenter={() => (highlighted = 0)}
				onclick={() => choose(null)}
			>
				<span class="check" class:is-visible={value === null}>
					<Icon name="check" class="w-3.5 h-3.5" />
				</span>
				<span class="app-main">
					<span class="row-name">{fallbackLabel}</span>
					{#if fallbackDetail}<span class="app-detail">{fallbackDetail}</span>{/if}
				</span>
			</button>

			{#if lost}
				<!-- Inert: this IS the stored value, and it names nothing to switch to. -->
				<div class="row is-inert">
					<span class="check is-visible"><Icon name="check" class="w-3.5 h-3.5" /></span>
					<span class="row-name">No longer here</span>
				</div>
			{/if}

			<p class="group-label">{groupLabel}</p>

			<div class="list" bind:this={listEl}>
				{#if options.length === 0}
					<p class="empty">Nothing here yet</p>
				{:else}
					{#each options as option, index (option.id)}
						<button
							type="button"
							role="option"
							aria-selected={option.id === value}
							class="row"
							class:is-picked={option.id === value}
							class:is-highlighted={highlighted === index + 1}
							data-index={index + 1}
							onmouseenter={() => (highlighted = index + 1)}
							onclick={() => choose(option.id)}
						>
							<span class="check" class:is-visible={option.id === value}>
								<Icon name="check" class="w-3.5 h-3.5" />
							</span>
							<span class="row-name">{option.name}</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.picker {
		position: relative;
	}

	/* The trigger wears the input recipe at the same measure the row's other controls do, so
	   the panel reads as a form and not as three different kinds of control. */
	.trigger {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.65rem;
		font-family: var(--font-ui);
		font-size: 0.8125rem;
		color: var(--color-text-primary);
		text-align: left;
		cursor: pointer;
	}

	.trigger.is-open {
		border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
	}

	.trigger.is-lost .trigger-label {
		color: var(--color-warning);
	}

	.trigger-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trigger :global(.trigger-chevron) {
		width: 0.9rem;
		height: 0.9rem;
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	/* Fully opaque (`--color-bg-solid`) rather than the float recipe, the same exception
	   MockupTip takes: this list opens over the portrait and the card text, and a name read
	   through them is a name misread. */
	.menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		padding: 0.25rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-solid);
		box-shadow: var(--shadow-md);
		z-index: 50;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		padding: 0.35rem 0.5rem;
		border: 0;
		border-radius: calc(var(--radius-md) - 2px);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.78rem;
		text-align: left;
		cursor: pointer;
		transition: background 80ms ease;
	}

	.row.is-highlighted {
		background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
	}

	.row.is-picked {
		color: var(--color-text-primary);
	}

	.row.is-inert {
		color: var(--color-warning);
		cursor: default;
	}

	/* Above the rule and away from the group under it: the separation is what says this row
	   is not one of them. */
	.app-row {
		align-items: flex-start;
		padding-bottom: 0.45rem;
		margin-bottom: 0.25rem;
		border-bottom: 1px solid color-mix(in srgb, var(--color-border-subtle) 60%, transparent);
		border-radius: 0;
	}

	.app-main {
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		min-width: 0;
	}

	/* What the app is answering with right now. A row from the library can never carry this,
	   which is the whole point of drawing it. */
	.app-detail {
		font-size: 0.68rem;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.check {
		width: 0.9rem;
		flex-shrink: 0;
		display: inline-flex;
		color: var(--color-accent);
		visibility: hidden;
	}

	.check.is-visible {
		visibility: visible;
	}

	.row-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.group-label {
		padding: 0.15rem 0.5rem 0.2rem;
		font-family: var(--font-ui);
		font-size: 0.64rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
	}

	.list {
		max-height: 13rem;
		overflow-y: auto;
	}

	.empty {
		padding: 0.35rem 0.5rem;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		color: var(--color-text-muted);
	}
</style>
