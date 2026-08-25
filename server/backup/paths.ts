/**
 * Where the backup store lives, what a snapshot folder is called, and (the part that has
 * to be read before anything is added to the data dir) exactly which entries a snapshot
 * carries.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { CONFIG_PATH, resolveBackupDir, resolveDataDir } from '../config';

/**
 * What a snapshot copies, named one by one rather than "everything in the data dir".
 *
 * This is a hand-kept list and the twin of `scripts/package.ts`'s copy list: a new
 * directory under the data dir has to be added HERE, to `restore.ts`'s swap, and to the
 * packaging script, or it silently falls outside backups while looking backed up. The
 * list is explicit precisely so that omission is a visible edit rather than a default.
 *
 * `security.json` and `allowlist.json` are deliberately absent from both directions. They
 * are the door to the app rather than the content behind it, and a restore that quietly
 * reinstated a months-old password, or reopened a port the reader had since closed, would
 * be a security surprise arriving under the word "restore".
 *
 * The database's `-wal`/`-shm` files are absent for a different reason: `VACUUM INTO`
 * writes a self-contained database that already holds everything the live WAL was
 * carrying, so copying them would pair a stale journal with a file it does not describe.
 */
export const SNAPSHOT_ENTRIES = [
	{ name: 'chungushub.db', kind: 'db' },
	{ name: 'images', kind: 'dir' },
	{ name: 'assistant-files', kind: 'dir' },
	{ name: 'presets', kind: 'dir' },
	{ name: 'assistantSkills.json', kind: 'file' }
] as const;

/** The mirrored data dir inside a snapshot folder, beside its `manifest.json`. */
export const SNAPSHOT_DATA_DIR = 'data';
export const MANIFEST_FILE = 'manifest.json';

/**
 * Written into a snapshot folder before anything else and deleted after the manifest, so
 * its presence means "ours, and not finished". Deleting one small file is the commit, and
 * that is deliberate: building somewhere else and renaming the directory into place is the
 * obvious design and does not work. Anything holding a handle on a directory stops Windows
 * renaming it, and from source the store sits inside the repo where an editor's or a dev
 * server's recursive watcher does exactly that. A file has no such problem.
 *
 * A folder without this marker and without a manifest is somebody else's, and is left alone.
 */
export const BUILDING_MARKER = '.building';

export function buildingMarkerPath(id: string): string {
	return join(snapshotPath(id), BUILDING_MARKER);
}

/** Claims the next launch for a restore. Written once the safety snapshot has landed and
 *  removed once the swap has finished, so its presence always means "not done yet". */
export const RESTORE_JOURNAL = 'restore.json';

export function snapshotPath(id: string): string {
	return join(resolveBackupDir(), id);
}

export function snapshotDataPath(id: string): string {
	return join(snapshotPath(id), SNAPSHOT_DATA_DIR);
}

export function manifestPath(id: string): string {
	return join(snapshotPath(id), MANIFEST_FILE);
}

export function journalPath(): string {
	return join(resolveBackupDir(), RESTORE_JOURNAL);
}

/**
 * A sortable, readable folder name. Lexical order is chronological order, which is what
 * lets listing, retention and the boot sweep work off the name alone without opening a
 * manifest. Windows forbids `:` in a filename, so the ISO time is spelled with dashes.
 */
export function snapshotId(at: Date, kind: string): string {
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	const stamp =
		`${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
		`_${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
	return `${stamp}_${kind}`;
}

/** Same name with a counter, for the one case two snapshots land in the same second. */
export function uniqueSnapshotId(at: Date, kind: string): string {
	const base = snapshotId(at, kind);
	if (!existsSync(snapshotPath(base))) return base;
	for (let n = 2; n < 100; n++) {
		const candidate = `${base}_${n}`;
		if (!existsSync(snapshotPath(candidate))) return candidate;
	}
	throw new Error(`Cannot name a snapshot: ${base} and 98 variants of it already exist`);
}

function containerOf(path: string): string {
	// realpath needs the thing to exist; the backup dir does not until the first snapshot,
	// so resolve the nearest ancestor that does and keep the rest as written. A junction or
	// a symlink anywhere above still gets folded away, which a string compare would miss.
	let probe = resolve(path);
	const tail: string[] = [];
	while (!existsSync(probe)) {
		const parent = resolve(probe, '..');
		if (parent === probe) return resolve(path);
		tail.unshift(probe.slice(parent.length + 1));
		probe = parent;
	}
	return join(realpathSync(probe), ...tail);
}

function contains(outer: string, inner: string): boolean {
	if (outer === inner) return true;
	return inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/**
 * The store may not sit inside the data dir and the data dir may not sit inside the store.
 * The first makes every snapshot carry the ones before it, so the second snapshot is twice
 * the size of the first and the tenth is unusable. The second puts live data where
 * retention prunes, which deletes it. Both are reachable by one edit of `backupDir`, which is
 * a line in a text file people are told to edit, so this runs at boot and refuses to start
 * rather than waiting for the first snapshot. The way out names the setting rather than the
 * env var, since the env var is not what the reader touched.
 */
export function assertBackupDirUsable(): void {
	const data = containerOf(resolveDataDir());
	const backups = containerOf(resolveBackupDir());
	const moveIt = `Point "backupDir" in ${CONFIG_PATH} (or CHUNGUS_BACKUP_DIR) somewhere outside.`;
	if (contains(data, backups)) {
		throw new Error(
			`The backup folder sits inside the data folder (${backups} inside ${data}). ` +
				`Every snapshot would carry the ones before it. ${moveIt}`
		);
	}
	if (contains(backups, data)) {
		throw new Error(
			`The data folder sits inside the backup folder (${data} inside ${backups}). ` +
				`Retention would delete live data. ${moveIt}`
		);
	}
}
