/**
 * A connection's extra headers against the REAL server database (bun:sqlite).
 *
 * They share a row with the API key, and two writers touch that row: the key/URL save and the
 * headers save. What is pinned here is that neither can wipe the other's half, that a provider
 * switch takes the headers with it, and that a cell nobody can read fails loud instead of
 * quietly sending requests without them.
 *
 * Same env dance as the other real-SQL files: CHUNGUS_DATA_DIR is pinned to a throwaway dir
 * before the first db call.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHeaderRows } from '../shared/connection-headers';

let dataDir: string;
let serverDb: any;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-connection-headers-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ serverDb } = await import('./db'));
	serverDb.closeForTests();
});

afterAll(() => {
	serverDb.closeForTests();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

beforeEach(() => {
	serverDb.db.run('DELETE FROM connection_credentials');
});

const BYO = 'openai-compatible';
const rawHeaders = (id: string): string | null =>
	(serverDb.db.query('SELECT extra_headers FROM connection_credentials WHERE connection_id = ?').get(id) as {
		extra_headers: string | null;
	}).extra_headers;

describe('connection headers in the credentials row', () => {
	test('round-trip beside the key and URL', () => {
		serverDb.setConnectionCredentials('c1', BYO, 'sk-1', 'http://gw.local/v1');
		serverDb.setConnectionHeaders('c1', BYO, { 'api-key': 'gate', 'X-Title': 'ChungusHub' });
		expect(serverDb.getConnectionCredentials('c1')).toEqual({
			provider: BYO,
			apiKey: 'sk-1',
			baseUrl: 'http://gw.local/v1',
			headers: { 'api-key': 'gate', 'X-Title': 'ChungusHub' }
		});
	});

	test('saving the key or URL again keeps the headers', () => {
		serverDb.setConnectionCredentials('c1', BYO, 'sk-1', 'http://gw.local/v1');
		serverDb.setConnectionHeaders('c1', BYO, { 'api-key': 'gate' });
		serverDb.setConnectionCredentials('c1', BYO, 'sk-2', 'http://other.local/v1');
		expect(serverDb.getConnectionCredentials('c1')).toEqual({
			provider: BYO,
			apiKey: 'sk-2',
			baseUrl: 'http://other.local/v1',
			headers: { 'api-key': 'gate' }
		});
	});

	test('switching the provider drops them', () => {
		serverDb.setConnectionCredentials('c1', BYO, '', 'http://gw.local/v1');
		serverDb.setConnectionHeaders('c1', BYO, { 'api-key': 'gate' });
		serverDb.setConnectionCredentials('c1', 'openrouter', '');
		expect(serverDb.getConnectionCredentials('c1').headers).toEqual({});
		expect(rawHeaders('c1')).toBeNull();
	});

	test('a save aimed at a provider the row no longer uses is refused and changes nothing', () => {
		serverDb.setConnectionCredentials('c1', 'openrouter', 'sk-or');
		expect(() => serverDb.setConnectionHeaders('c1', BYO, { 'api-key': 'gate' })).toThrow('no longer uses');
		expect(serverDb.getConnectionCredentials('c1')).toEqual({
			provider: 'openrouter',
			apiKey: 'sk-or',
			baseUrl: null,
			headers: {}
		});
	});

	test('a connection with no row yet gets one carrying only the headers', () => {
		serverDb.setConnectionHeaders('fresh', BYO, { 'api-key': 'gate' });
		expect(serverDb.getConnectionCredentials('fresh')).toEqual({
			provider: BYO,
			apiKey: '',
			baseUrl: null,
			headers: { 'api-key': 'gate' }
		});
	});

	test('clearing them stores NULL, the same as a row that never had any', () => {
		serverDb.setConnectionCredentials('c1', BYO, '', 'http://gw.local/v1');
		serverDb.setConnectionHeaders('c1', BYO, { 'api-key': 'gate' });
		serverDb.setConnectionHeaders('c1', BYO, {});
		expect(rawHeaders('c1')).toBeNull();
	});

	test('a set fetch could not send is refused before anything is written', () => {
		serverDb.setConnectionCredentials('c1', BYO, '', 'http://gw.local/v1');
		serverDb.setConnectionHeaders('c1', BYO, { 'api-key': 'gate' });
		expect(() => serverDb.setConnectionHeaders('c1', BYO, { 'bad name': 'x' })).toThrow('not a valid header name');
		expect(() => serverDb.setConnectionHeaders('c1', BYO, { 'X-A': 'line\nbreak' })).toThrow('cannot carry');
		expect(() => serverDb.setConnectionHeaders('c1', BYO, { 'X-A': '1', 'x-a': '2' })).toThrow('named twice');
		expect(serverDb.getConnectionCredentials('c1').headers).toEqual({ 'api-key': 'gate' });
	});

	test('duplicating a connection carries them', () => {
		serverDb.setConnectionCredentials('c1', BYO, 'sk-1', 'http://gw.local/v1');
		serverDb.setConnectionHeaders('c1', BYO, { 'api-key': 'gate' });
		serverDb.copyConnectionCredentials('c1', 'c2');
		expect(serverDb.getConnectionCredentials('c2').headers).toEqual({ 'api-key': 'gate' });
	});

	test('a cell that will not parse fails loud naming the connection, and is left as it was', () => {
		serverDb.setConnectionCredentials('c1', BYO, 'sk-1', 'http://gw.local/v1');
		serverDb.db.run("UPDATE connection_credentials SET extra_headers = '{torn' WHERE connection_id = 'c1'");
		expect(() => serverDb.getConnectionCredentials('c1')).toThrow('connection c1 are unreadable');
		expect(rawHeaders('c1')).toBe('{torn');
	});
});

describe('the editor rows', () => {
	test('a wholly blank row is still being filled in and is skipped', () => {
		expect(
			readHeaderRows([
				{ name: ' api-key ', value: ' gate ' },
				{ name: '', value: '' }
			])
		).toEqual({ headers: { 'api-key': 'gate' } });
	});

	test('the first thing wrong is named', () => {
		expect(readHeaderRows([{ name: '', value: 'x' }])).toEqual({ error: 'a header has a value but no name.' });
		expect(readHeaderRows([{ name: 'X Id', value: 'x' }])).toEqual({ error: '"X Id" is not a valid header name.' });
		expect(
			readHeaderRows([
				{ name: 'X-Id', value: '1' },
				{ name: 'x-id', value: '2' }
			])
		).toEqual({ error: '"x-id" is named twice.' });
	});

	test('an empty value is a header like any other', () => {
		expect(readHeaderRows([{ name: 'X-Flag', value: '' }])).toEqual({ headers: { 'X-Flag': '' } });
	});
});
