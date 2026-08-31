<script lang="ts">
	/**
	 * The open book's foot, wearing the shape the two library editors wear (`.editor-stats`,
	 * app.css): what this book holds, counted live off the book itself.
	 *
	 * **There is no prompt figure beside the token one, and there cannot be.** What a book
	 * injects is decided per turn by the scan, so the only honest number here is an upper
	 * bound: everything enabled firing at once. A real answer is what the Test scan strip is
	 * for, against text the reader supplies.
	 */
	import { countTokens } from '$lib/tokenizer';
	import { partitionEntries, type Lorebook } from '$lib/lorebook/types';

	let { book }: { book: Lorebook } = $props();

	let parts = $derived(partitionEntries(book.entries));

	/** The natures, spelled out only where the book holds more than one of them: "3 entries ·
	 *  3 keyword" says the same number twice. */
	let composition = $derived(
		[
			{ label: 'always active', count: parts.alwaysActive.length },
			{ label: 'keyword', count: parts.keyword.length },
			{ label: 'off', count: parts.disabled.length }
		].filter((part) => part.count > 0)
	);

	/** Every key that can wake something in here, primary and secondary alike, counted per
	 *  entry rather than deduped: two entries listening for one word are two ways in. */
	let keys = $derived(book.entries.reduce((n, e) => n + e.key.length + e.keysecondary.length, 0));

	let tokens = $derived(
		book.entries.reduce((n, e) => (e.disable ? n : n + countTokens(e.content)), 0)
	);

	function num(value: number): string {
		return value.toLocaleString();
	}
</script>

<div class="editor-stats">
	<span class="editor-stat">
		<b>{num(book.entries.length)}</b>
		{book.entries.length === 1 ? 'entry' : 'entries'}
	</span>
	{#if composition.length > 1}
		{#each composition as part (part.label)}
			<span class="editor-stat"><b>{num(part.count)}</b> {part.label}</span>
		{/each}
	{/if}
	{#if keys > 0}
		<span class="editor-stat"><b>{num(keys)}</b> {keys === 1 ? 'keyword' : 'keywords'}</span>
	{/if}
	<span
		class="editor-stat"
		title="Every enabled entry firing at once. What a turn really spends is decided by the scan."
	>
		<b>~{num(tokens)}</b> tokens
	</span>
</div>
