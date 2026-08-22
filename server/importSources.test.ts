/**
 * The import ledger against the REAL server database (bun:sqlite).
 *
 * What is pinned here is the claim's SECOND write. A source file arrives twice only because
 * somebody asked for it, and it becomes a new entry every time, so a claim that kept naming the
 * first one would point at a deleted row for good, and the confirm card (which drops a claim
 * whose entry the library no longer holds) would offer that file again on every run forever.
 *
 * Mirrors the prompt-log test's env dance: CHUNGUS_DATA_DIR is pinned to a throwaway dir before
 * the first db call, so no test can silently point db writes at the real user-data.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let serverDb: any;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-import-sources-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('./db'));
	// One handle per process, bound on first use (see server/db.ts). Release whatever an
	// earlier file left open so this file's first db call binds to the dir above.
	serverDb.closeForTests();
});

afterAll(() => {
	// Release before deleting: statements against an unlinked file fail for the rest of the run.
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

function entityFor(key: string): string | null | undefined {
	return serverDb.getImportedSources().find((row: any) => row.key === key)?.entityId;
}

describe('the import ledger', () => {
	test('claims a file with what it became, and a file with nothing behind it', () => {
		serverDb.recordImportedSources([
			{ key: 'sillytavern:characters/Alice.png', entityId: 'entry-1' },
			{ key: 'sillytavern:backgrounds/tavern.jpg' }
		]);
		expect(entityFor('sillytavern:characters/Alice.png')).toBe('entry-1');
		expect(entityFor('sillytavern:backgrounds/tavern.jpg')).toBeNull();
	});

	test('a second claim names the entry that exists now, not the one that used to', () => {
		serverDb.recordImportedSources([
			{ key: 'sillytavern:characters/Alice.png', entityId: 'entry-2' }
		]);
		expect(entityFor('sillytavern:characters/Alice.png')).toBe('entry-2');
	});

	test('a claim carrying no entry cannot blank one that is already there', () => {
		serverDb.recordImportedSources([{ key: 'sillytavern:characters/Alice.png' }]);
		expect(entityFor('sillytavern:characters/Alice.png')).toBe('entry-2');
	});

	test('re-claiming adds no second row for the same file', () => {
		const keys = serverDb.getImportedSources().map((row: any) => row.key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toHaveLength(2);
	});

	test('an empty batch is not a write', () => {
		serverDb.recordImportedSources([]);
		expect(serverDb.getImportedSources()).toHaveLength(2);
	});
});
