<!--
  The Prompt Builder lives in the narrow Settings dock (~350–500px on wide screens,
  a chat-area overlay below the dock breakpoint), so the whole layout is driven by
  container queries against its own width (.pb, container-name: builder), never
  the viewport. Structure: a preset action row + save state on top,
  the prompt-item list as the primary surface, controls and the macro reference
  as quieter secondary sections below.
-->
<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import MockupTip from '$lib/components/mockups/MockupTip.svelte';
	import RawExpandedMockup from '$lib/components/mockups/RawExpandedMockup.svelte';
	import PruneEmptyBlocksMockup from '$lib/components/mockups/PruneEmptyBlocksMockup.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import MacroReference from '$lib/components/ui/MacroReference.svelte';
	import PresetManager from '$lib/components/presets/PresetManager.svelte';
	import ChatOverrideNotice from '$lib/components/ui/ChatOverrideNotice.svelte';
	import {
		chatLorebookClaim,
		chatMutedLorebookClaim,
		chatPersonaEntry,
		chatPreset,
		resolvePromptTarget,
		toPromptCharacter
	} from '$lib/utils/chat-setup';
	import { presetService } from '$lib/services/presets.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { presetControlsStore } from '$lib/stores/presetControls.svelte';
	import { regexRulesStore } from '$lib/stores/regex-rules.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { imageService } from '$lib/services/imageService';
	import { countTokens, tokenCalibration } from '$lib/tokenizer';
	import { cappedHistoryTurns, extractMacroNames, MACROS, SYSTEM_MACROS } from '$lib/macros';
	import {
		assemblePrompt,
		buildMacroContext,
		resolveItem,
		DEFAULT_CONTINUE_PROMPT,
		type AssembleInput
	} from '$lib/utils/prompt-assembly';
	import { memoryStore } from '$lib/memory/store.svelte';
	import { dragHandleZone, dragHandle, type DndEvent } from 'svelte-dnd-action';
	import { fade } from 'svelte/transition';
	import { untrack } from 'svelte';
	import { autoResize } from '$lib/actions/autoResize';
	import ControlEditor from './ControlEditor.svelte';
	import SectionEditor from './SectionEditor.svelte';
	import PresetIdentityEditor from './PresetIdentityEditor.svelte';
	import BundleListEditor from './BundleListEditor.svelte';
	import CarriedRegexEditor from './CarriedRegexEditor.svelte';
	import { isSectionIcon } from '$lib/config/section-icons';
	import { clonePreset } from '$lib/services/presets.svelte';
	import type {
		PromptPreset,
		PromptItem,
		PromptRole,
		PromptControl,
		PromptPresetBundle,
		PromptPresetMeta,
		PromptSection
	} from '$lib/types/database';
	import type { RegexRule } from '$lib/utils/regex-rules';

	/** Names a control may not reuse: every built-in macro, engine-resolved or flow-supplied. */
	const RESERVED_MACROS = new Set<string>(MACROS.map((m) => m.name));

	let currentPreset = $state<PromptPreset | null>(null);
	// Any number of rows can be open at once: each row toggles independently.
	let expandedItemIds = $state<Set<string>>(new Set());
	let expandedControlIds = $state<Set<string>>(new Set());
	let expandedSectionIds = $state<Set<string>>(new Set());
	let showExpandedTokens = $state(false);

	/** Immutable Set toggle so $state sees the change. */
	function toggledSet(set: Set<string>, id: string): Set<string> {
		const next = new Set(set);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return next;
	}

	// Dirty = a draft exists. Never tracked by hand: the service only keeps a draft
	// while its content materially differs from the committed preset, so this can't
	// drift into phantom "unsaved changes" no matter which code path saved it.
	let isDirty = $derived(currentPreset ? presetService.hasDraft(currentPreset.id) : false);

	// Transient "saved" confirmation, shown briefly after a save, then fades out.
	let justSaved = $state(false);
	let savedTimeout: ReturnType<typeof setTimeout> | null = null;

	function flashSaved(): void {
		justSaved = true;
		if (savedTimeout) clearTimeout(savedTimeout);
		savedTimeout = setTimeout(() => (justSaved = false), 2000);
	}

	// The editor works on its own copy so the committed preset stays untouched until save.
	// It is the service's own clone: the per-preset field list lives in exactly one place,
	// so a new field can't survive Save here and then vanish on the next unrelated edit.
	const cloneForEdit = clonePreset;

	// The active chat's bound character, for expanded token counting.
	let activeCharacterEntry = $derived.by(() => {
		const cid = chatStore.activeChat?.characterId;
		if (!cid) return null;
		return characterLibraryStore.entries.find((e) => e.id === cid && e.type === 'character') ?? null;
	});

	// The variant that chat plays against, not the library's active one: the numbers
	// here claim to match what is actually sent, so they resolve the pin like the
	// generation path and the composer meter do.
	let activeCharacterData = $derived(
		activeCharacterEntry
			? characterLibraryStore.dataForVersion(
					activeCharacterEntry,
					chatStore.activeChat?.characterVersionId ?? null
				)
			: null
	);

	// Token accounting runs through the SAME assembly primitives the real prompt and the chat
	// input meter use (buildMacroContext / resolveItem / assemblePrompt), so the numbers here
	// match what is actually sent for the active chat: memory recall, chat history and
	// auto-lorebook all included, instead of a separate approximation that drifts. The
	// connection those numbers are counted in comes from the same resolver too.
	let promptTarget = $derived(resolvePromptTarget(chatStore.activeChat));
	let chatPersona = $derived(chatPersonaEntry(chatStore.activeChat));
	let assembleInput = $derived<AssembleInput>({
		preset: currentPreset,
		resolvedPersona: toPromptCharacter(chatPersona),
		resolvedCharacters: activeCharacterEntry && activeCharacterData
			? [
					{
						name: activeCharacterEntry.identity.name,
						traits: activeCharacterData.traits
					}
				]
			: [],
		lorebooks: lorebookStore.booksForChat({
			cards: [...(activeCharacterData?.lorebookIds ?? []), ...(chatPersona?.data.lorebookIds ?? [])],
			chat: chatLorebookClaim(chatStore.activeChat),
			muted: chatMutedLorebookClaim(chatStore.activeChat)
		}),
		lorebookSettings: lorebookSettingsStore.settings,
		controls: currentPreset?.controls ?? [],
		customFields: presetControlsStore.valuesFor(currentPreset?.id ?? null),
		chatMessages: chatStore.currentChatState?.activePath ?? [],
		recall: { text: memoryStore.recall || null, archivedIds: memoryStore.archivedMessageIds },
		model: promptTarget.model,
		postProcessing: promptTarget.postProcessing,
		contextBudget: promptTarget.contextBudget,
		regexRules: regexRulesStore.effectiveFor(currentPreset)
	});
	let macroContext = $derived(buildMacroContext(assembleInput));
	let activeModel = $derived(promptTarget.model);

	// Offered to the carried-rule tester as a one-click sample: a rule that styles the
	// model's own panels is only really testable against the model's own output.
	let lastReply = $derived(
		[...(chatStore.currentChatState?.activePath ?? [])]
			.reverse()
			.find((m) => m.role === 'assistant' && m.content.trim())?.content
	);

	// Per-item breakdown: { total, macroTokens } where macroTokens is the extra brought in by
	// macro/structural resolution (context + injected chat). "Raw" is the plain authored-text
	// size; "Expanded" predicts the real sent size, so it carries the model's calibration,
	// keeping the Expanded total in lockstep with the chat input box for the same chat.
	function getItemTokenBreakdown(item: PromptItem): { total: number; macroTokens: number } {
		const raw = countTokens(item.content, activeModel);
		if (!showExpandedTokens) return { total: raw, macroTokens: 0 };
		const r = resolveItem(item, macroContext, activeModel);
		const ratio = tokenCalibration.ratioFor(activeModel);
		const resolved = Math.round((r.preset + r.context + r.memory + r.chat) * ratio);
		return { total: resolved, macroTokens: Math.max(0, resolved - Math.round(raw * ratio)) };
	}

	// Enabled-item total. In expanded mode it comes straight from the shared assembler (then
	// calibrated), so it equals what the chat input box reports; raw mode is plain text.
	let expandedAssembly = $derived(currentPreset && showExpandedTokens ? assemblePrompt(assembleInput) : null);

	let totalEnabledTokens = $derived.by(() => {
		if (!currentPreset) return 0;
		if (expandedAssembly) {
			return Math.round(expandedAssembly.breakdown.total * tokenCalibration.ratioFor(activeModel));
		}
		return currentPreset.items.filter((item) => item.enabled).reduce((sum, item) => sum + countTokens(item.content, activeModel), 0);
	});

	// The trim is why the per-item numbers can add up to more than the total: each row prices
	// what its item resolves to, and the total prices what actually fits the context size.
	// Without saying so the two just silently disagree, and a trim drops live turns that no
	// summary covers, which is the one way story text leaves the prompt with nothing recalling it.
	let trimmedMessages = $derived(expandedAssembly?.trimmedMessages ?? 0);
	let overBudget = $derived(expandedAssembly?.overBudget ?? false);

	// Lint: the macros an item may safely reference are the system macros plus this
	// preset's control macros. Anything else leaks into the prompt as literal {{xyz}}.
	let providedMacros = $derived.by(() => {
		const set = new Set<string>(SYSTEM_MACROS);
		for (const control of currentPreset?.controls ?? []) {
			const macro = control.macro.trim();
			if (macro) set.add(macro);
		}
		return set;
	});

	// The parameterized history macro is a shape, not a name: {{chatHistoryLast20}} is never in
	// the set but resolves, and the placeholder {{chatHistoryLastN}} is a name nothing provides.
	// Ask the same parser resolution asks, or the lint warns on the spelling that works and
	// stays quiet on the one that ships a literal to the model.
	function unboundMacrosFor(content: string): string[] {
		return extractMacroNames(content).filter(
			(name) => cappedHistoryTurns(name) === undefined && !providedMacros.has(name)
		);
	}

	let itemsWithUnboundMacros = $derived(
		currentPreset?.items.filter((item) => unboundMacrosFor(item.content).length > 0).length ?? 0
	);

	// The preset the open chat is built from, when that is not the one on this page. Editing
	// here then reaches every chat that follows the app and not the story on screen, and the
	// meter above prices this preset rather than the one that story sends.
	let storyPreset = $derived.by(() => {
		const running = chatPreset(chatStore.activeChat);
		return running && running.id !== currentPreset?.id ? running : null;
	});

	// The active preset can change outside the builder too (sync from another device,
	// the service's first-boot seeding). Reload the editor whenever it does.
	let externalPresetId = $derived(presetService.getActivePresetId());
	let externalContentVersion = $derived(presetService.getContentVersion());

	$effect(() => {
		externalContentVersion;
		if (!externalPresetId) {
			currentPreset = null;
			return;
		}
		const preset = untrack(() => presetService.getEffective(externalPresetId));
		if (preset) {
			const changedPreset = externalPresetId !== untrack(() => currentPreset?.id);
			currentPreset = cloneForEdit(preset);
			if (changedPreset) {
				expandedItemIds = new Set();
				expandedControlIds = new Set();
				expandedSectionIds = new Set();
			}
		}
	});

	// Drag & drop config
	const flipDurationMs = 200;

	// Role display helpers
	const roleColors: Record<PromptRole, string> = {
		system: 'bg-blue-500/20 text-blue-400',
		user: 'bg-green-500/20 text-green-400',
		assistant: 'bg-purple-500/20 text-purple-400'
	};

	const roleLabels: Record<PromptRole, string> = {
		system: 'System',
		user: 'User',
		assistant: 'Assistant'
	};

	// Make sure presets are loaded; the guard inside initialize() makes re-runs free.
	// The editor copy itself arrives reactively through the effect above once the
	// service publishes the active id, with no manual seeding here.
	$effect(() => {
		presetService.initialize();
	});

	/** Every edit lands in the preset's draft: the committed file is untouched until
	 *  Save. The service compares content itself: edits that end up matching the
	 *  committed preset drop the draft (and the dirty state) instead of keeping it. */
	async function persistDraft(): Promise<void> {
		if (!currentPreset) return;
		await presetService.saveDraft(currentPreset);
	}

	// In-app replacement for native confirm(), which renders browser chrome.
	let confirmState = $state<{ title: string; message: string; confirmLabel: string; variant: 'danger' | 'default'; resolve: (ok: boolean) => void } | null>(null);

	function askConfirm(opts: { title?: string; message: string; confirmLabel?: string; variant?: 'danger' | 'default' }): Promise<boolean> {
		return new Promise((resolve) => {
			confirmState = { title: opts.title ?? 'Confirm', message: opts.message, confirmLabel: opts.confirmLabel ?? 'Confirm', variant: opts.variant ?? 'default', resolve };
		});
	}

	function resolveConfirm(ok: boolean): void {
		confirmState?.resolve(ok);
		confirmState = null;
	}

	/**
	 * The cover is the one edit here that puts a FILE on disk, and files don't follow the
	 * draft. Uploading only writes the new path; whichever cover the resolved preset ends up
	 * not pointing at is deleted here, once the outcome is known. Save drops the one it
	 * replaced, Discard drops the one it never adopted, and either way nothing is deleted
	 * while a live preset still names it.
	 */
	async function dropUnusedCover(before: string | undefined, after: string | undefined): Promise<void> {
		if (before && before !== after) await imageService.deleteImage(before);
	}

	async function saveChanges(): Promise<void> {
		if (!currentPreset || !isDirty) return;
		const replaced = presetService.getCommitted(currentPreset.id)?.meta?.cover;
		const committed = await presetService.commitDraft(currentPreset.id);
		if (committed) currentPreset = cloneForEdit(committed);
		await dropUnusedCover(replaced, committed?.meta?.cover);
		flashSaved();
		toastStore.success('Preset saved');
	}

	async function discardChanges(): Promise<void> {
		if (!currentPreset || !isDirty) return;
		const ok = await askConfirm({ title: 'Discard changes', message: 'Discard unsaved changes and revert to the saved version?', confirmLabel: 'Discard', variant: 'danger' });
		if (!ok) return;
		const abandoned = currentPreset.meta?.cover;
		const committed = await presetService.discardDraft(currentPreset.id);
		if (committed) currentPreset = cloneForEdit(committed);
		await dropUnusedCover(abandoned, committed?.meta?.cover);
	}

	// ===== Prompt items =====

	function toggleItemExpanded(itemId: string): void {
		expandedItemIds = toggledSet(expandedItemIds, itemId);
	}

	async function handleItemFieldChange(itemId: string, field: keyof Pick<PromptItem, 'name' | 'role' | 'content' | 'note'>, value: string): Promise<void> {
		if (!currentPreset) return;

		// An emptied note is dropped rather than stored blank, so it never rides the wire
		// as a field the item doesn't actually have.
		const next = field === 'note' && !value ? undefined : value;
		currentPreset.items = currentPreset.items.map((item) => (item.id === itemId ? { ...item, [field]: next } : item));
		await persistDraft();
	}

	async function addNewItem(): Promise<void> {
		if (!currentPreset) return;

		const newItem: PromptItem = {
			id: crypto.randomUUID(),
			name: '',
			role: 'system',
			content: '',
			enabled: true
		};

		currentPreset.items = [...currentPreset.items, newItem];
		await persistDraft();
		expandedItemIds = new Set([...expandedItemIds, newItem.id]);
	}

	async function deleteItem(itemId: string): Promise<void> {
		if (!currentPreset) return;
		currentPreset.items = currentPreset.items.filter((item) => item.id !== itemId);
		if (expandedItemIds.has(itemId)) expandedItemIds = toggledSet(expandedItemIds, itemId);
		await persistDraft();
	}

	async function toggleItem(itemId: string): Promise<void> {
		if (!currentPreset) return;
		currentPreset.items = currentPreset.items.map((item) => (item.id === itemId ? { ...item, enabled: !item.enabled } : item));
		await persistDraft();
	}

	// ===== Preset options =====

	// The continue instruction is an override: absent means "the shipped default", so typing
	// the default back in drops the field rather than freezing a copy of it into the preset.
	// An EMPTY string is a real value meaning "send no instruction", which is why Reset
	// (back to absent) exists at all.
	let continuePromptText = $derived(currentPreset?.continuePrompt ?? DEFAULT_CONTINUE_PROMPT);
	let continuePromptModified = $derived(currentPreset?.continuePrompt !== undefined);

	async function setContinuePrompt(value: string): Promise<void> {
		if (!currentPreset) return;
		currentPreset.continuePrompt = value === DEFAULT_CONTINUE_PROMPT ? undefined : value;
		await persistDraft();
	}

	async function resetContinuePrompt(): Promise<void> {
		if (!currentPreset) return;
		currentPreset.continuePrompt = undefined;
		await persistDraft();
	}

	// ===== The preset's byline, sections, setups and carried rules =====
	// Each is a plain slice of the working copy, written the same way everything else here
	// is: mutate the copy, then persistDraft.

	async function setMeta(meta: PromptPresetMeta | undefined): Promise<void> {
		if (!currentPreset) return;
		currentPreset.meta = meta;
		await persistDraft();
	}

	async function setSections(sections: PromptSection[]): Promise<void> {
		if (!currentPreset) return;
		currentPreset.sections = sections.length > 0 ? sections : undefined;
		await persistDraft();
	}

	async function setBundles(bundles: PromptPresetBundle[]): Promise<void> {
		if (!currentPreset) return;
		currentPreset.bundles = bundles.length > 0 ? bundles : undefined;
		await persistDraft();
	}

	async function setCarriedRules(rules: RegexRule[] | undefined): Promise<void> {
		if (!currentPreset) return;
		currentPreset.regexRules = rules;
		await persistDraft();
	}

	let sections = $derived(currentPreset?.sections ?? []);

	/** Which section each control names: drives the per-section count and the "declared but
	 *  empty" warning, so an author sees a heading that will never render before a reader does. */
	let usedGroups = $derived(
		(currentPreset?.controls ?? []).map((c) => c.group?.trim() ?? '').filter((g) => g)
	);

	/** Groups controls point at that no section declares. They still render (under their own
	 *  name, after the declared ones). This is the offer to give them a real heading. */
	let undeclaredGroups = $derived([
		...new Set(usedGroups.filter((g) => !sections.some((s) => s.id === g)))
	]);

	function toggleSectionExpanded(sectionId: string): void {
		expandedSectionIds = toggledSet(expandedSectionIds, sectionId);
	}

	async function addSection(): Promise<void> {
		let id = 'section';
		for (let n = 2; sections.some((s) => s.id === id); n++) id = `section-${n}`;
		await setSections([...sections, { id, title: '' }]);
		expandedSectionIds = new Set([...expandedSectionIds, id]);
	}

	async function adoptGroup(group: string): Promise<void> {
		await setSections([...sections, { id: group, title: group }]);
		expandedSectionIds = new Set([...expandedSectionIds, group]);
	}

	async function updateSection(updated: PromptSection): Promise<void> {
		await setSections(sections.map((s) => (s.id === updated.id ? updated : s)));
	}

	async function deleteSection(sectionId: string): Promise<void> {
		// The controls keep their `group`: the heading goes, the grouping stays, and the
		// group simply falls back to rendering under its own name. Clearing every control's
		// section because a heading was deleted would be a much bigger edit than the one asked for.
		if (expandedSectionIds.has(sectionId)) expandedSectionIds = toggledSet(expandedSectionIds, sectionId);
		await setSections(sections.filter((s) => s.id !== sectionId));
	}

	function handleSectionDndConsider(e: CustomEvent<DndEvent<PromptSection>>): void {
		// Collapse only the dragged row, so its placeholder gap stays compact.
		const draggedId = e.detail.info.id;
		if (expandedSectionIds.has(draggedId)) expandedSectionIds = toggledSet(expandedSectionIds, draggedId);
		if (!currentPreset) return;
		currentPreset.sections = e.detail.items;
	}

	async function handleSectionDndFinalize(e: CustomEvent<DndEvent<PromptSection>>): Promise<void> {
		await setSections(e.detail.items);
	}

	// ===== Custom controls (the form authors craft for Preset Controls) =====

	function toggleControlExpanded(controlId: string): void {
		expandedControlIds = toggledSet(expandedControlIds, controlId);
	}

	// ---- Available Macros reference ----
	// Rendered by the shared MacroReference component (scope 'preset'); only the
	// preset's own dynamic control macros are supplied from here.
	let presetControlMacros = $derived(
		(currentPreset?.controls ?? []).filter((c) => c.macro.trim())
	);

	/** Validate a control's macro name: required, unique, not a built-in. */
	function macroError(control: PromptControl): string | undefined {
		const macro = control.macro.trim();
		if (!macro) return 'Macro name is required.';
		if (RESERVED_MACROS.has(macro)) return `{{${macro}}} is a built-in macro, so the engine resolves it itself and this control would be ignored. Pick another name.`;
		const clash = currentPreset?.controls?.some((c) => c.id !== control.id && c.macro.trim() === macro);
		if (clash) return 'Another control already uses this macro.';
		return undefined;
	}

	async function addControl(): Promise<void> {
		if (!currentPreset) return;
		const newControl: PromptControl = {
			id: crypto.randomUUID(),
			macro: '',
			label: '',
			type: 'text'
		};
		currentPreset.controls = [...(currentPreset.controls ?? []), newControl];
		await persistDraft();
		expandedControlIds = new Set([...expandedControlIds, newControl.id]);
	}

	async function updateControl(updated: PromptControl): Promise<void> {
		if (!currentPreset) return;
		currentPreset.controls = (currentPreset.controls ?? []).map((c) => (c.id === updated.id ? updated : c));
		await persistDraft();
	}

	async function deleteControl(controlId: string): Promise<void> {
		if (!currentPreset) return;
		currentPreset.controls = (currentPreset.controls ?? []).filter((c) => c.id !== controlId);
		if (expandedControlIds.has(controlId)) expandedControlIds = toggledSet(expandedControlIds, controlId);
		await persistDraft();
	}

	// Drag & drop rides the library's dragHandleZone/dragHandle pair: only the lead
	// grip starts a drag, the rest of the row is a plain click target. Whole-row
	// dragging was tried first and felt broken: the library treats any press that
	// moves 3px as a drag, so ordinary slightly-sloppy clicks were eaten as
	// micro-drags (no click fired, the open row collapsed via `consider`, and a grab
	// cursor flashed). Items and controls are separate zones with distinct `type`s
	// so a prompt item can never be dropped into the controls list or vice versa.
	function onExpandKeydown(e: KeyboardEvent, toggle: () => void): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggle();
		}
	}

	// Keep the drag preview compact even when the dragged row was expanded.
	function stripBodyFromDragPreview(el?: HTMLElement): void {
		el?.querySelector('[data-item-body]')?.remove();
	}

	function handleDndConsider(e: CustomEvent<DndEvent<PromptItem>>): void {
		// Collapse only the dragged row so its placeholder gap stays compact.
		// Other open rows keep their state through the drag.
		const draggedId = e.detail.info.id;
		if (expandedItemIds.has(draggedId)) expandedItemIds = toggledSet(expandedItemIds, draggedId);
		if (!currentPreset) return;
		currentPreset.items = e.detail.items;
	}

	async function handleDndFinalize(e: CustomEvent<DndEvent<PromptItem>>): Promise<void> {
		if (!currentPreset) return;
		currentPreset.items = e.detail.items;
		await persistDraft();
	}

	function handleControlDndConsider(e: CustomEvent<DndEvent<PromptControl>>): void {
		const draggedId = e.detail.info.id;
		if (expandedControlIds.has(draggedId)) expandedControlIds = toggledSet(expandedControlIds, draggedId);
		if (!currentPreset) return;
		currentPreset.controls = e.detail.items;
	}

	async function handleControlDndFinalize(e: CustomEvent<DndEvent<PromptControl>>): Promise<void> {
		if (!currentPreset) return;
		currentPreset.controls = e.detail.items;
		await persistDraft();
	}
</script>

<div class="pb">
	<!-- Preset selection, actions, and save state in normal document flow. -->
	<header class="pb-spine">
		<PresetManager id="preset-select" showCreate showSave={isDirty} onSave={saveChanges} />

		{#if isDirty || justSaved}
			<div class="pb-spine-status" aria-live="polite">
				{#if isDirty}
					<span class="pb-dot pb-dot--dirty"></span>
					<span class="pb-status-dirty">Unsaved changes</span>
					<span class="pb-status-spacer"></span>
					<button type="button" class="pb-status-link" onclick={discardChanges}>Discard</button>
				{:else}
					<!-- |global so the fade-out still plays when the whole status row leaves. -->
					<span class="pb-status-saved" transition:fade|global={{ duration: 250 }}>
						<span class="pb-dot pb-dot--saved"></span>
						Saved
					</span>
				{/if}
			</div>
		{/if}
	</header>

	{#if storyPreset && currentPreset}
		<ChatOverrideNotice
			subject="the active preset"
			using={storyPreset.name}
			instead={currentPreset.name}
		/>
	{/if}

	<!-- Prompt items: the primary surface. data-setting is the Chungus Assistant's
	     deep-link anchor (registry: settings.ts, anchor 'prompt-builder'). -->
	<section class="pb-sec" data-setting="prompt-builder">
		<div class="pb-sec-head">
			<span class="pb-sec-title">Prompt items</span>
			{#if totalEnabledTokens > 0}
				<span class="pb-sec-meta">{totalEnabledTokens.toLocaleString()} tokens</span>
			{/if}
			{#if overBudget || trimmedMessages > 0}
				<span
					class="pb-warn-chip"
					title={overBudget
						? 'The prompt exceeds the context size even with all chat history dropped. The rows below price what each item resolves to; the total prices what fits.'
						: `${trimmedMessages} older chat ${trimmedMessages === 1 ? 'turn is' : 'turns are'} dropped to fit the context size, so the rows below add up to more than the total.`}
				>
					<Icon name="warning" class="w-3.5 h-3.5" strokeWidth={1.5} />
					{overBudget ? 'over budget' : `${trimmedMessages} trimmed`}
				</span>
			{/if}
			{#if itemsWithUnboundMacros > 0}
				<span class="pb-warn-chip" title="Some items reference macros that no control or system macro provides.">
					<Icon name="warning" class="w-3.5 h-3.5" strokeWidth={1.5} />
					{itemsWithUnboundMacros}
				</span>
			{/if}
			<span class="pb-sec-spacer"></span>
			<MockupTip text="Only changes the token count shown here, never what gets sent. Raw counts the text as written, Expanded counts what it weighs once resolved.">
				{#snippet trigger()}
					<button
						type="button"
						class="pb-mode"
						class:is-on={showExpandedTokens}
						onclick={() => (showExpandedTokens = !showExpandedTokens)}
					>
						<Icon name="sparkles" class="w-3.5 h-3.5" strokeWidth={1.5} />
						{showExpandedTokens ? 'Expanded' : 'Raw'}
					</button>
				{/snippet}
				<RawExpandedMockup />
			</MockupTip>
			<button type="button" class="pb-add" onclick={addNewItem} title="Add prompt item">
				<Icon name="plus" class="w-3.5 h-3.5" strokeWidth={2} />
				<span class="pb-add-label">Add item</span>
			</button>
		</div>

		{#if currentPreset && currentPreset.items.length > 0}
			<div
				class="pb-list"
				use:dragHandleZone={{ items: currentPreset.items, type: 'pb-items', flipDurationMs, dropTargetStyle: {}, delayTouchStart: 180, transformDraggedElement: stripBodyFromDragPreview }}
				onconsider={handleDndConsider}
				onfinalize={handleDndFinalize}
			>
				{#each currentPreset.items as item (item.id)}
					{@const isExpanded = expandedItemIds.has(item.id)}
					{@const breakdown = getItemTokenBreakdown(item)}
					{@const unboundMacros = unboundMacrosFor(item.content)}
					<div class="pb-row" class:is-expanded={isExpanded}>
						<!-- Header row: the lead grip drags, everything else is a plain click -->
						<div class="pb-row-head">
							<!-- Drag handle. The library wires role/tabindex/cursor and Enter/Space
							     keyboard drag onto it; a plain click still toggles expand, and a real
							     drag suppresses its own trailing click. -->
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<span
								class="pb-lead"
								use:dragHandle
								aria-label="Drag to reorder"
								title="Drag to reorder"
								onclick={() => toggleItemExpanded(item.id)}
							>
								<span class="pb-lead-chevron"><Icon name="chevronRight" class="w-4 h-4" /></span>
								<span class="pb-lead-grip"><Icon name="menu" class="w-4 h-4" strokeWidth={1.5} /></span>
							</span>
							<div
								class="pb-row-main"
								class:is-off={!item.enabled}
								role="button"
								tabindex="0"
								aria-expanded={isExpanded}
								aria-label={isExpanded ? 'Collapse item' : 'Expand item'}
								title="Click to edit"
								onclick={() => toggleItemExpanded(item.id)}
								onkeydown={(e) => onExpandKeydown(e, () => toggleItemExpanded(item.id))}
							>
								<span class="pb-role {roleColors[item.role]}">
									<span class="pb-role-full">{roleLabels[item.role]}</span>
									<span class="pb-role-abbr" aria-hidden="true">{roleLabels[item.role][0]}</span>
								</span>
								<span class="pb-name">{item.name || 'Untitled'}</span>
								<span class="pb-tokens">
									{breakdown.total.toLocaleString()}{#if showExpandedTokens && breakdown.macroTokens > 0}<em>+{breakdown.macroTokens.toLocaleString()}</em>{/if}
								</span>
							</div>

							{#if item.note}
								<span class="pb-row-note" title={item.note}>
									<Icon name="annotation" class="w-4 h-4" strokeWidth={1.5} />
								</span>
							{/if}

							{#if unboundMacros.length > 0}
								<span
									class="pb-row-warn"
									title={`Unbound macro${unboundMacros.length > 1 ? 's' : ''}: ${unboundMacros.map((m) => `{{${m}}}`).join(', ')}. Nothing provides ${unboundMacros.length > 1 ? 'them' : 'it'}, so ${unboundMacros.length > 1 ? 'they' : 'it'} will appear literally in the prompt.`}
								>
									<Icon name="warning" class="w-4 h-4" strokeWidth={1.5} />
								</span>
							{/if}

							<button
								type="button"
								class="pb-row-del"
								title="Delete item"
								aria-label="Delete item"
								onclick={() => deleteItem(item.id)}
							>
								<Icon name="trash" class="w-4 h-4" strokeWidth={1.5} />
							</button>

							<Toggle checked={item.enabled} onchange={() => toggleItem(item.id)} label="Toggle enabled" />
						</div>

						<!-- Expanded editor -->
						{#if isExpanded}
							<div data-item-body class="pb-body">
								<div class="pb-fields">
									<div class="pb-field">
										<label for="item-name-{item.id}" class="pb-label">Name</label>
										<input
											id="item-name-{item.id}"
											type="text"
											value={item.name}
											oninput={(e) => handleItemFieldChange(item.id, 'name', (e.target as HTMLInputElement).value)}
											placeholder="Enter item name"
											class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm"
										/>
									</div>

									<div class="pb-field">
										<label for="item-role-{item.id}" class="pb-label">Role</label>
										<Select
											id="item-role-{item.id}"
											value={item.role}
											onchange={(e) => handleItemFieldChange(item.id, 'role', (e.target as HTMLSelectElement).value)}
											class="!px-3 !py-2 !text-sm"
										>
											<option value="system">System</option>
											<option value="user">User</option>
											<option value="assistant">Assistant</option>
										</Select>
									</div>
								</div>

								<div class="pb-field">
									<label for="item-content-{item.id}" class="pb-label">Prompt content</label>
									<textarea
										id="item-content-{item.id}"
										value={item.content}
										oninput={(e) => handleItemFieldChange(item.id, 'content', (e.target as HTMLTextAreaElement).value)}
										use:autoResize={400}
										placeholder="Enter the prompt content…"
										class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm resize-none"
									></textarea>
									{#if unboundMacros.length > 0}
										<div class="pb-lint">
											<Icon name="warning" class="w-3.5 h-3.5 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
											<span>
												{unboundMacros.map((m) => `{{${m}}}`).join(', ')}. No control or system macro provides {unboundMacros.length > 1 ? 'these' : 'this'}, so {unboundMacros.length > 1 ? 'they' : 'it'} will appear literally in the output. Add a matching control below, or remove the reference.
											</span>
										</div>
									{/if}
								</div>

								<!-- The one field on this page that never reaches the model. Everything
								     else an author types here is prompt; this is the place to say
								     "don't touch unless you know what this does" without saying it
								     to the model too. -->
								<div class="pb-field">
									<label for="item-note-{item.id}" class="pb-label">
										Author's note
										<span class="pb-label-aside">never sent</span>
									</label>
									<textarea
										id="item-note-{item.id}"
										value={item.note ?? ''}
										oninput={(e) => handleItemFieldChange(item.id, 'note', (e.target as HTMLTextAreaElement).value)}
										use:autoResize={160}
										placeholder="What this item is for, what breaks if it's edited, who should leave it alone…"
										class="input-base w-full px-3 py-2 text-text-secondary font-ui text-sm resize-none"
									></textarea>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{:else}
			<div class="pb-empty">
				<p>No prompt items yet. "Add item" starts the prompt this preset sends.</p>
			</div>
		{/if}
	</section>

	<!-- Custom controls: the form this preset publishes to the Preset Controls page -->
	{#if currentPreset}
		<section class="pb-sec">
			<div class="pb-sec-head">
				<span class="pb-sec-title">Preset controls</span>
				<InfoTip text="Widgets on the Preset Controls page, each bound to a macro you can drop into the prompt items above." />
				{#if (currentPreset.controls?.length ?? 0) > 0}
					<span class="pb-sec-meta">{currentPreset.controls?.length}</span>
				{/if}
				<span class="pb-sec-spacer"></span>
				<button type="button" class="pb-add" onclick={addControl} title="Add control">
					<Icon name="plus" class="w-3.5 h-3.5" strokeWidth={2} />
					<span class="pb-add-label">Add control</span>
				</button>
			</div>

			{#if currentPreset.controls && currentPreset.controls.length > 0}
				<div
					class="pb-list"
					use:dragHandleZone={{ items: currentPreset.controls, type: 'pb-controls', flipDurationMs, dropTargetStyle: {}, delayTouchStart: 180, transformDraggedElement: stripBodyFromDragPreview }}
					onconsider={handleControlDndConsider}
					onfinalize={handleControlDndFinalize}
				>
					{#each currentPreset.controls as control (control.id)}
						{@const isExpanded = expandedControlIds.has(control.id)}
						{@const err = macroError(control)}
						<div class="pb-row" class:is-expanded={isExpanded}>
							<div class="pb-row-head">
								<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
								<span
									class="pb-lead"
									use:dragHandle
									aria-label="Drag to reorder"
									title="Drag to reorder"
									onclick={() => toggleControlExpanded(control.id)}
								>
									<span class="pb-lead-chevron"><Icon name="chevronRight" class="w-4 h-4" /></span>
									<span class="pb-lead-grip"><Icon name="menu" class="w-4 h-4" strokeWidth={1.5} /></span>
								</span>
								<div
									class="pb-row-main"
									role="button"
									tabindex="0"
									aria-expanded={isExpanded}
									aria-label={isExpanded ? 'Collapse control' : 'Expand control'}
									title="Click to edit"
									onclick={() => toggleControlExpanded(control.id)}
									onkeydown={(e) => onExpandKeydown(e, () => toggleControlExpanded(control.id))}
								>
									<span class="pb-type">{control.type}</span>
									<span class="pb-name">{control.label || 'Untitled control'}</span>
									{#if control.macro}
										<span class="pb-macro">{`{{${control.macro}}}`}</span>
									{/if}
								</div>

								{#if err}
									<span class="pb-row-warn pb-row-warn--error" title={err}>
										<Icon name="warning" class="w-4 h-4" strokeWidth={1.5} />
									</span>
								{/if}

								<button
									type="button"
									class="pb-row-del"
									title="Delete control"
									aria-label="Delete control"
									onclick={() => deleteControl(control.id)}
								>
									<Icon name="trash" class="w-4 h-4" strokeWidth={1.5} />
								</button>
							</div>
							{#if isExpanded}
								<div data-item-body class="pb-body">
									<ControlEditor {control} macroError={err} {sections} onChange={updateControl} />
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<div class="pb-empty">
					<p>No controls yet. "Add control" crafts a widget readers can use on the Preset Controls page.</p>
				</div>
			{/if}
		</section>
	{/if}

	<!-- Sections: the shape of the reader's page. Order here is the order they meet them in,
	     which is the whole reason this list is draggable rather than derived. -->
	{#if currentPreset}
		<section class="pb-sec">
			<div class="pb-sec-head">
				<span class="pb-sec-title">Sections</span>
				<InfoTip text="Headings on the Preset Controls page. A control joins one by naming its key, and declaring it here gives that key a title, an icon and a place in the order." />
				{#if sections.length > 0}
					<span class="pb-sec-meta">{sections.length}</span>
				{/if}
				<span class="pb-sec-spacer"></span>
				<button type="button" class="pb-add" onclick={addSection} title="Add section">
					<Icon name="plus" class="w-3.5 h-3.5" strokeWidth={2} />
					<span class="pb-add-label">Add section</span>
				</button>
			</div>

			{#if sections.length > 0}
				<div
					class="pb-list"
					use:dragHandleZone={{ items: sections, type: 'pb-sections', flipDurationMs, dropTargetStyle: {}, delayTouchStart: 180, transformDraggedElement: stripBodyFromDragPreview }}
					onconsider={handleSectionDndConsider}
					onfinalize={handleSectionDndFinalize}
				>
					{#each sections as section (section.id)}
						{@const isExpanded = expandedSectionIds.has(section.id)}
						{@const used = usedGroups.filter((g) => g === section.id).length}
						<div class="pb-row" class:is-expanded={isExpanded}>
							<div class="pb-row-head">
								<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
								<span
									class="pb-lead"
									use:dragHandle
									aria-label="Drag to reorder"
									title="Drag to reorder, this is the order readers meet them in"
									onclick={() => toggleSectionExpanded(section.id)}
								>
									<span class="pb-lead-chevron"><Icon name="chevronRight" class="w-4 h-4" /></span>
									<span class="pb-lead-grip"><Icon name="menu" class="w-4 h-4" strokeWidth={1.5} /></span>
								</span>
								<div
									class="pb-row-main"
									role="button"
									tabindex="0"
									aria-expanded={isExpanded}
									aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
									title="Click to edit"
									onclick={() => toggleSectionExpanded(section.id)}
									onkeydown={(e) => onExpandKeydown(e, () => toggleSectionExpanded(section.id))}
								>
									{#if isSectionIcon(section.icon)}
										<Icon name={section.icon} class="w-4 h-4 flex-shrink-0 text-text-muted" strokeWidth={1.5} />
									{/if}
									<span class="pb-name">{section.title || section.id}</span>
									{#if section.collapsed}
										<span class="pb-type">folded</span>
									{/if}
									<span class="pb-tokens" class:pb-tokens--warn={used === 0} title="Controls in this section">
										{used}
									</span>
								</div>

								<button
									type="button"
									class="pb-row-del"
									title="Delete section"
									aria-label="Delete section"
									onclick={() => deleteSection(section.id)}
								>
									<Icon name="trash" class="w-4 h-4" strokeWidth={1.5} />
								</button>
							</div>
							{#if isExpanded}
								<div data-item-body class="pb-body">
									<SectionEditor {section} {used} onChange={updateSection} />
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<div class="pb-empty">
					<p>No sections. Readers get one flat list, in whatever order the controls happen to sit.</p>
				</div>
			{/if}

			{#if undeclaredGroups.length > 0}
				<div class="pb-adopt">
					<p class="pb-adopt-text">
						{undeclaredGroups.length === 1 ? 'One group is' : `${undeclaredGroups.length} groups are`}
						named by controls but not declared here, so they render last under their own name.
					</p>
					<div class="pb-adopt-row">
						{#each undeclaredGroups as group (group)}
							<button type="button" class="pb-adopt-btn" onclick={() => adoptGroup(group)}>
								<Icon name="plus" class="w-3 h-3" strokeWidth={2} />
								{group}
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</section>
	{/if}

	<!-- Setups: the configurations the author vouches for, one click each. -->
	{#if currentPreset}
		<section class="pb-sec">
			<div class="pb-sec-head">
				<span class="pb-sec-title">Setups</span>
				<InfoTip text="A named snapshot of every control value, applied by a reader in one click. It saves you shipping the same preset five times over." />
				{#if (currentPreset.bundles?.length ?? 0) > 0}
					<span class="pb-sec-meta">{currentPreset.bundles?.length}</span>
				{/if}
			</div>
			<BundleListEditor
				bundles={currentPreset.bundles ?? []}
				controls={currentPreset.controls ?? []}
				values={presetControlsStore.valuesFor(currentPreset.id)}
				onChange={setBundles}
			/>
		</section>
	{/if}

	<!-- The preset's own find & replace: what makes it look right the moment it lands. -->
	{#if currentPreset}
		<section class="pb-sec">
			<div class="pb-sec-head">
				<span class="pb-sec-title">Regex this preset carries</span>
				<InfoTip text="Rules that ship inside the preset, run on top of the reader's own, and withdraw when the preset does. Each switch is the position its rule arrives in; a reader can move it, but the rule stays yours." />
				{#if (currentPreset.regexRules?.length ?? 0) > 0}
					<span class="pb-sec-meta">{currentPreset.regexRules?.length}</span>
				{/if}
			</div>
			<CarriedRegexEditor rules={currentPreset.regexRules ?? []} onChange={setCarriedRules} {lastReply} />
		</section>
	{/if}

	<!-- The byline. Below the machinery because it is written once and rarely revisited. -->
	{#if currentPreset}
		<section class="pb-sec">
			<div class="pb-sec-head">
				<span class="pb-sec-title">Preset identity</span>
				<InfoTip text="What a reader meets before they touch a single control." />
			</div>
			<PresetIdentityEditor meta={currentPreset.meta} onChange={setMeta} />
		</section>
	{/if}

	<!-- Preset options: per-preset knobs over how the prompt is ASSEMBLED rather than what
	     it says, which is why they sit below both lists (set once, rarely revisited). -->
	{#if currentPreset}
		<section class="pb-sec">
			<div class="pb-sec-head">
				<span class="pb-sec-title">Preset options</span>
			</div>

			<!-- Preset-level opt-in: empty tag blocks prune themselves (see macros.ts). Off by
			     default so imported presets keep meaning exactly what they say. -->
			<div class="pb-prune">
				<div class="pb-prune-text">
					<span class="pb-prune-title">Prune empty blocks</span>
					<MockupTip
						text="Drops a plain <tag> block, framing and all, when every macro inside it resolves empty. Static-only blocks are never touched."
					>
						<PruneEmptyBlocksMockup />
					</MockupTip>
				</div>
				<Toggle
					checked={currentPreset.pruneEmptyBlocks ?? false}
					onchange={(v) => {
						if (!currentPreset) return;
						currentPreset.pruneEmptyBlocks = v;
						persistDraft();
					}}
					label="Prune empty blocks"
				/>
			</div>

			<!-- Preset-level example-dialogue separator: replaces SillyTavern's <START>
			     marker between example-dialogue blocks (see macros.ts). Blank falls back
			     to the default "***". -->
			<div class="pb-prune">
				<div class="pb-prune-text">
					<span class="pb-prune-title">Example separator</span>
				</div>
				<input
					type="text"
					value={currentPreset.exampleSeparator ?? ''}
					oninput={(e) => {
						if (!currentPreset) return;
						currentPreset.exampleSeparator = (e.target as HTMLInputElement).value;
						persistDraft();
					}}
					placeholder="***"
					class="input-base px-2.5 py-1 text-sm font-ui w-28"
				/>
			</div>
			<p class="pb-sep-hint">Replaces &lt;START&gt; between example-dialogue blocks.</p>

			<!-- The instruction Continue appends after the reply it extends. Per-preset because
			     it is prompt text like everything else here: it ships and saves with the preset,
			     and rides the same connection as an ordinary send. -->
			<div class="pb-opt">
				<div class="pb-opt-head">
					<label for="continue-prompt" class="pb-prune-title">Continue prompt</label>
					{#if continuePromptModified}
						<button type="button" class="pb-opt-reset" onclick={resetContinuePrompt}>Reset</button>
					{/if}
				</div>
				<textarea
					id="continue-prompt"
					value={continuePromptText}
					oninput={(e) => setContinuePrompt((e.target as HTMLTextAreaElement).value)}
					use:autoResize={{ maxHeight: 260, value: continuePromptText }}
					placeholder="No instruction, the reply closes the prompt bare."
					class="input-base w-full px-3 py-2 text-text-primary font-ui text-sm resize-none"
				></textarea>
				<p class="pb-sep-hint pb-opt-hint">
					Sent as the final turn, right after the reply being extended. Clear it to send nothing,
					and providers that support assistant prefill continue the reply natively.
				</p>
			</div>
		</section>
	{/if}

	<MacroReference
		controls={presetControlMacros.map((c) => ({ name: c.macro.trim(), description: c.label || 'Custom control' }))}
	/>
</div>

<ConfirmDialog
	open={!!confirmState}
	title={confirmState?.title}
	message={confirmState?.message ?? ''}
	confirmLabel={confirmState?.confirmLabel}
	variant={confirmState?.variant}
	onConfirm={() => resolveConfirm(true)}
	onCancel={() => resolveConfirm(false)}
/>

<style>
	/* The builder measures itself, never the viewport: it lives in a ~360–500px
	   dock on wide screens and a chat-column overlay on narrow ones. */
	.pb {
		container-type: inline-size;
		container-name: builder;
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
	}

	/* ---- Preset actions ---- */
	.pb-spine {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	/* Save-state line under the actions: amber while dirty, a brief green after save. */
	.pb-spine-status {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		min-height: 1rem;
		font-family: var(--font-ui);
		font-size: 0.72rem;
	}

	.pb-dot {
		align-self: center;
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 9999px;
		flex-shrink: 0;
	}

	.pb-dot--dirty {
		background: var(--color-warning);
	}

	.pb-dot--saved {
		background: var(--color-success);
	}

	.pb-status-dirty {
		color: var(--color-warning);
		font-weight: 600;
		white-space: nowrap;
	}

	.pb-status-spacer {
		flex: 1 1 0;
	}

	.pb-status-link {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 0.18em;
		cursor: pointer;
		transition: color 120ms ease;
	}

	.pb-status-link:hover {
		color: var(--color-text-primary);
	}

	.pb-status-saved {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--color-text-muted);
	}

	/* ---- Sections ---- */
	.pb-sec {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.pb-sec-head {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 1.9rem;
	}

	.pb-sec-title {
		font-family: var(--font-ui);
		font-size: 0.6563rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.pb-sec-meta {
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.pb-sec-spacer {
		flex: 1 1 0;
		min-width: 0.25rem;
	}

	.pb-warn-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-warning);
		cursor: help;
	}

	/* Preset options: quiet settings rows under the item and control lists. */
	.pb-prune {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.55rem 0.7rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-secondary) 55%, transparent);
	}

	.pb-prune-text {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.pb-prune-title {
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.pb-sep-hint {
		margin: -0.35rem 0 0;
		padding: 0 0.7rem;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	/* The one option whose value is prose, so it gets a stacked block instead of a row. */
	.pb-opt {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
	}

	.pb-opt-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.05rem;
	}

	/* Reset appears only once the field carries an override, the same contract as the
	   engine prompt editor it replaces: back to absent, i.e. the shipped default. */
	.pb-opt-reset {
		margin-left: auto;
		padding: 0;
		border: 0;
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.pb-opt-reset:hover {
		color: var(--color-text-primary);
	}

	.pb-opt-hint {
		margin: 0;
		padding: 0 0.05rem;
		line-height: 1.45;
	}

	.pb-mode {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		height: 1.9rem;
		padding: 0 0.6rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
	}

	.pb-mode:hover {
		color: var(--color-text-secondary);
		border-color: var(--color-border);
	}

	.pb-mode.is-on {
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 32%, transparent);
		color: var(--color-accent);
	}

	.pb-add {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 1.9rem;
		padding: 0 0.6rem;
		border: 1px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		transition: background-color 140ms ease, border-color 140ms ease;
	}

	.pb-add:hover {
		background: color-mix(in srgb, var(--color-accent) 17%, transparent);
		border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
	}

	@container builder (max-width: 379px) {
		.pb-add-label {
			display: none;
		}

		.pb-add {
			width: 1.9rem;
			padding: 0;
			justify-content: center;
		}
	}

	/* ---- Row list (shared by items and controls) ---- */
	.pb-list {
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 84%, transparent);
		overflow: hidden;
	}

	.pb-row {
		border-bottom: 1px solid var(--color-border-subtle);
		background: transparent;
	}

	.pb-row:last-child {
		border-bottom: 0;
	}

	.pb-row.is-expanded {
		background: color-mix(in srgb, var(--color-bg-secondary) 60%, transparent);
		box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	/* Vertical padding lives on the clickable region (.pb-row-main) and the handle,
	   not on this shell. Otherwise the row's top/bottom strips are click-dead. */
	.pb-row-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.6rem;
		transition: background-color 120ms ease;
	}

	.pb-row-head:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 50%, transparent);
	}

	.pb-row-main {
		flex: 1;
		align-self: stretch;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		padding: 0.45rem 0;
		text-align: left;
		user-select: none;
		cursor: pointer;
	}

	.pb-row-main.is-off > * {
		opacity: 0.45;
	}

	/* Leading slot = the drag handle (dragHandle action): chevron at rest, grip on
	   hover, always the grip on touch. One spot, no layout shift, and since only
	   this slot starts a drag, clicks on the rest of the row are never eaten. */
	.pb-lead {
		position: relative;
		align-self: stretch;
		width: 1.15rem;
		min-height: 1.5rem;
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.pb-lead-chevron,
	.pb-lead-grip {
		position: absolute;
		inset: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: opacity 120ms ease, transform 160ms ease;
	}

	.pb-lead-grip {
		opacity: 0;
	}

	.pb-row.is-expanded .pb-lead-chevron {
		transform: rotate(90deg);
	}

	@media (hover: hover) {
		.pb-row:not(.is-expanded) .pb-row-head:hover .pb-lead-chevron {
			opacity: 0;
		}

		.pb-row:not(.is-expanded) .pb-row-head:hover .pb-lead-grip {
			opacity: 1;
		}
	}

	/* With no hover to disclose the grip on touch, show it outright so the drag point
	   is visible; the accent bar + open body already mark the expanded row. */
	@media (hover: none) {
		.pb-lead-chevron {
			opacity: 0;
		}

		.pb-lead-grip {
			opacity: 1;
		}
	}

	.pb-role {
		flex-shrink: 0;
		padding: 0.1rem 0.5rem;
		border-radius: var(--radius-sm);
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.pb-role-abbr {
		display: none;
	}

	@container builder (max-width: 399px) {
		.pb-role-full {
			display: none;
		}

		.pb-role-abbr {
			display: inline;
		}

		.pb-role {
			min-width: 1.45rem;
			text-align: center;
			padding: 0.1rem 0.3rem;
		}
	}

	.pb-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-ui);
		font-size: 0.82rem;
		color: var(--color-text-primary);
	}

	.pb-tokens {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.pb-tokens em {
		font-style: normal;
		color: var(--color-accent);
		margin-left: 0.25rem;
	}

	.pb-type {
		flex-shrink: 0;
		padding: 0.1rem 0.5rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-tertiary) 90%, transparent);
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: capitalize;
		white-space: nowrap;
	}

	.pb-macro {
		flex-shrink: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 0.68rem;
		color: var(--color-text-muted);
	}

	@container builder (max-width: 429px) {
		.pb-macro {
			display: none;
		}
	}

	.pb-row-warn {
		flex-shrink: 0;
		display: inline-flex;
		color: var(--color-warning);
		cursor: help;
	}

	/* An item carrying an author's note says so, so the one thing on this page the model
	   never sees is still visible without opening every row. */
	.pb-row-note {
		flex-shrink: 0;
		display: inline-flex;
		color: var(--color-text-muted);
		cursor: help;
	}

	/* A declared section no control names never renders. Flag it here, not in the app. */
	.pb-tokens--warn {
		color: var(--color-warning);
	}

	.pb-label-aside {
		margin-left: 0.4rem;
		font-weight: 400;
		font-size: 0.68rem;
		color: var(--color-text-muted);
	}

	/* Groups the controls use that no section speaks for yet. */
	.pb-adopt {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.6rem 0.7rem;
		border: 1px solid color-mix(in srgb, var(--color-warning) 25%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-warning) 7%, transparent);
	}

	.pb-adopt-text {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.pb-adopt-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.pb-adopt-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.2rem 0.55rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-full);
		background: var(--color-bg-secondary);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: color 120ms ease, border-color 120ms ease;
	}

	.pb-adopt-btn:hover {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
	}

	.pb-row-warn--error {
		color: var(--color-error);
	}

	/* Delete stays out of the way until the row is hovered (or expanded); on touch
	   devices, where there is no hover, it is simply always there. */
	.pb-row-del {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		opacity: 0;
		transition: color 120ms ease, opacity 120ms ease, background-color 120ms ease;
	}

	.pb-row-head:hover .pb-row-del,
	.pb-row.is-expanded .pb-row-del,
	.pb-row-del:focus-visible {
		opacity: 1;
	}

	@media (hover: none) {
		.pb-row-del {
			opacity: 1;
		}
	}

	.pb-row-del:hover {
		color: var(--color-error);
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
	}

	/* ---- Expanded editor body ---- */
	.pb-body {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 0.75rem 0.85rem 0.95rem;
		border-top: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-primary) 50%, transparent);
	}

	.pb-fields {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.75rem;
	}

	@container builder (min-width: 430px) {
		.pb-fields {
			grid-template-columns: 1fr 1fr;
		}
	}

	.pb-field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}

	.pb-label {
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.pb-lint {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--color-warning);
	}

	/* ---- Empty states ---- */
	.pb-empty {
		padding: 1.6rem 1rem;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-lg);
		text-align: center;
	}

	.pb-empty p {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		color: var(--color-text-muted);
	}
</style>
