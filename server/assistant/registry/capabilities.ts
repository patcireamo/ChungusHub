/**
 * Capability assembly: every tool the assistant can call, in the order they appear
 * to the model. The definitions live in one module per family:
 *
 *  - entity-ops.ts: the generic read/find/create/edit/set/update/delete that work
 *    uniformly over every addressable entity (driven by entities.ts field metadata)
 *  - images.ts: the image look tool + the entry-art write
 *  - versions.ts: character version roster reads + lifecycle mutations
 *  - navigate.ts: deep-linking the user into the app
 *  - chat-reads.ts: chat list/search, windowed message reads, chat context, chat memory
 *  - lorebook-entries.ts: paged entry reads and search + entry create/edit/delete + links
 *  - lorebook-settings.ts: the settings map + the defaults', books' and entries' settings
 *  - files.ts: reading the files the user attached to the tab as reference material
 *  - ask.ts: putting a question to the user and waiting for the answer
 *
 * This file only assembles them; adding a capability means adding it to its family
 * module and to the array below. registry/index.ts (buildTools/dispatch) and
 * smoke.ts consume the array and notice a missing entry immediately.
 */
import type { Capability } from './types';
import { readEntity, findEntities, createEntity, editEntity, setEntity, updateEntities, deleteEntity } from './entity-ops';
import { viewCharacterImages, editCharacterImages } from './images';
import { readCharacterVersions, manageCharacterVersions } from './versions';
import { navigate } from './navigate';
import { listChats, searchChats, readChatMessages, readChatContext, readMemoryState, editMemoryEpisode } from './chat-reads';
import { readLorebookEntries, createLorebookEntry, editLorebookEntry, deleteLorebookEntry, manageEntryLorebooks } from './lorebook-entries';
import { readLorebookSettings, configureLorebooks, configureLorebookEntries } from './lorebook-settings';
import { setActivePersona, renameChat, createChat, addSteering, readConnectionState } from './workspace';
import { manageGreetings } from './greetings';
import { readPromptLog, readPromptEntry } from './prompt-trace';
import { listFiles, readFile, searchFileTool } from './files';
import { askUser } from './ask';

/** Every capability, in the order they should appear to the model. */
export const CAPABILITIES: Capability[] = [
	askUser,
	readEntity,
	findEntities,
	createEntity,
	editEntity,
	setEntity,
	updateEntities,
	deleteEntity,
	viewCharacterImages,
	editCharacterImages,
	readCharacterVersions,
	manageCharacterVersions,
	navigate,
	listChats,
	searchChats,
	readChatMessages,
	readChatContext,
	listFiles,
	readFile,
	searchFileTool,
	readMemoryState,
	editMemoryEpisode,
	readLorebookSettings,
	readLorebookEntries,
	createLorebookEntry,
	editLorebookEntry,
	configureLorebookEntries,
	configureLorebooks,
	deleteLorebookEntry,
	manageEntryLorebooks,
	manageGreetings,
	readPromptLog,
	readPromptEntry,
	createChat,
	setActivePersona,
	addSteering,
	renameChat,
	readConnectionState
];
