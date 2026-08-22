<script lang="ts">
	/**
	 * A checkbox whose state is a count rather than a boolean.
	 *
	 * Both facts are written straight onto the element instead of being bound, and each has its
	 * own reason. `indeterminate` is a DOM property with no attribute behind it, so nothing
	 * declarative reaches it. And `checked` has to be written even when it computes to the value
	 * it already had: clicking a partly-on box flips the element's own `checked` to false, and a
	 * binding that sees no change of its own leaves that flip standing.
	 *
	 * Clicking a partly-on box turns it fully ON. That is the conventional answer and the
	 * opposite of what the native toggle does, which is the whole reason the click is read off
	 * the count here rather than off the element.
	 */
	interface Props {
		/** How many of `total` are switched on. */
		chosen: number;
		total: number;
		label: string;
		onchange: (on: boolean) => void;
	}

	let { chosen, total, label, onchange }: Props = $props();

	let el: HTMLInputElement | null = $state(null);

	$effect(() => {
		if (!el) return;
		el.checked = chosen > 0;
		el.indeterminate = chosen > 0 && chosen < total;
	});
</script>

<input
	bind:this={el}
	type="checkbox"
	class="tick"
	aria-label={label}
	onchange={() => onchange(chosen < total)}
/>

<style>
	.tick {
		flex-shrink: 0;
		accent-color: var(--color-accent);
		cursor: pointer;
	}
</style>
