/**
 * The parent half of the backup system: one job at a time, the unattended schedule, and the
 * reading the settings page renders.
 *
 * The job itself runs in a child process (`job.ts` explains why). Progress is not pushed
 * over the socket: the page polls while a job is live and stops when it is not, which is
 * one fewer message shape to keep in step across the bridge for something that happens a
 * few times a day. Completion broadcasts once on the `backups` scope so devices that are
 * NOT looking at the page still see the new row when they open it.
 */
import { rmSync } from 'node:fs';
import { IS_COMPILED, resolveBackupDir, resolveDataDir } from '../config';
import { serverDb } from '../db';
import type { SyncScope } from '../../shared/sync';
import {
	DEFAULT_BACKUP_SETTINGS,
	KEEP_SCHEDULED_RANGE,
	KEEP_UPGRADE_RANGE,
	BACKUP_INTERVALS,
	type BackupInterval,
	type BackupJobState,
	type BackupSettings,
	type BackupsPayload,
	type SnapshotKind,
	type SnapshotManifest
} from '../../shared/backups';
import { JOB_ENV, type JobMessage, type JobSpec } from './job';
import { listSnapshots } from './manifest';
import { prunable } from './retention';
import { snapshotPath } from './paths';
import { beginRestore, readJournal } from './restore';
import { scheduleDecision } from './schedule';

const SETTINGS_KEY = 'backupSettings';
/** When the data last changed. It lives in the settings table because the answer has to
 *  survive a restart: held only in memory it reads as "yes" on every launch, and an install
 *  nobody has touched then gets a full copy of itself once an interval for as long as it is
 *  owned. */
const CHANGED_AT_KEY = 'dataChangedAt';
const TICK_MS = 60_000;
/** Long enough after listen that a first-boot catch-up never competes with the first paint. */
const FIRST_TICK_MS = 15_000;
/**
 * A failed scheduled snapshot waits before trying again, doubling from five minutes and never
 * past the interval itself. The usual cause is a full disk, which does not clear inside a
 * minute, and each attempt walks the whole library and writes a partial copy before giving up.
 */
const RETRY_BASE_MS = 5 * 60_000;
/**
 * How long a job may say nothing before it is treated as wedged. It reports every phase and
 * every 250 files, so silence is not slowness: it is a child stuck on a file a scanner or a
 * network share will not release. Without this the lock is held for the life of the process:
 * no snapshot, no restore and no delete would be accepted again until the app was restarted.
 */
const JOB_SILENCE_MS = 10 * 60_000;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Degrade a corrupt blob to defaults rather than throwing, exactly as the client stores do
 * for every other preference. This is not a state file the server runs on: the worst a bad
 * value can do here is take a backup at the wrong hour.
 */
export function normalizeBackupSettings(raw: unknown): BackupSettings {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_BACKUP_SETTINGS };
	const s = raw as Record<string, unknown>;
	const interval = BACKUP_INTERVALS.includes(s.intervalHours as BackupInterval)
		? (s.intervalHours as BackupInterval)
		: DEFAULT_BACKUP_SETTINGS.intervalHours;
	return {
		automatic: s.automatic === undefined ? DEFAULT_BACKUP_SETTINGS.automatic : s.automatic === true,
		intervalHours: interval,
		keepScheduled: clamp(
			s.keepScheduled,
			KEEP_SCHEDULED_RANGE.min,
			KEEP_SCHEDULED_RANGE.max,
			DEFAULT_BACKUP_SETTINGS.keepScheduled
		),
		keepUpgrade: clamp(
			s.keepUpgrade,
			KEEP_UPGRADE_RANGE.min,
			KEEP_UPGRADE_RANGE.max,
			DEFAULT_BACKUP_SETTINGS.keepUpgrade
		)
	};
}

class BackupService {
	private job: BackupJobState | null = null;
	private locked = false;
	private failure: string | null = null;
	private broadcast: (scope: SyncScope) => void = () => {};
	private timer: ReturnType<typeof setInterval> | null = null;
	/** When the data last changed, as this process knows it. */
	private changedAt = 0;
	/** What the settings row currently says, so the first change after a snapshot is the only
	 *  one that has to reach the disk. */
	private persistedAt = 0;
	/** The newest snapshot's stamp, which is what `persistedAt` is measured against. */
	private anchorAt = 0;
	/** Consecutive scheduled failures, and the moment the next attempt is allowed. */
	private failures = 0;
	private retryAfter = 0;
	/** Held while the schedule cannot decide anything, so the page can say why. */
	private paused: string | null = null;

	/** Wired at boot so the service can announce a finished job without importing index.ts. */
	configure(broadcast: (scope: SyncScope) => void): void {
		this.broadcast = broadcast;
	}

	settings(): BackupSettings {
		const raw = serverDb.getSetting(SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_BACKUP_SETTINGS };
		try {
			return normalizeBackupSettings(JSON.parse(raw));
		} catch {
			return { ...DEFAULT_BACKUP_SETTINGS };
		}
	}

	/**
	 * Something was written. The schedule compares this against the newest snapshot's own
	 * stamp, so an install nobody has touched is never copied twice.
	 *
	 * Only the FIRST change after a snapshot reaches the disk: once the stored value is past
	 * the newest snapshot, the answer to "is anything owed a copy" is already yes and writing
	 * it again would buy nothing. That is one settings row per snapshot cycle, written the
	 * moment it becomes true rather than on a timer, so an app closed straight after an edit
	 * still knows the edit happened.
	 */
	markChanged(): void {
		this.changedAt = Date.now();
		if (this.persistedAt > this.anchorAt) return;
		this.persistedAt = this.changedAt;
		serverDb.setSetting(CHANGED_AT_KEY, String(this.changedAt));
	}

	state(): BackupJobState | null {
		return this.job;
	}

	isBusy(): boolean {
		return this.locked;
	}

	payload(): BackupsPayload {
		const { snapshots, unreadable } = listSnapshots();
		return {
			snapshots,
			job: this.job,
			location: resolveBackupDir(),
			totalBytes: snapshots.reduce((sum, s) => sum + s.bytes.onDisk, 0),
			lastError:
				this.failure ??
				this.paused ??
				(unreadable > 0
					? `${unreadable} folder${unreadable === 1 ? '' : 's'} here could not be read as a snapshot`
					: null)
		};
	}

	/**
	 * Serialize everything that touches the store. A snapshot must not run while a restore
	 * is swapping the files it would be copying, and two snapshots would both try to link
	 * against the same previous one while writing it.
	 */
	async withLock<T>(state: BackupJobState, run: (update: (patch: Partial<BackupJobState>) => void) => Promise<T>): Promise<T> {
		if (this.locked) {
			throw new Error('A backup is already running. Wait for it to finish, then try again.');
		}
		this.locked = true;
		this.job = state;
		this.failure = null;
		const task = (async () => {
			try {
				return await run((patch) => {
					if (this.job) this.job = { ...this.job, ...patch };
				});
			} catch (error) {
				this.failure = error instanceof Error ? error.message : String(error);
				throw error;
			} finally {
				this.locked = false;
				this.job = null;
				this.broadcast('backups');
			}
		})();
		return task;
	}

	/**
	 * Take one, in a child process, and prune afterwards.
	 *
	 * `prune: false` exists for exactly one caller: the pre-upgrade snapshot at boot, which
	 * runs before the database has been opened. Pruning reads the retention settings, and
	 * reading a setting would open the database and run the migrations that snapshot is
	 * standing in front of. Boot prunes for itself once the database is up.
	 */
	async snapshot(
		kind: SnapshotKind,
		label: string | null,
		options: { prune?: boolean } = {}
	): Promise<SnapshotManifest> {
		return this.withLock(
			{
				kind: 'snapshot',
				snapshotId: '',
				phase: 'Starting',
				filesDone: 0,
				filesTotal: 0,
				startedAt: Date.now()
			},
			async (update) => {
				const manifest = await this.runChild({ kind, label }, update);
				// Any snapshot, not just a scheduled one, is what the schedule measures against
				// next: this one already holds everything up to the moment it started. One that
				// lands by hand also clears the schedule's backoff, since whatever was stopping
				// it plainly is not stopping it now.
				this.anchorAt = Math.max(this.anchorAt, manifest.createdAt);
				this.failures = 0;
				this.retryAfter = 0;
				if (options.prune !== false) this.prune();
				return manifest;
			}
		);
	}

	/** Apply retention outside a job: boot's own call, once the database is readable. */
	pruneNow(): void {
		if (this.locked) return;
		this.prune();
	}

	/**
	 * Claim a restore: stop taking work, save the present, and mark the next launch.
	 *
	 * The swap itself is not here and cannot be: `restore.ts` explains why a running server
	 * is structurally unable to replace its own database file. What this does is make the
	 * decision safe: nothing more is written that the restore would silently discard, the
	 * current state is captured first, and the marker that survives to the next boot is
	 * written last, once the safety snapshot has actually landed.
	 *
	 * `quiesce` belongs to the caller because this module knows nothing about sockets.
	 */
	async restore(id: string, hooks: { quiesce: () => void }): Promise<void> {
		const target = listSnapshots().snapshots.find((s) => s.id === id);
		if (!target) throw new Error(`No readable snapshot named "${id}".`);

		return this.withLock(
			{
				kind: 'restore',
				snapshotId: id,
				phase: 'Backing up the current data first',
				filesDone: 0,
				filesTotal: 0,
				startedAt: Date.now()
			},
			async (update) => {
				// Stop first. Everything written from here on is about to be discarded, and
				// the reader deserves not to spend the next hour writing into it.
				hooks.quiesce();
				// Always, and before the marker: restoring the wrong snapshot has to be a
				// recoverable mistake rather than the end of the story.
				await this.runChild({ kind: 'preRestore', label: null }, (patch) => update(patch));
				update({ phase: 'Ready to restore', filesDone: 0, filesTotal: 0 });
				beginRestore(id);
				// Deliberately no pruning here: retention could otherwise delete the very
				// snapshot the marker now points at.
			}
		);
	}

	private async runChild(
		spec: JobSpec,
		update: (patch: Partial<BackupJobState>) => void
	): Promise<SnapshotManifest> {
		// From source the entry is argv[1]; a compiled binary IS the entry and takes none.
		const argv = IS_COMPILED ? [process.execPath] : [process.execPath, process.argv[1]];
		const child = Bun.spawn(argv, {
			// Both folders are handed over rather than left to be resolved again. The child runs
			// the same `config.ts` and would read the settings file as it stands NOW, so a line
			// edited since this process booted would point the job at a folder its parent is not
			// using. An environment variable outranks that file, which is what pins the two together.
			env: {
				...process.env,
				CHUNGUS_DATA_DIR: resolveDataDir(),
				CHUNGUS_BACKUP_DIR: resolveBackupDir(),
				[JOB_ENV]: JSON.stringify(spec)
			},
			stdout: 'pipe',
			stderr: 'pipe'
		});

		// Drained from the first moment, never after the exit: a child that fills the stderr
		// pipe while this side is still reading stdout blocks on the write, stdout then never
		// ends, and both processes wait on each other for as long as the app is open.
		const stderrText = new Response(child.stderr).text();

		let manifest: SnapshotManifest | null = null;
		let failure: string | null = null;
		let carry = '';
		let lastHeard = Date.now();
		let wedged = false;
		// Silence, not slowness: the job reports every phase and every 250 files, so ten
		// minutes without a word is a child that will not come back on its own.
		const watchdog = setInterval(() => {
			if (Date.now() - lastHeard < JOB_SILENCE_MS) return;
			wedged = true;
			child.kill();
		}, 30_000);

		const decoder = new TextDecoder();
		try {
			for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
				lastHeard = Date.now();
				carry += decoder.decode(chunk, { stream: true });
				const lines = carry.split('\n');
				carry = lines.pop() ?? '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('{')) continue; // Not protocol; a stray log line.
					let message: JobMessage;
					try {
						message = JSON.parse(trimmed) as JobMessage;
					} catch {
						continue;
					}
					if (message.t === 'progress') {
						update({
							phase: message.phase,
							filesDone: message.filesDone,
							filesTotal: message.filesTotal
						});
					} else if (message.t === 'done') {
						manifest = message.manifest;
						update({ snapshotId: message.manifest.id });
					} else if (message.t === 'error') {
						failure = message.message;
					}
				}
			}
		} finally {
			clearInterval(watchdog);
		}

		const code = await child.exited;
		if (manifest) return manifest;
		if (wedged) {
			// The folder it died in keeps its `.building` marker and is swept at the next boot,
			// exactly as one a power cut ended.
			throw new Error('The backup stopped responding for ten minutes and was stopped.');
		}
		const stderr = (await stderrText).trim();
		throw new Error(
			failure ?? stderr.split('\n').pop() ?? `The backup process stopped with code ${code}.`
		);
	}

	/** Apply retention. Runs after every successful snapshot, never on a timer of its own. */
	private prune(): void {
		const { snapshots } = listSnapshots();
		const doomed = prunable(snapshots, this.settings(), Date.now());
		for (const id of doomed) {
			try {
				rmSync(snapshotPath(id), { recursive: true, force: true });
			} catch (error) {
				console.error(`[backup] could not prune "${id}":`, error);
			}
		}
		if (doomed.length > 0) console.log(`[backup] pruned ${doomed.length} snapshot(s).`);
	}

	remove(ids: string[]): number {
		if (this.locked) {
			throw new Error('A backup is running. Wait for it to finish, then delete.');
		}
		let removed = 0;
		for (const id of ids) {
			// The name comes off the wire, so it must not be able to reach out of the store.
			if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
				throw new Error(`"${id}" is not a snapshot name.`);
			}
			rmSync(snapshotPath(id), { recursive: true, force: true });
			removed++;
		}
		if (removed > 0) this.broadcast('backups');
		return removed;
	}

	/** The unattended schedule. One timer, re-deciding from the store each minute rather
	 *  than re-arming itself, so a changed interval takes effect within the minute and a
	 *  machine asleep for two days takes one snapshot on waking rather than forty. */
	startSchedule(): void {
		if (this.timer) return;
		// The database is open by now, so the answer to "was anything written before the last
		// shutdown" is readable. Without it every launch would claim yes.
		this.changedAt = Number(serverDb.getSetting(CHANGED_AT_KEY) ?? '0') || 0;
		this.persistedAt = this.changedAt;
		// Read before the first request can arrive, so the very first change after a launch
		// still knows whether it is the one that has to reach the disk.
		this.anchorAt = listSnapshots().snapshots[0]?.createdAt ?? 0;
		const tick = () => {
			try {
				this.maybeScheduled();
			} catch (error) {
				console.error('[backup] scheduled snapshot failed:', error);
			}
		};
		setTimeout(tick, FIRST_TICK_MS);
		this.timer = setInterval(tick, TICK_MS);
	}

	private maybeScheduled(): void {
		if (this.locked) return;
		const settings = this.settings();
		if (!settings.automatic) {
			// Nothing is on hold when nothing is scheduled, and a sentence about a stalled
			// schedule has to go the moment the schedule does.
			this.paused = null;
			return;
		}
		// A claimed restore freezes the store until the relaunch. Not for the snapshot itself
		// (that would only copy data the restore is about to discard) but for the prune after
		// it: a new scheduled snapshot shifts the retention window, and the snapshot it pushes
		// out can be the very one the journal points at, which the next boot then cannot find.
		if (readJournal()) {
			this.paused = null;
			return;
		}

		const newest = listSnapshots().snapshots[0] ?? null;
		this.anchorAt = newest?.createdAt ?? 0;
		const decision = scheduleDecision({
			now: Date.now(),
			newest,
			changedAt: this.changedAt,
			intervalHours: settings.intervalHours,
			retryAfter: this.retryAfter
		});
		this.paused =
			decision.reason === 'clock behind the store'
				? "A snapshot here is dated in the future, so scheduled backups are on hold. Check this machine's date and time, or delete that snapshot."
				: null;
		if (!decision.take) return;

		void this.snapshot('scheduled', null).catch((error) => {
			this.failures++;
			const backoff = Math.min(
				settings.intervalHours * 3_600_000,
				RETRY_BASE_MS * 2 ** (this.failures - 1)
			);
			this.retryAfter = Date.now() + backoff;
			console.error('[backup] scheduled snapshot failed:', error);
		});
	}
}

export const backupService = new BackupService();
