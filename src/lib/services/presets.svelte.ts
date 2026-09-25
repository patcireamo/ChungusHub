/**
 * Client preset service.
 *
 * Presets are JSON files on the server. Editing never touches the committed file:
 * every change is written to a per-preset draft (data/presets/temp/<id>.json) that
 * lives until you Save (commit + drop draft) or Discard (drop draft). The "effective"
 * preset (draft if one exists, else committed) is what the editor shows AND what
 * generation uses, so you can try changes live and revert if you don't like them.
 */
import type { PromptPreset, PromptItem, PromptControl } from '$lib/types/database';
import { apiGet, apiSend, getClientId } from '$lib/services/transport';
import { db } from '$lib/services/database';
import { imageService } from '$lib/services/imageService';
import { registerSettingsReload } from '$lib/services/syncedSetting';
import { parsePresetJson, serializePresetJson, type ImportedPreset } from '$lib/services/preset-io';
import type { RegexRule } from '$lib/utils/regex-rules';
import { SvelteMap } from 'svelte/reactivity';

function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.substring(0, 50);
}

/** A preset minus its items' runtime ids: the shape on disk and on the wire. */
type StoredPreset = Omit<PromptPreset, 'items'> & { items: Omit<PromptItem, 'id'>[] };

/** Deep-copy controls so nested option arrays aren't shared between presets. */
function cloneControls(controls?: PromptControl[]): PromptControl[] {
	return (controls ?? []).map((control) => ({
		...control,
		options: control.options?.map((option) => ({ ...option })),
		defaultOptionIds: control.defaultOptionIds ? [...control.defaultOptionIds] : undefined,
		defaultRange: control.defaultRange ? [...control.defaultRange] : undefined
	}));
}

function cloneRules(rules?: RegexRule[]): RegexRule[] | undefined {
	return rules?.map((rule) => ({ ...rule, targets: [...rule.targets], scopes: [...rule.scopes] }));
}

/**
 * Deep copy of everything a preset owns EXCEPT its items, whose ids are the caller's
 * business (minted fresh on load, dropped on the wire, kept when cloning in place).
 *
 * This is the single per-preset field list, the one architecture/prompt-pipeline.md
 * coupling 9 keeps pointing at. `hydrate`, `strip`, `clone`, `duplicatePreset` and the
 * Prompt Builder's working copy all route through it, so a new field reaches every one of
 * them at once instead of surviving Save and vanishing on the next unrelated edit. Key
 * order is fixed here on purpose: `strip` drives `sameContent`, which compares serialized
 * output, and two orders would read as two different presets.
 */
function clonePresetBody(preset: Omit<StoredPreset, 'id' | 'items'>) {
	return {
		name: preset.name,
		controls: cloneControls(preset.controls),
		sections: preset.sections?.map((section) => ({ ...section })),
		bundles: preset.bundles?.map((bundle) => ({ ...bundle, values: { ...bundle.values } })),
		meta: preset.meta ? { ...preset.meta } : undefined,
		regexRules: cloneRules(preset.regexRules),
		pruneEmptyBlocks: preset.pruneEmptyBlocks === true,
		exampleSeparator: preset.exampleSeparator,
		continuePrompt: preset.continuePrompt,
		rewritePrompt: preset.rewritePrompt
	};
}

/**
 * A working copy nothing else shares. The Prompt Builder edits one of these and writes it
 * back as a draft, so every mutation there is safely local until it persists.
 */
export function clonePreset(preset: PromptPreset): PromptPreset {
	return {
		id: preset.id,
		...clonePresetBody(preset),
		items: preset.items.map((item) => ({ ...item }))
	};
}

class PresetService {
	// Reactive so every consumer ($derived over getAllPresets/getActivePresetId in
	// InputArea, PromptBuilder, etc.) refreshes the instant the set or selection changes,
	// with no page reload needed. Plain Map/field reads weren't tracked by Svelte.
	private presets = new SvelteMap<string, PromptPreset>(); // committed (saved) presets
	private drafts = new SvelteMap<string, PromptPreset>(); // unsaved working copies
	private initialized = false;
	private activePresetId = $state<string | null>(null);
	// Only replacements made outside the editor tick this (remote draft, default reset, a
	// rename). Prompt Builder uses it to refresh an already-open editor when the active id stays the same.
	private contentVersion = $state(0);

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.loadAll();
		await this.loadActivePresetId();
		await this.ensureActivePreset();
		registerSettingsReload(() => this.syncActivePresetId());
		this.initialized = true;
	}

	private async loadActivePresetId(): Promise<void> {
		const presetId = await db.getSetting('activePresetId');
		if (presetId) {
			this.activePresetId = presetId;
			return;
		}
		// One-shot carry-over from the per-mode selection. Only reachable while no
		// `activePresetId` exists at all; `ensureActivePreset` writes one on this same boot,
		// so it never runs twice. Unparseable JSON throws rather than starting the user on a
		// silently different preset than the one they left.
		const oldData = await db.getSetting('activePresetByMode');
		if (!oldData) return;
		const map = JSON.parse(oldData);
		if (map.story) {
			this.activePresetId = map.story;
			await db.setSetting('activePresetId', map.story);
		}
	}

	getActivePresetId(): string | null {
		return this.activePresetId;
	}

	getContentVersion(): number {
		return this.contentVersion;
	}

	/** The only active-preset mutation path. Every consumer reads this same state. */
	async activatePreset(presetId: string): Promise<PromptPreset> {
		const preset = this.getEffective(presetId);
		if (!preset) throw new Error(`Preset not found: ${presetId}`);
		const previous = this.activePresetId;
		this.activePresetId = presetId;
		try {
			await db.setSetting('activePresetId', presetId);
		} catch (error) {
			this.activePresetId = previous && this.getEffective(previous) ? previous : null;
			throw error;
		}
		return preset;
	}

	/** Reload file-backed presets after the server's `presets` sync hint. */
	async syncReload(): Promise<void> {
		await this.loadAll();
		await this.syncActivePresetId();
		this.contentVersion++;
	}

	private async syncActivePresetId(): Promise<void> {
		this.activePresetId = (await db.getSetting('activePresetId')) || null;
		await this.ensureActivePreset();
	}

	private async ensureActivePreset(): Promise<void> {
		if (this.activePresetId && this.getEffective(this.activePresetId)) return;
		let next = this.getAllPresets()[0] ?? null;
		if (!next) next = await this.createPreset('New Preset');
		await this.activatePreset(next.id);
	}

	private async loadAll(): Promise<void> {
		const data = (await apiGet('/api/presets')) as { presets: StoredPreset[]; drafts: StoredPreset[] };
		this.presets.clear();
		this.drafts.clear();
		for (const stored of data.presets) {
			this.presets.set(stored.id, this.hydrate(stored));
		}
		for (const stored of data.drafts ?? []) {
			// Ignore orphan drafts whose committed preset no longer exists.
			const committed = this.presets.get(stored.id);
			if (!committed) continue;
			const draft = this.hydrate(stored);
			// A draft identical to its committed preset is a phantom "unsaved changes"
			// flag (e.g. left behind by a no-op edit), so clean it up instead of loading it.
			if (this.sameContent(draft, committed)) {
				await apiSend(`/api/presets/${encodeURIComponent(stored.id)}/draft`, 'DELETE', { clientId: getClientId() });
				continue;
			}
			this.drafts.set(stored.id, draft);
		}
	}

	/**
	 * Material equality: same wire payload (strip() drops the runtime item ids, so only
	 * name, items and controls are compared). This is what decides whether an edit state
	 * is actually a draft or just the committed preset again.
	 */
	private sameContent(a: PromptPreset, b: PromptPreset): boolean {
		return JSON.stringify(this.strip(a)) === JSON.stringify(this.strip(b));
	}

	private hydrate(stored: StoredPreset): PromptPreset {
		return {
			id: stored.id,
			...clonePresetBody(stored),
			items: (stored.items ?? []).map((item) => ({ ...item, id: crypto.randomUUID() }))
		};
	}

	/**
	 * Wire payload for persistence. Runtime item ids are regenerated on load, but control +
	 * option ids are kept stable: option ids ARE the stored value for select/radio/tags, so
	 * regenerating one resets every reader's saved choice. (Control VALUES key on the
	 * control's macro name, not its id, and they are global rather than per-chat. See
	 * architecture/preset-authoring.md coupling 1.)
	 */
	private strip(preset: PromptPreset): Omit<StoredPreset, 'id'> {
		return {
			...clonePresetBody(preset),
			items: preset.items.map(({ id: _id, ...item }) => item)
		};
	}

	private clone(preset: PromptPreset): PromptPreset {
		return clonePreset(preset);
	}

	/** Committed presets (the names shown in the picker). */
	getAllPresets(): PromptPreset[] {
		return Array.from(this.presets.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	/** The preset to edit and to generate from: the draft if one exists, else committed. */
	getEffective(id: string): PromptPreset | null {
		return this.drafts.get(id) ?? this.presets.get(id) ?? null;
	}

	/** The saved preset, ignoring any draft over it. Needed where an edit puts a FILE on
	 *  disk (the cover) and the loser has to be identified before the draft is resolved. */
	getCommitted(id: string): PromptPreset | null {
		return this.presets.get(id) ?? null;
	}

	/** Effective preset for the active id. The first-preset fallback only covers boot. */
	getActiveEffectivePreset(): PromptPreset | null {
		if (this.activePresetId) {
			const active = this.getEffective(this.activePresetId);
			if (active) return active;
		}
		const first = this.getAllPresets()[0];
		return first ? this.getEffective(first.id) : null;
	}

	hasDraft(id: string): boolean {
		return this.drafts.has(id);
	}

	/** Case-insensitive, trimmed name collision check against committed presets. */
	isNameTaken(name: string, exceptId?: string): boolean {
		const target = name.trim().toLowerCase();
		for (const preset of this.presets.values()) {
			if (preset.id !== exceptId && preset.name.trim().toLowerCase() === target) return true;
		}
		return false;
	}

	// ===== Editing (drafts) =====

	/**
	 * Persist the in-progress edit to the preset's draft. Does not touch the committed
	 * file. If the edit state matches the committed preset (an edit typed and reverted,
	 * a drop back onto the same spot, …), any existing draft is dropped instead:
	 * "unsaved changes" exists exactly when the content actually differs.
	 */
	async saveDraft(preset: PromptPreset): Promise<void> {
		const committed = this.presets.get(preset.id);
		if (committed && this.sameContent(preset, committed)) {
			await this.discardDraft(preset.id);
			return;
		}
		this.drafts.set(preset.id, this.clone(preset));
		await apiSend(`/api/presets/${encodeURIComponent(preset.id)}/draft`, 'PUT', {
			...this.strip(preset),
			clientId: getClientId()
		});
	}

	/** Save: write the draft onto the committed preset and drop the draft. */
	async commitDraft(id: string): Promise<PromptPreset | null> {
		const draft = this.drafts.get(id);
		if (!draft) return this.presets.get(id) ?? null;
		await apiSend(`/api/presets/${encodeURIComponent(id)}`, 'PUT', { ...this.strip(draft), clientId: getClientId() });
		await apiSend(`/api/presets/${encodeURIComponent(id)}/draft`, 'DELETE', { clientId: getClientId() });
		const committed = this.clone(draft);
		this.presets.set(id, committed);
		this.drafts.delete(id);
		return committed;
	}

	/** Discard: drop the draft, reverting to the committed preset. */
	async discardDraft(id: string): Promise<PromptPreset | null> {
		if (this.drafts.has(id)) {
			this.drafts.delete(id);
			await apiSend(`/api/presets/${encodeURIComponent(id)}/draft`, 'DELETE', { clientId: getClientId() });
		}
		return this.presets.get(id) ?? null;
	}

	// ===== Preset lifecycle =====

	async createPreset(name: string): Promise<PromptPreset> {
		const id = this.generateUniqueId(name);
		const newPreset: PromptPreset = { id, name: name.trim(), items: [], controls: [] };
		await apiSend(`/api/presets/${encodeURIComponent(id)}`, 'PUT', { ...this.strip(newPreset), clientId: getClientId() });
		this.presets.set(id, newPreset);
		return newPreset;
	}

	async duplicatePreset(sourceId: string, newName: string): Promise<PromptPreset> {
		// Duplicate what the user is actually using. If Prompt Builder has a draft,
		// the copy includes it without saving or discarding the source draft.
		const source = this.getEffective(sourceId);
		if (!source) throw new Error(`Preset not found: ${sourceId}`);
		const id = this.generateUniqueId(newName);
		const newPreset: PromptPreset = {
			...clonePreset(source),
			id,
			name: newName.trim(),
			items: source.items.map((item) => ({ ...item, id: crypto.randomUUID() }))
		};
		await apiSend(`/api/presets/${encodeURIComponent(id)}`, 'PUT', { ...this.strip(newPreset), clientId: getClientId() });
		this.presets.set(id, newPreset);
		return newPreset;
	}

	/** A name is not an authoring edit: it lands on the saved preset and on any open draft
	 *  together, so it never shows as an unsaved change and Discard cannot take it back. */
	async renamePreset(id: string, name: string): Promise<PromptPreset> {
		const committed = this.presets.get(id);
		if (!committed) throw new Error(`Preset not found: ${id}`);
		const renamed: PromptPreset = { ...this.clone(committed), name: name.trim() };
		await apiSend(`/api/presets/${encodeURIComponent(id)}`, 'PUT', { ...this.strip(renamed), clientId: getClientId() });
		this.presets.set(id, renamed);
		const draft = this.drafts.get(id);
		if (draft) await this.saveDraft({ ...this.clone(draft), name: renamed.name });
		// The Prompt Builder's working copy would otherwise write the old name back into the draft.
		this.contentVersion++;
		return renamed;
	}

	async deletePreset(id: string): Promise<void> {
		// The cover belongs to this preset alone (import and upload both mint a fresh file),
		// so it goes with it rather than lingering as an orphan nothing can reach. Both sides
		// are collected: a draft that swapped the cover leaves TWO files behind, and only one
		// of them is the one the effective preset names.
		const covers = this.coversOf(id);
		await apiSend(`/api/presets/${encodeURIComponent(id)}`, 'DELETE', { clientId: getClientId() });
		for (const path of covers) await imageService.deleteImage(path);
		this.presets.delete(id);
		this.drafts.delete(id);
		if (this.activePresetId === id) await this.ensureActivePreset();
	}

	async importPresetJson(text: string): Promise<PromptPreset> {
		return this.importPreset(parsePresetJson(text));
	}

	/** Land a parsed preset under a free name. `cover` is a stored image path the caller
	 *  already saved: the PNG card path supplies one, a JSON import never does. */
	async importPreset(imported: ImportedPreset, cover?: string): Promise<PromptPreset> {
		let name = imported.name;
		for (let n = 2; this.isNameTaken(name); n++) name = `${imported.name} (${n})`;
		const complete: PromptPreset = {
			id: this.generateUniqueId(name),
			...imported,
			name,
			...(cover ? { meta: { ...imported.meta, cover } } : {})
		};
		await apiSend(`/api/presets/${encodeURIComponent(complete.id)}`, 'PUT', {
			...this.strip(complete),
			clientId: getClientId()
		});
		this.presets.set(complete.id, complete);
		return complete;
	}

	exportPresetJson(id: string): string {
		const preset = this.getEffective(id);
		if (!preset) throw new Error(`Preset not found: ${id}`);
		return serializePresetJson(preset);
	}

	/** Every cover file one preset is holding: committed and draft can name different ones. */
	private coversOf(id: string): string[] {
		const paths = [this.presets.get(id)?.meta?.cover, this.drafts.get(id)?.meta?.cover];
		return [...new Set(paths.filter((path): path is string => !!path))];
	}

	/** Factory reset: wipe all presets + drafts on the server, then reload defaults. */
	async restoreDefaults(): Promise<void> {
		// Covers are files, not rows: the server's wipe cannot see them, so collect them
		// before the presets that name them are gone.
		const covers = this.getAllPresets().flatMap((preset) => this.coversOf(preset.id));
		await apiSend('/api/presets/restore-defaults', 'POST', { clientId: getClientId() });
		for (const path of covers) await imageService.deleteImage(path);
		await this.loadAll();
		this.activePresetId = null;
		await this.ensureActivePreset();
		this.contentVersion++;
	}

	private generateUniqueId(name: string): string {
		const baseSlug = slugify(name) || 'preset';
		let slug = baseSlug;
		let counter = 1;
		while (this.presets.has(slug)) {
			slug = `${baseSlug}-${counter}`;
			counter++;
		}
		return slug;
	}
}

export const presetService = new PresetService();
