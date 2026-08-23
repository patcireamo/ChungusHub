<script lang="ts">
	/**
	 * What one lorebook scan decided, read back. The single surface for it: the chat renders it
	 * for the turn a reply carries, the lorebook page's tester renders it for text the reader
	 * typed. Both need the same words, and an entry that fired for one reason here must not read
	 * as a different reason there.
	 *
	 * Presentation only. It never scans, and it never reaches a store.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import {
		LOREBOOK_SCAN_FIELDS,
		lorebookWasInjected,
		type LorebookEntryRecord,
		type LorebookKeyMatch,
		type LorebookStatus,
		type LorebookTrace
	} from '$lib/lorebook/types';

	interface Props {
		trace: LorebookTrace;
	}

	let { trace }: Props = $props();

	/** Why an entry ended where it did, in one line. The only place these are worded. */
	const REASONS: Record<LorebookStatus, string> = {
		constant: 'Always active, no keyword needed',
		keyword: 'Its keyword matched',
		noMatch: 'Nothing matched its keywords',
		filtered: 'A keyword matched, then its filter refused',
		rolledOut: 'Matched, then lost its trigger roll',
		delayed: 'Waits for another entry to wake it, and none did',
		neverFires: 'Its recursion settings leave nothing that can wake it',
		trimmed: 'Fired, then the token budget dropped it',
		disabled: 'Switched off',
		empty: 'Nothing to inject',
		offTrigger: 'This kind of generation is not one it fires on',
		sticky: 'Still held in by the window it opened when it fired',
		cooldown: 'Fired recently, and its window has not reopened',
		tooEarly: 'The chat is not long enough for it yet',
		groupLost: 'Another entry in its group took the slot'
	};

	function reasonFor(record: LorebookEntryRecord): string {
		if (record.status === 'rolledOut' && record.probability != null) {
			return `Matched, then lost its ${record.probability}% roll`;
		}
		if (record.status === 'groupLost' && record.lostTo) {
			return `Lost the “${record.lostTo.group}” group to ${record.lostTo.title || 'another entry'}`;
		}
		return REASONS[record.status];
	}

	/** Where an entry landed, said only when it is not the block everything else went into. */
	function placementOf(record: LorebookEntryRecord): string {
		if (!record.placedAt) return '';
		const { role, depth } = record.placedAt;
		const where = depth === 0 ? 'after the last turn' : `${depth} ${depth === 1 ? 'turn' : 'turns'} back`;
		return `in the chat, ${where}, as ${role}`;
	}

	/** Where a key was found, in the reader's terms. */
	function sourceLabel(match: LorebookKeyMatch, bookName: string): string {
		const source = match.source;
		if (source.kind === 'entry') {
			const woke = source.title || 'another entry';
			// The book is named only when it is not the one this entry lives in: that is the
			// case the reader cannot work out from the row they are looking at.
			return source.bookName && source.bookName !== bookName ? `from ${woke} (${source.bookName})` : `from ${woke}`;
		}
		if (source.kind === 'field') {
			return `in the ${LOREBOOK_SCAN_FIELDS.find((f) => f.id === source.field)?.label.toLowerCase()}`;
		}
		if (source.depth === 0) return 'in the last turn';
		return `${source.depth} ${source.depth === 1 ? 'turn' : 'turns'} back`;
	}

	const injected = $derived(trace.records.filter((r) => lorebookWasInjected(r.status)));
	const held = $derived(trace.records.filter((r) => !lorebookWasInjected(r.status)));

	const summary = $derived.by(() => {
		const parts: string[] = [];
		parts.push(injected.length === 1 ? '1 entry in the prompt' : `${injected.length} entries in the prompt`);
		if (held.length > 0) parts.push(`${held.length} kept out`);
		// "Silent", not "never matched": the count also holds entries that were switched off,
		// empty, or filtered to another generation kind.
		if (trace.silent > 0) parts.push(`${trace.silent} stayed silent`);
		return parts.join(' · ');
	});

	const nothingScanned = $derived(trace.records.length === 0 && trace.silent === 0);
</script>

{#if nothingScanned}
	<!-- Only the tester can land here: the chat hides its pill when a trace is empty, and a
	     scanned book always records every entry it holds. So the one true reading is a book
	     with nothing in it. -->
	<p class="lt-empty">This book has no entries, so a scan has nothing to report.</p>
{:else}
	<p class="lt-summary">{summary}</p>

	{#each [{ label: 'In the prompt', rows: injected }, { label: 'Kept out', rows: held }] as group (group.label)}
		{#if group.rows.length > 0}
			<section class="lt-group">
				<h3 class="section-label">{group.label}</h3>
				<ul class="lt-rows">
					{#each group.rows as record (record.entryId)}
						<li class="lt-row" class:lt-row-in={lorebookWasInjected(record.status)}>
							<span class="lt-dot" aria-hidden="true"></span>
							<div class="lt-body">
								<p class="lt-head">
									<span class="lt-title">{record.title || 'Untitled entry'}</span>
									<span class="lt-book">
										<Icon name="bookOpen" class="w-3 h-3" strokeWidth={1.6} />
										{record.bookName}
									</span>
								</p>
								<p class="lt-reason">
									{reasonFor(record)}
									{#if placementOf(record)}<span class="lt-place">· {placementOf(record)}</span>{/if}
								</p>
								{#if record.matches.length > 0}
									<p class="lt-keys">
										{#each record.matches as match (match.role + match.key)}
											<span class="lt-key" class:lt-key-secondary={match.role === 'secondary'}>
												{match.key}
												<span class="lt-where">{sourceLabel(match, record.bookName)}</span>
											</span>
										{/each}
									</p>
									<p class="lt-excerpt">{record.matches[0].excerpt}</p>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/each}
{/if}

<style>
	.lt-empty,
	.lt-summary {
		font-family: var(--font-ui);
		font-size: 0.82rem;
		color: var(--color-text-muted);
	}

	.lt-summary {
		margin-bottom: 0.9rem;
	}

	.lt-group + .lt-group {
		margin-top: 1.1rem;
	}

	.lt-rows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.45rem;
	}

	.lt-row {
		display: flex;
		gap: 0.6rem;
		padding: 0.55rem 0.7rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-bg-secondary) 55%, transparent);
	}

	/* The one thing a reader scans for: did this entry reach the model. */
	.lt-dot {
		width: 0.5rem;
		height: 0.5rem;
		margin-top: 0.34rem;
		flex-shrink: 0;
		border-radius: var(--radius-full);
		background: var(--color-text-muted);
		opacity: 0.5;
	}

	.lt-row-in .lt-dot {
		background: var(--color-success);
		opacity: 1;
	}

	.lt-body {
		min-width: 0;
		flex: 1;
	}

	.lt-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.lt-title {
		font-family: var(--font-ui);
		font-size: 0.86rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.lt-book {
		display: inline-flex;
		align-items: center;
		gap: 0.24rem;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--color-text-muted);
	}

	.lt-reason {
		margin-top: 0.12rem;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-secondary);
	}

	.lt-keys {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin-top: 0.35rem;
	}

	.lt-key {
		display: inline-flex;
		align-items: baseline;
		gap: 0.3rem;
		padding: 0.1rem 0.45rem;
		border-radius: var(--radius-full);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-accent) 24%, transparent);
	}

	/* Secondary keys filter a decision the primary made, so they never wear the accent. */
	.lt-key-secondary {
		color: var(--color-text-secondary);
		background: color-mix(in srgb, var(--color-text-muted) 12%, transparent);
		border-color: var(--color-border-subtle);
	}

	/* The tiny source label riding a key chip ("2 turns back"). */
	.lt-where {
		font-weight: 500;
		font-size: 0.64rem;
		opacity: 0.75;
	}

	/* The placement clause of a reason line: part of the sentence, so it keeps the
	   sentence's size and only steps back in colour. */
	.lt-place {
		font-weight: 500;
		color: var(--color-text-muted);
	}

	.lt-excerpt {
		margin-top: 0.3rem;
		font-family: var(--font-body);
		font-size: 0.76rem;
		font-style: italic;
		color: var(--color-text-muted);
		overflow-wrap: anywhere;
	}
</style>
