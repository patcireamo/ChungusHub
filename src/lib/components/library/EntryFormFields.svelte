<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { imageService, imageRejectionReason } from '$lib/services/imageService';
	import { toastStore } from '$lib/stores/toast.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import AlternateGreetingsModal from './AlternateGreetingsModal.svelte';
	import CharacterGallery from './CharacterGallery.svelte';
	import CharacterSprites from './CharacterSprites.svelte';
	import SpriteLabelDialog from './SpriteLabelDialog.svelte';
	import PortraitFramingDialog from './PortraitFramingDialog.svelte';
	import { portraitFocusStyle, type PortraitFocus } from '$lib/utils/portrait-focus';
	import { autoResize } from '$lib/actions/autoResize';
	import {
		PERMANENT_TRAITS,
		BLOB_MACRO,
		type CharacterSprite,
		type CharacterTraits,
		type TraitKey
	} from '$lib/types/library';
	import { presetService } from '$lib/services/presets.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import { spriteSortPref, SPRITE_SORT_OPTIONS } from '$lib/stores/spriteSort.svelte';
	import type { SpriteSort } from '$lib/utils/sprites';
	import { extractMacroNames } from '$lib/macros';

	interface Props {
		// Data
		name: string;
		imageUrl: string | undefined;
		/** Where every avatar box aims inside the portrait; undefined is the centred cover. */
		portraitFocus: PortraitFocus | undefined;
		tags: string[] | undefined;
		traits: CharacterTraits;
		/** Alternate opening messages (characters only). */
		alternateGreetings: string[] | undefined;
		/** Extra image paths shown in the gallery section. */
		gallery: string[] | undefined;
		/** The character's sprites: their own image set, shown in their own section. */
		sprites: CharacterSprite[] | undefined;
		defaultSprite: string | undefined;

		// Unique id for form element IDs
		entityId: string;

		/** Rendered at the foot of the identity pane: beside the portrait on wide screens, and
		 *  above the card's own fields when the grid stacks. A snippet rather than data, so
		 *  what goes there keeps its own state and its own store writes. */
		identityExtra?: Snippet;

		// Callbacks
		onFieldChange: (field: 'name', value: string) => void;
		onTraitChange: (traitKey: keyof CharacterTraits, value: string) => void;
		onImageSelect: (file: File) => Promise<void>;
		onImageRemove: () => Promise<void>;
		onPortraitFocusChange: (focus: PortraitFocus | null) => Promise<void>;
		onTagsChange: (tags: string[]) => void;
		onAlternateGreetingsChange: (greetings: string[]) => void;
		onGalleryAdd: (files: File[]) => Promise<void>;
		onGalleryRemove: (path: string) => Promise<void>;
		onSpritesAdd: (items: { file: File; label: string }[]) => Promise<void>;
		onSpriteLabel: (path: string, label: string) => Promise<void>;
		onSpriteDefault: (path: string) => Promise<void>;
		onSpriteRemove: (path: string) => Promise<void>;
	}

	let {
		name,
		imageUrl,
		portraitFocus,
		tags,
		traits,
		alternateGreetings,
		gallery,
		sprites,
		defaultSprite,
		entityId,
		identityExtra,
		onFieldChange,
		onTraitChange,
		onImageSelect,
		onImageRemove,
		onPortraitFocusChange,
		onTagsChange,
		onAlternateGreetingsChange,
		onGalleryAdd,
		onGalleryRemove,
		onSpritesAdd,
		onSpriteLabel,
		onSpriteDefault,
		onSpriteRemove
	}: Props = $props();

	// The rename dialog is mounted here, once, rather than per tile inside the grid: one dialog
	// for the whole list is one answer to what a legal label is.
	let labelling = $state<{ path: string; label: string } | null>(null);
	const takenLabels = $derived(
		(sprites ?? []).filter((s) => s.path !== labelling?.path).map((s) => s.label)
	);

	async function commitLabel(label: string) {
		const target = labelling;
		labelling = null;
		if (!target) return;
		try {
			await onSpriteLabel(target.path, label);
		} catch (error) {
			console.error('Renaming a sprite failed:', error);
			toastStore.failed('rename that sprite', error);
		}
	}

	// "Not sent to AI" is derived, never toggled: a field is sent when the active preset
	// references either the whole-sheet {{character}} blob or the field's own macro. The set
	// of macro names the active preset actually uses (enabled items only), recomputed
	// reactively as the preset or its draft changes.
	let referencedMacros = $derived.by(() => {
		const preset = presetService.getActiveEffectivePreset();
		const names = new Set<string>();
		for (const item of preset?.items ?? []) {
			if (item.enabled) for (const macro of extractMacroNames(item.content)) names.add(macro);
		}
		return names;
	});

	// This editor is character-only, so the blob is always {{character}}.
	let blobPresent = $derived(referencedMacros.has(BLOB_MACRO.character));

	/** A field isn't sent when neither its blob membership nor its own macro is in the preset. */
	function isNotSent(macro: string | undefined, ridesBlob: boolean): boolean {
		if (ridesBlob && blobPresent) return false;
		if (macro && referencedMacros.has(macro)) return false;
		return true;
	}

	// Alternate greetings manager (modal opened from the First Message field).
	let showGreetingsModal = $state(false);
	let greetings = $derived(alternateGreetings ?? []);
	let firstMessageValue = $derived(traits.firstMessage ?? '');

	// Swap an alternate greeting with the primary First Message.
	function makeFirstGreeting(index: number) {
		const old = firstMessageValue;
		const picked = greetings[index] ?? '';
		onTraitChange('firstMessage', picked);
		const next = [...greetings];
		next[index] = old;
		onAlternateGreetingsChange(next);
	}

	// Section collapse state. Four fixed sections: the primary card, the metadata details,
	// the gallery and the sprites. Card details defaults collapsed.
	let openSections = $state<Record<string, boolean>>({
		card: true,
		details: false,
		gallery: false,
		sprites: false
	});
	function toggleSection(id: string) {
		openSections = { ...openSections, [id]: !(openSections[id] ?? true) };
	}
	let cardOpen = $derived(openSections.card ?? true);
	let detailsOpen = $derived(openSections.details ?? false);
	let galleryOpen = $derived(openSections.gallery ?? false);
	let spritesOpen = $derived(openSections.sprites ?? false);
	// The order picker belongs to the open grid, and on a single sprite it would be a control
	// over nothing.
	let showSpriteSort = $derived(spritesOpen && (sprites?.length ?? 0) > 1);

	// Image handling state
	let fileInputRef = $state<HTMLInputElement | null>(null);
	let resolvedImageUrl = $state<string | null>(null);
	let imageLoading = $state(false);

	// Tags handling state
	let newTagInput = $state('');
	let showTagInput = $state(false);
	let tagInputRef = $state<HTMLInputElement | null>(null);
	let editingTagIndex = $state<number | null>(null);
	let editingTagValue = $state('');
	let editTagInputRef = $state<HTMLInputElement | null>(null);

	// Resolve image URL when imageUrl prop changes
	$effect(() => {
		if (imageUrl) {
			imageService.getImageUrl(imageUrl).then((url) => {
				resolvedImageUrl = url;
			});
		} else {
			resolvedImageUrl = null;
		}
	});

	// Placeholders for the permanent character-card fields.
	const namePlaceholder = 'Character name';
	const TRAIT_PLACEHOLDERS: Partial<Record<TraitKey, string>> = {
		description: 'Who they are: appearance, presence, how they carry themselves…',
		firstMessage: "The character's opening message that starts the scene…",
		creator: 'Who made this card…',
		creatorNotes: 'Notes on how to use this character…',
		personality: 'Core personality traits, how they interact with others…',
		scenario: 'The setting and situation the roleplay takes place in…',
		exampleDialogue: 'Sample exchanges that show how the character speaks…'
	};

	function getTraitPlaceholder(key: TraitKey, label: string): string {
		return TRAIT_PLACEHOLDERS[key] ?? `Describe ${label.toLowerCase()}…`;
	}

	// ---- Trait fields ----
	// The fixed character-card set: never renamed or deleted, only toggling AI-exclude.
	interface TraitField {
		key: TraitKey;
		label: string;
		value: string;
		placeholder: string;
		notSent: boolean;
		notSentTitle: string;
		seedsChat: boolean;
		/** Optional short helper line rendered under the field's textarea. */
		hint?: string;
	}

	// Only exampleDialogue gets a hint today. It teaches the SillyTavern-style <START> /
	// {{char}}: / {{user}}: convention the field's macro resolution expects.
	const TRAIT_HINTS: Partial<Record<TraitKey, string>> = {
		exampleDialogue:
			'Separate distinct example chats with <START>. Prefix lines with {{char}}: and {{user}}: to show who speaks.'
	};

	let permanentFields = $derived(
		PERMANENT_TRAITS.character.map(
			(def): TraitField => ({
				key: def.key,
				label: def.label,
				value: traits[def.key] ?? '',
				placeholder: getTraitPlaceholder(def.key, def.label),
				// A chat-seeding field (First Message) always reaches the AI via the opening
				// turn, so it's never flagged "not sent".
				notSent: def.seedsChat ? false : isNotSent(def.macro, !!def.inBlob),
				notSentTitle: buildNotSentTitle(def.macro, !!def.inBlob),
				seedsChat: !!def.seedsChat,
				hint: TRAIT_HINTS[def.key]
			})
		)
	);

	// Look up a permanent field by key so the template can place each one explicitly.
	let permanentByKey = $derived(new Map(permanentFields.map((f) => [f.key, f])));
	function pf(key: TraitKey): TraitField | undefined {
		return permanentByKey.get(key);
	}

	/** Human explanation for the read-only "Not sent to AI" badge, actionable where possible. */
	function buildNotSentTitle(macro: string | undefined, inBlob: boolean): string {
		if (!macro) return "Metadata: no preset macro places this field, so it's never sent to the AI.";
		const alt = inBlob ? ' or {{character}}' : '';
		return `Not sent to the AI. Add {{${macro}}}${alt} to the active preset to include it.`;
	}

	// Image handlers
	let showFraming = $state(false);

	function handleImageClick() {
		fileInputRef?.click();
	}

	function handleAdjustFraming(e: MouseEvent) {
		// The frame behind this button opens the file picker.
		e.stopPropagation();
		showFraming = true;
	}

	async function handleImageSelectInternal(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const refused = imageRejectionReason(file);
		if (refused) {
			toastStore.error(refused);
			input.value = '';
			return;
		}

		imageLoading = true;
		try {
			await onImageSelect(file);
		} catch (error) {
			console.error('Saving the entry image failed:', error);
			toastStore.failed(`save "${file.name}"`, error);
		} finally {
			imageLoading = false;
			input.value = '';
		}
	}

	async function handleRemoveImageInternal(e: Event) {
		e.stopPropagation();
		imageLoading = true;
		try {
			await onImageRemove();
		} finally {
			imageLoading = false;
		}
	}

	// Tags handlers
	function handleAddTag() {
		showTagInput = true;
		tick().then(() => {
			tagInputRef?.focus();
		});
	}

	function handleTagInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			submitTag();
		} else if (e.key === 'Escape') {
			// Consume the press so the workspace's global Esc doesn't also close
			// the hosting Library panel.
			e.preventDefault();
			e.stopPropagation();
			cancelTagInput();
		}
	}

	function submitTag() {
		const tag = newTagInput.trim();
		if (tag) {
			const currentTags = tags || [];
			if (!currentTags.includes(tag)) {
				onTagsChange([...currentTags, tag]);
			}
		}
		newTagInput = '';
		showTagInput = false;
	}

	function cancelTagInput() {
		newTagInput = '';
		showTagInput = false;
	}

	function removeTag(tag: string) {
		const currentTags = tags || [];
		onTagsChange(currentTags.filter((t) => t !== tag));
	}

	function startEditingTag(index: number) {
		const currentTags = tags || [];
		editingTagIndex = index;
		editingTagValue = currentTags[index];
		tick().then(() => {
			editTagInputRef?.focus();
			editTagInputRef?.select();
		});
	}

	function submitTagEdit() {
		if (editingTagIndex === null) return;
		const currentTags = [...(tags || [])];
		const trimmed = editingTagValue.trim();
		if (trimmed && trimmed !== currentTags[editingTagIndex]) {
			// Avoid duplicates
			if (!currentTags.includes(trimmed)) {
				currentTags[editingTagIndex] = trimmed;
				onTagsChange(currentTags);
			}
		}
		editingTagIndex = null;
		editingTagValue = '';
	}

	function cancelTagEdit() {
		editingTagIndex = null;
		editingTagValue = '';
	}

	function handleEditTagKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			submitTagEdit();
		} else if (e.key === 'Escape') {
			// Consume the press so the workspace's global Esc doesn't also close
			// the hosting Library panel.
			e.preventDefault();
			e.stopPropagation();
			cancelTagEdit();
		}
	}
</script>

<!-- Hidden file input -->
<input
	bind:this={fileInputRef}
	type="file"
	accept="image/*"
	class="hidden"
	onchange={handleImageSelectInternal}
/>

<!-- One always-open field card per permanent field. -->
{#snippet fieldCard(field: TraitField, headerExtra?: Snippet)}
	<div
		class="group/field rounded-[var(--radius-lg)] border border-border-subtle bg-bg-secondary/40 transition-colors hover:border-border"
	>
		<div class="flex items-center gap-2 px-3 pt-2.5 pb-1">
			<div class="flex-1 min-w-0 flex items-center gap-2">
				<span class="min-w-0 truncate text-sm font-ui font-medium text-text-primary">
					{field.label}
				</span>
				{@render headerExtra?.()}
			</div>

			{#if field.seedsChat}
				<span
					class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-ui font-medium rounded-[var(--radius-sm)] bg-accent/15 text-accent shrink-0"
					title="This becomes the chat's opening message, so it reaches the AI as context. It doesn't need a preset macro."
				>
					<Icon name="chat" class="w-3 h-3" />
					Opening message
				</span>
			{:else if field.notSent}
				<span
					class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-ui font-medium rounded-[var(--radius-sm)] bg-warning/15 text-warning shrink-0"
					title={field.notSentTitle}
				>
					<Icon name="eyeOff" class="w-3 h-3" />
					Not sent to AI
				</span>
			{/if}
		</div>
		<div class="px-3 pb-3 pt-1">
			<textarea
				use:autoResize={{ maxHeight: 220, value: field.value }}
				id="{field.key}-{entityId}"
				value={field.value}
				oninput={(e) => onTraitChange(field.key, (e.target as HTMLTextAreaElement).value)}
				placeholder={field.placeholder}
				class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm placeholder:text-text-muted resize-none min-h-[3rem] {field.notSent
					? 'opacity-60'
					: ''}"
			></textarea>
			{#if field.hint}
				<p class="mt-1.5 text-xs font-ui text-text-muted">{field.hint}</p>
			{/if}
		</div>
	</div>
{/snippet}

<!-- A collapsible section heading, styled like the accent "CHARACTER CARD" header. -->
{#snippet sectionHeading(
	id: string,
	label: string,
	icon: 'user' | 'bookOpen' | 'image',
	open: boolean,
	trailing?: Snippet
)}
	<!-- The trailing control sits OUTSIDE the collapse button: a control nested inside it would
	     be a button in a button, and every press would also fold the section away. -->
	<div class="flex items-center gap-2">
		<button
			type="button"
			class="flex-1 min-w-0 flex items-center gap-1.5 py-0.5 text-left"
			onclick={() => toggleSection(id)}
			aria-expanded={open}
		>
			<Icon
				name="chevronDown"
				class="w-3.5 h-3.5 shrink-0 text-accent transition-transform {open ? '' : '-rotate-90'}"
			/>
			<Icon name={icon} class="w-3.5 h-3.5 text-accent" />
			<span class="text-xs font-ui font-semibold uppercase tracking-wide text-accent">{label}</span>
			<span class="flex-1 border-t border-border-subtle/70 ml-1"></span>
		</button>
		{#if trailing}{@render trailing()}{/if}
	</div>
{/snippet}

<!-- Sits at the right of the Sprites heading. Display only: the stored list keeps the order the
     files arrived in, which is why upload order is one of the choices rather than a lost one. -->
{#snippet spriteSortControl()}
	<Select
		variant="compact"
		value={spriteSortPref.order}
		onchange={(e) => spriteSortPref.set(e.currentTarget.value as SpriteSort)}
		aria-label="Sort sprites"
	>
		{#each SPRITE_SORT_OPTIONS as option (option.id)}
			<option value={option.id}>{option.label}</option>
		{/each}
	</Select>
{/snippet}

<!-- Sits next to the First Message label; opens the alternate-greetings manager. -->
{#snippet greetingsButton()}
	<button
		type="button"
		class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-sm)] text-[11px] font-ui font-medium border border-border text-text-muted hover:text-accent hover:border-accent/50 transition-colors"
		onclick={() => (showGreetingsModal = true)}
		title="Manage alternate greetings"
	>
		<Icon name="chat" class="w-3 h-3" />
		Alternate greetings{greetings.length ? ` · ${greetings.length}` : ''}
	</button>
{/snippet}

<div class="grid grid-cols-1 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] gap-6 p-6">
	<!-- Identity pane: portrait + name/tags. Pinned alongside the scrolling fields on wide
	     screens (top offset matches the grid's own padding so it never drifts); stacks on top on
	     narrow ones. -->
	<div class="space-y-4 lg:sticky lg:top-6 lg:self-start">
		<!-- Portrait -->
		<div
			class="portrait-frame relative w-full max-w-[15rem] lg:max-w-none mx-auto lg:mx-0 aspect-[3/4] rounded-[var(--radius-lg)] overflow-hidden border border-border bg-bg-tertiary group/portrait cursor-pointer transition-all hover:border-accent hover:shadow-md"
			role="button"
			tabindex="0"
			onclick={handleImageClick}
			onkeydown={(e) => e.key === 'Enter' && handleImageClick()}
			aria-label="Change character image"
			aria-disabled={imageLoading}
		>
			{#if imageLoading}
				<div class="absolute inset-0 flex items-center justify-center bg-bg-tertiary">
					<Spinner size="md" />
				</div>
			{:else if resolvedImageUrl}
				<img
					src={resolvedImageUrl}
					alt={name || 'character'}
					class="w-full h-full object-cover"
					style={portraitFocusStyle(portraitFocus)}
				/>
				<div
					class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-0 group-hover/portrait:opacity-100 transition-opacity flex items-end justify-center pb-2.5"
				>
					<span class="text-white/90 text-xs font-ui">Change photo</span>
				</div>
				<button
					type="button"
					class="portrait-overlay-action absolute top-1.5 right-1.5 p-1 rounded-full bg-black/50 text-white/80 hover:bg-error hover:text-white"
					onclick={handleRemoveImageInternal}
					aria-label="Remove image"
				>
					<Icon name="close" class="w-3.5 h-3.5" />
				</button>
				<button
					type="button"
					class="portrait-overlay-action absolute bottom-1.5 right-1.5 p-1 rounded-full bg-black/50 text-white/80 hover:bg-black/75 hover:text-white"
					onclick={handleAdjustFraming}
					aria-label="Adjust framing"
					title="Adjust framing"
				>
					<Icon name="crop" class="w-3.5 h-3.5" />
				</button>
			{:else}
				<div
					class="w-full h-full flex flex-col items-center justify-center text-text-muted group-hover/portrait:text-accent transition-colors gap-1.5"
				>
					<Icon name="image" class="w-7 h-7" />
					<span class="text-xs font-ui">Add photo</span>
				</div>
			{/if}
		</div>

		<!-- Name -->
		<div>
			<label for="name-{entityId}" class="block text-sm font-ui font-medium text-text-primary mb-1.5">
				Name
			</label>
			<input
				id="name-{entityId}"
				type="text"
				value={name}
				oninput={(e) => onFieldChange('name', (e.target as HTMLInputElement).value)}
				placeholder={namePlaceholder}
				class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm placeholder:text-text-muted"
			/>
		</div>

		<!-- Tags -->
		<div>
			<span class="block text-sm font-ui font-medium text-text-primary mb-1.5">
				Tags
			</span>
			<div class="flex flex-wrap gap-2 items-center">
				{#each tags || [] as tag, i}
					{#if editingTagIndex === i}
						<input
							bind:this={editTagInputRef}
							type="text"
							bind:value={editingTagValue}
							onkeydown={handleEditTagKeydown}
							onblur={submitTagEdit}
							class="input-base px-2.5 py-1 text-sm font-ui"
							style="width: calc({Math.max(4, editingTagValue.length + 1)}ch + 1.5rem)"
						/>
					{:else}
						<span
							class="inline-flex items-center gap-1 px-2.5 py-1 text-sm font-ui rounded-[var(--radius-md)] bg-accent/10 text-accent"
						>
							<button type="button" onclick={() => startEditingTag(i)} class="hover:underline cursor-text">
								{tag}
							</button>
							<button
								type="button"
								onclick={() => removeTag(tag)}
								class="p-0.5 hover:bg-accent/20 rounded transition-colors"
								aria-label="Remove tag"
							>
								<Icon name="close" class="w-3 h-3" />
							</button>
						</span>
					{/if}
				{/each}
				{#if showTagInput}
					<input
						bind:this={tagInputRef}
						type="text"
						bind:value={newTagInput}
						onkeydown={handleTagInputKeydown}
						onblur={submitTag}
						placeholder="New tag…"
						class="input-base px-2.5 py-1 text-sm font-ui w-24"
					/>
				{:else}
					<Button
						variant="ghost"
						size="sm"
						class="!px-2.5 !py-1 !text-sm !border !border-dashed !border-border"
						onclick={handleAddTag}
					>
						<Icon name="plus" class="w-3.5 h-3.5" />
						Add tag
					</Button>
				{/if}
			</div>
		</div>

		{@render identityExtra?.()}
	</div>

	<!-- Fields pane: three fixed, collapsible categories. The rule between the panes is drawn
	     on this side and only once the grid is side by side; stacked, the panes follow each
	     other down the page and a line across the middle would read as a divider between the
	     tags and the card. -->
	<div class="min-w-0 space-y-5 lg:border-l lg:border-border-subtle lg:pl-6">
		<!-- Character Card: the essentials. -->
		<div class="space-y-3">
			{@render sectionHeading('card', 'Character Card', 'user', cardOpen)}
			{#if cardOpen}
				{@const description = pf('description')}
				{@const firstMessage = pf('firstMessage')}
				{#if description}{@render fieldCard(description)}{/if}
				{#if firstMessage}{@render fieldCard(firstMessage, greetingsButton)}{/if}
			{/if}
		</div>

		<!-- Card details: everything else, with the two short metadata fields side by side. -->
		<div class="space-y-3">
			{@render sectionHeading('details', 'Card details', 'bookOpen', detailsOpen)}
			{#if detailsOpen}
				{@const personality = pf('personality')}
				{@const scenario = pf('scenario')}
				{@const examples = pf('exampleDialogue')}
				{@const systemPrompt = pf('systemPrompt')}
				{@const postHistory = pf('postHistoryInstructions')}
				{@const characterVersion = pf('characterVersion')}
				{@const creator = pf('creator')}
				{@const creatorNotes = pf('creatorNotes')}
				{#if personality}{@render fieldCard(personality)}{/if}
				{#if scenario}{@render fieldCard(scenario)}{/if}
				{#if examples}{@render fieldCard(examples)}{/if}
				{#if systemPrompt}{@render fieldCard(systemPrompt)}{/if}
				{#if postHistory}{@render fieldCard(postHistory)}{/if}
				{#if creator || characterVersion}
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
						{#if creator}{@render fieldCard(creator)}{/if}
						{#if characterVersion}{@render fieldCard(characterVersion)}{/if}
					</div>
				{/if}
				{#if creatorNotes}{@render fieldCard(creatorNotes)}{/if}
			{/if}
		</div>

		<!-- Gallery: extra art tied to this character. -->
		<div class="space-y-3">
			{@render sectionHeading('gallery', 'Gallery', 'image', galleryOpen)}
			{#if galleryOpen}
				<CharacterGallery {gallery} onAdd={onGalleryAdd} onRemove={onGalleryRemove} />
			{/if}
		</div>

		<!-- Sprites: the pictures the engine picks between. Their own set, not gallery art. -->
		<div class="space-y-3">
			{@render sectionHeading(
				'sprites',
				'Sprites',
				'image',
				spritesOpen,
				showSpriteSort ? spriteSortControl : undefined
			)}
			{#if spritesOpen}
				<CharacterSprites
					{sprites}
					{defaultSprite}
					onAddFiles={onSpritesAdd}
					onEditLabel={(path, label) => (labelling = { path, label })}
					onRemove={onSpriteRemove}
					onSetDefault={onSpriteDefault}
				/>
			{/if}
		</div>
	</div>
</div>

<AlternateGreetingsModal
	open={showGreetingsModal}
	greetings={greetings}
	firstMessage={firstMessageValue}
	onChange={onAlternateGreetingsChange}
	onMakeFirst={makeFirstGreeting}
	onClose={() => (showGreetingsModal = false)}
/>

<SpriteLabelDialog
	open={labelling !== null}
	label={labelling?.label ?? ''}
	taken={takenLabels}
	onCommit={commitLabel}
	onCancel={() => (labelling = null)}
/>

{#if imageUrl}
	<PortraitFramingDialog
		open={showFraming}
		onSave={onPortraitFocusChange}
		imagePath={imageUrl}
		{name}
		focus={portraitFocus}
		onClose={() => (showFraming = false)}
	/>
{/if}
