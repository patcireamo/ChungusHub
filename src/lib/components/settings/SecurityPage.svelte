<script lang="ts">
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import {
		allowIpAddress,
		getAccessInfo,
		getSecurityInfo,
		revokeIpAddress,
		setIpAllowlistEnabled,
		setNetworkAccessEnabled,
		setPasswordLockEnabled,
		setSecurityPassword,
		setSessionIdleMinutes,
		type AccessInfo,
		type DeniedAttempt
	} from '$lib/services/transport';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import InfoTip from '$lib/components/ui/InfoTip.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import { formatRelativeTime } from '$lib/utils/date';
	import MockupTip from '$lib/components/mockups/MockupTip.svelte';
	import IpAllowlistMockup from '$lib/components/mockups/IpAllowlistMockup.svelte';
	import { toggleRow } from '$lib/actions/toggleRow';

	const MIN_PASSWORD_LENGTH = 4;

	// ===== Access control (IP allowlist) =====
	let allowed = $state<string[]>([]);
	let recent = $state<DeniedAttempt[]>([]);
	let online = $state<string[]>([]);
	let yourIp = $state<string | null>(null);
	let yourIpAllowed = $state(false);
	let newIp = $state('');
	let accessError = $state('');
	let busy = $state(false);
	// The manual by-address form is an escape hatch, folded away by default:
	// the waiting list covers the normal flow without any typing.
	let manualOpen = $state(false);

	// The machine ChungusHub runs on is allowed by being that machine rather than by
	// sitting in the file, so it gets the pinned row and is kept out of the list below:
	// it can be added by hand, and would otherwise show up as two devices. Everything
	// else is listed identically wherever this page is open, in the order the server
	// sorts it, so only the "This device" marker moves from screen to screen.
	const LOOPBACK_IPS = ['127.0.0.1', '::1'];
	let isHostDevice = $derived(yourIp !== null && LOOPBACK_IPS.includes(yourIp));
	let hostOnline = $derived(LOOPBACK_IPS.some((ip) => online.includes(ip)));
	let listedDevices = $derived(allowed.filter((ip) => !LOOPBACK_IPS.includes(ip)));
	let otherDeviceCount = $derived(listedDevices.filter((ip) => ip !== yourIp).length);
	/** The reader's own address, held while its removal is being confirmed. */
	let removeSelfIp = $state<string | null>(null);

	// Switching approval on from a device the gate would refuse is a one-way door: doing
	// it drops every open connection, this device's next request lands on the waiting
	// page, and letting it back in takes a device that is already approved. The host
	// machine is always one of those, so this only ever fires over the network, and on a
	// machine with no screen there is no way back at all. Asked, never assumed.
	let wouldLockSelfOut = $derived(yourIp !== null && !yourIpAllowed);
	let lockoutOpen = $state(false);

	// ===== Network access (the master switch) =====
	// Off closes the server's port to everything but this computer, so there is no
	// ChungusHub on the network to find. The two cards below decide who gets past a
	// port that is open, so with it shut they have nothing to say and are not rendered.
	let networkEnabled = $state(false);
	let networkError = $state('');

	// Off pressed from a device that is not the host machine cuts that device off with
	// every other one on the network the moment the port closes, and reopening takes
	// the computer ChungusHub runs on. Asked, never assumed; an address that never
	// loaded is asked too, since the silent direction is the lockout.
	let networkOffOpen = $state(false);

	// ===== Password lock =====
	// Two states, one per `passwordSet`: no password yet → the setup form is the whole
	// story; a password exists → an on/off switch, the idle window, a folded change form.
	let allowlistEnabled = $state(true);
	let passwordEnabled = $state(false);
	let passwordSet = $state(false);
	let newPassword = $state('');
	let showPassword = $state(false);
	// Only meaningful once a password exists: reveals the change form.
	let changeOpen = $state(false);
	let securityError = $state('');
	let securityBusy = $state(false);

	let passwordValid = $derived(newPassword.length >= MIN_PASSWORD_LENGTH);

	// The idle window, in minutes, 0 meaning never. The field is a draft rather than the
	// value: the 5s poll below would otherwise overwrite a number while it is being typed,
	// so it only follows the server while the two still agree.
	let idleMinutes = $state(60);
	let idleInput = $state('60');
	let idleDirty = $derived(idleInput.trim() !== String(idleMinutes));
	let idleValid = $derived(/^\d+$/.test(idleInput.trim()));

	onMount(() => {
		loadAccess();
		loadSecurity();
		// Keep the waiting list live while the tab is open, so a device knocking on
		// the door shows up here within seconds. The switches are re-read alongside
		// it because they can also move without this page: the server applies edits
		// made to security.json directly, and toggles left showing the old positions
		// would be the one place in the app lying about what the server is doing.
		const poll = setInterval(() => {
			if (busy || securityBusy) return;
			loadSecurity();
			if (networkEnabled) loadAccess();
		}, 5000);
		return () => clearInterval(poll);
	});

	function applyAccess(info: AccessInfo): void {
		allowed = info.allowed;
		recent = info.recent;
		online = info.online;
		yourIp = info.yourIp;
		yourIpAllowed = info.yourIpAllowed;
	}

	async function loadAccess(): Promise<void> {
		try {
			applyAccess(await getAccessInfo());
		} catch (e) {
			accessError = e instanceof Error ? e.message : 'Failed to load access list';
		}
	}

	async function loadSecurity(): Promise<void> {
		try {
			const info = await getSecurityInfo();
			const idleWasClean = !idleDirty;
			networkEnabled = info.networkAccessEnabled;
			allowlistEnabled = info.ipAllowlistEnabled;
			passwordEnabled = info.passwordEnabled;
			passwordSet = info.passwordSet;
			idleMinutes = info.sessionIdleMinutes;
			if (idleWasClean) idleInput = String(idleMinutes);
		} catch (e) {
			securityError = e instanceof Error ? e.message : 'Failed to load security settings';
		}
	}

	async function toggleNetwork(on: boolean): Promise<void> {
		if (securityBusy) return;
		// Switching on shuts nobody out, so only the other direction is asked about.
		// Nothing moves while the question stands: the switch reads its position from
		// `networkEnabled`, so backing out leaves it where it was with no snap-back.
		if (!on && !isHostDevice) {
			networkOffOpen = true;
			return;
		}
		await applyNetwork(on);
	}

	async function applyNetwork(on: boolean): Promise<void> {
		securityBusy = true;
		networkError = '';
		try {
			await setNetworkAccessEnabled(on);
			networkEnabled = on;
		} catch (e) {
			networkError = e instanceof Error ? e.message : 'Failed to update network access';
		} finally {
			securityBusy = false;
		}
	}

	async function confirmNetworkOff(): Promise<void> {
		networkOffOpen = false;
		await applyNetwork(false);
	}

	async function toggleAllowlist(on: boolean): Promise<void> {
		if (securityBusy) return;
		// Switching off never shuts anyone out, so only the other direction is asked about.
		// Nothing moves while the question stands: the switch reads its position from
		// `allowlistEnabled`, so backing out leaves it where it was with no snap-back.
		if (on && wouldLockSelfOut) {
			lockoutOpen = true;
			return;
		}
		await applyAllowlist(on);
	}

	async function applyAllowlist(on: boolean): Promise<void> {
		securityBusy = true;
		accessError = '';
		try {
			await setIpAllowlistEnabled(on);
			allowlistEnabled = on;
		} catch (e) {
			accessError = e instanceof Error ? e.message : 'Failed to update allowlist setting';
		} finally {
			securityBusy = false;
		}
	}

	/** The order is the whole of it: this device joins the list first, so the switch that
	 *  drops every connection a moment later finds it already approved. The other way
	 *  round it is refused between the two calls and the second one never arrives. */
	async function allowSelfAndEnable(): Promise<void> {
		lockoutOpen = false;
		if (!yourIp || busy || securityBusy) return;
		if (!(await doAllow(yourIp))) return;
		await applyAllowlist(true);
	}

	async function doAllow(ip: string): Promise<boolean> {
		if (busy) return false;
		busy = true;
		accessError = '';
		try {
			applyAccess(await allowIpAddress(ip));
			return true;
		} catch (e) {
			accessError = e instanceof Error ? e.message : 'Failed to add IP';
			return false;
		} finally {
			busy = false;
		}
	}

	async function addIp(): Promise<void> {
		const ip = newIp.trim();
		if (!ip) return;
		if (await doAllow(ip)) newIp = '';
	}

	/** Only the reader's own row can cut the reader off, and only while approval is the
	 *  gate: with it switched off an address decides nothing until it is switched back
	 *  on, and the switch asks its own question at that point. */
	function requestRemove(ip: string): void {
		if (ip === yourIp && allowlistEnabled) {
			removeSelfIp = ip;
			return;
		}
		removeIp(ip);
	}

	async function confirmRemoveSelf(): Promise<void> {
		const ip = removeSelfIp;
		removeSelfIp = null;
		if (ip) await removeIp(ip);
	}

	async function removeIp(ip: string): Promise<void> {
		if (busy) return;
		busy = true;
		accessError = '';
		try {
			applyAccess(await revokeIpAddress(ip));
		} catch (e) {
			accessError = e instanceof Error ? e.message : 'Failed to remove IP';
		} finally {
			busy = false;
		}
	}

	// Set the first password, or change an existing one: same call, same form.
	// Both switch the lock on server-side; the calling device keeps its session.
	async function savePassword(): Promise<void> {
		if (!passwordValid || securityBusy) return;
		securityBusy = true;
		securityError = '';
		try {
			await setSecurityPassword(newPassword);
			passwordEnabled = true;
			passwordSet = true;
			newPassword = '';
			showPassword = false;
			changeOpen = false;
		} catch (e) {
			securityError = e instanceof Error ? e.message : 'Failed to set password';
		} finally {
			securityBusy = false;
		}
	}

	function cancelChange(): void {
		changeOpen = false;
		newPassword = '';
		showPassword = false;
		securityError = '';
	}

	async function togglePassword(on: boolean): Promise<void> {
		if (securityBusy) return;
		securityBusy = true;
		securityError = '';
		try {
			await setPasswordLockEnabled(on);
			passwordEnabled = on;
		} catch (e) {
			securityError = e instanceof Error ? e.message : 'Failed to update password lock';
		} finally {
			securityBusy = false;
		}
	}

	async function saveIdle(): Promise<void> {
		if (!idleValid || !idleDirty || securityBusy) return;
		securityBusy = true;
		securityError = '';
		const minutes = Number(idleInput.trim());
		try {
			await setSessionIdleMinutes(minutes);
			idleMinutes = minutes;
			// "060" saves as 60, and a field left spelling it the other way reads as unsaved.
			idleInput = String(minutes);
		} catch (e) {
			securityError = e instanceof Error ? e.message : 'Failed to update the idle timeout';
		} finally {
			securityBusy = false;
		}
	}

	function focusOnMount(node: HTMLElement): void {
		node.focus();
	}
</script>

<div class="space-y-6">
	<section class="security-card" data-setting="network-access">
		<header class="card-head">
			<div class="card-heading">
				<div class="title-row">
					<h3 class="card-title">Network Access</h3>
					<InfoTip
						text="Off is not a block: the app's port is closed, so there is nothing on the network to find. This computer is never affected, though flipping the switch reopens the port and the app reconnects."
					/>
				</div>
				<p class="card-sub">Whether ChungusHub exists on your network at all.</p>
			</div>
		</header>

		<div class="card-body">
			<div class="row" use:toggleRow>
				<div class="row-copy">
					<span class="row-label">Open on the network</span>
					<span class="row-desc">
						{#if networkEnabled}
							Other devices can reach the app. Which ones is decided below.
						{:else}
							The app runs for this computer alone.
						{/if}
					</span>
				</div>
				<Toggle
					checked={networkEnabled}
					disabled={securityBusy}
					label="Open on the network"
					onchange={toggleNetwork}
				/>
			</div>

			{#if networkError}
				<p class="error-line">{networkError}</p>
			{/if}
		</div>
	</section>

	{#if networkEnabled}
		<section class="security-card" data-setting="ip-allowlist">
			<header class="card-head">
				<div class="card-heading">
					<div class="title-row">
						<h3 class="card-title">Device Access</h3>
						<MockupTip
							text="Every device on your network has its own address. An unapproved one lands on a waiting page and shows up here, ready for a single Allow."
						>
							<IpAllowlistMockup />
						</MockupTip>
					</div>
					<p class="card-sub">Choose which devices on your network can open ChungusHub.</p>
				</div>
			</header>

			<div class="card-body">
				<div class="row" use:toggleRow>
					<div class="row-copy">
						<span class="row-label">Require approval</span>
						{#if !allowlistEnabled}
							<span class="row-desc row-desc-warn">
								Approval is off, anyone on your network can connect.
							</span>
						{/if}
					</div>
					<Toggle
						checked={allowlistEnabled}
						disabled={securityBusy}
						label="Require approval"
						onchange={toggleAllowlist}
					/>
				</div>

				{#if allowlistEnabled}
					{#if recent.length}
						<div class="group" transition:slide={{ duration: 160 }}>
							<span class="section-label group-label">Waiting to connect</span>
							{#each recent as attempt (attempt.ip)}
								<div class="row wait-row" transition:slide={{ duration: 160 }}>
									<span class="pulse-dot"></span>
									<div class="row-copy">
										<span class="row-ip">{attempt.ip}</span>
										<span class="row-desc">{formatRelativeTime(attempt.lastSeen)}</span>
									</div>
									<button
										class="allow-btn"
										type="button"
										onclick={() => doAllow(attempt.ip)}
										disabled={busy}
									>
										Allow
									</button>
								</div>
							{/each}
						</div>
					{/if}

					<div class="group">
						<span class="section-label group-label">Allowed devices</span>

						<div class="row">
							<span
								class="device-dot"
								class:is-you={isHostDevice}
								class:is-online={hostOnline}
								title={hostOnline ? 'Connected right now' : undefined}
							></span>
							<div class="row-copy">
								<span class="row-ip">127.0.0.1</span>
								<span class="row-desc">
									{isHostDevice ? 'This device' : 'The computer running ChungusHub'}, always allowed
								</span>
							</div>
						</div>

						{#each listedDevices as ip (ip)}
							<div class="row" transition:slide={{ duration: 160 }}>
								<span
									class="device-dot"
									class:is-you={ip === yourIp}
									class:is-online={online.includes(ip)}
									title={online.includes(ip) ? 'Connected right now' : undefined}
								></span>
								<div class="row-copy">
									<span class="row-ip">{ip}</span>
									{#if ip === yourIp}
										<span class="row-desc">This device</span>
									{/if}
								</div>
								<button
									class="remove-btn"
									type="button"
									onclick={() => requestRemove(ip)}
									disabled={busy}
									aria-label={`Remove ${ip}`}
								>
									<Icon name="trash" class="w-3.5 h-3.5" />
								</button>
							</div>
						{/each}

						{#if !otherDeviceCount && !recent.length}
							<p class="empty-hint">
								No other devices yet. Open ChungusHub on one and it will appear above, waiting for
								your approval.
							</p>
						{/if}
					</div>

					<div class="group">
						{#if !manualOpen}
							<button class="manual-toggle" type="button" onclick={() => (manualOpen = true)}>
								<Icon name="plus" class="w-3.5 h-3.5" strokeWidth={2} />
								Add a device by address
							</button>
						{:else}
							<form
								class="manual-form"
								transition:slide={{ duration: 160 }}
								onsubmit={(e) => {
									e.preventDefault();
									addIp();
								}}
							>
								<input
									class="input-base ip-input"
									type="text"
									bind:value={newIp}
									placeholder="e.g. 192.168.1.23"
									autocomplete="off"
									spellcheck="false"
									use:focusOnMount
								/>
								<button class="primary-btn" type="submit" disabled={busy || !newIp.trim()}>
									Allow
								</button>
							</form>
						{/if}
					</div>
				{/if}

				{#if accessError}
					<p class="error-line">{accessError}</p>
				{/if}
			</div>
		</section>

		<section class="security-card" data-setting="password-lock">
			<header class="card-head">
				<div class="card-heading">
					<div class="title-row">
						<h3 class="card-title">Password Lock</h3>
						<InfoTip
							text="This computer is never asked, only your other devices are. Locked out? Delete security.json in your data folder."
						/>
					</div>
					<p class="card-sub">Other devices must enter a password before they can use the app.</p>
				</div>
			</header>

			<div class="card-body">
				{#if !passwordSet}
					<!-- No password yet: the setup form is the whole card. Nothing to
					     toggle, nothing to change. Create one and the lock is on. -->
					<div class="group">
						<span class="row-label">Set a password</span>
						<form
							class="pw-form"
							onsubmit={(e) => {
								e.preventDefault();
								savePassword();
							}}
						>
							<div class="pw-field">
								<input
									class="input-base text-input"
									type={showPassword ? 'text' : 'password'}
									bind:value={newPassword}
									placeholder="At least {MIN_PASSWORD_LENGTH} characters"
									autocomplete="new-password"
									spellcheck="false"
								/>
								<button
									class="eye-btn"
									type="button"
									onclick={() => (showPassword = !showPassword)}
									aria-label={showPassword ? 'Hide password' : 'Show password'}
									tabindex="-1"
								>
									<Icon name={showPassword ? 'eyeOff' : 'eye'} class="w-4 h-4" />
								</button>
							</div>
							<button class="primary-btn" type="submit" disabled={securityBusy || !passwordValid}>
								Set password
							</button>
						</form>
					</div>
				{:else}
					<!-- Password exists: an on/off switch, the idle window, a folded change form. -->
					<div class="row" use:toggleRow>
						<div class="row-copy">
							<span class="row-label">Require password</span>
							<span class="row-desc">
								{#if passwordEnabled}
									Other devices need the password to connect.
								{:else}
									The password is saved but not required.
								{/if}
							</span>
						</div>
						<Toggle
							checked={passwordEnabled}
							disabled={securityBusy}
							label="Require password"
							onchange={togglePassword}
						/>
					</div>

					<div class="group">
						<span class="row-label">Ask again when idle</span>
						<span class="row-desc">
							{#if idleMinutes === 0}
								Other devices stay unlocked until the password changes.
							{:else}
								A device left alone this long is asked for the password again. Set 0 to stop
								asking.
							{/if}
						</span>
						<form
							class="pw-form"
							onsubmit={(e) => {
								e.preventDefault();
								saveIdle();
							}}
						>
							<input
								class="input-base idle-input"
								type="text"
								inputmode="numeric"
								bind:value={idleInput}
								autocomplete="off"
								spellcheck="false"
								aria-label="Minutes before an idle device is asked again"
							/>
							<span class="idle-unit">minutes</span>
							<button
								class="primary-btn idle-save"
								type="submit"
								disabled={securityBusy || !idleValid || !idleDirty}
							>
								Save
							</button>
						</form>
					</div>

					<div class="group">
						{#if !changeOpen}
							<button class="manual-toggle" type="button" onclick={() => (changeOpen = true)}>
								<Icon name="lock" class="w-3.5 h-3.5" strokeWidth={2} />
								Change password
							</button>
						{:else}
							<form
								class="pw-form"
								transition:slide={{ duration: 160 }}
								onsubmit={(e) => {
									e.preventDefault();
									savePassword();
								}}
							>
								<div class="pw-field">
									<input
										class="input-base text-input"
										type={showPassword ? 'text' : 'password'}
										bind:value={newPassword}
										placeholder="New password ({MIN_PASSWORD_LENGTH}+ characters)"
										autocomplete="new-password"
										spellcheck="false"
										use:focusOnMount
									/>
									<button
										class="eye-btn"
										type="button"
										onclick={() => (showPassword = !showPassword)}
										aria-label={showPassword ? 'Hide password' : 'Show password'}
										tabindex="-1"
									>
										<Icon name={showPassword ? 'eyeOff' : 'eye'} class="w-4 h-4" />
									</button>
								</div>
								<button class="ghost-btn" type="button" onclick={cancelChange}>Cancel</button>
								<button class="primary-btn" type="submit" disabled={securityBusy || !passwordValid}>
									Update
								</button>
							</form>
							<span class="row-desc pw-lead">Changing it signs every other device out.</span>
						{/if}
					</div>
				{/if}

				{#if securityError}
					<p class="error-line">{securityError}</p>
				{/if}
			</div>
		</section>
	{/if}
</div>

<!-- None is marked destructive: that rung lets a reader switch the asking off, and all
	 three of these exist to stop the same lockout, which is the one question that has to
	 survive an impatient afternoon of deleting things. -->
<ConfirmDialog
	open={networkOffOpen}
	title="Shut out the device you are on?"
	message={`Switching this off closes the port for every device on the network at once. Turning it back on takes the computer ChungusHub runs on: flip the switch there, or set "networkAccessEnabled" to true in security.json in your data folder.`}
	confirmLabel="Switch off anyway"
	variant="danger"
	onConfirm={confirmNetworkOff}
	onCancel={() => (networkOffOpen = false)}
/>

<ConfirmDialog
	open={lockoutOpen}
	title="This device is not approved yet"
	message={`This device (${yourIp}) is not on the list. Switching approval on now would shut it out, and letting it back in takes another device that is already approved.`}
	confirmLabel="Approve and switch on"
	onConfirm={allowSelfAndEnable}
	onCancel={() => (lockoutOpen = false)}
/>

<ConfirmDialog
	open={removeSelfIp !== null}
	title="Remove the device you are on?"
	message={`${removeSelfIp} is the device reading this. Removing it closes ChungusHub here, and opening it again takes another approved device or the computer ChungusHub runs on.`}
	confirmLabel="Remove anyway"
	variant="danger"
	onConfirm={confirmRemoveSelf}
	onCancel={() => (removeSelfIp = null)}
/>

<style>
	/* ── Card shell ─────────────────────────────────────────────────────── */
	.security-card {
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 60%, transparent);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-bg-secondary) 86%, transparent);
		overflow: hidden;
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		padding: 0.9rem 0.95rem 0.75rem;
	}

	.card-heading {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.card-sub {
		font-family: var(--font-ui);
		font-size: 0.72rem;
		line-height: 1.4;
		color: var(--color-text-muted);
	}

	/* ── Grouped rows (inset-list feel: hairlines between sections) ─────── */
	.card-body {
		display: flex;
		flex-direction: column;
		padding: 0 0.95rem 0.8rem;
	}

	.card-body > * + * {
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 75%, transparent);
	}

	.group {
		display: flex;
		flex-direction: column;
		padding: 0.55rem 0;
	}

	.group-label {
		padding-bottom: 0.15rem;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.5rem 0;
	}

	.group .row + .row {
		border-top: 1px solid color-mix(in srgb, var(--color-border-subtle) 55%, transparent);
	}

	.row-copy {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.12rem;
	}

	.row-label {
		font-family: var(--font-ui);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.row-desc {
		font-family: var(--font-ui);
		font-size: 0.7rem;
		line-height: 1.35;
		color: var(--color-text-muted);
	}

	.row-desc-warn {
		color: var(--color-warning);
	}

	.row-ip {
		font-family: var(--font-mono, monospace);
		font-size: 0.8rem;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ── Waiting list ───────────────────────────────────────────────────── */
	.wait-row {
		margin: 0.2rem 0;
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-accent) 24%, transparent);
		background: color-mix(in srgb, var(--color-accent) 7%, transparent);
	}

	.group .wait-row + .wait-row {
		border-top: 1px solid color-mix(in srgb, var(--color-accent) 24%, transparent);
	}

	.pulse-dot {
		position: relative;
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-full);
		background: var(--color-accent);
	}

	.pulse-dot::after {
		content: '';
		position: absolute;
		inset: -4px;
		border-radius: var(--radius-full);
		border: 1px solid var(--color-accent);
		animation: knock-pulse 1.8s ease-out infinite;
	}

	@keyframes knock-pulse {
		0% {
			transform: scale(0.55);
			opacity: 0.8;
		}
		70%,
		100% {
			transform: scale(1.5);
			opacity: 0;
		}
	}

	.allow-btn,
	.primary-btn {
		flex-shrink: 0;
		padding: 0.34rem 0.9rem;
		border-radius: var(--radius-full);
		border: 0;
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 650;
		cursor: pointer;
		transition: background-color 120ms ease, transform 80ms ease;
	}

	.allow-btn:hover:not(:disabled),
	.primary-btn:hover:not(:disabled) {
		background: var(--color-accent-hover);
	}

	.allow-btn:active:not(:disabled),
	.primary-btn:active:not(:disabled) {
		transform: scale(0.96);
	}

	.allow-btn:disabled,
	.primary-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* ── Allowed devices ────────────────────────────────────────────────── */
	.device-dot {
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-text-muted) 55%, transparent);
	}

	.device-dot.is-you,
	.device-dot.is-online {
		background: var(--color-success);
		box-shadow: 0 0 6px color-mix(in srgb, var(--color-success) 55%, transparent);
	}

	.remove-btn {
		flex-shrink: 0;
		display: inline-grid;
		place-items: center;
		width: 1.8rem;
		height: 1.8rem;
		border-radius: var(--radius-sm);
		border: 0;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.remove-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-error) 14%, transparent);
		color: var(--color-error);
	}

	.remove-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.empty-hint {
		padding: 0.45rem 0;
		font-family: var(--font-ui);
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--color-text-muted);
	}

	/* ── Manual add & password forms ────────────────────────────────────── */
	.manual-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 0;
		border: 0;
		background: transparent;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: color 120ms ease;
	}

	.manual-toggle:hover {
		color: var(--color-accent);
	}

	.manual-form {
		display: flex;
		gap: 0.5rem;
		padding: 0.5rem 0;
	}

	.ip-input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0.7rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.85rem;
		color: var(--color-text-primary);
	}

	/* ── Password lock ──────────────────────────────────────────────────── */
	.pw-lead {
		padding-bottom: 0.15rem;
	}

	.pw-form {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding-top: 0.5rem;
	}

	.pw-field {
		position: relative;
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
	}

	.text-input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 2.1rem 0.5rem 0.7rem;
		font-family: var(--font-ui);
		font-size: 0.85rem;
		color: var(--color-text-primary);
	}

	.idle-input {
		flex: 0 0 4.5rem;
		padding: 0.5rem 0.7rem;
		font-family: var(--font-ui);
		font-size: 0.85rem;
		text-align: center;
		color: var(--color-text-primary);
	}

	.idle-unit {
		font-family: var(--font-ui);
		font-size: 0.72rem;
		color: var(--color-text-muted);
	}

	.idle-save {
		margin-left: auto;
	}

	.eye-btn {
		position: absolute;
		right: 0.35rem;
		display: inline-grid;
		place-items: center;
		width: 1.6rem;
		height: 1.6rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: color 120ms ease;
	}

	.eye-btn:hover {
		color: var(--color-text-primary);
	}

	.ghost-btn {
		flex-shrink: 0;
		padding: 0.34rem 0.75rem;
		border-radius: var(--radius-full);
		border: 1px solid color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
		background: transparent;
		color: var(--color-text-secondary);
		font-family: var(--font-ui);
		font-size: 0.74rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.ghost-btn:hover {
		background: color-mix(in srgb, var(--color-text-muted) 12%, transparent);
		color: var(--color-text-primary);
	}

	.error-line {
		padding: 0.45rem 0 0.1rem;
		font-family: var(--font-ui);
		font-size: 0.74rem;
		color: var(--color-error);
	}

	@media (prefers-reduced-motion: reduce) {
		.pulse-dot::after {
			animation: none;
			opacity: 0;
		}
	}
</style>
