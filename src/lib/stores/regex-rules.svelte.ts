import { readSetting, writeSetting, registerSettingsReload } from '$lib/services/syncedSetting';
import type { PromptPreset } from '$lib/types/database';
import { DebouncedWriter } from '$lib/utils/debounced-write';
import {
	applyRegexRules,
	carriedRuleEnabled,
	createRegexRule,
	defaultRegexRules,
	normalizeCarriedOverrides,
	normalizeRegexRules,
	rulesWithCarried,
	type RegexRule
} from '$lib/utils/regex-rules';

const SETTINGS_KEY = 'regexRules';
const SAVE_DEBOUNCE_MS = 400;

interface RegexRulesBlob {
	rules: RegexRule[];
	/** Where the reader disagrees with a preset about one of the rules it carries, by rule
	 *  id. **Sparse**: a rule nobody touched is absent and follows whatever the author
	 *  shipped, so a preset that improves a rule's default in its next version reaches
	 *  every reader who never had an opinion about it. Kept here, not in the preset: the
	 *  switch is the reader's, and writing it into the preset would turn a flick of it into
	 *  an unsaved edit of someone else's document. */
	carriedOverrides: Record<string, boolean>;
}

class RegexRulesStore {
	rules = $state<RegexRule[]>([]);
	carriedOverrides = $state<Record<string, boolean>>({});
	// One blob, so one unnamed key. Editor keystrokes sit in its window; the writer
	// commits them rather than let a backgrounded tab lose them or replay them later
	// over a remote change.
	private writer = new DebouncedWriter(SAVE_DEBOUNCE_MS, () => this.write());

	async initialize(): Promise<void> {
		await this.load();
		registerSettingsReload(() => this.syncReload());
	}

	async syncReload(): Promise<void> {
		await this.load();
	}

	private async load(): Promise<void> {
		const raw = await readSetting<Partial<RegexRulesBlob> | null>(SETTINGS_KEY, null);
		this.rules = normalizeRegexRules(raw?.rules);
		this.carriedOverrides = normalizeCarriedOverrides(raw?.carriedOverrides);
	}

	/** The rules a preset ships with, switched-off ones included: what the Regex page lists as
	 *  that preset's own group.
	 *
	 *  The preset is handed in rather than reached for, and that is the whole point: once a
	 *  chat can run a preset of its own, "the active preset" has two answers, and a store
	 *  picking one of them silently is how a story ends up assembled from one preset's items
	 *  while another's rules rewrite what is sent. Each caller names the preset it means: the
	 *  chat surfaces the chat's, the Prompt Builder the one being edited, the Regex page the
	 *  app's. */
	carriedFrom(preset: PromptPreset | null): RegexRule[] {
		return preset?.regexRules ?? [];
	}

	/** Whether one carried rule runs: the reader's switch where they set one, the author's
	 *  shipped state otherwise. */
	carriedEnabled(rule: RegexRule): boolean {
		return carriedRuleEnabled(rule, this.carriedOverrides);
	}

	setCarriedEnabled(rule: RegexRule, enabled: boolean): void {
		const next = { ...this.carriedOverrides };
		// Landing back on what the author shipped drops the key rather than freezing today's
		// value into this install, so the rule resumes tracking the preset's own updates.
		if (enabled === rule.enabled) delete next[rule.id];
		else next[rule.id] = enabled;
		this.carriedOverrides = next;
		this.persist();
	}

	/**
	 * Every rule that actually runs under one preset: the reader's own, then the ones that
	 * preset carries at their effective switch positions. This is what every consumer reads
	 * (the three `AssembleInput` construction sites and the transcript below), so a preset's
	 * presentation layer can never apply on one surface and not another.
	 */
	effectiveFor(preset: PromptPreset | null): RegexRule[] {
		return rulesWithCarried(this.rules, this.carriedFrom(preset), this.carriedOverrides);
	}

	/** Display-side transform for the chat transcript, under the preset the chat runs. Reads
	 *  $state, so callers inside $derived re-run when the rules change. `depth` is the turn's
	 *  distance from the newest one on screen (0 = newest), which is what a depth-bounded rule
	 *  is measured against. */
	forDisplay(text: string, role: string, depth: number, preset: PromptPreset | null): string {
		return applyRegexRules(text, this.effectiveFor(preset), role, 'display', depth);
	}

	/** Append a fresh rule and return it (the UI opens its editor). */
	addRule(partial: Partial<RegexRule> = {}): RegexRule {
		const rule = createRegexRule(partial);
		this.rules.push(rule);
		this.persist();
		return rule;
	}

	updateRule(id: string, patch: Partial<Omit<RegexRule, 'id'>>): void {
		const rule = this.rules.find((r) => r.id === id);
		if (!rule) return;
		Object.assign(rule, patch);
		// Editor fields call this per keystroke, so coalesce the writes.
		this.persistSoon();
	}

	removeRule(id: string): void {
		this.rules = this.rules.filter((r) => r.id !== id);
		this.persist();
	}

	duplicateRule(id: string): RegexRule | null {
		const index = this.rules.findIndex((r) => r.id === id);
		if (index === -1) return null;
		const { id: _sourceId, ...source } = this.rules[index];
		const copy = createRegexRule({
			...source,
			name: `${source.name} (copy)`,
			targets: [...source.targets],
			scopes: [...source.scopes]
		});
		this.rules.splice(index + 1, 0, copy);
		this.persist();
		return copy;
	}

	/** Rules apply in list order, so order is part of the configuration. */
	reorder(ids: string[]): void {
		const byId = new Map(this.rules.map((r) => [r.id, r]));
		const next: RegexRule[] = [];
		for (const id of ids) {
			const rule = byId.get(id);
			if (!rule) continue;
			byId.delete(id);
			next.push(rule);
		}
		// Rules the caller didn't know about (e.g. a concurrent sync) keep a spot at the end
		// rather than being dropped: reorder must never lose rules.
		next.push(...byId.values());
		this.rules = next;
		this.persist();
	}

	/** Append imported rules (ids already freshened by the import parser). */
	importRules(rules: RegexRule[]): void {
		this.rules.push(...rules);
		this.persist();
	}

	/** Replace everything with a fresh copy of the shipped starter pack. */
	restoreDefaults(): void {
		this.rules = defaultRegexRules();
		this.persist();
	}

	private persistSoon(): void {
		this.writer.schedule();
	}

	/** Write now, dropping a waiting debounced write so it can't fire a second time. */
	private persist(): void {
		this.writer.cancel();
		this.write();
	}

	private write(): void {
		writeSetting(SETTINGS_KEY, {
			rules: this.rules,
			carriedOverrides: this.carriedOverrides
		} satisfies RegexRulesBlob);
	}
}

export const regexRulesStore = new RegexRulesStore();
