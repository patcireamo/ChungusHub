/**
 * Server-side database layer (bun:sqlite).
 *
 * This holds the real SQL. The client calls these methods by name over an HTTP RPC
 * bridge, and the method shapes are kept identical so the client-side DatabaseService
 * stays a thin proxy.
 *
 * Data is central and valuable, so the schema is versioned: each migration runs
 * exactly once, tracked in the _migrations table. No "IF NOT EXISTS" guesswork.
 */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGES_ROOT, resolveDbPath } from './config';
import {
	assistantFileModifiedAt,
	deleteAssistantFileText,
	deleteImage,
	listAssistantFileNames
} from './files';
import type { SyncScope } from '../shared/sync';
import type { AssistantFile } from '../shared/assistant-files';

/** Short stable digest, the chat-tree fingerprint's building block. Truncated SHA-1:
 *  64 bits is far past what "are these two chats the same" needs, and it only ever
 *  compares chats that already collided on a count+length signature. */
function shortDigest(value: string): string {
	return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

/**
 * The one case fold the chat search runs, applied IDENTICALLY in SQL (to narrow) and
 * in JS (to decide). Two rules, both deliberate:
 *
 *  - The dotted/dotless i family. Unicode pairs only I↔i, so without folding all four
 *    forms onto 'i' a search for "kapı" silently misses "KAPI", the same reason the
 *    client's `buildSearchRegex` carries `[iıIİ]` (src/lib/utils/chat-search.ts).
 *  - Case folding stops at ASCII + the five letters below, because
 *    SQLite's LOWER() is ASCII-only. Folding further in JS would make the decider
 *    accept rows the SQL narrowing already threw away, i.e. results that depend on
 *    which term happened to be longest. Consistent beats clever here.
 *
 * Every replacement is one character for one character, so an index found in the
 * folded text points at the same offset in the original, which is what lets the
 * snippet window be cut from the untouched content.
 */
const SEARCH_FOLD: [string, string][] = [
	['İ', 'i'],
	['I', 'i'],
	['ı', 'i'],
	['Ç', 'ç'],
	['Ğ', 'ğ'],
	['Ö', 'ö'],
	['Ş', 'ş'],
	['Ü', 'ü']
];

function foldSearchText(value: string): string {
	let out = value;
	for (const [from, to] of SEARCH_FOLD) out = out.split(from).join(to);
	return out.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The SQL twin of foldSearchText, wrapped around a column expression. */
function foldSearchSql(expr: string): string {
	return SEARCH_FOLD.reduce((acc, [from, to]) => `REPLACE(${acc}, '${from}', '${to}')`, `LOWER(${expr})`);
}

/** Neutralize LIKE wildcards in a user-typed needle (paired with ESCAPE '\'). */
function escapeLike(value: string): string {
	return value.replace(/([\\%_])/g, '\\$1');
}

/** A readable window of `content` around `at`, ellipsized on whichever side is cut. */
function snippetAround(content: string, at: number, radius = 90): string {
	if (at < 0) return content.slice(0, radius * 2).trim();
	const start = Math.max(0, at - radius);
	const end = Math.min(content.length, at + radius);
	return `${start > 0 ? '…' : ''}${content.slice(start, end).trim()}${end < content.length ? '…' : ''}`;
}

/**
 * Words in a message, for the stats aggregate: runs separated by whitespace, and nothing
 * cleverer. Roleplay prose is asterisks, quotes and two languages at once, so any rule that
 * tried to strip punctuation or split on letters would answer differently per language while
 * claiming to be the same figure. This one is the count a person gets by eye, it is the same
 * rule in every language, and it is the only word rule in the app.
 */
function countWords(content: string): number {
	const trimmed = content.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Read a JSON column that the server only carries, never interprets. A cell that will not
 * parse reads as absent instead of throwing: these columns hold records ABOUT a row rather
 * than the row itself, and one corrupt cell must never cost the reader everything the query
 * was for (`getMessagesByChat` maps a whole transcript in one pass).
 */
function parseJsonColumn(value: unknown): unknown {
	if (typeof value !== 'string' || !value) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

/**
 * The activity series' bucket width. Fifteen minutes because every real-world UTC offset is
 * a multiple of it, so a client folding these buckets into ITS local days never has to split
 * one. Widen this and readers on a half-hour offset get their late-night messages filed
 * under the wrong day.
 */
const QUARTER_HOUR_MS = 15 * 60 * 1000;

/**
 * The greetings a chat opens on, in seed order: First Message, then every alternate.
 *
 * Exported because the assistant's `create_chat` replica seeds a chat from this same list
 * and `refreshSeededGreetings` recognises a chat by the rows that seeding lays down: one
 * server-side answer, so the two can never disagree about what a chat's opening is. The
 * client's `chatStore.seedCharacterGreetings` is the third builder and the one that cannot
 * import this (architecture/chat-sessions.md coupling 12).
 */
export function chatGreetingsOf(data: unknown): string[] {
	const held = (data ?? {}) as { traits?: { firstMessage?: unknown }; alternateGreetings?: unknown };
	const alternates = Array.isArray(held.alternateGreetings) ? held.alternateGreetings : [];
	return [held.traits?.firstMessage, ...alternates]
		.map((greeting) => (typeof greeting === 'string' ? greeting.trim() : ''))
		.filter((greeting) => greeting.length > 0);
}

interface Migration {
	version: number;
	name: string;
	sql: string;
}

/**
 * One attached file as STORED: the shape both sides speak (shared/assistant-files.ts) plus
 * the one field only this side may know. The path never leaves the server: a file is
 * addressed by id everywhere else, so neither the model nor the client can name a location
 * on disk.
 */
export interface AssistantFileRow extends AssistantFile {
	textPath: string;
}

interface AssistantFileDbRow {
	id: string;
	session_id: string;
	message_id: string | null;
	name: string;
	kind: string;
	bytes: number;
	lines: number;
	token_estimate: number;
	text_path: string;
	created_at: number;
}

function assistantFileFromRow(r: AssistantFileDbRow): AssistantFileRow {
	return {
		id: r.id,
		sessionId: r.session_id,
		messageId: r.message_id,
		name: r.name,
		kind: r.kind,
		bytes: r.bytes,
		lines: r.lines,
		tokenEstimate: r.token_estimate,
		textPath: r.text_path,
		createdAt: r.created_at
	};
}

/**
 * The whole schema as one baseline. Every change from here is a migration appended after
 * it, and a database already carrying the baseline runs only what is newer than itself.
 *
 * Its version is the number the schema stands at rather than 1, which is what makes an
 * older database fail safely: numbered 1 the baseline would read as already applied and the
 * app would run against a schema missing half its columns. Numbered where it stands it
 * reads as missing instead, its CREATEs collide with the tables already there, and the boot
 * fails where the failure can be seen.
 */
const MIGRATIONS: Migration[] = [
	{
		version: 42,
		name: 'initial_schema',
		sql: `
		CREATE TABLE chats (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL DEFAULT 'New Chat',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			root_message_id TEXT,
			active_leaf_id TEXT,
			settings_json TEXT,
			character_id TEXT,
			-- The tip of the path marked as canon, which the story map draws as its spine.
			canon_leaf_id TEXT,
			character_version_id TEXT,
			-- Steering and the impersonate perspective, as an opaque JSON blob the server never
			-- parses. A corrupt value degrades client-side rather than failing the chat read,
			-- the same contract the settings table holds.
			feature_state TEXT,
			is_favorite INTEGER NOT NULL DEFAULT 0,
			-- The greeting texts the card put here when the chat was created. A chat still
			-- holding exactly these and nothing else is a mirror of the card, so an edit to the
			-- card reaches it. NULL is no claim: an imported chat is a story by definition.
			seeded_greetings TEXT
		);

		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			chat_id TEXT NOT NULL,
			parent_id TEXT,
			role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
			content TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			edited_at INTEGER,
			model TEXT,
			provider TEXT,
			tokens_prompt INTEGER,
			tokens_completion INTEGER,
			finish_reason TEXT,
			sibling_index INTEGER NOT NULL DEFAULT 0,
			thinking TEXT,
			-- The persona this turn was sent with, locked at send time. The active persona is
			-- global, so without it every past message re-attributes itself to the latest one.
			persona_id TEXT,
			-- { name, color } naming the divergent path this message heads.
			branch_label TEXT,
			attachments_json TEXT,
			generation_ms INTEGER,
			-- A typo fix does not advance edited_at, which memory reads as its staleness
			-- signal, so the touch is recorded here instead and the transcript still marks it.
			minor_edited_at INTEGER,
			sprite_label TEXT,
			first_token_ms INTEGER,
			reasoning_ms INTEGER,
			-- What the lorebook scan decided for the generation behind this turn: what reached
			-- the prompt, which keys pulled it in, and why an entry that could have fired did
			-- not. It hangs on the turn because a swipe is its own generation with its own rolls.
			lore_json TEXT,
			FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
			FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE SET NULL
		);
		CREATE INDEX idx_messages_parent ON messages(parent_id);
		CREATE INDEX idx_messages_chat ON messages(chat_id);

		CREATE TABLE settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE character_library (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL CHECK (type IN ('character', 'persona')),
			data_json TEXT NOT NULL,
			is_favorite INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE INDEX idx_character_library_type ON character_library(type);

		-- Named character variants. The entry's own data_json stays the ACTIVE variant's
		-- content, mirrored on every save, so every reader of the library works untouched.
		CREATE TABLE character_versions (
			id TEXT PRIMARY KEY,
			entry_id TEXT NOT NULL,
			name TEXT NOT NULL,
			data_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (entry_id) REFERENCES character_library(id) ON DELETE CASCADE
		);
		CREATE INDEX idx_character_versions_entry ON character_versions(entry_id);

		-- Standalone, so a book can be shared across entries, exported and re-imported on its
		-- own. Characters and personas link to one by id (data.lorebookIds).
		CREATE TABLE lorebooks (
			id TEXT PRIMARY KEY,
			data_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE INDEX idx_lorebooks_updated_at ON lorebooks(updated_at DESC);

		-- One note applies app-wide, to a character, to a single character version or to one
		-- chat. scope/scope_id are real columns so a chat delete can reap its own notes and a
		-- scope lookup is an index hit; no FK, since scope_id names a different table per
		-- scope and a dangling id is inert by design.
		CREATE TABLE steering_notes (
			id TEXT PRIMARY KEY,
			scope TEXT NOT NULL,
			scope_id TEXT,
			data_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE INDEX idx_steering_notes_scope ON steering_notes(scope, scope_id);

		CREATE TABLE memory_state (
			chat_id TEXT PRIMARY KEY,
			enabled INTEGER NOT NULL DEFAULT 0,
			config_json TEXT,
			updated_at INTEGER NOT NULL,
			-- 1 folds new turns into memory after each reply, 0 only on Process. It gates the
			-- extraction passes alone: branch-consistency roll-backs always run.
			auto_extract INTEGER NOT NULL DEFAULT 1,
			FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
		);

		-- The whole memory store. The archive boundary is deliberately not a column: it is
		-- derived on every read by tiling the active path with these episodes' own coverage,
		-- which is what lets the same rows answer differently on a branch.
		CREATE TABLE memory_episodes (
			id TEXT PRIMARY KEY,
			chat_id TEXT NOT NULL,
			layer INTEGER NOT NULL DEFAULT 0,
			content TEXT NOT NULL,
			source_message_ids TEXT,
			anchor_message_id TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
		);
		CREATE INDEX idx_memory_episodes_chat ON memory_episodes(chat_id, layer, created_at);

		CREATE TABLE assistant_sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL DEFAULT 'New session',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			-- The full tool-calling conversation the assistant replays each turn, so it
			-- remembers what it found and did. Separate from the transcript below.
			context_json TEXT,
			chat_id TEXT,
			-- The Assistant settings this session runs under, frozen at its first turn: they
			-- sit in the system prompt, so reading them live would re-price the conversation
			-- every time a setting moved.
			settings_json TEXT
		);

		CREATE TABLE assistant_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
			content TEXT NOT NULL,
			actions_json TEXT,
			error TEXT,
			created_at INTEGER NOT NULL,
			steps_json TEXT,
			usage_json TEXT,
			images_json TEXT,
			-- The row is written WHILE the turn runs, so it can outlive the process writing
			-- it: boot flips anything left running to interrupted, and durable tool effects
			-- are never left without a transcript naming them.
			status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('running', 'done', 'interrupted')),
			attachments_json TEXT,
			FOREIGN KEY (session_id) REFERENCES assistant_sessions(id) ON DELETE CASCADE
		);
		CREATE INDEX idx_assistant_messages_session ON assistant_messages(session_id, created_at);

		-- Files attached to an Assistant tab as reference material, read-only for their whole
		-- life, which is what makes a line number a permanent address. A file staged in the
		-- composer and never sent has message_id NULL, and that is the set the boot sweep acts on.
		CREATE TABLE assistant_files (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_id TEXT,
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			bytes INTEGER NOT NULL,
			lines INTEGER NOT NULL,
			token_estimate INTEGER NOT NULL,
			-- The readable, normalized text, and the ONLY thing kept: it is what the
			-- assistant reads and what the viewer shows, the upload itself is still on the
			-- user's own disk, and a second stored copy of a 10 MB file would buy nothing.
			text_path TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES assistant_sessions(id) ON DELETE CASCADE,
			FOREIGN KEY (message_id) REFERENCES assistant_messages(id) ON DELETE CASCADE
		);
		CREATE INDEX idx_assistant_files_session ON assistant_files(session_id, created_at);

		-- Unsent composer text, one row per chat, so a draft follows the user across devices.
		CREATE TABLE chat_drafts (
			chat_id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
		);

		-- The composer's recall history, deliberately tied to neither messages nor chats:
		-- recall has to survive a message being deleted or its whole chat going away.
		CREATE TABLE input_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chat_id TEXT,
			content TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);

		-- One row per named connection, so two connections can hit the same provider with
		-- different keys.
		CREATE TABLE connection_credentials (
			connection_id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			api_key_encrypted TEXT NOT NULL,
			base_url TEXT,
			updated_at INTEGER NOT NULL
		);

		-- The prompt debug log, durable so it survives a restart and reaches devices that
		-- connect later. The entry is opaque JSON only server/promptLog.ts touches, and the
		-- cap prune on insert bounds it rather than anything here.
		CREATE TABLE prompt_log (
			id TEXT PRIMARY KEY,
			started_at INTEGER NOT NULL,
			entry TEXT NOT NULL
		);
		CREATE INDEX idx_prompt_log_started_at ON prompt_log(started_at);

		-- Every source file an import has already brought over, so running the same folder
		-- again adds what is new and duplicates nothing, which is also what makes a stopped
		-- import resumable with no resume machinery. The key is the path inside the picked
		-- folder namespaced by format, never a hash: a card edited on the other side is the
		-- same character arriving twice. entity_id is what the file became, NULL for the
		-- kinds nothing points back at.
		CREATE TABLE import_sources (
			source_key TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			entity_id TEXT
		);
		`
	}
];

/** The newest schema this build can produce. A snapshot recording a higher one was written
 *  by a newer app and cannot be restored here, since migrations only ever run forward. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/**
 * Exported for the two tests that need a schema without booting a server: `schema-upgrade.test.ts`,
 * which holds every migration to what a migration is allowed to do, and `backup/backup.test.ts`,
 * which needs real tables to snapshot. Nothing else may import this.
 */
export const MIGRATIONS_FOR_TESTS: readonly Migration[] = MIGRATIONS;

/**
 * The schema version of the database file as it sits on disk, read through a throwaway
 * read-only connection so nothing has to open the live handle first. That ordering is the
 * whole reason it exists: the pre-upgrade snapshot has to be taken BEFORE `serverDb.open()`,
 * and opening is what runs the very migrations the snapshot exists to protect against.
 *
 * 0 means there is nothing to protect: no file, or a file no migration has touched yet.
 */
export function schemaVersionOnDisk(): number {
	const path = resolveDbPath();
	if (!existsSync(path)) return 0;
	let probe: Database | null = null;
	try {
		probe = new Database(path, { readonly: true });
		const row = probe.query('SELECT MAX(version) AS v FROM _migrations').get() as {
			v: number | null;
		} | null;
		return row?.v ?? 0;
	} catch {
		// No `_migrations` table, so no applied schema to snapshot. A file that is broken
		// rather than young says so loudly moments later, when open() runs for real.
		return 0;
	} finally {
		probe?.close();
	}
}

class ServerDatabase {
	private _db: Database | null = null;

	/**
	 * Opened on first use, resolving the data dir from the env at that moment rather than
	 * at import time. Import order must not decide which database file this process
	 * writes: test files load server modules in arbitrary order and pin
	 * CHUNGUS_DATA_DIR to a throwaway dir before their first db call, and a path frozen
	 * at import would silently point those writes at the real user-data instead.
	 * The server calls open() at boot so a broken database still fails at startup.
	 */
	private get db(): Database {
		if (!this._db) {
			this._db = new Database(resolveDbPath(), { create: true });
			this._db.exec('PRAGMA journal_mode = WAL');
			this._db.exec('PRAGMA foreign_keys = ON');
			this.runMigrations();
		}
		return this._db;
	}

	/** Force the lazy handle open now (fail-fast at server boot). */
	open(): void {
		void this.db;
	}

	/**
	 * Release the handle so the next use reopens against whatever CHUNGUS_DATA_DIR names
	 * then. One process holds one database, so a test file that pins its own throwaway dir
	 * calls this in beforeAll to bind to it, and in afterAll before deleting the dir: an
	 * open handle over a deleted file fails every later statement in the run with
	 * SQLITE_IOERR_VNODE, in whichever file happens to run next.
	 *
	 * Not a shutdown hook. Calling it under a live server faults whatever is mid-statement.
	 */
	closeForTests(): void {
		this._db?.close();
		this._db = null;
	}

	/** Highest migration applied to the open database. */
	schemaVersion(): number {
		const row = this.db.query('SELECT MAX(version) AS v FROM _migrations').get() as {
			v: number | null;
		} | null;
		return row?.v ?? 0;
	}

	/**
	 * What has been made since a moment, for the restore confirmation to state in real
	 * numbers. Messages are counted beside chats and characters because they are the actual
	 * work: a restore that costs "1 chat" can cost four hours of writing inside it.
	 *
	 * Deliberately not bridged: the only caller is the restore path, in this process.
	 */
	createdSince(at: number): { chats: number; messages: number; characters: number } {
		const one = (sql: string): number => (this.db.query(sql).get(at) as { n: number }).n;
		return {
			chats: one('SELECT COUNT(*) AS n FROM chats WHERE created_at > ?'),
			messages: one('SELECT COUNT(*) AS n FROM messages WHERE created_at > ?'),
			characters: one(
				"SELECT COUNT(*) AS n FROM character_library WHERE created_at > ? AND type = 'character'"
			)
		};
	}

	private runMigrations(): void {
		this.db.exec(
			'CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)'
		);
		const appliedRows = this.db.query('SELECT version FROM _migrations').all() as { version: number }[];
		const applied = new Set(appliedRows.map((r) => r.version));

		for (const migration of MIGRATIONS.sort((a, b) => a.version - b.version)) {
			if (applied.has(migration.version)) continue;
			console.log(`[db] applying migration ${migration.version}: ${migration.name}`);
			const tx = this.db.transaction(() => {
				this.db.exec(migration.sql);
				this.db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [
					migration.version,
					migration.name,
					Date.now()
				]);
			});
			tx();
		}
	}

	private select<T>(sql: string, params: unknown[] = []): T {
		return this.db.query(sql).all(...(params as never[])) as T;
	}

	private execute(sql: string, params: unknown[] = []): void {
		this.db.query(sql).run(...(params as never[]));
	}

	/** Row-at-a-time read, for the one caller that has to touch every message body in the
	 *  database (`getUserStats`). `select` would materialise the whole table first, which
	 *  on a large library means holding every message in memory at once to produce a
	 *  handful of numbers. Reach for it only when the pass is genuinely whole-table. */
	private selectIter<T>(sql: string, params: unknown[] = []): IterableIterator<T> {
		return this.db.query(sql).iterate(...(params as never[])) as IterableIterator<T>;
	}

	/** Run several writes atomically: any throw rolls back everything. Nests via
	 *  savepoints, so callees that open their own transaction stay safe inside. */
	inTransaction<T>(fn: () => T): T {
		return this.db.transaction(fn)();
	}

	// ===== MAPPERS (DB rows -> camelCase domain objects the client expects) =====

	private mapChat(row: Record<string, unknown>): unknown {
		return {
			id: row.id,
			title: row.title,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			rootMessageId: row.root_message_id,
			activeLeafId: row.active_leaf_id,
			canonLeafId: row.canon_leaf_id ?? null,
			settings: row.settings_json ? JSON.parse(row.settings_json as string) : null,
			characterId: row.character_id ?? null,
			characterVersionId: row.character_version_id ?? null,
			isFavorite: !!row.is_favorite,
			// Opaque, deliberately NOT JSON.parsed here (unlike settings/branchLabel
			// above): a corrupt blob must not fail this row's read (and getAllChats maps
			// every chat in one query, so it must not fail ALL of them either). The
			// client's normalizeChatFeatureState is the only reader.
			featureState: row.feature_state ?? null
		};
	}

	private mapMessage(row: Record<string, unknown>): unknown {
		return {
			id: row.id,
			chatId: row.chat_id,
			parentId: row.parent_id,
			role: row.role,
			content: row.content,
			personaId: row.persona_id ?? null,
			branchLabel: row.branch_label ? JSON.parse(row.branch_label as string) : null,
			thinking: row.thinking ?? null,
			attachments: row.attachments_json ? JSON.parse(row.attachments_json as string) : null,
			createdAt: row.created_at,
			editedAt: row.edited_at,
			minorEditedAt: row.minor_edited_at ?? null,
			spriteLabel: row.sprite_label ?? null,
			model: row.model,
			provider: row.provider,
			tokensPrompt: row.tokens_prompt,
			tokensCompletion: row.tokens_completion,
			finishReason: row.finish_reason,
			generationMs: row.generation_ms,
			firstTokenMs: row.first_token_ms ?? null,
			reasoningMs: row.reasoning_ms ?? null,
			// Parsed defensively: this is a debug record, and a corrupt cell must never cost
			// the reader the transcript it is attached to. A row that will not parse reads as
			// a turn nobody traced.
			lorebook: parseJsonColumn(row.lore_json),
			siblingIndex: row.sibling_index
		};
	}

	// ===== CHATS =====

	getAllChats(): unknown[] {
		const rows = this.select<Record<string, unknown>[]>(
			'SELECT * FROM chats ORDER BY updated_at DESC'
		);
		return rows.map((r) => this.mapChat(r));
	}

	getChat(id: string): unknown {
		const rows = this.select<Record<string, unknown>[]>('SELECT * FROM chats WHERE id = ?', [id]);
		return rows[0] ? this.mapChat(rows[0]) : null;
	}

	insertChat(chat: {
		id: string;
		title: string;
		createdAt: number;
		updatedAt: number;
		rootMessageId: string | null;
		activeLeafId: string | null;
		canonLeafId?: string | null;
		settings: unknown;
		characterId?: string | null;
		characterVersionId?: string | null;
		isFavorite?: boolean;
	}): void {
		this.execute(
			`INSERT INTO chats (id, title, created_at, updated_at, root_message_id, active_leaf_id, canon_leaf_id, settings_json, character_id, character_version_id, is_favorite)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				chat.id,
				chat.title,
				chat.createdAt,
				chat.updatedAt,
				chat.rootMessageId,
				chat.activeLeafId,
				chat.canonLeafId ?? null,
				chat.settings ? JSON.stringify(chat.settings) : null,
				chat.characterId ?? null,
				chat.characterVersionId ?? null,
				chat.isFavorite ? 1 : 0
			]
		);
	}

	/** Star/unstar a chat. Never touches updated_at: favoriting is bookkeeping, not
	 *  activity, and must not reshuffle an activity-sorted list under the user. */
	updateChatFavorite(chatId: string, isFavorite: boolean): void {
		this.execute('UPDATE chats SET is_favorite = ? WHERE id = ?', [isFavorite ? 1 : 0, chatId]);
	}

	/**
	 * Deep-copy a chat into a new one and return its id. Whole thing in one transaction:
	 * a half-copied story is worse than none.
	 *
	 * What rides along, and why: the entire message forest (every swipe, alternate
	 * greeting and abandoned fork; a copy of only the read branch is a different
	 * story), branch labels, the canon and active-leaf pointers, the pinned character
	 * version, and the feature state (steering + impersonate). Message timestamps are
	 * kept so the transcript reads identically; the chat's OWN created/updated are
	 * stamped now, because the copy is a new thing in the list. Attachment paths are
	 * copied verbatim: chat images are reference-counted (see dropOrphanedChatImages),
	 * so two rows sharing one file is the designed state, not a leak.
	 *
	 * Deliberately NOT copied: the favorite flag (a star is about the original) and the
	 * composer draft (unsent text belongs to where it was typed). Memory is opt-in:
	 * the caller asks the user first, see getChatMemoryFootprint.
	 */
	duplicateChat(options: { chatId: string; title: string; includeMemory: boolean }): string {
		const { chatId, title, includeMemory } = options;
		return this.inTransaction(() => {
			const source = this.select<Record<string, unknown>[]>('SELECT * FROM chats WHERE id = ?', [chatId])[0];
			if (!source) throw new Error(`duplicateChat: no chat with id ${chatId}`);

			const rows = this.select<Record<string, unknown>[]>('SELECT * FROM messages WHERE chat_id = ?', [chatId]);
			const idMap = new Map<string, string>();
			for (const row of rows) idMap.set(row.id as string, randomUUID());
			const remap = (id: unknown): string | null => (typeof id === 'string' ? (idMap.get(id) ?? null) : null);

			const newChatId = randomUUID();
			const now = Date.now();
			// Chat row first (messages.chat_id is a real FK), its pointers last, the same
			// ordering createChat -> seedCharacterGreetings uses, for the same reason.
			this.execute(
				`INSERT INTO chats (id, title, created_at, updated_at, root_message_id, active_leaf_id, canon_leaf_id, settings_json, character_id, character_version_id, feature_state, seeded_greetings, is_favorite)
				 VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 0)`,
				[
					newChatId,
					title,
					now,
					now,
					source.settings_json ?? null,
					source.character_id ?? null,
					source.character_version_id ?? null,
					source.feature_state ?? null,
					// The copy holds the same rows, so it holds the same claim: a duplicate of a
					// chat nobody has written in is one too, and follows the card just like it.
					source.seeded_greetings ?? null
				]
			);

			// Parent-first: messages.parent_id is a real FK, so a child can never land
			// before its parent. BFS from the roots reaches every node exactly once.
			const children = new Map<string | null, Record<string, unknown>[]>();
			for (const row of rows) {
				const key = (row.parent_id as string | null) ?? null;
				const bucket = children.get(key);
				if (bucket) bucket.push(row);
				else children.set(key, [row]);
			}
			const queue = [...(children.get(null) ?? [])];
			let copied = 0;
			while (queue.length) {
				const row = queue.shift()!;
				copied += 1;
				this.execute(
					`INSERT INTO messages
					 (id, chat_id, parent_id, role, content, persona_id, branch_label, thinking, attachments_json, created_at, edited_at, minor_edited_at, sprite_label,
					  model, provider, tokens_prompt, tokens_completion, finish_reason, generation_ms, first_token_ms, reasoning_ms, lore_json, sibling_index)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						idMap.get(row.id as string),
						newChatId,
						remap(row.parent_id),
						row.role,
						row.content,
						row.persona_id ?? null,
						row.branch_label ?? null,
						row.thinking ?? null,
						row.attachments_json ?? null,
						row.created_at,
						row.edited_at ?? null,
						row.minor_edited_at ?? null,
						row.sprite_label ?? null,
						row.model ?? null,
						row.provider ?? null,
						row.tokens_prompt ?? null,
						row.tokens_completion ?? null,
						row.finish_reason ?? null,
						row.generation_ms ?? null,
						row.first_token_ms ?? null,
						row.reasoning_ms ?? null,
						row.lore_json ?? null,
						row.sibling_index
					]
				);
				queue.push(...(children.get(row.id as string) ?? []));
			}
			// Every row must be reachable from a root (a deleted parent NULLs its children
			// into roots, so it always is). If that ever stops holding, a silent partial
			// copy would look like a successful one. Refuse instead.
			if (copied !== rows.length) {
				throw new Error(`duplicateChat: ${rows.length - copied} message(s) unreachable from a root in chat ${chatId}`);
			}

			this.execute(
				'UPDATE chats SET root_message_id = ?, active_leaf_id = ?, canon_leaf_id = ? WHERE id = ?',
				[remap(source.root_message_id), remap(source.active_leaf_id), remap(source.canon_leaf_id), newChatId]
			);

			// Chat-scoped steering notes are part of what makes the copy the same story:
			// each is re-minted under a fresh id, bound to the new chat. Notes at the
			// global/character/version scopes are untouched: they already apply to the
			// copy through their own binding, and copying them would double-inject.
			const notes = this.select<{ id: string; data_json: string; created_at: number; updated_at: number }[]>(
				"SELECT * FROM steering_notes WHERE scope = 'chat' AND scope_id = ?",
				[chatId]
			);
			for (const note of notes) {
				this.execute(
					"INSERT INTO steering_notes (id, scope, scope_id, data_json, created_at, updated_at) VALUES (?, 'chat', ?, ?, ?, ?)",
					[randomUUID(), newChatId, note.data_json, note.created_at, note.updated_at]
				);
			}

			if (includeMemory) this.copyChatMemory(chatId, newChatId, idMap);
			return newChatId;
		});
	}

	/** Carry a chat's memory across to a duplicate. Every message reference is remapped
	 *  through the same map the message copy used, and episode cross-references through
	 *  their own fresh-id map: memory still pointing at the original's rows would resolve
	 *  its coverage against a tree it no longer belongs to. Runs inside duplicateChat's
	 *  transaction. */
	private copyChatMemory(fromChatId: string, toChatId: string, messageIds: Map<string, string>): void {
		// A reference that doesn't remap means the source's memory points at a message that
		// no longer exists, a real state but a transient one: the source heals it the next
		// time the chat is opened and the dead episode is reaped (architecture/memory.md). Quietly
		// dropping those references would NOT reproduce it, it would invent a different
		// state that happens to be internally valid and can therefore never heal: an episode
		// whose coverage silently shrank still claims the turns it lost. Refuse instead, and
		// let the caller tell the user to open the chat once (or copy the story alone).
		//
		// This gate is right for MESSAGE references and only for them. A column naming rows
		// the promotion deletes in its own transaction is dangling by construction, so
		// sending one through here would fail every copy of a chat past its first promotion.
		const remapMsgId = (id: string): string => {
			const mapped = messageIds.get(id);
			if (!mapped) throw new Error('mem-copy-stale: memory points at a message that is gone');
			return mapped;
		};
		const remapMsg = (id: unknown): string | null => (typeof id === 'string' ? remapMsgId(id) : null);
		const remapMsgList = (json: unknown): string | null => {
			if (typeof json !== 'string') return null;
			const parsed = JSON.parse(json) as unknown;
			if (!Array.isArray(parsed)) return null;
			return JSON.stringify(parsed.filter((id): id is string => typeof id === 'string').map(remapMsgId));
		};

		const state = this.select<Record<string, unknown>[]>('SELECT * FROM memory_state WHERE chat_id = ?', [fromChatId])[0];
		if (state) {
			this.execute(
				'INSERT INTO memory_state (chat_id, enabled, config_json, updated_at, auto_extract) VALUES (?, ?, ?, ?, ?)',
				[toChatId, state.enabled, state.config_json ?? null, Date.now(), state.auto_extract]
			);
		}

		// ORDER BY rowid: the copy's rows are re-inserted in the order they come back, and
		// memListEpisodes breaks created_at ties by rowid, so reading in index order would
		// silently re-order same-millisecond rows in the copy (architecture/memory.md coupling 6:
		// insertion order must survive ties).
		const episodes = this.select<Record<string, unknown>[]>('SELECT * FROM memory_episodes WHERE chat_id = ? ORDER BY rowid', [fromChatId]);
		for (const episode of episodes) {
			this.execute(
				`INSERT INTO memory_episodes (id, chat_id, layer, content, source_message_ids, anchor_message_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					toChatId,
					episode.layer,
					episode.content,
					remapMsgList(episode.source_message_ids),
					remapMsg(episode.anchor_message_id),
					episode.created_at
				]
			);
		}
	}

	updateChat(chat: Record<string, unknown> & { id: string }, options: { touchUpdatedAt?: boolean } = {}): void {
		const { touchUpdatedAt = false } = options;
		const updates: string[] = [];
		const values: unknown[] = [];

		if (chat.title !== undefined) {
			updates.push('title = ?');
			values.push(chat.title);
		}
		if (chat.rootMessageId !== undefined) {
			updates.push('root_message_id = ?');
			values.push(chat.rootMessageId);
		}
		if (chat.activeLeafId !== undefined) {
			updates.push('active_leaf_id = ?');
			values.push(chat.activeLeafId);
		}
		if (chat.canonLeafId !== undefined) {
			updates.push('canon_leaf_id = ?');
			values.push(chat.canonLeafId ?? null);
		}
		if (chat.settings !== undefined) {
			updates.push('settings_json = ?');
			values.push(chat.settings ? JSON.stringify(chat.settings) : null);
		}
		if (chat.characterId !== undefined) {
			updates.push('character_id = ?');
			values.push(chat.characterId ?? null);
		}
		if (chat.characterVersionId !== undefined) {
			updates.push('character_version_id = ?');
			values.push(chat.characterVersionId ?? null);
		}
		if (chat.featureState !== undefined) {
			// Opaque passthrough, like settings.value: the caller already sends a
			// JSON string (or null); this never parses or re-serializes it.
			updates.push('feature_state = ?');
			values.push(chat.featureState ?? null);
		}

		if (touchUpdatedAt) {
			updates.push('updated_at = ?');
			values.push(Date.now());
		}
		if (updates.length === 0) return;
		values.push(chat.id);

		this.execute(`UPDATE chats SET ${updates.join(', ')} WHERE id = ?`, values);
	}

	updateChatActiveLeaf(chatId: string, leafId: string | null, options: { touchUpdatedAt?: boolean } = {}): void {
		const { touchUpdatedAt = false } = options;
		if (touchUpdatedAt) {
			this.execute('UPDATE chats SET active_leaf_id = ?, updated_at = ? WHERE id = ?', [
				leafId,
				Date.now(),
				chatId
			]);
			return;
		}
		this.execute('UPDATE chats SET active_leaf_id = ? WHERE id = ?', [leafId, chatId]);
	}

	touchChatActivity(chatId: string): void {
		this.execute('UPDATE chats SET updated_at = ? WHERE id = ?', [Date.now(), chatId]);
	}

	// ===== Chat image attachments (files under images/chat/) =====
	//
	// A deleted chat, message, or assistant session must leave nothing behind on disk: the
	// user deleted it, so its pictures are gone too. Two rules make that safe.
	//
	//  1. Reference counting. Branching or forking a message COPIES its attachment list,
	//     so several rows can point at one file. A file dies only once NO message and no
	//     assistant message references it any more, checked AFTER the rows are gone.
	//  2. images/chat/ only. Character and persona art lives in its own folder and is
	//     always a copy (see edit_character_images), never an alias of a chat attachment.
	//     This sweep refuses to touch anything outside images/chat/, so deleting a chat
	//     can never blank a portrait that came from it.

	/** The image paths one attachments_json / images_json blob references. */
	private imagePathsIn(json: string | null): string[] {
		if (!json) return [];
		const parsed = JSON.parse(json) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((item) => (typeof item === 'string' ? item : (item as { kind?: string; path?: string })?.path))
			.filter((p): p is string => typeof p === 'string' && p.length > 0);
	}

	private imagePathsOfChat(chatId: string): string[] {
		const rows = this.select<{ attachments_json: string | null }[]>('SELECT attachments_json FROM messages WHERE chat_id = ?', [chatId]);
		return rows.flatMap((r) => this.imagePathsIn(r.attachments_json));
	}

	private imagePathsOfMessages(messageIds: string[]): string[] {
		if (!messageIds.length) return [];
		const holes = messageIds.map(() => '?').join(', ');
		const rows = this.select<{ attachments_json: string | null }[]>(`SELECT attachments_json FROM messages WHERE id IN (${holes})`, messageIds);
		return rows.flatMap((r) => this.imagePathsIn(r.attachments_json));
	}

	private imagePathsOfAssistantSession(sessionId: string): string[] {
		const rows = this.select<{ images_json: string | null }[]>('SELECT images_json FROM assistant_messages WHERE session_id = ?', [sessionId]);
		return rows.flatMap((r) => this.imagePathsIn(r.images_json));
	}

	/** Ids of a message and everything under it, so their files can be collected first. */
	private descendantIds(messageId: string, includeSelf: boolean): string[] {
		const seed = includeSelf ? 'SELECT id FROM messages WHERE id = ?' : 'SELECT id FROM messages WHERE parent_id = ?';
		const rows = this.select<{ id: string }[]>(
			`WITH RECURSIVE descendants AS (
				${seed}
				UNION ALL
				SELECT m.id FROM messages m
				INNER JOIN descendants d ON m.parent_id = d.id
			)
			SELECT id FROM descendants`,
			[messageId]
		);
		return rows.map((r) => r.id);
	}

	/** Deletes every candidate file no surviving row points at. Call AFTER the rows are gone. */
	private dropOrphanedChatImages(paths: string[]): void {
		for (const path of new Set(paths)) {
			// The one folder this sweep owns. Entry art is never reachable from here.
			if (!path.startsWith('images/chat/')) continue;
			// Escape LIKE wildcards so a path containing % or _ can't false-match another
			// row (which would leak the file). Paths are server-generated UUIDs today,
			// but the sweep must not depend on that staying true.
			const escaped = path.replace(/([\\%_])/g, '\\$1');
			const needle = `%"${escaped}"%`;
			const inMessages = this.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM messages WHERE attachments_json LIKE ? ESCAPE '\\'", [needle])[0]?.n ?? 0;
			if (inMessages > 0) continue;
			const inAssistant = this.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM assistant_messages WHERE images_json LIKE ? ESCAPE '\\'", [needle])[0]?.n ?? 0;
			if (inAssistant > 0) continue;
			deleteImage(path);
		}
	}

	/**
	 * Boot-time GC for images/chat/: an upload whose send was abandoned (composer closed,
	 * tab discarded) is referenced by no row and reachable by no sweep, so it would sit on
	 * disk forever. Runs once at server start; the one-hour age guard protects uploads a
	 * client staged moments before a restart. Thumbnails ride with their originals.
	 */
	sweepAbandonedChatImages(): number {
		const dir = join(IMAGES_ROOT, 'chat');
		if (!existsSync(dir)) return 0;
		const cutoff = Date.now() - 60 * 60 * 1000;
		// Every path any message or assistant turn references, parsed from the real rows.
		// No LIKE guessing here, this sweep must err on the side of keeping files. If any
		// row fails to parse, the reference set is unknowable: abort, delete nothing.
		const referenced = new Set<string>();
		try {
			for (const row of this.select<{ attachments_json: string | null }[]>('SELECT attachments_json FROM messages WHERE attachments_json IS NOT NULL')) {
				for (const p of this.imagePathsIn(row.attachments_json)) referenced.add(p);
			}
			for (const row of this.select<{ images_json: string | null }[]>('SELECT images_json FROM assistant_messages WHERE images_json IS NOT NULL')) {
				for (const p of this.imagePathsIn(row.images_json)) referenced.add(p);
			}
		} catch (e) {
			console.error('[db] abandoned-image sweep skipped because a row failed to parse:', e instanceof Error ? e.message : e);
			return 0;
		}
		let swept = 0;
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			if (!statSync(abs).isFile()) continue;
			const rel = `images/chat/${name}`;
			if (referenced.has(rel)) continue;
			if (statSync(abs).mtimeMs > cutoff) continue;
			deleteImage(rel); // removes the thumbnail alongside
			swept += 1;
		}
		if (swept > 0) console.log(`[db] swept ${swept} abandoned chat image${swept === 1 ? '' : 's'}`);
		return swept;
	}

	deleteChat(chatId: string): void {
		const paths = this.imagePathsOfChat(chatId);
		this.execute('DELETE FROM chats WHERE id = ?', [chatId]); // messages cascade
		// Steering notes bound to this chat can't cascade, since scope_id has no FK, so they
		// are reaped here, where the delete can't be forgotten.
		// This rides the 'chats' broadcast: another device keeps those note rows cached
		// until its next steering refresh, which is harmless (a chat-scoped note whose
		// chat is gone never resolves): the duplicateChat precedent for one method
		// touching several tables under the one scope that matters.
		this.execute("DELETE FROM steering_notes WHERE scope = 'chat' AND scope_id = ?", [chatId]);
		this.dropOrphanedChatImages(paths);
	}

	// ===== MESSAGES =====

	getMessagesByChat(chatId: string): unknown[] {
		const rows = this.select<Record<string, unknown>[]>('SELECT * FROM messages WHERE chat_id = ?', [chatId]);
		return rows.map((r) => this.mapMessage(r));
	}

	/** chatId → total message rows, in one pass. Powers the chat list's
	 *  "sort by message count" without loading any message bodies. */
	getMessageCounts(): Record<string, number> {
		const rows = this.select<{ chat_id: string; count: number }[]>(
			'SELECT chat_id, COUNT(*) AS count FROM messages GROUP BY chat_id'
		);
		const out: Record<string, number> = {};
		for (const r of rows) out[r.chat_id] = r.count;
		return out;
	}

	/** chatId → created_at of the most recent user message, in one pass. Powers the
	 *  library's "Recent" sort with actual talk activity: seeded greetings and
	 *  bookkeeping touches don't count, only messages the user really sent. */
	getLastUserMessageTimes(): Record<string, number> {
		const rows = this.select<{ chat_id: string; last: number }[]>(
			"SELECT chat_id, MAX(created_at) AS last FROM messages WHERE role = 'user' GROUP BY chat_id"
		);
		const out: Record<string, number> = {};
		for (const r of rows) out[r.chat_id] = r.last;
		return out;
	}

	/** chatId → persona_id of the most recent user message that carried one. Lets the
	 *  chat lists show whose persona a chat was last written with, without loading
	 *  any message bodies. Ties on created_at just keep whichever row comes last. */
	getLastPersonaByChat(): Record<string, string> {
		const rows = this.select<{ chat_id: string; persona_id: string }[]>(
			`SELECT m.chat_id, m.persona_id
			 FROM messages m
			 JOIN (
				SELECT chat_id, MAX(created_at) AS mx
				FROM messages
				WHERE role = 'user' AND persona_id IS NOT NULL
				GROUP BY chat_id
			 ) t ON t.chat_id = m.chat_id AND t.mx = m.created_at
			 WHERE m.role = 'user' AND m.persona_id IS NOT NULL`
		);
		const out: Record<string, string> = {};
		for (const r of rows) out[r.chat_id] = r.persona_id;
		return out;
	}

	// ===== CHAT LIST AGGREGATES =====
	//
	// Everything the chats panel needs to render a row without loading a single
	// message body over the wire. Each method is one pass over the messages table.

	/** Ids along every chat's ACTIVE path (root→active leaf), as one recursive walk up
	 *  the parent chain from each chat's leaf. The basis for the panel's honest counts
	 *  and for restricting search to the branch the reader actually reads. The depth
	 *  bound is a hang guard, not a real limit: the tree can't hold a cycle, but a
	 *  chat list that never returns would be a far worse way to find out it did. */
	private activePathRows(): { chat_id: string; id: string }[] {
		return this.select<{ chat_id: string; id: string }[]>(
			`WITH RECURSIVE path(chat_id, id, parent_id, depth) AS (
				SELECT c.id, m.id, m.parent_id, 0
				FROM chats c JOIN messages m ON m.id = c.active_leaf_id
				UNION ALL
				SELECT p.chat_id, m.id, m.parent_id, p.depth + 1
				FROM messages m JOIN path p ON m.id = p.parent_id
				WHERE p.depth < 100000
			)
			SELECT chat_id, id FROM path`
		);
	}

	/** Per-chat row data for the chats panel: how many turns the active branch holds
	 *  (`path`: what a reader would actually read), how many rows the whole tree holds
	 *  (`total`: every swipe, alternate greeting and abandoned fork), and when that
	 *  branch was last written to (`lastAt`). The two counts are deliberately BOTH
	 *  returned: the panel labels them separately instead of showing one unexplained
	 *  number. No message text: the rows show times and counts, and the only snippet
	 *  the panel renders is the one searchChatMessages cuts around a hit. */
	getChatListStats(): Record<string, { path: number; total: number; lastAt: number | null }> {
		const out: Record<string, { path: number; total: number; lastAt: number | null }> = {};
		const blank = () => ({ path: 0, total: 0, lastAt: null as number | null });

		for (const r of this.select<{ chat_id: string; count: number }[]>(
			'SELECT chat_id, COUNT(*) AS count FROM messages GROUP BY chat_id'
		)) {
			out[r.chat_id] = { ...blank(), total: r.count };
		}

		const pathIds = new Map<string, string[]>();
		for (const r of this.activePathRows()) {
			const bucket = pathIds.get(r.chat_id);
			if (bucket) bucket.push(r.id);
			else pathIds.set(r.chat_id, [r.id]);
		}
		// The active leaf IS the newest turn on the branch, so its timestamp is the
		// branch's: no second MAX() pass, and it can never report a turn that lives on
		// some other branch (which a plain MAX(created_at) over the chat would).
		const leaves = this.select<{ chat_id: string; created_at: number }[]>(
			`SELECT c.id AS chat_id, m.created_at
			 FROM chats c JOIN messages m ON m.id = c.active_leaf_id`
		);
		const leafByChat = new Map(leaves.map((r) => [r.chat_id, r.created_at]));

		for (const [chatId, ids] of pathIds) {
			const entry = (out[chatId] ??= blank());
			entry.path = ids.length;
			entry.lastAt = leafByChat.get(chatId) ?? null;
		}
		return out;
	}

	/** chatId → a key shared by every chat whose message tree is byte-identical, so the
	 *  panel can flag copies at a glance (a Duplicate, or the same ST log imported
	 *  twice). Only chats that actually have a twin appear.
	 *
	 *  Two stages so a big library stays cheap: an aggregate signature in SQL narrows
	 *  the field without reading one byte of content, and only chats that COLLIDE on it
	 *  get their content read and hashed. The hash is structural: a node's digest folds
	 *  in its children's digests, ordered by (sibling_index, child digest), so it is
	 *  independent of row ids and of insertion order, which a copy never reproduces.
	 *  Timestamps are deliberately out of it: same story, same text = same chat. */
	getChatContentGroups(): Record<string, string> {
		const signatures = this.select<{ chat_id: string; n: number; len: number }[]>(
			'SELECT chat_id, COUNT(*) AS n, SUM(LENGTH(content)) AS len FROM messages GROUP BY chat_id HAVING COUNT(*) > 0'
		);
		const bySignature = new Map<string, string[]>();
		for (const s of signatures) {
			const key = `${s.n}:${s.len}`;
			const bucket = bySignature.get(key);
			if (bucket) bucket.push(s.chat_id);
			else bySignature.set(key, [s.chat_id]);
		}

		const out: Record<string, string> = {};
		for (const candidates of bySignature.values()) {
			if (candidates.length < 2) continue;
			const byHash = new Map<string, string[]>();
			for (const chatId of candidates) {
				const hash = this.hashChatTree(chatId);
				const bucket = byHash.get(hash);
				if (bucket) bucket.push(chatId);
				else byHash.set(hash, [chatId]);
			}
			for (const [hash, chatIds] of byHash) {
				if (chatIds.length < 2) continue;
				for (const chatId of chatIds) out[chatId] = hash;
			}
		}
		return out;
	}

	/** Structural digest of one chat's whole message forest (see getChatContentGroups).
	 *  Attachments count as content: two runs of the same words over different pictures
	 *  are not the same chat. `thinking` deliberately does not: reasoning is the model's
	 *  scratch paper, not the story. */
	private hashChatTree(chatId: string): string {
		const rows = this.select<{ id: string; parent_id: string | null; role: string; content: string; attachments_json: string | null; sibling_index: number }[]>(
			'SELECT id, parent_id, role, content, attachments_json, sibling_index FROM messages WHERE chat_id = ?',
			[chatId]
		);
		const children = new Map<string | null, typeof rows>();
		for (const row of rows) {
			const bucket = children.get(row.parent_id);
			if (bucket) bucket.push(row);
			else children.set(row.parent_id, [row]);
		}
		// Iterative post-order: a deep chat must not blow the stack.
		const digest = new Map<string, string>();
		const stack: { row: (typeof rows)[number]; expanded: boolean }[] = (children.get(null) ?? []).map((row) => ({ row, expanded: false }));
		while (stack.length) {
			const frame = stack.pop()!;
			const kids = children.get(frame.row.id) ?? [];
			if (!frame.expanded && kids.length) {
				stack.push({ row: frame.row, expanded: true });
				for (const kid of kids) stack.push({ row: kid, expanded: false });
				continue;
			}
			const kidDigests = kids
				.map((k) => `${k.sibling_index}:${digest.get(k.id) ?? ''}`)
				.sort();
			digest.set(
				frame.row.id,
				shortDigest(
					`${frame.row.role}\u0001${frame.row.content}\u0002${frame.row.attachments_json ?? ''}\u0003${kidDigests.join('\u0004')}`
				)
			);
		}
		const roots = (children.get(null) ?? [])
			.map((r) => `${r.sibling_index}:${digest.get(r.id) ?? ''}`)
			.sort();
		return shortDigest(roots.join('\u0005'));
	}

	/** chatId → { hits, snippet } for chats whose ACTIVE branch contains every term
	 *  (case-insensitive, any order). Off-path branches are deliberately not searched:
	 *  the panel promises "in the story you'd read", and a hit you can't see without a
	 *  branch jump is worse than no hit. `snippet` is a window around the first match
	 *  in the newest matching turn, so the row shows why it matched. */
	searchChatMessages(query: string): Record<string, { hits: number; snippet: string }> {
		const terms = query.trim().split(/\s+/).filter(Boolean).map(foldSearchText);
		if (!terms.length) return {};

		const onPath = new Set<string>();
		for (const r of this.activePathRows()) onPath.add(r.id);
		if (!onPath.size) return {};

		// The narrowest term first: the LIKE that survives the fewest rows does the
		// heavy lifting, and everything after it is a check over what's left.
		const needle = terms.reduce((a, b) => (b.length > a.length ? b : a));
		const folded = foldSearchSql('content');
		const rows = this.select<{ id: string; chat_id: string; content: string; created_at: number }[]>(
			`SELECT id, chat_id, content, created_at FROM messages WHERE ${folded} LIKE ? ESCAPE '\\' ORDER BY created_at ASC`,
			[`%${escapeLike(needle)}%`]
		);

		const out: Record<string, { hits: number; snippet: string }> = {};
		for (const row of rows) {
			if (!onPath.has(row.id)) continue;
			const hay = foldSearchText(row.content);
			if (!terms.every((t) => hay.includes(t))) continue;
			const entry = (out[row.chat_id] ??= { hits: 0, snippet: '' });
			entry.hits += 1;
			// Rows arrive oldest-first, so the last one written wins: the newest hit.
			entry.snippet = snippetAround(row.content, hay.indexOf(terms[0]));
		}
		return out;
	}

	/** What a chat's memory would cost to carry along on a duplicate. Counts only:
	 *  the duplicate dialog asks the user before anything is copied. */
	getChatMemoryFootprint(chatId: string): { enabled: boolean; episodes: number } {
		const state = this.select<{ enabled: number }[]>('SELECT enabled FROM memory_state WHERE chat_id = ?', [chatId])[0];
		const episodes =
			this.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM memory_episodes WHERE chat_id = ?', [chatId])[0]?.n ?? 0;
		return { enabled: !!state?.enabled, episodes };
	}

	// ===== USER STATS =====
	//
	// One whole-library aggregate for the stats screen. It lives here for the same reason
	// the block above does: it reads every message body in the database and must turn them
	// into numbers on this side, never ship them. See src/lib/types/stats.ts for what each
	// figure means and which of them are measured over a subset.

	/**
	 * Everything the stats screen renders, in one call.
	 *
	 * ONE streamed pass over `messages` does the bulk of it, because a second pass would be
	 * a second read of every message body. The pass folds each row into the effort totals,
	 * the story totals (when it sits on its chat's open branch), the activity buckets, the
	 * per-character tallies and the record holders at the same time.
	 *
	 * **Nothing here estimates.** A turn with no token count is skipped by the token totals
	 * rather than priced from its text, and every measured total ships the number of turns
	 * it covers, so a screen cannot present a corner of the library as the whole of it.
	 */
	getUserStats(): unknown {
		// The branch each chat is open at, resolved once. Everything "story" is this set,
		// and everything off it is a turn that was written and then left behind.
		const onPath = new Set<string>();
		const pathPerChat = new Map<string, number>();
		for (const r of this.activePathRows()) {
			onPath.add(r.id);
			pathPerChat.set(r.chat_id, (pathPerChat.get(r.chat_id) ?? 0) + 1);
		}

		// Which character each chat belongs to, so the pass can tally the cast without
		// joining every message row against the chats table.
		const characterOfChat = new Map<string, string>();
		for (const r of this.select<{ id: string; character_id: string | null }[]>(
			'SELECT id, character_id FROM chats WHERE character_id IS NOT NULL'
		)) {
			if (r.character_id) characterOfChat.set(r.id, r.character_id);
		}

		const blankVolume = () => ({
			messages: 0,
			userMessages: 0,
			assistantMessages: 0,
			words: 0,
			userWords: 0,
			assistantWords: 0
		});
		const effort = blankVolume();
		const story = blankVolume();
		const shape = { abandoned: 0, longestStory: 0 };
		const measured = {
			promptTokens: 0,
			promptTokenTurns: 0,
			completionTokens: 0,
			completionTokenTurns: 0,
			generationMs: 0,
			generationTurns: 0,
			firstTokenMs: 0,
			firstTokenTurns: 0,
			reasoningMs: 0,
			reasoningTurns: 0,
			assistantTurns: 0
		};

		const buckets = new Map<number, number>();
		const cast = new Map<string, { chatIds: Set<string>; messages: number; words: number; firstAt: number; lastAt: number }>();
		let longestReply: { chatId: string; words: number } | null = null;
		let longestUserTurn: { chatId: string; words: number } | null = null;
		let firstMessageAt: number | null = null;
		let lastMessageAt: number | null = null;

		for (const row of this.selectIter<{
			id: string;
			chat_id: string;
			role: string;
			content: string;
			created_at: number;
			tokens_prompt: number | null;
			tokens_completion: number | null;
			generation_ms: number | null;
			first_token_ms: number | null;
			reasoning_ms: number | null;
		}>(
			`SELECT id, chat_id, role, content, created_at,
			        tokens_prompt, tokens_completion, generation_ms, first_token_ms, reasoning_ms
			 FROM messages`
		)) {
			const words = countWords(row.content);
			const isUser = row.role === 'user';
			const isAssistant = row.role === 'assistant';

			effort.messages += 1;
			effort.words += words;
			if (isUser) {
				effort.userMessages += 1;
				effort.userWords += words;
			} else if (isAssistant) {
				effort.assistantMessages += 1;
				effort.assistantWords += words;
			}

			if (onPath.has(row.id)) {
				story.messages += 1;
				story.words += words;
				if (isUser) {
					story.userMessages += 1;
					story.userWords += words;
				} else if (isAssistant) {
					story.assistantMessages += 1;
					story.assistantWords += words;
				}
			} else {
				shape.abandoned += 1;
			}

			// System turns are deliberately in the activity series: they are still a moment
			// the library was being worked in, which is the only thing a heatmap claims.
			const bucket = Math.floor(row.created_at / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
			buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
			if (firstMessageAt === null || row.created_at < firstMessageAt) firstMessageAt = row.created_at;
			if (lastMessageAt === null || row.created_at > lastMessageAt) lastMessageAt = row.created_at;

			const characterId = characterOfChat.get(row.chat_id);
			if (characterId) {
				let entry = cast.get(characterId);
				if (!entry) {
					entry = { chatIds: new Set(), messages: 0, words: 0, firstAt: row.created_at, lastAt: row.created_at };
					cast.set(characterId, entry);
				}
				entry.chatIds.add(row.chat_id);
				entry.messages += 1;
				entry.words += words;
				if (row.created_at < entry.firstAt) entry.firstAt = row.created_at;
				if (row.created_at > entry.lastAt) entry.lastAt = row.created_at;
			}

			if (isAssistant) {
				measured.assistantTurns += 1;
				if (!longestReply || words > longestReply.words) longestReply = { chatId: row.chat_id, words };
				if (row.tokens_prompt !== null) {
					measured.promptTokens += row.tokens_prompt;
					measured.promptTokenTurns += 1;
				}
				if (row.tokens_completion !== null) {
					measured.completionTokens += row.tokens_completion;
					measured.completionTokenTurns += 1;
				}
				if (row.generation_ms !== null) {
					measured.generationMs += row.generation_ms;
					measured.generationTurns += 1;
				}
				if (row.first_token_ms !== null) {
					measured.firstTokenMs += row.first_token_ms;
					measured.firstTokenTurns += 1;
				}
				if (row.reasoning_ms !== null) {
					measured.reasoningMs += row.reasoning_ms;
					measured.reasoningTurns += 1;
				}
			} else if (isUser && (!longestUserTurn || words > longestUserTurn.words)) {
				longestUserTurn = { chatId: row.chat_id, words };
			}
		}

		let longestChat: { chatId: string; messages: number } | null = null;
		for (const [chatId, messages] of pathPerChat) {
			if (messages > shape.longestStory) shape.longestStory = messages;
			if (!longestChat || messages > longestChat.messages) longestChat = { chatId, messages };
		}

		const counts = this.select<{ type: string; n: number }[]>(
			'SELECT type, COUNT(*) AS n FROM character_library GROUP BY type'
		);
		const shelf = (type: string) => counts.find((c) => c.type === type)?.n ?? 0;
		const scalar = (sql: string) => this.select<{ n: number }[]>(sql)[0]?.n ?? 0;

		// Lorebook entries live inside the row's JSON payload, so counting them means
		// parsing each book. There are tens of books at most, never thousands of messages.
		let lorebookEntries = 0;
		for (const r of this.select<{ data_json: string }[]>('SELECT data_json FROM lorebooks')) {
			try {
				const entries = (JSON.parse(r.data_json) as { entries?: unknown[] }).entries;
				if (Array.isArray(entries)) lorebookEntries += entries.length;
			} catch {
				// A book whose payload will not parse is already broken everywhere else in the
				// app; it must not take the whole stats screen down with it.
			}
		}

		return {
			library: {
				chats: scalar('SELECT COUNT(*) AS n FROM chats'),
				characters: shelf('character'),
				personas: shelf('persona'),
				lorebooks: scalar('SELECT COUNT(*) AS n FROM lorebooks'),
				lorebookEntries,
				memoryEpisodes: scalar('SELECT COUNT(*) AS n FROM memory_episodes')
			},
			effort,
			story,
			// Oldest first, so the client can walk it straight into a calendar.
			activity: [...buckets.entries()].sort((a, b) => a[0] - b[0]),
			cast: [...cast.entries()]
				.map(([characterId, e]) => ({
					characterId,
					chats: e.chatIds.size,
					messages: e.messages,
					words: e.words,
					firstAt: e.firstAt,
					lastAt: e.lastAt
				}))
				// Ties break on who you have known longest, so the order is stable between
				// runs instead of following whatever the map happened to hold.
				.sort((a, b) => b.messages - a.messages || a.firstAt - b.firstAt),
			shape,
			records: { longestReply, longestUserTurn, longestChat, firstMessageAt, lastMessageAt },
			measured
		};
	}

	getMessage(id: string): unknown {
		const rows = this.select<Record<string, unknown>[]>('SELECT * FROM messages WHERE id = ?', [id]);
		return rows[0] ? this.mapMessage(rows[0]) : null;
	}

	insertMessage(message: Record<string, unknown>): void {
		this.execute(
			`INSERT INTO messages
			 (id, chat_id, parent_id, role, content, persona_id, branch_label, thinking, attachments_json, created_at, edited_at, minor_edited_at, sprite_label,
			  model, provider, tokens_prompt, tokens_completion, finish_reason, generation_ms, first_token_ms, reasoning_ms, lore_json, sibling_index)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				message.id,
				message.chatId,
				message.parentId,
				message.role,
				message.content,
				message.personaId ?? null,
				message.branchLabel ? JSON.stringify(message.branchLabel) : null,
				message.thinking ?? null,
				Array.isArray(message.attachments) && message.attachments.length
					? JSON.stringify(message.attachments)
					: null,
				message.createdAt,
				message.editedAt ?? null,
				message.minorEditedAt ?? null,
				message.spriteLabel ?? null,
				message.model ?? null,
				message.provider ?? null,
				message.tokensPrompt ?? null,
				message.tokensCompletion ?? null,
				message.finishReason ?? null,
				message.generationMs ?? null,
				message.firstTokenMs ?? null,
				message.reasoningMs ?? null,
				message.lorebook ? JSON.stringify(message.lorebook) : null,
				message.siblingIndex ?? 0
			]
		);
	}

	/**
	 * Rewrite one turn's text.
	 *
	 * `edited_at` is the systemic staleness signal chat memory compares against, so advancing
	 * it discards the summary covering this turn and buys a paid re-read (architecture/memory.md).
	 * A **minor** edit is the user saying that is not worth doing (the turn still says the
	 * same thing), so it stamps `minor_edited_at` and leaves `edited_at` exactly where it was.
	 * The transcript still marks the turn as edited from either stamp; the summary survives.
	 *
	 * The mode is the caller's assertion, never inferred: no diff of two strings can tell a
	 * typo from a retcon, and guessing wrong in the quiet direction leaves memory describing
	 * a scene that no longer happened.
	 */
	updateMessageContent(messageId: string, content: string, opts?: { minor?: boolean }): void {
		const column = opts?.minor ? 'minor_edited_at' : 'edited_at';
		this.execute(`UPDATE messages SET content = ?, ${column} = ? WHERE id = ?`, [
			content,
			Date.now(),
			messageId
		]);
	}

	/** Extend an assistant turn with a generated continuation: the full joined content plus
	 *  the run's accumulated stats. Deliberately leaves edited_at alone: a continuation is
	 *  more generation, not a user edit, so the turn never gets flagged as edited. The
	 *  sprite reading is left alone here too, for the same reason memory's summary is:
	 *  whether a rewritten turn is re-read is the caller's decision, gated on a setting the
	 *  server has no business reading (architecture/engines.md).
	 *
	 *  `first_token_ms` is deliberately absent from the patch, so no continuation can touch it:
	 *  it records WHEN this turn started speaking, which happened once, on the run that created
	 *  it. `reasoning_ms` is in the patch because it records HOW MUCH thinking the turn cost,
	 *  and a continuation adds to that the same way it adds to `generation_ms`; the caller
	 *  accumulates both. */
	applyMessageContinuation(
		messageId: string,
		patch: {
			content: string;
			thinking: string | null;
			tokensPrompt: number | null;
			tokensCompletion: number | null;
			finishReason: string | null;
			generationMs: number | null;
			reasoningMs: number | null;
		}
	): void {
		this.execute(
			'UPDATE messages SET content = ?, thinking = ?, tokens_prompt = ?, tokens_completion = ?, finish_reason = ?, generation_ms = ?, reasoning_ms = ? WHERE id = ?',
			[
				patch.content,
				patch.thinking,
				patch.tokensPrompt,
				patch.tokensCompletion,
				patch.finishReason,
				patch.generationMs,
				patch.reasoningMs,
				messageId
			]
		);
	}

	/** Re-attribute a message to a persona (or clear it with null). Independent of
	 *  content edits, so it never bumps edited_at. The persona a message was sent with
	 *  is normally locked at send time; this is the deliberate, after-the-fact rebind. */
	updateMessagePersona(messageId: string, personaId: string | null): void {
		this.execute('UPDATE messages SET persona_id = ? WHERE id = ?', [personaId ?? null, messageId]);
	}

	/** Record which sprite label the Sprites engine read an assistant turn as. Metadata like the
	 *  branch label below: it never touches content or edited_at, so re-reading a turn is not an
	 *  edit and the memory pipeline has nothing to invalidate. */
	updateMessageSpriteLabel(messageId: string, label: string | null): void {
		this.execute('UPDATE messages SET sprite_label = ? WHERE id = ?', [label ?? null, messageId]);
	}

	/** Bind every user turn in a chat to a persona at once (or clear with null). Powers the
	 *  composer's "set persona for this chat" action: imported/legacy chats whose user
	 *  messages have no persona show a plain "You" until re-attributed. Only user rows are
	 *  touched; content and edited_at are left alone. */
	setChatUserPersona(chatId: string, personaId: string | null): void {
		this.execute("UPDATE messages SET persona_id = ? WHERE chat_id = ? AND role = 'user'", [
			personaId ?? null,
			chatId
		]);
	}

	/** Name (or clear) the branch a message heads. `label` is a { name, color } object or
	 *  null to remove it. Purely story-map metadata, never touching content or edited_at. */
	updateMessageBranchLabel(messageId: string, label: unknown): void {
		this.execute('UPDATE messages SET branch_label = ? WHERE id = ?', [
			label ? JSON.stringify(label) : null,
			messageId
		]);
	}

	/**
	 * Splice one row out: its children re-parent to its parent, everything below survives.
	 *
	 * Refused when the row **heads a branch and holds replies**. The splice merges its children
	 * into its parent's child set, and at a fork those two sets answer different turns: the
	 * branches beside it answer what it answers, its own children answer IT. Merged, they leave
	 * a swipe position alternating between a user turn and a reply, which no reader and no
	 * renderer can make sense of. The rule lives here rather than in the delete menus so every
	 * caller inherits it: the client store over RPC, the assistant's `delete_entity`, and
	 * anything added later. Callers that mean it delete the whole subtree instead.
	 */
	/**
	 * A chat's three tree pointers may never name a row that is gone. The transcript is drawn
	 * by walking root→`active_leaf_id`, and that walk stops dead at a missing id: a chat whose
	 * leaf points at a deleted turn renders EMPTY with every one of its messages still in the
	 * table. So every delete path here repairs the pointers in its own transaction rather than
	 * leaving it to whoever called. The client store, the assistant's `delete_entity`, and
	 * anything added later all inherit it, which is the same reason the splice refusal lives
	 * here (architecture/chat-sessions.md coupling 3).
	 *
	 * `doomed` is always a connected subtree, so the nearest surviving ancestor of any pointer
	 * inside it is one value: `escapeId`, the parent of the subtree's head.
	 *
	 * This is the floor, not the policy. A caller with a better answer (the transcript re-homes
	 * the view to a same-role sibling for continuity) simply sets the leaf again afterwards.
	 */
	private repairChatPointers(chatId: string, doomed: Set<string>, escapeId: string | null): void {
		const chat = this.select<{ root_message_id: string | null; active_leaf_id: string | null; canon_leaf_id: string | null }[]>(
			'SELECT root_message_id, active_leaf_id, canon_leaf_id FROM chats WHERE id = ?',
			[chatId]
		)[0];
		if (!chat) return;
		// The first surviving parentless row: what the chat re-roots on, and where the view
		// lands when the doomed subtree reached all the way up and there is no ancestor left.
		const survivingRoot = (): string | null =>
			this.select<{ id: string }[]>(
				'SELECT id FROM messages WHERE chat_id = ? AND parent_id IS NULL ORDER BY sibling_index ASC, created_at ASC LIMIT 1',
				[chatId]
			)[0]?.id ?? null;

		if (chat.active_leaf_id && doomed.has(chat.active_leaf_id)) {
			// Null only when the chat has no messages left at all: a chat that still holds
			// turns must always name one, or the transcript is blank for a different reason.
			this.execute('UPDATE chats SET active_leaf_id = ? WHERE id = ?', [escapeId ?? survivingRoot(), chatId]);
		}
		// The canon marker may legitimately end up unset: with the whole canonical prefix gone
		// there is no spine to draw, and picking an unrelated branch would invent one.
		if (chat.canon_leaf_id && doomed.has(chat.canon_leaf_id)) {
			this.execute('UPDATE chats SET canon_leaf_id = ? WHERE id = ?', [escapeId, chatId]);
		}
		if (chat.root_message_id && doomed.has(chat.root_message_id)) {
			this.execute('UPDATE chats SET root_message_id = ? WHERE id = ?', [survivingRoot(), chatId]);
		}
	}

	deleteMessageOnly(messageId: string): void {
		const message = this.getMessage(messageId) as { chatId: string; parentId: string | null } | null;
		if (!message) return;

		const childCount =
			this.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM messages WHERE parent_id = ?', [messageId])[0]?.n ?? 0;
		if (childCount > 0) {
			// `IS` rather than `=` so a root's NULL parent actually compares, and chat_id so the
			// other chats' roots aren't counted as this one's siblings.
			const branchCount =
				this.select<{ n: number }[]>(
					'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND parent_id IS ? AND id != ?',
					[message.chatId, message.parentId, messageId]
				)[0]?.n ?? 0;
			if (branchCount > 0) {
				throw new Error(
					`deleteMessageOnly refused: message ${messageId} heads a branch (${branchCount} other branch${branchCount === 1 ? '' : 'es'} beside it) and has ${childCount} ${childCount === 1 ? 'reply' : 'replies'} below it. Splicing it would merge those replies into the fork, leaving a swipe that alternates roles. Delete the whole subtree instead.`
				);
			}
		}

		const paths = this.imagePathsOfMessages([messageId]);
		const tx = this.db.transaction(() => {
			// Re-parented children join the new parent's existing children with fresh sibling
			// indexes appended after them: two merging sibling sets must never share an index.
			const base = this.getNextSiblingIndex(message.parentId);
			const children = this.select<{ id: string }[]>(
				'SELECT id FROM messages WHERE parent_id = ? ORDER BY sibling_index ASC, created_at ASC',
				[messageId]
			);
			children.forEach((child, i) => {
				this.execute('UPDATE messages SET parent_id = ?, sibling_index = ? WHERE id = ?', [
					message.parentId,
					base + i,
					child.id
				]);
			});
			this.execute('DELETE FROM messages WHERE id = ?', [messageId]);
			// The splice re-parents the children, so the one row that vanishes from the tree is
			// this one and the parent is where anything pointing at it lands.
			this.repairChatPointers(message.chatId, new Set([messageId]), message.parentId);
		});
		tx();
		this.dropOrphanedChatImages(paths);
	}

	deleteMessageAndDescendants(messageId: string): void {
		const message = this.getMessage(messageId) as { chatId: string; parentId: string | null } | null;
		if (!message) return;
		const doomed = this.descendantIds(messageId, true);
		const paths = this.imagePathsOfMessages(doomed);
		const tx = this.db.transaction(() => {
			this.execute(
				`WITH RECURSIVE descendants AS (
					SELECT id FROM messages WHERE id = ?
					UNION ALL
					SELECT m.id FROM messages m
					INNER JOIN descendants d ON m.parent_id = d.id
				)
				DELETE FROM messages WHERE id IN (SELECT id FROM descendants)`,
				[messageId]
			);
			this.repairChatPointers(message.chatId, new Set(doomed), message.parentId);
		});
		tx();
		this.dropOrphanedChatImages(paths);
	}

	deleteDescendants(messageId: string): void {
		const message = this.getMessage(messageId) as { chatId: string } | null;
		if (!message) return;
		const doomed = this.descendantIds(messageId, false);
		const paths = this.imagePathsOfMessages(doomed);
		const tx = this.db.transaction(() => {
			this.execute(
				`WITH RECURSIVE descendants AS (
					SELECT id FROM messages WHERE parent_id = ?
					UNION ALL
					SELECT m.id FROM messages m
					INNER JOIN descendants d ON m.parent_id = d.id
				)
				DELETE FROM messages WHERE id IN (SELECT id FROM descendants)`,
				[messageId]
			);
			// Nothing below survives, so the turn itself is where a pointer lands.
			this.repairChatPointers(message.chatId, new Set(doomed), messageId);
		});
		tx();
		this.dropOrphanedChatImages(paths);
	}

	getNextSiblingIndex(parentId: string | null): number {
		const result = this.select<{ max_index: number | null }[]>(
			'SELECT MAX(sibling_index) as max_index FROM messages WHERE parent_id IS ?',
			[parentId]
		);
		const maxIndex = result[0]?.max_index;
		return maxIndex !== null && maxIndex !== undefined ? maxIndex + 1 : 0;
	}

	// ===== SETTINGS =====

	getSetting(key: string): string | null {
		const rows = this.select<{ value: string }[]>('SELECT value FROM settings WHERE key = ?', [key]);
		return rows[0]?.value ?? null;
	}

	setSetting(key: string, value: string): void {
		this.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
	}

	deleteSetting(key: string): void {
		this.execute('DELETE FROM settings WHERE key = ?', [key]);
	}

	// ===== CHAT DRAFTS =====

	getChatDraft(chatId: string): unknown {
		const rows = this.select<{ chat_id: string; content: string; updated_at: number }[]>(
			'SELECT * FROM chat_drafts WHERE chat_id = ?',
			[chatId]
		);
		if (!rows[0]) return null;
		return { chatId: rows[0].chat_id, content: rows[0].content, updatedAt: rows[0].updated_at };
	}

	upsertChatDraft(chatId: string, content: string): void {
		this.execute(
			`INSERT INTO chat_drafts (chat_id, content, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(chat_id) DO UPDATE SET
			 content = excluded.content,
			 updated_at = excluded.updated_at`,
			[chatId, content, Date.now()]
		);
	}

	deleteChatDraft(chatId: string): void {
		this.execute('DELETE FROM chat_drafts WHERE chat_id = ?', [chatId]);
	}

	// ===== INPUT HISTORY =====

	/** The newest `limit` entries, oldest → newest (nav walks it back to front). */
	getInputHistory(limit: number): unknown[] {
		const rows = this.select<{ id: number; chat_id: string | null; content: string }[]>(
			'SELECT * FROM (SELECT id, chat_id, content FROM input_history ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
			[this.clampHistoryCap(limit)]
		);
		return rows.map((r) => ({ id: r.id, chatId: r.chat_id, content: r.content }));
	}

	/** Append one sent message and trim the log to the cap in the same transaction. */
	addInputHistory(chatId: string | null, content: string, cap: number): void {
		const limit = this.clampHistoryCap(cap);
		const tx = this.db.transaction(() => {
			this.execute('INSERT INTO input_history (chat_id, content, created_at) VALUES (?, ?, ?)', [
				chatId,
				content,
				Date.now()
			]);
			this.execute(
				'DELETE FROM input_history WHERE id NOT IN (SELECT id FROM input_history ORDER BY id DESC LIMIT ?)',
				[limit]
			);
		});
		tx();
	}

	clearInputHistory(): void {
		this.execute('DELETE FROM input_history');
	}

	private clampHistoryCap(cap: number): number {
		return Number.isFinite(cap) ? Math.min(1000, Math.max(10, Math.round(cap))) : 100;
	}

	// ===== IMPORT SOURCES =====

	/** Every source file an import has claimed, with what it became where that is worth
	 *  remembering. Read when a folder is scanned, and again when one is imported. */
	getImportedSources(): { key: string; entityId: string | null }[] {
		const rows = this.select<{ source_key: string; entity_id: string | null }[]>(
			'SELECT source_key, entity_id FROM import_sources',
			[]
		);
		return rows.map((r) => ({ key: r.source_key, entityId: r.entity_id }));
	}

	/**
	 * Claim these source files. Written in batches as an import walks, never once at the end,
	 * so a run that is stopped or dies keeps what it already landed.
	 *
	 * **A second claim on the same file refreshes what it became**, which is what makes
	 * `entity_id` mean the entry that exists rather than one that used to. A file only arrives
	 * twice because the reader asked for it (the confirm card's include-known box, or an entry
	 * they deleted being offered again), and it makes a NEW entry each time; leaving the first
	 * id standing would point the claim at a deleted row for good, and a reader who deleted
	 * that entry would then be handed the same file on every run forever. `created_at` is not
	 * touched, since it records when this file first came over, and a claim carrying no id
	 * cannot blank one that is already there.
	 */
	recordImportedSources(claims: { key: string; entityId?: string | null }[]): void {
		if (claims.length === 0) return;
		const now = Date.now();
		const tx = this.db.transaction(() => {
			for (const claim of claims) {
				this.execute(
					`INSERT INTO import_sources (source_key, entity_id, created_at) VALUES (?, ?, ?)
					 ON CONFLICT(source_key) DO UPDATE SET entity_id = excluded.entity_id
					 WHERE excluded.entity_id IS NOT NULL`,
					[claim.key, claim.entityId ?? null, now]
				);
			}
		});
		tx();
	}

	// ===== CONNECTION CREDENTIALS =====

	getConnectionCredentials(connectionId: string): unknown {
		const rows = this.select<{ provider: string; api_key_encrypted: string; base_url: string | null }[]>(
			'SELECT provider, api_key_encrypted, base_url FROM connection_credentials WHERE connection_id = ?',
			[connectionId]
		);
		if (!rows[0]) return null;
		return { provider: rows[0].provider, apiKey: rows[0].api_key_encrypted, baseUrl: rows[0].base_url };
	}

	setConnectionCredentials(connectionId: string, provider: string, apiKey: string, baseUrl?: string): void {
		this.execute(
			`INSERT OR REPLACE INTO connection_credentials (connection_id, provider, api_key_encrypted, base_url, updated_at)
			 VALUES (?, ?, ?, ?, ?)`,
			[connectionId, provider, apiKey, baseUrl ?? null, Date.now()]
		);
	}

	deleteConnectionCredentials(connectionId: string): void {
		this.execute('DELETE FROM connection_credentials WHERE connection_id = ?', [connectionId]);
	}

	/** Duplicate one connection's stored credentials under another connection id,
	 *  entirely server-side, so the key never rides the wire. No-op when the source
	 *  has no credentials. */
	copyConnectionCredentials(fromConnectionId: string, toConnectionId: string): void {
		this.execute(
			`INSERT OR REPLACE INTO connection_credentials (connection_id, provider, api_key_encrypted, base_url, updated_at)
			 SELECT ?, provider, api_key_encrypted, base_url, ? FROM connection_credentials WHERE connection_id = ?`,
			[toConnectionId, Date.now(), fromConnectionId]
		);
	}

	// ===== CHARACTER LIBRARY =====

	getAllLibraryEntries(): unknown[] {
		const rows = this.select<{ id: string; type: string; data_json: string; is_favorite: number; created_at: number; updated_at: number }[]>(
			'SELECT * FROM character_library ORDER BY updated_at DESC'
		);
		return rows.map((row) => this.mapLibraryEntry(row));
	}

	getLibraryEntry(id: string): unknown {
		const rows = this.select<{ id: string; type: string; data_json: string; is_favorite: number; created_at: number; updated_at: number }[]>(
			'SELECT * FROM character_library WHERE id = ?',
			[id]
		);
		return rows[0] ? this.mapLibraryEntry(rows[0]) : null;
	}

	/** The stored payload: identity + data, plus the active version pointer when the
	 *  entry is versioned. Unversioned entries keep the exact pre-version shape. */
	private libraryPayload(entry: Record<string, unknown>): Record<string, unknown> {
		const payload: Record<string, unknown> = { identity: entry.identity, data: entry.data };
		if (entry.activeVersionId) payload.activeVersionId = entry.activeVersionId;
		return payload;
	}

	insertLibraryEntry(entry: Record<string, unknown>): void {
		this.execute(
			`INSERT INTO character_library (id, type, data_json, is_favorite, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[entry.id, entry.type, JSON.stringify(this.libraryPayload(entry)), entry.isFavorite ? 1 : 0, entry.createdAt, entry.updatedAt]
		);
	}

	/** Save an entry and carry a changed opening into the chats that are still nothing but
	 *  that opening (refreshSeededGreetings). Returns the ids of the chats whose rows moved,
	 *  so the caller can announce the `messages` scope beside `library`. Every door writes
	 *  through here, so none of them has to reimplement the rule. */
	updateLibraryEntry(entry: Record<string, unknown>): string[] {
		return this.inTransaction(() => {
			// Read before the overwrite: the greetings this save is REPLACING are what tells a
			// chat that only mirrors the card from one that holds a story.
			const stored = this.select<{ type: string; data_json: string }[]>(
				'SELECT type, data_json FROM character_library WHERE id = ?',
				[entry.id]
			)[0];
			this.execute('UPDATE character_library SET data_json = ?, updated_at = ? WHERE id = ?', [
				JSON.stringify(this.libraryPayload(entry)),
				Date.now(),
				entry.id
			]);
			// The entry's data IS the active variant's content; mirror every save into that
			// variant's row so parked/active rows are uniformly readable (pinned chats,
			// export, import) without a "which one is live" special case anywhere else.
			if (entry.activeVersionId) {
				this.execute(
					'UPDATE character_versions SET data_json = ?, updated_at = ? WHERE id = ? AND entry_id = ?',
					[JSON.stringify(entry.data), Date.now(), entry.activeVersionId, entry.id]
				);
			}
			return stored ? this.refreshSeededGreetings(entry, stored) : [];
		});
	}

	/**
	 * Carry a character's changed opening into the chats that are still nothing but that
	 * opening.
	 *
	 * A chat nobody has written in is a **mirror** of the card, not a copy of it: its rows
	 * hold the First Message and the alternate greetings and nothing else, so an edit to the
	 * card has to reach them or every unstarted chat quietly opens on a version of the
	 * character that no longer exists. The moment the chat holds something the user put
	 * there (a turn, a reply, a hand-edited greeting, an extra opening written by hand), it
	 * is a story, and the card stops reaching it.
	 *
	 * There is deliberately **no "this chat has been used" flag**. A chat qualifies by what it
	 * holds right now: exactly the greetings the card handed it (`chats.seeded_greetings`),
	 * every row still an unedited root-level assistant turn. That is what makes
	 * the rewrite safe (a single character the user typed anywhere in the chat breaks the
	 * match), and it is why a chat emptied back down to its greetings follows the card again:
	 * nothing left in it is the user's to protect, and "has this been used" is a question about
	 * the past rather than about what the chat holds.
	 *
	 * **Recognition asks the CHAT, never the card's history**, and that is the load-bearing
	 * half. Matching against the greetings a save happens to be replacing looks equivalent and
	 * is not: a chat holding a story while the card moves on ends up holding a text the card no
	 * longer recognises, so emptying it back out could never hand it back. What that produced
	 * is worse than either answer: the chat followed the card or not depending on invisible
	 * history, which from outside reads as random.
	 *
	 * Scope is the variant that actually changed. Chats pinned elsewhere keep what they were
	 * pinned to, and a save that MOVES the active pointer (a fork, a version switch) is not a
	 * content edit at all, so it reconciles nothing.
	 */
	private refreshSeededGreetings(entry: Record<string, unknown>, stored: { type: string; data_json: string }): string[] {
		if (stored.type !== 'character') return [];
		const previous = JSON.parse(stored.data_json) as { data?: unknown; activeVersionId?: string };
		const versionId = (entry.activeVersionId as string | undefined) ?? null;
		if ((previous.activeVersionId ?? null) !== versionId) return [];

		// The card's own before/after decides only whether there is anything to do at all:
		// every other save of the entry (a tag, a description, an autosave tick while the user
		// types in some other field) stops here without looking at a single chat.
		const before = chatGreetingsOf(previous.data);
		const after = chatGreetingsOf(entry.data);
		if (before.length === after.length && before.every((greeting, i) => greeting === after[i])) return [];

		// One query names the candidates, and it COUNTS each chat's messages rather than reading
		// them: a chat whose row count already disagrees with its own claim cannot be a mirror,
		// and pulling a long story's turns to find that out would put whole chats on the wire
		// every time the user pauses typing in the First Message field.
		// `IS ?` rather than `= ?`: an unversioned character's chats carry a NULL pin, and
		// `= NULL` matches no row at all.
		const chats = this.select<{ id: string; active_leaf_id: string | null; canon_leaf_id: string | null; seeded_greetings: string; row_count: number }[]>(
			`SELECT c.id, c.active_leaf_id, c.canon_leaf_id, c.seeded_greetings,
			        (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS row_count
			 FROM chats c
			 WHERE c.character_id = ? AND c.character_version_id IS ? AND c.seeded_greetings IS NOT NULL`,
			[entry.id, versionId]
		);

		const touched: string[] = [];
		for (const chat of chats) {
			const claimed = JSON.parse(chat.seeded_greetings) as string[];
			if (chat.row_count !== claimed.length) continue;
			const rows = this.select<Record<string, unknown>[]>(
				'SELECT * FROM messages WHERE chat_id = ? ORDER BY sibling_index',
				[chat.id]
			);
			if (!this.mirrorsGreetings(rows, claimed)) continue;
			this.rewriteSeededGreetings(chat, rows, after);
			this.setChatSeededGreetings(chat.id, after);
			touched.push(chat.id);
		}
		return touched;
	}

	/** Record what the card handed this chat, at the moment it hands it over. Written by every
	 *  seeding path (the client store's `seedCharacterGreetings`, the assistant's `create_chat`,
	 *  and the refresh above) and read only by the refresh: the client never reads it back,
	 *  which is why `mapChat` deliberately does not carry it. */
	setChatSeededGreetings(chatId: string, greetings: string[]): void {
		this.execute('UPDATE chats SET seeded_greetings = ? WHERE id = ?', [JSON.stringify(greetings), chatId]);
	}

	/** Is this chat still nothing but the greetings it claims, untouched? Anything else in it
	 *  (a turn, a reply hanging under a greeting, an edit stamp, an attachment, an opening the
	 *  user wrote by hand) means it is a story the card may not rewrite. */
	private mirrorsGreetings(rows: Record<string, unknown>[], greetings: string[]): boolean {
		if (rows.length !== greetings.length) return false;
		return rows.every(
			(row, i) =>
				row.parent_id === null &&
				row.role === 'assistant' &&
				row.edited_at === null &&
				row.minor_edited_at === null &&
				row.attachments_json === null &&
				row.sibling_index === i &&
				row.content === greetings[i]
		);
	}

	/** Move a mirroring chat onto the card's current greetings, in place. */
	private rewriteSeededGreetings(
		chat: { id: string; active_leaf_id: string | null; canon_leaf_id: string | null },
		rows: Record<string, unknown>[],
		greetings: string[]
	): void {
		const kept = Math.min(rows.length, greetings.length);
		// Rewritten in place rather than reseeded: the row ids are what the chat's pointers
		// name, so a reader parked on the third greeting is still on the third greeting after.
		// No `edited_at` either: the card wrote this, not the user, and that stamp is the
		// transcript's "edited" mark and memory's staleness signal (architecture/memory.md).
		for (let i = 0; i < kept; i++) {
			if (rows[i].content === greetings[i]) continue;
			this.execute('UPDATE messages SET content = ? WHERE id = ?', [greetings[i], rows[i].id]);
		}

		const dropped = rows.slice(kept);
		if (dropped.length) {
			// A chat pointer naming a row that is gone renders the chat EMPTY with every
			// message still in the table (see repairChatPointers), so the pointers retreat
			// off the rows about to go rather than being repaired afterwards.
			const gone = new Set(dropped.map((row) => row.id as string));
			const pointers: Record<string, unknown> & { id: string } = { id: chat.id };
			if (chat.active_leaf_id && gone.has(chat.active_leaf_id)) pointers.activeLeafId = rows[0].id;
			if (chat.canon_leaf_id && gone.has(chat.canon_leaf_id)) pointers.canonLeafId = null;
			// The card lost its opening entirely: the chat is empty until it has one again.
			if (greetings.length === 0) {
				pointers.rootMessageId = null;
				pointers.activeLeafId = null;
				pointers.canonLeafId = null;
			}
			this.updateChat(pointers);
			for (const row of dropped) this.execute('DELETE FROM messages WHERE id = ?', [row.id]);
		}

		const now = Date.now();
		let firstAdded: string | null = null;
		for (let i = kept; i < greetings.length; i++) {
			const id = randomUUID();
			this.insertMessage({
				id,
				chatId: chat.id,
				parentId: null,
				role: 'assistant',
				content: greetings[i],
				createdAt: now + i,
				siblingIndex: i
			});
			firstAdded ??= id;
		}
		// A character that had no opening at all just gained one; the chat has to point at it.
		if (rows.length === 0 && firstAdded) {
			this.updateChat({ id: chat.id, rootMessageId: firstAdded, activeLeafId: firstAdded });
		}
	}

	updateLibraryEntryFavorite(id: string, isFavorite: boolean): void {
		this.execute('UPDATE character_library SET is_favorite = ? WHERE id = ?', [isFavorite ? 1 : 0, id]);
	}

	/** Delete an entry, holding the persona floor on the way: the library always has at least
	 *  one persona, and the active pointer always names a row that exists. Both halves live
	 *  here rather than in the Library views because this is the one door every delete goes
	 *  through (the client's RPC bridge and the assistant's `delete_entity` alike), and a rule
	 *  the assistant can walk around is not a rule. Returns the persona the active pointer
	 *  moved to, or null when it did not move; the callers announce the `settings` scope off
	 *  that, since a moved pointer is a settings write riding a library one. */
	deleteLibraryEntry(id: string): string | null {
		const row = this.select<{ type: string }[]>(
			'SELECT type FROM character_library WHERE id = ?',
			[id]
		)[0];
		if (row?.type !== 'persona') {
			this.execute('DELETE FROM character_library WHERE id = ?', [id]);
			return null;
		}

		// Ordered like getAllLibraryEntries, so the survivor that takes over is the one at the
		// top of the reader's own list rather than an arbitrary row.
		const survivors = this.select<{ id: string }[]>(
			"SELECT id FROM character_library WHERE type = 'persona' AND id != ? ORDER BY updated_at DESC",
			[id]
		);
		if (survivors.length === 0) {
			throw new Error(
				'The app keeps at least one persona and this is the last one. Create another persona first.'
			);
		}

		return this.inTransaction(() => {
			let movedActiveTo: string | null = null;
			if (this.getSetting('activePersonaId') === id) {
				movedActiveTo = survivors[0].id;
				this.setSetting('activePersonaId', movedActiveTo);
			}
			this.execute('DELETE FROM character_library WHERE id = ?', [id]);
			return movedActiveTo;
		});
	}

	// ===== CHARACTER VERSIONS =====

	private mapCharacterVersion(row: { id: string; entry_id: string; name: string; data_json: string; created_at: number; updated_at: number }): unknown {
		return {
			id: row.id,
			entryId: row.entry_id,
			name: row.name,
			data: JSON.parse(row.data_json),
			createdAt: row.created_at,
			updatedAt: row.updated_at
		};
	}

	getAllCharacterVersions(): unknown[] {
		const rows = this.select<{ id: string; entry_id: string; name: string; data_json: string; created_at: number; updated_at: number }[]>(
			'SELECT * FROM character_versions ORDER BY created_at ASC'
		);
		return rows.map((r) => this.mapCharacterVersion(r));
	}

	getCharacterVersion(id: string): unknown {
		const rows = this.select<{ id: string; entry_id: string; name: string; data_json: string; created_at: number; updated_at: number }[]>(
			'SELECT * FROM character_versions WHERE id = ?',
			[id]
		);
		return rows[0] ? this.mapCharacterVersion(rows[0]) : null;
	}

	/** All variant rows of one entry, oldest first. The entry delete cascades them away. */
	getCharacterVersionsByEntry(entryId: string): unknown[] {
		const rows = this.select<{ id: string; entry_id: string; name: string; data_json: string; created_at: number; updated_at: number }[]>(
			'SELECT * FROM character_versions WHERE entry_id = ? ORDER BY created_at ASC',
			[entryId]
		);
		return rows.map((r) => this.mapCharacterVersion(r));
	}

	insertCharacterVersion(version: { id: string; entryId: string; name: string; data: unknown; createdAt: number; updatedAt: number }): void {
		this.execute(
			`INSERT INTO character_versions (id, entry_id, name, data_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[version.id, version.entryId, version.name, JSON.stringify(version.data), version.createdAt, version.updatedAt]
		);
	}

	renameCharacterVersion(id: string, name: string): void {
		this.execute('UPDATE character_versions SET name = ?, updated_at = ? WHERE id = ?', [name, Date.now(), id]);
	}

	deleteCharacterVersion(id: string): void {
		this.execute('DELETE FROM character_versions WHERE id = ?', [id]);
	}

	/** Pin every not-yet-pinned chat of a character to the given version. Runs once,
	 *  when a character is first versioned: the chats played against the pre-version
	 *  state get anchored to the baseline row so they keep exactly what they saw. */
	pinUnpinnedChatsToVersion(entryId: string, versionId: string): void {
		this.execute(
			'UPDATE chats SET character_version_id = ? WHERE character_id = ? AND character_version_id IS NULL',
			[versionId, entryId]
		);
	}

	private mapLibraryEntry(row: { id: string; type: string; data_json: string; is_favorite: number; created_at: number; updated_at: number }): unknown {
		const parsed = JSON.parse(row.data_json) as Record<string, unknown>;
		return {
			id: row.id,
			type: row.type,
			...parsed,
			isFavorite: row.is_favorite === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at
		};
	}

	// ===== LOREBOOKS =====

	private mapLorebook(row: { id: string; data_json: string; created_at: number; updated_at: number }): unknown {
		const parsed = JSON.parse(row.data_json) as Record<string, unknown>;
		return { id: row.id, ...parsed, createdAt: row.created_at, updatedAt: row.updated_at };
	}

	getAllLorebooks(): unknown[] {
		const rows = this.select<{ id: string; data_json: string; created_at: number; updated_at: number }[]>(
			'SELECT * FROM lorebooks ORDER BY updated_at DESC'
		);
		return rows.map((r) => this.mapLorebook(r));
	}

	getLorebook(id: string): unknown {
		const rows = this.select<{ id: string; data_json: string; created_at: number; updated_at: number }[]>(
			'SELECT * FROM lorebooks WHERE id = ?',
			[id]
		);
		return rows[0] ? this.mapLorebook(rows[0]) : null;
	}

	insertLorebook(book: Record<string, unknown>): void {
		const payload = {
			name: book.name,
			scanDepth: book.scanDepth,
			recursiveScanning: book.recursiveScanning,
			maxRecursionSteps: book.maxRecursionSteps,
			caseSensitive: book.caseSensitive,
			matchWholeWords: book.matchWholeWords,
			entries: book.entries,
			extensions: book.extensions
		};
		this.execute('INSERT INTO lorebooks (id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?)', [
			book.id,
			JSON.stringify(payload),
			book.createdAt ?? Date.now(),
			book.updatedAt ?? Date.now()
		]);
	}

	updateLorebook(book: Record<string, unknown>): void {
		const payload = {
			name: book.name,
			scanDepth: book.scanDepth,
			recursiveScanning: book.recursiveScanning,
			maxRecursionSteps: book.maxRecursionSteps,
			caseSensitive: book.caseSensitive,
			matchWholeWords: book.matchWholeWords,
			entries: book.entries,
			extensions: book.extensions
		};
		this.execute('UPDATE lorebooks SET data_json = ?, updated_at = ? WHERE id = ?', [
			JSON.stringify(payload),
			Date.now(),
			book.id
		]);
	}

	deleteLorebook(id: string): void {
		// Just drop the book. A character/persona may keep this id in data.lorebookIds, but
		// every reader resolves links against existing books (prompt-builder, the store's
		// resolveBooks, the assistant, the link picker) and skips ids with no book, so a dangling
		// id is inert, and it's dropped the next time the entry is saved. We deliberately do NOT
		// rewrite character_library here: that cross-table write under the 'lorebooks' sync
		// scope would leave other devices' library caches stale and resurrect the id on a later
		// save. Read-time filtering is the single, consistent source of truth.
		this.execute('DELETE FROM lorebooks WHERE id = ?', [id]);
	}

	// ===== STEERING NOTES =====

	private mapSteeringNote(row: {
		id: string;
		scope: string;
		scope_id: string | null;
		data_json: string;
		created_at: number;
		updated_at: number;
	}): unknown {
		const parsed = JSON.parse(row.data_json) as Record<string, unknown>;
		return {
			id: row.id,
			scope: row.scope,
			scopeId: row.scope_id,
			...parsed,
			createdAt: row.created_at,
			updatedAt: row.updated_at
		};
	}

	/** The payload keys: everything that is NOT its own column. An explicit whitelist,
	 *  like the lorebook writer: a new note field must be named here or it round-trips
	 *  in memory and vanishes the moment the row is rewritten. */
	private steeringNotePayload(note: Record<string, unknown>): string {
		return JSON.stringify({
			title: note.title,
			text: note.text,
			enabled: note.enabled,
			mode: note.mode,
			depth: note.depth,
			role: note.role
		});
	}

	getAllSteeringNotes(): unknown[] {
		const rows = this.select<
			{ id: string; scope: string; scope_id: string | null; data_json: string; created_at: number; updated_at: number }[]
		>('SELECT * FROM steering_notes ORDER BY created_at ASC');
		return rows.map((r) => this.mapSteeringNote(r));
	}

	insertSteeringNote(note: Record<string, unknown>): void {
		this.execute(
			'INSERT INTO steering_notes (id, scope, scope_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
			[
				note.id,
				note.scope,
				note.scopeId ?? null,
				this.steeringNotePayload(note),
				note.createdAt ?? Date.now(),
				note.updatedAt ?? Date.now()
			]
		);
	}

	updateSteeringNote(note: Record<string, unknown>): void {
		// Scope is rewritten too: re-binding a note to another character or chat is an
		// ordinary edit, not a delete-and-recreate.
		this.execute('UPDATE steering_notes SET scope = ?, scope_id = ?, data_json = ?, updated_at = ? WHERE id = ?', [
			note.scope,
			note.scopeId ?? null,
			this.steeringNotePayload(note),
			Date.now(),
			note.id
		]);
	}

	deleteSteeringNote(id: string): void {
		this.execute('DELETE FROM steering_notes WHERE id = ?', [id]);
	}

	// ===== ASSISTANT SESSIONS (Chungus Assistant conversations) =====

	getAllAssistantSessions(): unknown[] {
		const rows = this.select<{ id: string; title: string; chat_id: string | null; created_at: number; updated_at: number; message_count: number }[]>(
			`SELECT s.id, s.title, s.chat_id, s.created_at, s.updated_at, COUNT(m.id) AS message_count
			 FROM assistant_sessions s LEFT JOIN assistant_messages m ON m.session_id = s.id
			 GROUP BY s.id ORDER BY s.updated_at DESC`
		);
		return rows.map((r) => ({ id: r.id, title: r.title, chatId: r.chat_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at, messageCount: r.message_count }));
	}

	insertAssistantSession(session: { id: string; title: string; createdAt: number; updatedAt: number }): void {
		this.execute('INSERT INTO assistant_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [
			session.id,
			session.title,
			session.createdAt,
			session.updatedAt
		]);
	}

	updateAssistantSession(session: { id: string; title?: string; updatedAt?: number; chatId?: string | null }): void {
		const updates: string[] = [];
		const values: unknown[] = [];
		if (session.title !== undefined) {
			updates.push('title = ?');
			values.push(session.title);
		}
		if (session.updatedAt !== undefined) {
			updates.push('updated_at = ?');
			values.push(session.updatedAt);
		}
		if (session.chatId !== undefined) {
			updates.push('chat_id = ?');
			values.push(session.chatId);
		}
		if (!updates.length) return;
		values.push(session.id);
		this.execute(`UPDATE assistant_sessions SET ${updates.join(', ')} WHERE id = ?`, values);
	}

	/** One session's row, or null. The loop uses this to tell "session deleted mid-turn"
	 *  apart from a real insert failure when committing a finished turn. */
	getAssistantSession(id: string): unknown {
		const rows = this.select<{ id: string; title: string; chat_id: string | null; created_at: number; updated_at: number }[]>(
			'SELECT id, title, chat_id, created_at, updated_at FROM assistant_sessions WHERE id = ?',
			[id]
		);
		const r = rows[0];
		return r ? { id: r.id, title: r.title, chatId: r.chat_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at } : null;
	}

	/** The settings snapshot a session runs under, or null when it has never taken a
	 *  turn. Raw JSON: server/assistant/sessionSettings.ts owns the shape. */
	getAssistantSessionSettings(id: string): string | null {
		const rows = this.select<{ settings_json: string | null }[]>('SELECT settings_json FROM assistant_sessions WHERE id = ?', [id]);
		return rows[0]?.settings_json ?? null;
	}

	setAssistantSessionSettings(id: string, json: string): void {
		this.execute('UPDATE assistant_sessions SET settings_json = ? WHERE id = ?', [json, id]);
	}

	deleteAssistantSession(id: string): void {
		const paths = this.imagePathsOfAssistantSession(id);
		// Attached files are owned outright by this session, so their bytes go with it. The
		// rows cascade, though, so collect the paths while they can still be read.
		const filePaths = this.assistantFilePathsOfSession(id);
		this.execute('DELETE FROM assistant_sessions WHERE id = ?', [id]); // assistant_messages + assistant_files cascade
		this.dropOrphanedChatImages(paths);
		for (const path of filePaths) deleteAssistantFileText(path);
	}

	getAssistantMessages(sessionId: string): unknown[] {
		const rows = this.select<{ id: string; session_id: string; role: string; content: string; steps_json: string | null; actions_json: string | null; usage_json: string | null; images_json: string | null; attachments_json: string | null; error: string | null; status: string; created_at: number }[]>(
			// A transcript reads in the order its rows were appended, and rowid says so
			// outright when two land in the same millisecond, rather than leaving the pair
			// to whichever order the index happens to walk them in.
			'SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
			[sessionId]
		);
		// One corrupt JSON cell must not brick the whole tab (this runs at the start of
		// EVERY turn via collectUserImages): the row degrades to a visible error bubble
		// instead, loud in the transcript, fatal to nothing.
		return rows.map((r) => {
			try {
				return {
					id: r.id,
					sessionId: r.session_id,
					role: r.role,
					content: r.content,
					steps: r.steps_json ? JSON.parse(r.steps_json) : undefined,
					actions: r.actions_json ? JSON.parse(r.actions_json) : undefined,
					usage: r.usage_json ? JSON.parse(r.usage_json) : undefined,
					images: r.images_json ? JSON.parse(r.images_json) : undefined,
					attachments: r.attachments_json ? JSON.parse(r.attachments_json) : undefined,
					error: r.error ?? undefined,
					// Only the two abnormal states travel; a committed turn says nothing, so
					// every reader can treat an absent status as "this turn is finished".
					...(r.status !== 'done' ? { status: r.status } : {}),
					createdAt: r.created_at
				};
			} catch (e) {
				console.error(`[db] corrupt assistant message ${r.id}:`, e instanceof Error ? e.message : e);
				// images_json gets its own parse: the attachment roster ("attachment 3") is
				// numbered off these rows, so a corrupt steps/usage cell elsewhere in the row
				// must not silently renumber every attachment after it.
				let images: unknown;
				try {
					images = r.images_json ? JSON.parse(r.images_json) : undefined;
				} catch {
					images = undefined;
				}
				const imagesLost = !!r.images_json && images === undefined;
				// attachments_json likewise: the chips are this row's own record of what rode
				// with it, so a corrupt cell elsewhere must not silently strip them.
				let attachments: unknown;
				try {
					attachments = r.attachments_json ? JSON.parse(r.attachments_json) : undefined;
				} catch {
					attachments = undefined;
				}
				return {
					id: r.id,
					sessionId: r.session_id,
					role: r.role,
					content: r.content,
					...(Array.isArray(images) && images.length ? { images } : {}),
					...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
					...(r.status !== 'done' ? { status: r.status } : {}),
					error:
						'This message failed to load because its stored data is corrupt. Delete it (or the session) to clear the damage.' +
						(imagesLost ? ' Its attachments could not be recovered, so attachment numbering may have shifted.' : ''),
					createdAt: r.created_at
				};
			}
		});
	}

	/** The assistant's full replayed conversation for a session (model-facing context). */
	getAssistantContext(sessionId: string): unknown[] {
		const rows = this.select<{ context_json: string | null }[]>(
			'SELECT context_json FROM assistant_sessions WHERE id = ?',
			[sessionId]
		);
		const raw = rows[0]?.context_json;
		if (!raw) return [];
		// A corrupt row must surface, not silently wipe the assistant's memory of the session,
		// and it must surface ACTIONABLY: a bare SyntaxError with no session id would leave
		// the tab permanently stuck behind a cryptic error. A non-array is exactly as corrupt.
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			throw new Error(
				`Assistant session ${sessionId} has a corrupt stored context (${e instanceof Error ? e.message : 'invalid JSON'}). Delete the session, or start a new tab, to clear it.`
			);
		}
		if (!Array.isArray(parsed)) {
			throw new Error(`Assistant session ${sessionId} has a corrupt stored context (not a message list). Delete the session to clear it.`);
		}
		return parsed;
	}

	setAssistantContext(sessionId: string, messages: unknown[]): void {
		this.execute('UPDATE assistant_sessions SET context_json = ? WHERE id = ?', [JSON.stringify(messages), sessionId]);
	}

	// ----- Attached files (read-only reference material, architecture/chungus-assistant.md) -----

	/** Records one uploaded file. `messageId` is null until the turn it rides is sent. */
	createAssistantFile(file: AssistantFileRow): void {
		this.execute(
			'INSERT INTO assistant_files (id, session_id, message_id, name, kind, bytes, lines, token_estimate, text_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[file.id, file.sessionId, file.messageId, file.name, file.kind, file.bytes, file.lines, file.tokenEstimate, file.textPath, file.createdAt]
		);
	}

	/** Every file of one tab, oldest first: the roster the assistant addresses by id and
	 *  the list the panel draws its chips from. Includes files still staged in the composer
	 *  (message_id null); the caller decides whether those count for its purpose. */
	listAssistantFiles(sessionId: string): AssistantFileRow[] {
		const rows = this.select<AssistantFileDbRow[]>(
			'SELECT * FROM assistant_files WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
			[sessionId]
		);
		return rows.map(assistantFileFromRow);
	}

	getAssistantFile(id: string): AssistantFileRow | null {
		const rows = this.select<AssistantFileDbRow[]>('SELECT * FROM assistant_files WHERE id = ?', [id]);
		return rows[0] ? assistantFileFromRow(rows[0]) : null;
	}

	/** Binds staged files to the turn that carried them. Scoped to the session AND to rows
	 *  still unbound, so a replayed request can never re-home a file that already rode. */
	stampAssistantFiles(sessionId: string, ids: string[], messageId: string): void {
		for (const id of ids) {
			this.execute('UPDATE assistant_files SET message_id = ? WHERE id = ? AND session_id = ? AND message_id IS NULL', [
				messageId,
				id,
				sessionId
			]);
		}
	}

	/** Drops one file and its bytes. A file is named by exactly one row, so there is no
	 *  shared-reference check to make here, unlike a chat image, which several turns can
	 *  point at once branching or forking has copied its attachment list. */
	deleteAssistantFile(id: string): void {
		const file = this.getAssistantFile(id);
		if (!file) return;
		this.execute('DELETE FROM assistant_files WHERE id = ?', [id]);
		deleteAssistantFileText(file.textPath);
	}

	/** Both cascades take the ROWS; the bytes are ours to unlink, so collect the paths first. */
	private assistantFilePathsOfSession(sessionId: string): string[] {
		return this.select<{ text_path: string }[]>('SELECT text_path FROM assistant_files WHERE session_id = ?', [sessionId]).map(
			(r) => r.text_path
		);
	}

	/**
	 * Boot-time GC for assistant-files/: bytes whose row is gone (a session deleted while the
	 * server was down, or a crash between the write and the insert) are referenced by nothing
	 * and reachable by no other sweep. The one-hour age guard protects a file a client
	 * uploaded moments before a restart, exactly like the chat-image sweep's.
	 *
	 * Files still staged in a composer are NOT swept: their row exists, and a half-typed
	 * message that survives a restart must not lose its attachment.
	 */
	sweepAbandonedAssistantFiles(): number {
		const names = listAssistantFileNames();
		if (!names.length) return 0;
		const cutoff = Date.now() - 60 * 60 * 1000;
		const referenced = new Set(
			this.select<{ text_path: string }[]>('SELECT text_path FROM assistant_files').map((r) => r.text_path)
		);
		let swept = 0;
		for (const name of names) {
			const relative = `assistant-files/${name}`;
			if (referenced.has(relative)) continue;
			if (assistantFileModifiedAt(relative) > cutoff) continue;
			deleteAssistantFileText(relative);
			swept += 1;
		}
		if (swept > 0) console.log(`[db] swept ${swept} orphaned assistant file${swept === 1 ? '' : 's'}`);
		return swept;
	}

	/** Drop one assistant message, used when a retry replaces the failed turn's bubble. */
	deleteAssistantMessage(id: string): void {
		const rows = this.select<{ images_json: string | null }[]>('SELECT images_json FROM assistant_messages WHERE id = ?', [id]);
		const paths = rows.flatMap((r) => this.imagePathsIn(r.images_json));
		this.execute('DELETE FROM assistant_messages WHERE id = ?', [id]);
		this.dropOrphanedChatImages(paths);
	}

	/**
	 * Appends one transcript row and returns the moment it was stamped with. The stamp is
	 * taken HERE and never accepted from the caller: `getAssistantMessages` orders by it,
	 * and the two writers sit on different clocks: a browser inserts the user's message,
	 * the loop inserts the turn answering it milliseconds later. Let each side stamp its
	 * own row and any drift between those clocks puts the reply above the message it
	 * answers, permanently, in the stored transcript.
	 */
	insertAssistantMessage(message: { id: string; sessionId: string; role: string; content: string; steps?: unknown; actions?: unknown; usage?: unknown; images?: unknown; error?: string; status?: string }): number {
		const createdAt = Date.now();
		this.execute(
			'INSERT INTO assistant_messages (id, session_id, role, content, steps_json, actions_json, usage_json, images_json, error, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[
				message.id,
				message.sessionId,
				message.role,
				message.content,
				message.steps ? JSON.stringify(message.steps) : null,
				message.actions ? JSON.stringify(message.actions) : null,
				message.usage ? JSON.stringify(message.usage) : null,
				Array.isArray(message.images) && message.images.length ? JSON.stringify(message.images) : null,
				message.error ?? null,
				message.status ?? 'done',
				createdAt
			]
		);
		return createdAt;
	}

	/**
	 * Rewrites a turn's row in place: the assistant loop owns one row from the moment the
	 * turn starts ('running') to the moment it commits ('done'), rewriting it at every step
	 * boundary. Returns false when the row is gone (its session was deleted mid-turn), so
	 * the caller can tell that apart from a real write failure instead of guessing.
	 * Server-only: the loop is the single writer, so this is deliberately not bridged.
	 */
	updateAssistantTurn(turn: { id: string; content: string; steps?: unknown; usage?: unknown; error?: string; status: string }): boolean {
		if (!this.select<{ id: string }[]>('SELECT id FROM assistant_messages WHERE id = ?', [turn.id]).length) return false;
		this.execute('UPDATE assistant_messages SET content = ?, steps_json = ?, usage_json = ?, error = ?, status = ? WHERE id = ?', [
			turn.content,
			turn.steps ? JSON.stringify(turn.steps) : null,
			turn.usage ? JSON.stringify(turn.usage) : null,
			turn.error ?? null,
			turn.status,
			turn.id
		]);
		return true;
	}

	/**
	 * Stamps the resolved workspace-attachment record onto a USER row, once the loop's note
	 * builder has decided each attachment's real mode. Guarded by session and role so a bad
	 * id can never scribble on another session's transcript or on an assistant turn; returns
	 * false when the row is gone (its session deleted between the client's insert and the
	 * turn start), so the caller can tell that apart from a write failure. Server-only:
	 * the loop is the single writer, so this is deliberately not bridged.
	 */
	setAssistantMessageAttachments(id: string, sessionId: string, attachments: unknown[]): boolean {
		if (!this.select<{ id: string }[]>("SELECT id FROM assistant_messages WHERE id = ? AND session_id = ? AND role = 'user'", [id, sessionId]).length) {
			return false;
		}
		this.execute('UPDATE assistant_messages SET attachments_json = ? WHERE id = ?', [
			Array.isArray(attachments) && attachments.length ? JSON.stringify(attachments) : null,
			id
		]);
		return true;
	}

	/**
	 * Boot sweep: a row still marked 'running' belongs to a turn whose process died, and
	 * nothing can resume it. Marking it interrupted keeps the steps it did finish visible and
	 * keeps it out of the retry path: re-running it would repeat every mutation it already
	 * committed, and none of those can be taken back. Returns the count.
	 */
	markInterruptedAssistantTurns(): number {
		const n = this.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM assistant_messages WHERE status = 'running'")[0]?.n ?? 0;
		if (n) this.execute("UPDATE assistant_messages SET status = 'interrupted' WHERE status = 'running'");
		return n;
	}

	// ===== CHAT MEMORY =====

	private mapMemoryState(r: Record<string, unknown>): unknown {
		return {
			chatId: r.chat_id,
			enabled: r.enabled === 1,
			autoExtract: r.auto_extract !== 0,
			config: r.config_json ? JSON.parse(r.config_json as string) : null,
			updatedAt: r.updated_at
		};
	}

	private mapEpisode(r: Record<string, unknown>): unknown {
		return {
			id: r.id,
			chatId: r.chat_id,
			layer: r.layer,
			content: r.content,
			sourceMessageIds: r.source_message_ids ? JSON.parse(r.source_message_ids as string) : [],
			anchorMessageId: r.anchor_message_id ?? null,
			createdAt: r.created_at
		};
	}

	memGetState(chatId: string): unknown {
		const rows = this.select<Record<string, unknown>[]>('SELECT * FROM memory_state WHERE chat_id = ?', [chatId]);
		return rows[0] ? this.mapMemoryState(rows[0]) : null;
	}

	memListEpisodes(chatId: string): unknown[] {
		// rowid tiebreak: a fast build can land several batches in the same millisecond,
		// and downstream ordering (promotion picks "oldest N", recall is chronological)
		// must stay insertion-ordered through created_at ties.
		const rows = this.select<Record<string, unknown>[]>(
			'SELECT * FROM memory_episodes WHERE chat_id = ? ORDER BY layer ASC, created_at ASC, rowid ASC',
			[chatId]
		);
		return rows.map((r) => this.mapEpisode(r));
	}

	/** Fold a config patch onto whatever this chat already has stored. */
	private mergeMemoryConfig(chatId: string, patch: unknown): Record<string, unknown> {
		const row = this.select<{ config_json: string | null }[]>(
			'SELECT config_json FROM memory_state WHERE chat_id = ?',
			[chatId]
		)[0];
		const stored = row?.config_json ? (JSON.parse(row.config_json) as Record<string, unknown>) : {};
		return { ...stored, ...(patch as Record<string, unknown>) };
	}

	memSetState(chatId: string, patch: Record<string, unknown>): void {
		const now = Date.now();
		const exists = this.select<{ chat_id: string }[]>('SELECT chat_id FROM memory_state WHERE chat_id = ?', [chatId]);
		if (!exists.length) {
			this.execute(
				'INSERT INTO memory_state (chat_id, enabled, auto_extract, config_json, updated_at) VALUES (?, ?, ?, ?, ?)',
				[
					chatId,
					patch.enabled ? 1 : 0,
					patch.autoExtract === false ? 0 : 1,
					patch.config ? JSON.stringify(patch.config) : null,
					now
				]
			);
			return;
		}
		const updates: string[] = [];
		const values: unknown[] = [];
		if (patch.enabled !== undefined) {
			updates.push('enabled = ?');
			values.push(patch.enabled ? 1 : 0);
		}
		if (patch.autoExtract !== undefined) {
			updates.push('auto_extract = ?');
			values.push(patch.autoExtract ? 1 : 0);
		}
		if (patch.config !== undefined) {
			updates.push('config_json = ?');
			// MERGE, don't replace. `patch.config` carries only the fields the caller changed
			// (one slider), so a second device editing a different slider keeps its value.
			// Replacing made every write a read-merge-write from a client cache that could be
			// minutes stale, and worse while the other device was mid-build, since its sync
			// reload is skipped whenever it is busy. An explicit null still clears the row.
			values.push(patch.config ? JSON.stringify(this.mergeMemoryConfig(chatId, patch.config)) : null);
		}
		updates.push('updated_at = ?');
		values.push(now);
		values.push(chatId);
		this.execute(`UPDATE memory_state SET ${updates.join(', ')} WHERE chat_id = ?`, values);
	}

	/**
	 * The one invariant every memory write is checked against: **no two episodes of a chat
	 * may cover the same message**.
	 *
	 * This replaced a compare-and-swap on a stored cursor. The cursor is derived now
	 * (src/lib/memory/branching.ts resolveCoverage tiles the active path with episode
	 * coverage), and a derived boundary is only well-defined while coverage is unique:
	 * two summaries claiming one turn would both render in recall and make the tiling walk
	 * pick arbitrarily. It is also a strictly better guard than the CAS was: it catches a
	 * double-fold from any source (a raced run, another device, a chat copy) rather than
	 * only one that moved a cursor.
	 *
	 * Call inside the transaction, AFTER the step's own deletes: a promotion legitimately
	 * covers exactly what the episodes it just consumed did.
	 */
	private memAssertNoOverlap(chatId: string, sourceMessageIds: unknown): void {
		const incoming = new Set(Array.isArray(sourceMessageIds) ? (sourceMessageIds as string[]) : []);
		if (incoming.size === 0) return;
		const rows = this.select<{ id: string; source_message_ids: string | null }[]>(
			'SELECT id, source_message_ids FROM memory_episodes WHERE chat_id = ?',
			[chatId]
		);
		for (const row of rows) {
			const ids: string[] = row.source_message_ids ? JSON.parse(row.source_message_ids) : [];
			const hit = ids.find((id) => incoming.has(id));
			if (hit !== undefined) {
				throw new Error(
					`mem-op-superseded: episode ${row.id} already covers message ${hit} (concurrent update)`
				);
			}
		}
	}

	memApplyBatch(chatId: string, result: Record<string, any>): void {
		const now = Date.now();
		const tx = this.db.transaction(() => {
			// The engine fails loud rather than committing an unusable episode, so a batch
			// without one is a bug upstream, not a case to absorb: it would move the boundary
			// over turns nothing covers, which is exactly the gap the design must not have.
			if (!result.episode) throw new Error('memApplyBatch: batch carries no episode, refusing to fold');
			// Dormant summaries of the same span, written on a branch this fold abandons.
			// They go first so the overlap check below sees only genuine conflicts.
			for (const id of (result.supersedeEpisodeIds ?? []) as string[]) {
				this.execute('DELETE FROM memory_episodes WHERE id = ? AND chat_id = ?', [id, chatId]);
			}
			this.memAssertNoOverlap(chatId, result.episode.sourceMessageIds);
			this.execute(
				`INSERT INTO memory_episodes (id, chat_id, layer, content, source_message_ids, anchor_message_id, created_at)
				 VALUES (?, ?, 0, ?, ?, ?, ?)`,
				[crypto.randomUUID(), chatId, result.episode.content, JSON.stringify(result.episode.sourceMessageIds ?? []), result.episode.anchorMessageId ?? null, now]
			);
			this.execute('UPDATE memory_state SET updated_at = ? WHERE chat_id = ?', [now, chatId]);
		});
		tx();
	}

	memApplyPromotion(chatId: string, result: Record<string, any>): void {
		const now = Date.now();
		const ins = result.insert;
		const delIds: string[] = result.deleteEpisodeIds ?? [];
		const tx = this.db.transaction(() => {
			// Keep chronology: the merged episode inherits the newest covered timestamp.
			// The COUNT doubles as a supersede guard: if any source episode is already gone
			// (a reap or another device's promotion consumed it), merging the leftovers
			// would duplicate their coverage, so reject the whole step instead.
			let createdAt = now;
			if (delIds.length) {
				const ph = delIds.map(() => '?').join(',');
				const rows = this.select<{ n: number; mx: number | null }[]>(
					`SELECT COUNT(*) AS n, MAX(created_at) AS mx FROM memory_episodes WHERE chat_id = ? AND id IN (${ph})`,
					[chatId, ...delIds]
				);
				if ((rows[0]?.n ?? 0) !== delIds.length) {
					throw new Error('mem-op-superseded: episodes to merge changed (concurrent update)');
				}
				if (rows[0]?.mx != null) createdAt = rows[0].mx;
			}
			for (const id of delIds) this.execute('DELETE FROM memory_episodes WHERE id = ? AND chat_id = ?', [id, chatId]);
			// After the deletes: the merge covers exactly what its sources did, so checking
			// before them would flag the step against itself.
			this.memAssertNoOverlap(chatId, ins.sourceMessageIds);
			this.execute(
				`INSERT INTO memory_episodes (id, chat_id, layer, content, source_message_ids, anchor_message_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					crypto.randomUUID(),
					chatId,
					ins.layer,
					ins.content,
					JSON.stringify(ins.sourceMessageIds ?? []),
					ins.anchorMessageId ?? null,
					createdAt
				]
			);
		});
		tx();
	}

	/**
	 * Delete episodes that can never apply to this chat again: a turn they cover was
	 * deleted, or was rewritten after the summary was written.
	 *
	 * Plain deletes with no guard, deliberately. There is no boundary to keep in step (it
	 * is derived from whatever survives) and the operation is idempotent, so a reap racing
	 * a fold cannot corrupt either: the fold's own overlap check still holds, and a second
	 * reap of the same ids is a no-op. This is the ONLY delete path that isn't part of a
	 * step that replaces what it removes. Branch changes never reach it.
	 */
	memReapEpisodes(chatId: string, episodeIds: string[]): void {
		if (!episodeIds?.length) return;
		const now = Date.now();
		const tx = this.db.transaction(() => {
			for (const id of episodeIds) this.execute('DELETE FROM memory_episodes WHERE id = ? AND chat_id = ?', [id, chatId]);
			this.execute('UPDATE memory_state SET updated_at = ? WHERE chat_id = ?', [now, chatId]);
		});
		tx();
	}

	/** Rewrite one episode's text. Coverage is untouched (only the prose the model reads
	 *  changes), so this needs no guard: it can neither open a gap nor move the boundary.
	 *  Deleting an episode by hand deliberately has no method; that WOULD open a gap. */
	memUpdateEpisodeContent(chatId: string, episodeId: string, content: string): void {
		this.execute('UPDATE memory_episodes SET content = ? WHERE id = ? AND chat_id = ?', [content, episodeId, chatId]);
	}

	memReset(chatId: string): void {
		const now = Date.now();
		const tx = this.db.transaction(() => {
			this.execute('DELETE FROM memory_episodes WHERE chat_id = ?', [chatId]);
			// The insert branch only fires for a chat that was never enabled: reset wipes
			// derived memory, it must not silently switch the engine on.
			this.execute(
				`INSERT INTO memory_state (chat_id, enabled, updated_at) VALUES (?, 0, ?)
				 ON CONFLICT(chat_id) DO UPDATE SET updated_at = excluded.updated_at`,
				[chatId, now]
			);
		});
		tx();
	}

	// ===== PROMPT DEBUG LOG (server-internal, used only by server/promptLog.ts, not bridged) =====

	/** Insert one entry and prune the oldest rows past `cap` in the same transaction. */
	insertPromptLogEntry(id: string, startedAt: number, entry: string, cap: number): void {
		this.inTransaction(() => {
			this.execute('INSERT OR REPLACE INTO prompt_log (id, started_at, entry) VALUES (?, ?, ?)', [id, startedAt, entry]);
			this.execute(
				'DELETE FROM prompt_log WHERE id IN (SELECT id FROM prompt_log ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?)',
				[cap]
			);
		});
	}

	getPromptLogEntry(id: string): string | null {
		const rows = this.select<{ entry: string }[]>('SELECT entry FROM prompt_log WHERE id = ?', [id]);
		return rows[0]?.entry ?? null;
	}

	updatePromptLogEntry(id: string, entry: string): void {
		this.execute('UPDATE prompt_log SET entry = ? WHERE id = ?', [entry, id]);
	}

	/** Every stored entry, newest first. */
	getAllPromptLogEntries(): string[] {
		return this.select<{ entry: string }[]>('SELECT entry FROM prompt_log ORDER BY started_at DESC, rowid DESC').map((r) => r.entry);
	}

	clearPromptLog(): void {
		this.execute('DELETE FROM prompt_log');
	}

}

export const serverDb = new ServerDatabase();

// Methods the client may invoke over the RPC bridge, grouped by the sync scope a
// successful mutation should broadcast. Read-only methods are not listed here.
// The scope vocabulary lives in shared/sync.ts, so a scope the client cannot handle
// is a compile error here rather than a device that quietly stops refreshing.
export const MUTATION_SCOPES: Record<string, SyncScope> = {
	insertChat: 'chats',
	updateChat: 'chats',
	updateChatActiveLeaf: 'chats',
	updateChatFavorite: 'chats',
	// Bookkeeping the client only ever writes (what the card handed this chat), so the hint
	// it carries costs another device one chat-list refetch and nothing else.
	setChatSeededGreetings: 'chats',
	touchChatActivity: 'chats',
	deleteChat: 'chats',
	// Writes messages (and optionally memory) too, but one method carries one scope and
	// 'chats' is the one that matters: sync.ts reloads chatStore + chatCastStore for it,
	// which is exactly what a new chat needs on another device. A copied chat is never
	// the open chat anywhere, so its memory loads on first open like any other chat's.
	duplicateChat: 'chats',
	insertMessage: 'messages',
	updateMessageContent: 'messages',
	applyMessageContinuation: 'messages',
	updateMessagePersona: 'messages',
	updateMessageSpriteLabel: 'messages',
	setChatUserPersona: 'messages',
	updateMessageBranchLabel: 'messages',
	deleteMessageOnly: 'messages',
	deleteMessageAndDescendants: 'messages',
	deleteDescendants: 'messages',
	setSetting: 'settings',
	deleteSetting: 'settings',
	upsertChatDraft: 'drafts',
	deleteChatDraft: 'drafts',
	addInputHistory: 'inputHistory',
	clearInputHistory: 'inputHistory',
	// Nothing on another device draws this row. It rides the `library` scope because an import
	// is writing library entries around it anyway, and a mutation with no scope has no shape here.
	recordImportedSources: 'library',
	setConnectionCredentials: 'settings',
	deleteConnectionCredentials: 'settings',
	copyConnectionCredentials: 'settings',
	insertLibraryEntry: 'library',
	updateLibraryEntry: 'library',
	updateLibraryEntryFavorite: 'library',
	deleteLibraryEntry: 'library',
	insertCharacterVersion: 'library',
	renameCharacterVersion: 'library',
	deleteCharacterVersion: 'library',
	pinUnpinnedChatsToVersion: 'chats',
	insertLorebook: 'lorebooks',
	updateLorebook: 'lorebooks',
	deleteLorebook: 'lorebooks',
	insertSteeringNote: 'steering',
	updateSteeringNote: 'steering',
	deleteSteeringNote: 'steering',
	insertAssistantSession: 'assistant',
	updateAssistantSession: 'assistant',
	deleteAssistantSession: 'assistant',
	insertAssistantMessage: 'assistant',
	deleteAssistantMessage: 'assistant',
	memSetState: 'memory',
	memApplyBatch: 'memory',
	memApplyPromotion: 'memory',
	memReapEpisodes: 'memory',
	memUpdateEpisodeContent: 'memory',
	memReset: 'memory'
};

// Every method the bridge is allowed to dispatch (reads + mutations).
const READ_METHODS = [
	'getAllChats', 'getChat', 'getMessagesByChat', 'getMessageCounts', 'getLastPersonaByChat',
	'getLastUserMessageTimes',
	'getChatListStats', 'getChatContentGroups', 'searchChatMessages', 'getChatMemoryFootprint',
	'getUserStats',
	'getMessage', 'getNextSiblingIndex', 'getSetting', 'getChatDraft', 'getInputHistory', 'getConnectionCredentials',
	'getImportedSources',
	'getAllLibraryEntries', 'getLibraryEntry',
	'getAllCharacterVersions', 'getCharacterVersion',
	'getAllLorebooks', 'getLorebook',
	'getAllSteeringNotes',
	'getAllAssistantSessions', 'getAssistantMessages',
	'memGetState', 'memListEpisodes'
];

export const ALLOWED_DB_METHODS = new Set([...READ_METHODS, ...Object.keys(MUTATION_SCOPES)]);

export function callDbMethod(method: string, args: unknown[]): unknown {
	if (!ALLOWED_DB_METHODS.has(method)) {
		throw new Error(`Unknown db method: ${method}`);
	}
	const fn = (serverDb as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
	return fn.apply(serverDb, args);
}
