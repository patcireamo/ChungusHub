/**
 * The listing every hand-copied folder goes through: the bundled defaults and the preset store.
 *
 * What it protects is boot. The example-character seed lists `defaults/characters/`, keeps every
 * name ending `.json` and parses it, and it runs before the server listens, so one file in there
 * that is not JSON stops the app from starting at all. macOS puts exactly that file there: a
 * `._<name>` beside everything it copies to exFAT, a network share or a USB stick, binary, and
 * keeping the name's extension.
 *
 * Same env dance as the database tests: CHUNGUS_DATA_DIR is pinned to a throwaway dir before the
 * first import, since `files.ts` reads config as it loads.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let folder: string;
let visibleEntries: typeof import('./files').visibleEntries;

/** The first bytes of a real AppleDouble file: magic 0x00051607, version 2. */
const APPLE_DOUBLE = new Uint8Array([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]);

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-visible-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ visibleEntries } = await import('./files'));

	// A bundled character as a Mac leaves it after a copy to a stick: the card, its portrait and
	// its sprite pack, each with a metadata twin, plus the folder's own .DS_Store.
	folder = join(dataDir, 'characters');
	mkdirSync(join(folder, 'example'), { recursive: true });
	writeFileSync(join(folder, 'example.json'), '{"name":"Example"}');
	writeFileSync(join(folder, '._example.json'), APPLE_DOUBLE);
	writeFileSync(join(folder, 'example.webp'), new Uint8Array([0]));
	writeFileSync(join(folder, '._example.webp'), APPLE_DOUBLE);
	writeFileSync(join(folder, '.DS_Store'), APPLE_DOUBLE);
	writeFileSync(join(folder, 'example', 'happy.webp'), new Uint8Array([0]));
	writeFileSync(join(folder, 'example', '._happy.webp'), APPLE_DOUBLE);
});

afterAll(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe('visibleEntries', () => {
	// The premise, pinned so the test below keeps meaning something: the twin passes the
	// extension check every lister uses and then cannot be parsed.
	test('the metadata twin is what a .json lister would otherwise choke on', () => {
		expect('._example.json'.endsWith('.json')).toBe(true);
		expect(() => JSON.parse(readFileSync(join(folder, '._example.json'), 'utf8'))).toThrow();
	});

	test('skips every hidden name and keeps everything else', () => {
		const names = visibleEntries(folder).map((e) => e.name).sort();
		expect(names).toEqual(['example', 'example.json', 'example.webp']);
	});

	test('keeps the entry kinds, so a sprite folder still reads as a folder', () => {
		const entries = visibleEntries(folder);
		expect(entries.find((e) => e.name === 'example')?.isDirectory()).toBe(true);
		expect(entries.find((e) => e.name === 'example.json')?.isFile()).toBe(true);
	});

	test('filters a sprite folder the same way', () => {
		expect(visibleEntries(join(folder, 'example')).map((e) => e.name)).toEqual(['happy.webp']);
	});
});
