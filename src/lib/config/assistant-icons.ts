/**
 * Tool → verb icon, so a list of assistant actions scans at a glance.
 *
 * Shared by the two surfaces that list tool calls: the turn timeline (what ran) and the
 * approval card (what is about to). A tool wears the same mark in both, which is the whole
 * point of it being one table: the row a user approved and the row that reports it are
 * recognisably the same act.
 *
 * A tool missing from the map falls back to a neutral check; that is cosmetic, not a bug.
 */
import type { ComponentProps } from 'svelte';
import type Icon from '$lib/components/ui/Icon.svelte';

type IconName = ComponentProps<typeof Icon>['name'];

export const TOOL_ICONS: Record<string, IconName> = {
	ask_user: 'annotation',
	read_entity: 'eye',
	find_entities: 'search',
	create_entity: 'plus',
	edit_entity: 'pencil',
	set_entity: 'pencil',
	update_entities: 'pencil',
	delete_entity: 'trash',
	list_chats: 'chat',
	search_chats: 'search',
	read_chat_messages: 'chat',
	read_chat_context: 'eye',
	list_files: 'document',
	read_file: 'document',
	search_file: 'search',
	read_memory_state: 'eye',
	edit_memory_episode: 'pencil',
	read_character_versions: 'eye',
	manage_character_versions: 'pencil',
	read_lorebook_settings: 'bookOpen',
	read_lorebook_entries: 'bookOpen',
	create_lorebook_entry: 'bookOpen',
	edit_lorebook_entry: 'bookOpen',
	configure_lorebook_entries: 'bookOpen',
	configure_lorebooks: 'bookOpen',
	delete_lorebook_entry: 'trash',
	view_character_images: 'image',
	edit_character_images: 'image',
	manage_entry_lorebooks: 'bookOpen',
	manage_greetings: 'chat',
	read_prompt_log: 'search',
	read_prompt_entry: 'eye',
	create_chat: 'plus',
	set_active_persona: 'user',
	add_steering: 'compass',
	rename_chat: 'pencil',
	read_connection_state: 'eye',
	navigate: 'mapPin'
};

/** Takes the shape rather than a full result, so a call that is still streaming (or still
 *  waiting to be approved) wears the same icon it will keep once it has run. */
export function toolIcon(tool: { type: string; error?: string }): IconName {
	if (tool.error) return 'warning';
	return TOOL_ICONS[tool.type] ?? 'check';
}

/**
 * Workspace-attachment kind → icon, shared by the composer's chips (AssistantAttachBar) and
 * the sent message's chips (AssistantTurnTimeline): the chip a user staged and the chip
 * that reports what rode must be recognisably the same thing.
 */
export function attachmentKindIcon(kind: string, entryType?: string): IconName {
	if (kind === 'selection') return 'annotation';
	if (kind === 'chat') return 'chat';
	if (kind === 'lorebook') return 'bookOpen';
	return entryType === 'persona' ? 'user' : 'users';
}
