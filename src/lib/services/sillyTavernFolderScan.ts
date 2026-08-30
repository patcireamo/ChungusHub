/**
 * Reading a picked folder into one bundle of SillyTavern files.
 *
 * **The pick is the profile folder** (`data/default-user` in a standard install), and a known
 * folder counts only as a direct child of it. An ancestor therefore matches nothing and is
 * refused, which is the whole rule. Resolving an ancestor for the reader is not free and must
 * not come back: `<input webkitdirectory>` makes the BROWSER walk every file under the pick
 * before a line of this runs, so pointing at a SillyTavern checkout costs its entire
 * `node_modules` whatever we then do with the list.
 *
 * Everything that can be known about a pick before a single row is written, and nothing else:
 * no stores, no db, no writes, and tested as such
 * ([`sillyTavernFolderScan.test.ts`](./sillyTavernFolderScan.test.ts)). Path arithmetic answers
 * all of it but one, a persona's name, which SillyTavern keeps in `settings.json`. Staying free
 * of the store graph is what lets both the confirm card and the importer read from here.
 * Writing the bundle belongs to `sillyTavernFolderImport.ts`.
 */

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;
const KNOWN_FOLDERS = ['backgrounds', 'characters', 'worlds', 'chats', 'User Avatars'] as const;
type KnownFolder = (typeof KNOWN_FOLDERS)[number];

/** One row of the import ledger: a source file an earlier run claimed, and what it became for
 *  the one kind a later run has to find again (a character card's library entry). */
export interface ImportedSource {
	key: string;
	entityId: string | null;
}

/** One profile folder's worth of files, ready to import. */
export interface FolderScan {
	/** The picked folder's own name, so the confirm card can say what it read. */
	root: string;
	characters: File[];
	/** Sprite folder name → its images. Grouped here so a pack lands as one write, and so the
	 *  count is on screen before the import runs. */
	spritesByFolder: Map<string, File[]>;
	worlds: File[];
	backgrounds: File[];
	avatars: File[];
	chats: { file: File; characterName: string }[];
	/** The profile's `settings.json`, which is where the persona names live. */
	settingsFile: File | null;
}

/**
 * Is this path a file inside one of SillyTavern's folders, one level under the pick?
 *
 * The browser prefixes every path with the picked folder's own name, so the folder has to be
 * the SECOND segment and can be nowhere else: deeper refuses an ancestor, and shallower would
 * accept a lone `characters/` folder as a profile, which is a different pick with no
 * `settings.json`, no chats and no way to spell any of that on screen.
 */
function isInKnownFolder(parts: string[]): boolean {
	return parts.length > 2 && (KNOWN_FOLDERS as readonly string[]).includes(parts[1]);
}

/**
 * File a path into its bucket.
 *
 * backgrounds / characters / worlds / User Avatars are flat in SillyTavern, so only direct
 * children count. A `characters/<Name>/` sub-folder is that character's sprites (anger.png,
 * joy.png, …) rather than a card, so it is bucketed separately and never mistaken for one.
 */
function place(scan: FolderScan, folder: KnownFolder, rest: string[], file: File): void {
	const direct = rest.length === 1;
	if (folder === 'backgrounds' && direct && IMAGE_EXT.test(file.name)) scan.backgrounds.push(file);
	else if (folder === 'characters' && direct && /\.(png|json)$/i.test(file.name)) scan.characters.push(file);
	else if (folder === 'characters' && rest.length === 2 && IMAGE_EXT.test(file.name)) {
		// characters/<characterName>/<label>.png: the filename IS the label.
		const bucket = scan.spritesByFolder.get(rest[0]);
		if (bucket) bucket.push(file);
		else scan.spritesByFolder.set(rest[0], [file]);
	} else if (folder === 'worlds' && direct && /\.json$/i.test(file.name)) scan.worlds.push(file);
	else if (folder === 'User Avatars' && direct && IMAGE_EXT.test(file.name)) scan.avatars.push(file);
	else if (folder === 'chats' && /\.jsonl$/i.test(file.name) && rest.length >= 2) {
		// chats/<characterName>/<file>.jsonl: the folder names the character.
		scan.chats.push({ file, characterName: rest[0] });
	}
}

/**
 * Read a picked profile folder. Returns **null** when nothing recognizable is directly inside
 * it, never an empty bundle: importing nothing under a success message is how somebody decides
 * the app cannot read their library.
 */
export function scanSillyTavernFolder(files: File[]): FolderScan | null {
	const scan: FolderScan = {
		root: '',
		characters: [],
		spritesByFolder: new Map(),
		worlds: [],
		backgrounds: [],
		avatars: [],
		chats: [],
		settingsFile: null
	};

	for (const file of files) {
		const parts = (file.webkitRelativePath || file.name).split('/').filter(Boolean);

		// The profile's own settings.json, beside those folders and never deeper.
		if (parts[parts.length - 1] === 'settings.json') {
			if (parts.length <= 2 && !scan.settingsFile) scan.settingsFile = file;
			continue;
		}

		if (!isInKnownFolder(parts)) continue;
		scan.root = parts[0];
		place(scan, parts[1] as KnownFolder, parts.slice(2), file);
	}

	return countFiles(scan) > 0 ? scan : null;
}

/** How many files a bundle would import. Sprites count one by one, since each is its own
 *  source file even though a pack lands as one write. */
export function countFiles(scan: FolderScan): number {
	let sprites = 0;
	for (const files of scan.spritesByFolder.values()) sprites += files.length;
	return (
		scan.characters.length +
		sprites +
		scan.worlds.length +
		scan.backgrounds.length +
		scan.avatars.length +
		scan.chats.length
	);
}

/** A filename without its extension. SillyTavern names a card's file after the character and
 *  folders that character's chats and sprites under the same stem, so this is the one piece of
 *  arithmetic the binding rule rests on and it lives here once. */
export function stemOf(name: string): string {
	return name.replace(/\.[^.]+$/, '');
}

/**
 * What a file is called in the import ledger (`import_sources`, architecture/server-core.md).
 *
 * The path INSIDE the picked folder, so the same library recognizes itself after being copied
 * or renamed, namespaced by the format so a second importer can never collide with this one.
 * A path and not a hash: a card edited in SillyTavern is that character arriving twice, and a
 * key that moved with every edit would protect nobody.
 */
export function sourceKey(root: string, file: File): string {
	const path = file.webkitRelativePath || file.name;
	const inside = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
	return `sillytavern:${inside}`;
}

/**
 * The card filename's stem, for a key that names a character card, else null.
 *
 * This is what lets a LATER run bind a chat folder to a character the ledger already holds:
 * the folder is named after the card's file, and matching on display name instead is the exact
 * collision that filename matching exists to avoid. A sprite (`characters/<Name>/joy.png`) is
 * not a card, so the single segment under `characters/` is required rather than assumed.
 */
export function cardStemFromKey(key: string): string | null {
	const parts = key.replace(/^sillytavern:/, '').split('/');
	if (parts.length !== 2 || parts[0] !== 'characters') return null;
	return stemOf(parts[1]).toLowerCase();
}

/**
 * The world file's stem, for a key that names one, else null.
 *
 * SillyTavern names a world file after the book inside it, and a card links to that book by the
 * same name (`extensions.world`), so this is what lets a LATER run bind a card to a book an
 * earlier run already brought over instead of shelving the card's own copy beside it.
 */
export function worldStemFromKey(key: string): string | null {
	const parts = key.replace(/^sillytavern:/, '').split('/');
	if (parts.length !== 2 || parts[0] !== 'worlds') return null;
	return stemOf(parts[1]).toLowerCase();
}

/**
 * The same bundle with a set of source keys taken out. Sprite folders left empty by the filter
 * are dropped whole, so a character whose pack is entirely gone is not visited at all.
 *
 * **One filter, two questions.** The ledger asks it with what earlier runs already claimed, and
 * the confirm card asks it again with what the reader has switched off. Shrinking the bundle is
 * the ONLY way either one narrows an import: the importer writes whatever it is handed, so
 * neither of them needs a flag inside it, and there is one place where "this file is not coming
 * over" is decided.
 */
export function withoutKeys(scan: FolderScan, keys: Set<string>): FolderScan {
	const kept = (file: File) => !keys.has(sourceKey(scan.root, file));
	const spritesByFolder = new Map<string, File[]>();
	for (const [folder, files] of scan.spritesByFolder) {
		const pack = files.filter(kept);
		if (pack.length > 0) spritesByFolder.set(folder, pack);
	}
	return {
		root: scan.root,
		characters: scan.characters.filter(kept),
		spritesByFolder,
		worlds: scan.worlds.filter(kept),
		backgrounds: scan.backgrounds.filter(kept),
		avatars: scan.avatars.filter(kept),
		chats: scan.chats.filter((c) => kept(c.file)),
		// The profile's settings.json is in no bucket, is never claimed and is never a row the
		// reader can switch off: it is read for the persona names beside it, and a run that
		// imports one new persona still needs it.
		settingsFile: scan.settingsFile
	};
}

/** One row the confirm card draws, and every source key it stands for. A sprite pack and a
 *  character's chat history are many files under one row, so a row is a key LIST. */
export interface PlanItem {
	/** Unique within its group. The row's first key, which no other row can hold. */
	id: string;
	label: string;
	keys: string[];
}

export type PlanGroupId =
	| 'characters'
	| 'sprites'
	| 'personas'
	| 'chats'
	| 'worlds'
	| 'backgrounds';

export interface PlanGroup {
	id: PlanGroupId;
	label: string;
	items: PlanItem[];
}

/** SillyTavern settings.json: only the persona bits we read. */
interface STSettings {
	power_user?: {
		personas?: Record<string, string>;
		persona_descriptions?: Record<string, { description?: string }>;
	};
}

/** A profile's persona identities, keyed by avatar filename. */
export interface PersonaSettings {
	names: Record<string, string>;
	descriptions: Record<string, string>;
}

/**
 * Read the persona identities out of a profile's `settings.json`.
 *
 * **A persona's name is the one thing about a picked profile that cannot be read off a path**,
 * since SillyTavern keeps it here rather than in the avatar's filename. This is the ONE reader
 * of that file's shape: the confirm card labels its rows from `names` and the run writes both,
 * so a card naming a persona one thing while the import writes another cannot happen.
 *
 * It lives beside the scan rather than in the importer because both callers need it and only
 * one of them can be imported without a store graph behind it. Throws on unreadable JSON, and
 * each caller decides what that costs it.
 */
export function readPersonaSettings(text: string): PersonaSettings {
	const power = (JSON.parse(text) as STSettings)?.power_user;
	const descriptions: Record<string, string> = {};
	for (const [file, entry] of Object.entries(power?.persona_descriptions ?? {})) {
		if (typeof entry?.description === 'string') descriptions[file] = entry.description;
	}
	return { names: power?.personas ?? {}, descriptions };
}

/** Names a bundle's rows cannot read off their own paths. */
export interface PlanLabels {
	/** Persona display names by avatar filename, out of the profile's `settings.json`. The one
	 *  row this module cannot name on its own, since SillyTavern keeps a persona's name there
	 *  rather than in the picture's filename. */
	personas?: Record<string, string>;
}

/**
 * A bundle spelled out as the rows somebody can switch off.
 *
 * The rows read the way somebody thinks about a profile, which is not the order the run writes
 * them in: lorebooks land first there, so a card can bind to the book it names rather than
 * shelving its own copy of it.
 *
 * **Every label but one comes off a path**, so a card is never opened and a lorebook is never
 * parsed to draw this: SillyTavern names a card's file after the character, folders sprites and
 * chats under that same name, and names a world file after the book. A pick of four hundred
 * characters therefore costs no reads at all. Personas are the exception and take their names
 * through `labels`, falling back to the filename exactly as the import itself does, so a row
 * cannot be labelled one thing and written as another.
 *
 * **Sprites and chats are one row per character, not one per file.** A pack is already one
 * write, and a story's history is the unit somebody decides about; three hundred timestamps
 * under one heading is a list nobody reads. Per-file chat picking has its own surface
 * (architecture/chat-sessions.md), so it is deliberately not repeated here.
 *
 * Empty groups are dropped: a heading with nothing under it is a control that cannot move.
 */
export function planGroups(scan: FolderScan, labels: PlanLabels = {}): PlanGroup[] {
	const key = (file: File) => sourceKey(scan.root, file);
	const fileItem = (file: File): PlanItem => ({
		id: key(file),
		label: stemOf(file.name),
		keys: [key(file)]
	});
	const personaItem = (file: File): PlanItem => ({
		id: key(file),
		label: labels.personas?.[file.name]?.trim() || stemOf(file.name),
		keys: [key(file)]
	});
	const folderItem = (label: string, files: File[]): PlanItem => ({
		id: key(files[0]),
		label,
		keys: files.map(key)
	});

	const chatsByCharacter = new Map<string, File[]>();
	for (const { file, characterName } of scan.chats) {
		const bucket = chatsByCharacter.get(characterName);
		if (bucket) bucket.push(file);
		else chatsByCharacter.set(characterName, [file]);
	}

	const groups: PlanGroup[] = [
		{ id: 'characters', label: 'Characters', items: scan.characters.map(fileItem) },
		{
			id: 'sprites',
			label: 'Sprites',
			items: [...scan.spritesByFolder].map(([folder, files]) => folderItem(folder, files))
		},
		{ id: 'personas', label: 'Personas', items: scan.avatars.map(personaItem) },
		{
			id: 'chats',
			label: 'Chats',
			items: [...chatsByCharacter].map(([character, files]) => folderItem(character, files))
		},
		{ id: 'worlds', label: 'Lorebooks', items: scan.worlds.map(fileItem) },
		{ id: 'backgrounds', label: 'Backgrounds', items: scan.backgrounds.map(fileItem) }
	];
	return groups.filter((group) => group.items.length > 0);
}

/**
 * How many chats and sprite packs in this bundle belong to a character the reader switched off.
 *
 * Both bind to their character by folder name, so leaving that character out lands them nowhere
 * and reports them skipped. **This asks the importer's own question early enough for the reader
 * to change the answer**, which is the whole point: read off the report afterwards it is a list
 * of work that did not happen and cannot be retried without picking the folder again.
 *
 * **Only the case a tick can fix is counted, and that is the difference between a warning and
 * noise.** A folder whose character is nowhere in the picked profile at all is an orphan of
 * SillyTavern's own making (a card deleted there leaves its chat folder behind), and there is
 * nothing on this card to switch on for it: the run reports those as skipped, which is the only
 * honest thing anybody can say about them. So a folder counts here only when its character is
 * `available` (a row the card is offering) and not `resolvable` (a row that would actually
 * bind). `resolvable` is assembled by the caller from the same three sources the importer binds
 * with (this run's cards, the ledger's claims, the library's display names), and that pairing is
 * hand-kept.
 *
 * Chats are counted as files and sprites as packs, matching what each one costs the reader and
 * what the run's own report lists.
 */
export function strandedByChoice(
	scan: FolderScan,
	resolvable: Set<string>,
	available: Set<string>
): { chats: number; sprites: number } {
	const fixable = (folder: string) => {
		const name = folder.trim().toLowerCase();
		return !resolvable.has(name) && available.has(name);
	};
	let chats = 0;
	for (const { characterName } of scan.chats) if (fixable(characterName)) chats++;
	let sprites = 0;
	for (const folder of scan.spritesByFolder.keys()) if (fixable(folder)) sprites++;
	return { chats, sprites };
}
