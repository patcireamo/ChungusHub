/**
 * Server configuration and filesystem paths.
 * Everything lives under a single data directory so the whole install is portable.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ensurePrivacyMarkers } from './privacy-notice';
import { hostnameEntry } from './same-origin';

// True inside a `bun build --compile` binary: bundled modules live on the
// virtual bunfs mount (/$bunfs, B:\~BUN on Windows), not on disk. Uses the
// standard import.meta.url (not Bun's .path) because Vite also loads this
// module when bundling the config, and DECODES it first: a file URL escapes
// the `~` of the Windows mount to `%7E`, so an undecoded check answers false
// in every Windows portable build. That is not a cosmetic miss: BASE_DIR
// falls back to the working directory, which puts user-data wherever the app
// happened to be launched from and looks for `build/` there too.
const META_URL = decodeURIComponent(import.meta.url);
export const IS_COMPILED = META_URL.includes('$bunfs') || META_URL.includes('~BUN');

// Where the app's files live. From source that's the repo (cwd); as a compiled
// portable binary it's the folder the executable sits in, so double-clicking
// works from anywhere and user-data lands next to the exe.
const BASE_DIR = IS_COMPILED ? dirname(process.execPath) : process.cwd();

/**
 * Process settings: what this process has to know before it can answer anything, and what
 * nobody can fix from inside the app once it is wrong. Port, address, and where the data and
 * the snapshots live. Everything the app can change about itself is an app setting and lives
 * in the database instead.
 *
 * The file sits beside the executable (beside the repo from source) and NOT under the data
 * dir, because it is the thing that says where the data dir is. Precedence is environment
 * variable > file > default, in that order and nowhere else: the test suite pins its throwaway
 * dirs through the environment and has to win over whatever an install happens to carry.
 *
 * A value it cannot read is collected here rather than thrown: this module is imported by
 * `vite.config.ts` as well, so the sentence belongs to the server's own startup, which reads
 * `CONFIG_ISSUES` and stops on it.
 */
export const CONFIG_PATH = join(BASE_DIR, 'chungushub.config.json');

/** Exported for the packaging script alone: what a fresh install will listen on, which is
 *  what its README has to state rather than whatever port the machine doing the build uses. */
export const DEFAULT_PORT = 4242;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_DATA_DIR = 'user-data';
/** Relative to the DATA dir, so a data folder moved somewhere else keeps its snapshots beside it. */
const DEFAULT_BACKUP_DIR = '../backups';

/** Every setting the file holds and what a fresh install gets, in the order it is written. One
 *  list, so the first write, the backfill and the unknown-key check can never disagree about
 *  what a complete file looks like. */
const CONFIG_DEFAULTS: Record<string, unknown> = {
	'//': 'ChungusHub process settings, read once at startup: restart to apply, and an environment variable wins over anything here. Relative paths: dataDir from this file, backupDir from the data folder.',
	port: DEFAULT_PORT,
	host: DEFAULT_HOST,
	dataDir: DEFAULT_DATA_DIR,
	backupDir: DEFAULT_BACKUP_DIR,
	openBrowser: true,
	allowedHostnames: []
};
/** A note is not a setting, so it is never backfilled: a reader who deleted one keeps it deleted. */
const SETTING_KEYS = Object.keys(CONFIG_DEFAULTS).filter((key) => !key.startsWith('//'));

/** A value this process cannot read, which stops the boot: it would otherwise substitute a
 *  default for it, and the two it decides are where the data lives and who can reach it. */
export const CONFIG_ISSUES: string[] = [];
/** Printed at boot and nothing more. Nothing is being substituted for a key this build does not
 *  know, so refusing to start on one would wall off going back to an older ChungusHub after a
 *  newer one added a setting to the file, which is a move the app allows everywhere else. */
export const CONFIG_NOTICES: string[] = [];
/** Environment variables winning over a value the file also states, named on the boot banner.
 *  An edited line that silently does nothing is the one failure a second settings surface can
 *  still cause, and these are deliberately absent from the docs. */
export const CONFIG_OVERRIDES: string[] = [];

function readConfigFile(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
	} catch (error) {
		CONFIG_ISSUES.push(`${CONFIG_PATH} is not readable as JSON: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		CONFIG_ISSUES.push(`${CONFIG_PATH} must hold a JSON object.`);
		return {};
	}
	const file = parsed as Record<string, unknown>;
	// A misspelled key that silently does nothing is the whole reason this file exists to be
	// hand-edited, so it is named rather than ignored, on screen and not by refusing to start
	// (see CONFIG_NOTICES). Anything beginning with `//` is a note: the shipped file teaches
	// that spelling with its own first line, so a second one is not a typo.
	for (const key of Object.keys(file)) {
		if (key.startsWith('//')) continue;
		if (!SETTING_KEYS.includes(key)) {
			CONFIG_NOTICES.push(`"${key}" in ${CONFIG_PATH} is not a setting. Known keys: ${SETTING_KEYS.join(', ')}.`);
		}
	}
	return file;
}

const FILE = readConfigFile();

/** Read once at import: called per use it would report the same fault on every call. */
function fileText(key: 'host' | 'dataDir' | 'backupDir'): string | null {
	const value = FILE[key];
	if (value === undefined) return null;
	if (typeof value !== 'string' || !value.trim()) {
		CONFIG_ISSUES.push(`"${key}" in ${CONFIG_PATH} must be a non-empty string.`);
		return null;
	}
	return value.trim();
}

/** Strictly a boolean rather than anything truthy, for the same reason `readPort` refuses a value
 *  that merely converts to a number: `"false"` is a string, and every string is true. Someone who
 *  wrote it meaning off would get a browser on every launch and no line saying why. */
function fileBool(key: 'openBrowser'): boolean | null {
	const value = FILE[key];
	if (value === undefined) return null;
	if (typeof value !== 'boolean') {
		CONFIG_ISSUES.push(`"${key}" in ${CONFIG_PATH} must be true or false.`);
		return null;
	}
	return value;
}

/** The names this install answers to on top of the ones that are its own by construction
 *  (server/same-origin.ts). Same stance as the readers above: a value it cannot read stops the
 *  boot rather than being narrowed to the empty list, which would lock the reader out of the
 *  address they reach their own install by and say nothing about why. An entry that is more
 *  than a name is refused the same way rather than kept: it matches no header, so keeping it
 *  is a line that silently does nothing, the failure this file must never have. */
function fileHostnames(): string[] | null {
	const value = FILE.allowedHostnames;
	if (value === undefined) return null;
	if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
		CONFIG_ISSUES.push(`"allowedHostnames" in ${CONFIG_PATH} must be a list of names.`);
		return null;
	}
	const names: string[] = [];
	for (const entry of value as string[]) {
		const name = hostnameEntry(entry);
		if (!name) {
			CONFIG_ISSUES.push(
				`"allowedHostnames" in ${CONFIG_PATH} holds ${JSON.stringify(entry)}, which is not a name on its own: no scheme, port or path, just the name.`
			);
			return null;
		}
		names.push(name);
	}
	return names;
}

const FILE_HOST = fileText('host');
const FILE_DATA_DIR = fileText('dataDir');
const FILE_BACKUP_DIR = fileText('backupDir');
const FILE_OPEN_BROWSER = fileBool('openBrowser');

function readPort(): number {
	const fromEnv = process.env.CHUNGUS_PORT;
	if (fromEnv === undefined && FILE.port === undefined) return DEFAULT_PORT;
	// The file's value has to BE a number rather than merely convert to one: `Number()` reads
	// null and "" as a perfectly valid 0 and true as 1, and a 0 here is not a default, it is the
	// OS handing out a different port on every launch with every saved address gone stale.
	const port =
		fromEnv !== undefined
			? fromEnv.trim()
				? Number(fromEnv)
				: NaN
			: typeof FILE.port === 'number'
				? FILE.port
				: NaN;
	// 0 itself is legitimate and asks the OS for a free port; the test suite runs on it.
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		const where = fromEnv !== undefined ? 'CHUNGUS_PORT' : `"port" in ${CONFIG_PATH}`;
		CONFIG_ISSUES.push(`${where} must be a whole number from 0 to 65535.`);
		return DEFAULT_PORT;
	}
	return port;
}

/** Write-then-rename, same reason as security.json and allowlist.json, and a stronger one: this
 *  is the file that says where the data lives, so a torn one stops the next boot with that line
 *  gone. Returns what went wrong, or null. */
function writeConfig(path: string, contents: Record<string, unknown>): string | null {
	const temp = `${path}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(contents, null, 2)}\n`);
		renameSync(temp, path);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Bring the settings file up to date with the settings this build has. A first run writes the
 * whole file, so they are visible to someone who has only a folder and a text editor. A file
 * already there keeps every value in it and gains only the lines it lacks, so a setting added in
 * a later version reaches an install that already exists rather than being one the reader has to
 * hear about somewhere and type in.
 *
 * Three rules make that safe to run over a file somebody has edited:
 *  - A file it cannot read is left byte for byte alone. Rebuilding one from defaults would drop
 *    the line naming where the data lives, and the boot has already refused to start on it.
 *  - A missing setting is written with its DEFAULT, never with the value this launch resolved: an
 *    environment variable outranks the file anyway, and baking one in would hand the next launch
 *    a path that was never meant to outlive the shell that set it.
 *  - Nothing missing means nothing written, so the file is touched once per new setting.
 *
 * What is there is edited rather than rebuilt from a template, so notes, key order and a
 * misspelled key all survive; the boot still names the typo. Only the indentation is normalised.
 */
export function ensureConfigFile(path = CONFIG_PATH): void {
	if (!existsSync(path)) {
		const failure = writeConfig(path, CONFIG_DEFAULTS);
		// Not fatal, and deliberately not silent: with no file the defaults above are exactly
		// what is running, so the launch is sound and only the way to change it is missing.
		if (failure) console.log(`  Could not write ${path}, so the defaults are in force: ${failure}`);
		return;
	}
	let held: unknown;
	try {
		held = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return;
	}
	if (!held || typeof held !== 'object' || Array.isArray(held)) return;
	const settings = held as Record<string, unknown>;
	const missing = SETTING_KEYS.filter((key) => !Object.hasOwn(settings, key));
	if (missing.length === 0) return;
	for (const key of missing) settings[key] = CONFIG_DEFAULTS[key];
	const failure = writeConfig(path, settings);
	console.log(
		failure
			? `  Could not add ${missing.join(', ')} to ${path}: ${failure}`
			: `  Added ${missing.join(', ')} to ${path}.`
	);
}

// Data directory: env override, else the file, else ./user-data under the base dir. Central,
// valuable, backup-able. Exposed as a function because the database binds its path lazily: the
// test suite points CHUNGUS_DATA_DIR at a throwaway dir after modules are already loaded, and an
// import-frozen path would silently send those writes into the real user-data (see
// ServerDatabase in db.ts).
export function resolveDataDir(): string {
	const fromEnv = process.env.CHUNGUS_DATA_DIR;
	if (fromEnv) return resolve(fromEnv);
	return resolve(BASE_DIR, FILE_DATA_DIR ?? DEFAULT_DATA_DIR);
}
export const DATA_DIR = resolveDataDir();

export function resolveDbPath(): string {
	return join(resolveDataDir(), 'chungushub.db');
}

// Where snapshots of the data dir are kept: a SIBLING of it, never inside it. A snapshot
// written into the folder it is snapshotting would carry every snapshot before it, and the
// next one would carry that. `CHUNGUS_BACKUP_DIR` moves it (onto another drive, say) and is
// read per call for the same reason `resolveDataDir` is: the test suite points both env
// vars at throwaway dirs after these modules are already loaded. The directory is created
// by the first snapshot, not here: an install that never backs up grows no empty folder.
export function resolveBackupDir(): string {
	const override = process.env.CHUNGUS_BACKUP_DIR;
	if (override) return resolve(override);
	return resolve(resolveDataDir(), FILE_BACKUP_DIR ?? DEFAULT_BACKUP_DIR);
}

// Per-entity image storage: images/<category>/ with a thumbnails/ subfolder each. The
// relative path stored in the DB (images/<category>/<file>) encodes the category, so
// serving, copying, and deleting all derive it from the path.
export const IMAGES_ROOT = join(DATA_DIR, 'images');
export const IMAGE_CATEGORIES = [
	'characters',
	'personas',
	'backgrounds',
	'chat',
	'presets',
	'lorebooks'
] as const;
export type ImageCategory = (typeof IMAGE_CATEGORIES)[number];

// Files the user attaches to a Chungus Assistant tab as reference material. Read-only for
// their whole life and owned by their `assistant_files` row, so nothing else writes here.
export const ASSISTANT_FILES_ROOT = join(DATA_DIR, 'assistant-files');

export const PRESETS_DIR = join(DATA_DIR, 'presets');
// Per-preset unsaved working copies; live until the user saves or discards.
export const TEMP_PRESETS_DIR = join(PRESETS_DIR, 'temp');
export const ASSISTANT_SKILLS_PATH = join(DATA_DIR, 'assistantSkills.json');
export const ALLOWLIST_PATH = join(DATA_DIR, 'allowlist.json');
// Security switches (allowlist toggle + password hash + sessions). Deleting the
// file restores the defaults. That is the documented lockout recovery.
export const SECURITY_PATH = join(DATA_DIR, 'security.json');

// The built SvelteKit PWA (vite build output).
export const CLIENT_DIR = resolve(join(BASE_DIR, 'build'));

// Bundled default presets shipped with the repo (seeds data/presets on first run).
export const DEFAULT_PRESETS_DIR = resolve(join(BASE_DIR, 'defaults', 'presets'));

// Bundled assistant skills shipped with the repo, one `<id>.json` each in the same
// format an export writes (seeds assistantSkills.json on first read, and backs the
// Defaults browser in Assistant Settings).
export const DEFAULT_SKILLS_DIR = resolve(join(BASE_DIR, 'defaults', 'skills'));

// Bundled example characters shipped with the repo: `<id>.json` plus the pictures under the
// same name (`<id>.<image>` portrait, `<id>/` sprite folder). Seeded into the library ONCE,
// tracked by id, so a character the user deletes is gone for good.
export const DEFAULT_CHARACTERS_DIR = resolve(join(BASE_DIR, 'defaults', 'characters'));

// Bundled workspace background images, served directly from the repo (never copied
// into the data dir; dropping a file in this folder is all it takes to ship one).
export const DEFAULT_BACKGROUNDS_DIR = resolve(join(BASE_DIR, 'defaults', 'backgrounds'));

// Plain HTTP, and only that: a device on the network connects with no certificate
// to install and no warning to click through. Browsers count localhost as a secure
// context, so the host machine still gets the full PWA (installable, clipboard);
// other devices trade those two for having nothing to set up.
// 4242 keeps clear of what this audience already runs: SillyTavern 8000, koboldcpp 5001,
// ComfyUI 8188, Stable Diffusion 7860, Ollama 11434. A collision costs a first launch.
export const PORT = readPort();
export const HOST = process.env.CHUNGUS_HOST ?? FILE_HOST ?? DEFAULT_HOST;

// Whether a launch throws the UI up in the default browser. Only the portable build reads it,
// where the executable IS somebody's whole launch; a machine nobody is sitting at wants it off.
export const OPEN_BROWSER = process.env.CHUNGUS_NO_OPEN ? false : (FILE_OPEN_BROWSER ?? true);

// Names beyond an address, `localhost` and this machine's own that this install may be reached
// by: a Tailscale name, a domain pointed at it through a proxy. Empty for everyone who reaches
// their install the way the docs describe it, which is why it can default to refusing the rest.
export const ALLOWED_HOSTNAMES = fileHostnames() ?? [];

// Only when the file states the key too: an override of something it never mentions confuses
// nobody, while a line somebody edited and watched do nothing is exactly what this is for.
for (const [variable, key] of [
	['CHUNGUS_PORT', 'port'],
	['CHUNGUS_HOST', 'host'],
	['CHUNGUS_DATA_DIR', 'dataDir'],
	['CHUNGUS_BACKUP_DIR', 'backupDir'],
	['CHUNGUS_NO_OPEN', 'openBrowser']
] as const) {
	if (process.env[variable] && FILE[key] !== undefined) {
		CONFIG_OVERRIDES.push(`${variable} is set, so "${key}" in ${CONFIG_PATH} is ignored.`);
	}
}

// IPs seeded as always-allowed via env (comma-separated). Never written to the
// allowlist file, handy for dev or scripted setups.
export const ALLOWLIST_ENV = (process.env.CHUNGUS_ALLOWLIST ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

export function ensureDirs(): void {
	const dirs = [DATA_DIR, PRESETS_DIR, TEMP_PRESETS_DIR, ASSISTANT_FILES_ROOT];
	for (const category of IMAGE_CATEGORIES) {
		dirs.push(join(IMAGES_ROOT, category), join(IMAGES_ROOT, category, 'thumbnails'));
	}
	for (const dir of dirs) {
		mkdirSync(dir, { recursive: true });
	}
	ensurePrivacyMarkers(DATA_DIR, 'data');
}

// Create the data directories at import time so anything that opens a file under
// DATA_DIR (e.g. the SQLite database) finds its parent directory already present.
// Skipped under `bun test`, where this names the real dir no test writes to (each pins
// its own first), so running it would only leave an empty user-data behind in the repo.
// Skipped while a setting is unreadable too: the boot below is about to stop on that, and a
// refused launch must not leave a data folder behind at a path nobody chose.
if (process.env.NODE_ENV !== 'test' && CONFIG_ISSUES.length === 0) ensureDirs();
