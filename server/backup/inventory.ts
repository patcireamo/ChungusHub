/**
 * What a database holds, read from an arbitrary database FILE rather than from the live
 * handle: the snapshot job runs in its own process and asks these questions of the copy it
 * just wrote, so nothing here may touch `serverDb`.
 */
import { Database } from 'bun:sqlite';
import type { SnapshotSummary } from '../../shared/backups';

/**
 * Every stored image path, found by matching the SHAPE of one rather than by walking the
 * schema. A stored path is always `images/<category>/<file>` (`saveImage`, files.ts), so one
 * pattern over the JSON columns finds them all, under whichever key they sit, in whichever
 * table, including keys added after this was written.
 *
 * Reading the blobs' shapes instead would be a hand-kept list of five JSON schemas that
 * nothing forces anyone to update, and the failure mode of forgetting one is a backup that
 * silently drops a picture. Over-matching costs a copy of a file that already exists;
 * under-matching costs the file.
 *
 * The character class stops at a quote, a backslash and a slash, which is exactly what a
 * filename cannot contain. Background art keeps a human name and may carry spaces.
 *
 * The alternation is `IMAGE_CATEGORIES` (config.ts) spelled out, and must be kept with it: a
 * category this pattern does not name is a folder no snapshot ever copies.
 */
const IMAGE_PATH_RE =
	/images\/(?:characters|personas|backgrounds|chat|presets|lorebooks)\/[^"\\/]+/g;

/** Columns whose text may name an image, table by table. Adding a JSON column that can
 *  carry one needs an entry here; adding a KEY inside an existing one needs nothing. */
const IMAGE_BEARING = [
	{ table: 'messages', column: 'attachments_json' },
	{ table: 'assistant_messages', column: 'images_json' },
	{ table: 'character_library', column: 'data_json' },
	{ table: 'character_versions', column: 'data_json' },
	{ table: 'lorebooks', column: 'data_json' },
	{ table: 'settings', column: 'value' },
	{ table: 'chats', column: 'settings_json' }
] as const;

function tableExists(db: Database, name: string): boolean {
	const row = db
		.query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(name) as { ok: number } | null;
	return !!row;
}

function columnExists(db: Database, table: string, column: string): boolean {
	if (!tableExists(db, table)) return false;
	const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return rows.some((r) => r.name === column);
}

function count(db: Database, table: string, where = ''): number {
	if (!tableExists(db, table)) return 0;
	const row = db.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number };
	return row.n;
}

/**
 * Every ORIGINAL the database claims. Thumbnails are deliberately not in here: they are
 * derived beside their original by convention and plenty of images legitimately have none
 * (a chat attachment, for one), so treating a missing thumbnail as a claim the snapshot
 * failed to honour would put a warning on almost every row.
 */
export function referencedImagePaths(db: Database): Set<string> {
	const found = new Set<string>();
	for (const { table, column } of IMAGE_BEARING) {
		if (!columnExists(db, table, column)) continue;
		const rows = db
			.query(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)
			.all() as { v: unknown }[];
		for (const row of rows) {
			if (typeof row.v !== 'string') continue;
			for (const hit of row.v.matchAll(IMAGE_PATH_RE)) found.add(hit[0]);
		}
	}
	return found;
}

/** The same pattern over a preset document, whose cover art is named in a FILE rather than
 *  in the database and would otherwise fall outside the reconcile pass entirely. */
export function referencedImagePathsInText(text: string): Set<string> {
	const found = new Set<string>();
	for (const hit of text.matchAll(IMAGE_PATH_RE)) found.add(hit[0]);
	return found;
}

/** Attached-file bytes, which are addressed by a plain column rather than by JSON. */
export function referencedAssistantFiles(db: Database): Set<string> {
	if (!columnExists(db, 'assistant_files', 'text_path')) return new Set();
	const rows = db
		.query('SELECT text_path AS v FROM assistant_files WHERE text_path IS NOT NULL')
		.all() as { v: unknown }[];
	const found = new Set<string>();
	for (const row of rows) {
		if (typeof row.v === 'string' && row.v) found.add(row.v);
	}
	return found;
}

/**
 * The counts a snapshot's row shows. Taken here, once, and written into the manifest:
 * listing a year of snapshots must never mean opening a year of databases.
 */
export function summarize(db: Database, imageCount: number, presetCount: number): SnapshotSummary {
	return {
		chats: count(db, 'chats'),
		messages: count(db, 'messages'),
		characters: count(db, 'character_library', "WHERE type = 'character'"),
		personas: count(db, 'character_library', "WHERE type = 'persona'"),
		lorebooks: count(db, 'lorebooks'),
		presets: presetCount,
		images: imageCount
	};
}
