<script lang="ts">
	/**
	 * Bringing picked SillyTavern chat files onto the character the Chats panel is scoped to.
	 *
	 * **There is no character picker here and there must not be one.** A library runs to
	 * thousands of entries, so a dropdown of every character is a list nobody can search their
	 * way through, and the panel already answers the question: the button only exists while the
	 * list is narrowed to somebody, and that somebody is the target. What the files themselves
	 * name is read and shown, but only so a file played with a different character is caught
	 * before it lands, since this app has no undo for a chat grafted onto the wrong story.
	 *
	 * No format logic lives here. The header is read by the format module and the tree is built
	 * by `chatStore.importSillyTavernChat`, the same call the folder importer makes.
	 */
	import Dialog from '$lib/components/ui/Dialog.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { readChatCharacterName } from '$lib/services/sillyTavernChatImport';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';

	interface Props {
		files: File[];
		/** The character the panel is scoped to. Every file lands on them. */
		characterId: string;
		characterName: string;
		onClose: () => void;
	}

	let { files, characterId, characterName, onClose }: Props = $props();

	interface Row {
		id: string;
		file: File;
		lines: string[];
		/** What the file says it was played with, shown beside the filename. */
		characterName: string | null;
		elsewhere: boolean;
	}

	let rows = $state<Row[]>([]);
	let reading = $state(true);
	let busy = $state(false);
	let imported = $state(0);
	/** A picked file that could not be read at all. Held apart from the import failures below
	 *  because it has no row to retry from: folded into one list, the next clean import run
	 *  would clear it and close the dialog on a success that left a file behind. */
	let unreadable = $state<string[]>([]);
	let failures = $state<string[]>([]);
	let problems = $derived([...unreadable, ...failures]);

	let target = $derived(characterName.trim() || 'this character');
	let strays = $derived(rows.filter((row) => row.elsewhere).length);

	function reason(e: unknown): string {
		return e instanceof Error ? e.message : String(e);
	}

	// `files` is handed over once, by the pick that mounted this dialog, so this reads them
	// once and never re-runs.
	$effect(() => {
		void readPicked(files);
	});

	async function readPicked(picked: File[]): Promise<void> {
		const next: Row[] = [];
		const refused: string[] = [];
		const here = characterName.trim().toLowerCase();
		for (const file of picked) {
			try {
				const lines = (await file.text()).split('\n');
				const named = readChatCharacterName(lines);
				next.push({
					id: crypto.randomUUID(),
					file,
					lines,
					characterName: named,
					// A file that names nobody is not a mismatch: it is a file with nothing to
					// disagree with, and flagging it would cry wolf on every chat ST exported
					// without the field.
					elsewhere: named !== null && named.toLowerCase() !== here
				});
			} catch (e) {
				refused.push(`${file.name}: ${reason(e)}`);
			}
		}
		rows = next;
		unreadable = refused;
		reading = false;
	}

	async function runImport(): Promise<void> {
		busy = true;
		const failed: string[] = [];
		const kept: Row[] = [];

		for (const row of rows) {
			try {
				const { chatId } = await chatStore.importSillyTavernChat({
					characterId,
					lines: row.lines
				});
				if (chatId) {
					imported++;
					continue;
				}
				failed.push(`${row.file.name}: no importable messages`);
				kept.push(row);
			} catch (e) {
				failed.push(`${row.file.name}: ${reason(e)}`);
				kept.push(row);
			}
		}

		busy = false;
		failures = failed;
		// Only what did not land stays on the list, so pressing Import again retries those
		// rather than sending the ones that already arrived a second time.
		rows = kept;

		if (problems.length === 0) {
			// The imported chats sort by when they were actually played, so a story from months
			// ago lands well down a list the reader is not even looking at while this dialog is
			// open. That is the toast channel's own case: a count the screen does not show.
			toastStore.success(`Imported ${imported} chat${imported === 1 ? '' : 's'}`);
			onClose();
		}
	}

	function requestClose(): void {
		if (!busy) onClose();
	}
</script>

<Dialog open={true} onClose={requestClose} title="Import chats" size="md">
	{#if reading}
		<div class="loading">
			<Spinner size="sm" />
			<span>Reading the files…</span>
		</div>
	{:else}
		{#if rows.length > 0}
			<p class="lead">
				Each file lands on <strong>{target}</strong> as its own chat, its swipes kept as branches.
			</p>

			<ul class="rows">
				{#each rows as row (row.id)}
					<li class="row">
						<span class="row-name">{row.file.name}</span>
						{#if row.characterName}
							<span class="row-from" class:is-stray={row.elsewhere}>{row.characterName}</span>
						{/if}
					</li>
				{/each}
			</ul>

			{#if strays > 0}
				<p class="note is-stray">
					{strays === 1 ? 'One file was' : `${strays} files were`} played with a different character.
					{strays === 1 ? 'It still lands' : 'They still land'} on {target}.
				</p>
			{/if}
		{/if}

		{#if problems.length > 0}
			<div class="failures">
				<span class="failures-head">
					{problems.length}
					{problems.length === 1 ? 'file' : 'files'} did not come over
					{#if imported > 0}, {imported} did{/if}
				</span>
				<ul>
					<!-- Keyed by position: two files can carry the same name and the same reason,
					     and a duplicate key throws. -->
					{#each problems as line, i (i)}
						<li>{line}</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="actions">
			<Button variant="ghost" onclick={requestClose} disabled={busy}>
				{rows.length === 0 ? 'Close' : 'Cancel'}
			</Button>
			{#if rows.length > 0}
				<Button variant="primary" onclick={runImport} disabled={busy}>
					{busy ? 'Importing…' : `Import ${rows.length} chat${rows.length === 1 ? '' : 's'}`}
				</Button>
			{/if}
		</div>
	{/if}
</Dialog>

<style>
	.loading {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-family: var(--font-ui);
		font-size: 0.82rem;
		color: var(--color-text-secondary);
	}

	.lead {
		font-family: var(--font-ui);
		font-size: 0.82rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.lead strong {
		color: var(--color-text-primary);
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin: 0.9rem 0 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.45rem 0.65rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
	}

	.row-name {
		font-family: var(--font-mono);
		font-size: 0.74rem;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-from {
		flex-shrink: 0;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		color: var(--color-text-muted);
	}

	.is-stray {
		color: var(--color-warning);
	}

	.failures {
		margin-top: 0.9rem;
		padding: 0.6rem 0.7rem;
		border: 1px solid color-mix(in srgb, var(--color-error) 40%, transparent);
		border-radius: var(--radius-lg);
	}

	.failures-head {
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--color-error);
	}

	.failures ul {
		margin: 0.35rem 0 0;
		padding-left: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--color-text-muted);
	}

	.note {
		margin-top: 0.7rem;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.2rem;
	}
</style>
