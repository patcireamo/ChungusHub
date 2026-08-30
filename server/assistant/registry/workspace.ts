/**
 * Workspace orchestration capabilities: actions on the workspace's own state rather than
 * one entity's fields, namely which persona is globally active and what a chat is called.
 *
 * The settings DOCTRINE is untouched by these: app settings stay explain-and-navigate
 * only. Active persona and chat titles are story-workspace state, the things a user
 * asks the assistant to drive as their operator, not configuration knobs.
 */
import { serverDb, chatGreetingsOf } from '../../db';
import type { Capability } from './types';
import type { RawChat, RawLibraryEntry } from '../rows';
import { requireChatId } from './chat-reads';
import { stampState } from '../freshness';
import { ToolError, str, requireStr, clampInt, ok } from './util';

/** The persona a switch is aimed at, with every refusal the switch itself would make, so a
 *  card never offers a switch the call is going to reject. */
function loadPersonaToActivate(personaId: unknown): RawLibraryEntry {
	const id = str(personaId).trim();
	const target = serverDb.getLibraryEntry(id) as RawLibraryEntry | null;
	if (!target) throw new ToolError(`No library entry with id "${id}". Use find_entities kind:persona to find the right id.`);
	if (target.type !== 'persona') {
		throw new ToolError(`"${target.identity.name}" is a ${target.type}, not a persona: only personas can be the active protagonist.`);
	}
	if (serverDb.getSetting('activePersonaId') === id) throw new ToolError(`${target.identity.name} is already the active persona.`);
	return target;
}

export const setActivePersona: Capability = {
	name: 'set_active_persona',
	summary: 'Switch which persona is globally ACTIVE: the protagonist NEW user messages and generations attribute to. Never touches history: existing messages keep the persona they were sent with (rebind those separately with update_entities on personaId). Use when the user says "switch me to <persona>".',
	risk: 'write',
	params: [{ name: 'personaId', type: 'string', describe: 'The persona to activate (from find_entities kind:persona).', required: true }],
	preview(args) {
		const target = loadPersonaToActivate(args.personaId);
		return {
			act: 'Switch active persona',
			label: target.identity.name,
			target: { kind: 'persona', id: target.id },
			notes: [{ text: 'Only new messages attribute to them: everything already written keeps the persona it was sent with.' }]
		};
	},
	run(args, ctx) {
		const target = loadPersonaToActivate(args.personaId);
		const id = target.id;
		serverDb.setSetting('activePersonaId', id);
		ctx.broadcast('settings');
		return ok(
			{ type: 'set_active_persona', kind: 'persona', id, name: target.identity.name, label: `Active persona → ${target.identity.name}` },
			{ personaId: id, name: target.identity.name, note: 'New user messages now attribute to this persona; history keeps its original attribution.' }
		);
	}
};

/** The character a new chat binds to, or a loud error. */
function loadChatCharacter(characterId: unknown): RawLibraryEntry {
	const entry = serverDb.getLibraryEntry(str(characterId).trim()) as RawLibraryEntry | null;
	if (!entry || entry.type !== 'character') {
		throw new ToolError(`No character with id "${str(characterId)}". Chats bind to characters; use find_entities kind:character to find the right id.`);
	}
	return entry;
}

/** Mirrors chatStore.generateChatTitle: "<name> - YYYY-MM-DD" (architecture/chat-sessions.md).
 *  The date is the client's `utils/date.ts` shape, which server code cannot import. */
function defaultChatTitle(name: string, when: number): string {
	const d = new Date(when);
	const datePrefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	const clean = name.trim();
	return clean ? `${clean} - ${datePrefix}` : datePrefix;
}

/**
 * The claims a new chat is born carrying: the character's own New Chat Defaults, the same
 * three the composer stamps (src/lib/stores/chat.svelte.ts `createChat`). A character
 * carrying none of them leaves the blob NULL rather than storing a row of nulls, which is
 * what keeps "claims nothing" a state the row can actually be in.
 *
 * Only the claim keys are written. Every other field of the blob has a default the reader
 * fills in, so mirroring the client's whole shape would be a second copy of it to keep in
 * step for no change in what anything reads.
 */
function birthClaims(entry: RawLibraryEntry): string | null {
	const connection = entry.defaultConnectionId ?? null;
	const persona = entry.defaultPersonaId ?? null;
	const preset = entry.defaultPresetId ?? null;
	if (!connection && !persona && !preset) return null;
	return JSON.stringify({ connection, persona, preset });
}

/**
 * The version a chat with this character is born pinned to. Second spelling of
 * `characterLibraryStore.chatVersionSeed` (src/lib/stores/characterLibrary.svelte.ts), which
 * this process cannot import: the character's own default while that version still exists,
 * else the first one ever made, else nothing for an unversioned character. Never the active
 * version, which says which variant the LIBRARY is editing and nothing about what a story
 * starts on. Two answers here and a chat the assistant made plays a different variant than
 * the same chat started from the composer.
 */
function chatVersionSeed(entry: RawLibraryEntry): string | null {
	const versions = serverDb.getCharacterVersionsByEntry(entry.id) as { id: string }[];
	const seed = entry.defaultVersionId;
	if (seed && versions.some((v) => v.id === seed)) return seed;
	return versions[0]?.id ?? null;
}

/**
 * Server-side replica of chatStore.createChat + seedCharacterGreetings
 * (architecture/chat-sessions.md). The store's client orchestration isn't reachable from
 * here, so the invariants are hand-honored: chat row first with null root/leaf
 * (messages.chat_id is a real FK), greeting rows parent-first as ROOT SIBLINGS
 * stored RAW ({{char}}/{{user}} literal; they resolve live at display/generation),
 * then the root/leaf pointers, all in one transaction; the chat is born on all four of the
 * character's New Chat Defaults, exactly as the composer mints it: the version pinned, and
 * the persona, connection and preset claimed where the character names them. Answering
 * fewer of them here would play the same character, started two different ways, as two
 * different stories with nothing on either screen saying why. The greeting LIST itself is not replicated:
 * `chatGreetingsOf` is the db module's own, and `refreshSeededGreetings` recognises a
 * still-unwritten chat by exactly the rows it produces.
 */
export const createChat: Capability = {
	name: 'create_chat',
	summary: 'Start a new chat with a character, seeded exactly like the UI: the First Message plus any alternate greetings open the chat as swipeable greeting branches, the chat pins to the version new chats with that character start on, and the title defaults to "<name> - YYYY-MM-DD". Does NOT switch what the user has open: the result carries a button to jump in.',
	risk: 'write',
	params: [
		{ name: 'characterId', type: 'string', describe: 'The character the chat is bound to.', required: true },
		{ name: 'title', type: 'string', describe: 'Optional title; omit for the "<name> - YYYY-MM-DD" default.' }
	],
	preview(args) {
		const entry = loadChatCharacter(args.characterId);
		const seeds = chatGreetingsOf(entry.data).length;
		return {
			act: 'Start a new chat',
			label: str(args.title).trim() || defaultChatTitle(entry.identity.name, Date.now()),
			within: entry.identity.name,
			notes: [
				{
					text: seeds
						? `Opens on ${seeds} swipeable greeting${seeds === 1 ? '' : 's'}. What you have open does not change.`
						: 'The character has no First Message or greetings, so it opens empty.',
					warn: seeds === 0
				}
			]
		};
	},
	run(args, ctx) {
		const entry = loadChatCharacter(args.characterId);
		const now = Date.now();
		const title = str(args.title).trim() || defaultChatTitle(entry.identity.name, now);
		const chatId = crypto.randomUUID();
		const greetings = chatGreetingsOf(entry.data);
		// Resolved once: the row and the result the assistant reads back have to name the same
		// variant, or the model is told a pin the chat does not carry.
		const versionId = chatVersionSeed(entry);
		serverDb.inTransaction(() => {
			serverDb.insertChat({
				id: chatId,
				title,
				createdAt: now,
				updatedAt: now,
				rootMessageId: null,
				activeLeafId: null,
				canonLeafId: null,
				settings: null,
				characterId: entry.id,
				characterVersionId: versionId,
				featureState: birthClaims(entry),
				isFavorite: false
			});
			// What the card handed this chat: a chat still holding exactly it is a mirror the
			// card can go on reaching (server/db.ts refreshSeededGreetings). Written even when
			// the list is empty, so a card that later gains an opening reaches the empty chat.
			serverDb.setChatSeededGreetings(chatId, greetings);
			let rootId: string | null = null;
			for (let i = 0; i < greetings.length; i += 1) {
				const messageId = crypto.randomUUID();
				serverDb.insertMessage({
					id: messageId,
					chatId,
					parentId: null,
					role: 'assistant',
					content: greetings[i],
					personaId: null,
					createdAt: now + i,
					siblingIndex: i
				});
				if (i === 0) rootId = messageId;
			}
			if (rootId) serverDb.updateChat({ id: chatId, rootMessageId: rootId, activeLeafId: rootId });
		});
		ctx.broadcast('chats');
		if (greetings.length) ctx.broadcast('messages');
		return ok(
			{
				type: 'create_chat',
				id: chatId,
				name: title,
				label: `Created chat: ${title}`,
				nav: { kind: 'chat', id: chatId, label: title }
			},
			{
				chatId,
				title,
				characterId: entry.id,
				...(versionId ? { pinnedVersionId: versionId } : {}),
				greetingsSeeded: greetings.length,
				...(greetings.length === 0 ? { note: 'The character has no First Message or alternate greetings: the chat opens empty.' } : {}),
				...stampState(['chat', chatId])
			}
		);
	}
};

// Mirrors of the client's steering vocabulary (src/lib/types/steering.ts), with no
// cross-boundary import, so contracts.test.ts asserts the three lists stay equal.
const STEERING_MODES = ['once', 'pinned'] as const;
const STEERING_ROLES = ['system', 'user', 'assistant'] as const;
const STEERING_SCOPES = ['global', 'character', 'version', 'chat'] as const;

/** The chat a chat-scoped tool acts on, or a loud error. */
function loadChat(chatId: unknown): RawChat {
	const id = requireChatId(chatId);
	const chat = serverDb.getChat(id) as RawChat | null;
	if (!chat) throw new ToolError(`No chat with id "${id}". Use list_chats or search_chats to find the right id.`);
	return chat;
}

/**
 * Where a steering note lands and how far it reaches, with every refusal the write makes: a
 * bound scope with nothing to bind to would store a note that could never resolve. Shared with
 * the preview, so the card refuses exactly what the call would and names the reach identically.
 */
function resolveSteeringScope(chat: RawChat, rawScope: unknown): { scope: string; scopeId: string | null; reach: string } {
	const scope = str(rawScope).trim() || 'chat';
	if (!(STEERING_SCOPES as readonly string[]).includes(scope)) {
		throw new ToolError(`\`scope\` must be one of: ${STEERING_SCOPES.join(', ')}; got "${scope}".`);
	}
	if (scope === 'global') return { scope, scopeId: null, reach: 'every chat' };
	if (scope === 'chat') return { scope, scopeId: chat.id, reach: chat.title };
	const character = chat.characterId ? (serverDb.getLibraryEntry(chat.characterId) as RawLibraryEntry | null) : null;
	const name = character?.identity.name ?? 'this chat\'s character';
	if (scope === 'character') {
		if (!chat.characterId) throw new ToolError('That chat has no character bound, so a character-scoped note would never apply.');
		return { scope, scopeId: chat.characterId, reach: `every chat with ${name}` };
	}
	if (!chat.characterVersionId) throw new ToolError("That chat isn't pinned to a character version, so a version-scoped note would never apply.");
	return { scope, scopeId: chat.characterVersionId, reach: `${name}'s pinned version` };
}

export const addSteering: Capability = {
	name: 'add_steering',
	summary:
		'Add a STEERING NOTE: guidance text injected into the story prompt without ever becoming a chat message. Notes STACK, so ADD one instead of trying to replace what is there. THE tool for "make the next scene darker / bring the storm forward / stop being so flowery" asks: steer the story, don\'t edit it.',
	risk: 'write',
	params: [
		{ name: 'chatId', type: 'string', describe: 'The chat to act on, required even for a global note, since the scope is resolved from this chat.', required: true },
		{ name: 'text', type: 'string', describe: 'The guidance text.', required: true },
		{
			name: 'scope',
			type: 'string',
			describe:
				'How far the note reaches: chat = this story only (the default), character = every chat with this chat\'s character, version = only while the chat stays pinned to its current variant, global = everything.',
			enum: STEERING_SCOPES
		},
		{ name: 'mode', type: 'string', describe: 'once (next generation only, then removes itself) or pinned (until switched off, the default).', enum: STEERING_MODES },
		{ name: 'title', type: 'string', describe: 'Optional short label for the note lists. Falls back to the first line of the text.' },
		{ name: 'depth', type: 'integer', describe: 'How deep into the prompt it injects (0 = at the end). Omit to inherit the app-wide default.', minimum: 0, maximum: 100 },
		{ name: 'role', type: 'string', describe: 'The prompt role it injects as. Omit to inherit the app-wide default.', enum: STEERING_ROLES }
	],
	preview(args) {
		const chat = loadChat(args.chatId);
		const { reach } = resolveSteeringScope(chat, args.scope);
		const text = requireStr(args.text, 'text').trim();
		const once = str(args.mode).trim() === 'once';
		return {
			act: 'Add steering note',
			within: reach,
			label: str(args.title).trim() || text.split('\n')[0],
			// Steering never becomes a chat message, which is the thing about it a reader has
			// to know before allowing one.
			notes: [
				{ text: once ? 'Rides the next reply only, then removes itself.' : 'Keeps applying to every reply until it is switched off.' },
				{ text: 'Guides the writing without ever appearing in the story.' }
			],
			diff: { before: '', after: text, title: 'Steering note' }
		};
	},
	run(args, ctx) {
		const chat = loadChat(args.chatId);
		const text = requireStr(args.text, 'text').trim();
		if (!text) throw new ToolError('`text` cannot be empty: a note with no guidance would never inject.');

		const mode = str(args.mode).trim() || 'pinned';
		if (!(STEERING_MODES as readonly string[]).includes(mode)) {
			throw new ToolError(`\`mode\` must be "once" or "pinned"; got "${mode}".`);
		}
		const { scope, scopeId, reach } = resolveSteeringScope(chat, args.scope);

		const roleArg = str(args.role).trim();
		if (roleArg && !(STEERING_ROLES as readonly string[]).includes(roleArg)) {
			throw new ToolError(`\`role\` must be one of: ${STEERING_ROLES.join(', ')}; got "${roleArg}".`);
		}
		const now = Date.now();
		const note = {
			id: crypto.randomUUID(),
			title: str(args.title).trim(),
			text,
			scope,
			scopeId,
			enabled: true,
			mode,
			// Absent = inherit the app-wide placement, the same tri-state the UI writes.
			depth: args.depth === undefined || args.depth === null ? null : clampInt(args.depth, 0, 100, 0),
			role: roleArg || null,
			createdAt: now,
			updatedAt: now
		};
		serverDb.insertSteeringNote(note);
		ctx.broadcast('steering');
		return ok(
			{ type: 'add_steering', id: note.id, name: note.title || text, label: `Steering added to ${reach}` },
			{
				noteId: note.id,
				scope,
				note:
					mode === 'once'
						? 'Rides the NEXT story generation only, then removes itself.'
						: 'Keeps applying to every story generation until switched off or deleted.'
			}
		);
	}
};

/** The safe projection of one stored connection: explicitly picked fields only, so a
 *  future blob field (endpoint URLs, anything credential-adjacent) can never leak. */
function projectConnection(c: Record<string, unknown>): Record<string, unknown> {
	return {
		id: c.id,
		name: c.name,
		provider: c.provider,
		model: c.model,
		...(c.contextSize != null ? { contextSize: c.contextSize } : {}),
		// BYO endpoints only, where it is the difference between a stored value and a
		// SENT one: nothing can detect what such an endpoint accepts, so the user
		// declares it and only declared knobs leave the app. Without this a diagnosis
		// would read `generation` as gospel and blame a penalty that never ships.
		...(c.provider === 'openai-compatible'
			? { samplingParams: Array.isArray(c.samplingParams) ? c.samplingParams : [] }
			: {}),
		...(c.generation && typeof c.generation === 'object' ? { generation: c.generation } : {})
	};
}

export const readConnectionState: Capability = {
	name: 'read_connection_state',
	summary: 'READ-ONLY view of the generation setup: which connection (provider + model + sampling settings) serves each routing point (primary story generation, the assistant itself, and every engine). THE grounding for diagnosis asks like "why are replies repetitive / short": see the actual temperature and penalties before advising, then point the user at Settings → Connections to change them (navigate). On an "openai-compatible" connection a `samplingParams` list comes with it: those are the ONLY sampling knobs that endpoint is sending, so a `generation` value outside that list is stored but inert. Say so instead of blaming it. API keys are never part of this.',
	risk: 'read',
	params: [],
	run() {
		const rawConns = serverDb.getSetting('connections');
		if (!rawConns) {
			return ok(
				{ type: 'read_connection_state', label: 'Read the connection setup: none configured' },
				{ connections: [], assignments: {}, note: 'No connections are configured yet. The user sets them up in Settings → Connections.' }
			);
		}
		let parsedConns: unknown;
		let parsedAssignments: unknown;
		try {
			parsedConns = JSON.parse(rawConns);
			const rawAssignments = serverDb.getSetting('connectionAssignments');
			parsedAssignments = rawAssignments ? JSON.parse(rawAssignments) : {};
		} catch (e) {
			throw new ToolError(`The stored connection settings are corrupt (${e instanceof Error ? e.message : 'invalid JSON'}). The user should check Settings → Connections.`);
		}
		const list = Array.isArray(parsedConns) ? (parsedConns as Record<string, unknown>[]) : [];
		const connections = list.filter((c) => c && typeof c === 'object').map(projectConnection);
		const assignments: Record<string, unknown> = {};
		if (parsedAssignments && typeof parsedAssignments === 'object' && !Array.isArray(parsedAssignments)) {
			for (const [point, connId] of Object.entries(parsedAssignments as Record<string, unknown>)) {
				const conn = connections.find((c) => c.id === connId);
				assignments[point] = conn
					? { connection: conn.name, provider: conn.provider, model: conn.model }
					: { missingConnectionId: connId };
			}
		}
		return ok(
			{ type: 'read_connection_state', label: `Read the connection setup: ${connections.length} connection${connections.length === 1 ? '' : 's'}` },
			{
				connections,
				assignments,
				note: 'Read-only. Changing a model, assignment, or sampling value happens on Settings → Connections. Navigate the user there.'
			}
		);
	}
};

export const renameChat: Capability = {
	name: 'rename_chat',
	summary: 'Rename a chat. Only the title changes: messages, character binding, and memory stay untouched.',
	risk: 'write',
	params: [
		{ name: 'chatId', type: 'string', describe: 'The chat to rename.', required: true },
		{ name: 'title', type: 'string', describe: 'The new title.', required: true }
	],
	preview(args) {
		const chat = loadChat(args.chatId);
		const title = str(args.title).trim();
		return {
			act: 'Rename chat',
			label: `${chat.title} → ${title || '(empty)'}`,
			target: { kind: 'chat', id: chat.id },
			notes: [{ text: 'The title only: messages, character and memory stay as they are.' }]
		};
	},
	run(args, ctx) {
		const chat = loadChat(args.chatId);
		const title = str(args.title).trim();
		if (!title) throw new ToolError('rename_chat needs a non-empty title.');
		if (title === chat.title) throw new ToolError(`That chat is already titled "${title}".`);
		serverDb.updateChat({ id: chat.id, title });
		ctx.broadcast('chats');
		return ok(
			{ type: 'rename_chat', id: chat.id, name: title, label: `Renamed chat "${chat.title}" → "${title}"` },
			{ chatId: chat.id, title, ...stampState(['chat', chat.id]) }
		);
	}
};
