<script lang="ts">
	/**
	 * Connections page: the Model routing card (who runs on what) + the
	 * connection list.
	 *
	 * Routing is one flat, always-visible list: every calling point with its own
	 * pill select, nothing else. The two points the user drives directly (Primary,
	 * Assistant) sit slightly emphasized on top; every calling engine follows right
	 * below in the same shape. No roles, no groups, no "follows X" inheritance,
	 * no warnings: a fresh install routes everything to the Default connection,
	 * and re-pointing anything is the user's own, explicit choice.
	 *
	 * This is the only place in the app that ROUTES a point, and it always speaks for the
	 * app: the Engines page shows resolution read-only (architecture/engines.md), and a chat
	 * that has claimed its own connection is announced here and changes nothing.
	 */
	import Icon from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import ConnectionEditor from './ConnectionEditor.svelte';
	import { tick } from 'svelte';
	import { connectionStore, ASSIGNMENT_IDS } from '$lib/stores/connections.svelte';
	import ChatOverrideNotice from '$lib/components/ui/ChatOverrideNotice.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { chatConnectionId } from '$lib/utils/chat-setup';
	import { llmService } from '$lib/services/llm/provider';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { type Connection, type ProviderName } from '$lib/types/llm';
	import { flashTarget } from '$lib/utils/flash-target';
	import { ENGINES } from '$lib/engines/registry';

	const connections = $derived(connectionStore.connections);
	const editorId = $derived(uiStore.settingsConnectionId);
	const COLLAPSED_LIMIT = 4;
	let expanded = $state(false);
	const visibleConnections = $derived(
		expanded ? connections : connections.slice(0, COLLAPSED_LIMIT)
	);
	const hiddenCount = $derived(Math.max(0, connections.length - COLLAPSED_LIMIT));

	interface RoutePoint {
		id: string;
		label: string;
		icon:
			| 'chat'
			| 'annotation'
			| 'brain'
			| 'sparkles'
			| 'feather'
			| 'checkCircle'
			| 'mask'
			| 'compass'
			| 'image';
	}

	// The two points the user talks to directly, slightly emphasized: the story and
	// the assistant. Everything else is machinery the app runs on their behalf.
	const KEY_POINTS: RoutePoint[] = [
		{ id: 'primary', label: 'Primary', icon: 'chat' },
		{ id: 'assistant', label: 'Assistant', icon: 'annotation' }
	];

	// Every calling engine, registry order. Steering makes no call and is
	// deliberately absent: there is nothing to route.
	const ENGINE_POINTS: RoutePoint[] = ENGINES.filter((e) => e.makesCalls).map((e) => ({
		id: e.id,
		label: e.name,
		icon: e.icon
	}));

	const POINT_LABELS: Record<string, string> = Object.fromEntries(
		[...KEY_POINTS, ...ENGINE_POINTS].map((p) => [p.id, p.label])
	);

	function providerLabel(name: ProviderName): string {
		return llmService.getProviderMeta(name)?.displayName ?? name;
	}

	function modelShort(model: string): string {
		return model ? (model.split('/').pop() ?? model) : 'No model';
	}

	/** Pill/option text: the pick and its consequence in one string. */
	function optionLabel(c: Connection): string {
		return `${c.name} · ${modelShort(c.model)}`;
	}

	function openEditor(id: string): void {
		uiStore.settingsConnectionId = id;
	}

	async function revealConnection(id: string): Promise<void> {
		if (connections.length > COLLAPSED_LIMIT) expanded = true;
		await tick();
		const card = document.getElementById(`connection-card-${id}`);
		if (card) flashTarget(card, 'nearest');
	}

	async function newConnection(): Promise<void> {
		const c = connectionStore.create();
		await revealConnection(c.id);
	}

	async function duplicate(id: string): Promise<void> {
		const c = await connectionStore.duplicate(id);
		if (c) await revealConnection(c.id);
	}

	let confirmingDelete = $state<string | null>(null);

	// The open chat sends somewhere else, so every Primary row below is the app's answer and
	// not this story's. Said once at the top rather than pinned to that row: the sentence has
	// to name the connection the chat actually rides, which the row has no way to show.
	let storyConnection = $derived.by(() => {
		const claimed = chatConnectionId(chatStore.activeChat);
		if (claimed === null || claimed === connectionStore.assignmentFor('primary')) return null;
		return connectionStore.get(claimed) ?? null;
	});

	function confirmDelete(): void {
		if (confirmingDelete) {
			connectionStore.remove(confirmingDelete);
			if (connections.length <= COLLAPSED_LIMIT) expanded = false;
		}
		confirmingDelete = null;
	}
</script>

{#snippet routeRow(point: RoutePoint, key: boolean)}
	<div class="route-row" class:is-key={key}>
		<Icon name={point.icon} class="w-4 h-4 route-icon" strokeWidth={1.75} />
		<span class="route-label">{point.label}</span>
		<Select
			variant="compact"
			class="pill-select"
			value={connectionStore.assignmentFor(point.id)}
			onchange={(e) => connectionStore.setAssignment(point.id, (e.currentTarget as HTMLSelectElement).value)}
		>
			{#each connections as c (c.id)}
				<option value={c.id}>{optionLabel(c)}</option>
			{/each}
		</Select>
	</div>
{/snippet}

{#if editorId}
	{#key editorId}
		<ConnectionEditor id={editorId} />
	{/key}
{:else}
	<div class="connections">
		{#if storyConnection}
			<ChatOverrideNotice
				subject="Primary routing"
				using={storyConnection.name}
				instead={connectionStore.connectionFor('primary')?.name ?? 'No connection'}
			/>
		{/if}

		<!-- Model routing: which connection serves each calling point -->
		<section class="card" data-setting="model-routing">
			<div class="card-head">
				<span class="card-title">Model routing</span>
				<InfoTip
					text="Every part of the app that calls a model, and the connection it rides. Point any row somewhere else whenever you like."
				/>
			</div>

			<div class="routes">
				{#each KEY_POINTS as point (point.id)}
					{@render routeRow(point, true)}
				{/each}
				<div class="routes-divider"></div>
				{#each ENGINE_POINTS as point (point.id)}
					{@render routeRow(point, false)}
				{/each}
			</div>
		</section>

		<!-- Connection list -->
		<section class="card" data-setting="connections">
			<div class="card-head">
				<span class="card-title">Connections</span>
				<InfoTip
					text="One complete way to reach a model: provider, key, model and its settings, saved under a name. Keep as many as you like."
				/>
				<button type="button" class="new-btn" onclick={newConnection}>
					<Icon name="plus" class="w-3.5 h-3.5" strokeWidth={2} />
					New
				</button>
			</div>

			<div class="list" id="connection-list">
				{#each visibleConnections as c (c.id)}
					{@const points = connectionStore.assignedPoints(c.id)}
					<div class="conn-card" id="connection-card-{c.id}">
						<button type="button" class="conn-main" onclick={() => openEditor(c.id)}>
							<div class="conn-text">
								<span class="conn-name">{c.name}</span>
								<span class="conn-sub">{providerLabel(c.provider)} · {modelShort(c.model)}</span>
								{#if points.length}
									<div class="conn-points">
										{#if points.length === ASSIGNMENT_IDS.length}
											<span class="point-chip">Everything</span>
										{:else}
											{#each points as p (p)}
												<span class="point-chip">{POINT_LABELS[p] ?? p}</span>
											{/each}
										{/if}
									</div>
								{/if}
							</div>
							<Icon name="chevronRight" class="w-4 h-4 conn-chev" strokeWidth={2} />
						</button>
						<div class="conn-actions">
							<button type="button" class="icon-btn" title="Duplicate" aria-label="Duplicate" onclick={() => duplicate(c.id)}>
								<Icon name="copy" class="w-4 h-4" strokeWidth={1.75} />
							</button>
							{#if connections.length > 1}
								<button
									type="button"
									class="icon-btn danger"
									title="Delete"
									aria-label="Delete"
									onclick={() => (confirmingDelete = c.id)}
								>
									<Icon name="trash" class="w-4 h-4" strokeWidth={1.75} />
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>

			{#if hiddenCount > 0}
				<button
					type="button"
					class="list-toggle"
					onclick={() => (expanded = !expanded)}
					aria-controls="connection-list"
					aria-expanded={expanded}
				>
					<Icon name={expanded ? 'chevronUp' : 'chevronDown'} class="w-3.5 h-3.5" />
					<span>{expanded ? 'Show less' : `Show ${hiddenCount} more`}</span>
				</button>
			{/if}
		</section>
	</div>

	<ConfirmDialog
		open={!!confirmingDelete}
		title="Delete connection"
		message="Anything routed to it moves to another connection, and its saved API key is removed."
		confirmLabel="Delete"
		variant="danger"
		destructive
		onConfirm={confirmDelete}
		onCancel={() => (confirmingDelete = null)}
	/>
{/if}

<style>
	.connections {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	/* ===== Model routing ===== */
	.routes {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.routes-divider {
		margin: 0.25rem 0;
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 60%, transparent);
	}

	/* One thin line per point. Wraps instead of squeezing: in a narrow dock the
	   pill drops to its own line and stays right-aligned via the auto margin. */
	.route-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.3rem 0.5rem;
	}

	.route-row :global(.route-icon) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.route-label {
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 550;
		color: var(--color-text-secondary);
	}

	/* The two key points read a notch heavier; same anatomy, no other ceremony. */
	.route-row.is-key .route-label {
		font-size: 0.8rem;
		font-weight: 650;
		color: var(--color-text-primary);
	}

	.route-row.is-key :global(.route-icon) {
		color: var(--color-accent);
	}

	.route-row > :global(div) {
		min-width: 0;
		margin-left: auto;
	}

	/* The select as a quiet pill: the routed connection and its model in one
	   breath. Native select underneath: the OS picker does the mobile work. */
	.connections :global(select.pill-select) {
		max-width: 100%;
		border-radius: var(--radius-full);
		padding: 0.28rem 1.9rem 0.28rem 0.7rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ===== New button ===== */
	/* The one thing on this page that belongs at the card's right edge. The pull lives
	   on the button, never on `.card-head`: that head also carries a title and its
	   InfoTip, and pushing those apart strands the ⓘ a card's width from what it
	   explains. */
	.new-btn {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.35rem 0.7rem;
		border-radius: var(--radius-full);
		border: 1px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		color: var(--color-accent);
		font-family: var(--font-ui);
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 110ms ease;
	}

	.new-btn:hover {
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
	}

	/* ===== Connection list ===== */
	.list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.3rem;
	}

	.conn-card {
		display: flex;
		align-items: stretch;
		gap: 0.3rem;
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 60%, transparent);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 80%, transparent);
		overflow: hidden;
	}

	.conn-main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.7rem 0.75rem;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background 110ms ease;
	}

	.conn-main:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 45%, transparent);
	}

	.conn-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.conn-name {
		font-family: var(--font-ui);
		font-size: 0.86rem;
		font-weight: 600;
		color: var(--color-text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.conn-sub {
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.conn-points {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.1rem;
	}

	.point-chip {
		font-family: var(--font-ui);
		font-size: 0.62rem;
		font-weight: 650;
		padding: 0.08rem 0.4rem;
		border-radius: var(--radius-full);
		color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.conn-main :global(.conn-chev) {
		color: var(--color-text-muted);
		opacity: 0.65;
		flex-shrink: 0;
	}

	.conn-actions {
		display: flex;
		align-items: center;
		gap: 0.1rem;
		padding: 0 0.35rem;
	}

	.conn-actions .icon-btn.danger:hover {
		color: var(--color-error);
	}

	.list-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		width: fit-content;
		margin: 0.55rem auto 0;
		padding: 0.25rem 0.5rem;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
	}

	.list-toggle:hover {
		color: var(--color-accent);
	}
</style>
