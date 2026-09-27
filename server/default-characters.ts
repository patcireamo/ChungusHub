/**
 * The example characters the app ships, seeded into the library ONCE.
 *
 * `defaults/characters/` is read as a folder, the same way `defaults/presets/` is: `<id>.json`
 * is a character, `<id>.<image>` beside it is the portrait, and the `<id>/` folder beside it is
 * the sprite pack, one picture per label in SillyTavern's own layout. Dropping that set in is
 * the whole act of shipping a character, so there is no list to keep in step with the files.
 *
 * **What is different here is what happens after a delete.** A preset the user removes comes
 * back on the next boot, because the app must always have something to generate with. A
 * character is somebody's library, so once it is gone it stays gone: the ids already seeded are
 * kept in the `seededDefaultCharacters` setting and that ledger is never cleared. It holds ids
 * rather than a single "done" flag so a character added to a later build still reaches an
 * install that already exists, without resurrecting the one its owner threw away.
 *
 * An empty or missing folder is fine, unlike the preset one: a build that ships no example
 * character is a build without one, not a broken install.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CHARACTERS_DIR } from './config';
import { IMAGE_EXT_RE, seedBundledImage, visibleEntries } from './files';
import { serverDb } from './db';
import { labelFromFilename, normalizeSpriteLabel, resolveDefaultSprite } from '../shared/sprites';

/** The ids this install has already been given. Never cleared, which is the whole point. */
const LEDGER_KEY = 'seededDefaultCharacters';

/** A bundled character's own file, which is the stored row's content and nothing else: no image
 *  paths, because a path is install-local and this is where the files it names come into
 *  existence. `defaultSprite` names a LABEL, since that is what the pack calls its pictures. */
interface BundledCard {
	name: string;
	tags: string[];
	traits: Record<string, unknown>;
	alternateGreetings: string[];
	defaultSprite?: string;
}

interface BundledCharacter {
	id: string;
	/** Portrait filename beside the card, or null when it ships faceless. */
	portrait: string | null;
	/** Sprite filenames inside `<id>/`, sorted so every machine reads the pack in one order. */
	sprites: string[];
}

export function ensureDefaultCharacters(): void {
	const seeded = readLedger();
	for (const bundle of bundledCharacters()) {
		if (seeded.has(bundle.id)) continue;
		seedCharacter(bundle, seeded);
	}
}

/**
 * A malformed ledger throws rather than reading as empty. Treating it as empty would seed every
 * example character again, which for anyone who deleted one is the app putting it back and for
 * everyone else is a second copy.
 */
function readLedger(): Set<string> {
	const raw = serverDb.getSetting(LEDGER_KEY);
	if (!raw) return new Set();
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) throw new Error(`Setting ${LEDGER_KEY} is not a list: ${raw}`);
	return new Set(parsed.map(String));
}

function bundledCharacters(): BundledCharacter[] {
	if (!existsSync(DEFAULT_CHARACTERS_DIR)) return [];
	const entries = visibleEntries(DEFAULT_CHARACTERS_DIR);
	// Sorted, so an id carrying two pictures resolves to the same one on every machine instead
	// of following the filesystem's mood.
	const images = entries.filter((e) => e.isFile() && IMAGE_EXT_RE.test(e.name)).map((e) => e.name).sort();
	const folders = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
	return entries
		.filter((e) => e.isFile() && e.name.endsWith('.json'))
		.map((e) => e.name.replace(/\.json$/, ''))
		.sort()
		.map((id) => ({
			id,
			portrait: images.find((name) => name.replace(IMAGE_EXT_RE, '') === id) ?? null,
			sprites: folders.has(id) ? spriteFilesIn(join(DEFAULT_CHARACTERS_DIR, id)) : []
		}));
}

function spriteFilesIn(dir: string): string[] {
	return visibleEntries(dir)
		.filter((e) => e.isFile() && IMAGE_EXT_RE.test(e.name))
		.map((e) => e.name)
		.sort();
}

/** Read a bundled card, refusing anything that would land as a nameless or contentless row. */
function readCard(id: string): BundledCard {
	const where = `defaults/characters/${id}.json`;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(join(DEFAULT_CHARACTERS_DIR, `${id}.json`), 'utf8')) as Record<string, unknown>;
	} catch (e) {
		// A bare parse error names no file, and this runs at boot, where it is all anyone sees.
		throw new Error(`${where} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error(`${where} has no name`);
	if (!raw.traits || typeof raw.traits !== 'object') throw new Error(`${where} has no traits`);
	return {
		name: raw.name,
		tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
		traits: raw.traits as Record<string, unknown>,
		alternateGreetings: Array.isArray(raw.alternateGreetings) ? raw.alternateGreetings.map(String) : [],
		defaultSprite: typeof raw.defaultSprite === 'string' ? raw.defaultSprite : undefined
	};
}

/**
 * Copy the pictures, then write the row and the ledger together.
 *
 * The two writes share a transaction because they answer the same question from opposite sides:
 * a row without its ledger entry is a character that comes back doubled on the next boot, and a
 * ledger entry without its row is a character that never arrives at all. Pictures copied by a
 * run that then died are unreferenced bytes and nothing worse, the same exposure a seeded preset
 * cover carries.
 */
function seedCharacter(bundle: BundledCharacter, seeded: Set<string>): void {
	const card = readCard(bundle.id);
	const identity: Record<string, unknown> = { name: card.name, tags: card.tags };

	if (bundle.portrait) {
		identity.imageUrl = seedBundledImage(join(DEFAULT_CHARACTERS_DIR, bundle.portrait), 'characters');
	}
	if (bundle.sprites.length > 0) {
		const sprites = bundle.sprites.map((file) => ({
			path: seedBundledImage(join(DEFAULT_CHARACTERS_DIR, bundle.id, file), 'characters'),
			label: labelFromFilename(file)
		}));
		identity.sprites = sprites;
		identity.defaultSprite = resolveDefaultSprite(sprites, pickDefaultSprite(card, sprites, bundle.id));
	}

	const data: Record<string, unknown> = { traits: card.traits };
	if (card.alternateGreetings.length > 0) data.alternateGreetings = card.alternateGreetings;

	const now = Date.now();
	serverDb.inTransaction(() => {
		serverDb.insertLibraryEntry({
			id: randomUUID(),
			type: 'character',
			identity,
			data,
			isFavorite: false,
			createdAt: now,
			updatedAt: now
		});
		serverDb.setSetting(LEDGER_KEY, JSON.stringify([...seeded, bundle.id]));
	});
	seeded.add(bundle.id);
	console.log(`[library] seeded the example character "${card.name}" (${bundle.sprites.length} sprite(s)).`);
}

/**
 * The path the card's `defaultSprite` label names, or undefined to let the pack's first picture
 * take the role. A label naming nothing throws: it is a typo in a file we ship, and the sprite
 * silently chosen instead would be whichever one happened to sort first.
 */
function pickDefaultSprite(
	card: BundledCard,
	sprites: { path: string; label: string }[],
	id: string
): string | undefined {
	if (!card.defaultSprite) return undefined;
	const wanted = normalizeSpriteLabel(card.defaultSprite).toLowerCase();
	const match = sprites.find((s) => s.label.toLowerCase() === wanted);
	if (!match) {
		throw new Error(`defaults/characters/${id}.json names default sprite "${card.defaultSprite}", which no picture in ${id}/ carries`);
	}
	return match.path;
}
