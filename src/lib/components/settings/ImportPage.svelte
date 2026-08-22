<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Alert from '$lib/components/ui/Alert.svelte';
	import SillyTavernPlan from './SillyTavernPlan.svelte';
	import { importRun } from '$lib/stores/import-run.svelte';

	let folderInput = $state<HTMLInputElement | undefined>(undefined);

	// The run outlives this card: closing Settings unmounts it while the import keeps writing,
	// so its state is read off the store. Progress itself is the standing row's (layout/ImportBar),
	// which is on screen whether or not this page is, and stating it twice would only teach the
	// eye to skip both. What this page owns is the summary afterwards.
	let importing = $derived(importRun.running);
	let pending = $derived(importRun.pending);
	let report = $derived(importRun.report);

	// While this card is on screen the run's finish toast stands down: the summary below says
	// the same thing, in more detail, right where the reader is already looking.
	$effect(() => importRun.watch());

	// <input webkitdirectory> is a non-standard attribute the type system doesn't know;
	// set it on the element directly so the picker selects a whole folder.
	$effect(() => {
		if (folderInput) folderInput.webkitdirectory = true;
	});

	function handleFolder(event: Event): void {
		const input = event.target as HTMLInputElement;
		const files = input.files ? Array.from(input.files) : [];
		input.value = '';
		if (files.length === 0) return;
		void importRun.scan(files);
	}

	// How many files Import would write: the pick, minus what has come over before, minus
	// whatever the reader switched off. The button carries it, so the card always states the
	// number it is about to act on.
	let planned = $derived(importRun.planned);

	interface Line {
		label: string;
		result: { imported: number; failed: string[] };
		extra?: string;
	}

	let reportLines = $derived<Line[]>(
		report
			? [
					{ label: 'Characters', result: report.characters },
					{ label: 'Sprites', result: report.sprites },
					{ label: 'Personas', result: report.personas },
					{ label: 'Chats', result: report.chats },
					{ label: 'Lorebooks', result: report.worlds },
					{ label: 'Backgrounds', result: report.backgrounds }
				]
			: []
	);
</script>

<div class="import">
	<!-- SillyTavern -->
	<section class="card">
		<div class="card-head">
			<span class="card-title">SillyTavern</span>
			<InfoTip
				text="Everything is read straight from disk in your browser. Nothing is uploaded anywhere but your own ChungusHub."
			/>
		</div>
		<div class="card-body">
			<p class="lede font-ui">
				Point this at your SillyTavern profile folder, <code>data/default-user</code>. It all comes
				over in one pass, or you can leave parts of it behind before the run starts.
			</p>

			<ul class="what font-ui">
				<li><Icon name="user" class="w-3.5 h-3.5" /> Characters (linked lorebooks too)</li>
				<li><Icon name="image" class="w-3.5 h-3.5" /> Sprites, named after their filenames</li>
				<li><Icon name="users" class="w-3.5 h-3.5" /> Personas (name + description from settings)</li>
				<li><Icon name="chat" class="w-3.5 h-3.5" /> Chats (swipes preserved as branches)</li>
				<li><Icon name="scroll" class="w-3.5 h-3.5" /> Worlds / lorebooks</li>
				<li><Icon name="image" class="w-3.5 h-3.5" /> Backgrounds</li>
			</ul>

			<Button variant="primary" size="sm" disabled={importing} onclick={() => folderInput?.click()}>
				<Icon name="folder" class="w-3.5 h-3.5" />
				{importing ? 'Importing…' : 'Choose SillyTavern folder'}
			</Button>

			<Alert message={importRun.error} />

			{#if pending}
				<div class="report">
					<SillyTavernPlan root={pending.root} />

					<!-- One fixed sentence naming what ticking the box does, never a report of what
					     the box is currently doing: a label that swaps meaning on click leaves the
					     reader unable to tell the state from the effect. The counts above answer the
					     state, since they are the plan. -->
					{#if importRun.alreadyImported > 0}
						<label class="again font-ui">
							<input type="checkbox" bind:checked={importRun.bringKnownAgain} />
							<span>
								Include the {importRun.alreadyImported === 1
									? 'file'
									: `${importRun.alreadyImported} files`} this folder has already sent
							</span>
						</label>
						{#if importRun.bringKnownAgain}
							<p class="again-note font-ui">
								Anything you still have arrives a second time, as a copy.
							</p>
						{/if}
					{/if}

					<div class="found-actions">
						<Button
							variant="primary"
							size="sm"
							disabled={planned === 0}
							onclick={() => importRun.start()}
						>
							Import {planned} file{planned === 1 ? '' : 's'}
						</Button>
						<Button variant="secondary" size="sm" onclick={() => importRun.discard()}>
							Cancel
						</Button>
					</div>
				</div>
			{/if}

			{#if report}
				<div class="report">
					<span class="section-label">Import summary</span>

					{#if importRun.stoppedBy === 'you'}
						<p class="note font-ui">
							Stopped. Choose the same folder again to bring over what is left.
						</p>
					{:else if importRun.stoppedBy === 'connection'}
						<p class="note font-ui">
							Stopped: the server went away. Choose the same folder again once it is back and the
							rest comes over.
						</p>
					{/if}
					{#if report.ledgerLost > 0}
						<p class="note font-ui">
							{report.ledgerLost}
							{report.ledgerLost === 1 ? 'file' : 'files'} came over but could not be marked as imported.
							Choosing this folder again brings them a second time.
						</p>
					{/if}
					<ul class="report-list font-ui">
						{#each reportLines as line (line.label)}
							<li>
								<span class="report-label">{line.label}</span>
								<span class="report-count">{line.result.imported} imported</span>
								{#if line.result.failed.length > 0}
									<span class="report-fail">{line.result.failed.length} failed</span>
								{/if}
							</li>
						{/each}
					</ul>

					{#if report.chats.skippedNoCharacter.length > 0}
						<p class="note font-ui">
							{report.chats.skippedNoCharacter.length} chat{report.chats.skippedNoCharacter.length ===
							1
								? ''
								: 's'} skipped, no matching character in the library. Import the character first, then
							re-run.
						</p>
					{/if}

					{#if report.sprites.skippedNoCharacter.length > 0}
						<p class="note font-ui">
							{report.sprites.skippedNoCharacter.length} sprite folder{report.sprites
								.skippedNoCharacter.length === 1
								? ''
								: 's'} skipped, no matching character in the library. Import the character first, then
							re-run.
						</p>
					{/if}

					{#each reportLines as line (line.label)}
						{#if line.result.failed.length > 0}
							<details class="fails">
								<summary class="font-ui">{line.label} failures ({line.result.failed.length})</summary>
								<ul class="font-mono">
									{#each line.result.failed as f (f)}
										<li>{f}</li>
									{/each}
								</ul>
							</details>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</section>

</div>

<input bind:this={folderInput} type="file" class="hidden" onchange={handleFolder} multiple />

<style>
	.import {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.card-body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		align-items: flex-start;
	}

	.lede {
		font-size: 0.82rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
	}

	.lede code {
		font-family: var(--font-mono);
		font-size: 0.78em;
		padding: 0.05rem 0.3rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
	}

	.what {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.8rem;
		color: var(--color-text-secondary);
	}

	.what li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.what :global(svg) {
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	.report {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		width: 100%;
		margin-top: 0.35rem;
		padding-top: 0.75rem;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 45%, transparent);
	}

	.report-list {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.report-list li {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		font-size: 0.8rem;
	}

	.report-label {
		min-width: 6.5rem;
		color: var(--color-text-secondary);
		font-weight: 600;
	}

	.report-count {
		color: var(--color-text-primary);
	}

	.report-fail {
		color: var(--color-error);
		font-size: 0.74rem;
	}

	.found-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.again {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.again input {
		margin-top: 0.15rem;
		accent-color: var(--color-accent);
		cursor: pointer;
	}

	/* Lined up under the label's text rather than under its box, so it reads as that
	   checkbox's consequence and not as another line of the card. */
	.again-note {
		margin: -0.25rem 0 0;
		padding-left: 1.25rem;
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	.note {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		line-height: 1.45;
	}

	.fails {
		font-size: 0.75rem;
	}

	.fails summary {
		cursor: pointer;
		color: var(--color-text-secondary);
	}

	.fails ul {
		margin: 0.4rem 0 0;
		padding-left: 1rem;
		color: var(--color-text-muted);
		font-size: 0.72rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

</style>
