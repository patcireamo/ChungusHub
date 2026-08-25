/**
 * One running ChungusHub per data folder.
 *
 * Nothing underneath enforces this. `bun:sqlite` takes no file lock, so two processes opening
 * one database both write it, each unaware of the other's rows, and the images, presets and
 * snapshot store beside it have no locking at all. Two copies pointed at one folder is not a
 * race the loser survives, and until now the only thing standing in the way was the two of them
 * wanting the same port, which stops being true the moment the port is a setting.
 *
 * **The lock is a socket, not a file.** A lock file records a claim and then has to guess
 * whether the claimant is still alive: a crash leaves the claim behind, and every rule for
 * deciding when to ignore it is either a heartbeat to keep writing or a pid that the OS is free
 * to hand to something else. A listening socket answers the question by existing. The kernel
 * releases it the instant the holder dies, however it dies, so there is no stale state to sweep
 * and no liveness to infer. On Windows that is a named pipe, which lives nowhere on disk; on
 * everything else a unix socket inside the data folder itself (see `addressFor`), which is a
 * path long enough to matter on macOS, where a socket path over about a hundred characters is
 * refused: a data folder buried that deep stops the launch with the reason on screen.
 *
 * **The starting instance connects rather than binding.** Reaching the address is proof enough
 * that someone holds it, and the holder writes back who it is, so the refusal can name a port
 * and a process instead of just saying no. Binding to find out would also be the one call Bun
 * cannot report on a contended pipe: it aborts the process instead of raising.
 *
 * Two launches inside the same event-loop tick can both find the address free. Nothing here
 * closes that window, and closing it would take a second lock with the staleness problem this
 * one exists to avoid; a double launch by hand is milliseconds wide at its fastest.
 */
import { createHash } from 'node:crypto';
import { realpathSync, unlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';

export interface RunningInstance {
	pid: number;
	port: number;
	startedAt: number;
}

/** Long enough for a loopback answer, short enough that a wedged holder cannot stall a launch. */
const ANSWER_MS = 1_000;

/**
 * How long a copy that is still holding the folder is waited out before the launch gives up on
 * it, and how often it is asked again. The wait exists for one case and it is the same one the
 * port bind waits for (server/index.ts): a process that died a moment ago and relaunched itself,
 * racing its own corpse. Without it a crash costs a start by hand.
 */
const CLAIM_WAIT_MS = 5_000;
const CLAIM_RETRY_MS = 100;

/** What a holder that answered nothing readable is reported as: it is still holding. */
const UNNAMED: RunningInstance = { pid: 0, port: 0, startedAt: 0 };

/**
 * One address per data folder, and the same address from either side of it.
 *
 * Off Windows that is a socket **inside the data folder**, which is what makes the claim belong
 * to the folder rather than to whoever launched: the temp dir would have done, but it follows
 * `TMPDIR` and is per-user on macOS, so two launches that disagree about it would each find
 * their own address free and both run against one folder. It sits outside `SNAPSHOT_ENTRIES`, so
 * no snapshot carries it and no restore swaps it. Windows has no such file: a pipe lives in a
 * flat machine-global namespace, so the name is a hash of the canonicalised path, which also
 * folds a symlink, a mapped drive and a different spelling of one folder onto one name. Two
 * genuinely different paths to one folder across a network share do not meet either way, and
 * cannot: nothing local can see that they are the same folder.
 */
function addressFor(dataDir: string): string {
	if (process.platform !== 'win32') return join(dataDir, '.instance.sock');
	const key = createHash('sha256')
		.update(realpathSync.native(dataDir).toLowerCase())
		.digest('hex')
		.slice(0, 16);
	return `\\\\.\\pipe\\chungushub-${key}`;
}

/**
 * Whoever holds the address, plus why nobody answered when nobody did. A connection that opens
 * is the answer; the identity that follows is decoration, and its absence must not read as free.
 *
 * The error code is the other half of the answer and is what keeps the caller from guessing: a
 * connect can fail because there is nothing there, or because there is something there this
 * process was not allowed to reach, and only the first of those is a folder going spare.
 */
function askWhoHolds(address: string): Promise<{ holder: RunningInstance | null; code: string | null }> {
	return new Promise((resolve) => {
		const socket = connect(address);
		let connected = false;
		let payload = '';
		let code: string | null = null;
		socket.setTimeout(ANSWER_MS, () => socket.destroy());
		socket.on('connect', () => {
			connected = true;
		});
		socket.on('data', (chunk) => {
			payload += chunk.toString();
		});
		socket.on('error', (error: NodeJS.ErrnoException) => {
			code = error.code ?? 'UNKNOWN';
		});
		socket.on('close', () => {
			if (!connected) return resolve({ holder: null, code });
			try {
				const parsed = JSON.parse(payload) as RunningInstance;
				resolve({ holder: typeof parsed?.pid === 'number' ? parsed : UNNAMED, code: null });
			} catch {
				resolve({ holder: UNNAMED, code: null });
			}
		});
	});
}

/**
 * Claim the data folder for this process, or report who already has it.
 *
 * `describe` is asked per enquiry rather than captured, because the claim is made before the
 * server binds and the port is the useful half of the answer.
 */
export async function claimDataDir(
	dataDir: string,
	describe: () => RunningInstance
): Promise<RunningInstance | null> {
	const address = addressFor(dataDir);
	const deadline = Date.now() + CLAIM_WAIT_MS;
	let said = false;
	let code: string | null = null;
	for (;;) {
		const answer = await askWhoHolds(address);
		if (!answer.holder) {
			code = answer.code;
			break;
		}
		if (Date.now() >= deadline) return answer.holder;
		if (!said) {
			console.log('  Another copy still has this data folder. Waiting for it to let go…');
			said = true;
		}
		await new Promise((wake) => setTimeout(wake, CLAIM_RETRY_MS));
	}

	// A unix socket outlives the process that made it, so the residue of a crash has to go
	// before this one can bind. **Only for the two codes that mean nobody is there**: any other
	// failure to reach it (a socket owned by another user, a descriptor limit) says the folder
	// might well be held, and removing it then is how two copies end up writing one database.
	if (process.platform !== 'win32' && code !== 'ENOENT') {
		if (code !== 'ECONNREFUSED') {
			throw new Error(`Could not tell whether ${address} is in use (${code ?? 'no answer'}).`);
		}
		unlinkSync(address);
	}

	const server = createServer((socket) => {
		// A peer that hangs up before this drains raises `error` on a socket nobody listens to,
		// and an unhandled one of those takes down the process holding the folder: the one
		// process this module exists to keep alive.
		socket.on('error', () => {});
		socket.end(JSON.stringify(describe()));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(address, () => {
			server.removeListener('error', reject);
			// Past here the claim is held, so an error is not a failed start: it is the lock
			// itself faulting, which nothing can repair from in here and nobody may miss.
			server.on('error', (error) =>
				console.error(`  The claim on this data folder faulted: ${error.message}`)
			);
			resolve();
		});
	});
	return null;
}
