/**
 * File-backed storage: character images (+ thumbnails) and prompt presets.
 * Centralized on the server so every device sees the same assets.
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	ASSISTANT_FILES_ROOT,
	DEFAULT_BACKGROUNDS_DIR,
	DEFAULT_PRESETS_DIR,
	IMAGES_ROOT,
	IMAGE_CATEGORIES,
	PRESETS_DIR,
	TEMP_PRESETS_DIR,
	type ImageCategory
} from './config';

// ===== IMAGES =====

/**
 * The extensions a stored picture can wear and the type each is served as, most likely first:
 * normalized art is png with jpeg as its overflow (`toStoredFormat` on the client), while
 * anything the app ships with (backgrounds, preset covers, an example character's art) keeps
 * whatever it was authored as, since it is copied rather than uploaded. It is the set a file
 * has to be in to count as a picture, it is walked in order when a thumbnail request has to
 * find its original, and it is the only thing `/files/` will answer with.
 *
 * Both halves are one decision, and neither closes the door alone. An upload names its own
 * extension, so without the whitelist a caller stores an `.html` under this origin and then
 * navigates to it; without the fixed type beside it, a name that IS on the list still gets
 * served by whatever a content-type guess makes of the bytes inside.
 */
const IMAGE_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.avif': 'image/avif'
};

const IMAGE_EXTENSIONS = Object.keys(IMAGE_TYPES);

/** The type a stored picture is served with, or null for a name that is not one of them. */
export function imageContentType(path: string): string | null {
	const ext = path.match(/\.[^./\\]+$/)?.[0].toLowerCase();
	return (ext && IMAGE_TYPES[ext]) || null;
}

/** What counts as a picture in a bundled folder: workspace backgrounds, the cover art sitting
 *  beside a default preset, and an example character's portrait and sprites. */
export const IMAGE_EXT_RE = new RegExp(`(${IMAGE_EXTENSIONS.map((e) => `\\${e}`).join('|')})$`, 'i');

/**
 * Every thumbnail is webp, and the extension is FIXED, which is what keeps a thumbnail's
 * path a pure derivation from its original's rather than a lookup. `thumbnailFor` is the one
 * spelling of that convention on this side (the backup inventory and the assistant smoke
 * script call it rather than repeating it); the client has the only other copy, since it
 * cannot import server code, and `contracts.test.ts` holds the two together.
 *
 * webp rather than jpeg because a thumbnail must not change what the picture IS: jpeg has no
 * alpha, so a cut-out came back with its removed background filled in black. It is also the
 * format `toStoredFormat` may never use for a STORED file, and the difference is the
 * audience: stored art is what a model receives (local llama.cpp servers refuse webp
 * outright), while a thumbnail is only ever drawn by this app's own browser tab.
 */
const THUMBNAIL_EXTENSION = '.webp';

/** The thumbnail beside an original, by the convention this module writes it under. */
export function thumbnailFor(relativePath: string): string {
	const dir = relativePath.slice(0, relativePath.lastIndexOf('/')); // images/<category>
	const nameWithoutExt = basename(relativePath).replace(/\.[^.]+$/, '');
	return `${dir}/thumbnails/${nameWithoutExt}${THUMBNAIL_EXTENSION}`;
}

/**
 * The file that answers a `/files/images/…` request: normally the one asked for, and for a
 * thumbnail that does not exist, the original beside it.
 *
 * The walk below is spelled in lowercase and every writer into this store lowercases what it
 * writes (`saveImage`, `copyImage`, `seedBundledImage`), which is one invariant rather than
 * three coincidences. Break it and the picture is found on Windows and gone on Linux.
 *
 * A thumbnail is an optimization and never a distinct asset, so the request means "the
 * smallest stored copy of this picture" and there is always an answer while the picture
 * itself is there. Three states reach it: an upload whose thumbnail failed to encode
 * (`makeThumbnail` returns null and the upload goes ahead without one), a picture stored
 * before thumbnails were webp, and a category that never wrote one. Without the rule each of
 * those is a broken-image icon in a gallery, which tells the reader nothing and hides a
 * picture that is safe on disk.
 */
export function resolveImageFile(relativePath: string): string | null {
	const direct = absFromRelative(relativePath);
	if (existsSync(direct) && statSync(direct).isFile()) return direct;

	const cut = relativePath.lastIndexOf('/thumbnails/');
	if (cut === -1) return null;
	const dir = relativePath.slice(0, cut);
	const nameWithoutExt = basename(relativePath).replace(/\.[^.]+$/, '');
	for (const ext of IMAGE_EXTENSIONS) {
		const candidate = absFromRelative(`${dir}/${nameWithoutExt}${ext}`);
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

function absFromRelative(relativePath: string): string {
	// This layout is spelled with `/` on every platform, and a host-shaped path is refused
	// at the door rather than served. A backslash is an ordinary character to the
	// `/thumbnails/` checks above, so one arriving from a caller that ran a path through
	// `node:path` leaves every derivation here quietly unmatched on Windows alone, and each
	// miss surfaces as a picture that is on disk and cannot be found.
	if (relativePath.includes('\\')) {
		throw new Error(`Image paths are spelled with "/": ${relativePath}`);
	}
	// relativePath looks like images/<category>/<file>. Strip the images/ prefix and
	// rejoin under the images root so paths can't escape it.
	const safe = relativePath.replace(/^images\//, '').replace(/\.\./g, '');
	return join(IMAGES_ROOT, safe);
}

/**
 * Every thumbnail under a picture's name, whatever extension it wears. A stored name is this
 * picture's alone, so anything under it in `thumbnails/` is its own small copy, including one
 * left by an install that wrote them in another format. Going by today's extension alone
 * leaves those on disk, and nothing else ever walks that folder.
 */
function removeThumbnails(relativePath: string): void {
	const base = thumbnailFor(relativePath).replace(/\.[^.]+$/, '');
	for (const ext of IMAGE_EXTENSIONS) {
		const thumb = absFromRelative(`${base}${ext}`);
		if (existsSync(thumb)) rmSync(thumb);
	}
}

export async function saveImage(
	original: Blob,
	thumb: Blob | null,
	ext: string,
	category: ImageCategory = 'characters',
	preferredName?: string | null
): Promise<string> {
	const safeCategory = IMAGE_CATEGORIES.includes(category) ? category : 'characters';
	const cleanExt = `.${ext.replace(/^\./, '')}`.toLowerCase();
	// The caller names the extension and it lands in a filesystem path under an origin that
	// serves what is written there. A shape check is not enough: ".html" is as plain an
	// extension as ".png". Only a name on the list gets a file.
	if (!IMAGE_EXTENSIONS.includes(cleanExt)) {
		throw new Error(
			`"${ext}" is not a picture format ChungusHub stores. Use one of: ${IMAGE_EXTENSIONS.join(', ')}.`
		);
	}

	const dir = join(IMAGES_ROOT, safeCategory);
	const thumbsDir = join(dir, 'thumbnails');
	mkdirSync(dir, { recursive: true });
	mkdirSync(thumbsDir, { recursive: true });

	// Backgrounds keep a human-readable filename (it doubles as the display name in
	// the picker); entity art keeps opaque UUIDs. Sanitized to a safe basename, and
	// deduped with a numeric suffix so re-uploads never overwrite.
	let id: string = randomUUID();
	if (preferredName && safeCategory === 'backgrounds') {
		const base = basename(preferredName)
			.replace(/\.[^.]+$/, '')
			.replace(/[^a-z0-9 _-]/gi, '')
			.trim()
			.slice(0, 64);
		if (base) {
			id = base;
			for (let n = 2; existsSync(join(dir, `${id}${cleanExt}`)); n++) {
				id = `${base}-${n}`;
			}
		}
	}
	const filename = `${id}${cleanExt}`;

	writeFileSync(join(dir, filename), Buffer.from(await original.arrayBuffer()));
	if (thumb) {
		writeFileSync(
			join(thumbsDir, `${id}${THUMBNAIL_EXTENSION}`),
			Buffer.from(await thumb.arrayBuffer())
		);
	}

	return `images/${safeCategory}/${filename}`;
}

export function copyImage(relativePath: string, targetCategory?: ImageCategory): string | null {
	if (!relativePath) return null;
	const sourcePath = absFromRelative(relativePath);
	if (!existsSync(sourcePath)) return null;

	// Copy within the source's own category (images/<category>/...) unless the caller
	// names another one: a chat attachment adopted as character art moves folders, so
	// it outlives the chat it arrived in.
	const dirRel = targetCategory ? `images/${targetCategory}` : relativePath.slice(0, relativePath.lastIndexOf('/'));
	const dirAbs = absFromRelative(dirRel);
	const thumbsAbs = join(dirAbs, 'thumbnails');

	const ext = (relativePath.match(/\.[^.]+$/)?.[0] ?? '.png').toLowerCase();
	const newId = randomUUID();
	const newFilename = `${newId}${ext}`;

	mkdirSync(dirAbs, { recursive: true });
	mkdirSync(thumbsAbs, { recursive: true });
	copyFileSync(sourcePath, join(dirAbs, newFilename));

	const sourceThumb = absFromRelative(thumbnailFor(relativePath));
	if (existsSync(sourceThumb)) {
		copyFileSync(sourceThumb, join(thumbsAbs, `${newId}${THUMBNAIL_EXTENSION}`));
	}

	return `${dirRel}/${newFilename}`;
}

export function deleteImage(relativePath: string): void {
	if (!relativePath) return;
	const original = absFromRelative(relativePath);
	if (existsSync(original)) rmSync(original);
	removeThumbnails(relativePath);
}

/**
 * Every stored original, by the relative path a row names it with. The `thumbnails/`
 * subfolder is skipped: what sits in there is a derived copy of one of these and never a
 * picture in its own right.
 */
export function listStoredImages(): string[] {
	const out: string[] = [];
	for (const category of IMAGE_CATEGORIES) {
		const dir = join(IMAGES_ROOT, category);
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).sort()) {
			if (!IMAGE_EXT_RE.test(name)) continue;
			if (!statSync(join(dir, name)).isFile()) continue;
			out.push(`images/${category}/${name}`);
		}
	}
	return out;
}

/**
 * Store one picture's thumbnail, encoded from the original by the only encoder there is:
 * the browser (Settings › Advanced rebuilds them all with it).
 *
 * Every other spelling of this picture's thumbnail goes with the write. A stale one under
 * another extension is never read again, so leaving it would keep it beside the new file for
 * the rest of the picture's life and carry it into every backup.
 */
export async function saveThumbnail(relativePath: string, thumb: Blob): Promise<void> {
	if (!existsSync(absFromRelative(relativePath))) {
		throw new Error(`No stored picture at ${relativePath}`);
	}
	removeThumbnails(relativePath);
	writeFileSync(absFromRelative(thumbnailFor(relativePath)), Buffer.from(await thumb.arrayBuffer()));
}

// ===== ASSISTANT FILES =====

/**
 * Reference files attached to a Chungus Assistant tab (architecture/chungus-assistant.md).
 *
 * These bytes are NEVER served as a static file, unlike images. The stored text is whatever
 * the user uploaded, so serving it from the app's own origin would run an attached `.html`
 * or `.svg` as a page on the origin that holds the session cookie. The viewer and the tools
 * both read it through the JSON API instead, which has no content type to get wrong.
 */

function absAssistantFile(relativePath: string): string {
	// relativePath looks like assistant-files/<uuid>.txt. Strip the prefix and rejoin under
	// the root so a stored path can never escape it.
	const safe = relativePath.replace(/^assistant-files\//, '').replace(/\.\./g, '');
	return join(ASSISTANT_FILES_ROOT, safe);
}

/** Writes one attached file's normalized text and returns the path its row stores. */
export function saveAssistantFileText(text: string): string {
	const relative = `assistant-files/${randomUUID()}.txt`;
	writeFileSync(absAssistantFile(relative), text, 'utf-8');
	return relative;
}

/** The stored text. Throws when the file is gone: a row naming bytes that vanished is a
 *  real breakage, and answering an empty file would let the assistant read a card as blank. */
export function readAssistantFileText(relativePath: string): string {
	const abs = absAssistantFile(relativePath);
	if (!existsSync(abs)) throw new Error(`Attached file is missing from disk: ${relativePath}`);
	return readFileSync(abs, 'utf-8');
}

export function deleteAssistantFileText(relativePath: string): void {
	if (!relativePath) return;
	const abs = absAssistantFile(relativePath);
	if (existsSync(abs)) rmSync(abs);
}

/** Every stored file name under the root: the boot sweep's disk side. */
export function listAssistantFileNames(): string[] {
	if (!existsSync(ASSISTANT_FILES_ROOT)) return [];
	return readdirSync(ASSISTANT_FILES_ROOT).filter((name) => statSync(join(ASSISTANT_FILES_ROOT, name)).isFile());
}

/** Modified time of one stored file, for the sweep's age guard. */
export function assistantFileModifiedAt(relativePath: string): number {
	const abs = absAssistantFile(relativePath);
	return existsSync(abs) ? statSync(abs).mtimeMs : 0;
}

// ===== BACKGROUNDS =====

export interface BackgroundEntry {
	/** File-URL path relative to /files/, what the client stores and renders. */
	path: string;
	/** Display name derived from the filename. */
	name: string;
	/** Bundled default vs user-uploaded. Only custom ones can be deleted. */
	source: 'default' | 'custom';
}

function backgroundName(filename: string): string {
	return filename
		.replace(IMAGE_EXT_RE, '')
		.replace(/[-_]+/g, ' ')
		.trim()
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Every available workspace background: bundled defaults + user uploads. */
export function listBackgrounds(): BackgroundEntry[] {
	const out: BackgroundEntry[] = [];
	if (existsSync(DEFAULT_BACKGROUNDS_DIR)) {
		for (const name of readdirSync(DEFAULT_BACKGROUNDS_DIR).sort()) {
			if (!IMAGE_EXT_RE.test(name)) continue;
			out.push({ path: `backgrounds/${name}`, name: backgroundName(name), source: 'default' });
		}
	}
	const customDir = join(IMAGES_ROOT, 'backgrounds');
	if (existsSync(customDir)) {
		for (const name of readdirSync(customDir).sort()) {
			if (!IMAGE_EXT_RE.test(name)) continue;
			out.push({ path: `images/backgrounds/${name}`, name: backgroundName(name), source: 'custom' });
		}
	}
	return out;
}

// ===== PRESETS =====

/** The shape the server persists. Structural only: the client owns what the fields mean. */
export interface PresetFileData {
	name: string;
	items?: unknown[];
	controls?: unknown[];
	sections?: unknown[];
	bundles?: unknown[];
	meta?: unknown;
	regexRules?: unknown[];
	pruneEmptyBlocks?: boolean;
	exampleSeparator?: string;
	continuePrompt?: string;
}

function optionalArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/**
 * The one per-preset field list on this side of the wire: seeding a bundled default,
 * reading the directory and writing a file all go through it. Split it into hand-kept
 * copies and a new field survives one round trip, then vanishes on the next.
 */
function presetFileShape(data: Record<string, unknown>): Omit<PresetFileData, 'name'> & { name: unknown } {
	return {
		name: data.name,
		items: optionalArray(data.items) ?? [],
		controls: optionalArray(data.controls) ?? [],
		sections: optionalArray(data.sections),
		bundles: optionalArray(data.bundles),
		meta: data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta) ? data.meta : undefined,
		regexRules: optionalArray(data.regexRules),
		pruneEmptyBlocks: data.pruneEmptyBlocks === true,
		exampleSeparator: optionalString(data.exampleSeparator),
		continuePrompt: optionalString(data.continuePrompt)
	};
}

/**
 * Every bundled default, discovered from the folder rather than declared in a list:
 * `defaults/presets/<id>.json` is a preset, and a `<id>.<image>` beside it is its cover.
 * Dropping that pair into the folder is the whole act of shipping one, so there is no
 * second place to keep in step and no way to add a preset that arrives faceless.
 *
 * An empty folder throws. A build that seeds no preset puts a first-run user in front of
 * a workspace with nothing to generate with, which is a broken build, not a valid state.
 */
function bundledDefaults(): { id: string; cover: string | null }[] {
	const names = existsSync(DEFAULT_PRESETS_DIR) ? readdirSync(DEFAULT_PRESETS_DIR).sort() : [];
	const images = names.filter((name) => IMAGE_EXT_RE.test(name));
	const defaults = names
		.filter((name) => name.endsWith('.json'))
		.map((name) => {
			const id = name.replace(/\.json$/, '');
			// Read in sorted order, so a name carrying two pictures resolves to the same one
			// on every machine instead of following the filesystem's mood.
			return { id, cover: images.find((image) => image.replace(IMAGE_EXT_RE, '') === id) ?? null };
		});
	if (defaults.length === 0) {
		throw new Error(`No bundled default presets in ${DEFAULT_PRESETS_DIR}`);
	}
	return defaults;
}

/**
 * Copy a bundled picture into the image store and hand back the path that will name it.
 *
 * It lands the way an upload does, under a fresh id, for one reason: restoring preset defaults
 * deletes the covers the old presets named *after* the server has re-seeded, so a fixed
 * filename would have the wipe take the fresh copy with it. It writes no thumbnail, since
 * `resolveImageFile` answers a thumbnail request with the original when there is none, and that
 * is exactly the intent: a shipped picture is already stored at the size the app draws it, so
 * there is nothing a thumbnail would save.
 */
export function seedBundledImage(sourcePath: string, category: ImageCategory): string {
	const dir = join(IMAGES_ROOT, category);
	mkdirSync(dir, { recursive: true });
	// Lowercased like every other write into this store, because the walk in `resolveImageFile`
	// is spelled in lowercase: a `.JPEG` on disk is found on Windows and is a broken picture on
	// Linux, which is the one shape of bug a bundled asset can carry to every install at once.
	const ext = sourcePath.slice(sourcePath.lastIndexOf('.')).toLowerCase();
	const filename = `${randomUUID()}${ext}`;
	copyFileSync(sourcePath, join(dir, filename));
	return `images/${category}/${filename}`;
}

export function ensureDefaultPresets(): void {
	mkdirSync(PRESETS_DIR, { recursive: true });
	for (const { id, cover } of bundledDefaults()) {
		const dest = join(PRESETS_DIR, `${id}.json`);
		if (existsSync(dest)) continue;
		const src = join(DEFAULT_PRESETS_DIR, `${id}.json`);
		const shaped = presetFileShape(JSON.parse(readFileSync(src, 'utf8')));
		// The bundled document carries no cover path: a path is install-local, and this is
		// where the file it names comes into existence.
		if (cover) {
			shaped.meta = {
				...((shaped.meta ?? {}) as Record<string, unknown>),
				cover: seedBundledImage(join(DEFAULT_PRESETS_DIR, cover), 'presets')
			};
		}
		writeFileSync(dest, JSON.stringify(shaped, null, 2));
	}
}

// Keep underscores: bundled default ids (e.g. "standard_chungus") use them. Stripping
// them rewrote files under a different id, spawning duplicates.
const PRESET_ID_RE = /[^a-z0-9_-]/gi;

function readPresetDir(dir: string): unknown[] {
	mkdirSync(dir, { recursive: true });
	const out: unknown[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith('.json')) continue;
		const data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
		out.push({ id: name.replace(/\.json$/, ''), ...presetFileShape(data) });
	}
	return out;
}

function writePresetFile(dir: string, id: string, data: PresetFileData): void {
	const safeId = id.replace(PRESET_ID_RE, '');
	if (!safeId) throw new Error('Invalid preset id');
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${safeId}.json`),
		JSON.stringify(presetFileShape(data as unknown as Record<string, unknown>), null, 2)
	);
}

function removePresetFile(dir: string, id: string): void {
	const safeId = id.replace(PRESET_ID_RE, '');
	if (!safeId) return;
	const path = join(dir, `${safeId}.json`);
	if (existsSync(path)) rmSync(path);
}

// ----- committed presets (data/presets) -----
export function listPresets(): unknown[] {
	return readPresetDir(PRESETS_DIR); // the temp/ subdir is skipped (not a .json file)
}

export function savePreset(
	id: string,
	data: PresetFileData
): void {
	writePresetFile(PRESETS_DIR, id, data);
}

export function deletePreset(id: string): void {
	removePresetFile(PRESETS_DIR, id);
	removePresetFile(TEMP_PRESETS_DIR, id); // drop any unsaved draft with it
}

// ----- per-preset drafts (data/presets/temp) -----
export function listDrafts(): unknown[] {
	return readPresetDir(TEMP_PRESETS_DIR);
}

export function saveDraft(
	id: string,
	data: PresetFileData
): void {
	writePresetFile(TEMP_PRESETS_DIR, id, data);
}

export function deleteDraft(id: string): void {
	removePresetFile(TEMP_PRESETS_DIR, id);
}

// Factory reset: wipe every preset and draft, then re-seed the bundled defaults.
export function restoreDefaults(): void {
	for (const dir of [PRESETS_DIR, TEMP_PRESETS_DIR]) {
		mkdirSync(dir, { recursive: true });
		for (const name of readdirSync(dir)) {
			if (name.endsWith('.json')) rmSync(join(dir, name));
		}
	}
	ensureDefaultPresets();
}
