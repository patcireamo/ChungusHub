<script lang="ts">
	import Workspace from '$lib/components/layout/Workspace.svelte';
	import TitleBar from '$lib/components/layout/TitleBar.svelte';
	import AssistantFloatingWidget from '$lib/components/assistant/AssistantFloatingWidget.svelte';
	import WelcomeDialog, { openWelcomeDialog } from '$lib/components/layout/WelcomeDialog.svelte';
	import ToastContainer from '$lib/components/ui/ToastContainer.svelte';
	import DataAheadBar, { setDataAhead } from '$lib/components/layout/DataAheadBar.svelte';
	import ConnectionBar from '$lib/components/layout/ConnectionBar.svelte';
	import DeleteGuardBar from '$lib/components/layout/DeleteGuardBar.svelte';
	import ImportBar from '$lib/components/layout/ImportBar.svelte';
	import { deleteGuard } from '$lib/stores/delete-guard.svelte';
	import { advancedSettingsStore } from '$lib/stores/advanced-settings.svelte';
	import { promptHoldStore } from '$lib/stores/promptHold.svelte';
	import { generalSettingsStore } from '$lib/stores/general-settings.svelte';
	import { regexRulesStore } from '$lib/stores/regex-rules.svelte';
	import { inputHistoryStore } from '$lib/stores/inputHistory.svelte';
	import { ambientStore } from '$lib/stores/ambient.svelte';
	import { backgroundStore } from '$lib/stores/background.svelte';
	import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
	import { libraryViewPrefs, personasViewPrefs } from '$lib/stores/browseViewPrefs.svelte';
	import { spriteSortPref } from '$lib/stores/spriteSort.svelte';
	import { lorebookSortPref } from '$lib/stores/lorebookSort.svelte';
	import { db } from '$lib/services/database';
	import { presetService } from '$lib/services/presets.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { chatCastStore } from '$lib/stores/chatCast.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { llmService } from '$lib/services/llm/provider';
	import { connectionStore } from '$lib/stores/connections.svelte';
	import { characterLibraryStore } from '$lib/stores/characterLibrary.svelte';
	import { lorebookStore } from '$lib/lorebook/store.svelte';
	import { steeringStore } from '$lib/stores/steering.svelte';
	import { lorebookSettingsStore } from '$lib/lorebook/settings.svelte';
	import { personaStore } from '$lib/stores/persona.svelte';
	import { presetControlsStore } from '$lib/stores/presetControls.svelte';
	import { assistantSessionStore } from '$lib/stores/assistantSessions.svelte';
	import { tokenCalibration } from '$lib/tokenizer';
	import {
		AccessDeniedError,
		MaintenanceError,
		apiGet,
		getServerConfig,
		onReconnect
	} from '$lib/services/transport';
	import { backupStore } from '$lib/stores/backups.svelte';
	import { initSync } from '$lib/services/sync';
	import { onMount } from 'svelte';

	type Phase = 'loading' | 'ready' | 'error' | 'denied' | 'maintenance';

	let phase = $state<Phase>('loading');
	let error = $state<string | null>(null);
	/** What the launch card is waiting on, while it is waiting rather than loading. */
	let waiting = $state<'connecting' | 'unreachable' | null>(null);
	/** The server's own account of why it is not serving, shown verbatim. */
	let held = $state<{ headline: string; detail: string } | null>(null);

	/**
	 * The launch card's two lines. Waiting for the server is not the same as loading, and past
	 * a point it is not the same as waiting either: name the one thing the reader can check.
	 */
	const launch = $derived(
		waiting === 'unreachable'
			? {
					title: "Can't reach the server",
					copy: 'Make sure ChungusHub is still running, then leave this page open. Retrying…'
				}
			: waiting === 'connecting'
				? { title: 'Waiting for the server', copy: 'Starting up. This page opens on its own.' }
				: {
						title: 'Preparing workspace',
						copy: 'Loading chats, presets, providers, and UI state.'
					}
	);

	/** How long the card says "starting" before it stops guessing and names the problem. */
	const SLOW_CONNECT_MS = 15_000;
	/** The transport's own reconnect cadence, so this rides those attempts instead of racing
	 *  them with a second set. */
	const RETRY_MS = 2_000;

	/**
	 * Wait for the live-sync socket, which every step below reads through.
	 *
	 * A single attempt is capped at 5s and the transport's reconnect loop keeps trying
	 * underneath it (architecture/client-data-layer.md), so a cold dev server, a phone waking
	 * on its network or an install still opening its port heals here instead of ending the
	 * launch. Only a state that will never heal on its own leaves this loop, and it leaves by
	 * throwing: a device that is not allowed in, and a server holding itself for a restore.
	 */
	async function connectOrWait(): Promise<void> {
		const startedAt = Date.now();
		for (;;) {
			try {
				await db.initialize();
				waiting = null;
				return;
			} catch (e) {
				// Every pass says so: a wait nobody can see is the failure this screen prevents.
				console.error('Waiting for the server:', e);
				await stopIfRefused();
				waiting = Date.now() - startedAt >= SLOW_CONNECT_MS ? 'unreachable' : 'connecting';
				await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
			}
		}
	}

	/**
	 * Ask the server what it is doing. 403 (this device is not allowed in) and 503 (a restore
	 * holds the install) are answers rather than outages, and both end the wait by throwing.
	 * Anything else means nothing is listening yet, which is what waiting is for.
	 */
	async function stopIfRefused(): Promise<void> {
		try {
			await apiGet('/api/health');
		} catch (e) {
			if (e instanceof AccessDeniedError || e instanceof MaintenanceError) throw e;
		}
	}

	/**
	 * Raise the first-run greeting.
	 *
	 * TWO conditions, because "has been greeted" and "has a persona" are different facts:
	 * the library's floor is one persona and the greeting is the only door that writes the
	 * first one (architecture/library.md), so someone whose greeting was cut short by a
	 * failed write is asked again here rather than left with no "you" at all.
	 */
	function maybeGreet() {
		if (generalSettingsStore.welcomeSeen && characterLibraryStore.personas.length > 0) return;
		openWelcomeDialog();
	}

	async function boot() {
		phase = 'loading';
		try {
			// Initialize all services in order - ORDER MATTERS
			await connectOrWait();
			// Which set of data this page was built against, read the moment the socket is up.
			// A restore replaces all of it during a launch this page cannot witness, so
			// `watchForRestore` compares this on every reconnect. A push could never carry the
			// news: the process that took the decision is gone by the time it becomes true.
			const serverConfig = await getServerConfig();
			bootDataEpoch = serverConfig.dataEpoch;
			setDataAhead(serverConfig.dataAhead);
			await themeStore.initialize();
			// Synced UI preferences (formerly per-device localStorage). Loaded before the
			// workspace paints so the toolbars open with the user's saved view. All
			// ride the settings sync spine.
			await advancedSettingsStore.initialize();
			// Which request gates hold their prompt for review. Before the workspace paints,
			// like every other switch a surface reads the moment it is used.
			await promptHoldStore.initialize();
			// After the settings it reads: the guard derives its rung from them, and its
			// outage rule has to be armed before any surface can ask it anything.
			deleteGuard.initialize();
			await generalSettingsStore.initialize();
			// Settings only, not the snapshot listing: the Backups root row shows the
			// schedule, and the listing is fetched when its page opens.
			await backupStore.initialize();
			await regexRulesStore.initialize();
			// After general settings: the reload respects the configured history cap.
			await inputHistoryStore.initialize();
			await ambientStore.initialize();
			await backgroundStore.initialize();
			await featurePromptsStore.initialize();
			await libraryViewPrefs.initialize();
			await personasViewPrefs.initialize();
			await spriteSortPref.initialize();
			await lorebookSortPref.initialize();
			await presetService.initialize();
			// Named connections + surface bindings ride the settings spine; load them
			// before llmService so every surface can resolve who serves it.
			await connectionStore.initialize();
			await llmService.initialize();
			await tokenCalibration.init();
			// The library + global persona/preset-control values back generation, so
			// load them before anything resolves the active chat's context.
			await characterLibraryStore.load();
			await lorebookStore.load();
			await lorebookSettingsStore.initialize();
			// Steering notes are prompt context like the lorebooks above: the composer's
			// readout and the chat meter both resolve them the moment a chat opens, so
			// they load before chatStore does.
			await steeringStore.load();
			await personaStore.initialize();
			await presetControlsStore.initialize();
			await assistantSessionStore.initialize();

			// Boot the global chat list, restoring the last viewed chat (or
			// creating a fresh blank one when none exist yet).
			await chatStore.loadAllChats();

			// Build the chat → cast index so the chat lists can show whose
			// story each one is. Non-fatal: the lists fall back to titles without it.
			await chatCastStore.load();

			// Land on the welcome screen: the user continues their last story, starts
			// a fresh one, or jumps into the Chats browser from here.
			uiStore.openWelcome();

			initSync();
			watchForRestore();

			phase = 'ready';

			// After `ready` and never before: a dialog stacked on a boot state card would
			// be greeting someone whose app has not started.
			maybeGreet();
		} catch (e) {
			if (e instanceof AccessDeniedError) {
				phase = 'denied';
				return;
			}
			if (e instanceof MaintenanceError) {
				held = { headline: e.message, detail: e.detail };
				phase = 'maintenance';
				return;
			}
			error = e instanceof Error ? e.message : 'Failed to initialize application';
			console.error('Initialization error:', e);
			phase = 'error';
		}
	}

	/** The data this page was built against. Set while boot runs, before anything can observe
	 *  a reconnect, so the comparison below never has to reason about "unknown". */
	let bootDataEpoch = 0;

	/**
	 * A restore happens during a launch this page slept through: every socket closed, the
	 * server stopped, and what came back holds different chats, characters and pictures than
	 * the stores in this tab. Nothing in memory is worth keeping at that point, so the page
	 * reloads rather than trying to reconcile, and it asks on RECONNECT rather than being
	 * told, since the only moment anyone could have been told is the moment nobody was
	 * listening. A phone that was asleep for hours finds out the same way.
	 */
	function watchForRestore(): void {
		onReconnect(() => {
			void getServerConfig()
				.then((config) => {
					// Re-read, not just re-checked: what answers after a reconnect can be an older
					// build than the one this tab booted against, and a plain restart moves no epoch.
					setDataAhead(config.dataAhead);
					if (config.dataEpoch !== bootDataEpoch) window.location.reload();
				})
				.catch(() => {
					// Still coming back up. The next reconnect asks again.
				});
		});
	}

	onMount(boot);

</script>

<div class="app-shell surface-shell">
	<TitleBar />
	<ToastContainer />

	{#if phase === 'error'}
		<div class="app-state-wrap">
			<div class="state-card card-elevated">
				<div class="state-icon state-icon-error">
					<span>!</span>
				</div>
				<h1 class="state-title text-error">Initialization error</h1>
				<p class="state-copy">{error}</p>
				<button
					class="state-action"
					onclick={() => window.location.reload()}
				>
					Retry launch
				</button>
			</div>
		</div>
	{:else if phase === 'denied'}
		<div class="app-state-wrap">
			<div class="state-card card-elevated">
				<div class="state-icon state-icon-error">
					<span>!</span>
				</div>
				<h1 class="state-title text-error">Access denied</h1>
				<p class="state-copy">
					This device isn't on the allowlist. Ask the host to allow its IP from
					Settings → Security.
				</p>
			</div>
		</div>
	{:else if phase === 'maintenance' && held}
		<!-- The server is up and holding itself for a restore. Its own two lines, because it
		     is the only side that knows which state this is and what the reader has to do. -->
		<div class="app-state-wrap">
			<div class="state-card card-elevated">
				<div class="state-icon state-icon-loading">
					<span class="pulse-dot"></span>
					<span class="pulse-dot" style="animation-delay: 140ms"></span>
					<span class="pulse-dot" style="animation-delay: 280ms"></span>
				</div>
				<h1 class="state-title">{held.headline}</h1>
				<p class="state-copy">{held.detail}</p>
			</div>
		</div>
	{:else if phase !== 'ready'}
		<div class="app-state-wrap">
			<div class="state-card card-elevated">
				<div class="state-icon state-icon-loading">
					<span class="pulse-dot"></span>
					<span class="pulse-dot" style="animation-delay: 140ms"></span>
					<span class="pulse-dot" style="animation-delay: 280ms"></span>
				</div>
				<h1 class="state-title">{launch.title}</h1>
				<p class="state-copy">{launch.copy}</p>
			</div>
		</div>
	{:else}
		<!-- Only once the workspace is up: the boot failure states below say the same thing
		     in their own words, and two accounts of one outage is one too many. -->
		<!-- First of the four: an outage stops writes, while this one lets them through into
		     data this build does not understand, and it is the only one here that cannot
		     resolve while the app is open. -->
		<DataAheadBar />
		<ConnectionBar />
		<!-- Under the connection row on purpose: an outage is the more urgent of the two, and
		     an outage also closes any window, so they only ever stack on a kept rung. -->
		<DeleteGuardBar />
		<!-- Last of the three: work that is merely running is the least urgent thing this
		     channel says, and unlike the two above it resolves on its own. -->
		<ImportBar />
		<div class="app-main">
			<Workspace />
		</div>
		<!-- The Chungus Assistant lives here, at the shell's top level, so its fixed
		     floating widget/launcher paints above the title bar and the workspace's
		     isolated stacking context. -->
		<AssistantFloatingWidget />
		<!-- Mounted with the workspace, not with the shell: it portals to body and owns
		     its own open flag, and there is nothing to greet anyone about while a boot
		     state card is still on screen. -->
		<WelcomeDialog />
	{/if}
</div>

<style>
	.app-shell {
		height: 100dvh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		position: relative;
	}

	.app-state-wrap {
		flex: 1;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.state-card {
		width: min(100%, 30rem);
		padding: clamp(1.2rem, 1.05rem + 0.8vw, 1.8rem);
		text-align: center;
	}

	.state-icon {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 999px;
		margin: 0 auto 0.9rem;
		display: grid;
		place-items: center;
		font-family: var(--font-ui);
		font-weight: 700;
	}

	.state-icon-error {
		background: color-mix(in srgb, var(--color-error) 12%, transparent);
		color: var(--color-error);
		border: 1px solid color-mix(in srgb, var(--color-error) 34%, transparent);
	}

	.state-icon-loading {
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
	}

	.pulse-dot {
		width: 0.42rem;
		height: 0.42rem;
		border-radius: 50%;
		background: var(--color-accent);
		animation: shellPulse 1s ease-in-out infinite;
	}

	.state-title {
		margin: 0;
		font-family: var(--font-ui);
		font-size: clamp(1.08rem, 0.95rem + 0.4vw, 1.28rem);
		font-weight: 700;
		color: var(--color-text-primary);
	}

	.state-copy {
		margin: 0.55rem auto 0;
		max-width: 25rem;
		font-size: 0.93rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
	}

	.state-action {
		margin-top: 1rem;
		padding: 0.62rem 1rem;
		border-radius: var(--radius-md);
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-family: var(--font-ui);
		font-weight: 600;
		font-size: 0.88rem;
		border: 0;
		cursor: pointer;
		transition: background-color 140ms ease;
	}

	.state-action:hover {
		background: var(--color-accent-hover);
	}

	.state-action:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.app-main {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	@keyframes shellPulse {
		0%,
		100% {
			opacity: 0.32;
			transform: translateY(0);
		}

		50% {
			opacity: 1;
			transform: translateY(-2px);
		}
	}
</style>
