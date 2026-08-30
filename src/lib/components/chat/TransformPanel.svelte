<script lang="ts">
	/**
	 * The composer's transform surface (Spellcheck, Impersonate): a strip that opens ABOVE
	 * the composer rather than a modal over the app: the draft being rewritten stays on
	 * screen underneath it and the story stays readable behind it, which is the whole
	 * context for judging what the model proposes.
	 *
	 * NOTHING here spends a token without a press. Impersonate opens in `setup` having
	 * called nothing, and picking a perspective only records the choice. The button beside
	 * it is the single thing that calls a model, and it carries the estimate of what that
	 * call will cost, counted off the exact messages the run will send. Spellcheck has
	 * nothing to choose, so its menu row was the press and it opens mid-run; stopping it
	 * lands in the same `setup`, which is why that phase exists for both kinds.
	 *
	 * Presentation splits by kind because the two produce different shapes of text. A
	 * spellcheck is small edits over the draft, so it reads as an inline redline. An
	 * impersonation is a new message grown from a note, where a word diff against that note
	 * is noise (a handful of accidental word matches strung between two wholesale
	 * rewrites), so it reads as the message itself, with the draft it grew from still
	 * sitting in the composer below.
	 *
	 * The contract this surface exists to enforce: the draft is NEVER replaced silently.
	 * Approve swaps the text in, close/Escape/error leave the composer byte-for-byte
	 * untouched.
	 */
	import { onMount } from 'svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import PillRow from '$lib/components/ui/PillRow.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { chatPersonaEntry } from '$lib/utils/chat-setup';
	import { promptHoldStore } from '$lib/stores/promptHold.svelte';
	import { engineById } from '$lib/engines/registry';
	import { failureText } from '$lib/stores/toast.svelte';
	import { llmService } from '$lib/services/llm/provider';
	import { buildComposerTransformPrompt, runComposerTransform } from '$lib/services/composerTransformService';
	import { countMessages, tokenCalibration } from '$lib/tokenizer';
	import { diffWords } from '$lib/utils/text-diff';
	import type { ImpersonatePerspective, Message } from '$lib/types/chat';

	interface Props {
		kind: 'spellcheck' | 'impersonate';
		/** The composer draft as it was when the transform was triggered. */
		original: string;
		chatId: string;
		/** The visible story path, for Impersonate's context. */
		chatMessages: Message[];
		/** Close, leaving the composer untouched. */
		onClose: () => void;
		/** Approve: the caller replaces the composer draft with `proposed`. */
		onApprove: (proposed: string) => void;
	}

	let { kind, original, chatId, chatMessages, onClose, onApprove }: Props = $props();

	/** `setup` is the phase that exists so a call is never made before the user has said
	 *  what they want. Spellcheck opens past it and falls back into it after a stop. */
	type Phase = 'setup' | 'running' | 'ready' | 'error';

	let phase = $state<Phase>('setup');
	let proposed = $state('');
	let errorMessage = $state('');
	// Impersonate's per-chat voice; seeded from the chat on mount (the panel mounts fresh
	// per open), then locally owned: picking persists the choice and nothing else.
	let perspective = $state<ImpersonatePerspective>('first');
	/** The perspective the result on screen was written in. The gap between this and the
	 *  pills' current pick is what lights the rewrite button. */
	let ranPerspective = $state<ImpersonatePerspective>('first');
	let abortController: AbortController | null = null;

	// Name and glyph off the registry, not spelled again here: the menu row that opened
	// this strip wears the same ones (architecture/engines.md).
	let engine = $derived(engineById(kind));

	// Written as the reader would meet it: the same sentence in each person, with the
	// active persona's own name in the third, so the pick needs no explaining.
	let speaker = $derived(chatPersonaEntry(chatStore.activeChat)?.identity.name?.trim() ?? '');
	let perspectiveOptions = $derived([
		{ value: 'first', label: 'First person', title: 'Written as "I reach for the letter"' },
		{ value: 'second', label: 'Second person', title: 'Written as "You reach for the letter"' },
		{
			value: 'third',
			label: 'Third person',
			title: speaker
				? `Written as "${speaker} reaches for the letter"`
				: 'Written as "they reach for the letter"'
		}
	]);

	// The model the engine's own connection resolves to: the encoding the estimate counts
	// under, and the name its tooltip says the price is for.
	let engineModel = $derived(llmService.modelFor({ engine: kind }));

	/** What the next press will cost, counted off the EXACT messages a run would send
	 *  (the service's own builder), so the number can never drift from the request, then
	 *  scaled by that model's learned calibration like every other meter in the app. */
	let estimatedTokens = $derived.by(() => {
		if (phase !== 'setup') return 0;
		const messages = buildComposerTransformPrompt({ kind, draft: original, chatMessages, perspective });
		return Math.round(countMessages(messages, engineModel) * tokenCalibration.ratioFor(engineModel));
	});

	let segments = $derived(phase === 'ready' && kind === 'spellcheck' ? diffWords(original, proposed) : []);
	let unchanged = $derived(phase === 'ready' && proposed === original);

	/** Runs of changed text, not changed tokens: a substitution is one fix, not two. */
	let fixCount = $derived.by(() => {
		let count = 0;
		let inRun = false;
		for (const segment of segments) {
			if (segment.type === 'equal') inRun = false;
			else if (!inRun) {
				inRun = true;
				count += 1;
			}
		}
		return count;
	});

	// One muted line in the head, saying whatever the phase makes worth saying: the price
	// before a call, the size of the change after one.
	let headNote = $derived.by(() => {
		if (phase === 'setup') return estimatedTokens > 0 ? `~${estimatedTokens.toLocaleString()} tokens` : '';
		if (phase !== 'ready' || kind !== 'spellcheck') return '';
		if (unchanged) return 'nothing to change';
		return `${fixCount} ${fixCount === 1 ? 'fix' : 'fixes'}`;
	});

	// A held request has not been made yet, so the strip says what is actually happening
	// rather than claiming work that is still waiting on a press.
	let runningNote = $derived(
		promptHoldStore.holding
			? 'Waiting for your review…'
			: kind === 'spellcheck'
				? 'Correcting your draft…'
				: 'Ghostwriting your message…'
	);

	let staleResult = $derived(kind === 'impersonate' && perspective !== ranPerspective);
	let rewriteTitle = $derived.by(() => {
		if (kind === 'spellcheck') return 'Check the draft again';
		const picked = perspectiveOptions.find((o) => o.value === perspective)?.label ?? 'first person';
		return staleResult ? `Write it again in ${picked.toLowerCase()}` : 'Write another take';
	});

	async function run(): Promise<void> {
		abortController?.abort();
		abortController = new AbortController();
		const signal = abortController.signal;
		const asked = perspective;
		phase = 'running';
		try {
			const result = await runComposerTransform({
				kind,
				draft: original,
				chatMessages,
				perspective: kind === 'impersonate' ? asked : undefined,
				signal
			});
			if (signal.aborted) return; // superseded by a re-run or the panel closing
			// Cancelled at the prompt review: nothing was spent, so this lands exactly where a
			// stop does, on the press that would try again.
			if (result === null) {
				phase = 'setup';
				return;
			}
			proposed = result;
			ranPerspective = asked;
			phase = 'ready';
		} catch (error) {
			if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
			errorMessage = failureText(kind === 'spellcheck' ? 'check the draft' : 'write the message', error);
			phase = 'error';
		}
	}

	onMount(() => {
		perspective = chatStore.featureState(chatId).impersonatePerspective;
		ranPerspective = perspective;
		// Spellcheck's own menu row was the press; there is nothing here to decide first.
		// Unless its prompt is held: the review would then arrive over a strip the reader
		// never saw, and cancelling it would land them on a button that had not existed yet.
		// A held gate says they want a step before the call, so this is that step.
		if (kind === 'spellcheck' && !promptHoldStore.armed('spellcheck')) void run();
		return () => abortController?.abort();
	});

	// Escape closes the strip, marked consumed so the shell's own Escape doesn't also
	// close the panel hosting this chat (shell Esc contract, architecture/ui-shell-settings.md).
	$effect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			close();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	/** Picking a perspective persists it and calls nothing. The button spends, never a pill. */
	function pickPerspective(value: string): void {
		perspective = value as ImpersonatePerspective;
		void chatStore.setImpersonatePerspective(chatId, perspective);
	}

	/** Stop drops the request and lands in `setup`, where the same press starts another:
	 *  a stopped call must not leave the strip with nothing to act on. */
	function stop(): void {
		abortController?.abort();
		abortController = null;
		phase = 'setup';
	}

	function close(): void {
		abortController?.abort();
		onClose();
	}
</script>

<section class="transform-panel surface-float" aria-label={engine.name}>
	<div class="head">
		<Icon name={engine.icon} class="w-3.5 h-3.5 shrink-0 text-text-muted" />
		<span class="head-title font-ui">{engine.name}</span>
		{#if headNote}
			<span
				class="head-note font-ui"
				title={phase === 'setup' && engineModel ? `Estimated for ${engineModel}` : undefined}
			>
				{headNote}
			</span>
		{/if}
		<button
			type="button"
			class="head-close"
			aria-label="Close and keep the draft"
			title="Keep the draft as it is (Esc)"
			onclick={close}
		>
			<Icon name="close" class="w-4 h-4" />
		</button>
	</div>

	{#if phase === 'running'}
		<div class="body body--state font-ui" aria-live="polite">
			<Icon name="refresh" class="w-4 h-4 animate-spin shrink-0" />
			<span>{runningNote}</span>
		</div>
	{:else if phase === 'error'}
		<div class="body body--state body--error font-ui" aria-live="polite">
			<Icon name="warning" class="w-4 h-4 shrink-0" />
			<span>{errorMessage}</span>
		</div>
	{:else if phase === 'ready'}
		<!-- Spellcheck reads as a redline over the user's own text; Impersonate reads as the
		     message it wrote, since diffing a full message against the note behind it is noise. -->
		<div class="body panel-scroll" aria-live="polite">
			{#if kind === 'spellcheck'}
				{#each segments as seg, i (i)}
					{#if seg.type === 'equal'}<span>{seg.text}</span>{:else if seg.type === 'removed'}<del
							class="seg-removed">{seg.text}</del>{:else}<ins class="seg-added">{seg.text}</ins>{/if}
				{/each}
			{:else}
				{proposed}
			{/if}
		</div>
	{/if}

	<div class="foot">
		{#if kind === 'impersonate'}
			<div class="opts" class:opts--inert={phase === 'running'} inert={phase === 'running'}>
				<span class="opts-label font-ui">Perspective</span>
				<PillRow
					options={perspectiveOptions}
					current={perspective}
					onpick={pickPerspective}
					label="Perspective"
				/>
			</div>
		{/if}

		<div class="acts">
			{#if phase === 'running'}
				<Button variant="secondary" size="sm" onclick={stop}>Stop</Button>
			{:else if phase === 'setup'}
				<!-- svelte-ignore a11y_autofocus -->
				<Button variant="primary" size="sm" autofocus onclick={() => void run()}>
					{kind === 'spellcheck' ? 'Check the draft' : 'Ghostwrite'}
				</Button>
			{:else if phase === 'error'}
				<!-- svelte-ignore a11y_autofocus -->
				<Button variant="primary" size="sm" autofocus onclick={() => void run()}>Try again</Button>
			{:else}
				<button
					type="button"
					class="rewrite"
					class:rewrite--stale={staleResult}
					aria-label={rewriteTitle}
					title={rewriteTitle}
					onclick={() => void run()}
				>
					<Icon name="refresh" class="w-4 h-4" />
				</button>
				{#if unchanged}
					<!-- svelte-ignore a11y_autofocus -->
					<Button variant="primary" size="sm" autofocus onclick={close}>Close</Button>
				{:else}
					<!-- svelte-ignore a11y_autofocus -->
					<Button variant="primary" size="sm" autofocus onclick={() => onApprove(proposed)}>Use it</Button>
				{/if}
			{/if}
		</div>
	</div>
</section>

<style>
	/* Sits in the composer's own column, directly over it: a raised surface in normal
	   flow, so it shortens the transcript instead of covering the story. */
	.transform-panel {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
		padding: 0.5rem 0.55rem 0.55rem;
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-md);
		animation: transformPanelIn 180ms ease-out;
	}

	@keyframes transformPanelIn {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.head-title {
		font-size: 0.76rem;
		font-weight: 640;
		color: var(--color-text-primary);
	}

	.head-note {
		margin-left: auto;
		font-size: 0.7rem;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	/* Last in the row, so with no note the title and this sit at the two ends. */
	.head-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		margin-left: 0.15rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.head-close:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	.head-note + .head-close {
		margin-left: 0;
	}

	.head-title + .head-close {
		margin-left: auto;
	}

	/* The proposal, in the story's own font: this is text that is about to be a message.
	   pre-wrap keeps the draft's line breaks. */
	.body {
		padding: 0.6rem 0.7rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
		font-family: var(--font-body);
		font-size: 0.92rem;
		line-height: 1.65;
		color: var(--color-text-primary);
		white-space: pre-wrap;
		overflow-wrap: break-word;
		max-height: min(34vh, 20rem);
		overscroll-behavior: contain;
	}

	/* Waiting and failing are chrome, not story text: same box, UI voice. */
	.body--state {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.body--error {
		border-color: color-mix(in srgb, var(--color-error) 30%, transparent);
		background: color-mix(in srgb, var(--color-error) 10%, transparent);
		color: var(--color-error);
	}

	.seg-removed {
		background: color-mix(in srgb, var(--color-error) 14%, transparent);
		color: var(--color-error);
		text-decoration: line-through;
		text-decoration-thickness: 1px;
		border-radius: 3px;
	}

	.seg-added {
		background: color-mix(in srgb, var(--color-success) 16%, transparent);
		color: var(--color-text-primary);
		text-decoration: none;
		border-radius: 3px;
	}

	/* Choices left, actions right, and both wrap as a unit on a narrow screen. */
	.foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.opts {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
		flex-wrap: wrap;
	}

	/* Dimmed while a call is out: the pick can't change what is already being written,
	   and re-picking mid-run would only read as a way to spend twice. */
	.opts--inert {
		opacity: 0.45;
	}

	.opts-label {
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.acts {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-left: auto;
	}

	.rewrite {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.85rem;
		height: 1.85rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.rewrite:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	/* The result on screen is in a different person from the one now picked: the only
	   button that fixes that says so, rather than the strip quietly re-running itself. */
	.rewrite--stale {
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
	}

	@media (pointer: coarse) {
		.head-close,
		.rewrite {
			width: 2.3rem;
			height: 2.3rem;
		}
	}
</style>
