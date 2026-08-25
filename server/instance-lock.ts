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
 * everything else a unix socket, kept out of the data folder for the reason in `addressFor`.
 *
 * **The starting instance connects rather than binding.** Reaching the address is proof enough
 * that someone holds it, and the holder writes back who it is, so the refusal can name a port
 * and a process instead of just saying no. Binding to find out would also be the one call Bun
 * cannot report on a contended pipe: it aborts the process instead of raising. **Being refused
 * is not the same proof in reverse**, and is asked again before it counts (`REFUSAL_ASKS`): a
 * live holder refuses the odd connection, and that is the answer which deletes the address.
 *
 * Two launches inside the same event-loop tick can both find the address free. Nothing here
 * closes that window, and closing it would take a second lock with the staleness problem this
 * one exists to avoid; a double launch by hand is milliseconds wide at its fastest.
 */
import { createHash } from 'node:crypto';
import { realpathSync, unlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';

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
 * How many times a refusal is asked again before it counts, and how long between asks.
 *
 * A unix socket server refuses the occasional connection while it is alive and listening
 * (Linux, Bun 1.3.9: about one connect in two hundred, on an otherwise idle server, with or
 * without a backlog of its own). A refusal is the one answer that makes a launch delete the
 * address and take the folder, so believing a false one hands a running copy's folder to the
 * copy starting beside it, which is the whole failure this module exists to prevent. Every
 * refusal measured from a live holder was gone by the very next ask.
 */
const REFUSAL_ASKS = 4;
const REFUSAL_GAP_MS = 25;

/**
 * One address per data folder, and the same address from either side of it: the path is
 * canonicalised before it is hashed, so a symlink, a mapped drive and a different spelling of one
 * folder all land on one name. Two genuinely different paths to one folder across a network share
 * do not, and cannot: nothing local can see that they are the same folder.
 *
 * **The address is never inside the data folder**, however much the claim belongs to it. Two
 * `fs.watch` handles sit on that directory for the life of the process (watch-file.ts), and on
 * Linux a watcher meeting a new socket there opens it, gets `ENXIO` and takes the process down.
 * Nor is it `os.tmpdir()`, which is a scratch space rather than a meeting place: it follows
 * `TMPDIR` and is per-user on macOS, so two launches that disagreed about it would each find
 * their own address free and both run against one folder. `/tmp` is the one directory both of
 * those platforms agree on. Windows has no file at all: a pipe lives in a flat machine-global
 * namespace, which is what the hashed name is for.
 */
function addressFor(dataDir: string): string {
	const canonical = realpathSync.native(dataDir);
	const key = createHash('sha256')
		.update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
		.digest('hex')
		.slice(0, 16);
	return process.platform === 'win32'
		? `\\\\.\\pipe\\chungushub-${key}`
		: `/tmp/chungushub-${key}.sock`;
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
 * The enquiry a launch acts on: the same question as `askWhoHolds`, except that a refusal has
 * to repeat before it is taken for an answer. An address that is genuinely dead refuses every
 * time, so nothing that should get in is kept out: it costs such a launch a few milliseconds.
 */
async function whoHolds(address: string): Promise<{ holder: RunningInstance | null; code: string | null }> {
	for (let ask = 1; ; ask++) {
		const answer = await askWhoHolds(address);
		if (answer.holder || answer.code !== 'ECONNREFUSED' || ask === REFUSAL_ASKS) return answer;
		await new Promise((wake) => setTimeout(wake, REFUSAL_GAP_MS));
	}
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
		const answer = await whoHolds(address);
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
	// before this one can bind. **Only for the two codes that mean nobody is there**, and for a
	// refusal only once it has repeated: any other failure to reach it (a socket owned by another
	// user, a descriptor limit) says the folder might well be held, and removing it then is how
	// two copies end up writing one database.
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
