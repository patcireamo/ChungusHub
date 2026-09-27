/**
 * Assistant skills: procedural guides the assistant reads on demand instead of carrying
 * in its system prompt. The prompt holds only a one-line index (name + description) per
 * ENABLED skill; when a task matches, the assistant pulls the body with
 * `read_entity kind:skill`. Baseline behaviours (simple edits, chat fixes) never need one.
 *
 * Every skill belongs to the user: written, edited, toggled and deleted from the Skills
 * section of Assistant Settings, with no privileged class among them. What ships is
 * `defaults/skills/`: one `<id>.json` per skill in the same format an export writes,
 * read as a FOLDER, so shipping another is dropping a file in and nothing else. That
 * folder is a read-only catalog: the first read seeds the user's list from it and the
 * Defaults browser copies out of it on demand, but nothing ever writes back into it,
 * which is what lets a deleted or rewritten skill be fetched again unharmed. What it
 * holds are worked examples, not an attempt at a complete set: the sets worth having
 * are the ones users write and trade, so shipping more is a decision, never a todo.
 *
 * State lives in assistantSkills.json under the data dir: the list verbatim, ids and all.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSISTANT_SKILLS_PATH, DEFAULT_SKILLS_DIR } from '../../config';
import { visibleEntries } from '../../files';
import { parseSkillsFile } from '../../../shared/skills-file';

export interface Skill {
	id: string;
	name: string;
	/** One line in the system-prompt index: how the assistant decides to read the skill. */
	description: string;
	/** The full guide. */
	body: string;
	enabled: boolean;
}

/** What the client sends back when saving the whole set. A row with an unknown id is new. */
export interface SkillInput {
	id?: string;
	name: string;
	description: string;
	body: string;
	enabled: boolean;
}

// ===== The shipped catalog (defaults/skills/*.json) =====

/**
 * Every bundled skill, in filename order, with its id taken from the filename. Throws
 * when the folder is missing or holds no skill: that is a packaging mistake, and an
 * empty list would hide it behind a Defaults browser that simply shows nothing.
 */
export function listDefaultSkills(): Skill[] {
	if (!existsSync(DEFAULT_SKILLS_DIR)) throw new Error(`Bundled skills are missing: ${DEFAULT_SKILLS_DIR}`);
	const out: Skill[] = [];
	for (const file of visibleEntries(DEFAULT_SKILLS_DIR).map((e) => e.name).sort()) {
		if (!file.endsWith('.json')) continue;
		const stem = file.replace(/\.json$/, '');
		const entries = parseSkillsFile(readFileSync(join(DEFAULT_SKILLS_DIR, file), 'utf8'));
		// One skill per file is the convention; a file carrying several still lands with
		// unique ids rather than overwriting itself.
		entries.forEach((entry, i) => out.push({ id: i === 0 ? stem : `${stem}-${i + 1}`, ...entry }));
	}
	if (out.length === 0) throw new Error(`No skills found in ${DEFAULT_SKILLS_DIR}.`);
	return out;
}

// ===== The user's list =====

function readRow(raw: unknown): Skill {
	if (!raw || typeof raw !== 'object') throw new Error('a skill row is not an object');
	const o = raw as Record<string, unknown>;
	for (const key of ['id', 'name', 'description', 'body'] as const) {
		if (typeof o[key] !== 'string' || !(o[key] as string).trim()) throw new Error(`a skill row has no ${key}`);
	}
	return {
		id: o.id as string,
		name: o.name as string,
		description: o.description as string,
		body: o.body as string,
		enabled: o.enabled !== false
	};
}

/** The full set, disabled ones included. A fresh install is seeded from the catalog here. */
export function listSkills(): Skill[] {
	if (!existsSync(ASSISTANT_SKILLS_PATH)) {
		const seeded = listDefaultSkills();
		writeFileSync(ASSISTANT_SKILLS_PATH, JSON.stringify(seeded, null, 2));
		return seeded;
	}
	try {
		const raw = JSON.parse(readFileSync(ASSISTANT_SKILLS_PATH, 'utf8'));
		if (!Array.isArray(raw)) throw new Error('expected an array of skills');
		return raw.map(readRow);
	} catch (e) {
		// A corrupt file must not silently erase the user's skills: the next save writes the
		// full set and makes the loss permanent. Park the broken file next door for recovery
		// and start from the shipped catalog, loudly.
		const backup = `${ASSISTANT_SKILLS_PATH}.corrupt-${Date.now()}`;
		try {
			copyFileSync(ASSISTANT_SKILLS_PATH, backup);
			console.error(`[assistant] assistantSkills.json is corrupt (${e instanceof Error ? e.message : e}); backed it up to ${backup} and started from the bundled skills.`);
		} catch {
			console.error('[assistant] assistantSkills.json is corrupt and could not be backed up. Starting from the bundled skills.');
		}
		return listDefaultSkills();
	}
}

/** Only what the assistant may use: disabled skills are invisible to it. */
export function listEnabledSkills(): Skill[] {
	return listSkills().filter((s) => s.enabled);
}

export function getSkill(id: string): Skill | null {
	return listSkills().find((s) => s.id === id) ?? null;
}

/** The one-line-per-skill index embedded in the system prompt; '' when none enabled.
 *  Name leads (an id the user never chose must not be mistaken for a title); the id
 *  trails as the explicit handle for read_entity kind:skill. */
export function describeSkillIndex(): string {
	return listEnabledSkills()
		.map((s) => `- **${s.name}** (id: \`${s.id}\`): ${s.description}`)
		.join('\n');
}

// ===== Save (full replacement from the Skills section) =====

function cleanLine(v: unknown, label: string, max: number): string {
	if (typeof v !== 'string' || !v.trim()) throw new Error(`A skill needs a non-empty ${label}.`);
	return v.trim().slice(0, max);
}

/**
 * Persists the whole set, in the order given. A missing or already-taken id is minted
 * here rather than refused: two rows sharing one id would make the second unreadable
 * and unsavable, with nothing on screen to explain why.
 */
export function saveSkills(inputs: SkillInput[]): Skill[] {
	const taken = new Set<string>();
	const skills = inputs.map((input) => {
		const id = input.id && !taken.has(input.id) ? input.id : crypto.randomUUID();
		taken.add(id);
		return {
			id,
			name: cleanLine(input.name, 'name', 120),
			description: cleanLine(input.description, 'description', 300),
			body: cleanLine(input.body, 'body', 20000),
			enabled: input.enabled !== false
		};
	});
	writeFileSync(ASSISTANT_SKILLS_PATH, JSON.stringify(skills, null, 2));
	return skills;
}
