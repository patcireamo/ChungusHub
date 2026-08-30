/**
 * Cross-boundary contract tests.
 *
 * Most hand-kept couplings in architecture/*.md have been collapsed into a single source or a
 * shared type. What lands here is the residue: pairs of declarations that genuinely
 * cannot be one declaration (a TypeScript union and the SQL that must agree with it, a
 * client list and a `.svelte` file's private constant, an ordering that carries its own
 * information), plus the couplings whose two ends live in modules that must not import
 * each other. For those, "keep these in sync" becomes a failing `bun test` instead of a
 * comment nobody reads.
 *
 * Several tests read source text rather than importing, because importing the server's
 * runtime creates its data directory as a side effect, and a `.svelte` file's internals
 * are not importable at all. Every scan therefore asserts it FOUND something before
 * comparing: a regex that silently stops matching would otherwise turn into a green test
 * that checks nothing, which is worse than the coupling it replaced.
 *
 * Adding a coupling that cannot be derived away? Add its test here.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PROVIDER_NAMES } from '$lib/types/llm';
import { REASONING_DIALECTS } from '$lib/config/sampling';
import { PERMANENT_TRAITS } from '$lib/types/library';
import { MACROS } from '$lib/macros';
import {
	AMBIENT_BASE_SETTINGS,
	AMBIENT_EFFECTS,
	AMBIENT_EFFECT_SETTINGS
} from '$lib/types/ambient';
import { STEERING_ROLES, STEERING_SCOPES } from '$lib/types/steering';
import { palettes } from '$lib/themes/presets';
// The app's own reading, so this contract and the palette editor's readout can never
// drift into disagreeing about what a ratio is.
import { contrastRatio } from '$lib/utils/contrast';
import { SYNC_SCOPES } from '$shared/sync';
import { PROVIDER_PROFILES } from '../../server/llm/providers/index';
import { CAPABILITY_GROUPS, CAPABILITY_PRESETS } from '../../server/assistant/registry/groups';

const ROOT = join(import.meta.dir, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

/** All matches of `re`'s first capture group, asserted non-empty so a stale pattern fails
 *  loudly instead of quietly agreeing with everything. */
function scan(source: string, re: RegExp, what: string): string[] {
	const found = [...source.matchAll(re)].map((m) => m[1]);
	expect(found.length, `found no ${what}, so the scan pattern is stale`).toBeGreaterThan(0);
	return found;
}

/** The body of a named declaration, e.g. `export const FOO = [ … ];`. */
function block(source: string, re: RegExp, what: string): string {
	const m = source.match(re);
	expect(m, `could not locate ${what}, so the scan pattern is stale`).not.toBeNull();
	return m![0];
}

describe('RPC bridge (architecture/client-data-layer.md #1, architecture/server-core.md #1)', () => {
	test('every client proxy method is on the server allowlist', () => {
		const server = read('server', 'db.ts');
		const mutations = scan(
			block(server, /export const MUTATION_SCOPES[\s\S]*?\n\};/, 'MUTATION_SCOPES'),
			/^\t([A-Za-z]+):/gm,
			'mutation methods'
		);
		const reads = scan(
			block(server, /const READ_METHODS = \[[\s\S]*?\n\];/, 'READ_METHODS'),
			/'([A-Za-z]+)'/g,
			'read methods'
		);
		const allowed = new Set([...mutations, ...reads]);

		const proxied = scan(
			read('src', 'lib', 'services', 'database.ts'),
			/this\.call[^(]*\(\s*'([A-Za-z]+)'/g,
			'client proxy calls'
		);

		// The other direction is deliberately NOT asserted: the server exposes methods the
		// client has no proxy for (the assistant reaches them in-process).
		expect([...new Set(proxied)].filter((m) => !allowed.has(m))).toEqual([]);
	});
});

describe('live sync (architecture/client-data-layer.md #2, architecture/server-core.md #2)', () => {
	// The vocabulary itself is shared (shared/sync.ts) and both ends are typed against it,
	// so drift is a compile error. What the compiler cannot see is a scope nobody ever
	// broadcasts, which is dead weight in the client's handler table.
	test('every declared scope is actually broadcast by some mutation', () => {
		const server = read('server', 'db.ts');
		const scopes = new Set(
			scan(
				block(server, /export const MUTATION_SCOPES[\s\S]*?\n\};/, 'MUTATION_SCOPES'),
				/^\t[A-Za-z]+:\s*'([A-Za-z]+)'/gm,
				'mutation scopes'
			)
		);
		for (const m of read('server', 'index.ts').matchAll(/broadcastSync\(\s*'([A-Za-z]+)'/g)) {
			scopes.add(m[1]);
		}
		expect([...SYNC_SCOPES].filter((s) => !scopes.has(s))).toEqual([]);
	});

	// The other half of the same failure, one layer down: a store that READS a settings row
	// but never registers a reload. The write side broadcasts, every other device is told,
	// and nobody listens, so that device keeps its boot-time copy until the page reloads.
	// Four of these had accumulated silently; this is what makes the fifth loud.
	test('every settings reader has a reload path', () => {
		const exempt = [
			'src/lib/services/database.ts', // the RPC proxy: it IS the read
			'src/lib/utils/prompt-builder.ts' // reads per build, so it can never be stale
		];
		const offenders: string[] = [];
		let checked = 0;
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!/\.(ts|svelte)$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
				const rel = full.replaceAll('\\', '/');
				if (exempt.some((path) => rel.endsWith(path))) continue;
				const source = readFileSync(full, 'utf8');
				if (!/\b(readSetting|getSetting)\s*[<(]/.test(source)) continue;
				checked += 1;
				// Either the reader hooks itself into the broadcast, or it exposes the
				// `syncReload` that sync.ts's `settings` handler calls by name.
				if (!/registerSettingsReload|syncReload/.test(source)) {
					offenders.push(rel.slice(rel.indexOf('src/')));
				}
			}
		};
		walk(join(ROOT, 'src', 'lib'));
		expect(checked, 'found no settings readers, so the scan pattern is stale').toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});

describe('notification contract (architecture/ui-shell-settings.md)', () => {
	/** Every `toastStore.<tone>(…)` / `failureText(…)` call in `src`, as its raw argument text.
	 *  Statements end at the first `);`, which none of these calls contains. */
	function notificationCalls(): { file: string; text: string }[] {
		const out: { file: string; text: string }[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!/\.(ts|svelte)$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
				const source = readFileSync(full, 'utf8');
				const rel = full.replaceAll('\\', '/');
				for (const m of source.matchAll(/\b(?:toastStore\.(?:error|warning|info|success|failed)|failureText)\(/g)) {
					const start = m.index + m[0].length;
					const end = source.indexOf(');', start);
					out.push({ file: rel.slice(rel.indexOf('src/')), text: source.slice(start, end === -1 ? start + 300 : end) });
				}
			}
		};
		walk(join(ROOT, 'src'));
		expect(out.length, 'found no notification calls, so the scan pattern is stale').toBeGreaterThan(0);
		return out;
	}

	// A caught error handed straight to the reader names a symptom and nothing else: only the
	// call site knows which of the clicks in front of them produced it. `failed`/`failureText`
	// take the act for exactly that reason, so a thrown value must never reach `error`.
	test('no caught error is dumped into a hand-written message', () => {
		const offenders = notificationCalls()
			.filter((c) => /\binstanceof Error\b/.test(c.text))
			.map((c) => `${c.file}: ${c.text.trim().slice(0, 80)}`);
		expect(offenders).toEqual([]);
	});

});

/** Strips whatever comment `trimmed` sits inside, carrying block-comment state across
 *  lines via `state`. Tuned to how this codebase actually writes comments (block
 *  comments open flush and every JSDoc continuation line's first character is `*`)
 *  rather than to arbitrary JS/HTML, so a shape this misses is a gap worth knowing about. */
function stripComment(trimmed: string, state: { block: 'js' | 'html' | null }): string {
	if (state.block === 'js') {
		const end = trimmed.indexOf('*/');
		if (end === -1) return '';
		state.block = null;
		return trimmed.slice(end + 2);
	}
	if (state.block === 'html') {
		const end = trimmed.indexOf('-->');
		if (end === -1) return '';
		state.block = null;
		return trimmed.slice(end + 3);
	}
	if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
	if (trimmed.startsWith('/*')) {
		const end = trimmed.indexOf('*/', 2);
		if (end === -1) {
			state.block = 'js';
			return '';
		}
		return trimmed.slice(end + 2);
	}
	if (trimmed.startsWith('<!--')) {
		const end = trimmed.indexOf('-->', 4);
		if (end === -1) {
			state.block = 'html';
			return '';
		}
		return trimmed.slice(end + 3);
	}
	return trimmed;
}

/** Every code (non-comment) line under `dir` whose filename passes `match`, as file/text
 *  pairs: the raw material both scans below filter for a dash. */
function codeLines(dir: string, match: (name: string) => boolean): { file: string; text: string }[] {
	const out: { file: string; text: string }[] = [];
	const walk = (d: string): void => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!match(entry.name)) continue;
			const state: { block: 'js' | 'html' | null } = { block: null };
			for (const raw of readFileSync(full, 'utf8').split('\n')) {
				let code = stripComment(raw.trim(), state);
				// A trailing `// comment` after real code on the same line: cut it at the
				// first whitespace-then-`//`, which a genuine string is in practice never
				// shaped like (unlike a bare `//`, which a pasted URL could contain).
				const inline = code.search(/\s\/\//);
				if (inline !== -1) code = code.slice(0, inline);
				if (code) out.push({ file: full.replaceAll('\\', '/'), text: code });
			}
		}
	};
	walk(dir);
	return out;
}

/** Every `.svelte` file under `src/`, as repo-relative paths. */
function svelteFiles(): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith('.svelte')) out.push(full.replaceAll('\\', '/'));
		}
	};
	walk(join(ROOT, 'src'));
	return out;
}

/** The two characters this contract is about, written as escapes so this file can scan for
 *  them without carrying either one. */
const EM_DASH = '\u2014';
const EN_DASH = '\u2013';

/** A line that genuinely needs an em dash says so on the line itself. Greppable, reviewable,
 *  and it travels with the line rather than with the file. */
const DATA_MARKER = 'em-dash: data';

describe('em dash contract (architecture/ui-shell-settings.md)', () => {
	// ONE rule, over every tracked file: the em dash appears nowhere. Not in copy, not in a
	// comment, not in prompt text a model reads, not in a doc, not in a shell script. The
	// character renders as a stray bar in the UI font at message sizes, and a model copies the
	// punctuation it is fed straight back onto the screen, so there is no file type where it is
	// harmless. `git ls-files` is the scope on purpose: a new file, a new directory or a new
	// extension is covered the day it lands, with nothing here to keep in step.
	//
	// The escape hatch is per LINE, never per file. A file allowlist would exempt the regex
	// starter pack's next em dash along with the four it is allowed, and nobody would see it
	// happen. A line that carries the character as DATA (a pattern that matches it, a fixture
	// that proves the pattern, a sample the reader previews) ends with `em-dash: data`.
	test('no tracked file carries an em dash outside a line marked as data', () => {
		const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 })
			.split('\0')
			.filter(Boolean);
		expect(files.length, 'git listed no files, so the scan is stale').toBeGreaterThan(100);
		const offenders: string[] = [];
		for (const file of files) {
			const bytes = readFileSync(join(ROOT, file));
			// A NUL byte means binary: fonts, webp, png. Nothing to read there.
			if (bytes.includes(0)) continue;
			const text = bytes.toString('utf8');
			if (!text.includes(EM_DASH)) continue;
			text.split('\n').forEach((line, i) => {
				if (line.includes(EM_DASH) && !line.includes(DATA_MARKER)) {
					offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
				}
			});
		}
		expect(offenders).toEqual([]);
	});

	// The en dash is a different rule with a narrower reach. It is CORRECT in a range, so a
	// comment or a prompt may hold `seq 4-5` spelled properly, and only text a reader sees is
	// held to the ban. That is why these three stay scoped where the rule above is not.
	//
	// A `.svelte` file's template and script together ARE its UI: no Svelte markup construct,
	// class name, CSS selector or JS identifier can contain one, so any en dash left after
	// stripping comments is authored copy, by construction.
	test('no .svelte file carries an en dash outside a comment', () => {
		const lines = codeLines(join(ROOT, 'src'), (name) => name.endsWith('.svelte'));
		expect(lines.length, 'found no .svelte code lines, so the scan pattern is stale').toBeGreaterThan(0);
		const offenders = lines
			.filter((l) => l.text.includes(EN_DASH))
			.map((l) => `${l.file.slice(l.file.indexOf('src/'))}: ${l.text.slice(0, 100)}`);
		expect(offenders).toEqual([]);
	});

	// src/lib/config/ holds UI-facing config only (labels, hints, icons, settings copy) and
	// nothing else lands there, so unlike most `.ts` it is scopable with no false positives.
	test('no src/lib/config file carries an en dash outside a comment', () => {
		const lines = codeLines(join(ROOT, 'src', 'lib', 'config'), (name) => name.endsWith('.ts'));
		expect(lines.length, 'found no config code lines, so the scan pattern is stale').toBeGreaterThan(0);
		const offenders = lines
			.filter((l) => l.text.includes(EN_DASH))
			.map((l) => `${l.file.slice(l.file.indexOf('src/'))}: ${l.text.slice(0, 100)}`);
		expect(offenders).toEqual([]);
	});

	// The other named UI copy living outside src/: this `describe` renders directly in the
	// Capabilities settings section. `whenToReach` on the same type is prompt text for the
	// model instead (the system prompt's tool index), where a range is legitimate.
	test('no capability group or preset describe carries an en dash', () => {
		const describes = [...CAPABILITY_GROUPS.map((g) => g.describe), ...CAPABILITY_PRESETS.map((p) => p.describe)];
		expect(describes.length, 'found no capability describes, so the scan pattern is stale').toBeGreaterThan(0);
		expect(describes.filter((d) => d.includes(EN_DASH))).toEqual([]);
	});

	/** The comment-stripped text `codeLines` produces, rejoined per file, so a statement spread
	 *  over several lines is one string to match against. */
	function codeSource(dir: string, match: (name: string) => boolean): { file: string; text: string }[] {
		const byFile = new Map<string, string[]>();
		for (const { file, text } of codeLines(dir, match)) {
			byFile.set(file, [...(byFile.get(file) ?? []), text]);
		}
		return [...byFile].map(([file, lines]) => ({ file, text: lines.join('\n') }));
	}

	/** The expression starting at `start`, read to the `,`, `;` or closing bracket that ends it.
	 *  Quote- and template-aware (a `${…}` may hold another template), so a value wrapped over
	 *  several lines is read whole instead of clipped at the first newline. */
	function expressionAt(source: string, start: number): string {
		const open: string[] = [];
		let i = start;
		for (; i < source.length; i += 1) {
			const c = source[i];
			const top = open[open.length - 1];
			const quoted = top === "'" || top === '"' || top === '`';
			if (quoted && c === '\\') {
				i += 1;
				continue;
			}
			if (top === "'" || top === '"') {
				if (c === top) open.pop();
				continue;
			}
			if (top === '`') {
				if (c === '`') open.pop();
				else if (c === '$' && source[i + 1] === '{') {
					open.push('{');
					i += 1;
				}
				continue;
			}
			if (c === "'" || c === '"' || c === '`' || c === '(' || c === '[' || c === '{') {
				open.push(c);
				continue;
			}
			if (c === ')' || c === ']' || c === '}') {
				if (!open.length) break;
				open.pop();
				continue;
			}
			if ((c === ',' || c === ';') && !open.length) break;
		}
		return source.slice(start, i);
	}

	/** Every expression `re` introduces, across `files`. */
	function valuesOf(files: { file: string; text: string }[], ...patterns: RegExp[]): { file: string; text: string }[] {
		const out: { file: string; text: string }[] = [];
		for (const { file, text } of files) {
			for (const re of patterns) {
				for (const m of text.matchAll(re)) out.push({ file, text: expressionAt(text, m.index + m[0].length) });
			}
		}
		return out;
	}

	const dashed = (values: { file: string; text: string }[]): string[] =>
		values
			.filter((v) => v.text.includes(EN_DASH))
			.map((v) => `${v.file.slice(v.file.indexOf('server/'))}: ${v.text.trim().slice(0, 100)}`);

	// A provider's thrown message is not an internal detail: `failureText` folds it into the
	// sentence the reader gets, verbatim, so every throw under server/llm/ is reader copy by
	// construction. The HTTP status table is the same copy through another door: it is thrown by
	// variable, so it is matched on its own shape instead.
	test('no provider failure text carries an en dash', () => {
		const files = codeSource(join(ROOT, 'server', 'llm'), (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
		const shown = valuesOf(files, /throw new Error\(/g, /case \d+:\s*return\s*/g);
		expect(shown.length, 'found no provider failure text, so the scan pattern is stale').toBeGreaterThan(0);
		expect(dashed(shown)).toEqual([]);
	});
});

describe('one house voice (architecture/ui-shell-settings.md)', () => {
	// Three dots typed by hand and a real ellipsis are the same intent set two ways, and
	// the split showed up worst inside one control class: two search fields side by side,
	// one saying "Search chats…" and the other "Search 12 characters...". Spread is the
	// only other `...` a `.svelte` file can contain, and spread is ALWAYS followed by an
	// identifier, a bracket or a brace, so the negative lookahead separates them exactly.
	test('user-facing copy uses the ellipsis character, never three dots', () => {
		const lines = codeLines(join(ROOT, 'src'), (name) => name.endsWith('.svelte'));
		expect(lines.length, 'found no .svelte code lines, so the scan pattern is stale').toBeGreaterThan(0);
		const offenders = lines
			.filter((l) => /\.\.\.(?![A-Za-z0-9_$[({])/.test(l.text))
			// RegexPage prints `\p{...}` as regex SYNTAX in a flag hint, where the three
			// dots are the thing being quoted rather than an elision.
			.filter((l) => !l.text.includes('\\\\p{...}'))
			.map((l) => `${l.file.slice(l.file.indexOf('src/'))}: ${l.text.slice(0, 100)}`);
		expect(offenders).toEqual([]);
	});

	// "when was this" has one answer. utils/date.ts owns the bands, the capitalisation and
	// the Yesterday step; three components used to hand-roll their own and disagreed on all
	// three, so the same row read differently depending on which panel it was in. The give
	// away is a template literal ending in a unit + " ago", or the lowercase "just now" none
	// of them agreed on either.
	test('no surface hand-rolls its own relative time', () => {
		const lines = codeLines(join(ROOT, 'src'), (n) => n.endsWith('.svelte') || n.endsWith('.ts'))
			.filter((l) => !l.file.includes('/utils/date.') && !l.file.endsWith('.test.ts'));
		expect(lines.length, 'walked no source lines, so the scan is stale').toBeGreaterThan(0);
		const offenders = lines
			.filter((l) => /`\$\{[^`]*\}\s*[mhd] ago`|'just now'|"just now"/.test(l.text))
			.map((l) => `${l.file.slice(l.file.indexOf('src/'))}: ${l.text.slice(0, 100)}`);
		expect(offenders).toEqual([]);
	});

	// One platform check, one spelling of a shortcut. Left to themselves the surfaces
	// produced "Ctrl+K" in the title bar, "Ctrl N" on the landing and "Ctrl /" in Settings,
	// two of which sit on screen together.
	test('only ShortcutsSheet knows what platform this is', () => {
		const offenders = svelteFiles()
			.filter((f) => !f.endsWith('ui/ShortcutsSheet.svelte'))
			.filter((f) => /navigator\.platform/.test(readFileSync(f, 'utf8')))
			.map((f) => f.slice(f.indexOf('src/')));
		expect(offenders).toEqual([]);
	});
});

describe('nav labels and panel titles (architecture/ui-shell-settings.md)', () => {
	// One boolean decides two things that must never disagree: the TitleBar's nav
	// buttons carry their labels, and the panels those buttons raise hide their own
	// name line. TitleBar stamps it on the root element and every reader is a CSS
	// selector on that attribute, so the residue is the attribute's NAME, spelled in
	// two files that cannot read each other's strings. Drift either way is a panel
	// named twice on one screen, or a panel with no name anywhere.
	const one = (source: string, re: RegExp, what: string): string => {
		const found = scan(source, re, what);
		expect(found.length, `expected exactly one ${what}`).toBe(1);
		return found[0];
	};

	test('the bar and the panel names read the attribute the bar stamps', () => {
		const titleBar = read('src', 'lib', 'components', 'layout', 'TitleBar.svelte');
		const stamps = scan(
			titleBar,
			/(?:toggle|remove)Attribute\('([a-z-]+)'/g,
			'stamped nav-label attribute in TitleBar.svelte'
		);
		const barReads = scan(
			titleBar,
			/:root:not\(\[([a-z-]+)\]\)/g,
			'nav-label selector in TitleBar.svelte'
		);
		const titleReads = one(
			read('src', 'app.css'),
			/:root\[([a-z-]+)\] \.overlay-title/g,
			'.overlay-title gate in app.css'
		);
		for (const name of [...stamps, ...barReads, titleReads]) expect(name).toBe(stamps[0]);
	});

	test('the label rule measures the dock regime column, not the bar', () => {
		// The probe's width must be the variable the dock branch assigns to the column:
		// fork either spelling and the labels key on a width that is no longer the dock
		// regime's, which on screen is labels reversing direction mid-resize.
		const probeVar = one(
			read('src', 'lib', 'components', 'layout', 'TitleBar.svelte'),
			/\.nav-room-probe \{[^}]*width: var\((--[a-z-]+)\)/g,
			'nav probe width in TitleBar.svelte'
		);
		const css = read('src', 'app.css');
		one(css, new RegExp(`(${probeVar}): min\\(`, 'g'), 'docked column equation in app.css');
		one(
			css,
			new RegExp(`--chat-col-max: var\\((${probeVar})\\)`, 'g'),
			'dock branch consuming the docked column in app.css'
		);
	});
});

describe('shared UI recipes (architecture/ui-shell-settings.md)', () => {
	// `.empty-orb` is the disc ui/EmptyState draws. A panel reaching for it directly is
	// building a second empty state by hand, which is how the app ended up with three orb
	// sizes and headings on some of them but not others.
	test('the empty-state orb is only drawn by ui/EmptyState', () => {
		const offenders = svelteFiles()
			.filter((f) => !f.endsWith('ui/EmptyState.svelte'))
			// MemoryView's is an INTRO card, not an empty state: the panel has a chat and
			// works, it is explaining an engine the reader has not switched on yet.
			.filter((f) => !f.endsWith('memory/MemoryView.svelte'))
			.filter((f) => /empty-orb/.test(readFileSync(f, 'utf8')))
			.map((f) => f.slice(f.indexOf('src/')));
		expect(offenders).toEqual([]);
	});

	// One busy indicator (ui/Spinner). The hand-rolled ring is recognisable by its two
	// halves: a transparent top border and the spin. It had drifted to five sizes.
	test('nothing hand-rolls a spinner ring', () => {
		const offenders = svelteFiles()
			.filter((f) => !f.endsWith('ui/Spinner.svelte'))
			.filter((f) => {
				const s = readFileSync(f, 'utf8');
				return /border-t-transparent[^"']*animate-spin|animate-spin[^"']*border-t-transparent/.test(s);
			})
			.map((f) => f.slice(f.indexOf('src/')));
		expect(offenders).toEqual([]);
	});

	// One switch (ui/Toggle), so "on" looks the same everywhere. Three components used to
	// draw their own at three sizes with three different on-states.
	test('a switch is ui/Toggle', () => {
		const offenders = svelteFiles()
			.filter((f) => !f.endsWith('ui/Toggle.svelte'))
			// The lorebook row's dot carries THREE natures in its colour (always active /
			// keyword / off) and only happens to click as a toggle, so it is not one.
			.filter((f) => !f.endsWith('lorebook/LorebookEntryRow.svelte'))
			// The hint layer SELECTS switches rather than drawing one: the role is a member of
			// its list of what earns a label, which is the opposite of hand-rolling a control.
			.filter((f) => !f.endsWith('layout/HintLayer.svelte'))
			.filter((f) => /role="switch"/.test(readFileSync(f, 'utf8')))
			.map((f) => f.slice(f.indexOf('src/')));
		expect(offenders).toEqual([]);
	});

	// Status colours come from the palette. A `var(--color-error, #ef4444)` fallback never
	// renders (the var is always defined by @theme) and is simply a second, different red
	// sitting in the source claiming to be the app's.
	test('no status colour carries a hardcoded fallback', () => {
		const lines = codeLines(join(ROOT, 'src'), (n) => n.endsWith('.svelte') || n.endsWith('.ts'));
		const offenders = lines
			.filter((l) => /var\(\s*--color-(?:error|success|warning|on-error|on-success)\s*,/.test(l.text))
			.map((l) => `${l.file.slice(l.file.indexOf('src/'))}: ${l.text.slice(0, 100)}`);
		expect(offenders).toEqual([]);
	});
});

describe('test isolation (architecture/testing.md)', () => {
	// bun's module registry is process-wide and one run loads every test file into it, so a
	// stub left standing is served to every file that loads after it, in whatever order the
	// platform walks the tree. It then fails on one OS and not the other, and it fails inside
	// the file that INHERITED the stub rather than the one that left it, which is the worst
	// shape a test failure can take. Every stub is therefore put back by the file that
	// installed it, so each specifier reaches `mock.module` at least twice.
	test('every module stub is restored by the file that installed it', () => {
		const offenders: string[] = [];
		let checked = 0;
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				// This file names the idiom in order to scan for it, and stubs nothing itself.
				if (!entry.name.endsWith('.test.ts') || entry.name === 'contracts.test.ts') continue;
				const source = readFileSync(full, 'utf8');
				if (!source.includes('mock.module(')) continue;
				checked += 1;
				const rel = full.replaceAll('\\', '/');
				const name = rel.slice(rel.lastIndexOf('/') + 1);
				const stubbed = [...source.matchAll(/mock\.module\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
				for (const specifier of new Set(stubbed)) {
					if (stubbed.filter((s) => s === specifier).length < 2) {
						offenders.push(`${name}: ${specifier} is stubbed and never put back`);
					}
				}
				if (!/afterAll\(/.test(source)) offenders.push(`${name}: stubs modules with no afterAll to restore them`);
			}
		};
		for (const root of ['src', 'server']) walk(join(ROOT, root));
		expect(checked, 'found no file stubbing a module, so the scan is stale').toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});

describe('transcript refresh order (architecture/chat-sessions.md #4)', () => {
	// Two reads of the open transcript overlap constantly, since a mutation awaits its own
	// refresh while the sync replay `endStream` fires runs unawaited beside it. The one that
	// resolves last is not the one that read last, and the older publishing over the newer
	// puts a deleted turn back, reverts an edit and moves the branch being read. `overtaken`
	// is what stands the older one down. A second publisher that skips it brings the whole
	// class back, so the loaded transcript is written in exactly one place. The behaviour
	// itself is pinned by src/lib/stores/transcript-refresh.test.ts.
	test('one guarded publisher writes the loaded transcript', () => {
		const source = read('src', 'lib', 'stores', 'chat.svelte.ts');
		// Each assignment with enough of what follows to tell a whole state (carries the rows)
		// from the patches that spread the current one and the clears that write null.
		const assignments = scan(
			source,
			/(this\.currentChatState = [\s\S]{0,240})/g,
			'currentChatState assignments'
		);
		expect(assignments.filter((a) => a.includes('allMessages'))).toHaveLength(1);

		const load = block(source, /\tasync loadChatState\(chatId: string\)[\s\S]*?\n\t\}/, 'loadChatState');
		expect(load).toContain('allMessages: messages');
		expect(load.indexOf('this.overtaken(')).toBeGreaterThan(-1);
		expect(load.indexOf('this.overtaken(')).toBeLessThan(load.indexOf('this.currentChatState = {'));
	});
});

describe('transcript window (architecture/chat-sessions.md #14)', () => {
	// The transcript renders a WINDOW of the branch, so a turn the reader has not loaded back
	// has no row in the document. A surface that points at a turn by resolving `msg-<id>`
	// itself therefore finds nothing for anything behind that window, and on screen that reads
	// as the turn having been deleted. Pointing goes through `messageStore.revealMessage` (or
	// `revealTargetId`, which it sets); the transcript loads the turn back in and flashes it.
	// The two files exempted below are the transcript itself: they own the window, so they are
	// the only place that may reach for a row directly.
	const OWNS_THE_WINDOW = ['components/chat/MessageList.svelte', 'components/chat/ChatSearchBar.svelte'];

	test('nothing outside the transcript resolves a message row from the DOM', () => {
		const offenders: string[] = [];
		let checked = 0;
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!/\.(ts|svelte)$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
				const rel = full.replaceAll('\\', '/').slice(full.replaceAll('\\', '/').indexOf('src/lib/') + 8);
				if (OWNS_THE_WINDOW.includes(rel)) continue;
				checked += 1;
				// Every shape that reaches a turn's row: the id template, the CSS id selector,
				// and the prefix selector the selection walker uses.
				if (/msg-\$\{|['"`]#msg-|\[id\^=['"]msg-/.test(readFileSync(full, 'utf8'))) {
					offenders.push(rel);
				}
			}
		};
		walk(join(ROOT, 'src', 'lib'));
		expect(checked, 'walked no source files, so the scan is stale').toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});

describe('transcript scroll writes (architecture/chat-sessions.md #15)', () => {
	// The message list is the one box in the app that glides: the `scroll-behavior: smooth`
	// in its own CSS is what lets `ChatContainer` forward a wheel from the empty margin
	// beside it by writing `scrollTop` and letting that animator do the travel. The price is
	// that `behavior: 'auto'` does not mean "jump" here. It DEFERS to that CSS, and so does a
	// plain `scrollTop` write, so a scroll meant to land instead travels: read as the
	// default, it animates the correction that holds the reading position after earlier turns
	// load, and the reader watches the whole stretch that just arrived fly past. Nothing in
	// the type system separates the two, since all three spellings are a valid ScrollBehavior.
	const OWNS_THE_SCROLLER = ['MessageList.svelte', 'ChatSearchBar.svelte'];

	// Both directions. Dropping the CSS kills the margin wheel's feel, and a SECOND scroller
	// growing it turns every `'auto'` write aimed at that one into a glide as well.
	test('the transcript scroller is the only one that glides', () => {
		// The declaration itself, off `codeLines`: the rule is quoted in the comments around
		// it, and a scan reading those would agree with a stylesheet that had lost it.
		const smooth = [
			...new Set(
				codeLines(join(ROOT, 'src'), (n) => n.endsWith('.svelte'))
					.filter((l) => /^scroll-behavior:\s*smooth\b/.test(l.text))
					.map((l) => l.file.slice(l.file.indexOf('src/')))
			)
		];
		expect(smooth).toEqual(['src/lib/components/chat/MessageList.svelte']);
	});

	// A bare ban on the word rather than a hunt for the shapes it arrives in: it fits an
	// option field, a ternary and a plain argument alike, and the next shape is free. The
	// deliberate travels say `'smooth'` and mean it.
	test('nothing scrolling it asks for `auto`', () => {
		const offenders = OWNS_THE_SCROLLER.filter((name) => {
			const source = read('src', 'lib', 'components', 'chat', name);
			expect(source, `${name} scrolls nothing any more, so this scan is stale`).toContain("'instant'");
			return source.includes("'auto'");
		});
		expect(offenders).toEqual([]);
	});
});

describe('commands (architecture/chat-sessions.md)', () => {
	// The registry is the whole vocabulary and the palette renders from it, so almost nothing
	// here can drift. What is left is the residue that fails SILENTLY: a command whose group
	// has no section is filtered out of a grouped palette and so does not exist for anyone
	// who did not already know its name, a second claim on a spelling shadows the first in
	// the lookup map, and a spelling the parser cannot produce can never be typed at all.
	//
	// Read rather than imported: the registry reaches the stores, and a runes module cannot
	// be evaluated here. Every scan asserts it found something first.
	const source = read('src', 'lib', 'commands', 'registry.ts');
	const names = scan(source, /^\t\tname: '([a-z0-9-]+)',$/gm, 'command names');
	const groups = scan(source, /^\t\tgroup: '([a-z]+)',$/gm, 'command groups');
	const sections = scan(source, /^\t\{ id: '([a-z]+)', label: '[^']+' \}/gm, 'palette sections');
	const aliases = [...source.matchAll(/^\t\taliases: \[([^\]]+)\],$/gm)].flatMap((m) =>
		m[1].split(',').map((spelling) => spelling.trim().replace(/^'|'$/g, ''))
	);

	test('every command sits in a group the palette renders', () => {
		expect(names.length).toBe(groups.length);
		expect(groups.filter((group) => !sections.includes(group))).toEqual([]);
	});

	test('no name or alias is claimed twice', () => {
		const spellings = [...names, ...aliases];
		expect(aliases.length, 'found no aliases, so that scan pattern is stale').toBeGreaterThan(0);
		expect(spellings.filter((s, i) => spellings.indexOf(s) !== i)).toEqual([]);
	});

	test('every spelling is one the parser can produce', () => {
		// `parseCommandInput` lowercases and cuts at the first space, so anything carrying a
		// capital, a space or a slash is a row nobody can ever reach by typing.
		expect([...names, ...aliases].filter((s) => !/^[a-z][a-z0-9-]*$/.test(s))).toEqual([]);
	});
});

describe('shortcuts (architecture/ui-shell-settings.md)', () => {
	// The key registry is both the matcher and what the sheet draws, so a key cannot be bound
	// as one thing and documented as another. What is left is residue that fails SILENTLY, and
	// silence is the whole problem with a keyboard: nothing on screen says a press did nothing.
	//
	// Read rather than imported, the same reason as the commands block above: the registry
	// reaches the stores and a runes module cannot be evaluated here.
	const source = read('src', 'lib', 'commands', 'shortcuts.svelte.ts');
	const list = source.slice(source.indexOf('export const SHORTCUTS'));
	const rows = list.slice(0, list.indexOf('\n];')).split(/\n\t\{/).slice(1);
	const groups = scan(source, /\bgroup: '([a-z]+)'/g, 'shortcut groups');
	const sections = scan(source, /^\t\{ id: '([a-z]+)', label: '[^']+' \}/gm, 'sheet sections');

	test('every shortcut sits in a group the sheet renders', () => {
		expect(groups.filter((group) => !sections.includes(group))).toEqual([]);
	});

	test('no two shortcuts answer to the same press', () => {
		// The first match wins and the second is dead with nothing saying so, on screen or in
		// the sheet, which lists both.
		const combos = scan(source, /\bbinding: \{ ([^}]+) \}/g, 'shortcut bindings').flatMap((binding) => {
			// Every quoted string in a binding is one of its spellings, whether it names a key or
			// a position; the modifiers are booleans. A binding with none can never be pressed.
			const keys = [...binding.matchAll(/'([^']+)'/g)].map((match) => match[1].toLowerCase());
			expect(keys.length, `a binding with neither key nor code: ${binding}`).toBeGreaterThan(0);
			const parts = ['mod', 'shift', 'alt'].filter((flag) => new RegExp(`\\b${flag}: true`).test(binding));
			return keys.map((key) => [...parts, key].join('+'));
		});
		expect(combos.filter((combo, i) => combos.indexOf(combo) !== i)).toEqual([]);
	});

	test('a row either binds and runs, or documents a key it does not own', () => {
		// `matchShortcut` skips a row with no `run`, so a bound row without one is a key the
		// sheet promises and nothing answers; chips beside a binding are dead copy, since the
		// sheet draws a bound row's keys from the binding itself.
		expect(rows.length, 'found no shortcut rows, so the split is stale').toBeGreaterThan(0);
		const offenders = rows
			.map((row) => ({
				id: row.match(/id: '([^']+)'/)?.[1] ?? '(unnamed)',
				bound: /\bbinding: \{/.test(row),
				runs: /\brun: /.test(row),
				chips: /\bchips: \[/.test(row)
			}))
			.filter((row) => (row.bound ? !row.runs || row.chips : !row.chips || row.runs))
			.map((row) => row.id);
		expect(offenders).toEqual([]);
	});
});

describe('destructive-act ladder (architecture/ui-shell-settings.md)', () => {
	// Deletion asks BEFORE the act and is final afterwards. The undo channel is gone by
	// decision, not by accident: two of its three implementations deferred the real delete
	// behind a page-lifetime timer (a closed tab resurrected the chat, a second device kept
	// showing it), and each grew a shadow list purely to lie to sync about rows not yet
	// deleted. A new surface reaching for a post-hoc undo is this failure growing back.
	test('no surface re-grows a post-hoc undo', () => {
		const offenders: string[] = [];
		let checked = 0;
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!/\.(ts|svelte)$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
				checked += 1;
				const source = readFileSync(full, 'utf8');
				if (/\b(?:withAction|pendingDeletes|undoDelete)\b/.test(source)) {
					const rel = full.replaceAll('\\', '/');
					offenders.push(rel.slice(rel.indexOf('src/')));
				}
			}
		};
		walk(join(ROOT, 'src', 'lib'));
		expect(checked, 'walked no source files, so the scan is stale').toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});

describe('websocket messages (architecture/client-data-layer.md #3, architecture/server-core.md #4)', () => {
	test('every message the client sends has a server handler', () => {
		const sent = new Set(
			scan(
				read('src', 'lib', 'services', 'transport.ts'),
				/\bt:\s*'([a-z-]+)'/g,
				'client-sent WS discriminators'
			)
		);
		const handled = new Set(
			scan(read('server', 'index.ts'), /msg\.t === '([a-z-]+)'/g, 'server WS handlers')
		);
		// 'sync' travels server→client only, so it has no inbound handler by design.
		expect([...sent].filter((t) => t !== 'sync' && !handled.has(t))).toEqual([]);
	});
});

describe('capability groups (architecture/chungus-assistant.md)', () => {
	// CAPABILITY_GROUPS is what gates every tool, generates the prompt's tool index, and
	// fills the Capabilities page. A capability missing from it would be ungatable and
	// unnamed; a family naming a tool that no longer exists would price a switch wrong.
	// groups.ts is pure (no imports at all), so this one imports rather than scanning; the
	// capability NAMES are scanned, because importing the registry opens the database.
	const capabilityNames = (): string[] => {
		const dir = join(ROOT, 'server', 'assistant', 'registry');
		const sources = readdirSync(dir)
			.filter((f) => f.endsWith('.ts'))
			.map((f) => readFileSync(join(dir, f), 'utf8'))
			.join('\n');
		// A capability's `name` is the only top-level `name:` in these modules; a ParamDef's
		// sits inline inside an array literal, never at one tab of indent.
		return scan(sources, /^\tname: '([a-z_]+)',$/gm, 'capability definitions');
	};

	test('the families partition every capability', () => {
		const grouped = CAPABILITY_GROUPS.flatMap((g) => g.tools);
		expect(new Set(grouped).size, 'a tool is listed in two families').toBe(grouped.length);
		expect([...grouped].sort()).toEqual([...capabilityNames()].sort());
	});

	test('every preset names real families, and none drops an always-on one', () => {
		const ids = new Set(CAPABILITY_GROUPS.map((g) => g.id));
		const alwaysOn = CAPABILITY_GROUPS.filter((g) => g.alwaysOn).map((g) => g.id);
		for (const preset of CAPABILITY_PRESETS) {
			expect(preset.groups.filter((g) => !ids.has(g)), `preset ${preset.id} names an unknown family`).toEqual([]);
			expect(alwaysOn.filter((g) => !preset.groups.includes(g)), `preset ${preset.id} drops an always-on family`).toEqual([]);
		}
	});

	// Experimental is a promise to the user: the family is opt-in per workspace, so no preset
	// may hand it out. A preset that did would flip it on with one tap and no badge in sight.
	test('no preset hands out an experimental family', () => {
		const experimental = CAPABILITY_GROUPS.filter((g) => g.experimental).map((g) => g.id);
		expect(experimental.length, 'no experimental family left, so retire this test with the flag').toBeGreaterThan(0);
		for (const preset of CAPABILITY_PRESETS) {
			expect(preset.groups.filter((g) => experimental.includes(g)), `preset ${preset.id} includes an experimental family`).toEqual([]);
		}
	});

	// One capability per `export const X: Capability = {`, up to the next one, scanned rather
	// than imported, for the same reason as above.
	const capabilityBlocks = (): { name: string; body: string }[] => {
		const dir = join(ROOT, 'server', 'assistant', 'registry');
		const out: { name: string; body: string }[] = [];
		for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
			for (const body of readFileSync(join(dir, file), 'utf8').split(/^export const \w+: Capability = \{$/m).slice(1)) {
				const name = /^\tname: '([a-z_]+)',$/m.exec(body)?.[1];
				if (name) out.push({ name, body });
			}
		}
		expect(out.length, 'no capability definitions found, so the scan pattern went stale').toBeGreaterThan(0);
		return out;
	};

	// The whole approval policy is a threshold on `risk` (server/assistant/types.ts). A
	// capability that declares none would be judged by the registry's unknown-tool fallback and
	// asked about in every mode, which reads as a broken switch rather than as the bug it is.
	test('every capability declares its rung on the ladder', () => {
		const undeclared = capabilityBlocks()
			.filter(({ body }) => !/^\trisk: '(read|write|delete)',$/m.test(body))
			.map(({ name }) => name);
		expect(undeclared, 'a capability with no risk class cannot be placed against an approval mode').toEqual([]);
	});

	// The approval card is built by the capabilities themselves. One that writes without a
	// `preview` falls back to its tool name and its raw arguments, which is a row asking the
	// user to trust a change nobody described.
	test('every capability that writes says what it will write', () => {
		const blind = capabilityBlocks()
			.filter(({ body }) => !/^\trisk: 'read',$/m.test(body) && !/^\tpreview\(/m.test(body))
			.map(({ name }) => name);
		expect(blind, 'a mutating capability with no preview shows the user its raw arguments').toEqual([]);
	});

	// A tool whose rung depends on its arguments is let through the cheap name-only pass so the
	// preview can price it. With no preview to answer, it would be asked about in Auto whatever
	// it turned out to be. The gate would work, but every `switch` would stop the turn.
	test('every escalating capability has the preview that decides its rung', () => {
		const escalating = capabilityBlocks().filter(({ body }) => /^\tescalates: true,$/m.test(body));
		expect(escalating.length, 'no escalating capability left, so retire this test with the flag').toBeGreaterThan(0);
		for (const { name, body } of escalating) {
			expect(/^\trisk: 'write',$/m.test(body), `${name} escalates from a rung that is not \`write\``).toBe(true);
			expect(/risk: 'delete'/.test(body), `${name} escalates but its preview never raises the rung`).toBe(true);
		}
	});
});

describe('provider vocabulary (architecture/llm-providers.md #1)', () => {
	// PROVIDER_NAMES is the single client source (ProviderName derives from it). The server
	// keeps its own union and profile list because the two sides never import each other.
	test('server profiles cover exactly the client provider list', () => {
		expect(PROVIDER_PROFILES.map((p) => p.name).sort()).toEqual([...PROVIDER_NAMES].sort());
	});

	test("the server's ProviderName union matches the client list", () => {
		const union = scan(
			block(read('server', 'llm', 'types.ts'), /export type ProviderName =[\s\S]*?;/, 'ProviderName'),
			/'([a-z-]+)'/g,
			'server provider names'
		);
		expect(union.sort()).toEqual([...PROVIDER_NAMES].sort());
	});
});

describe('prompt target (architecture/prompt-pipeline.md #10)', () => {
	// Every surface that assembles a prompt prices and shapes it against a connection's model,
	// context window and post-processing. Resolve those per surface and a chat can be metered
	// against one context window while the send rides another, with the review dialog naming a
	// third and nothing on screen saying so. `resolvePromptTarget` is the one resolution.
	const ASSEMBLY_SITES = [
		['src', 'lib', 'utils', 'prompt-builder.ts'],
		['src', 'lib', 'components', 'chat', 'InputArea.svelte'],
		['src', 'lib', 'components', 'promptBuilder', 'PromptBuilderView.svelte']
	];

	test('every AssembleInput site takes its connection terms from the resolver', () => {
		for (const site of ASSEMBLY_SITES) {
			const where = site.join('/');
			const source = read(...site);
			expect(source, `${where} must resolve a prompt target`).toContain('resolvePromptTarget(');
			for (const field of ['model', 'postProcessing', 'contextBudget']) {
				expect(source, `${where} must assemble with promptTarget.${field}`).toContain(
					`${field}: promptTarget.${field}`
				);
			}
		}
	});

	test('no assembling surface resolves a connection itself', () => {
		const own = /llmService\.(getPrimaryModel|getPromptTokenBudget|getPromptPostProcessing|getPromptPlaceholder)\(/;
		for (const site of [...ASSEMBLY_SITES, ['src', 'lib', 'utils', 'live-macro-context.ts']]) {
			expect(own.test(read(...site)), `${site.join('/')} resolves its own connection`).toBe(false);
		}
	});

	test('the story generations send on the connection they were assembled for', () => {
		const calls = scan(
			read('src', 'lib', 'stores', 'messages.svelte.ts'),
			/llmService\.complete\(([^,]+),/g,
			'story completion calls'
		);
		expect(calls.map((t) => t.trim())).toEqual(calls.map(() => 'callTarget'));
	});
});

describe('sampling parameters (architecture/prompt-pipeline.md #2, architecture/llm-providers.md #2, #4)', () => {
	/** The string literals of both policy type declarations, comments excluded. */
	const policyLiterals = (...path: string[]): string[] => {
		const src = read(...path);
		const decls = [
			block(src, /export type ResolvedParamPolicy =[^;]*;/, `ResolvedParamPolicy in ${path.at(-1)}`),
			block(src, /export type ParamPolicy =[^;]*;/, `ParamPolicy in ${path.at(-1)}`)
		].join('\n');
		return [...new Set(scan(decls, /'([a-z-]+)'/g, `${path.at(-1)} policy literals`))].sort();
	};

	// The profiles declare it server-side; the client renders and builds requests from it.
	// Neither side imports the other, so the union is mirrored by hand. A literal on one
	// side only is a policy that silently mis-branches: 'declared' reaching the client
	// helpers unresolved would fall straight through to the 'reported' path.
	test('both ParamPolicy copies carry the same vocabulary', () => {
		expect(policyLiterals('server', 'llm', 'providers', 'types.ts')).toEqual(
			policyLiterals('src', 'lib', 'types', 'llm.ts')
		);
	});

	test('every provider allow-list entry is a real slider field or a known non-sampling param', () => {
		const sliders = new Set(
			scan(read('src', 'lib', 'config', 'sampling.ts'), /apiField: '([a-z_]+)'/g, 'slider apiFields')
		);
		// Request fields the app sends outside the sampling sliders; a provider may still
		// have to declare them in its allow-list.
		const nonSampling = new Set(['max_tokens', 'max_completion_tokens', 'seed']);

		const dir = join(ROOT, 'server', 'llm', 'providers');
		const skip = new Set(['index.ts', 'types.ts', 'util.ts', 'openai-compatible.ts']);
		const offenders: string[] = [];
		let checked = 0;
		for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !skip.has(f))) {
			const m = readFileSync(join(dir, file), 'utf8').match(/paramPolicy:\s*\[[\s\S]*?\]/);
			if (!m) continue; // 'reported' / 'base-only' / absent, so no static list to check
			checked += 1;
			for (const p of m[0].matchAll(/'([a-z_]+)'/g)) {
				if (!sliders.has(p[1]) && !nonSampling.has(p[1])) offenders.push(`${file}: ${p[1]}`);
			}
		}
		expect(checked, 'found no static provider allow-lists, so the scan pattern is stale').toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});

describe('reasoning + tuning shapes (architecture/llm-providers.md #2)', () => {
	const stripComments = (s: string): string =>
		s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

	const SERVER = ['server', 'llm', 'types.ts'];
	const CLIENT = ['src', 'lib', 'types', 'llm.ts'];

	/** One interface's top-level field names, comments stripped so prose can differ. */
	const fields = (path: string[], name: string): string[] => {
		const body = stripComments(
			block(read(...path), new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`), `${name} in ${path.at(-1)}`)
		);
		return scan(body, /^\t(\w+)\??:/gm, `${name} fields in ${path.at(-1)}`).sort();
	};

	/** One interface's string literals: the wire values its fields may carry. */
	const literals = (path: string[], name: string): string[] => {
		const body = stripComments(
			block(read(...path), new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`), `${name} in ${path.at(-1)}`)
		);
		return [...new Set(scan(body, /'([a-z_-]+)'/g, `${name} literals in ${path.at(-1)}`))].sort();
	};

	// The profiles declare a ReasoningPolicy server-side and applyTuning translates it; the
	// client renders the effort pills from the same shape and, for a declared (BYO) dialect,
	// puts a policy on the wire. Neither side imports the other. A field or a wire value that
	// exists on one side only is a control that renders and sends nothing, or a request field
	// nothing can ever produce.
	test('both ReasoningPolicy copies carry the same fields', () => {
		expect(fields(SERVER, 'ReasoningPolicy')).toEqual(fields(CLIENT, 'ReasoningPolicy'));
	});

	test('both ReasoningPolicy copies carry the same wire values', () => {
		expect(literals(SERVER, 'ReasoningPolicy')).toEqual(literals(CLIENT, 'ReasoningPolicy'));
	});

	// GenerationTuning is the whole per-request tuning payload. A field the client sets and
	// the server's copy has never heard of is silently dropped at the type boundary, which is
	// exactly "visible but not sent".
	test('both GenerationTuning copies carry the same fields', () => {
		expect(fields(SERVER, 'GenerationTuning')).toEqual(fields(CLIENT, 'GenerationTuning'));
	});

	// The union is the stored vocabulary, the table is what the editor offers and what
	// resolveReasoningPolicy reads. A dialect missing from the table resolves to null: a
	// stored declaration that quietly stops sending anything.
	test('every reasoning dialect has exactly one row, and only none has no policy', () => {
		const union = scan(
			block(read(...CLIENT), /export type ReasoningDialect =[^;]*;/, 'ReasoningDialect'),
			/'([a-z_-]+)'/g,
			'reasoning dialects'
		);
		expect(REASONING_DIALECTS.map((d) => d.value).sort()).toEqual([...union].sort());
		expect(REASONING_DIALECTS.filter((d) => (d.value === 'none') !== (d.policy === null))).toEqual([]);
	});
});

describe('settings deep links (architecture/chungus-assistant.md #1, architecture/ui-shell-settings.md #2)', () => {
	const catalog = () => read('server', 'assistant', 'registry', 'settings.ts');

	test('the assistant tab union matches the client one', () => {
		const server = scan(
			block(catalog(), /export type SettingsTab =[\s\S]*?;/, 'server SettingsTab'),
			/'([A-Za-z]+)'/g,
			'server settings tabs'
		);
		const client = scan(
			block(
				read('src', 'lib', 'config', 'settings-pages.ts'),
				/export type SettingsTab =[\s\S]*?;/,
				'client SettingsTab'
			),
			/'([A-Za-z]+)'/g,
			'client settings tabs'
		);
		expect(server.sort()).toEqual(client.sort());
	});

	test('every catalogued setting can be routed to and highlighted', () => {
		const anchors = [...new Set(scan(catalog(), /anchor:\s*'([a-z0-9-]+)'/g, 'catalog anchors'))];

		const pages = read('src', 'lib', 'config', 'settings-pages.ts');
		const routable = new Set(
			scan(
				block(pages, /ANCHOR_PAGES[^=]*=\s*\{[\s\S]*?\n\};/, 'ANCHOR_PAGES'),
				/^\t'?([a-z0-9-]+)'?:/gm,
				'ANCHOR_PAGES keys'
			)
		);
		expect(anchors.filter((a) => !routable.has(a))).toEqual([]);

		// `flashSelector` finds the control by this attribute; without one the deep link
		// lands on the right page but highlights nothing.
		const marked = new Set<string>();
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith('.svelte')) {
					for (const m of readFileSync(full, 'utf8').matchAll(/data-setting="([a-z0-9-]+)"/g)) {
						marked.add(m[1]);
					}
				}
			}
		};
		walk(join(ROOT, 'src', 'lib', 'components'));
		expect(marked.size, 'found no data-setting attributes, so the scan is stale').toBeGreaterThan(0);
		expect(anchors.filter((a) => !marked.has(a))).toEqual([]);
	});
});

describe('ambient effects (architecture/ui-shell-settings.md #5)', () => {
	// The union, the picker list, the labels/descriptions maps and the canvas renderer all
	// derive from AMBIENT_EFFECTS. The compositing order cannot: it carries its own
	// back-to-front information, and it lives inside a .svelte file.
	test('the canvas render order covers every effect', () => {
		const order = scan(
			block(
				read('src', 'lib', 'components', 'ambient', 'AmbientCanvas.svelte'),
				/const EFFECT_RENDER_ORDER: AmbientEffect\[\] = \[[\s\S]*?\];/,
				'EFFECT_RENDER_ORDER'
			),
			/'([a-z0-9-]+)'/g,
			'render order entries'
		);
		expect([...AMBIENT_EFFECTS].filter((e) => !order.includes(e))).toEqual([]);
		expect(order.filter((e) => !(AMBIENT_EFFECTS as readonly string[]).includes(e))).toEqual([]);
	});

	// Every effect's settings list is the four shared ones followed by its own, and the
	// canvas reads density/speed/visibility/overMessages straight out of that one bag. A
	// per-effect def reusing one of those keys would shadow the knob it names: the row
	// would draw two sliders called the same thing and the second would decide.
	test('no effect redefines one of the shared knobs', () => {
		const base = new Set(AMBIENT_BASE_SETTINGS.map((def) => def.key));
		const clashes = Object.entries(AMBIENT_EFFECT_SETTINGS).flatMap(([type, defs]) =>
			(defs ?? []).filter((def) => base.has(def.key)).map((def) => `${type}.${def.key}`)
		);
		expect(clashes).toEqual([]);
	});
});

describe('anchored tips (architecture/ui-shell-settings.md)', () => {
	// A hover bubble positioned inside its own panel is clipped by that panel's scroll
	// container, and naming a side by hand only moves which edge it falls off. One action
	// measures the side for every tip in the app; a component that rolls its own bubble
	// brings the clipping back, silently, and only on narrow surfaces.
	test('every tooltip bubble is placed by the anchorTo action', () => {
		const bespoke: string[] = [];
		let bubbles = 0;
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith('.svelte')) {
					const source = readFileSync(full, 'utf8');
					if (!source.includes('role="tooltip"')) continue;
					bubbles++;
					if (!source.includes('actions/anchorTo')) bespoke.push(entry.name);
				}
			}
		};
		walk(join(ROOT, 'src', 'lib', 'components'));
		expect(bubbles, 'found no tooltip bubbles, so the scan is stale').toBeGreaterThan(0);
		expect(bespoke).toEqual([]);
	});
});

describe('character fields (architecture/library.md #1, architecture/macros.md #1)', () => {
	// CHARACTER_FIELD_MACROS now derives from PERMANENT_TRAITS, so resolution can't drift.
	// The macro REFERENCE is still hand-written, and a field whose macro is missing there
	// resolves correctly but is invisible to every macro-picker UI.
	test('every character field macro is documented in the macro registry', () => {
		const declared = new Set(MACROS.map((m) => m.name));
		const fieldMacros = PERMANENT_TRAITS.character
			.map((t) => t.macro)
			.filter((m): m is string => !!m);
		expect(fieldMacros.length).toBeGreaterThan(0);
		expect(fieldMacros.filter((m) => !declared.has(m))).toEqual([]);
	});
});

describe('thumbnail convention (architecture/server-core.md #7)', () => {
	// A thumbnail's path is derived from its original's, on both sides, and the derivation
	// is only pure because the extension is fixed. The client cannot import server code, so
	// this pair is the whole residue: the server writes the file and the client asks for it
	// by name, and an extension that moved on one side alone points every existing picture
	// at a file nobody wrote.
	test('client and server agree on the thumbnail extension', () => {
		const server = scan(
			read('server', 'files.ts'),
			/const THUMBNAIL_EXTENSION = '(\.[a-z0-9]+)'/g,
			"the server's thumbnail extension"
		);
		const client = scan(
			read('src', 'lib', 'services', 'imageService.ts'),
			/const THUMBNAIL_EXTENSION = '(\.[a-z0-9]+)'/g,
			"the client's thumbnail extension"
		);
		expect(client).toEqual(server);
	});

	// A `/files/…` request carries a URL path, which is `/`-separated by definition, and
	// files.ts refuses any other spelling because it reads a thumbnail's location out of the
	// path itself (`/thumbnails/`), which a backslash does not match. `node:path`'s `normalize`
	// answers in the HOST's separator, so one call on the way in turns every picture in the app
	// into broken art on Windows and nowhere else: the platform half is what no reviewer on
	// another OS can see, which is why the rule is asserted rather than left to a comment.
	test('the file routes spell a request path without node:path', () => {
		const source = read('server', 'index.ts');
		const helper = block(
			source,
			/function requestedFilePath\(pathname[\s\S]*?\n\}/,
			"requestedFilePath's body"
		);
		expect(helper, 'requestedFilePath must not reshape a URL path with node:path').not.toContain(
			'normalize('
		);
		for (const route of ['serveDefaultBackground', 'serveImage']) {
			const re = new RegExp(`function ${route}\\(pathname[\\s\\S]*?\\n\\}`);
			expect(
				block(source, re, `${route}'s body`),
				`${route} must take its path from requestedFilePath`
			).toContain('requestedFilePath(');
		}
	});

	// The format the client encodes has to BE the extension it is stored under, or every
	// thumbnail is bytes of one kind under the name of another: browsers sniff and render
	// it anyway, so the lie surfaces nowhere until something trusts the content type.
	test('the client encodes the format it names', () => {
		const source = read('src', 'lib', 'services', 'imageService.ts');
		const [type] = scan(source, /const THUMBNAIL_TYPE = 'image\/([a-z0-9]+)'/g, 'the thumbnail type');
		const [ext] = scan(source, /const THUMBNAIL_EXTENSION = '\.([a-z0-9]+)'/g, 'the thumbnail extension');
		expect(ext).toBe(type);
	});
});

describe('steering vocabulary (architecture/engines.md, architecture/chungus-assistant.md)', () => {
	// `add_steering` states scope/mode/role as tool-schema enums and cannot import the
	// client model (server code never reaches into src/), so all three are mirrored.
	const mirrored = (name: string): string[] =>
		scan(
			block(
				read('server', 'assistant', 'registry', 'workspace.ts'),
				new RegExp(`const ${name} = \\[[\\s\\S]*?\\] as const;`),
				`mirrored ${name}`
			),
			/'([a-z]+)'/g,
			`mirrored ${name} values`
		);

	test("the assistant's scope enum matches the scope ladder", () => {
		expect(mirrored('STEERING_SCOPES')).toEqual([...STEERING_SCOPES]);
	});

	test("the assistant's role enum matches the injectable roles", () => {
		expect(mirrored('STEERING_ROLES')).toEqual([...STEERING_ROLES]);
	});

	test("the assistant's mode enum matches the note lifetimes", () => {
		// SteeringMode has no runtime list of its own: it is a two-value union, so the
		// literals are read out of the type declaration.
		const declared = scan(
			block(read('src', 'lib', 'types', 'steering.ts'), /export type SteeringMode =[\s\S]*?;/, 'SteeringMode'),
			/'([a-z]+)'/g,
			'SteeringMode values'
		);
		expect(mirrored('STEERING_MODES')).toEqual(declared);
	});
});


/* Every palette is authored to the same readability floor.
 *
 * Not a cross-module coupling but the same kind of trap: nothing in the type system
 * stops a palette from shipping text tiers a stop shallower than its siblings, and the
 * damage only shows where a translucent surface sits over the workspace photo, since glass
 * composites a light palette toward the picture and AWAY from its dark text, while a
 * dark palette only ever gains. A shallow palette therefore reads fine on a bare page
 * and falls apart in the app, which is exactly the failure mode a review misses.
 * `LIGHT_GLASS_KEEP` in theme.svelte.ts holds the second half of that contract. */
describe('theme custom properties (architecture/ui-shell-settings.md)', () => {
	// A custom property whose ENTIRE value is a CSS-wide keyword is that keyword for the
	// property itself, not a token handed on to whoever reads it. `--x: inherit` stamped on
	// <html> therefore inherits from nothing, leaves the property invalid, and every
	// `var(--x, fallback)` silently takes its fallback instead, which is how Story Text's
	// "Off" came to paint the very default tint it was there to remove. The failure is
	// silent and in the worst direction: the control looks wired and does the opposite of
	// standing down, so it belongs in a test rather than in a comment beside one call site.
	// `currentColor` is the colour-shaped way to say "whatever surrounds this"; a face or a
	// weight that wants the same says it by declaring nothing at all (a `data-*` attribute).
	const KEYWORD = String.raw`(?:inherit|initial|unset|revert|revert-layer)`;

	// theme.svelte.ts is the one module that stamps custom properties on <html>, and every
	// string literal in it is a CSS value, an enum id or a property name, none of which is
	// ever one of these words. Scanning for the KEYWORD itself rather than for an assignment
	// shape is deliberate: the bug took the form of a ternary arm sitting alone on a line,
	// two lines below the property it was answering for, which no `key: value` pattern sees.
	test('the theme store hands no CSS-wide keyword to a custom property', () => {
		const lines = codeLines(join(ROOT, 'src', 'lib', 'stores'), (n) => n === 'theme.svelte.ts');
		expect(lines.length, 'found no theme store code lines, so the scan is stale').toBeGreaterThan(0);
		const bare = new RegExp(String.raw`(['"\`])${KEYWORD}\1`);
		const offenders = lines
			.filter((l) => bare.test(l.text))
			.map((l) => l.text.slice(0, 100));
		expect(offenders).toEqual([]);
	});

	// Everywhere else the same mistake can only be written out in full: a declaration in a
	// stylesheet or an inline `style`, or a `setProperty` call from another module.
	test('nothing declares a custom property as a CSS-wide keyword', () => {
		const lines = codeLines(
			join(ROOT, 'src'),
			(name) => name.endsWith('.svelte') || name.endsWith('.ts') || name.endsWith('.css')
		);
		expect(lines.length, 'found no code lines, so the scan is stale').toBeGreaterThan(0);
		const forms = [
			new RegExp(String.raw`--[a-z][\w-]*:\s*${KEYWORD}\s*(?:[;'"\`]|$)`),
			new RegExp(String.raw`setProperty\(\s*(['"\`])--[\w-]+\1\s*,\s*(['"\`])${KEYWORD}\2`)
		];
		const offenders = lines
			.filter((l) => forms.some((re) => re.test(l.text)))
			.map((l) => `${l.file.slice(l.file.indexOf('src/'))}: ${l.text.slice(0, 100)}`);
		expect(offenders).toEqual([]);
	});
});

describe('dev prebundle (architecture/build-packaging.md #8)', () => {
	// An unlisted dependency is discovered while Vite transforms the module that imports it,
	// which on a cold cache happens mid page load: the requests are held until esbuild is
	// done and the page is then force-reloaded under an app that has already started booting.
	// Nothing in a build or a type check says a name is missing here, and a warm cache hides
	// it locally, so the drift surfaces on somebody else's fresh clone or nowhere at all.
	test('every runtime dependency is named in optimizeDeps.include', () => {
		const listed = scan(
			block(read('vite.config.ts'), /optimizeDeps: \{[\s\S]*?\n\t\},/, 'optimizeDeps.include'),
			/'([^']+)'/g,
			'prebundled dependencies'
		);
		const deps = Object.keys(
			(JSON.parse(read('package.json')) as { dependencies: Record<string, string> }).dependencies
		);
		expect(deps.length, 'package.json lists no dependencies, so the scan is stale').toBeGreaterThan(0);
		// A package is covered by its own name or by the subpaths actually imported, which is
		// what a package with per-entry exports (gpt-tokenizer's encodings) needs.
		const covers = (entry: string, dep: string) => entry === dep || entry.startsWith(`${dep}/`);
		expect(deps.filter((dep) => !listed.some((entry) => covers(entry, dep)))).toEqual([]);
		expect(listed.filter((entry) => !deps.some((dep) => covers(entry, dep)))).toEqual([]);
	});
});

describe('palette readability', () => {
	// The weakest the shipped dark palettes go, rounded down: any palette that reads
	// worse than this is out of family, whatever its mode.
	const FLOORS = { textPrimary: 13, textSecondary: 7, textMuted: 4 };

	for (const p of palettes) {
		test(`${p.id} separates its text tiers from its own base`, () => {
			for (const [tier, floor] of Object.entries(FLOORS)) {
				const ratio = contrastRatio(p.colors[tier as keyof typeof p.colors], p.colors.bgPrimary);
				expect(ratio, `${p.id} ${tier} reads ${ratio.toFixed(1)}:1, floor is ${floor}:1`).toBeGreaterThanOrEqual(floor);
			}
		});
	}
});
