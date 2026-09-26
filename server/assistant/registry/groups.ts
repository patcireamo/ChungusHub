/**
 * Capability groups: the families the assistant's tools belong to.
 *
 * One table, three consumers, and that is the whole point: the system prompt's tool index
 * is generated from it (so a new capability owes the prompt nothing but its name in a
 * family line), the user's Capabilities setting switches whole families on and off against
 * it, and `src/lib/contracts.test.ts` asserts the table still partitions `CAPABILITIES`
 * exactly: every tool in one family, no family naming a tool that no longer exists.
 *
 * The prompt block this replaces was 1.7k tokens of prose restating the very tool schemas
 * that sit beside it in the same cached prefix. Moving a sentence between the two costs
 * nothing and gains nothing; the only thing the schemas genuinely cannot supply is the
 * grouping itself, which is what lives here.
 */

export interface CapabilityGroup {
	/** Stable key: the settings row, the gate, and the contracts assertion all use it. */
	id: string;
	/** Human label for Assistant Settings. */
	label: string;
	/** One line of "when do I reach for this family", for the prompt index. Names no tool
	 *  twice and repeats no schema: the tool list right below already describes each call. */
	whenToReach: string;
	/** The same family said to the PERSON deciding whether to switch it on: a different
	 *  audience and a different sentence, which is why it is not the line above. */
	describe: string;
	/** The capability names in this family, in the order the prompt lists them. */
	tools: string[];
	/** Core is what the assistant IS: reading the workspace. Switching it off would leave a
	 *  tool-calling agent that cannot find an id, so it never switches off. */
	alwaysOn?: boolean;
	/** Not part of what a fresh workspace runs: the user opts in from the Capabilities page. */
	defaultOff?: boolean;
	/** Still rough at the edges: badged Experimental on the Capabilities page, and kept out of
	 *  the defaults AND of every preset: the user opts in knowingly, per workspace. */
	experimental?: boolean;
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
	{
		id: 'core',
		label: 'Core',
		alwaysOn: true,
		whenToReach:
			'reading anything, finding the id for it, and putting a question to the user when the answer is only theirs to give. The file tools read what the user attached to this conversation as reference material: read-only, addressed by line number, and search first on anything long.',
		describe:
			'Reading your workspace and searching it, reading the files you attach, and asking you a multiple-choice question when only you can decide.',
		tools: [
			'read_entity',
			'find_entities',
			'list_chats',
			'search_chats',
			'read_chat_messages',
			'read_chat_context',
			'list_files',
			'read_file',
			'search_file',
			'ask_user'
		]
	},
	{
		id: 'navigation',
		label: 'Navigation',
		defaultOff: true,
		whenToReach:
			'pointing the user at the app itself. The `setting` kind is a read-only catalog of the app\'s own settings (read it with the Core tools): answer "what does X do" from it and `navigate` the user to the control. You never change app settings yourself. `navigate` also jumps to a character, persona, message, or chat.',
		describe:
			"Letting the assistant explain the app's own settings and offer buttons that jump you straight to a setting, a character or persona, a message, or a chat.",
		tools: ['navigate']
	},
	{
		id: 'writing',
		label: 'Writing',
		whenToReach:
			'creating and changing characters, personas, lorebook records and messages (one target at a time, or every match of a filter at once). It also covers an entry\'s ART (edit_character_images): copying a picture from an upload, or from another entry, is a write and not a look.',
		describe:
			"Creating and editing characters, personas and messages, including sweeping one change across every match at once, and setting or rearranging an entry's portrait and gallery.",
		tools: ['create_entity', 'edit_entity', 'set_entity', 'update_entities', 'edit_character_images']
	},
	{
		id: 'deleting',
		label: 'Deleting',
		experimental: true,
		whenToReach: 'removing an entry, a whole book, or a message. Permanent.',
		describe:
			'Deleting characters, personas, whole lorebooks and chat messages. Permanent, with no undo, and still rough around the edges: leave it off unless you need it. Removing single entries inside a lorebook lives under Lorebook, not here.',
		tools: ['delete_entity']
	},
	{
		id: 'lorebook',
		label: 'Lorebook',
		whenToReach:
			'the world facts a chat injects and how they fire: reading and searching books, writing entries, every setting from the defaults down to one entry, and linking a book to a character or persona.',
		describe: 'Reading and writing lorebook entries and every lorebook setting, and linking a book to a character so it actually injects.',
		tools: [
			'read_lorebook_settings',
			'read_lorebook_entries',
			'create_lorebook_entry',
			'edit_lorebook_entry',
			'configure_lorebook_entries',
			'configure_lorebooks',
			'delete_lorebook_entry',
			'manage_entry_lorebooks'
		]
	},
	{
		id: 'memory',
		label: 'Memory',
		whenToReach: "a chat's long-term memory: what is folded away, and correcting a summary that misremembers.",
		describe: 'Reading what a chat has folded into long-term memory, and correcting a summary that misremembers.',
		tools: ['read_memory_state', 'edit_memory_episode']
	},
	{
		id: 'story',
		label: 'Story operations',
		whenToReach: 'running the workspace around a story: starting a chat, steering the next generation, switching the active persona, retitling, and a character\'s alternate openings.',
		describe: 'Starting chats, steering the next reply, switching the active persona, renaming, and alternate greetings.',
		tools: ['create_chat', 'add_steering', 'set_active_persona', 'rename_chat', 'manage_greetings']
	},
	{
		id: 'versions',
		label: 'Versions',
		whenToReach: "a character's named variants. Leave them alone unless the user brings them up.",
		describe: "Reading and managing a character's named variants.",
		tools: ['read_character_versions', 'manage_character_versions']
	},
	{
		id: 'images',
		label: 'Images',
		defaultOff: true,
		whenToReach:
			'LOOKING at the art a character or persona owns. Every read already reports WHAT art an entry has, so reach for this only when the pictures themselves matter; a read also attaches the portrait while this is on, so an entry you have just read needs no second call to see.',
		describe:
			'Letting the assistant look at the portraits and gallery art your entries own. Seeing an image needs a vision-capable assistant model, and each one it looks at costs context. Rearranging that art is under Writing; this family is about looking.',
		tools: ['view_character_images']
	},
	{
		id: 'diagnostics',
		label: 'Diagnostics',
		whenToReach: '"why did the last generation say that" and "what is eating my context": the captured prompt log, and which connection serves each routing point.',
		describe: 'The captured prompt log and which connection serves each routing point, for "why did the last reply say that".',
		tools: ['read_prompt_log', 'read_prompt_entry', 'read_connection_state']
	}
];

/** The group a capability belongs to, by tool name. */
const GROUP_OF = new Map<string, CapabilityGroup>(CAPABILITY_GROUPS.flatMap((g) => g.tools.map((t) => [t, g] as const)));

export function groupOfTool(name: string): CapabilityGroup | undefined {
	return GROUP_OF.get(name);
}

/** Families that cannot be switched off: the assistant's ability to look at anything. */
export const ALWAYS_ON_GROUPS: readonly string[] = CAPABILITY_GROUPS.filter((g) => g.alwaysOn).map((g) => g.id);

/**
 * What a workspace with no stored choice runs: every family that is neither opt-in
 * (`defaultOff`: Images for its context cost, Navigation) nor `experimental` (Deleting).
 * The rest are one switch away on the Capabilities page; nothing turns them on silently.
 */
export const DEFAULT_ENABLED_GROUPS: readonly string[] = CAPABILITY_GROUPS.filter((g) => !g.defaultOff && !g.experimental).map((g) => g.id);

/**
 * Named starting points for the Capabilities page. They are presentation, not storage: only
 * the enabled SET is stored, and the page shows whichever preset that set happens to equal
 * (or Custom). A second stored field would be a preset and a set that can disagree.
 *
 * They NEST: Simple ⊂ Standard ⊂ Full. A person reads three buttons left to right as a
 * ladder, so a step up that quietly revoked a family would take away a tool they had just
 * been using. `smoke.ts` asserts the containment.
 */
export const CAPABILITY_PRESETS: { id: string; label: string; describe: string; groups: readonly string[] }[] = [
	{
		id: 'simple',
		label: 'Simple',
		describe: 'Everything the story itself needs: writing, the lorebook, memory, story operations and versions. Nothing that deletes.',
		groups: ['core', 'writing', 'lorebook', 'memory', 'story', 'versions']
	},
	{
		id: 'standard',
		label: 'Standard',
		describe: 'Simple, plus looking at the art your entries own. Every family except Navigation, Deleting and Diagnostics.',
		groups: ['core', 'writing', 'lorebook', 'memory', 'story', 'versions', 'images']
	},
	{
		id: 'full',
		label: 'Full',
		describe: 'Standard, plus jumping you around the app, the prompt log and connection reads. Only the experimental Deleting family stays off.',
		groups: CAPABILITY_GROUPS.filter((g) => !g.experimental).map((g) => g.id)
	}
];

/** The stored list, made safe to run on: unknown ids dropped, always-on families forced in. */
export function normalizeGroups(ids: readonly string[]): string[] {
	const known = new Set(CAPABILITY_GROUPS.map((g) => g.id));
	const out = new Set(ALWAYS_ON_GROUPS);
	for (const id of ids) if (known.has(id)) out.add(id);
	return CAPABILITY_GROUPS.filter((g) => out.has(g.id)).map((g) => g.id);
}

/** The complement: what the prompt has to name as switched off. */
export function disabledGroupIds(enabled: ReadonlySet<string>): string[] {
	return CAPABILITY_GROUPS.filter((g) => !enabled.has(g.id)).map((g) => g.id);
}

/**
 * The prompt's tool index: one line per family, naming its tools and when to reach for it.
 *
 * A family the user has switched off is still NAMED, with its state and the way back. The
 * alternative is worse than it looks: a model that has never heard of the lorebook tools
 * answers "add this to the lorebook" by improvising (editing the character's description
 * instead) rather than saying it cannot.
 */
export function describeToolFamilies(disabledGroupIds: readonly string[]): string {
	const off = new Set(disabledGroupIds);
	const lines = CAPABILITY_GROUPS.map((g) =>
		off.has(g.id)
			? `- **${g.label}**: SWITCHED OFF by the user, so its tools (${g.tools.join(', ')}) are not available. Say so plainly instead of improvising around them, and tell them it turns back on under the gear in the assistant panel, in Assistant Settings → Capabilities. (\`navigate\` cannot reach that page: it is inside this panel, not the app's Settings.)`
			: `- **${g.label}** (${g.tools.join(', ')}): ${g.whenToReach}`
	);
	return lines.join('\n');
}
