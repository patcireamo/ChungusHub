/**
 * Renaming a preset, the one lifecycle verb that edits a preset in place. Run with `bun test`.
 *
 * `$state` is shimmed alone because it is the only rune the service uses, so a service that grows
 * another fails here loudly. The transport stub spreads the real module and is put back afterwards:
 * Bun's module registry is shared by every file in the run.
 */
import { describe, test, expect, afterAll, mock } from 'bun:test';

(globalThis as unknown as { $state: unknown }).$state = <T>(value?: T): T | undefined => value;

/** The last body each preset file and each draft file was written with, by endpoint. */
const written = new Map<string, Record<string, unknown>>();

const realTransport = { ...(await import('$lib/services/transport')) };

afterAll(() => {
	mock.module('$lib/services/transport', () => realTransport);
});

mock.module('$lib/services/transport', () => ({
	...realTransport,
	getClientId: () => 'test-client',
	apiGet: async () => ({ presets: [], drafts: [] }),
	apiSend: async (path: string, method: string, body?: Record<string, unknown>) => {
		if (method === 'PUT') written.set(path, structuredClone(body ?? {}));
		return {};
	}
}));

const { presetService, clonePreset } = await import('./presets.svelte');

describe('renaming a preset', () => {
	test('lands on the saved file under the same id and opens no draft', async () => {
		const preset = await presetService.createPreset('Rename Probe Alpha');
		const version = presetService.getContentVersion();

		await presetService.renamePreset(preset.id, '  Renamed Alpha  ');

		expect(presetService.getCommitted(preset.id)?.name).toBe('Renamed Alpha');
		expect(written.get(`/api/presets/${preset.id}`)?.name).toBe('Renamed Alpha');
		expect(presetService.hasDraft(preset.id)).toBe(false);
		// An open Prompt Builder re-clones on this tick, or its next edit writes the old name back.
		expect(presetService.getContentVersion()).toBe(version + 1);
		await presetService.deletePreset(preset.id);
	});

	test('carries an open draft across without saving or dropping its edits', async () => {
		const preset = await presetService.createPreset('Rename Probe Beta');
		const item = { id: crypto.randomUUID(), name: 'Main', role: 'system' as const, content: 'Unsaved text', enabled: true };
		await presetService.saveDraft({ ...clonePreset(presetService.getCommitted(preset.id)!), items: [item] });

		await presetService.renamePreset(preset.id, 'Renamed Beta');

		expect(presetService.hasDraft(preset.id)).toBe(true);
		expect(presetService.getEffective(preset.id)?.name).toBe('Renamed Beta');
		expect(presetService.getEffective(preset.id)?.items.map((i) => i.content)).toEqual(['Unsaved text']);
		expect(presetService.getCommitted(preset.id)?.items).toEqual([]);
		expect(written.get(`/api/presets/${preset.id}/draft`)?.name).toBe('Renamed Beta');
		// Discard hands back the saved preset, which already wears the new name.
		await presetService.discardDraft(preset.id);
		expect(presetService.getEffective(preset.id)?.name).toBe('Renamed Beta');
		await presetService.deletePreset(preset.id);
	});

	test("treats its own name in another case as free and another preset's as taken", async () => {
		const own = await presetService.createPreset('Rename Probe Gamma');
		const other = await presetService.createPreset('Rename Probe Delta');

		expect(presetService.isNameTaken('rename probe GAMMA', own.id)).toBe(false);
		expect(presetService.isNameTaken('rename probe delta', own.id)).toBe(true);
		await presetService.deletePreset(own.id);
		await presetService.deletePreset(other.id);
	});
});
