/**
 * What `ensureConfigFile` is allowed to do to a settings file somebody already has. This is the
 * one file in an install that is edited by hand and the one that says where the data lives, so
 * every case here is about what must survive a build that has learned a new setting: the values
 * in it, the notes around them, and a file it cannot read, which it must not touch at all.
 *
 * No env dance and no database: the function takes the path it works on, so these run against a
 * throwaway file and never see the real `chungushub.config.json`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureConfigFile } from './config';

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'chungus-config-'));
	path = join(dir, 'chungushub.config.json');
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const write = (contents: Record<string, unknown>) => writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`);
const read = () => readFileSync(path, 'utf8');
const parsed = () => JSON.parse(read()) as Record<string, unknown>;

describe('the settings file on a first run', () => {
	test('every setting is written, with the note above them', () => {
		ensureConfigFile(path);
		expect(Object.keys(parsed())).toEqual([
			'//',
			'port',
			'host',
			'dataDir',
			'backupDir',
			'openBrowser',
			'allowedHostnames'
		]);
		expect(parsed().port).toBe(4242);
		expect(parsed().openBrowser).toBe(true);
		expect(parsed().allowedHostnames).toEqual([]);
	});

	test('the write leaves no temp file behind', () => {
		ensureConfigFile(path);
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});
});

describe('the settings file on a build that has learned a new setting', () => {
	test('a file already holding every setting is not written at all', () => {
		// Four-space indentation and no trailing newline: a file that came back normalised was
		// rewritten, and this one had no reason to be.
		const original =
			'{\n    "port": 9000,\n    "openBrowser": false,\n    "host": "127.0.0.1",\n    "dataDir": "D:/stories",\n    "backupDir": "../backups",\n    "allowedHostnames": []\n}';
		writeFileSync(path, original);
		ensureConfigFile(path);
		expect(read()).toBe(original);
	});

	test('the missing setting is added and everything already there survives', () => {
		write({
			'//': 'a note the reader wrote over the shipped one',
			'// port': 'the one the router forwards',
			port: 9000,
			host: '127.0.0.1',
			dataDir: 'D:/stories',
			backupDir: '../backups'
		});
		ensureConfigFile(path);
		const file = parsed();
		expect(file.openBrowser).toBe(true);
		expect(file.port).toBe(9000);
		expect(file.host).toBe('127.0.0.1');
		expect(file.dataDir).toBe('D:/stories');
		expect(file['//']).toBe('a note the reader wrote over the shipped one');
		expect(file['// port']).toBe('the one the router forwards');
		// What was there keeps the order it was written in; the new lines land after it.
		expect(Object.keys(file)).toEqual([
			'//',
			'// port',
			'port',
			'host',
			'dataDir',
			'backupDir',
			'openBrowser',
			'allowedHostnames'
		]);
	});

	test('a setting somebody turned off is never turned back on', () => {
		write({ openBrowser: false });
		ensureConfigFile(path);
		expect(parsed().openBrowser).toBe(false);
		expect(parsed().port).toBe(4242);
	});

	test('a missing setting is written with its default, not with the value this launch resolved', () => {
		write({ port: 9000, host: '127.0.0.1', backupDir: '../backups', openBrowser: true });
		ensureConfigFile(path);
		// The literal default, not the absolute path `resolveDataDir()` answers. A file carrying a
		// resolved value would pin every later launch to a folder nobody chose.
		expect(parsed().dataDir).toBe('user-data');
	});

	test('a misspelled key survives, so the boot can still name it', () => {
		write({ prot: 9000, host: '0.0.0.0', dataDir: 'user-data', backupDir: '../backups' });
		ensureConfigFile(path);
		const file = parsed();
		expect(file.prot).toBe(9000);
		expect(file.port).toBe(4242);
		expect(file.openBrowser).toBe(true);
	});

	test('a second run changes nothing', () => {
		write({ port: 9000 });
		ensureConfigFile(path);
		const afterFirst = read();
		ensureConfigFile(path);
		expect(read()).toBe(afterFirst);
	});
});

describe('a settings file it cannot read', () => {
	test('half a file is left byte for byte alone', () => {
		// Rebuilding this from defaults would drop "dataDir" and send the next launch to an empty
		// workspace. The boot refuses to start on it instead, with the line to fix named.
		const torn = '{\n  "port": 4242,\n  "dataDir": "D:/stories",\n  "host": ';
		writeFileSync(path, torn);
		ensureConfigFile(path);
		expect(read()).toBe(torn);
	});

	test('a file holding something other than an object is left alone', () => {
		writeFileSync(path, '[]\n');
		ensureConfigFile(path);
		expect(read()).toBe('[]\n');
	});
});
