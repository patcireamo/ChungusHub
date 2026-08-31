/**
 * Smoke tests for the pure memory engine. Run with `bun test`.
 *
 * These exercise the parts that must be correct no matter what the LLM returns: batch
 * boundaries and the no-gap invariant, recursive promotion, recall assembly, and (the hard
 * one) branching. The LLM and the database are in-memory fakes, so nothing here touches
 * the app, Svelte, or the network.
 *
 * The centre of gravity is the branching block. The archive boundary is DERIVED from
 * episode coverage rather than stored, so what those tests assert is mostly the absence of
 * writes: walking to another branch and back must restore the boundary exactly, having
 * deleted nothing and spent nothing.
 */

import { describe, expect, test } from 'bun:test';

import { plannedWork, processChat, syncCoverage, type EngineDeps } from './engine';
import {
	activePath,
	changeImpact,
	episodeSeqRanges,
	nextBatch,
	pendingCount,
	resolveCoverage,
	type Coverage
} from './branching';
import { describeMemoryImpact } from './impact-copy';
import { buildRecall } from './recall';
import {
	resolveConfig,
	sanitizeMemoryDefaults,
	followsInherited,
	memorySliderMax,
	MEMORY_CONFIG_FIELDS,
	DEFAULT_MEMORY_CONFIG
} from './config';
import { DEFAULT_EXTRACT_TEMPLATE, DEFAULT_PROMOTE_TEMPLATE, longestRepeatedRun, sceneLengthInstruction } from './prompts';
import type {
	BatchResult,
	Episode,
	LlmFn,
	MemoryConfig,
	MemoryDb,
	MemoryMessage,
	MemoryState,
	PromotionResult
} from './types';

// ===== In-memory MemoryDb (mirrors the server's transactional semantics) =====

class FakeDb implements MemoryDb {
	episodes: Episode[] = [];
	state: MemoryState = { chatId: 'c', enabled: true, autoExtract: true, config: null, updatedAt: 0 };
	// A realistic epoch-scale clock, not a counter starting at zero: episode createdAt is
	// compared against message editedAt, so a fixture whose stamps live in different number
	// ranges would test a comparison that can never happen in the app.
	private clock = 1_700_000_000_000;
	private seq = 0;
	private id(p: string): string {
		return `${p}${++this.seq}`;
	}

	async getState() {
		return { ...this.state };
	}
	async setState(_c: string, patch: Partial<Omit<MemoryState, 'chatId'>>) {
		this.state = { ...this.state, ...patch, updatedAt: ++this.clock };
	}
	async listEpisodes() {
		return this.episodes.map((e) => ({ ...e, sourceMessageIds: [...e.sourceMessageIds] }));
	}

	/**
	 * Mirrors server/db.ts memAssertNoOverlap, the one invariant every write is checked
	 * against, and what replaced the old cursor compare-and-swap. A derived boundary is only
	 * well-defined while no two episodes claim the same turn.
	 */
	private assertNoOverlap(ids: string[]) {
		const incoming = new Set(ids);
		for (const e of this.episodes) {
			if (e.sourceMessageIds.some((id) => incoming.has(id))) {
				throw new Error('mem-op-superseded: episode already covers that message (concurrent update)');
			}
		}
	}

	async applyBatch(chatId: string, r: BatchResult) {
		const drop = new Set(r.supersedeEpisodeIds ?? []);
		this.episodes = this.episodes.filter((e) => !drop.has(e.id));
		this.assertNoOverlap(r.episode.sourceMessageIds);
		this.episodes.push({
			id: this.id('e'),
			chatId,
			layer: 0,
			content: r.episode.content,
			sourceMessageIds: [...r.episode.sourceMessageIds],
			anchorMessageId: r.episode.anchorMessageId,
			createdAt: ++this.clock
		});
	}

	async applyPromotion(chatId: string, r: PromotionResult) {
		const del = new Set(r.deleteEpisodeIds);
		const covered = this.episodes.filter((e) => del.has(e.id));
		// Mirrors the server's supersede guard: merging episodes that are already gone
		// would duplicate their coverage.
		if (covered.length !== r.deleteEpisodeIds.length) {
			throw new Error('mem-op-superseded: episodes to merge changed (concurrent update)');
		}
		// Mirrors the server: the merged episode inherits the newest timestamp it covers, so
		// a higher layer keeps the chronological position of the span it replaced.
		const createdAt = covered.length ? Math.max(...covered.map((e) => e.createdAt)) : ++this.clock;
		this.episodes = this.episodes.filter((e) => !del.has(e.id));
		this.assertNoOverlap(r.insert.sourceMessageIds);
		this.episodes.push({
			id: this.id('e'),
			chatId,
			layer: r.insert.layer,
			content: r.insert.content,
			sourceMessageIds: [...r.insert.sourceMessageIds],
			anchorMessageId: r.insert.anchorMessageId,
			createdAt
		});
	}

	async reapEpisodes(_chatId: string, ids: string[]) {
		const drop = new Set(ids);
		this.episodes = this.episodes.filter((e) => !drop.has(e.id));
	}

	async updateEpisodeContent(_c: string, id: string, content: string) {
		const e = this.episodes.find((x) => x.id === id);
		if (e) e.content = content;
	}

	async reset() {
		this.episodes = [];
	}
}

// ===== Helpers =====

/** A linear chain m0 → m1 → … with alternating roles. */
function linear(n: number): MemoryMessage[] {
	const out: MemoryMessage[] = [];
	for (let i = 0; i < n; i++) {
		out.push({
			id: `m${i}`,
			parentId: i === 0 ? null : `m${i - 1}`,
			role: i % 2 === 0 ? 'user' : 'assistant',
			content: `turn ${i}`,
			speaker: i % 2 === 0 ? 'User' : 'Char'
		});
	}
	return out;
}

type Handler = (db: FakeDb, batchText: string) => unknown;

/** An LLM that runs scripted extraction handlers and a fixed promotion merge. */
function scriptedLlm(handlers: Handler[], db: FakeDb): { llm: LlmFn; calls: () => number } {
	let i = 0;
	let promotions = 0;
	const llm: LlmFn = async (messages) => {
		const text = messages[0].content;
		if (text.includes('EPISODES TO MERGE:')) {
			promotions++;
			return JSON.stringify({ episode: `merged#${promotions}` });
		}
		const h = handlers[Math.min(i, handlers.length - 1)];
		i++;
		return JSON.stringify(h(db, text));
	};
	return { llm, calls: () => i };
}

function deps(db: FakeDb, llm: LlmFn, templates?: Partial<EngineDeps['templates']>): EngineDeps {
	return {
		db,
		llm,
		templates: { extract: DEFAULT_EXTRACT_TEMPLATE, promote: DEFAULT_PROMOTE_TEMPLATE, ...templates }
	};
}

function setConfig(db: FakeDb, cfg: Partial<MemoryConfig>) {
	db.state.config = cfg;
}

const addEp = (n: string) => () => ({ episode: `ep ${n}` });

/** A stored episode, spelled out, for the pure-function tests that need exact coverage. */
function ep2(id: string, sourceMessageIds: string[], createdAt: number, layer = 0): Episode {
	return {
		id,
		chatId: 'c',
		layer,
		content: `sum ${id}`,
		sourceMessageIds,
		anchorMessageId: sourceMessageIds[sourceMessageIds.length - 1] ?? null,
		createdAt
	};
}

/** Where the episodes currently stand against a given path: the whole derived state. */
function coverageOf(db: FakeDb, msgs: MemoryMessage[], leafId: string): Coverage {
	return resolveCoverage(msgs, leafId, db.episodes, resolveConfig(db.state.config).verbatimTail);
}
function cursorOf(db: FakeDb, msgs: MemoryMessage[], leafId: string): string | null {
	return coverageOf(db, msgs, leafId).cursorMessageId;
}

/** Every message claimed as archived must be covered by an ACTIVE episode, and every
 *  active episode must appear in the recall text. Together: folded ⇒ recalled. */
function assertNothingHidden(db: FakeDb, msgs: MemoryMessage[], leafId: string) {
	const c = coverageOf(db, msgs, leafId);
	const covered = new Set(c.active.flatMap((e) => e.sourceMessageIds));
	for (const id of c.archivedIds) expect(covered.has(id)).toBe(true);
	const recall = buildRecall(c.active) ?? '';
	for (const e of c.active) expect(recall).toContain(e.content);
	// And the converse: an active episode may never cover a turn still sent verbatim.
	for (const id of covered) expect(c.archivedIds.has(id)).toBe(true);
}

// ===== Tests =====

describe('config', () => {
	test('clamps and respects defaults', () => {
		expect(resolveConfig(null)).toEqual(DEFAULT_MEMORY_CONFIG);
		expect(resolveConfig({ batchSize: 1 }).batchSize).toBe(2); // below min
		expect(resolveConfig({ batchSize: 999 }).batchSize).toBe(60); // above max
		expect(resolveConfig({ maxLayers: 2 }).maxLayers).toBe(2);
		// promoteCount above maxPerLayer would mean promotion never fires.
		expect(resolveConfig({ maxPerLayer: 3, promoteCount: 20 }).promoteCount).toBe(3);
	});

	test('verbatimTail can never reach zero', () => {
		// At zero the boundary can reach the turn being answered, and {{chatHistory}} filters
		// archived ids, so that turn would drop out of its own prompt, with a summary left
		// speaking for the message the model is replying to.
		expect(resolveConfig({ verbatimTail: 0 }).verbatimTail).toBe(1);
		expect(resolveConfig({ verbatimTail: -5 }).verbatimTail).toBe(1);
	});

	test('the episode length instruction scales with the batch', () => {
		expect(sceneLengthInstruction(12)).toBe('4 to 8 sentences');
		// A tiny batch still gets a floor: one sentence cannot carry a scene.
		expect(sceneLengthInstruction(2)).toBe('3 to 5 sentences');
	});
});

describe('app-wide defaults: what a chat is handed when memory is switched on', () => {
	test('a value still on the shipped default is not stored', () => {
		// "Never set" and "set to the shipped number" have to be one state, because that is
		// what lets enabling write no override at all for a reader who never opened the page.
		expect(sanitizeMemoryDefaults({ batchSize: DEFAULT_MEMORY_CONFIG.batchSize })).toEqual({});
		expect(sanitizeMemoryDefaults(null)).toEqual({});
		expect(sanitizeMemoryDefaults({})).toEqual({});
	});

	test('only real, in-range numbers on known keys survive', () => {
		expect(sanitizeMemoryDefaults({ batchSize: 999 })).toEqual({ batchSize: 60 }); // clamped
		expect(sanitizeMemoryDefaults({ verbatimTail: 0 })).toEqual({ verbatimTail: 1 });
		expect(sanitizeMemoryDefaults({ batchSize: '8' })).toEqual({});
		expect(sanitizeMemoryDefaults({ batchSize: NaN })).toEqual({});
		expect(sanitizeMemoryDefaults({ nonsense: 4 })).toEqual({});
	});

	test('a stored default resolves exactly as the same per-chat override would', () => {
		// The whole seeding path is a copy from one to the other, so the two must agree.
		const defaults = sanitizeMemoryDefaults({ batchSize: 12, verbatimTail: 24 });
		expect(resolveConfig(defaults)).toEqual({
			...DEFAULT_MEMORY_CONFIG,
			batchSize: 12,
			verbatimTail: 24
		});
	});

	test('the shared slider list covers every tunable, within its clamp', () => {
		// One list drives the chat panel and the defaults card; a field missing here is a
		// tunable that silently cannot be set on either surface.
		expect(MEMORY_CONFIG_FIELDS.map((f) => f.key).sort()).toEqual(
			(Object.keys(DEFAULT_MEMORY_CONFIG) as (keyof typeof DEFAULT_MEMORY_CONFIG)[]).sort()
		);
		for (const f of MEMORY_CONFIG_FIELDS) {
			// With maxPerLayer given headroom, because promoteCount is bounded by that as well as
			// by its own clamp, and narrowing it live against the value on screen is exactly what
			// memorySliderMax is for. This checks each field against its OWN ceiling.
			const clamped = resolveConfig({ maxPerLayer: 60, [f.key]: f.max });
			expect(clamped[f.key]).toBe(f.max); // a slider must not offer what the clamp refuses
		}
	});

	test('the override star reads the value in force, not the stored number', () => {
		// A star clicking cannot clear is worse than no star: promoteCount is clamped by
		// maxPerLayer, so the row already follows even though nothing was stored for it.
		expect(followsInherited({ maxPerLayer: 3 }, {}, 'promoteCount')).toBe(true);
		expect(followsInherited({ batchSize: 12 }, { batchSize: 12 }, 'batchSize')).toBe(true);
		// A chat enabled before this default was set runs a number the card no longer holds.
		expect(followsInherited(null, { batchSize: 12 }, 'batchSize')).toBe(false);
		expect(followsInherited({ batchSize: 20 }, { batchSize: 12 }, 'batchSize')).toBe(false);
	});

	test('the merge slider stops where maxPerLayer does', () => {
		// promoteCount above maxPerLayer is clamped away by resolveConfig, so a slider that
		// still offered it would have a silently dead top half.
		expect(memorySliderMax('promoteCount', 5)).toBe(5);
		expect(memorySliderMax('promoteCount', 40)).toBe(20); // its own max still wins
		expect(memorySliderMax('batchSize', 5)).toBe(40); // unaffected by maxPerLayer
	});
});

describe('extraction + boundary + no-gap invariant', () => {
	test('archives whole batches, keeps the verbatim tail live, never leaves a gap', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 2 });
		const msgs = linear(14);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		const res = await processChat(deps(db, llm), 'c', msgs, 'm13');

		// 14 messages, tail 2 → 12 eligible → 3 batches of 4.
		expect(res.batchesDone).toBe(3);
		const c = coverageOf(db, msgs, 'm13');
		expect(c.cursorMessageId).toBe('m11');
		expect(c.archivedIds.size).toBe(12);
		// Every message is either archived or live, never both, never neither.
		const path = activePath(msgs, 'm13');
		expect(path.filter((m) => !c.archivedIds.has(m.id)).map((m) => m.id)).toEqual(['m12', 'm13']);
		assertNothingHidden(db, msgs, 'm13');
	});

	test('does not fire until a full batch is eligible', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 10, verbatimTail: 4 });
		const msgs = linear(12); // 8 eligible < 10
		const { llm, calls } = scriptedLlm([addEp('a')], db);
		const res = await processChat(deps(db, llm), 'c', msgs, 'm11');
		expect(res.batchesDone).toBe(0);
		expect(calls()).toBe(0);
		expect(cursorOf(db, msgs, 'm11')).toBe(null);
	});

	test('disabled chat is a no-op', async () => {
		const db = new FakeDb();
		db.state.enabled = false;
		const { llm, calls } = scriptedLlm([addEp('a')], db);
		const res = await processChat(deps(db, llm), 'c', linear(40), 'm39');
		expect(res.batchesDone).toBe(0);
		expect(calls()).toBe(0);
	});

	test('maxBatches caps a pass and reports that work is left', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(21);
		const { llm } = scriptedLlm([addEp('a')], db);
		const res = await processChat(deps(db, llm), 'c', msgs, 'm20', { maxBatches: 2 });
		expect(res.batchesDone).toBe(2);
		expect(res.capped).toBe(true);
		// The rest is still pending, and a later pass picks it up from the same boundary.
		expect(pendingCount(activePath(msgs, 'm20'), cursorOf(db, msgs, 'm20'), 1)).toBe(12);
		const res2 = await processChat(deps(db, llm), 'c', msgs, 'm20');
		expect(res2.capped).toBe(false);
		assertNothingHidden(db, msgs, 'm20');
	});

	test('a template with no {{batch}} refuses before it spends a call', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const { llm, calls } = scriptedLlm([addEp('a')], db);
		await expect(
			processChat(deps(db, llm, { extract: 'Summarise the scene. Output {"episode":"..."}' }), 'c', linear(12), 'm11')
		).rejects.toThrow('missing {{batch}}');
		expect(calls()).toBe(0);
		expect(db.episodes.length).toBe(0);
	});
});

describe('recursive promotion', () => {
	test('keeps every layer bounded and the top layer compacts in place', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 2, verbatimTail: 1, maxPerLayer: 3, promoteCount: 2, maxLayers: 2 });
		const msgs = linear(41);
		const { llm } = scriptedLlm([addEp('x')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm40');

		const byLayer = new Map<number, number>();
		for (const e of db.episodes) byLayer.set(e.layer, (byLayer.get(e.layer) ?? 0) + 1);
		for (const [layer, n] of byLayer) {
			expect(n).toBeLessThanOrEqual(4); // maxPerLayer + the one that trips promotion
			expect(layer).toBeLessThan(2); // maxLayers
		}
		assertNothingHidden(db, msgs, 'm40');
	});

	test('opening a fresh layer merges like any other promotion', async () => {
		// A step that relabels a single episode upward to open a layer spends no call and
		// compresses nothing, and it always picks the oldest, so the story's opening rides to
		// the top of the ladder at raw layer-0 length, carried up untouched at every layer it
		// passes, beside blocks holding dozens of turns each. Every episode above layer 0 is a
		// merge of promoteCount batches, with a paid call behind it.
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1, maxPerLayer: 5, promoteCount: 3, maxLayers: 3 });
		const msgs = linear(41);
		let merges = 0;
		const llm: LlmFn = async (m) => {
			if (m[0].content.includes('EPISODES TO MERGE:')) return JSON.stringify({ episode: `merged#${++merges}` });
			return JSON.stringify({ episode: 'raw' });
		};
		const res = await processChat(deps(db, llm), 'c', msgs, 'm40');

		const above = db.episodes.filter((e) => e.layer > 0);
		expect(above.length).toBeGreaterThan(0);
		expect(res.promotionsDone).toBe(merges);
		for (const e of above) {
			expect(e.sourceMessageIds.length).toBe(12); // promoteCount × batchSize
			expect(e.content.startsWith('merged#')).toBe(true);
		}
		assertNothingHidden(db, msgs, 'm40');
	});

	test('nothing folded is hidden from recall, even mid-promotion', async () => {
		// The regression this guards: recall used to render only the newest N layer-0
		// episodes while layer 0 held up to maxPerLayer, so a band of the story was dropped
		// from the live history AND left out of recall. Folded must imply recalled.
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 4, maxPerLayer: 6, promoteCount: 3, maxLayers: 3 });
		const msgs = linear(120);
		const { llm } = scriptedLlm([(_d, text) => ({ episode: `scene about ${text.slice(-24)}` })], db);
		await processChat(deps(db, llm), 'c', msgs, 'm119');

		expect(db.episodes.length).toBeGreaterThan(6); // promotion really ran
		expect(db.episodes.some((e) => e.layer >= 1)).toBe(true);
		assertNothingHidden(db, msgs, 'm119');
	});

	test('lowering maxLayers still compacts what already sits above the new ceiling', async () => {
		// The old loop ran `layer < maxLayers`, so anything above the new ceiling fell out of
		// its range entirely: it grew forever while the panel reported a shallower ladder.
		const db = new FakeDb();
		setConfig(db, { batchSize: 2, verbatimTail: 1, maxPerLayer: 3, promoteCount: 2, maxLayers: 3 });
		const msgs = linear(81);
		const { llm } = scriptedLlm([addEp('x')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm80');
		const deepest = Math.max(...db.episodes.map((e) => e.layer));
		expect(deepest).toBeGreaterThanOrEqual(1);

		// Now the user drags the ladder down to one layer and keeps playing.
		setConfig(db, { batchSize: 2, verbatimTail: 1, maxPerLayer: 3, promoteCount: 2, maxLayers: 1 });
		const longer = linear(121);
		await processChat(deps(db, llm), 'c', longer, 'm120');
		// Whatever layer the stranded episodes sit at, it is now capped like any other.
		const counts = new Map<number, number>();
		for (const e of db.episodes) counts.set(e.layer, (counts.get(e.layer) ?? 0) + 1);
		for (const n of counts.values()) expect(n).toBeLessThanOrEqual(4);
		assertNothingHidden(db, longer, 'm120');
	});
});

describe('recall assembly', () => {
	const ep = (over: Partial<Episode>): Episode => ({
		id: 'e',
		chatId: 'c',
		layer: 0,
		content: '',
		sourceMessageIds: [],
		anchorMessageId: null,
		createdAt: 0,
		...over
	});

	test('splits deep from recent, keeps the given order, and returns null when empty', () => {
		expect(buildRecall([])).toBe(null);
		// The input is Coverage.active: story order, root-first, layers interleaved. Nothing
		// is re-sorted here: createdAt stopped tracking story position once a re-folded hole
		// could write the newest row for the oldest turns.
		const out = buildRecall([
			ep({ id: 'e1', layer: 1, content: 'the siege', createdAt: 10 }),
			ep({ id: 'e2', layer: 0, content: 'they made camp', createdAt: 99 }),
			ep({ id: 'e3', layer: 0, content: 'they argued', createdAt: 20 })
		])!;
		expect(out).toContain('Earlier arcs:');
		expect(out).toContain('- the siege');
		expect(out).toContain('Recent events:');
		// Given order survives inside the recent block, whatever the timestamps say.
		expect(out.indexOf('they made camp')).toBeLessThan(out.indexOf('they argued'));
		// Deep memory precedes recent memory.
		expect(out.indexOf('the siege')).toBeLessThan(out.indexOf('they made camp'));
	});

	test('a re-folded hole prints in story order, not in write order', () => {
		// The regression this guards: deleting a turn kills its summary, and the pass that
		// re-reads that stretch writes the NEWEST row covering the OLDEST turns. Sorting by
		// createdAt put the middle of the book after its ending, in every prompt.
		const out = buildRecall([
			ep({ id: 'a', content: 'they met at the gate', createdAt: 100 }),
			ep({ id: 'b', content: 'the road turned north', createdAt: 900 }), // re-folded later
			ep({ id: 'c', content: 'the city burned', createdAt: 300 })
		])!;
		expect(out.indexOf('they met at the gate')).toBeLessThan(out.indexOf('the road turned north'));
		expect(out.indexOf('the road turned north')).toBeLessThan(out.indexOf('the city burned'));
	});

	test('a layer-0-only store renders without an empty Earlier arcs heading', () => {
		const out = buildRecall([ep({ content: 'they met', createdAt: 1 })])!;
		expect(out).not.toContain('Earlier arcs:');
		expect(out.startsWith('Recent events:')).toBe(true);
	});
});

describe('branching: the hard part', () => {
	/** m0..m(n-1) linear, then `branchAt` gets a second child chain of `extra` messages. */
	function forked(n: number, branchAt: number, extra: number): MemoryMessage[] {
		const base = linear(n);
		for (let i = 0; i < extra; i++) {
			base.push({
				id: `b${i}`,
				parentId: i === 0 ? `m${branchAt}` : `b${i - 1}`,
				role: i % 2 === 0 ? 'user' : 'assistant',
				content: `branch ${i}`,
				speaker: 'X'
			});
		}
		return base;
	}

	test('a swipe in the live zone changes nothing', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 2 });
		const msgs = linear(10);
		const { llm } = scriptedLlm([addEp('a'), addEp('b')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm9');
		const before = cursorOf(db, msgs, 'm9');

		// Alternate last reply: a sibling of m9, after the boundary.
		msgs.push({ id: 'm9b', parentId: 'm8', role: 'assistant', content: 'alt', speaker: 'Char' });
		const sync = await syncCoverage({ db }, 'c', msgs, 'm9b');
		expect(sync.reaped).toBe(0);
		expect(cursorOf(db, msgs, 'm9b')).toBe(before);
	});

	test('a deep branch retreats the boundary and DELETES NOTHING', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');
		expect(cursorOf(db, msgs, 'm12')).toBe('m11');
		expect(db.episodes.length).toBe(3);

		// Branch from m3, the end of the first batch's coverage (m0..m3).
		const branched = forked(13, 3, 4);
		const sync = await syncCoverage({ db }, 'c', branched, 'b3');
		expect(sync.reaped).toBe(0);
		expect(db.episodes.length).toBe(3); // the whole point: still there

		const c = coverageOf(db, branched, 'b3');
		expect(c.cursorMessageId).toBe('m3');
		expect(c.active.length).toBe(1);
		expect(c.dormant.length).toBe(2); // batches 2 and 3 belong to the other branch
		expect(c.dead.length).toBe(0);
		assertNothingHidden(db, branched, 'b3');
	});

	test('walking back to the long branch restores the boundary exactly, for free', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm, calls } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');
		const deepBoundary = cursorOf(db, msgs, 'm12');
		const spentBuilding = calls();

		const branched = forked(13, 3, 4);
		await syncCoverage({ db }, 'c', branched, 'b3'); // out to the branch…
		await syncCoverage({ db }, 'c', branched, 'm12'); // …and back

		expect(cursorOf(db, branched, 'm12')).toBe(deepBoundary);
		expect(coverageOf(db, branched, 'm12').active.length).toBe(3);
		expect(coverageOf(db, branched, 'm12').dormant.length).toBe(0);
		expect(calls()).toBe(spentBuilding); // not one extra model call
		assertNothingHidden(db, branched, 'm12');
	});

	test('a merged episode straddling the divergence goes dormant, not away', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 2, verbatimTail: 1, maxPerLayer: 2, promoteCount: 2, maxLayers: 2 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('x')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');
		expect(db.episodes.some((e) => e.layer === 1)).toBe(true);
		const stored = db.episodes.length;

		// Branch at m5, inside the span a merged episode covers.
		const branched = forked(13, 5, 3);
		await syncCoverage({ db }, 'c', branched, 'b2');
		expect(db.episodes.length).toBe(stored);
		// Nothing ACTIVE may cover an off-path message.
		const path = new Set(activePath(branched, 'b2').map((m) => m.id));
		for (const e of coverageOf(db, branched, 'b2').active) {
			for (const id of e.sourceMessageIds) expect(path.has(id)).toBe(true);
		}
		assertNothingHidden(db, branched, 'b2');
		// And it is all back the moment the reader returns.
		await syncCoverage({ db }, 'c', branched, 'm12');
		expect(coverageOf(db, branched, 'm12').dormant.length).toBe(0);
	});

	test('a deep branch keeps at least verbatimTail messages live (the tail is a floor)', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 4 });
		const msgs = linear(20);
		const { llm } = scriptedLlm([addEp('a')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm19');
		expect(cursorOf(db, msgs, 'm19')).toBe('m15');

		// Branch at m9 with a short continuation: the deep boundary would now sit inside the
		// tail of the much shorter path, so batches go dormant until the floor holds.
		const branched = forked(20, 9, 2);
		await syncCoverage({ db }, 'c', branched, 'b1');
		const c = coverageOf(db, branched, 'b1');
		expect(activePath(branched, 'b1').length - c.archivedIds.size).toBeGreaterThanOrEqual(4);
		expect(c.dead.length).toBe(0);
		assertNothingHidden(db, branched, 'b1');
	});

	test('the tail always clears the trailing non-user turns', async () => {
		// The configured floor of 1 assumes the leaf IS the last user turn. Insert a dummy
		// assistant turn from the composer menu (or run Continue, whose path ends on one) and
		// it is not: a tail of 1 then archives the last USER turn, which {{chatHistory}} would
		// then filter out of the prompt entirely.
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		expect(msgs[12].role).toBe('user');
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');
		expect(cursorOf(db, msgs, 'm12')).toBe('m11');

		// Four trailing assistant turns: a batch starting at m12 is now "eligible" by the raw
		// tail, and folding it would archive the last user turn.
		const trailing = [...msgs];
		for (let i = 0; i < 4; i++) {
			trailing.push({
				id: `a${i}`,
				parentId: i === 0 ? 'm12' : `a${i - 1}`,
				role: 'assistant',
				content: 'trailing',
				speaker: 'Char'
			});
		}
		await processChat(deps(db, llm), 'c', trailing, 'a3');
		const c = coverageOf(db, trailing, 'a3');
		expect(db.episodes.length).toBe(3); // nothing new folded
		expect(c.archivedIds.has('m12')).toBe(false);
		expect(c.cursorMessageId).toBe('m11');
		assertNothingHidden(db, trailing, 'a3');
	});

	test('raising then lowering the verbatim tail is completely reversible', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');
		expect(cursorOf(db, msgs, 'm12')).toBe('m11');

		// Raise it: the newest folded turns come back verbatim, their summaries go dormant.
		setConfig(db, { batchSize: 4, verbatimTail: 6 });
		expect(await syncCoverage({ db }, 'c', msgs, 'm12')).toEqual({ reaped: 0 });
		expect(cursorOf(db, msgs, 'm12')).toBe('m3');
		expect(coverageOf(db, msgs, 'm12').dormant.length).toBe(2);
		expect(db.episodes.length).toBe(3);
		assertNothingHidden(db, msgs, 'm12');

		// Lower it again and everything is simply back. This used to cost two summaries.
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		expect(cursorOf(db, msgs, 'm12')).toBe('m11');
		expect(coverageOf(db, msgs, 'm12').active.length).toBe(3);
	});

	test('a tail wider than the chat sends everything verbatim without losing a summary', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');

		setConfig(db, { batchSize: 4, verbatimTail: 40 });
		await syncCoverage({ db }, 'c', msgs, 'm12');
		const c = coverageOf(db, msgs, 'm12');
		expect(c.cursorMessageId).toBe(null);
		expect(c.archivedIds.size).toBe(0);
		expect(db.episodes.length).toBe(3);
		assertNothingHidden(db, msgs, 'm12');
	});

	test('folding never runs over an on-path dormant episode', async () => {
		// The trap: a tail-capped summary is still on this path and will apply again, so
		// re-folding its opening turns would destroy it AND pay for the privilege.
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');

		setConfig(db, { batchSize: 4, verbatimTail: 6 });
		const before = db.episodes.map((e) => e.id).sort();
		await processChat(deps(db, llm), 'c', msgs, 'm12');
		expect(db.episodes.map((e) => e.id).sort()).toEqual(before);
		expect(coverageOf(db, msgs, 'm12').foldCeilingIndex).toBe(4);
	});

	test('a deleted turn kills its own summary and nothing else', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');

		// Splice out m5 the way the app does: the row goes, its child re-parents.
		const spliced = msgs.filter((m) => m.id !== 'm5').map((m) => (m.id === 'm6' ? { ...m, parentId: 'm4' } : m));
		const sync = await syncCoverage({ db }, 'c', spliced, 'm12');
		expect(sync.reaped).toBe(1); // only the batch that covered m5
		expect(db.episodes.length).toBe(2);
		// The hole makes the summaries after it dormant, not dead: they come back once it fills.
		const c = coverageOf(db, spliced, 'm12');
		expect(c.dead.length).toBe(0);
		expect(c.active.length + c.dormant.length).toBe(2);
		assertNothingHidden(db, spliced, 'm12');
	});

	test('a hole narrower than a batch still gets closed, and revives what follows it', async () => {
		// Without the short gap-closing batch this deadlocks: the hole is batchSize-1 wide,
		// the tiling walk stops at it, and every later summary stays dormant forever. A long
		// chat silently reverts to sending its whole history verbatim.
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');

		const spliced = msgs.filter((m) => m.id !== 'm1').map((m) => (m.id === 'm2' ? { ...m, parentId: 'm0' } : m));
		expect(coverageOf(db, spliced, 'm12').active.length).toBe(0); // stalled at the hole

		const { llm: llm2 } = scriptedLlm([addEp('patch')], db);
		await processChat(deps(db, llm2), 'c', spliced, 'm12');
		const c = coverageOf(db, spliced, 'm12');
		expect(c.active.length).toBe(3); // the patch plus both revived summaries
		expect(c.cursorMessageId).toBe('m11');
		assertNothingHidden(db, spliced, 'm12');
	});

	/** A folded 61-message chat with clean 4-turn batches and no promotion in the way. */
	async function foldedLong(db: FakeDb) {
		setConfig(db, { batchSize: 4, verbatimTail: 1, maxPerLayer: 40 });
		const msgs = linear(61);
		const { llm } = scriptedLlm([(_d, t) => ({ episode: `scene ${t.slice(-12)}` })], db);
		await processChat(deps(db, llm), 'c', msgs, 'm60');
		return msgs;
	}

	test('deleting 50 turns mid-chat only kills the summaries that covered them', async () => {
		const db = new FakeDb();
		const msgs = await foldedLong(db);
		const stored = db.episodes.length;
		expect(stored).toBe(15);

		// Rip out m20..m38, a ragged cut that ends mid-batch, the realistic case. The row
		// after the cut re-parents onto the row before it, exactly as a splice delete does.
		const gone = new Set(Array.from({ length: 19 }, (_, i) => `m${20 + i}`));
		const spliced = msgs.filter((m) => !gone.has(m.id)).map((m) => (m.id === 'm39' ? { ...m, parentId: 'm19' } : m));
		const sync = await syncCoverage({ db }, 'c', spliced, 'm60');
		// Five batches touched the deleted span; the other ten are untouched.
		expect(sync.reaped).toBe(5);
		expect(db.episodes.length).toBe(10);

		// The early story is still summarised, and everything past the cut waits as dormant
		// rather than being thrown away with it.
		const c = coverageOf(db, spliced, 'm60');
		expect(c.cursorMessageId).toBe('m19');
		expect(c.active.length).toBe(5);
		expect(c.dormant.length).toBe(5);
		expect(c.dead.length).toBe(0);
		assertNothingHidden(db, spliced, 'm60');

		// One short pass bridges the one-turn hole the cut left, and all five come back.
		const { llm } = scriptedLlm([addEp('bridge')], db);
		await processChat(deps(db, llm), 'c', spliced, 'm60');
		const after = coverageOf(db, spliced, 'm60');
		expect(after.dormant.length).toBe(0);
		expect(after.active.length).toBe(11);
		assertNothingHidden(db, spliced, 'm60');
	});

	test('a cut that lands exactly on batch boundaries leaves no hole at all', async () => {
		const db = new FakeDb();
		const msgs = await foldedLong(db);

		// m20..m39 is precisely five batches, so the surviving coverage stays contiguous
		// across the join and the boundary does not retreat one turn.
		const gone = new Set(Array.from({ length: 20 }, (_, i) => `m${20 + i}`));
		const spliced = msgs.filter((m) => !gone.has(m.id)).map((m) => (m.id === 'm40' ? { ...m, parentId: 'm19' } : m));
		expect((await syncCoverage({ db }, 'c', spliced, 'm60')).reaped).toBe(5);

		const c = coverageOf(db, spliced, 'm60');
		expect(c.cursorMessageId).toBe('m59');
		expect(c.dormant.length).toBe(0);
		assertNothingHidden(db, spliced, 'm60');
	});

	test('an archived turn edited after folding kills its summary; the rest revive', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');

		// Rewrite m1 after the episode covering it was written.
		const afterItsFold = db.episodes.find((e) => e.sourceMessageIds.includes('m1'))!.createdAt + 1;
		const edited = msgs.map((m) => (m.id === 'm1' ? { ...m, editedAt: afterItsFold } : m));
		const sync = await syncCoverage({ db }, 'c', edited, 'm12');
		expect(sync.reaped).toBe(1); // its batch alone
		expect(db.episodes.length).toBe(2);
		expect(coverageOf(db, edited, 'm12').active.length).toBe(0); // stalled behind the hole

		// One paid pass re-reads the rewritten span, and the other two batches apply again.
		const { llm: llm2 } = scriptedLlm([addEp('rewritten')], db);
		await processChat(deps(db, llm2), 'c', edited, 'm12');
		expect(coverageOf(db, edited, 'm12').active.length).toBe(3);
		expect(cursorOf(db, edited, 'm12')).toBe('m11');
	});

	test('an off-path turn rewritten in the story map invalidates its summary too', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');

		// Walk to a branch, then rewrite a turn that is only on the OTHER branch. Its summary
		// is dormant here, so a path-only check would never see the edit.
		const afterItsFold = db.episodes.find((e) => e.sourceMessageIds.includes('m7'))!.createdAt + 1;
		const branched = forked(13, 3, 3);
		const edited = branched.map((m) => (m.id === 'm7' ? { ...m, editedAt: afterItsFold } : m));
		const sync = await syncCoverage({ db }, 'c', edited, 'b2');
		expect(sync.reaped).toBe(1);
	});

	test('dormant vs dead depends on being handed the whole tree, not just the path', () => {
		// The distinction only exists if resolveCoverage can see the rest of the tree: a turn
		// missing from what it is given reads as deleted. Handing it the active path alone
		// therefore calls every off-branch summary "dead", which is what the panel's "N
		// summaries belong to other branches" would then always report as zero.
		const branched = forked(13, 3, 4);
		const eps = [
			ep2('keep', ['m0', 'm1', 'm2', 'm3'], 10),
			ep2('other', ['m4', 'm5', 'm6', 'm7'], 20)
		];

		const whole = resolveCoverage(branched, 'b3', eps, 1);
		expect(whole.dormant.map((e) => e.id)).toEqual(['other']);
		expect(whole.dead.length).toBe(0);

		const pathOnly = resolveCoverage(activePath(branched, 'b3'), 'b3', eps, 1);
		expect(pathOnly.dead.map((e) => e.id)).toEqual(['other']);
		// Either way it stays out of what the model reads, which is why getRecall, whose
		// caller only has the path, is still correct.
		expect(whole.active.map((e) => e.id)).toEqual(pathOnly.active.map((e) => e.id));
		expect([...whole.archivedIds]).toEqual([...pathOnly.archivedIds]);
	});

	test('pendingCount and nextBatch report nothing for a boundary off this path', () => {
		const msgs = forked(10, 3, 3);
		const path = activePath(msgs, 'b2');
		// 'm9' is on the abandoned branch, so it is not on this path at all.
		expect(pendingCount(path, 'm9', 1)).toBe(0);
		expect(nextBatch(path, 'm9', 2, 1)).toBe(null);
	});

	test('an edit that happened before folding is not stale', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		// m5 rides the second batch, folded at clock 2; an edit stamped 1 predates it, so
		// that fold already saw the current wording and memory is valid as-is.
		const msgs = linear(9).map((m) => (m.id === 'm5' ? { ...m, editedAt: 1 } : m));
		const { llm } = scriptedLlm([addEp('a'), addEp('b')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm8');
		expect(await syncCoverage({ db }, 'c', msgs, 'm8')).toEqual({ reaped: 0 });
	});

	test('re-folding a span on a new branch supersedes the old branch summary of it', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a'), addEp('b'), addEp('c')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12');

		// Branch at m5 and play it out far enough that folding reaches across m4..m7,
		// ground the second batch already covers on the abandoned branch.
		const branched = forked(13, 5, 10);
		const { llm: llm2 } = scriptedLlm([addEp('new')], db);
		await processChat(deps(db, llm2), 'c', branched, 'b9');

		// No turn may end up covered twice, on any path.
		const seen = new Set<string>();
		for (const e of db.episodes) {
			for (const id of e.sourceMessageIds) {
				expect(seen.has(id)).toBe(false);
				seen.add(id);
			}
		}
		assertNothingHidden(db, branched, 'b9');
	});
});

describe('cost: every model call is bounded and quoted', () => {
	test('the automatic pass caps its merges however far over the caps the ladder is', async () => {
		// Dragging "summaries per layer" down owes merges immediately, and the next ordinary
		// reply used to pay for all of them: measured at 70 calls for one message, with no
		// confirm, no toast and no number anywhere.
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1, maxPerLayer: 40, promoteCount: 2, maxLayers: 3 });
		const msgs = linear(121);
		const { llm } = scriptedLlm([addEp('x')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm120');
		expect(db.episodes.length).toBeGreaterThan(20);

		setConfig(db, { batchSize: 4, verbatimTail: 1, maxPerLayer: 3, promoteCount: 2, maxLayers: 3 });
		let merges = 0;
		const counting: LlmFn = async (m) => {
			if (m[0].content.includes('EPISODES TO MERGE:')) merges++;
			return JSON.stringify({ episode: 'merged' });
		};
		const auto = await processChat(deps(db, counting), 'c', msgs, 'm120', { maxBatches: 3, maxPromotions: 3 });
		expect(auto.promotionsDone).toBe(3);
		expect(merges).toBe(3);

		// The debt is real, though: an uncapped run (one the user priced and confirmed) works
		// off far more than the automatic pass would ever spend unasked.
		const asked = await processChat(deps(db, counting), 'c', msgs, 'm120');
		expect(asked.promotionsDone).toBeGreaterThan(3);
	});

	test('promotion is reachable with nothing left to extract', async () => {
		// checkAndPromote used to live inside the extraction loop, so a lowered layer cap did
		// nothing at all until some future reply happened to make a batch eligible.
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1, maxPerLayer: 40, promoteCount: 2, maxLayers: 2 });
		const msgs = linear(41);
		const { llm } = scriptedLlm([addEp('x')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm40');
		const stored = db.episodes.length;

		setConfig(db, { batchSize: 4, verbatimTail: 1, maxPerLayer: 3, promoteCount: 2, maxLayers: 2 });
		const res = await processChat(deps(db, llm), 'c', msgs, 'm40');
		expect(res.batchesDone).toBe(0); // nothing to fold…
		expect(res.promotionsDone).toBeGreaterThan(0); // …and the ladder still came down
		expect(db.episodes.length).toBeLessThan(stored);
		assertNothingHidden(db, msgs, 'm40');
	});

	test('a build is quoted with its merges, and the quote holds', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1, maxPerLayer: 3, promoteCount: 2, maxLayers: 2 });
		const config = resolveConfig(db.state.config);
		const msgs = linear(41);

		const quote = plannedWork(msgs, 'm40', coverageOf(db, msgs, 'm40'), config);
		expect(quote.extractions).toBe(10); // 40 foldable turns, batches of 4
		expect(quote.promotions).toBeGreaterThan(0); // …and the ladder they build owes merges

		let calls = 0;
		const llm: LlmFn = async () => {
			calls++;
			return JSON.stringify({ episode: 'x' });
		};
		await processChat(deps(db, llm), 'c', msgs, 'm40');
		expect(calls).toBe(quote.total);
	});

	test('pricing a build counts past a hole, where the pending count stops', () => {
		// pendingCount stops at the fold ceiling because that is as far as the NEXT batch may
		// reach. Pricing from it quoted one pass for a backlog of two dozen.
		const msgs = linear(60);
		const config = resolveConfig({ batchSize: 4, verbatimTail: 1, maxPerLayer: 40 });
		const stranded = ep2('stranded', ['m50', 'm51', 'm52', 'm53'], 10);
		const c = resolveCoverage(msgs, 'm59', [stranded], config.verbatimTail);
		const path = activePath(msgs, 'm59');

		expect(pendingCount(path, c.cursorMessageId, config.verbatimTail, c.foldCeilingIndex)).toBe(50);
		// 50 uncovered turns before the stranded episode (12 full batches + one short one to
		// close the gap), then 4 more before the tail.
		expect(plannedWork(msgs, 'm59', c, config).extractions).toBe(14);
	});
});

describe('forward progress: coverage must stay contiguous', () => {
	/** Splice-delete one message the way the app does: the row goes, its children re-parent. */
	function splice(msgs: MemoryMessage[], id: string): MemoryMessage[] {
		const gone = msgs.find((m) => m.id === id)!;
		return msgs.filter((m) => m.id !== id).map((m) => (m.parentId === id ? { ...m, parentId: gone.parentId } : m));
	}

	/** No stored episode may cover a non-contiguous run of the path that produced it. One
	 *  that does can never apply again, and while it is merely dormant it also sets the fold
	 *  ceiling to its own start, a zero-width window, forever. */
	function assertCoverageContiguous(db: FakeDb, msgs: MemoryMessage[], leafId: string) {
		const idx = new Map(activePath(msgs, leafId).map((m, i) => [m.id, i]));
		for (const e of db.episodes) {
			const pos = e.sourceMessageIds.map((id) => idx.get(id));
			if (pos.some((p) => p === undefined)) continue; // off-path: this path says nothing
			const on = pos as number[];
			expect(Math.max(...on) - Math.min(...on) + 1).toBe(on.length);
		}
	}

	test('an episode whose coverage has a hole is reaped, not left blocking every future fold', () => {
		// Exactly what promotion used to write once a re-folded hole put a higher-layer block
		// between two same-layer episodes. Filed as dormant it set foldCeilingIndex to its own
		// start, so the fold window was zero-width at every path length and nothing could ever
		// be summarised again: no play, no Summarise, nothing short of Re-read.
		const msgs = linear(60);
		const gappy = ep2('gappy', ['m0', 'm1', 'm10', 'm11'], 10, 1);
		const later = ep2('later', ['m12', 'm13', 'm14', 'm15'], 20);

		const c = resolveCoverage(msgs, 'm59', [gappy, later], 12);
		expect(c.dead.map((e) => e.id)).toEqual(['gappy']);
		expect(c.dormant.map((e) => e.id)).toEqual(['later']);
		// The ceiling is the stranded episode ahead, never the frontier itself.
		expect(c.foldCeilingIndex).toBe(12);
		expect(nextBatch(msgs, c.cursorMessageId, 12, 12, c.foldCeilingIndex)).not.toBe(null);
	});

	test('promotion never merges across a higher-layer block, however the ladder is shaped', async () => {
		// The reproduction: fold to completion, delete one archived turn, keep playing. The
		// hole re-folds in front of the already-promoted region, so layer 0 straddles a layer-1
		// block. Merging "the first promoteCount at this layer" would jump the block.
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1, maxPerLayer: 3, promoteCount: 2, maxLayers: 2 });
		let msgs = linear(41);
		let leaf = 'm40';
		const { llm } = scriptedLlm([addEp('x')], db);
		await processChat(deps(db, llm), 'c', msgs, leaf);
		expect(db.episodes.some((e) => e.layer >= 1)).toBe(true);

		msgs = splice(msgs, 'm0');
		await syncCoverage({ db }, 'c', msgs, leaf);

		for (let turn = 0; turn < 8; turn++) {
			const last = msgs[msgs.length - 1].id;
			msgs = [
				...msgs,
				{ id: `x${turn}u`, parentId: last, role: 'user', content: 'more', speaker: 'User' },
				{ id: `x${turn}a`, parentId: `x${turn}u`, role: 'assistant', content: 'more', speaker: 'Char' }
			];
			leaf = `x${turn}a`;
			await syncCoverage({ db }, 'c', msgs, leaf);
			await processChat(deps(db, llm), 'c', msgs, leaf, { maxBatches: 3 });
			assertCoverageContiguous(db, msgs, leaf);
		}

		// And the engine still folds: nothing beyond a partial batch plus the tail is left live.
		// The path ends on an assistant turn, so the enforced tail is 2, not the configured 1.
		await processChat(deps(db, llm), 'c', msgs, leaf);
		const c = coverageOf(db, msgs, leaf);
		expect(activePath(msgs, leaf).length - c.archivedIds.size).toBeLessThan(4 + 2);
		assertNothingHidden(db, msgs, leaf);
	});
});

describe('guards: races and bad model output', () => {
	test('a second fold of the same span is rejected whole', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(13);
		const { llm } = scriptedLlm([addEp('a')], db);
		await processChat(deps(db, llm), 'c', msgs, 'm12', { maxBatches: 1 });
		expect(db.episodes.length).toBe(1);
		const covered = [...db.episodes[0].sourceMessageIds];

		await expect(
			db.applyBatch('c', {
				episode: { content: 'again', sourceMessageIds: covered, anchorMessageId: covered[covered.length - 1] },
				supersedeEpisodeIds: []
			})
		).rejects.toThrow('mem-op-superseded');
		expect(db.episodes.length).toBe(1);
	});

	test('an edit that lands while the model is answering is never committed', async () => {
		// The hole this closes: staleness is judged by comparing the turn's editedAt against
		// the episode's createdAt, and an episode committed AFTER the edit passes that test
		// forever, so a summary of text the user had already replaced would be archived
		// permanently, and every later pass would agree with it. The batch is stamped with
		// the wording it was READ with instead.
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		// The stamp deliberately predates every episode this test writes: that is the point.
		// Only the read-time comparison can see this edit; the createdAt rule never will.
		let msgs = linear(13);
		const llm: LlmFn = async () => {
			msgs = msgs.map((m) => (m.id === 'm1' ? { ...m, editedAt: 1 } : m)); // inside batch 1
			return JSON.stringify({ episode: 'a scene the user has already rewritten' });
		};
		const res = await processChat(deps(db, llm), 'c', msgs, 'm12', {
			latest: () => ({ allMessages: msgs, leafId: 'm12' })
		});
		expect(res.batchesDone).toBe(0);
		expect(db.episodes.length).toBe(0);

		// And the next pass reads the corrected span and folds it for real.
		const { llm: llm2 } = scriptedLlm([addEp('corrected')], db);
		await processChat(deps(db, llm2), 'c', msgs, 'm12');
		expect(cursorOf(db, msgs, 'm12')).toBe('m11');
		expect(await syncCoverage({ db }, 'c', msgs, 'm12')).toEqual({ reaped: 0 });
	});

	test('an unparseable extraction fails loud instead of archiving a placeholder', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const msgs = linear(9);
		const llm: LlmFn = async () => 'I cannot help with that request.';
		await expect(processChat(deps(db, llm), 'c', msgs, 'm8')).rejects.toThrow('returned no episode');
		expect(cursorOf(db, msgs, 'm8')).toBe(null);
		expect(db.episodes.length).toBe(0);
	});

	test('a looping model is retried once, then fails loud', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 1 });
		const looped =
			'She revealed that the wagon was moving through the city before dawn. He agreed to help her. ' +
			'She revealed that the wagon was moving through the city before dawn. He agreed to help her.';
		let calls = 0;
		const llm: LlmFn = async () => {
			calls++;
			return JSON.stringify({ episode: looped });
		};
		await expect(processChat(deps(db, llm), 'c', linear(9), 'm8')).rejects.toThrow('looped');
		expect(calls).toBe(2); // one retry, then loud
		expect(db.episodes.length).toBe(0);
	});

	test('a retry that comes back clean is committed', async () => {
		const db = new FakeDb();
		setConfig(db, { batchSize: 4, verbatimTail: 4 });
		let calls = 0;
		const llm: LlmFn = async () => {
			calls++;
			return JSON.stringify({ episode: calls === 1 ? '' : 'they crossed the river at dusk' });
		};
		const res = await processChat(deps(db, llm), 'c', linear(8), 'm7');
		expect(res.batchesDone).toBe(1);
		expect(db.episodes[0].content).toBe('they crossed the river at dusk');
	});

	test('longestRepeatedRun only fires on genuine loops', () => {
		expect(longestRepeatedRun('Korra took his hand and hated needing it, so she said nothing at all.')).toBeLessThan(12);
		const loop = 'the tripod device suppressed the avatar state within thirty metres of the lot ';
		expect(longestRepeatedRun(loop + loop)).toBeGreaterThanOrEqual(12);
	});
});

describe('naming and pricing a change before it happens', () => {
	// Two batch sizes on one thread: what a chat looks like after the size slider moved.
	// m0-based ids, 1-based seqs: m0 is #1.
	const MSGS = linear(30);
	const PATH = activePath(MSGS, 'm29');
	const span = (from: number, to: number) => MSGS.slice(from, to + 1).map((m) => m.id);
	const EPS = [ep2('e1', span(0, 2), 1), ep2('e2', span(3, 10), 2), ep2('e3', span(11, 20), 3)];
	const COV = resolveCoverage(MSGS, 'm29', EPS, 5);
	const impact = (ids: string[], removed: boolean) =>
		changeImpact(PATH, COV, ids, { removed, batchSize: 8, verbatimTail: 5 });

	test('a summary names the turns it was written from, in the transcript\'s own numbering', () => {
		expect(COV.active.length).toBe(3);
		const ranges = episodeSeqRanges(PATH, EPS);
		expect(ranges.get('e1')).toEqual({ from: 1, to: 3 });
		expect(ranges.get('e2')).toEqual({ from: 4, to: 11 });
		expect(ranges.get('e3')).toEqual({ from: 12, to: 21 });
	});

	test('a summary with a turn off this path has no range to state', () => {
		const offPath = [...MSGS, { id: 'x1', parentId: 'm5', role: 'user' as const, content: 'fork', speaker: 'User' }];
		const ranges = episodeSeqRanges(activePath(offPath, 'm29'), [ep2('ex', ['m5', 'x1'], 4)]);
		expect(ranges.has('ex')).toBe(false);
	});

	test('a gappy row gets no range either: a span over a hole is coverage it does not have', () => {
		// Nothing the engine writes is gappy; an import or a hand-edited row can be, and
		// #1–6 would claim four turns this episode never covered.
		expect(episodeSeqRanges(PATH, [ep2('g', ['m0', 'm5'], 4)]).has('g')).toBe(false);
	});

	test('a merged summary states the whole stretch it stands for', () => {
		const merged = ep2('mg', span(0, 10), 4, 1);
		expect(episodeSeqRanges(PATH, [merged]).get('mg')).toEqual({ from: 1, to: 11 });
	});

	test('a rewrite drops the one summary over it and pauses what follows', () => {
		const i = impact(['m5'], false);
		expect(i.dropped).toBe(1);
		expect(i.span).toEqual({ from: 4, to: 11 });
		// Every turn of that summary is re-read: the rewrite kept all of them.
		expect(i.reread).toBe(8);
		expect(i.passes).toBe(1);
		// e3 sits behind the hole; e1 is in front of it and keeps applying.
		expect(i.paused).toBe(1);
	});

	test('a delete re-reads only the turns that survive it', () => {
		const i = impact(['m5'], true);
		expect(i.dropped).toBe(1);
		expect(i.survivors).toBe(7);
		expect(i.reread).toBe(7);
		expect(i.paused).toBe(1);
	});

	test('a span deleted whole leaves no hole, so nothing is re-read and nothing waits', () => {
		const i = impact(span(3, 10), true);
		expect(i.dropped).toBe(1);
		expect(i.survivors).toBe(0);
		expect(i.reread).toBe(0);
		expect(i.passes).toBe(0);
		expect(i.paused).toBe(0);
	});

	test('survivors a shortened path pushes into the tail are NOT counted as re-read', () => {
		// Rewinding a story: everything from #18 down goes, which takes e3 with it. Its six
		// surviving turns land inside the verbatim tail of the shorter path, where no pass
		// reaches them: promising a re-read here is a promise the engine never keeps.
		const i = impact(span(17, 29), true);
		expect(i.dropped).toBe(1);
		expect(i.survivors).toBe(6);
		expect(i.reread).toBe(1);
		expect(i.passes).toBe(0);
		const lines = describeMemoryImpact(i, { mode: 'delete', auto: true });
		expect(lines.join(' ')).toContain('nothing is re-read');
		expect(lines.join(' ')).not.toContain('pass');
	});

	test('a run shorter than a batch with nothing covered after it folds no passes', () => {
		// The short-batch exception needs a fold ceiling. Bounded by the tail instead, the
		// remainder just waits, exactly as plannedExtractions prices it.
		const eps = [ep2('a1', span(0, 10), 1), ep2('a2', span(11, 13), 2)];
		const cov = resolveCoverage(MSGS, 'm29', eps, 5);
		const i = changeImpact(PATH, cov, ['m12'], { removed: false, batchSize: 8, verbatimTail: 5 });
		expect(i.reread).toBe(3);
		expect(i.paused).toBe(0);
		expect(i.passes).toBe(0);
	});

	test('touching a turn no summary covers costs nothing at all', () => {
		expect(impact(['m27'], false)).toMatchObject({ dropped: 0, paused: 0, reread: 0, droppedStored: 0 });
	});

	test('a stored summary outside the chain is counted, and not classified', () => {
		// `Coverage.dormant` mixes another branch's summaries with ones the tail pushed out
		// and ones stranded past a hole. They return on completely different terms, so the
		// count is reported and the reason is not guessed at.
		const forked = [...MSGS, { id: 'x1', parentId: 'm5', role: 'user' as const, content: 'fork', speaker: 'User' }];
		const eps = [...EPS, ep2('ex', ['x1'], 4)];
		const cov = resolveCoverage(forked, 'm29', eps, 5);
		const i = changeImpact(activePath(forked, 'm29'), cov, ['x1'], { removed: true, batchSize: 8, verbatimTail: 5 });
		expect(i.dropped).toBe(0);
		expect(i.droppedStored).toBe(1);
		expect(i.reread).toBe(0);
		expect(describeMemoryImpact(i, { mode: 'delete', auto: true })).toEqual([
			'1 other stored summary of these turns goes with them.'
		]);
	});

	test('a summary the tail pushed out is never called another branch\'s', () => {
		// Raising the tail parks e3 on THIS path. Editing one of its turns still kills it,
		// so the confirmation has to fire and must not claim the summary was off-branch.
		const cov = resolveCoverage(MSGS, 'm29', EPS, 12);
		const i = changeImpact(PATH, cov, ['m14'], { removed: false, batchSize: 8, verbatimTail: 12 });
		expect(i.dropped).toBe(0);
		expect(i.droppedStored).toBe(1);
		const lines = describeMemoryImpact(i, { mode: 'edit', auto: true });
		expect(lines.join(' ')).not.toContain('other branches');
		expect(lines.join(' ')).not.toContain('lost for good');
	});

	test('the confirmation says what it costs and who pays it back', () => {
		const rewrite = describeMemoryImpact(impact(['m5'], false), { mode: 'edit', auto: true });
		expect(rewrite[0]).toContain('#4 to #11');
		expect(rewrite[0]).toContain('Saving');
		expect(rewrite[1]).toContain('next reply');
		// Manual mode has no next-reply trigger, so it must not promise one.
		const manual = describeMemoryImpact(impact(['m5'], false), { mode: 'edit', auto: false });
		expect(manual[1]).toContain('Memory panel');
		expect(manual[1]).not.toContain('next reply');
		// A whole span going: no re-read to promise, and it says so instead of going quiet.
		const gone = describeMemoryImpact(impact(span(3, 10), true), { mode: 'delete', auto: true });
		expect(gone).toHaveLength(2);
		expect(gone[1]).toContain('nothing is re-read');
		expect(describeMemoryImpact(impact(['m27'], false), { mode: 'edit', auto: true })).toEqual([]);
	});

	test('every sentence agrees with itself at one', () => {
		// Singulars are the common case (one summary dropped, one behind it), and a plural
		// verb there is the first thing a reader notices.
		const one = describeMemoryImpact(
			{ dropped: 1, droppedStored: 1, paused: 1, survivors: 8, reread: 8, passes: 1, span: { from: 4, to: 11 } },
			{ mode: 'edit', auto: true }
		);
		expect(one[0]).toBe('Turns #4 to #11 are summarized in memory. Saving drops that summary, and the 1 summary behind it pauses.');
		expect(one[1]).toBe('Nothing is lost: your next reply re-reads 8 turns (1 pass), and the paused one returns.');
		expect(one[2]).toBe('1 other stored summary of these turns goes with them.');
		// A one-turn episode is reachable: a short batch closing a one-turn hole writes exactly one.
		const single = describeMemoryImpact(
			{ dropped: 1, droppedStored: 0, paused: 0, survivors: 0, reread: 0, passes: 0, span: { from: 7, to: 7 } },
			{ mode: 'delete', auto: true }
		);
		expect(single[0]).toContain('Turn #7 is summarized');
		expect(single[1]).toContain('turns it describes are going too');
	});

	test('a backlog past the automatic cap is not promised to one reply', () => {
		// Rewriting a turn inside a merged summary owes more passes than the post-turn pass
		// will spend, so the sentence must not name a single reply.
		const heavy = describeMemoryImpact(
			{ dropped: 1, droppedStored: 0, paused: 2, survivors: 108, reread: 108, passes: 9, span: { from: 1, to: 108 } },
			{ mode: 'edit', auto: true }
		);
		expect(heavy[1]).toContain('next few replies');
		expect(heavy[1]).not.toContain('next reply re-reads');
	});

	test('a summary in play with no span is a defect, not a sentence', () => {
		expect(() =>
			describeMemoryImpact(
				{ dropped: 1, droppedStored: 0, paused: 0, survivors: 0, reread: 0, passes: 0, span: null },
				{ mode: 'edit', auto: true }
			)
		).toThrow('no turn span');
	});
});
