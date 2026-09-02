/**
 * What may be stored as a picture, and what `/files/` may hand one back as.
 *
 * These are one rule and the file pins them as one. An upload names its own extension, so a
 * store that takes any plain-looking name writes a document into a folder this origin serves,
 * and a request for it comes back as a page holding the session cookie. Closing either half
 * alone leaves the other open: a whitelist with a guessed content type still serves the guess,
 * and a fixed content type over an open whitelist still writes the file.
 *
 * Same env dance as the database tests: CHUNGUS_DATA_DIR is pinned to a throwaway dir before
 * the first import, and every file written is recorded and removed, since config binds
 * IMAGES_ROOT once per process and an earlier test file may already have bound it elsewhere.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let imagesRoot: string;
let saveImage: typeof import('./files').saveImage;
let imageContentType: typeof import('./files').imageContentType;
const written: string[] = [];

/** Store one byte under `ext` and answer where it landed, or the refusal. */
async function store(ext: string): Promise<{ path: string } | { error: string }> {
	try {
		const path = await saveImage(new Blob([new Uint8Array([0])]), null, ext, 'characters');
		written.push(path);
		return { path };
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'chungus-image-files-'));
	process.env.CHUNGUS_DATA_DIR = dataDir;
	({ saveImage, imageContentType } = await import('./files'));
	({ IMAGES_ROOT: imagesRoot } = await import('./config'));
});

afterAll(() => {
	for (const path of written) {
		const abs = join(imagesRoot, path.replace(/^images\//, ''));
		if (existsSync(abs)) rmSync(abs);
	}
	rmSync(dataDir, { recursive: true, force: true });
});

// The invariant, driven from both ends at once: a name that can be written can be served,
// and a name that cannot be served is never written. Neither list can quietly grow past the
// other, whichever one a later change edits.
const CANDIDATES = [
	'.png',
	'.jpg',
	'.jpeg',
	'.webp',
	'.gif',
	'.avif',
	'png',
	'.PNG',
	'.html',
	'.svg',
	'.htm',
	'.bmp',
	'.exe',
	'.json',
	'.php',
	'.png.html',
	'.',
	''
];

describe('a stored picture is exactly what can be served as one', () => {
	for (const ext of CANDIDATES) {
		test(`"${ext}"`, async () => {
			const result = await store(ext);
			if ('error' in result) {
				expect(imageContentType(`x${ext}`)).toBeNull();
				return;
			}
			expect(imageContentType(result.path)).not.toBeNull();
			expect(existsSync(join(imagesRoot, result.path.replace(/^images\//, '')))).toBe(true);
		});
	}
});

describe('saveImage', () => {
	test('refuses a document, and writes nothing while refusing it', async () => {
		const before = written.length;
		const result = await store('html');
		expect(result).toHaveProperty('error');
		expect((result as { error: string }).error).toContain('.png');
		expect(written.length).toBe(before);
	});

	// The generic pass above only holds the two lists to each other, and SVG would satisfy it
	// on both: it is the one format that is a picture everywhere a picker looks and a document
	// everywhere a browser does, so putting it on the list reopens the whole chain at once.
	test('an SVG is neither stored nor served, picture-shaped as it is', async () => {
		expect(await store('.svg')).toHaveProperty('error');
		expect(imageContentType('images/lorebooks/a.svg')).toBeNull();
	});

	test('takes an extension however it is spelled', async () => {
		for (const ext of ['png', '.png', '.PNG']) {
			const result = await store(ext);
			expect(result).toHaveProperty('path');
			expect((result as { path: string }).path).toEndWith('.png');
		}
	});
});

describe('imageContentType', () => {
	test('names the type for every format that can be stored', () => {
		expect(imageContentType('images/characters/a.png')).toBe('image/png');
		expect(imageContentType('images/characters/a.jpg')).toBe('image/jpeg');
		expect(imageContentType('images/characters/a.jpeg')).toBe('image/jpeg');
		expect(imageContentType('images/characters/a.webp')).toBe('image/webp');
		expect(imageContentType('images/characters/a.gif')).toBe('image/gif');
		expect(imageContentType('images/characters/a.avif')).toBe('image/avif');
		expect(imageContentType('images/characters/A.PNG')).toBe('image/png');
	});

	test('has no answer for anything else, so nothing else is served', () => {
		for (const name of ['a.html', 'a.svg', 'a.txt', 'a.bmp', 'a', 'a.', '.png/a', 'a.png.html']) {
			expect(imageContentType(`images/characters/${name}`)).toBeNull();
		}
	});

	// A dot in a folder name is not the file's extension.
	test('reads the file name rather than the path', () => {
		expect(imageContentType('images/a.png/b')).toBeNull();
		expect(imageContentType('images/a.b/c.png')).toBe('image/png');
	});
});
