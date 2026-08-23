import type {
	PromptControl,
	PromptControlOption,
	PromptControlType,
	PromptItem,
	PromptPreset,
	PromptPresetBundle,
	PromptPresetMeta,
	PromptRole,
	PromptSection
} from '$lib/types/database';
import { DEFAULT_EXAMPLE_SEPARATOR } from '$lib/macros';
import { DEFAULT_CONTINUE_PROMPT } from '$lib/utils/prompt-assembly';
import { normalizeCarriedRules } from '$lib/utils/regex-rules';
import type { RegexRule } from '$lib/utils/regex-rules';

export interface ImportedPreset {
	name: string;
	items: PromptItem[];
	controls: PromptControl[];
	sections?: PromptSection[];
	bundles?: PromptPresetBundle[];
	meta?: PromptPresetMeta;
	regexRules?: RegexRule[];
	pruneEmptyBlocks: boolean;
	exampleSeparator?: string;
	continuePrompt?: string;
}

const CONTROL_TYPES = new Set<PromptControlType>([
	'text',
	'textarea',
	'toggle',
	'slider',
	'range',
	'select',
	'radio',
	'tags'
]);
const ROLES = new Set<PromptRole>(['system', 'user', 'assistant']);

function objectAt(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

/** Continues the toast's own `Couldn't import "<file>": `. SillyTavern's preset is named rather
 *  than lumped in with corrupt files: it is the one wrong file people bring here on purpose, and
 *  they need to hear "we don't read those" instead of deciding their own file is broken. */
function refusalFor(raw: Record<string, unknown>): string {
	if (Array.isArray(raw.prompts) || Array.isArray(raw.prompt_order)) {
		return 'it is a SillyTavern preset, which ChungusHub does not read. The prompt system here is a different shape, so a preset is rebuilt in the Prompt Builder rather than converted.';
	}
	return 'it is not a ChungusHub preset, since it carries no "items" list';
}

/** Parse the app's complete preset interchange format without mutating existing presets. */
export function parsePresetJson(text: string): ImportedPreset {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	const raw = objectAt(parsed, 'Preset');
	if (!Array.isArray(raw.items)) throw new Error(refusalFor(raw));

	const items = raw.items.map((value, index): PromptItem => {
		const item = objectAt(value, `Item ${index + 1}`);
		if (item.role !== undefined && !ROLES.has(item.role as PromptRole)) {
			throw new Error(`Item ${index + 1} has an unknown role "${String(item.role)}".`);
		}
		return {
			id: crypto.randomUUID(),
			name: typeof item.name === 'string' ? item.name : '',
			role: (item.role as PromptRole | undefined) ?? 'system',
			content: typeof item.content === 'string' ? item.content : '',
			enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
			note: typeof item.note === 'string' && item.note ? item.note : undefined
		};
	});

	const rawControls = raw.controls ?? [];
	if (!Array.isArray(rawControls)) throw new Error('"controls" must be an array when present.');
	const controls = rawControls.map((value, index): PromptControl => {
		const control = objectAt(value, `Control ${index + 1}`);
		if (!CONTROL_TYPES.has(control.type as PromptControlType)) {
			throw new Error(`Control ${index + 1} has an unknown type "${String(control.type)}".`);
		}
		let options: PromptControlOption[] | undefined;
		if (control.options !== undefined) {
			if (!Array.isArray(control.options)) {
				throw new Error(`Control ${index + 1} "options" must be an array.`);
			}
			options = control.options.map((value, optionIndex) => {
				const option = objectAt(value, `Control ${index + 1}, option ${optionIndex + 1}`);
				return {
					id: typeof option.id === 'string' && option.id ? option.id : crypto.randomUUID(),
					label: typeof option.label === 'string' ? option.label : '',
					injectedText: typeof option.injectedText === 'string' ? option.injectedText : '',
					description: typeof option.description === 'string' ? option.description : undefined
				};
			});
		}
		return {
			...(control as unknown as PromptControl),
			id: typeof control.id === 'string' && control.id ? control.id : crypto.randomUUID(),
			macro: typeof control.macro === 'string' ? control.macro : '',
			label: typeof control.label === 'string' ? control.label : '',
			type: control.type as PromptControlType,
			options
		};
	});

	return {
		name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Imported preset',
		items,
		controls,
		sections: parseSections(raw.sections),
		bundles: parseBundles(raw.bundles),
		meta: parseMeta(raw.meta),
		regexRules: normalizeCarriedRules(raw.regexRules),
		pruneEmptyBlocks: raw.pruneEmptyBlocks === true,
		exampleSeparator: asOverride(raw.exampleSeparator, DEFAULT_EXAMPLE_SEPARATOR),
		continuePrompt: asOverride(raw.continuePrompt, DEFAULT_CONTINUE_PROMPT)
	};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Sections are pure presentation, so a malformed one is dropped rather than thrown on:
 *  losing a heading is a cosmetic loss, and refusing the whole preset over it is not. */
function parseSections(raw: unknown): PromptSection[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const sections = raw
		.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
		.filter((section) => typeof section.id === 'string' && section.id.trim())
		.map((section) => ({
			id: (section.id as string).trim(),
			title: typeof section.title === 'string' && section.title.trim() ? section.title : (section.id as string),
			description: optionalString(section.description),
			icon: optionalString(section.icon),
			collapsed: section.collapsed === true
		}));
	return sections.length > 0 ? sections : undefined;
}

function parseBundles(raw: unknown): PromptPresetBundle[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const bundles = raw
		.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
		.filter((bundle) => typeof bundle.name === 'string' && bundle.name.trim())
		.map((bundle, index) => ({
			id: typeof bundle.id === 'string' && bundle.id ? bundle.id : `bundle-${index}`,
			name: (bundle.name as string).trim(),
			description: optionalString(bundle.description),
			values:
				bundle.values && typeof bundle.values === 'object' && !Array.isArray(bundle.values)
					? { ...(bundle.values as Record<string, unknown>) }
					: {}
		}));
	return bundles.length > 0 ? bundles : undefined;
}

/** `cover` is deliberately absent: it is a path into this install's image store, which
 *  means nothing anywhere else. A cover travels as the PNG card's own art instead. */
function parseMeta(raw: unknown): PromptPresetMeta | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const source = raw as Record<string, unknown>;
	const meta: PromptPresetMeta = {
		author: optionalString(source.author),
		version: optionalString(source.version),
		description: optionalString(source.description),
		writtenFor: optionalString(source.writtenFor)
	};
	return Object.values(meta).some((value) => value !== undefined) ? meta : undefined;
}

/**
 * A field the export always materializes comes back as an override only when it actually
 * deviates. Storing the shipped default verbatim would freeze this install's copy of it into
 * the preset: the imported preset would stop tracking the app's default and would show a
 * "Modified"/Reset affordance the importer never earned.
 */
function asOverride(value: unknown, shippedDefault: string): string | undefined {
	if (typeof value !== 'string' || value === shippedDefault) return undefined;
	return value;
}

/**
 * Stable, lossless JSON for clipboard/file export. Runtime prompt-item ids stay local.
 *
 * Every per-preset field is written at its EFFECTIVE value, never left out because the
 * preset happens to be riding a shipped fallback. Storage is override-only so the app's
 * defaults can still improve under an existing preset, but an export is a document a human
 * reads and another install imports: a field that silently vanishes from it reads as a
 * field the preset doesn't own, and there is no way to discover it by looking at the JSON.
 * `pruneEmptyBlocks` was always materialized this way; the two string fields now match it.
 */
export function serializePresetJson(preset: PromptPreset): string {
	return `${JSON.stringify(presetDocument(preset), null, 2)}\n`;
}

/**
 * The interchange document itself: what a `.json` export holds and what rides inside a
 * PNG card's text chunk. `meta.cover` is dropped: it is a path into this install's image
 * store, and a card's own art is what carries a cover across.
 */
export function presetDocument(preset: PromptPreset): Record<string, unknown> {
	const { cover: _cover, ...meta } = preset.meta ?? {};
	return {
		name: preset.name,
		meta: Object.values(meta).some((value) => value !== undefined) ? meta : undefined,
		items: preset.items.map(({ id: _id, ...item }) => item),
		controls: (preset.controls ?? []).map((control) => ({
			...control,
			options: control.options?.map((option) => ({ ...option })),
			defaultOptionIds: control.defaultOptionIds ? [...control.defaultOptionIds] : undefined,
			defaultRange: control.defaultRange ? [...control.defaultRange] : undefined
		})),
		sections: preset.sections?.map((section) => ({ ...section })),
		bundles: preset.bundles?.map((bundle) => ({ ...bundle, values: { ...bundle.values } })),
		regexRules: preset.regexRules?.map((rule) => ({
			...rule,
			targets: [...rule.targets],
			scopes: [...rule.scopes]
		})),
		pruneEmptyBlocks: preset.pruneEmptyBlocks === true,
		exampleSeparator: preset.exampleSeparator ?? DEFAULT_EXAMPLE_SEPARATOR,
		continuePrompt: preset.continuePrompt ?? DEFAULT_CONTINUE_PROMPT
	};
}
