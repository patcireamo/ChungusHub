<script lang="ts">
	/**
	 * The prompt hold's review surface: the request one press away from going out, whole and
	 * editable, with two ways out and no third.
	 *
	 * **What is approved is what is sent.** The array handed back is the array that goes on the
	 * wire, so nothing here previews, samples or reassembles: the editor works on the built
	 * messages themselves and the Send button passes them straight on. Cancel writes nothing
	 * anywhere, which is what lets the gate sit above every write its caller would do.
	 *
	 * Two views of one document. **Pretty** edits what a message SAYS, a card at a time, and
	 * can drop a message; **JSON** edits what the request IS, structure included. They are not
	 * two states: the JSON view parses into the same working copy on every keystroke, so a
	 * switch back is instant and the Send button is deciding about one thing either way. A
	 * document that will not parse names its fault and holds Send, rather than sending a
	 * request the reader cannot have meant.
	 *
	 * Cards open closed. A prompt is a dozen blocks and one of them is usually the whole preset,
	 * so the list is a map first and an editor second: sizes on every row make "what is actually
	 * in here" answerable without scrolling past a system block to reach the chat.
	 *
	 * The dialog is deliberately NOT dismissible: a backdrop click that threw away five minutes
	 * of editing would be the app's most expensive misclick. Escape still cancels, from this
	 * component's own listener, which is the same shape `TransformPanel` uses.
	 */
	import Dialog from '$lib/components/ui/Dialog.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import CopyButton from '$lib/components/debug/CopyButton.svelte';
	import PromptReviewCard from './PromptReviewCard.svelte';
	import { promptHoldStore } from '$lib/stores/promptHold.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { llmService } from '$lib/services/llm/provider';
	import { countTokens, tokenCalibration } from '$lib/tokenizer';
	import { parsePromptJson, promptToJson, sameMessage, samePrompt } from '$lib/utils/prompt-review';
	import type { LLMMessage } from '$lib/types/llm';

	let pending = $derived(promptHoldStore.pending);

	/** The working copy. Everything on screen and everything Send hands over reads from here,
	 *  including the JSON view, which parses into it rather than beside it. */
	let messages = $state<LLMMessage[]>([]);
	let collapsed = $state<boolean[]>([]);
	let mode = $state<'pretty' | 'json'>('pretty');
	let jsonText = $state('');
	let jsonError = $state('');
	/** Whether the JSON view breaks long lines. On by default, because one system block is a
	 *  single line thousands of characters long and a horizontal scrollbar over that is not a
	 *  way to read it. Deliberately NOT reset per request and deliberately not a stored
	 *  setting: it is how the reader likes to look at JSON, remembered while the app is open. */
	let wrap = $state(true);
	/** Per-message token counts, calibrated. Filled by the pass below, not per render. */
	let sizes = $state<number[]>([]);

	/** Which request the copy above was taken from, and whether it has been measured once. */
	let loadedId = '';
	let measured = false;

	// Before the DOM, not after it: seeding in an ordinary effect would paint one frame of an
	// empty review over the request that just arrived.
	$effect.pre(() => {
		const held = promptHoldStore.pending;
		if (!held || held.id === loadedId) return;
		loadedId = held.id;
		measured = false;
		messages = held.messages.map((message) => ({ ...message }));
		collapsed = held.messages.map(() => true);
		sizes = [];
		mode = 'pretty';
		jsonText = '';
		jsonError = '';
	});

	let model = $derived(pending ? llmService.modelFor(pending.target) : '');
	let contents = $derived(messages.map((message) => message.content));

	// Read eagerly, counted after a pause: BPE over a whole prompt on every keystroke is the
	// one thing that could make this panel feel slow. The first pass runs immediately, so the
	// head opens with real numbers rather than zeros.
	$effect(() => {
		const list = contents;
		const target = model;
		const timer = setTimeout(
			() => {
				const ratio = tokenCalibration.ratioFor(target);
				sizes = list.map((text) => Math.round(countTokens(text, target) * ratio));
				measured = true;
			},
			measured ? 200 : 0
		);
		return () => clearTimeout(timer);
	});

	let total = $derived(sizes.reduce((sum, count) => sum + count, 0));
	let edited = $derived(pending ? !samePrompt(messages, pending.messages) : false);
	let allOpen = $derived(collapsed.length > 0 && collapsed.every((shut) => !shut));

	/** The one thing standing between the reader and Send, in either view. */
	let blocker = $derived(jsonError || (messages.length === 0 ? 'The request has no messages left.' : ''));

	let note = $derived(
		pending?.gate.id === 'send'
			? 'Edits change this request only. Your message is stored in the chat as you typed it.'
			: 'Edits change this request only.'
	);

	/** A message the built request did not have is new, and so edited by definition. */
	function messageEdited(index: number): boolean {
		const original = pending?.messages[index];
		return !original || !sameMessage(messages[index], original);
	}

	function editMessage(index: number, content: string): void {
		messages[index] = { ...messages[index], content };
	}

	function removeMessage(index: number): void {
		messages = messages.filter((_, i) => i !== index);
		collapsed = collapsed.filter((_, i) => i !== index);
		sizes = sizes.filter((_, i) => i !== index);
	}

	function toggleAll(): void {
		collapsed = collapsed.map(() => allOpen);
	}

	function showJson(): void {
		jsonText = promptToJson(messages);
		jsonError = '';
		mode = 'json';
	}

	function readJson(text: string): void {
		jsonText = text;
		const parsed = parsePromptJson(text);
		jsonError = parsed.ok ? '' : parsed.error;
		if (!parsed.ok) return;
		messages = parsed.messages;
		// Folding is the reader's, so a message that was already here keeps how they left it.
		collapsed = parsed.messages.map((_, i) => collapsed[i] ?? true);
	}

	function reset(): void {
		if (!pending) return;
		messages = pending.messages.map((message) => ({ ...message }));
		collapsed = messages.map(() => true);
		if (mode === 'json') jsonText = promptToJson(messages);
		jsonError = '';
	}

	function send(): void {
		if (blocker) return;
		promptHoldStore.approve($state.snapshot(messages) as LLMMessage[]);
	}

	// Escape cancels and mod+Enter sends, both marked consumed so the shell's own Escape ladder
	// does not also act on this press (architecture/ui-shell-settings.md). On the CAPTURE phase,
	// which is what makes "the top-most surface owns Escape" true here rather than "whichever
	// surface mounted first does": the review can be raised over a composer strip that carries
	// its own Escape, and that strip closing underneath would leave this request with nothing
	// left to answer it.
	$effect(() => {
		if (!pending) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				promptHoldStore.cancel();
			} else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				send();
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});
</script>

{#if pending}
	<Dialog open={true} onClose={() => promptHoldStore.cancel()} size="2xl" dismissible={false} bare fill>
		<div class="review">
			<div class="head">
				<div class="identity">
					<Icon name={pending.gate.icon} class="w-4 h-4 shrink-0 text-text-secondary" />
					<h2 class="title">Review this prompt</h2>
					<span class="gate">{pending.gate.name}</span>
					<span class="spacer"></span>
					<!-- Grouped so a phone can drop the pair onto its own line whole, the same rule
					     the debug panel's head follows: the controls never shrink, the name does. -->
					<div class="tools">
						<div class="seg">
							<button
								class="seg-btn"
								class:on={mode === 'pretty'}
								type="button"
								disabled={mode === 'json' && jsonError !== ''}
								title={jsonError ? 'Fix the JSON first' : 'Edit message by message'}
								onclick={() => (mode = 'pretty')}
							>
								Pretty
							</button>
							<button class="seg-btn" class:on={mode === 'json'} type="button" onclick={showJson}>
								JSON
							</button>
						</div>
						{#if mode === 'pretty'}
							<button
								class="fold"
								type="button"
								onclick={toggleAll}
								title={allOpen ? 'Collapse every message' : 'Open every message'}
								aria-label={allOpen ? 'Collapse every message' : 'Open every message'}
							>
								<Icon name={allOpen ? 'chevronUp' : 'chevronDown'} class="w-4 h-4" strokeWidth={2} />
							</button>
						{:else}
							<button
								class="wrap-btn"
								class:on={wrap}
								type="button"
								aria-pressed={wrap}
								onclick={() => (wrap = !wrap)}
								title={wrap ? 'Let long lines run off the edge' : 'Break long lines to fit'}
							>
								Wrap
							</button>
						{/if}
						<CopyButton
							label={viewport.isMobile ? undefined : 'Copy'}
							text={() => promptToJson(messages)}
							title="Copy the whole request as JSON"
						/>
					</div>
				</div>

				<p class="meta">
					{#if model}<span>{model}</span>{/if}
					<span>{messages.length} message{messages.length === 1 ? '' : 's'}</span>
					<span>~{total.toLocaleString()} tokens</span>
				</p>

				<p class="note">{note}</p>
			</div>

			<div class="body" class:body--json={mode === 'json'}>
				{#if mode === 'pretty'}
					{#each messages as message, i (i)}
						<PromptReviewCard
							{message}
							index={i}
							tokens={sizes[i] ?? 0}
							collapsed={collapsed[i] ?? true}
							edited={messageEdited(i)}
							onToggle={() => (collapsed[i] = !collapsed[i])}
							onEdit={(content) => editMessage(i, content)}
							onRemove={() => removeMessage(i)}
						/>
					{/each}
				{:else}
					<textarea
						class="json"
						class:json--nowrap={!wrap}
						value={jsonText}
						spellcheck="false"
						aria-label="The whole request as JSON"
						oninput={(e) => readJson(e.currentTarget.value)}
					></textarea>
				{/if}
			</div>

			<div class="foot">
				<!-- The fault takes its own line rather than the Reset button's place: an emptied
				     request is exactly the state a reader needs that button from. -->
				{#if blocker}
					<p class="blocker" aria-live="polite">
						<Icon name="warning" class="w-3.5 h-3.5 shrink-0" />
						{blocker}
					</p>
				{/if}
				{#if edited}
					<button class="reset" type="button" onclick={reset}>
						<Icon name="refresh" class="w-3.5 h-3.5" />
						Undo my edits
					</button>
				{/if}
				<div class="acts">
					<Button variant="secondary" size="sm" onclick={() => promptHoldStore.cancel()}>Cancel</Button>
					<!-- Deliberately not autofocused: the dialog opens with the keyboard on the head,
					     so a stray Enter reads the prompt rather than sending it. ⌘/Ctrl+Enter is
					     the key that sends, from anywhere in here. -->
					<Button variant="primary" size="sm" disabled={blocker !== ''} onclick={send}>
						{pending.gate.confirm}
					</Button>
				</div>
			</div>
		</div>
	</Dialog>
{/if}

<style>
	/* Head and foot stand still, the middle scrolls: a request is long, and both the identity
	   of what is held and the two ways out have to stay reachable from anywhere in it. */
	.review {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.head {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.7rem 0.85rem 0.55rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.identity {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
	}

	.title {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.9rem;
		font-weight: 640;
		color: var(--color-text-primary);
	}

	/* Which press is being answered, in the gate's own name. */
	.gate {
		flex-shrink: 0;
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-accent) 15%, transparent);
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.03em;
	}

	.spacer {
		flex: 1;
	}

	.tools {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.seg {
		flex-shrink: 0;
		display: inline-flex;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border-subtle);
		overflow: hidden;
	}

	.seg-btn {
		padding: 0.28rem 0.5rem;
		border: 0;
		background: transparent;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.seg-btn:hover:not(:disabled) {
		color: var(--color-text-primary);
	}

	.seg-btn:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}

	.seg-btn.on {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
	}

	/* The ring goes on the group, the focused segment washes accent: the group clips its own
	   corners, so a ring on a segment would survive only as a sliver in the seam. */
	.seg:has(:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.seg-btn:focus-visible {
		outline: none;
		background: color-mix(in srgb, var(--color-accent) 32%, transparent);
	}

	.fold {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.fold:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	/* A word, not a glyph: nothing in the icon set says "break long lines". */
	.wrap-btn {
		flex-shrink: 0;
		padding: 0.28rem 0.5rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.wrap-btn:hover {
		color: var(--color-text-primary);
	}

	.wrap-btn.on {
		color: var(--color-text-primary);
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
	}

	/* One line of figures: who it is for, and how much of it there is. */
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.5rem;
		margin: 0;
		font-family: var(--font-mono, monospace);
		font-size: 0.66rem;
		color: var(--color-text-muted);
		min-width: 0;
	}

	.meta span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.note {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	/* The JSON view is ONE field, so it is the middle rather than something inside it: the
	   body stops scrolling and the textarea keeps the only scrollbar. Two of them over one
	   document is the outer one saying there is more below when there is nothing else there. */
	.body--json {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		padding: 0.6rem 0.7rem;
	}

	/* No height of its own: the dialog fills the room it is allowed and this takes what is
	   left of it, so reading a whole request needs no dragging and a drag handle would have
	   nothing to reach. A card in the Pretty view keeps the handle `autoResize` gives it,
	   because there it is one of many and the body around it really does scroll. */
	.json {
		flex: 1;
		min-height: 6rem;
		width: 100%;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-bg-tertiary) 30%, transparent);
		font-family: var(--font-mono, monospace);
		font-size: 0.74rem;
		line-height: 1.55;
		color: var(--color-text-primary);
		resize: none;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.json--nowrap {
		white-space: pre;
		overflow-wrap: normal;
	}

	.json:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border));
	}

	.foot {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.55rem 0.7rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.blocker {
		flex-basis: 100%;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0;
		min-width: 0;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		line-height: 1.4;
		color: var(--color-error);
	}

	.reset {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.3rem 0.45rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.reset:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 86%, transparent);
		color: var(--color-text-primary);
	}

	.acts {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-left: auto;
	}

	@media (max-width: 640px) {
		/* Its own full-width line under the identity, for the reason the debug panel states:
		   sharing the row squeezes the switch down to unreadable stubs. */
		.tools {
			width: 100%;
			justify-content: flex-end;
		}

		.spacer {
			display: none;
		}
	}

	@media (pointer: coarse) {
		.seg-btn,
		.wrap-btn {
			padding: 0.45rem 0.7rem;
		}

		.fold {
			width: 2.3rem;
			height: 2.3rem;
		}
	}
</style>
