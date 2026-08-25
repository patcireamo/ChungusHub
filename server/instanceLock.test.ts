import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One running ChungusHub per data folder (server/instance-lock.ts).
 *
 * Both halves need real processes, so this spawns the executable rather than calling into the
 * module: what is being pinned is that the OS releases the claim, and only an OS can be asked
 * that. Each instance takes an OS-assigned port, so a port collision can never be what stops
 * the second one. Every test brings its own folder and its own children, since a test that
 * inherits another's server passes or fails on the order they happened to run in.
 */

const scratches: string[] = [];
const running: ReturnType<typeof Bun.spawn>[] = [];

function launch(dataRoot: string): ReturnType<typeof Bun.spawn> {
	const child = Bun.spawn([process.execPath, 'server/index.ts'], {
		env: {
			...process.env,
			// `bun test` puts NODE_ENV=test in the environment the child would inherit, and
			// config.ts reads exactly that to decide whether to create the data dirs.
			NODE_ENV: 'production',
			CHUNGUS_PORT: '0',
			CHUNGUS_HOST: '127.0.0.1',
			CHUNGUS_DATA_DIR: join(dataRoot, 'data'),
			CHUNGUS_BACKUP_DIR: join(dataRoot, 'backups'),
			CHUNGUS_NO_OPEN: '1'
		},
		stdout: 'pipe',
		stderr: 'pipe'
	});
	running.push(child);
	return child;
}

/** A folder of its own, remembered so the teardown can take it away again. */
function scratchRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'chungus-lock-'));
	scratches.push(root);
	return root;
}

/** Everything a finished child said, both streams, since a refusal is written to stderr. */
async function said(child: ReturnType<typeof Bun.spawn>): Promise<string> {
	const [out, err] = await Promise.all([
		new Response(child.stdout as ReadableStream).text(),
		new Response(child.stderr as ReadableStream).text()
	]);
	return `${out}\n${err}`;
}

/** Read a live child's stdout until it announces a port, so the test waits on the claim
 *  being held rather than on a duration. */
async function waitForBanner(child: ReturnType<typeof Bun.spawn>): Promise<void> {
	const decoder = new TextDecoder();
	let banner = '';
	for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
		banner += decoder.decode(chunk, { stream: true });
		if (/http:\/\/localhost:\d+/.test(banner)) return;
	}
	throw new Error(`The instance exited before it announced a port:\n${banner}`);
}

afterEach(async () => {
	for (const child of running) {
		child.kill();
		// Windows will not unlink a file another process still has open, and the child holds
		// the SQLite handle until it is actually gone.
		await child.exited;
	}
	running.length = 0;
	for (const root of scratches) {
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				rmSync(root, { recursive: true, force: true });
				break;
			} catch {
				await Bun.sleep(100);
			}
		}
	}
	scratches.length = 0;
});

test('a second copy refuses the data folder a first one is using', async () => {
	const root = scratchRoot();
	await waitForBanner(launch(root));

	const second = launch(root);
	const exitCode = await second.exited;

	expect(exitCode).not.toBe(0);
	expect(await said(second)).toContain('already using this data folder');
}, 60_000);

test('a copy killed outright leaves the folder claimable', async () => {
	const root = scratchRoot();
	const first = launch(root);
	await waitForBanner(first);

	// The claim is a socket the kernel owns, so this is the crash: no clean shutdown runs and
	// nothing gets to write a release, yet the next launch must still get in.
	first.kill();
	await first.exited;

	const next = launch(root);
	await waitForBanner(next);
	expect(next.killed).toBe(false);
}, 60_000);
