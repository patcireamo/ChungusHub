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

const ANNOUNCED_PORT = /http:\/\/localhost:\d+/;
/** A copy that will not start says so within this: a launch reaching the banner is a database
 *  opened and a library seeded, which the Windows runner's disk makes slow rather than stuck. */
const LAUNCH_MS = 30_000;
/** A refusal is deliberately not immediate: a holder is waited out first (instance-lock.ts),
 *  so this is that wait with room to spare rather than a guess at how long a launch takes. */
const REFUSAL_MS = 20_000;
/** Once the refusal is on screen, leaving is `process.exit` and nothing else. Short, so that
 *  every wait here can time out and still leave the test its own budget to report in. */
const EXIT_MS = 5_000;

interface Copy {
	child: ReturnType<typeof Bun.spawn>;
	/** Everything it has said so far, both streams, in the order it said it. */
	said: () => string;
}

const scratches: string[] = [];
const running: Copy[] = [];

function launch(dataRoot: string): Copy {
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

	// Both streams, for the whole life of the copy rather than once it has finished. A child
	// whose pipe nobody drains blocks on the write, and a claim that faults after it was taken
	// reports that on stderr and nowhere else, so reading one stream at the end would leave the
	// interesting half of a failure unread.
	let heard = '';
	const decoder = new TextDecoder();
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream) heard += decoder.decode(chunk, { stream: true });
	};
	void drain(child.stdout as ReadableStream<Uint8Array>).catch(() => {});
	void drain(child.stderr as ReadableStream<Uint8Array>).catch(() => {});

	const copy: Copy = { child, said: () => heard };
	running.push(copy);
	return copy;
}

/** A folder of its own, remembered so the teardown can take it away again. */
function scratchRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'chungus-lock-'));
	scratches.push(root);
	return root;
}

/** Waits on what a copy says rather than on a duration, and gives up on one that has exited:
 *  everything it was ever going to say is already in the pipe by then. */
async function waitUntilSaid(copy: Copy, pattern: RegExp, within: number): Promise<boolean> {
	const deadline = Date.now() + within;
	for (;;) {
		if (pattern.test(copy.said())) return true;
		if (copy.child.exitCode !== null) {
			await Bun.sleep(50);
			return pattern.test(copy.said());
		}
		if (Date.now() >= deadline) return false;
		await Bun.sleep(20);
	}
}

async function waitForBanner(copy: Copy): Promise<void> {
	if (await waitUntilSaid(copy, ANNOUNCED_PORT, LAUNCH_MS)) return;
	throw new Error(`This copy never announced a port. It said:\n${copy.said()}`);
}

/** Its exit code, or null while it is still running: a copy that will not leave has to fail
 *  the test with what it said, rather than by running the whole suite out of time. */
async function exitedWithin(copy: Copy, within: number): Promise<number | null> {
	const deadline = Date.now() + within;
	while (copy.child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
	return copy.child.exitCode;
}

afterEach(async () => {
	for (const copy of running) {
		copy.child.kill();
		// Windows will not unlink a file another process still has open, and the child holds
		// the SQLite handle until it is actually gone.
		await copy.child.exited;
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
	const first = launch(root);
	await waitForBanner(first);

	const second = launch(root);
	await waitUntilSaid(second, /already using this data folder/, REFUSAL_MS);
	const exitCode = await exitedWithin(second, EXIT_MS);

	expect(second.said()).toContain('already using this data folder');
	// Refusing and then staying up is the same thing as never refusing to whoever launched it.
	expect(exitCode).toBeGreaterThan(0);
	// The other half, and the one a refused launch cannot show on its own: the copy that was
	// holding the folder is still holding it. A claim that lapses under the second launch lets
	// it in instead, and two copies then write one database with nothing said anywhere.
	expect(first.child.exitCode).toBe(null);
	expect(first.said()).not.toContain('faulted');
}, 60_000);

test('a copy killed outright leaves the folder claimable', async () => {
	const root = scratchRoot();
	const first = launch(root);
	await waitForBanner(first);

	// The claim is a socket the kernel owns, so this is the crash: no clean shutdown runs and
	// nothing gets to write a release, yet the next launch must still get in. It is also the
	// one case that is refused every time it is asked, which is what the launch takes for dead.
	first.child.kill();
	await first.child.exited;

	const next = launch(root);
	await waitForBanner(next);
	expect(next.child.exitCode).toBe(null);
}, 60_000);
