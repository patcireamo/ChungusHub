<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import { imageService } from '$lib/services/imageService';
	import { portraitFocusStyle } from '$lib/utils/portrait-focus';
	import type { LibraryEntry } from '$lib/types/library';

	interface Props {
		entry: LibraryEntry;
		/** What this entry is to the open chat: "In this chat" for the character it plays,
		 *  "Playing as" for the persona, which is the composer chip's own word for it. */
		label: string;
		onOpen: (id: string) => void;
	}

	let { entry, label, onOpen }: Props = $props();

	let name = $derived(
		entry.identity.name?.trim() ||
			(entry.type === 'character' ? 'Unnamed Character' : 'Unnamed Persona')
	);
	let face = $derived(imageService.thumbnailUrl(entry.identity.imageUrl));
</script>

<button
	type="button"
	class="brw-now"
	onclick={() => onOpen(entry.id)}
	aria-label="Open {name} in the Library editor"
	title="Open this {entry.type} in the Library editor"
>
	<span class="brw-now-face">
		{#if face}
			<img src={face} alt="" style={portraitFocusStyle(entry.identity.portraitFocus)} />
		{:else}
			<Icon name="user" class="w-4 h-4" strokeWidth={1.25} />
		{/if}
	</span>
	<span class="brw-now-text">
		<span class="brw-now-label">{label}</span>
		<span class="brw-now-name">{name}</span>
	</span>
	<Icon name="pencil" class="w-4 h-4 shrink-0" />
</button>
