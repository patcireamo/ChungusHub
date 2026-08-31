<script lang="ts">
	/**
	 * The composer's steering surface, and the ONLY one: everything a note can be has to be
	 * reachable from here. Two views: the stack of notes steering the next reply, and one
	 * note's editor (the shared SteeringNoteEditor).
	 *
	 * Its quick box is the cheap half of exactly one axis: guidance that rides one request
	 * and deletes itself. Everything configurable about a note (lifetime, scope, placement,
	 * a name) belongs to the editor, which is one click away, so the box carries no controls
	 * of its own at all.
	 *
	 * It renders the panel only; the trigger button, its active dot and the click-away
	 * backdrop stay in InputArea, which owns the open state and the composer's own button
	 * recipe.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import SteeringNoteEditor from '$lib/components/chat/SteeringNoteEditor.svelte';
	import { autoResize } from '$lib/actions/autoResize';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { steeringStore } from '$lib/stores/steering.svelte';
	import { bindingLabel } from '$lib/utils/steering-labels';
	import { noteLabel, steeringTargetForChat, type SteeringScope } from '$lib/types/steering';

	let chat = $derived(chatStore.activeChat);
	let target = $derived(steeringTargetForChat(chat));
	// The list shows every note bound here, on or off; `activeCount` is the subset that
	// actually injects, which is what the header counts.
	let scoped = $derived(steeringStore.scopedFor(target));
	let activeCount = $derived(steeringStore.activeFor(target).length);
	let history = $derived(chat ? chatStore.featureState(chat.id).steeringHistory : []);

	// Which note's editor is open; null = the stack list.
	let editingId = $state<string | null>(null);
	let editing = $derived(editingId ? steeringStore.getNote(editingId) : null);

	// The quick box: guidance for THIS reply and nothing more. Deliberately one-shot with no
	// lifetime picker and no commit button: anything that outlives one request is what the
	// editor below is for, and duplicating it here with a mode pill only made the cheap
	// action look like the expensive one. Write, it fires, it's gone.
	let quickText = $state('');

	// A chat switch under the popover invalidates both views: the editor may hold a note
	// bound to the chat we just left.
	let seenChatId: string | null = null;
	$effect(() => {
		const id = chatStore.activeChatId;
		if (id === seenChatId) return;
		seenChatId = id;
		editingId = null;
		quickText = '';
	});

	/** Where a fresh note goes: the story you're in, or globally when there is none, since
	 *  global is the only scope that resolves without a chat. */
	function freshScope(): { scope: SteeringScope; scopeId: string | null } {
		return chat ? { scope: 'chat', scopeId: chat.id } : { scope: 'global', scopeId: null };
	}

	async function addQuick() {
		const text = quickText.trim();
		if (!text) return;
		// Always one-shot, always the inherited placement: this box exists to steer the next
		// request, so the two knobs it could offer both belong to the editor instead.
		await steeringStore.create({ text, ...freshScope(), mode: 'once' });
		quickText = '';
	}

	/** Commit what is sitting in the quick box, called by InputArea's close before this
	 *  panel unmounts. The box holds real guidance the user typed; letting it die with the
	 *  component made "write a line, click back into the composer, send" silently steer
	 *  nothing at all. Only an explicit close routes through here. A chat switch discards
	 *  instead, which is what the effect below is for: it would bind to the wrong story. */
	export function commitQuick(): void {
		void addQuick();
	}

	function handleQuickKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		void addQuick();
	}

	async function newNote() {
		const note = await steeringStore.create({ text: '', ...freshScope(), mode: 'pinned' });
		editingId = note.id;
	}
</script>

<div class="steering-popover surface-float">
	{#if editing}
		<div class="pop-body panel-scroll">
			<SteeringNoteEditor
				note={editing}
				rows={4}
				maxHeight={180}
				onback={() => (editingId = null)}
				ondeleted={() => (editingId = null)}
			/>
		</div>
	{:else}
		<div class="pop-head">
			<span class="pop-title font-ui">Steering</span>
			<span class="pop-count font-ui">
				{#if scoped.length}
					{activeCount} of {scoped.length} on
				{:else}
					nothing set
				{/if}
			</span>
		</div>

		<!-- Both lists live in the one scroller, so however many notes and reused lines
		     pile up they take space from each other and never from the panel. -->
		<div class="pop-body panel-scroll">
			{#if scoped.length}
				<div class="stack">
					{#each scoped as note (note.id)}
						<div class="row" class:row--off={!note.enabled}>
							<Toggle
								checked={note.enabled}
								size="sm"
								label={note.enabled ? 'Disable this note' : 'Enable this note'}
								onchange={(on) => steeringStore.update(note.id, { enabled: on })}
							/>
							<button type="button" class="row-main" onclick={() => (editingId = note.id)}>
								<span class="row-title font-ui">{noteLabel(note)}</span>
								<span class="row-scope font-ui">
									{bindingLabel(note)}{#if note.mode === 'once'}<span class="row-once">next reply</span>{/if}
								</span>
							</button>
							<!-- Straight delete, no dialog: the editor's own Delete has never asked
							     either, and a note is one line of guidance, not a document. -->
							<button
								type="button"
								class="row-del"
								aria-label="Delete steering"
								title="Delete"
								onclick={() => steeringStore.remove(note.id)}
							>
								<Icon name="trash" class="w-3 h-3" />
							</button>
						</div>
					{/each}
				</div>
			{:else}
				<p class="empty">No guidance here yet. Type below to steer the next reply.</p>
			{/if}

			{#if history.length > 0}
				<div class="history">
					<span class="field-label font-ui">Recent</span>
					{#each history as entry (entry)}
						<button type="button" class="hist-row" title={entry} onclick={() => (quickText = entry)}>
							{entry}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Under the Recent list it fills, and outside the scroller: the cheap action is
		     never the one you have to scroll for. -->
		<div class="quick">
			<span class="field-label font-ui">Steer the next reply</span>
			<textarea
				class="quick-box"
				rows="2"
				bind:value={quickText}
				use:autoResize={{ maxHeight: 140, value: quickText, grip: false }}
				onkeydown={handleQuickKeydown}
				placeholder="Rides the next request, then it's gone…"
			></textarea>
		</div>

		<div class="foot">
			<button type="button" class="foot-link font-ui" onclick={newNote}>
				<Icon name="plus" class="w-3 h-3" />
				New steering
			</button>
		</div>
	{/if}
</div>

<style>
	.steering-popover {
		/* Anchored to the trigger's left edge, which sits ~6rem into the viewport on
		   phones (menu + attach buttons before it), so the clamp keeps the right edge
		   on-screen there instead of assuming the anchor is at the viewport's left. */
		width: min(23rem, calc(100vw - 6.5rem));
		/* It grows upward from the composer, so without a ceiling its own head leaves the
		   top of the screen and the stack goes with it. dvh rather than vh: a static one
		   over-measures under mobile browser chrome. */
		max-height: min(26rem, 60dvh);
		padding: 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	/* The lists take whatever the fixed rows leave, and scroll inside it. */
	.pop-body {
		flex: 0 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		overscroll-behavior: contain;
	}

	.pop-head,
	.quick,
	.foot {
		flex: none;
	}

	.pop-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.pop-title {
		font-size: 0.76rem;
		font-weight: 640;
		color: var(--color-text-primary);
	}

	.pop-count,
	.empty {
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.empty {
		margin: 0;
		font-family: var(--font-body);
		font-style: italic;
	}

	/* ===== the stack ===== */

	.stack {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.3rem;
		border-radius: var(--radius-sm);
	}

	.row:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
	}

	/* A note switched off stays legible: it is still the rule you wrote, just idle. */
	.row--off .row-main {
		opacity: 0.5;
	}

	.row-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.05rem;
		text-align: left;
		cursor: pointer;
	}

	.row-title {
		max-width: 100%;
		font-size: 0.76rem;
		font-weight: 600;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-scope {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		max-width: 100%;
		font-size: 0.65rem;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-once {
		color: var(--color-accent);
	}

	.row-once::before {
		content: '·';
		margin-right: 0.35rem;
		color: var(--color-text-muted);
	}

	/* Out of the way until the row is under the pointer, but never out of the tab
	   order: focus brings it back on its own. */
	.row-del {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.2rem;
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		opacity: 0;
		cursor: pointer;
		transition: opacity 120ms ease, color 120ms ease;
	}

	.row:hover .row-del,
	.row-del:focus-visible {
		opacity: 1;
	}

	.row-del:hover {
		color: var(--color-error);
	}





	/* ===== quick add, history, foot ===== */

	.field-label {
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.quick {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	/* No resize grip. See `autoResize`'s `grip: false`: this panel is anchored to its
	   bottom edge, so a bottom-right handle grows the box away from the pointer. */
	.quick-box {
		width: 100%;
		padding: 0.45rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-primary) 65%, transparent);
		color: var(--color-text-primary);
		font-family: var(--font-body);
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.quick-box:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	.quick-box::placeholder {
		color: var(--color-text-muted);
	}

	.history {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding-top: 0.45rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.hist-row {
		text-align: left;
		padding: 0.2rem 0.3rem;
		border-radius: var(--radius-sm);
		color: var(--color-text-secondary);
		font-family: var(--font-body);
		font-size: 0.75rem;
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.hist-row:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
		color: var(--color-text-primary);
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-top: 0.45rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.foot-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.15rem 0.25rem;
		border-radius: var(--radius-sm);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease;
	}

	.foot-link:hover {
		color: var(--color-text-primary);
	}
</style>
