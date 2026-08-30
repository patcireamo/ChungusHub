<script lang="ts">
	/**
	 * The star beside a setting that has left the value it would otherwise inherit, and
	 * nothing at all while it matches. The ONE way the app marks this, so an inherited value
	 * reads the same in the lorebook and in steering.
	 *
	 * **It reads the difference, not the storage.** A field typed back to the inherited value
	 * is not a change, however it is stored, and a mark insisting otherwise sends the reader
	 * hunting for a difference that isn't on screen. Callers pass the comparison, never
	 * `value !== null`.
	 *
	 * One state, no chrome: a row that follows the defaults says nothing, which is what
	 * following them looks like. The star doubles as the way back, so the value that took the
	 * detour carries its own undo instead of leaving the reader to guess at one (empty this
	 * field, pick the option named "inherit" out of that list).
	 *
	 * **Without `onRevert` it is a mark and not a control**, for the row that is itself a
	 * button: a second interactive thing inside one hit target is a mis-tap that silently
	 * changes a setting, and a row whose whole job is to open a list already carries the way
	 * back as the first item in it.
	 */
	interface Props {
		/** The value in force differs from the one this row would inherit. */
		overridden: boolean;
		/** Drop what this level stores so the row follows the default again. Omit where the
		 *  row cannot carry its own undo. */
		onRevert?: () => void;
		/** What the star means here, when "the default" is not the phrase for it. */
		label?: string;
	}

	let { overridden, onRevert, label }: Props = $props();

	let text = $derived(label ?? 'Changed from the default');
</script>

{#if overridden}
	{#if onRevert}
		<button
			type="button"
			class="ovr"
			onclick={onRevert}
			aria-label="Restore the default value"
			title="{text}, click to put it back"
		>*</button>
	{:else}
		<!-- role=img so the glyph is announced as what it means rather than as an asterisk. -->
		<span class="ovr ovr--static" role="img" aria-label={text} title={text}>*</span>
	{/if}
{/if}

<style>
	.ovr {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		align-self: center;
		width: 0.75rem;
		font-family: var(--font-ui);
		font-size: 1rem;
		line-height: 1;
		color: var(--color-accent);
		cursor: pointer;
		/* The glyph sits at the top of its em box, so it needs pushing onto the row's line. */
		transform: translateY(0.2em);
		transition: opacity 130ms ease;
	}

	.ovr:hover {
		opacity: 0.65;
	}

	.ovr--static {
		cursor: inherit;
	}
</style>
