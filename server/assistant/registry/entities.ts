/**
 * The entity registry: the single source of truth for ChungusHub's data model.
 *
 * Each entity lists its fields once (with model-facing descriptions) and, when
 * addressable, supplies a thin storage adapter. Everything else (the generic tool
 * schemas, the field enums, the system-prompt data-model section, the persona-only
 * field restriction) is derived from this file. A new field or entity is added
 * here and nowhere else.
 */
import { serverDb } from '../../db';
import { deleteImage } from '../../files';
import { ToolError, str, splitTags } from './util';
import { SETTINGS, getSetting as getSettingDef, type SettingDef } from './settings';
import { listEnabledSkills, getSkill, type Skill } from './skills';
import type { RawLibraryEntry, RawLorebookBook, RawMessage } from '../rows';
import type { EntityDef, EntityFlat, FieldDef, FieldValue, ListScope } from './types';

/** A delete confirm sentinel for entities whose title is not unique (messages). */
export const DELETE_SENTINEL = 'DELETE';

// ===== Library entries (character + persona share one table, differ by field set) =====

/**
 * The character-only fields, declared once as full FieldDefs. The factory spreads
 * these into the character entity's field list, and the trait keys below are derived
 * from them, so a new character field is added here and nowhere else.
 */
const CHARACTER_TRAIT_FIELDS: FieldDef[] = [
	{ key: 'personality', label: 'Personality', describe: 'Personality, voice, mannerisms, temperament.', type: 'text', editable: true, searchable: true },
	{ key: 'scenario', label: 'Scenario', describe: 'The setting and situation the roleplay takes place in.', type: 'text', editable: true, searchable: true },
	{ key: 'firstMessage', label: 'First message', describe: 'Opening message that starts the scene.', type: 'text', editable: true, searchable: true },
	{ key: 'exampleDialogue', label: 'Example dialogue', describe: 'Sample exchanges showing how the character speaks.', type: 'text', editable: true, searchable: true },
	{ key: 'creator', label: 'Creator', describe: 'Who created this character card.', type: 'string', editable: true, searchable: true },
	{ key: 'creatorNotes', label: 'Creator notes', describe: "Creator's notes on how to use the character.", type: 'text', editable: true, searchable: true },
	{ key: 'systemPrompt', label: 'System prompt', describe: "The card's own system-prompt override.", type: 'text', editable: true, searchable: true },
	{ key: 'postHistoryInstructions', label: 'Post-history instructions', describe: 'Instructions injected after the chat history (a.k.a. jailbreak).', type: 'text', editable: true, searchable: true },
	{ key: 'characterVersion', label: 'Character version', describe: 'Free-form version tag for the card.', type: 'string', editable: true, searchable: true }
];
/** Derived from the field defs above: the character trait keys, in reading order. */
const CHARACTER_TRAIT_KEYS = CHARACTER_TRAIT_FIELDS.map((f) => f.key);

/** Lives on identity, not in traits, so it stays out of CHARACTER_TRAIT_FIELDS. It is
 *  character-only all the same: the persona editor has no tag UI, so personas never carry any. */
const TAGS_FIELD: FieldDef = { key: 'tags', label: 'Tags', describe: 'Comma-separated organizational tags.', type: 'string', editable: true, summary: true, searchable: true };

function loadLibraryRaw(kind: 'character' | 'persona', id: string): RawLibraryEntry | null {
	const raw = serverDb.getLibraryEntry(id) as RawLibraryEntry | null;
	if (!raw || raw.type !== kind) return null;
	if (!raw.data) raw.data = { traits: {} };
	if (!raw.data.traits) raw.data.traits = {};
	return raw;
}

function flattenLibraryEntry(raw: RawLibraryEntry, kind: 'character' | 'persona'): EntityFlat {
	const t = raw.data.traits ?? {};
	const fields: Record<string, FieldValue> = { name: str(raw.identity.name) };
	if (kind === 'character') fields.tags = (raw.identity.tags ?? []).join(', ');
	fields.description = str(t.description);
	if (kind === 'character') {
		for (const key of CHARACTER_TRAIT_KEYS) fields[key] = str(t[key]);
	}
	return { id: raw.id, kind, fields, title: str(raw.identity.name) || `(unnamed ${kind})` };
}

/**
 * Project a character version's stored `data` into the same flat field record a
 * character read returns. Name and tags live on identity and are NOT versioned, so a
 * version exposes only its trait fields. This is what read_character_versions hands
 * back for a parked variant.
 */
export function characterVersionFields(data: { traits?: Record<string, string> }): Record<string, FieldValue> {
	const t = data.traits ?? {};
	const fields: Record<string, FieldValue> = { description: str(t.description) };
	for (const key of CHARACTER_TRAIT_KEYS) fields[key] = str(t[key]);
	return fields;
}

function writeLibraryField(raw: RawLibraryEntry, key: string, value: FieldValue): void {
	const v = value == null ? '' : String(value);
	if (key === 'name') raw.identity.name = v;
	else if (key === 'tags') raw.identity.tags = splitTags(v);
	else raw.data.traits[key] = v;
}

function libraryEntity(kind: 'character' | 'persona', describe: string): EntityDef {
	const characterOnly = kind === 'character';
	return {
		kind,
		describe,
		addressable: true,
		ops: { create: true, edit: true, delete: true, bulk: true },
		scope: 'library',
		fields: [
			{ key: 'name', label: 'Name', describe: 'Display name.', type: 'string', editable: true, summary: true, searchable: true },
			...(characterOnly ? [TAGS_FIELD] : []),
			{
				key: 'description',
				label: 'Description',
				describe: characterOnly
					? 'Who the character is: appearance, presence, how they carry themselves.'
					: 'The ONE field for a persona: pack everything about the protagonist (looks, voice, manner) in here.',
				type: 'text',
				editable: true,
				searchable: true
			},
			...(characterOnly ? CHARACTER_TRAIT_FIELDS : [])
		],

		read(id) {
			const raw = loadLibraryRaw(kind, id);
			return raw ? flattenLibraryEntry(raw, kind) : null;
		},

		list() {
			const all = serverDb.getAllLibraryEntries() as RawLibraryEntry[];
			return all.filter((e) => e.type === kind).map((e) => flattenLibraryEntry(e, kind));
		},

		create(fields) {
			const name = str(fields.name).trim();
			if (!name) throw new ToolError(`create_entity requires a name for the ${kind}.`);
			const now = Date.now();
			// `background` is a CharacterTraits field the UI owns; the assistant does not manage it
			// (deliberately not a registry FieldDef), so seed it empty for schema parity only.
			const traits: Record<string, string> = { description: str(fields.description), background: '' };
			if (characterOnly) {
				for (const key of CHARACTER_TRAIT_KEYS) traits[key] = str(fields[key]);
			}
			const raw: RawLibraryEntry = {
				id: crypto.randomUUID(),
				type: kind,
				identity: { name, tags: splitTags(fields.tags) },
				data: { traits },
				isFavorite: false,
				createdAt: now,
				updatedAt: now
			};
			serverDb.insertLibraryEntry(raw);
			return flattenLibraryEntry(raw, kind);
		},

		write(id, patch, ctx) {
			const raw = loadLibraryRaw(kind, id);
			if (!raw) throw new ToolError(`No ${kind} with id "${id}".`);
			for (const [key, value] of Object.entries(patch)) writeLibraryField(raw, key, value);
			raw.updatedAt = Date.now();
			// A rewritten `firstMessage` reaches the openings of chats that are still nothing
			// but this character's greetings (server/db.ts refreshSeededGreetings). Those are
			// message rows, and the caller only announces this entity's own `library` scope.
			const refreshed = serverDb.updateLibraryEntry(raw);
			if (refreshed.length) ctx.broadcast('messages');
		},

		remove(id, _opts, ctx) {
			const raw = loadLibraryRaw(kind, id);
			if (!raw) throw new ToolError(`No ${kind} with id "${id}".`);
			// The entry owns its art (every source is COPIED into images/characters|personas/),
			// so its files go with the row, the same set the library store sweeps. An upload
			// made in the editor is already on the entry, so the row names every file there is
			// to delete; no sweep anywhere else can reach `images/characters|personas/` (the
			// boot sweep is scoped to images/chat/), so one missed here sits on disk forever.
			const files = new Set(
				[
					raw.identity.imageUrl,
					...(raw.identity.gallery ?? []),
					...(raw.identity.sprites ?? []).map((sprite) => sprite.path)
				].filter((p): p is string => !!p)
			);
			// The row goes first, because it is the only step here that can refuse: the last
			// persona is undeletable (server/db.ts), and a sweep that ran ahead of that would
			// have stripped the art off an entry still sitting in the library.
			const movedActiveTo = serverDb.deleteLibraryEntry(id);
			for (const path of files) deleteImage(path);
			// The delete took the active persona with it and another one took over, which the
			// caller's `library` hint does not cover.
			if (movedActiveTo) ctx.broadcast('settings');
		},

		confirmToken(flat) {
			return String(flat.fields.name ?? '');
		}
	};
}

// ===== Messages =====

function flattenMessage(raw: RawMessage): EntityFlat {
	return {
		id: raw.id,
		kind: 'message',
		fields: {
			content: str(raw.content),
			personaId: raw.personaId ?? null,
			role: raw.role,
			chatId: raw.chatId,
			parentId: raw.parentId ?? null
		},
		title: `${raw.role} message`
	};
}

const messageEntity: EntityDef = {
	kind: 'message',
	describe: 'A single roleplay turn inside a chat.',
	note: 'Edits overwrite the message in place (no branching). `personaId` is the persona a user message was sent with, locked at send time. Rebind it to attribute orphaned ("You") messages to a persona.',
	addressable: true,
	ops: { create: false, edit: true, delete: true, bulk: true },
	scope: 'messages',
	fields: [
		{ key: 'content', label: 'Content', describe: 'The message text.', type: 'text', editable: true, searchable: true, summary: true },
		{ key: 'personaId', label: 'Persona id', describe: 'Id of the persona this user message is attributed to; null means unattributed ("You").', type: 'string', editable: true, summary: true },
		{ key: 'role', label: 'Role', describe: 'Who sent it: user, assistant, or system. Read-only.', type: 'enum', enumValues: ['user', 'assistant', 'system'], editable: false, summary: true },
		{ key: 'chatId', label: 'Chat id', describe: 'The chat this message belongs to. Read-only.', type: 'string', editable: false },
		{ key: 'parentId', label: 'Parent id', describe: 'The message it replies to. Read-only.', type: 'string', editable: false }
	],

	read(id) {
		const raw = serverDb.getMessage(id) as RawMessage | null;
		return raw ? flattenMessage(raw) : null;
	},

	list(_ctx, scope: ListScope) {
		if (scope.chatId) {
			// A nonexistent chat must not read as an empty one: "Found 0 messages" over a
			// stale id sends the model (and the user) down the wrong path.
			if (!serverDb.getChat(scope.chatId)) {
				throw new ToolError(`No chat with id "${scope.chatId}". Use list_chats or search_chats to find the right id.`);
			}
			return (serverDb.getMessagesByChat(scope.chatId) as RawMessage[]).map(flattenMessage);
		}
		// No chat scope: sweep every chat. Fine for a local single-user workspace;
		// the capability layer caps how many rows it acts on.
		const chats = serverDb.getAllChats() as { id: string }[];
		const out: EntityFlat[] = [];
		for (const chat of chats) {
			for (const m of serverDb.getMessagesByChat(chat.id) as RawMessage[]) out.push(flattenMessage(m));
		}
		return out;
	},

	write(id, patch, _ctx, opts) {
		const raw = serverDb.getMessage(id) as RawMessage | null;
		if (!raw) throw new ToolError(`No message with id "${id}".`);
		if ('content' in patch) {
			// The quiet door: a MINOR save stamps `minor_edited_at` instead of `edited_at`, so
			// chat memory keeps the summary over this turn (architecture/memory.md coupling 8).
			// The caller asserts it; nothing here reads the text to decide.
			serverDb.updateMessageContent(id, patch.content == null ? '' : String(patch.content), opts?.minor ? { minor: true } : undefined);
		}
		if ('personaId' in patch) {
			const personaId = patch.personaId == null || patch.personaId === '' ? null : String(patch.personaId);
			if (personaId) {
				if (raw.role !== 'user') throw new ToolError(`Only user messages can be attributed to a persona; message "${id}" is a ${raw.role} message.`);
				const target = serverDb.getLibraryEntry(personaId) as { type?: string } | null;
				if (!target) throw new ToolError(`No library entry with id "${personaId}" to attribute the message to.`);
				if (target.type !== 'persona') throw new ToolError(`Id "${personaId}" is a ${target.type}, not a persona: only personas can be attributed to messages.`);
			}
			serverDb.updateMessagePersona(id, personaId);
		}
	},

	remove(id, opts) {
		const raw = serverDb.getMessage(id) as RawMessage | null;
		if (!raw) throw new ToolError(`No message with id "${id}".`);
		if (opts.scope === 'with_descendants') serverDb.deleteMessageAndDescendants(id);
		else serverDb.deleteMessageOnly(id);
	},

	confirmToken() {
		return DELETE_SENTINEL;
	}
};

// ===== Lorebooks (standalone, addressable; their entries are managed by dedicated tools) =====

function flattenLorebook(raw: RawLorebookBook): EntityFlat {
	return {
		id: raw.id,
		kind: 'lorebook',
		fields: { name: str(raw.name), entryCount: Array.isArray(raw.entries) ? raw.entries.length : 0, everyChat: !!raw.global },
		title: str(raw.name) || '(untitled lorebook)'
	};
}

const lorebookEntity: EntityDef = {
	kind: 'lorebook',
	describe: 'A standalone lorebook (world-info book): a named set of entries injected into a chat when their keywords appear.',
	note: 'Rename/delete the book with the generic entity tools; its entries and settings through the Lorebook tools. A chat injects the books in every chat, the ones its character and persona link, and the ones it attached itself, less any it muted.',
	addressable: true,
	ops: { create: true, edit: true, delete: true, bulk: false },
	scope: 'lorebooks',
	fields: [
		{ key: 'name', label: 'Name', describe: 'Book title.', type: 'string', editable: true, summary: true, searchable: true },
		{ key: 'entryCount', label: 'Entries', describe: 'How many entries it holds.', type: 'number', editable: false, summary: true },
		{ key: 'everyChat', label: 'In every chat', describe: 'In every chat with nothing linking it (configure_lorebooks sets it).', type: 'boolean', editable: false, summary: true }
	],

	read(id) {
		const raw = serverDb.getLorebook(id) as RawLorebookBook | null;
		return raw ? flattenLorebook(raw) : null;
	},

	list() {
		return (serverDb.getAllLorebooks() as RawLorebookBook[]).map(flattenLorebook);
	},

	create(fields) {
		const name = str(fields.name).trim();
		if (!name) throw new ToolError('create_entity requires a name for the lorebook.');
		const now = Date.now();
		// All activation knobs at null = inherit the global settings, matching the UI's new-book defaults.
		const raw: RawLorebookBook = {
			id: crypto.randomUUID(),
			name,
			scanDepth: null,
			recursiveScanning: null,
			maxRecursionSteps: null,
			caseSensitive: null,
			matchWholeWords: null,
			entries: [],
			extensions: {},
			createdAt: now,
			updatedAt: now
		};
		serverDb.insertLorebook(raw);
		return flattenLorebook(raw);
	},

	write(id, patch) {
		const raw = serverDb.getLorebook(id) as RawLorebookBook | null;
		if (!raw) throw new ToolError(`No lorebook with id "${id}".`);
		if ('name' in patch) raw.name = patch.name == null ? '' : String(patch.name);
		serverDb.updateLorebook(raw);
	},

	remove(id) {
		const raw = serverDb.getLorebook(id) as RawLorebookBook | null;
		if (!raw) throw new ToolError(`No lorebook with id "${id}".`);
		serverDb.deleteLorebook(id);
	},

	confirmToken(flat) {
		return String(flat.fields.name ?? '');
	}
};

function flattenSetting(s: SettingDef): EntityFlat {
	return { id: s.id, kind: 'setting', title: s.label, fields: { label: s.label, category: s.tab, description: s.describe } };
}

/** A read-only, addressable entity: find_entities/read_entity explain a setting, the
 *  generic write ops all reject it (ops are false), and navigate deep-links to it. The whole
 *  KIND rides the Navigation family (`group`): switching that family off removes the settings
 *  surface entirely, catalog reads included, not just the `navigate` tool. */
const settingEntity: EntityDef = {
	kind: 'setting',
	describe: "A read-only catalog of the app's own settings: what each does and which tab it lives in.",
	note: 'Explain one with read_entity / find_entities kind:setting; take the user to it with navigate target:setting.',
	addressable: true,
	group: 'navigation',
	ops: { create: false, edit: false, delete: false, bulk: false },
	scope: 'settings',
	fields: [
		{ key: 'label', label: 'Label', describe: "The setting's name in the UI.", type: 'string', editable: false, summary: true, searchable: true },
		{ key: 'category', label: 'Category', describe: 'Which settings tab it lives in.', type: 'string', editable: false, summary: true, searchable: true },
		{ key: 'description', label: 'Description', describe: 'What the setting does.', type: 'text', editable: false, searchable: true }
	],
	read(id) {
		const s = getSettingDef(id);
		return s ? flattenSetting(s) : null;
	},
	list() {
		return SETTINGS.map(flattenSetting);
	}
};

function flattenSkill(s: Skill): EntityFlat {
	// body is a non-summary field: present for full reads + the search haystack,
	// but never dumped into find/list results.
	return { id: s.id, kind: 'skill', title: s.name, fields: { name: s.name, description: s.description, body: s.body } };
}

/** Read-only, addressable: the assistant reads a skill's body before specialized work.
 *  Skills are managed by the user in Assistant Settings, never by the assistant;
 *  disabled skills are invisible here entirely. */
const skillEntity: EntityDef = {
	kind: 'skill',
	describe: 'A procedural guide you follow for one kind of specialized work. The system prompt lists the index; read the body before doing that work.',
	note: 'Read one with read_entity kind:skill (the body is only in a full read). The user manages skills in Assistant Settings. You never write them.',
	addressable: true,
	ops: { create: false, edit: false, delete: false, bulk: false },
	scope: 'settings',
	fields: [
		{ key: 'name', label: 'Name', describe: 'Skill title.', type: 'string', editable: false, summary: true, searchable: true },
		{ key: 'description', label: 'Description', describe: 'When to use this skill.', type: 'text', editable: false, summary: true, searchable: true },
		{ key: 'body', label: 'Body', describe: 'The full guide to follow.', type: 'text', editable: false, searchable: true }
	],
	read(id) {
		const s = getSkill(id);
		return s && s.enabled ? flattenSkill(s) : null;
	},
	list() {
		return listEnabledSkills().map(flattenSkill);
	}
};

const chatEntity: EntityDef = {
	kind: 'chat',
	describe: 'A roleplay conversation bound to exactly one character; the active persona is global.',
	note: 'Read with read_chat_context (character + persona + linked lorebooks) and read_chat_messages (the turns); search across all chats with search_chats.',
	addressable: false,
	fields: [
		{ key: 'title', label: 'Title', describe: 'Chat name.', type: 'string', editable: false, summary: true },
		{ key: 'characterId', label: 'Character id', describe: 'The library character this chat is bound to.', type: 'string', editable: false }
	]
};

// ===== Registry =====

export const ENTITIES: EntityDef[] = [
	libraryEntity('character', 'An AI-played character with the full character-card field set; can link lorebooks.'),
	libraryEntity('persona', "The user's protagonist, a single free-text description. One is globally active."),
	messageEntity,
	lorebookEntity,
	chatEntity,
	settingEntity,
	skillEntity
];

/** Entities reachable through the generic entity tools (have a storage adapter). */
export const ADDRESSABLE_KINDS = ENTITIES.filter((e) => e.addressable).map((e) => e.kind);

/** Addressable kinds create_entity can make (messages are born from roleplay, not the assistant). */
export const CREATABLE_KINDS = ENTITIES.filter((e) => e.addressable && e.ops?.create).map((e) => e.kind);

const BY_KIND = new Map(ENTITIES.map((e) => [e.kind, e]));

export function getEntity(kind: string): EntityDef {
	const def = BY_KIND.get(kind);
	if (!def) throw new ToolError(`Unknown entity kind "${kind}". Known kinds: ${ENTITIES.map((e) => e.kind).join(', ')}.`);
	return def;
}

/** An addressable entity, or a loud error naming the ones that exist. */
export function getAddressable(kind: string): EntityDef {
	const def = getEntity(kind);
	if (!def.addressable || !def.read) {
		throw new ToolError(`"${kind}" is not directly addressable. Addressable kinds: ${ADDRESSABLE_KINDS.join(', ')}.`);
	}
	return def;
}

/** The editable FieldDef for a kind, or a loud error listing the valid fields. */
export function editableField(def: EntityDef, key: string) {
	const field = def.fields.find((f) => f.key === key);
	if (!field) {
		const valid = def.fields.filter((f) => f.editable).map((f) => f.key).join(', ');
		throw new ToolError(`"${key}" is not a field of ${def.kind}. Editable fields: ${valid}.`);
	}
	if (!field.editable) throw new ToolError(`"${key}" is read-only on ${def.kind} and cannot be edited.`);
	return field;
}
