<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Alert from '$lib/components/ui/Alert.svelte';
	import BrandGlyph from '$lib/components/ui/BrandGlyph.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { MOD_KEY } from '$lib/components/ui/ShortcutsSheet.svelte';
	import { shortcutsSheet } from '$lib/commands/shortcuts.svelte';
	import { LINKS, newIssueUrl } from '$lib/config/links';
	import { checkLatestRelease, getInstallInfo, type InstallInfo } from '$lib/services/transport';
	import { advancedSettingsStore } from '$lib/stores/advanced-settings.svelte';
	import { toastStore } from '$lib/stores/toast.svelte';
	import { viewport } from '$lib/stores/viewport.svelte';
	import { bytes } from '$lib/utils/bytes';
	import { copyText } from '$lib/utils/clipboard';
	import { APP_VERSION } from '$lib/version';

	// The Developer page's only switch: a streak of taps on the version, which is why nothing
	// anywhere else offers it. The streak has to be continuous, or a control someone pokes at
	// over a week eventually opens a page they never asked for; the window is the gap between
	// two taps rather than a deadline for the whole run, so a slow deliberate streak still
	// lands. The count is not $state: nothing on screen counts along.
	const VERSION_TAPS = 7;
	const TAP_GAP_MS = 1200;
	const NUDGE_MS = 240;
	/** How long a thrown label lives. Must match the `pop-rise` duration below, since that
	 *  animation is what fades it and this timer is what removes it. */
	const POP_MS = 900;

	let versionTaps = 0;
	let tapTimer: ReturnType<typeof setTimeout> | null = null;
	let versionEl = $state<HTMLElement | null>(null);
	let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

	/** The labels currently in the air. A list rather than one element, so a fast streak
	 *  stacks several instead of restarting a single one and showing only the last: the
	 *  count is the reward for tapping, and it is worth being able to watch it fall. */
	let pops = $state<{ id: number; text: string; x: number; final: boolean }[]>([]);
	let popId = 0;
	const popTimers = new Set<ReturnType<typeof setTimeout>>();

	/** Each label carries its own sideways offset, so two thrown a few milliseconds apart
	 *  fan out instead of printing on top of each other. They are cleared on a timer and
	 *  never on `animationend`, which is also what keeps them readable with motion off. */
	function throwPop(text: string, final = false): void {
		const id = popId++;
		pops.push({ id, text, x: (Math.random() - 0.5) * 0.7, final });
		const timer = setTimeout(() => {
			pops = pops.filter((p) => p.id !== id);
			popTimers.delete(timer);
		}, POP_MS);
		popTimers.add(timer);
	}

	onDestroy(() => {
		if (tapTimer) clearTimeout(tapTimer);
		if (nudgeTimer) clearTimeout(nudgeTimer);
		for (const timer of popTimers) clearTimeout(timer);
	});

	/** Answer every tap, or a control that only reacts on the seventh reads as a dead one.
	 *  The class is added by hand rather than through a `class:` directive because Svelte
	 *  batches DOM writes: dropping and re-adding it in one tick would never reach the DOM,
	 *  so the animation could not replay on a repeat tap. Hence the reflow between the two.
	 *  It comes off on a timer rather than on `animationend`, because the reduced-motion rule
	 *  cuts every animation to 0.01ms and the colour would be gone before it was seen: the
	 *  tint is what answers there, the shake is what answers everywhere else. */
	function nudgeVersion(): void {
		if (!versionEl) return;
		if (nudgeTimer) clearTimeout(nudgeTimer);
		versionEl.classList.remove('nudge');
		void versionEl.offsetWidth;
		versionEl.classList.add('nudge');
		nudgeTimer = setTimeout(() => {
			versionEl?.classList.remove('nudge');
			nudgeTimer = null;
		}, NUDGE_MS);
	}

	/** The thrown label counts down but never names what it is counting toward, which is what
	 *  keeps the page from advertising a door nobody asked about: a stray tap gets a number
	 *  and no explanation. The last one is the exception and has to be, since it is the only
	 *  thing on this page that reports the switch: the row it adds is in a list one level up. */
	function tapVersion(): void {
		nudgeVersion();
		if (tapTimer) clearTimeout(tapTimer);
		versionTaps += 1;
		if (versionTaps >= VERSION_TAPS) {
			versionTaps = 0;
			tapTimer = null;
			const on = !advancedSettingsStore.developerMode;
			advancedSettingsStore.setDeveloperMode(on);
			throwPop(on ? 'Developer on' : 'Developer off', true);
			return;
		}
		throwPop(`${VERSION_TAPS - versionTaps} left`);
		tapTimer = setTimeout(() => {
			versionTaps = 0;
			tapTimer = null;
		}, TAP_GAP_MS);
	}

	// ===== This install =====
	// Asked once, when the page opens: the answer counts every file in the data dir, so it
	// must never ride a render. It is a snapshot of this moment and is deliberately not
	// refreshed while the page is up.
	let install = $state<InstallInfo | null>(null);
	let installError = $state<string | null>(null);

	onMount(async () => {
		try {
			install = await getInstallInfo();
		} catch (error) {
			installError = error instanceof Error ? error.message : String(error);
		}
	});

	const buildLabel = $derived(install?.build === 'portable' ? 'Portable build' : 'Running from source');

	const sizeLine = $derived(
		!install
			? ''
			: install.imageBytes > 0
				? `${bytes(install.dataBytes)} on disk, ${bytes(install.imageBytes)} of it pictures.`
				: `${bytes(install.dataBytes)} on disk.`
	);

	/**
	 * The page and the server can be on different builds: replacing a portable build restarts
	 * the server while an open tab keeps running the client it already loaded, and the two
	 * disagree until a reload. Only a portable build can report this, since from source the
	 * server has no number to state and says so.
	 */
	const staleClient = $derived(
		install?.build === 'portable' && install.version !== APP_VERSION ? install.version : null
	);

	/** The three lines that decide whether a report can be acted on. */
	const environment = $derived(
		[
			`ChungusHub ${APP_VERSION}`,
			install ? `${buildLabel}, ${install.runtime} on ${install.platform}` : null,
			typeof navigator === 'undefined' ? null : navigator.userAgent
		]
			.filter((line) => line !== null)
			.join('\n')
	);

	async function copyDataDir(): Promise<void> {
		if (!install) return;
		try {
			await copyText(install.dataDir);
			toastStore.success('Copied the data folder path');
		} catch (error) {
			toastStore.failed('copy the path', error);
		}
	}

	async function copyHandle(): Promise<void> {
		try {
			await copyText(LINKS.discordHandle);
			toastStore.success('Copied the Discord handle');
		} catch (error) {
			toastStore.failed('copy the handle', error);
		}
	}

	async function copyEnvironment(): Promise<void> {
		try {
			await copyText(environment);
			toastStore.success('Copied the details');
		} catch (error) {
			toastStore.failed('copy the details', error);
		}
	}

	// ===== Updates =====
	// Runtime state and nothing else: what a check found matters for as long as the page is
	// open, and remembering it would mean storing which device asked and when, on a spine
	// every device reads.
	type UpdateState =
		| { kind: 'idle' }
		| { kind: 'checking' }
		| { kind: 'current' }
		| { kind: 'ahead'; version: string }
		| { kind: 'behind'; version: string; url: string }
		| { kind: 'failed'; message: string };

	let update = $state<UpdateState>({ kind: 'idle' });

	/** Strict on purpose: a tag this build cannot read is a failure the reader gets to see,
	 *  never a number quietly rounded into a comparison that says "you are up to date". */
	function parseVersion(v: string): [number, number, number] {
		const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
		if (!parts) throw new Error(`"${v}" is not a version this build can compare.`);
		return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
	}

	function compareVersions(a: string, b: string): number {
		const left = parseVersion(a);
		const right = parseVersion(b);
		for (let i = 0; i < 3; i++) {
			if (left[i] !== right[i]) return left[i] - right[i];
		}
		return 0;
	}

	async function checkForUpdates(): Promise<void> {
		update = { kind: 'checking' };
		try {
			const latest = await checkLatestRelease();
			// Weighed against the number baked into this bundle, never the server's: from
			// source the server answers 'dev'.
			const diff = compareVersions(latest.version, APP_VERSION);
			if (diff > 0) update = { kind: 'behind', version: latest.version, url: latest.url };
			else if (diff < 0) update = { kind: 'ahead', version: latest.version };
			else update = { kind: 'current' };
		} catch (error) {
			update = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
	}
</script>

<div class="about">
	<header class="identity">
		<img class="mark" src="/mark.svg" alt="" />
		<h2 class="name">ChungusHub</h2>
		<p class="tagline">A self-hosted workspace for long-form roleplay.</p>
		<!-- Also the one door to the Developer page: seven taps open it, seven close it.
		     Nothing names it, and nothing should; the labels thrown off the side count the
		     taps down without saying what is at the end of them. -->
		<div class="version-wrap">
			<button
				type="button"
				class="version"
				bind:this={versionEl}
				onclick={tapVersion}
				aria-label="Version {APP_VERSION}"
			>
				{APP_VERSION}
			</button>
			<!-- Hidden from screen readers: a bare "5 left" read out of context says nothing,
			     and what the streak finally does is a row appearing in the settings list. -->
			{#each pops as p (p.id)}
				<span
					class="pop"
					class:pop-final={p.final}
					style="--pop-x: {p.x}rem"
					aria-hidden="true">{p.text}</span
				>
			{/each}
		</div>
	</header>

	<section class="card">
		<div class="card-head">
			<span class="card-title">Updates</span>
		</div>
		<div class="card-body">
			<p class="note">
				Nothing is checked in the background. The check asks GitHub for its latest release,
				from the computer running ChungusHub, and sends nothing else.
			</p>
			<div class="update">
				<Button
					variant="secondary"
					size="sm"
					onclick={checkForUpdates}
					disabled={update.kind === 'checking'}
				>
					{#if update.kind === 'checking'}
						<Spinner size="sm" />
					{:else}
						<Icon name="refresh" class="w-3.5 h-3.5" strokeWidth={1.75} />
					{/if}
					Check for updates
				</Button>

				{#if update.kind === 'current'}
					<p class="verdict">
						<Icon name="checkCircle" class="w-3.5 h-3.5 verdict-icon" strokeWidth={1.75} />
						You are on the latest release.
					</p>
				{:else if update.kind === 'ahead'}
					<p class="verdict">
						<Icon name="info" class="w-3.5 h-3.5 verdict-icon" strokeWidth={1.75} />
						You are ahead of the latest release, which is {update.version}.
					</p>
				{:else if update.kind === 'behind'}
					<p class="verdict verdict-new">
						<Icon name="download" class="w-3.5 h-3.5 verdict-icon" strokeWidth={1.75} />
						{update.version} is out. You are on {APP_VERSION}.
					</p>
					<a class="release" href={update.url} target="_blank" rel="noopener noreferrer">
						See what changed
						<Icon name="externalLink" class="w-3.5 h-3.5" strokeWidth={1.75} />
					</a>
				{/if}
			</div>
			<Alert message={update.kind === 'failed' ? update.message : null} />
		</div>
	</section>

	<section class="card">
		<div class="card-head">
			<span class="card-title">Help &amp; community</span>
		</div>
		<nav class="rows" aria-label="Help and community">
			<a class="row" href={LINKS.docs} target="_blank" rel="noopener noreferrer">
				<Icon name="bookOpen" class="w-4 h-4 row-icon" strokeWidth={1.75} />
				<span class="row-label">Documentation</span>
				<Icon name="externalLink" class="w-3.5 h-3.5 row-out" strokeWidth={1.75} />
			</a>

			<!-- Gone on touch, where the sheet lists keys that device doesn't have and its only
			     other trigger (Ctrl+/) is unreachable: the row would open a dead end. Hidden, not
			     shown inert, the same rule the Chat controls follow. -->
			{#if !viewport.isTouch}
				<button type="button" class="row" onclick={() => shortcutsSheet.toggle()}>
					<Icon name="keyboard" class="w-4 h-4 row-icon" strokeWidth={1.75} />
					<span class="row-label">Keyboard shortcuts</span>
					<span class="row-value">{MOD_KEY} /</span>
				</button>
			{/if}

			<a class="row" href={LINKS.discord} target="_blank" rel="noopener noreferrer">
				<BrandGlyph name="discord" class="w-4 h-4 row-icon" />
				<span class="row-label">Discord</span>
				<Icon name="externalLink" class="w-3.5 h-3.5 row-out" strokeWidth={1.75} />
			</a>

			<a class="row" href={LINKS.repo} target="_blank" rel="noopener noreferrer">
				<BrandGlyph name="github" class="w-4 h-4 row-icon" />
				<span class="row-label">GitHub</span>
				<Icon name="externalLink" class="w-3.5 h-3.5 row-out" strokeWidth={1.75} />
			</a>

			<!-- Opens an issue with the build already written into it, which is the part of a
			     report nobody thinks to include and the part that decides whether it can be
			     reproduced. -->
			<a
				class="row"
				href={newIssueUrl(environment)}
				target="_blank"
				rel="noopener noreferrer"
			>
				<Icon name="annotation" class="w-4 h-4 row-icon" strokeWidth={1.75} />
				<span class="row-label">Report a bug</span>
				<Icon name="externalLink" class="w-3.5 h-3.5 row-out" strokeWidth={1.75} />
			</a>
		</nav>
	</section>

	<!-- The one block on the page written by a person rather than by the app, which is what a
	     reader with no GitHub account is left with once the links above run out. It stays one
	     card: the author's voice belongs here and nowhere else in the interface. -->
	<section class="card">
		<div class="card-head">
			<span class="card-title">Reach me</span>
		</div>
		<div class="reach">
			<p class="personal">
				If you would rather talk to a person, or you simply have an idea to share, I am on
				Discord: the server above, or straight to me here.
			</p>
			<button type="button" class="handle" onclick={copyHandle} title="Copy this handle">
				<BrandGlyph name="discord" class="w-3.5 h-3.5 handle-glyph" />
				<code>{LINKS.discordHandle}</code>
				<Icon name="copy" class="w-3 h-3" strokeWidth={1.75} />
			</button>
		</div>
	</section>

	<section class="card">
		<div class="card-head">
			<span class="card-title">This install</span>
			<InfoTip
				text="What this copy of ChungusHub runs on, and where it keeps everything you write. Copy details puts these lines and your browser on the clipboard, which is what a bug report needs."
			/>
		</div>

		{#if installError}
			<Alert message={installError} />
		{:else if !install}
			<p class="loading">
				<Spinner size="sm" />
				Reading the folder…
			</p>
		{:else}
			{#if staleClient}
				<Alert
					tone="warning"
					message="This page is still running the {APP_VERSION} build while the server has moved to {staleClient}. Reload to catch up."
				/>
			{/if}
			<div class="facts">
				<div class="fact">
					<span class="fact-label">Build</span>
					<span class="fact-value">{buildLabel}</span>
				</div>
				<div class="fact">
					<span class="fact-label">Runs on</span>
					<span class="fact-value">{install.runtime} on {install.platform}</span>
				</div>
			</div>

			<div class="where">
				<span class="section-label">Your data</span>
				<button type="button" class="path" onclick={copyDataDir} title="Copy this path">
					<code>{install.dataDir}</code>
					<Icon name="copy" class="w-3 h-3" strokeWidth={1.75} />
				</button>
				<p class="where-note">
					{sizeLine} Everything you have written lives in there: your stories, your characters, your
					pictures and your API keys.
				</p>
			</div>

			<div class="details">
				<Button variant="secondary" size="sm" onclick={copyEnvironment}>
					<Icon name="copy" class="w-3.5 h-3.5" strokeWidth={1.75} />
					Copy details
				</Button>
			</div>
		{/if}
	</section>

	<!-- The typeface, sound and recording lines are not garnish: each ships inside the app under
	     licenses of its own, and a page claiming one license over everything it hands the reader
	     would be claiming one it does not hold. Each notice is linked, not just named, because it
	     travels with the app and is served beside the files it covers. -->
	<p class="legal">
		ChungusHub is free software under the
		<a href={LINKS.license} target="_blank" rel="noopener noreferrer">AGPL-3.0</a>. The source is
		on <a href={LINKS.repo} target="_blank" rel="noopener noreferrer">GitHub</a>. The typefaces,
		notification sounds and ambient recordings it ships with are not covered by that license: the
		typefaces are under the
		<a href={LINKS.fontLicense} target="_blank" rel="noopener noreferrer">SIL Open Font License</a>,
		the sounds under
		<a href={LINKS.soundCredits} target="_blank" rel="noopener noreferrer">Creative Commons</a>
		and the recordings under the
		<a href={LINKS.soundscapeLicense} target="_blank" rel="noopener noreferrer">Pixabay Content License or CC0</a>.
	</p>
</div>

<style>
	.about {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	/* ===== Identity ===== */

	.identity {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		padding: 0.6rem 0 1rem;
		text-align: center;
	}

	.mark {
		width: 3.25rem;
		height: 3.25rem;
		margin-bottom: 0.35rem;
	}

	.name {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 1.15rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--color-text-primary);
	}

	.tagline {
		margin: 0;
		max-width: 22rem;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		line-height: 1.5;
		color: var(--color-text-muted);
	}

	/* Anchors the thrown labels to the pill without letting them into the layout: they are
	   absolutely positioned against this box, so the identity block never moves while one
	   is in the air. */
	.version-wrap {
		position: relative;
		display: flex;
		justify-content: center;
		margin-top: 0.5rem;
	}

	.version {
		padding: 0.22rem 0.6rem;
		border-radius: var(--radius-full);
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
		background: color-mix(in srgb, var(--color-bg-secondary) 80%, transparent);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: color 120ms ease, border-color 120ms ease;
	}

	.version:hover {
		color: var(--color-text-primary);
	}

	/* Added at runtime (see nudgeVersion), so it has to leave the scoping alone. */
	.version:global(.nudge) {
		color: var(--color-accent);
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
		animation: version-nudge 220ms ease;
	}

	@keyframes version-nudge {
		25% {
			transform: translateX(-3px) rotate(-1.5deg);
		}
		55% {
			transform: translateX(3px) rotate(1.5deg);
		}
		80% {
			transform: translateX(-1.5px);
		}
	}

	/* Thrown off the pill's right side rather than over it, where the only thing a rising
	   label can cross is empty margin: above it sits the tagline, and a number drifting
	   through a sentence reads as a rendering fault instead of a reward. */
	.pop {
		position: absolute;
		left: calc(100% + 0.45rem + var(--pop-x, 0rem));
		bottom: 0.1rem;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 700;
		white-space: nowrap;
		color: var(--color-accent);
		pointer-events: none;
		animation: pop-rise 900ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
	}

	.pop-final {
		font-size: 0.78rem;
		font-weight: 800;
	}

	@keyframes pop-rise {
		0% {
			transform: translateY(3px) scale(0.7);
			opacity: 0;
		}
		18% {
			transform: translateY(0) scale(1.12);
			opacity: 1;
		}
		32% {
			transform: translateY(-2px) scale(1);
			opacity: 1;
		}
		100% {
			transform: translateY(-26px) scale(0.96);
			opacity: 0;
		}
	}

	/* A thrown label is feedback, not decoration, so it keeps its whole life here and only
	   stops moving. The blanket rule would end the animation in 0.01ms and hold its last
	   frame, which is a number gone before it was read; with no animation at all the element
	   sits at its base state and the timer in `throwPop` clears it on the very same clock.
	   Both spellings are needed: the app's own motion setting stamps the attribute, and the
	   OS answers the query. The attribute rides `<html>`, outside this component, so it has
	   to be marked global or the whole rule is pruned as unused. */
	:global([data-motion='reduced']) .pop {
		animation: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.pop {
			animation: none;
		}
	}

	/* ===== Updates ===== */

	.note {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.73rem;
		line-height: 1.55;
		color: var(--color-text-muted);
	}

	.update {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.55rem;
	}

	.verdict {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		color: var(--color-text-secondary);
	}

	.verdict-new {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.verdict :global(.verdict-icon) {
		flex-shrink: 0;
		color: var(--color-accent);
	}

	.release {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-family: var(--font-ui);
		font-size: 0.76rem;
		font-weight: 600;
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 0.15em;
	}

	/* ===== Help & community ===== */

	.rows {
		display: flex;
		flex-direction: column;
	}

	/* Bleeds out to the card's padding edge so the hover band lines up with the card's own
	   frame, the same shape .toggle-row uses. The width is stated rather than left to `auto`,
	   because half these rows are buttons and a button sizes to its content: the band would
	   stop at the end of the label on one row and reach the frame on the next. */
	.row {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: calc(100% + 1rem);
		margin-inline: -0.5rem;
		padding: 0.42rem 0.5rem;
		border: none;
		border-radius: var(--radius-md);
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		transition: background-color 120ms ease;
	}

	.row:hover {
		background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
	}

	.row-label {
		font-family: var(--font-ui);
		font-size: 0.8rem;
		color: var(--color-text-primary);
	}

	.row-value {
		margin-left: auto;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.row :global(.row-icon) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.row:hover :global(.row-icon) {
		color: var(--color-accent);
	}

	.row :global(.row-out) {
		margin-left: auto;
		flex-shrink: 0;
		color: var(--color-text-muted);
		opacity: 0.65;
	}

	/* ===== Reach me ===== */

	.reach {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.7rem;
	}

	/* A shade warmer than the notes around it: this one is somebody talking, not the app
	   stating a fact, and the muted tone every other caption wears would bury it. */
	.personal {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		line-height: 1.6;
		color: var(--color-text-secondary);
	}

	.handle {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.32rem 0.65rem;
		border-radius: var(--radius-full);
		border: 1px solid var(--theme-border-raised);
		background: var(--theme-input-bg);
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: color 120ms ease, border-color 120ms ease;
	}

	.handle:hover {
		color: var(--color-text-primary);
		border-color: color-mix(in srgb, var(--color-accent) 45%, var(--theme-border-raised));
	}

	.handle code {
		font-size: 0.75rem;
	}

	.handle :global(.handle-glyph) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.handle:hover :global(.handle-glyph) {
		color: var(--color-accent);
	}

	/* ===== This install ===== */

	.loading {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		color: var(--color-text-muted);
	}

	.facts {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.fact {
		display: flex;
		align-items: baseline;
		gap: 1rem;
	}

	.fact-label {
		flex-shrink: 0;
		width: 4.6rem;
		font-family: var(--font-ui);
		font-size: 0.78rem;
		color: var(--color-text-muted);
	}

	.fact-value {
		font-family: var(--font-ui);
		font-size: 0.78rem;
		color: var(--color-text-primary);
	}

	.where {
		margin-top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.path {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.5rem;
		border-radius: 8px;
		border: 1px solid var(--theme-border-raised);
		background: var(--theme-input-bg);
		cursor: pointer;
		color: var(--color-text-secondary);
		text-align: left;
	}

	.path:hover {
		color: var(--color-text-primary);
	}

	.path code {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		font-size: 0.7rem;
	}

	.where-note {
		margin: 0.15rem 0 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.details {
		margin-top: 0.9rem;
	}

	/* ===== Legal ===== */

	.legal {
		margin: 0.35rem 0 0;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		line-height: 1.6;
		text-align: center;
		color: var(--color-text-muted);
	}

	.legal a {
		color: var(--color-text-secondary);
		text-decoration: underline;
		text-underline-offset: 0.15em;
	}

	.legal a:hover {
		color: var(--color-accent);
	}
</style>
