/**
 * ChungusHub self-hosted server (Bun).
 *
 * One process: serves the built PWA, exposes the DB/files/LLM API over HTTP,
 * and runs a WebSocket for live cross-device sync and LLM token streaming.
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { CLIENT_DIR, CONFIG_ISSUES, CONFIG_PATH, DATA_DIR, DEFAULT_BACKGROUNDS_DIR, HOST, IS_COMPILED, PORT, SECURITY_PATH, ensureConfigFile, ensureDirs, type ImageCategory } from './config';
import { claimDataDir, type RunningInstance } from './instance-lock';
import {
	allowIp,
	isAllowed,
	isLoopback,
	listAllowed,
	listDenied,
	normalizeIp,
	recordDenied,
	revokeIp,
	watchAllowlistFile
} from './access';
import * as security from './security';
import { installInfo, latestRelease } from './about';
import { LATEST_SCHEMA_VERSION, MUTATION_SCOPES, callDbMethod, schemaVersionOnDisk, serverDb } from './db';
import type { SyncScope } from '../shared/sync';
import { isGenerationCommit, type GenerationCommit } from '../shared/generation';
import { runBootSweeps } from './boot-sweeps';
import { backupService } from './backup/service';
import { JOB_ENV, runJobChild } from './backup/job';
import { assertBackupDirUsable } from './backup/paths';
import { patchManifest, readManifest } from './backup/manifest';
import { cancelPendingRestore, readJournal, resumeInterruptedRestore } from './backup/restore';
import { ensureBackupStoreMarkers, sweepAbandonedSnapshots } from './backup/snapshot';
import { restoreBlockedReason } from '../shared/backups';
import {
	copyImage,
	deleteDraft,
	deleteImage,
	deletePreset,
	ensureDefaultPresets,
	listBackgrounds,
	listDrafts,
	listPresets,
	listStoredImages,
	readAssistantFileText,
	resolveImageFile,
	restoreDefaults,
	saveDraft,
	saveImage,
	savePreset,
	saveThumbnail
} from './files';
import type { PresetFileData } from './files';
import { storeAssistantFile } from './assistant/files-ingest';
import { clampRange, splitLines } from './assistant/files-core';
import type { AssistantFile } from '../shared/assistant-files';
import type { AssistantFileRow } from './db';
import { complete, fetchAccount, fetchAvailableModels, fetchModelEndpoints, isProvider, providerMetadata, resolvedBaseUrl, validateCredentials, type RoutingConfig } from './llm/registry';
import { handleAssistant, type AssistantRequest } from './assistant/loop';
import * as promptLog from './promptLog';
import type {
	ApprovalCall,
	ApprovalCard,
	ApprovalOutcome,
	AskQuestion,
	AssistantStep,
	AssistantToolResult,
	QuestionAnswer,
	QuestionCard,
	QuestionOutcome
} from './assistant/types';
import { listSkills, listDefaultSkills, saveSkills, type SkillInput } from './assistant/registry/skills';
import { capabilityGroupCosts } from './assistant/registry';
import { CAPABILITY_GROUPS, CAPABILITY_PRESETS, DEFAULT_ENABLED_GROUPS } from './assistant/registry/groups';
import { applyLiveSettings, settingsStale } from './assistant/sessionSettings';

/** Stop with a reason, where the reader can read it. A portable build's console closes
 *  with the process, so it is held there, and only where there is a console to hold. */
function fatal(lines: string[]): never {
	console.error('');
	for (const line of lines) console.error(line ? `  ${line}` : '');
	console.error('');
	if (IS_COMPILED && process.stdin.isTTY) prompt('  Press Enter to close.');
	process.exit(1);
}

interface SocketData {
	clientId: string;
	/** Normalized client IP at upgrade time: presence for the settings UI's device dots. */
	ip: string | null;
}

const sockets = new Set<ServerWebSocket<SocketData>>();

/**
 * Every LLM generation in flight or waiting to be claimed, keyed by request id.
 *
 * Deliberately NOT per-socket state, and that is the whole point of the map. A phone that
 * backgrounds its browser has its socket torn down by the OS, and a generation bound to
 * that socket died with it: the answer was gone, and so was every token the reader had
 * already watched arrive, because the only copy of a streamed reply lives in the page that
 * asked for it until the call resolves. So a generation outlives its socket, keeps running
 * and keeps accumulating; `ws` is whoever is listening right now, null while nobody is, and
 * a page that comes back claims what it missed with `llm-attach`.
 *
 * A settled generation stays here for `CLAIM_WINDOW_MS`, because the socket looking open at
 * the moment the last frame was written proves nothing about a frozen tab having read it.
 * The window is what a returning page claims inside; past it the answer is dropped with a
 * line in the log rather than in silence.
 */
interface LiveGeneration {
	controller: AbortController;
	ws: ServerWebSocket<SocketData> | null;
	/** What has streamed so far, so a re-attach can be answered with the remainder alone. */
	content: string;
	thinking: string;
	/** Set once the call ended. For a call nobody commits, this is the only copy of the answer;
	 *  for one that does, `committedMessageId` names the row it already landed as. */
	settled:
		| { result: LlmCompletionResult; committedMessageId: string | null; spentSteeringIds: string[] }
		| { error: string }
		| null;
	/** Armed when the generation settles, cleared when the map entry goes. */
	dropTimer: ReturnType<typeof setTimeout> | null;
	/** Debug label ('chat', 'memory', …), for the line logged if the answer is dropped. */
	source: string;
	/** The chat this generation will write a turn into, for the single-flight rule below.
	 *  Null for every call that writes nothing. */
	commitChatId: string | null;
}
type LlmCompletionResult = Awaited<ReturnType<typeof complete>>;
const generations = new Map<string, LiveGeneration>();
/** How long an unclaimed answer is held. Long enough to cover a phone locked mid-reply,
 *  short enough that nothing accumulates on a server nobody is using. */
const CLAIM_WINDOW_MS = 10 * 60 * 1000;

/** Hand one frame to whoever is currently watching this generation, if anyone is. */
function emitGeneration(gen: LiveGeneration, frame: Record<string, unknown>): void {
	gen.ws?.send(JSON.stringify(frame));
}

/** The generation has ended. Hold the answer for the claim window rather than assuming the
 *  frame just written was read: the socket of a frozen tab looks open right up to the
 *  moment the OS tears it down. */
function settleGeneration(id: string, gen: LiveGeneration, settled: LiveGeneration['settled']): void {
	gen.settled = settled;
	// Dropped while it was still running (a restore claims the install and kills them all).
	// Holding its answer, or arming a timer to forget it, would both be for nobody.
	if (generations.get(id) !== gen) return;
	gen.dropTimer = setTimeout(() => {
		generations.delete(id);
		console.error(
			`[llm] dropped an unclaimed ${gen.source} answer after ${CLAIM_WINDOW_MS / 60000} minutes (request ${id}).`
		);
	}, CLAIM_WINDOW_MS);
}

/** Forget a generation and disarm whatever is still holding it. */
function dropGeneration(id: string): void {
	const gen = generations.get(id);
	if (!gen) return;
	if (gen.dropTimer) clearTimeout(gen.dropTimer);
	generations.delete(id);
}
// Sockets whose device currently has the debug panel enabled. Capture + broadcast of
// prompt logs only happens while at least one is listening, so an idle server pays nothing.
const debugSockets = new Set<ServerWebSocket<SocketData>>();

function anyDebug(): boolean {
	return debugSockets.size > 0;
}

/** Push one prompt-log change to every open debug panel. */
function broadcastPromptLog(event: promptLog.PromptLogEvent): void {
	const payload = JSON.stringify({ t: 'prompt-log', event });
	for (const ws of debugSockets) ws.send(payload);
}

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', ...extraHeaders }
	});
}

/** An attached file as the client may see it: the shared shape, with the stored path left
 *  behind. Every surface addresses a file by id, so handing one a location would be the only
 *  thing in the app that could tempt it into naming a path. */
function publicFile(row: AssistantFileRow): AssistantFile {
	const { textPath: _textPath, ...rest } = row;
	return rest;
}

/** Drop every live WebSocket. Run after a security setting tightens, so an app
 *  that is already open can't keep working on a connection it opened earlier.
 *  Its reconnect (and the next REST call) re-runs the gates. */
function kickAllSockets(reason = 'Security settings changed'): void {
	for (const ws of [...sockets]) ws.close(4001, reason);
}

/** Broadcast a sync hint to every connected client except the one that caused it.
 *  `SyncScope` (shared/sync.ts) is the vocabulary both ends share: a scope the client
 *  has no handler for cannot be spelled here. */
function broadcastSync(scope: SyncScope, originClientId: string | null): void {
	// Nearly every mutation in the app passes through here, which makes it where the backup
	// schedule learns that anything is owed a copy. Without it an idle machine writes an
	// identical copy of the same database every interval, forever. The backup scope itself is
	// excluded, or finishing a snapshot would immediately mark the next one as needed. The
	// paths that write without broadcasting mark themselves (see the assistant files below).
	if (scope !== 'backups') backupService.markChanged();
	const payload = JSON.stringify({ t: 'sync', scope });
	for (const ws of sockets) {
		if (originClientId && ws.data.clientId === originClientId) continue;
		ws.send(payload);
	}
}

// ===== Maintenance (restore) =====

/**
 * Set once a restore has been claimed. From then on this install is a waiting room: every
 * byte written would be discarded by the restore on the next launch, so nothing is accepted
 * and a navigation gets a page saying what to do. `retry` is true only while the state ends
 * on its own; a restore waits for a person, so its page does not pretend otherwise.
 * `cancellable` is true once the journal is the only thing armed, and puts a way out on the
 * page: until the relaunch runs the swap, withdrawing the claim destroys nothing.
 */
let maintenance: { headline: string; detail: string; retry: boolean; cancellable?: boolean } | null =
	null;

/**
 * Changes only when a restore replaced the data. Every client compares the value it booted
 * with each time it reconnects and reloads on a change, because the announcement cannot be
 * pushed: the process that took the decision is gone by the time it is true. It lives in the
 * settings table (written once, right after the boot that ran a swap) rather than in memory,
 * so a plain restart does not read as a restore and reload every open page for nothing.
 */
let dataEpoch = 0;

/**
 * Whether this data folder was last written by a newer build (set at boot, see below). Every
 * device is told, because the reader deciding whether to keep writing is not necessarily
 * sitting at the machine the server printed its warning on.
 */
let dataAhead = false;

/**
 * Stop taking work. Called the moment a restore is claimed rather than at the swap, because
 * the swap is a launch away: without this the reader could spend an hour writing into an
 * install that is already scheduled to be replaced.
 */
function quiesceForRestore(): void {
	kickAllSockets('Restoring a backup');
	// Generations outlive their socket, so the kick above leaves them running and holding
	// answers for a database that is about to be replaced. This is the one place they are
	// deliberately killed rather than detached.
	for (const [id, gen] of generations) {
		gen.controller.abort();
		dropGeneration(id);
	}
	// Aborting only breaks the loop; the turn still finalizes its own rows. That is fine
	// here (those rows are about to be replaced), but it is why nothing waits on them.
	for (const turn of assistantTurns.values()) turn.controller.abort();
}

async function runRestore(id: string, manifestAt: number): Promise<void> {
	try {
		await backupService.restore(id, { quiesce: quiesceForRestore });
		maintenance = {
			headline: 'Ready to restore',
			detail: `Close ChungusHub and start it again. It puts your data back to ${new Date(manifestAt).toLocaleString()} on the next launch, before anything else runs.`,
			retry: false,
			cancellable: true
		};
		console.log('');
		console.log('  A restore is queued. Stop ChungusHub and start it again to apply it.');
		console.log('');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('[backup] restore could not be prepared:', error);
		if (readJournal()) {
			// The marker landed and something after it did not. The next launch still does
			// the right thing, so say that rather than implying the app is usable.
			maintenance = {
				headline: 'Ready to restore',
				detail: `${message} Close ChungusHub and start it again to apply the restore.`,
				retry: false,
				cancellable: true
			};
			return;
		}
		// Nothing was claimed and nothing was touched: hand the app straight back.
		maintenance = null;
		lastRestoreError = message;
	}
}

/** Surfaced on the next `/api/backups` read, so a refusal that never reached a socket is
 *  still on the page when the reader comes back to it. */
let lastRestoreError: string | null = null;

// ===== Security headers =====

/**
 * Defense-in-depth for every HTML page we serve. The CSP's real job is privacy:
 * connect/img/font/media are pinned to this origin, so even if something ever
 * slipped past DOMPurify it could not phone content out to a third party.
 * 'unsafe-inline' script-src is required by the app.html polyfill and
 * SvelteKit's init snippet; ws://<host> keeps the sync socket working on
 * browsers that don't match same-origin WebSockets against 'self'.
 */
function htmlHeaders(host: string | null, extra?: Record<string, string>): Record<string, string> {
	const ws = host ? ` ws://${host} wss://${host}` : '';
	return {
		'content-type': 'text/html',
		'content-security-policy':
			`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ` +
			`img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${ws}; ` +
			`media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; ` +
			`base-uri 'self'; form-action 'self'; frame-ancestors 'self'`,
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		...extra
	};
}

// ===== Static serving =====

const MIME: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.webmanifest': 'application/manifest+json',
	'.woff2': 'font/woff2',
	// The bundled typefaces' licence notice, which Settings → About links. Named here or the
	// fallback below hands it over as a download instead of a page, and it carries a charset
	// because a copyright line is exactly where a non-ASCII character shows up.
	'.txt': 'text/plain; charset=utf-8'
};

function contentType(path: string): string {
	const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
	return MIME[ext] ?? 'application/octet-stream';
}

function serveStatic(pathname: string, host: string | null): Response {
	const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
	let filePath = join(CLIENT_DIR, rel);

	if (existsSync(filePath) && statSync(filePath).isFile()) {
		const type = contentType(filePath);
		return new Response(Bun.file(filePath), {
			headers: type === 'text/html' ? htmlHeaders(host) : { 'content-type': type }
		});
	}
	// SPA fallback: adapter-static emits index.html for client-side routing.
	filePath = join(CLIENT_DIR, 'index.html');
	if (existsSync(filePath)) {
		return new Response(Bun.file(filePath), { headers: htmlHeaders(host) });
	}
	return new Response('Client not built. Run: bun run build', { status: 500 });
}

/**
 * The file a `/files/…` request names, spelled the way this app stores a path: `/`-separated
 * on every platform, and with no way out of the folder it will be read from. `prefix` is the
 * route the caller already matched, and what is left of the path is what it asks for.
 *
 * **`node:path` is deliberately absent here.** A URL path is `/`-separated by definition, so
 * `normalize` does not tidy one up, it rewrites it into the HOST's separator, and files.ts
 * refuses a path in that spelling: the layout there reads a thumbnail's location out of the
 * path itself by looking for `/thumbnails/` inside it, and a backslash is an ordinary
 * character to that check. Every picture in the app is broken art on Windows alone. Traversal
 * is removed by dropping `..` outright rather than by resolving it, so nothing has to be
 * resolved for this to be safe.
 */
function requestedFilePath(pathname: string, prefix: string): string {
	return decodeURIComponent(pathname.slice(prefix.length))
		.replace(/\\/g, '/')
		.replace(/\.\./g, '');
}

function serveDefaultBackground(pathname: string): Response {
	// pathname like /files/backgrounds/<file>. Bundled defaults, served from the repo.
	const rel = requestedFilePath(pathname, '/files/backgrounds/');
	const filePath = join(DEFAULT_BACKGROUNDS_DIR, rel);
	if (existsSync(filePath) && statSync(filePath).isFile()) {
		return new Response(Bun.file(filePath), {
			headers: { 'content-type': contentType(filePath), 'cache-control': 'no-cache' }
		});
	}
	return new Response('Not found', { status: 404 });
}

function serveImage(pathname: string): Response {
	// pathname like /files/images/<category>/<file>, and what is under /files/ IS the stored
	// path: nothing is stripped and re-added. files.ts owns that layout, thumbnails included,
	// so a request for one that was never written is answered with the original beside it
	// (see `resolveImageFile`).
	const filePath = resolveImageFile(requestedFilePath(pathname, '/files/'));
	if (filePath) {
		return new Response(Bun.file(filePath), {
			headers: { 'content-type': contentType(filePath), 'cache-control': 'no-cache' }
		});
	}
	return new Response('Not found', { status: 404 });
}

/** A clean page for blocked devices that shows the IP the host needs to allow.
 *  Auto-retries every few seconds, so the moment the host clicks Allow the
 *  device falls through into the app, and each retry keeps the attempt fresh
 *  in the settings panel's waiting list. */
function forbidden(ip: string | null): Response {
	const shown = ip ? normalizeIp(ip) : 'unknown';
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="5" />
<title>Access denied · ChungusHub</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#1a1714;color:#e7e2da;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:1.5rem}
  .card{max-width:26rem;text-align:center;background:#221e1a;border:1px solid #3a342d;
    border-radius:16px;padding:2rem 1.6rem;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  h1{font-size:1.2rem;margin:0 0 .6rem}
  p{margin:.4rem 0;line-height:1.5;color:#b8b0a4;font-size:.92rem}
  code{background:#15120f;border:1px solid #3a342d;border-radius:8px;padding:.35rem .6rem;
    display:inline-block;margin-top:.4rem;color:#f0a868;font-size:1.05rem;letter-spacing:.02em}
</style></head><body><div class="card">
  <h1>This device isn't allowed</h1>
  <p>ChungusHub only accepts devices on its allowlist.</p>
  <p>Ask the host to add this address:</p>
  <code>${shown}</code>
  <p>This page retries on its own, so once allowed, you're in.</p>
</div></body></html>`;
	return new Response(html, { status: 403, headers: htmlHeaders(null) });
}

/**
 * What every device gets once a restore has been claimed. Same look as forbidden().
 *
 * It exists because the device that asked for the restore had its socket closed in the same
 * second, so from that moment this page is the only surface left that can say what is
 * happening and what the person has to do about it. It auto-retries only when the state
 * ends by itself; a restore waits for someone to relaunch the app, and a page refreshing
 * hopefully behind that instruction would suggest otherwise.
 */
function maintenancePage(state: NonNullable<typeof maintenance>): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${state.retry ? '<meta http-equiv="refresh" content="3" />' : ''}
<title>${state.headline} · ChungusHub</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#1a1714;color:#e7e2da;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:1.5rem}
  .card{max-width:26rem;text-align:center;background:#221e1a;border:1px solid #3a342d;
    border-radius:16px;padding:2rem 1.6rem;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  h1{font-size:1.2rem;margin:0 0 .6rem}
  p{margin:.4rem 0;line-height:1.5;color:#b8b0a4;font-size:.92rem}
  button{margin-top:1rem;padding:.5rem 1.1rem;border-radius:10px;border:1px solid #3a342d;
    background:#2a251f;color:#e7e2da;font:inherit;font-size:.88rem;cursor:pointer}
  button:hover{background:#332d26}
</style></head><body><div class="card">
  <h1>${state.headline}</h1>
  <p>${state.detail}</p>
  ${state.retry ? '<p>This page comes back on its own when it is done.</p>' : ''}
  ${state.cancellable ? '<button id="cancel" type="button">Cancel the restore</button>' : ''}
</div>
${
	state.cancellable
		? `<script>
document.getElementById('cancel').addEventListener('click', () => {
  fetch('/api/backups/cancel-restore', { method: 'POST' }).finally(() => location.reload());
});
</script>`
		: ''
}
</body></html>`;
	return new Response(html, { status: 503, headers: htmlHeaders(null) });
}

/** The password gate for devices without a valid session. Same look as forbidden(). */
function loginPage(host: string | null, status = 200): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Unlock · ChungusHub</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#1a1714;color:#e7e2da;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:1.5rem}
  .card{max-width:26rem;width:100%;text-align:center;background:#221e1a;border:1px solid #3a342d;
    border-radius:16px;padding:2rem 1.6rem;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  h1{font-size:1.2rem;margin:0 0 .6rem}
  p{margin:.4rem 0 1rem;line-height:1.5;color:#b8b0a4;font-size:.92rem}
  form{display:flex;gap:.5rem}
  input{flex:1;min-width:0;padding:.6rem .8rem;border-radius:10px;border:1px solid #3a342d;
    background:#15120f;color:#e7e2da;font-size:1rem}
  input:focus{outline:none;border-color:#f0a868}
  button{padding:.6rem 1rem;border-radius:10px;border:0;background:#f0a868;color:#1a1714;
    font-weight:600;font-size:.95rem;cursor:pointer}
  .err{color:#d97b6c;font-size:.85rem;min-height:1.2em;margin:.6rem 0 0}
</style></head><body><div class="card">
  <h1>ChungusHub is locked</h1>
  <p>Enter the password to use this device.</p>
  <form id="f"><input id="pw" type="password" autocomplete="current-password" autofocus />
  <button type="submit">Unlock</button></form>
  <p class="err" id="err"></p>
</div>
<script>
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.textContent = '';
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value })
    });
    if (res.ok) { location.replace('/'); return; }
    err.textContent = res.status === 429
      ? 'Too many attempts. Wait 30 seconds.'
      : 'Wrong password.';
  });
</script></body></html>`;
	return new Response(html, { status, headers: htmlHeaders(host) });
}

// ===== API =====

async function handleApi(req: Request, url: URL, clientIp: string | null): Promise<Response> {
	const path = url.pathname;

	// Client-readable runtime config. `dataEpoch` is how a device finds out its whole world
	// was replaced. It compares the value it booted with on every reconnect, because the
	// announcement cannot be pushed: a restore closes every socket before it starts.
	// `dataAhead` rides along because it is the same kind of fact: something happened to this
	// data folder that the running app cannot undo and the reader has to be told about.
	if (path === '/api/config') return json({ dataEpoch, dataAhead });

	// ----- Shared prompt debug log -----
	// Backfill the panel when a device opens it (the live feed rides the WebSocket).
	if (path === '/api/debug/prompt-log' && req.method === 'GET') {
		return json({ entries: promptLog.snapshot() });
	}
	// Clear from any device wipes it for all of them.
	if (path === '/api/debug/prompt-log/clear' && req.method === 'POST') {
		promptLog.clear();
		for (const ws of debugSockets) ws.send(JSON.stringify({ t: 'prompt-log-clear' }));
		return json({ ok: true });
	}

	// ----- Access control (IP allowlist) -----
	// All three return the same full snapshot so the settings UI can refresh its
	// allowed + waiting lists from any of them in one go. `online` = IPs holding
	// a live WebSocket right now, rendered as presence dots on the device list.
	const accessInfo = () =>
		json({
			allowed: listAllowed(),
			recent: listDenied(),
			online: [...new Set([...sockets].map((ws) => ws.data.ip).filter((ip) => ip !== null))],
			yourIp: clientIp ? normalizeIp(clientIp) : null,
			// Whether this device would get past the allowlist if it were on, answered here
			// rather than worked out from `allowed`: that list holds the file's entries alone,
			// so loopback and the env seeds pass a gate they never appear in. The settings UI
			// asks before switching the gate on, and a wrong answer there locks somebody out.
			yourIpAllowed: isAllowed(clientIp)
		});
	if (path === '/api/access' && req.method === 'GET') {
		return accessInfo();
	}
	if (path === '/api/access/allow' && req.method === 'POST') {
		const { ip } = (await req.json()) as { ip?: string };
		// A malformed address is the caller's mistake, not the server's: 400 with the
		// reason, rather than the catch-all's 500 for something that went wrong here.
		try {
			allowIp(String(ip ?? ''));
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
		return accessInfo();
	}
	if (path === '/api/access/revoke' && req.method === 'POST') {
		const { ip } = (await req.json()) as { ip?: string };
		revokeIp(String(ip ?? ''));
		return accessInfo();
	}
	// The Vite dev gate blocks LAN devices itself (they never reach this process)
	// and reports them here so the waiting list works in dev too. Loopback only:
	// that's the dev proxy and the host itself.
	if (path === '/api/access/record-denied' && req.method === 'POST') {
		if (!isLoopback(clientIp)) return json({ error: 'Loopback only.' }, 403);
		const { ip } = (await req.json()) as { ip?: string };
		recordDenied(String(ip ?? ''));
		return json({ ok: true });
	}

	// ----- Security (network access + allowlist toggle + password lock) -----
	if (path === '/api/security' && req.method === 'GET') {
		return json({
			networkAccessEnabled: security.isNetworkAccessEnabled(),
			ipAllowlistEnabled: security.isIpAllowlistEnabled(),
			passwordEnabled: security.isPasswordEnabled(),
			passwordSet: security.hasPassword()
		});
	}
	// The master switch, and it moves the listening socket rather than turning arrivals
	// away: off means the port exists on loopback alone, so a device on the network
	// finds nothing there to refuse it. The rebind is deferred one tick so this reply
	// is on the wire first: closing the socket takes its own connection with it.
	if (path === '/api/security/network-access' && req.method === 'POST') {
		const { enabled } = (await req.json()) as { enabled?: boolean };
		security.setNetworkAccessEnabled(enabled === true);
		setTimeout(rebindNetwork, 100);
		return json({ ok: true });
	}
	if (path === '/api/security/ip-allowlist' && req.method === 'POST') {
		const { enabled } = (await req.json()) as { enabled?: boolean };
		const on = enabled !== false;
		security.setIpAllowlistEnabled(on);
		if (on) kickAllSockets();
		return json({ ok: true });
	}
	if (path === '/api/security/password' && req.method === 'POST') {
		const { password } = (await req.json()) as { password?: string };
		const pw = String(password ?? '');
		if (pw.length < 4) return json({ error: 'Password must be at least 4 characters.' }, 400);
		// Every other device is logged out; the fresh cookie keeps this one in.
		const token = security.setPassword(pw);
		kickAllSockets();
		return json({ ok: true }, 200, { 'set-cookie': security.sessionCookie(token) });
	}
	// Flip the lock on/off; the stored password survives an off. Turning it on
	// kicks every socket so open apps re-pass the gate, same as the allowlist.
	if (path === '/api/security/password/enabled' && req.method === 'POST') {
		const { enabled } = (await req.json()) as { enabled?: boolean };
		const on = enabled === true;
		security.setPasswordLockEnabled(on);
		if (on) kickAllSockets();
		return json({ ok: true });
	}

	// ----- Backups -----
	if (path === '/api/backups' && req.method === 'GET') {
		const payload = backupService.payload();
		return json({
			...payload,
			lastError: lastRestoreError ?? payload.lastError,
			schemaVersion: LATEST_SCHEMA_VERSION,
			// A restore applies on the next launch, so the page has to be able to say that
			// this one is already claimed rather than offering the button again.
			restorePending: readJournal()?.snapshotId ?? null
		});
	}
	// 202 rather than a result: a snapshot of a large library outlives any sensible request
	// timeout, and the page that asked may well be closed before it finishes. The job runs
	// server-side and the row reports itself.
	if (path === '/api/backups/snapshot' && req.method === 'POST') {
		const { label } = (await req.json()) as { label?: string };
		if (backupService.isBusy()) {
			return json({ error: 'A backup is already running. Wait for it to finish, then try again.' }, 409);
		}
		// A new job opens a new chapter, so a restore refusal from last week stops being the
		// page's headline now: the job's own outcome is the current one.
		lastRestoreError = null;
		void backupService.snapshot('manual', typeof label === 'string' ? label : null).catch((error) => {
			console.error('[backup] snapshot failed:', error);
		});
		return json({ started: true }, 202);
	}
	if (path === '/api/backups/restore' && req.method === 'POST') {
		const { id } = (await req.json()) as { id?: string };
		const manifest = typeof id === 'string' ? readManifest(id) : null;
		if (!manifest) return json({ error: `No readable snapshot named "${id}".` }, 404);
		const blocked = restoreBlockedReason(manifest, LATEST_SCHEMA_VERSION);
		if (blocked) return json({ error: blocked }, 409);
		if (backupService.isBusy()) {
			return json({ error: 'A backup is already running. Wait for it to finish, then try again.' }, 409);
		}
		// Maintenance goes up inside the handler so every request arriving after this one is
		// already being turned away, while this reply still travels on a socket that has not
		// been closed yet.
		maintenance = {
			headline: 'Preparing to restore',
			detail: 'Saving the current data first, so this can be undone.',
			retry: true
		};
		lastRestoreError = null;
		void runRestore(manifest.id, manifest.createdAt);
		return json({ started: true }, 202);
	}
	// Withdraw a claimed restore before the relaunch applies it. Nothing has been destroyed
	// at that point (the claim is one small file), so the way back costs nothing, and an
	// armed restore that could only be disarmed by executing it would be a trap.
	if (path === '/api/backups/cancel-restore' && req.method === 'POST') {
		if (backupService.isBusy()) {
			return json({ error: 'The restore is still being prepared. Try again in a moment.' }, 409);
		}
		if (!readJournal()) return json({ error: 'No restore is waiting.' }, 409);
		cancelPendingRestore();
		maintenance = null;
		lastRestoreError = null;
		return json({ ok: true });
	}
	if (path === '/api/backups/delete' && req.method === 'POST') {
		const { ids } = (await req.json()) as { ids?: unknown };
		if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
			return json({ error: 'POST /api/backups/delete expects { ids: [...] }.' }, 400);
		}
		try {
			const removed = backupService.remove(ids as string[]);
			return json({ removed });
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 409);
		}
	}
	if (path === '/api/backups/pin' && req.method === 'POST') {
		const { id, pinned } = (await req.json()) as { id?: string; pinned?: boolean };
		if (typeof id !== 'string') return json({ error: 'POST /api/backups/pin expects { id }.' }, 400);
		try {
			const manifest = patchManifest(id, { pinned: pinned === true });
			broadcastSync('backups', null);
			return json({ manifest });
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 404);
		}
	}
	// What restoring this one would discard, counted on the live database at the moment the
	// reader is about to decide. Messages are in there beside chats because they are the
	// actual work: "1 chat" can be four hours of writing.
	if (path === '/api/backups/loss' && req.method === 'GET') {
		const id = url.searchParams.get('id') ?? '';
		const manifest = readManifest(id);
		if (!manifest) return json({ error: `No readable snapshot named "${id}".` }, 404);
		return json({ since: manifest.createdAt, ...serverDb.createdSince(manifest.createdAt) });
	}

	if (path === '/api/health') return json({ ok: true });

	// ----- About -----
	// Asked once, when the About page opens: the data-dir walk reads every file's size and
	// must never ride a render or a sync hint.
	if (path === '/api/about' && req.method === 'GET') return json(installInfo());
	// The update check, which is the one request the app makes that no story asked for. Its
	// failures are answered here rather than through the catch-all, because this is the one
	// call whose cause is worth a sentence on screen.
	if (path === '/api/about/latest-release' && req.method === 'GET') {
		try {
			return json(await latestRelease());
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 502);
		}
	}

	if (path === '/api/rpc/db' && req.method === 'POST') {
		const { method, args, clientId } = (await req.json()) as {
			method: string;
			args: unknown[];
			clientId?: string;
		};
		const result = callDbMethod(method, args ?? []);
		const scope = MUTATION_SCOPES[method];
		if (scope) broadcastSync(scope, clientId ?? null);
		// A card edit reaches the openings of chats nobody has written in yet (server/db.ts
		// refreshSeededGreetings), which is a message write on top of a library one. This hint
		// deliberately goes to EVERY client, the writer included: the device editing the card
		// is the one most likely to have one of those chats open beside the library.
		if (method === 'updateLibraryEntry' && Array.isArray(result) && result.length > 0) {
			broadcastSync('messages', null);
		}
		// Deleting the active persona hands the role to a survivor (server/db.ts holds the
		// one-persona floor), which is a settings write on top of a library one. Every client
		// hears it, the writer included: its own copy of who "you" are is now wrong.
		if (method === 'deleteLibraryEntry' && typeof result === 'string') {
			broadcastSync('settings', null);
		}
		return json({ result });
	}

	// ----- Images -----
	if (path === '/api/images' && req.method === 'POST') {
		const form = await req.formData();
		const original = form.get('file');
		const thumb = form.get('thumb');
		const ext = String(form.get('ext') ?? '.png');
		const category = String(form.get('category') ?? 'characters') as ImageCategory;
		if (!(original instanceof Blob)) return json({ error: 'file required' }, 400);
		const preferredName = form.get('name');
		const rel = await saveImage(
			original,
			thumb instanceof Blob ? thumb : null,
			ext,
			category,
			typeof preferredName === 'string' ? preferredName : null
		);
		broadcastSync('library', String(form.get('clientId') ?? '') || null);
		return json({ path: rel });
	}
	// Every stored picture, and the thumbnail for one. Both serve the rebuild in Settings ›
	// Advanced, which is a client job because the browser holds the only image encoder in
	// the app. Neither carries a sync hint: no row changes, and a rebuilt thumbnail lands at
	// the path every device already asks for.
	if (path === '/api/images' && req.method === 'GET') {
		return json({ paths: listStoredImages() });
	}
	if (path === '/api/images/thumbnail' && req.method === 'POST') {
		const form = await req.formData();
		const rel = String(form.get('path') ?? '');
		const thumb = form.get('thumb');
		if (!(thumb instanceof Blob)) return json({ error: 'thumb required' }, 400);
		await saveThumbnail(rel, thumb);
		backupService.markChanged();
		return json({ ok: true });
	}
	// These two carry no sync hint: a copy is made for a row that is about to be written and
	// announces itself through that row, and a delete follows one. They still tell the backup
	// schedule, on the same rule as the assistant files below: every write into the data dir
	// says so, whether or not another device needs to hear about it.
	if (path === '/api/images/copy' && req.method === 'POST') {
		const { path: rel, category } = (await req.json()) as {
			path: string;
			category?: ImageCategory;
		};
		const copied = copyImage(rel, category);
		backupService.markChanged();
		return json({ path: copied });
	}
	if (path === '/api/images/delete' && req.method === 'POST') {
		const { path: rel } = (await req.json()) as { path: string };
		deleteImage(rel);
		backupService.markChanged();
		return json({ ok: true });
	}
	// ----- Backgrounds (bundled defaults + user uploads) -----
	if (path === '/api/backgrounds' && req.method === 'GET') {
		return json({ backgrounds: listBackgrounds() });
	}

	// ----- Presets -----
	if (path === '/api/presets' && req.method === 'GET') {
		return json({ presets: listPresets(), drafts: listDrafts() });
	}
	if (path === '/api/presets/restore-defaults' && req.method === 'POST') {
		const { clientId } = (await req.json().catch(() => ({}))) as { clientId?: string };
		restoreDefaults();
		broadcastSync('presets', clientId ?? null);
		return json({ ok: true });
	}
	if (path.startsWith('/api/presets/') && path.endsWith('/draft') && req.method === 'PUT') {
		const id = decodeURIComponent(path.slice('/api/presets/'.length, -'/draft'.length));
		const data = (await req.json()) as PresetFileData & { clientId?: string };
		saveDraft(id, data);
		broadcastSync('presets', data.clientId ?? null);
		return json({ ok: true });
	}
	if (path.startsWith('/api/presets/') && path.endsWith('/draft') && req.method === 'DELETE') {
		const id = decodeURIComponent(path.slice('/api/presets/'.length, -'/draft'.length));
		const { clientId } = (await req.json().catch(() => ({}))) as { clientId?: string };
		deleteDraft(id);
		broadcastSync('presets', clientId ?? null);
		return json({ ok: true });
	}
	if (path.startsWith('/api/presets/') && req.method === 'PUT') {
		const id = decodeURIComponent(path.slice('/api/presets/'.length));
		const data = (await req.json()) as PresetFileData & { clientId?: string };
		savePreset(id, data);
		broadcastSync('presets', data.clientId ?? null);
		return json({ ok: true });
	}
	if (path.startsWith('/api/presets/') && req.method === 'DELETE') {
		const id = decodeURIComponent(path.slice('/api/presets/'.length));
		const { clientId } = (await req.json().catch(() => ({}))) as { clientId?: string };
		deletePreset(id);
		broadcastSync('presets', clientId ?? null);
		return json({ ok: true });
	}

	// ----- Assistant skills (the user's own list; defaults/skills is the read-only catalog) -----
	if (path === '/api/assistant-skills' && req.method === 'GET') {
		return json({ skills: listSkills() });
	}
	if (path === '/api/assistant-skills/defaults' && req.method === 'GET') {
		return json({ skills: listDefaultSkills() });
	}
	if (path === '/api/assistant-skills' && req.method === 'PUT') {
		const { skills, clientId } = (await req.json()) as { skills: SkillInput[]; clientId?: string };
		if (!Array.isArray(skills)) return json({ error: 'PUT /api/assistant-skills expects { skills: [...] }.' }, 400);
		try {
			const saved = saveSkills(skills);
			// A save sends the FULL set, so a dialog left open on another device would
			// otherwise save its stale list back over this one. Skills ride the coarse
			// `assistant` scope rather than earning their own: same subsystem, and the
			// sessions reload it also triggers is one cheap read.
			broadcastSync('assistant', clientId ?? null);
			return json({ skills: saved });
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	}

	// ----- Assistant capabilities (the CATALOG only; the chosen set is an ordinary settings
	// row the client reads and writes over the db bridge) -----
	if (path === '/api/assistant-capabilities' && req.method === 'GET') {
		const costs = capabilityGroupCosts();
		return json({
			groups: CAPABILITY_GROUPS.map((g) => ({
				id: g.id,
				label: g.label,
				describe: g.describe,
				tools: g.tools,
				alwaysOn: !!g.alwaysOn,
				experimental: !!g.experimental,
				// Priced with the loop's own estimator, so the page and the context budget
				// never quote different numbers for the same schemas.
				tokens: costs[g.id] ?? 0
			})),
			presets: CAPABILITY_PRESETS.map((p) => ({ id: p.id, label: p.label, describe: p.describe, groups: [...p.groups] })),
			defaults: [...DEFAULT_ENABLED_GROUPS]
		});
	}

	// ----- Assistant files (read-only reference material attached to one tab) -----
	//
	// Where the file lives on disk is the server's alone: every other surface addresses it by
	// id, so neither the model nor the client is ever handed a location.
	//
	// The bytes are NEVER served as a static file. What a user attaches is arbitrary text, so
	// handing it back with a guessed content type would run an attached `.html` as a page on
	// the app's own origin, the origin holding the session cookie. Everything here answers
	// in JSON, which has no content type to get wrong.
	//
	// No sync broadcast on any of these: an upload is staged on the page that made it and
	// carries nothing another device could render, and once a file rides a turn the transcript
	// (and its own `assistant` broadcast) is what announces it. They are the two writes in the
	// app that reach `assistant-files/` without one, so they tell the backup schedule directly:
	// a snapshot carries that folder, and a broadcast is otherwise how it hears about a change.
	if (path === '/api/assistant-files' && req.method === 'GET') {
		const sessionId = url.searchParams.get('sessionId') ?? '';
		if (!sessionId) return json({ error: 'sessionId is required.' }, 400);
		return json({ files: serverDb.listAssistantFiles(sessionId).map(publicFile) });
	}
	if (path === '/api/assistant-files' && req.method === 'POST') {
		const form = await req.formData();
		const file = form.get('file');
		const sessionId = String(form.get('sessionId') ?? '');
		if (!sessionId) return json({ error: 'sessionId is required.' }, 400);
		if (!serverDb.getAssistantSession(sessionId)) return json({ error: 'No assistant session with that id.' }, 404);
		if (!(file instanceof Blob)) return json({ error: 'file required' }, 400);
		const name = String(form.get('name') ?? (file instanceof File ? file.name : '') ?? 'attachment');
		try {
			const stored = storeAssistantFile(sessionId, name, new Uint8Array(await file.arrayBuffer()));
			backupService.markChanged();
			return json({ file: publicFile(stored) });
		} catch (e) {
			// Every ingest refusal is the user's to read: too big, not text, a picture with no
			// document in it. Nothing was stored, so there is nothing to clean up.
			return json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	}
	if (path === '/api/assistant-files/text' && req.method === 'GET') {
		const file = serverDb.getAssistantFile(url.searchParams.get('id') ?? '');
		if (!file) return json({ error: 'No attached file with that id.' }, 404);
		const text = readAssistantFileText(file.textPath);
		const lines = splitLines(text);
		// The viewer pages: a 10 MB file must not be handed to the DOM in one string.
		const from = Number(url.searchParams.get('from') ?? 1);
		const to = Number(url.searchParams.get('to') ?? lines.length);
		const range = clampRange(lines.length, Number.isFinite(from) ? from : 1, Number.isFinite(to) ? to : lines.length);
		return json({
			file: publicFile(file),
			fromLine: range.from,
			toLine: range.to,
			totalLines: lines.length,
			lines: lines.length === 0 ? [] : lines.slice(range.from - 1, range.to)
		});
	}
	if (path === '/api/assistant-files/delete' && req.method === 'POST') {
		const { id } = (await req.json()) as { id?: string };
		if (!id) return json({ error: 'id is required.' }, 400);
		const file = serverDb.getAssistantFile(id);
		// Only a file still staged in a composer can be thrown away. Once it has ridden a
		// turn the transcript names it, and a row deleted out from under that would leave the
		// assistant's own record pointing at nothing.
		if (file && file.messageId !== null) {
			return json({ error: 'That file has already been sent, so it stays with the conversation.' }, 400);
		}
		serverDb.deleteAssistantFile(id);
		backupService.markChanged();
		return json({ ok: true });
	}

	// ----- Assistant session settings (frozen per session; re-synced on demand) -----
	if (path === '/api/assistant-session-settings' && req.method === 'GET') {
		const sessionId = url.searchParams.get('sessionId') ?? '';
		if (!sessionId) return json({ error: 'sessionId is required.' }, 400);
		return json({ stale: settingsStale(sessionId) });
	}
	if (path === '/api/assistant-session-settings' && req.method === 'PUT') {
		const { sessionId } = (await req.json()) as { sessionId?: string };
		if (!sessionId) return json({ error: 'sessionId is required.' }, 400);
		applyLiveSettings(sessionId);
		return json({ stale: false });
	}

	// ----- LLM (non-streaming control plane) -----
	if (path === '/api/llm/providers' && req.method === 'GET') {
		return json({ providers: providerMetadata() });
	}
	if (path === '/api/llm/models' && req.method === 'POST') {
		const { connectionId, provider } = (await req.json()) as { connectionId: string; provider: string };
		if (!isProvider(provider)) return json({ error: 'Unknown provider' }, 400);
		if (!connectionId) return json({ error: 'No connection specified' }, 400);
		try {
			const models = await fetchAvailableModels(connectionId, provider);
			return json({ models, baseUrl: resolvedBaseUrl(connectionId, provider) });
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 502);
		}
	}
	if (path === '/api/llm/model-endpoints' && req.method === 'POST') {
		const { connectionId, provider, model } = (await req.json()) as { connectionId: string; provider: string; model: string };
		if (!isProvider(provider)) return json({ error: 'Unknown provider' }, 400);
		if (!connectionId) return json({ error: 'No connection specified' }, 400);
		if (!model) return json({ error: 'No model specified' }, 400);
		try {
			return json({ endpoints: await fetchModelEndpoints(connectionId, provider, model) });
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 502);
		}
	}
	if (path === '/api/llm/validate' && req.method === 'POST') {
		const { connectionId, provider } = (await req.json()) as { connectionId: string; provider: string };
		if (!isProvider(provider)) return json({ error: 'Unknown provider' }, 400);
		if (!connectionId) return json({ valid: false, error: 'No connection specified' });
		try {
			return json({ valid: await validateCredentials(connectionId, provider) });
		} catch (e) {
			return json({ valid: false, error: e instanceof Error ? e.message : String(e) });
		}
	}
	if (path === '/api/llm/account' && req.method === 'POST') {
		const { connectionId, provider } = (await req.json()) as { connectionId: string; provider: string };
		if (!isProvider(provider)) return json({ error: 'Unknown provider' }, 400);
		if (!connectionId) return json({ error: 'No connection specified' }, 400);
		try {
			return json({ account: await fetchAccount(connectionId, provider) });
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 502);
		}
	}

	return json({ error: 'Not found' }, 404);
}

// ===== WebSocket message handling (sync + LLM streaming) =====

/**
 * A reply and an opening scene are written HERE, because the page that asked for them may
 * never come back: a phone whose browser is discarded loses the request id with the tab, and
 * the reply it paid for would sit unclaimed until its window ran out. Every other call keeps
 * its result client-side, and the difference is what the loss costs. Chat memory refires on
 * the next turn, a sprite is re-read, a spellcheck is a button press, and a continue extends
 * a turn that is already safe on disk and re-continues with one click. None of those is a
 * story the reader cannot get back, and giving each of them a commit path would be machinery
 * that only ever runs where nothing was at stake.
 *
 * The placement shape itself is in shared/generation.ts, since both ends speak it.
 *
 * This writes a finished generation's reply into the story and tells every device, in that
 * order, so a page reading the `messages` hint finds committed state rather than racing it.
 *
 * Returns the new turn's id and the steering notes it really spent, for the `llm-done` frame,
 * or null when there was nothing to land: a stop that kept no text (the reader asked for
 * nothing to be kept), or a chat that was deleted while the model was writing.
 *
 * The broadcast deliberately carries no origin, unlike an ordinary mutation's: the page that
 * started this may be gone, and the one that is still here needs the hint as much as the
 * others. Its own copy defers safely behind `missedSyncWhileStreaming` while it is streaming
 * (architecture/chat-sessions.md).
 */
function commitGeneration(
	commit: GenerationCommit,
	result: LlmCompletionResult,
	timings: { generationMs: number; firstTokenMs: number | null; reasoningMs: number | null }
): { messageId: string; spentSteeringIds: string[] } | null {
	// The stop contract, and it is the client's rule moved rather than a new one: a stop
	// mid-stream keeps everything that streamed, and only a stop that beat the first token
	// has nothing worth a row.
	if (result.finishReason === 'cancelled' && !result.content.trim()) return null;

	const landed = serverDb.commitGeneratedTurn({
		chatId: commit.chatId,
		parentId: commit.parentId,
		expectedLeafId: commit.expectedLeafId,
		claimsRoot: commit.claimsRoot,
		content: result.content,
		thinking: result.thinking ?? null,
		model: result.model,
		provider: result.provider,
		tokensPrompt: result.usage.promptTokens,
		tokensCompletion: result.usage.completionTokens,
		finishReason: result.finishReason,
		generationMs: timings.generationMs,
		firstTokenMs: timings.firstTokenMs,
		reasoningMs: timings.reasoningMs,
		lorebook: commit.lorebook ?? null,
		spendSteeringIds: commit.spendSteeringIds
	});
	if (!landed) return null;

	broadcastSync('messages', null);
	if (landed.spentSteeringIds.length) broadcastSync('steering', null);
	return landed;
}

async function handleLlm(ws: ServerWebSocket<SocketData>, msg: {
	id: string;
	connectionId: string;
	provider: string;
	model: string;
	messages: { role: 'user' | 'assistant' | 'system'; content: string; images?: string[] }[];
	maxTokens?: number;
	temperature?: number;
	params?: Record<string, string | number>;
	/** Reasoning/verbosity/media tuning; providers translate what they support. */
	tuning?: import('./llm/types').GenerationTuning;
	/** The connection's OpenRouter routing (openrouter only; ignored elsewhere). */
	routing?: RoutingConfig | null;
	stream?: boolean;
	/** Debug-panel label for what kind of query this is ('chat', 'memory', …). */
	source?: string;
	/** Where this generation's reply belongs in the story, when it belongs in one at all.
	 *  Present for the two paths that CREATE a turn (a reply, an opening scene) and absent
	 *  for every other call, which is what decides who writes the answer down. See
	 *  `commitGeneration`. */
	commit?: GenerationCommit;
}): Promise<void> {
	if (!isProvider(msg.provider)) {
		ws.send(JSON.stringify({ t: 'llm-error', id: msg.id, message: `Unknown provider: ${msg.provider}` }));
		return;
	}
	if (!msg.connectionId) {
		ws.send(JSON.stringify({ t: 'llm-error', id: msg.id, message: 'No connection specified' }));
		return;
	}

	if (typeof msg.id !== 'string' || !msg.id) return;
	// A placement that does not typecheck would land a turn somewhere nobody asked for, so it
	// is refused before a token is paid for rather than absorbed at commit time.
	if (msg.commit !== undefined && !isGenerationCommit(msg.commit)) {
		ws.send(JSON.stringify({ t: 'llm-error', id: msg.id, message: 'Malformed commit placement on the request.' }));
		return;
	}
	// A reused id would orphan the first controller (uncancellable, unclaimable) and let the
	// first generation's ending overwrite the second's. The check is global because the map
	// is: two sockets sharing an id collide in exactly the same way as one socket reusing it.
	if (generations.has(msg.id)) {
		ws.send(JSON.stringify({ t: 'llm-error', id: msg.id, message: 'Duplicate request id: this request is already running.' }));
		return;
	}
	// One turn at a time per chat, and only for the calls that write one. A generation
	// outlives the page that asked for it, so a reader whose tab was discarded can reopen the
	// story, find it looking idle because the reply has not landed yet, and send again. Both
	// would commit, and the chat would hold two replies to one message. The composer's own
	// lock cannot see this: it belongs to a page that no longer exists. Engine calls stay
	// unlocked, since memory folding a chat while a reply is written into it is ordinary.
	if (msg.commit) {
		for (const live of generations.values()) {
			if (live.commitChatId === msg.commit.chatId && !live.settled) {
				ws.send(
					JSON.stringify({
						t: 'llm-error',
						id: msg.id,
						message: 'A reply is already being written for this chat. Wait for it to land, or stop it first.'
					})
				);
				return;
			}
		}
	}
	const controller = new AbortController();
	const gen: LiveGeneration = {
		controller,
		ws,
		content: '',
		thinking: '',
		settled: null,
		dropTimer: null,
		source: msg.source ?? 'completion',
		commitChatId: msg.commit?.chatId ?? null
	};
	generations.set(msg.id, gen);

	const stream = msg.stream !== false;

	// Capture the request for the shared debug log once, up front, so the request and
	// its result stay paired even if debug is toggled off mid-flight.
	const capture = anyDebug();
	if (capture) {
		const entry: promptLog.PromptLogEntry = {
			id: msg.id,
			source: msg.source ?? 'completion',
			kind: 'completion',
			provider: msg.provider,
			model: msg.model,
			messages: msg.messages,
			params: msg.params,
			maxTokens: msg.maxTokens,
			temperature: msg.temperature,
			stream,
			tuning: msg.tuning,
			routing: msg.routing,
			startedAt: Date.now(),
			status: 'pending'
		};
		promptLog.recordRequest(entry);
		broadcastPromptLog({ type: 'request', entry });
	}

	// A committing generation stamps its own clocks, because it also writes the row they land
	// on and it is the one side that is present for every frame. The client keeps measuring
	// its own for everything it still persists itself; the two never write the same column.
	// Monotonic rather than the wall clock: these three are durations, and an NTP step or a
	// hand-set clock mid-generation would be written into the row as a negative one.
	const startedAt = performance.now();
	let firstTokenAt: number | null = null;
	let thinkingFirstAt: number | null = null;
	let thinkingLastAt: number | null = null;

	try {
		const result = await complete(msg.connectionId, msg.provider, {
			model: msg.model,
			messages: msg.messages,
			maxTokens: msg.maxTokens,
			temperature: msg.temperature,
			params: msg.params,
			tuning: msg.tuning,
			routing: msg.routing,
			signal: controller.signal,
			// Only wire the callbacks when streaming: their presence is what makes the
			// provider issue a streaming request, so stream:false now genuinely asks the
			// API for a single non-streamed completion instead of just muting tokens.
			// Each token is kept as well as sent, so a page that was not listening for it
			// can still be handed it.
			onToken: stream
				? (token) => {
						firstTokenAt ??= performance.now();
						gen.content += token;
						emitGeneration(gen, { t: 'llm-token', id: msg.id, token });
					}
				: undefined,
			onThinkingToken: stream
				? (token) => {
						// Reasoning counts as the model speaking: on a model that thinks first, its
						// first thinking token IS the moment the wait ended.
						const at = performance.now();
						firstTokenAt ??= at;
						thinkingFirstAt ??= at;
						thinkingLastAt = at;
						gen.thinking += token;
						emitGeneration(gen, { t: 'llm-thinking', id: msg.id, token });
					}
				: undefined
		});
		// The debug log records the GENERATION, and it is filed before the commit on purpose:
		// the model answered and was paid whether or not the reply found a home, so a commit
		// that throws (a parent deleted mid-write) must not turn this into an error row with
		// no usage, no finish reason and none of the text it is the only place to read.
		if (capture) {
			const res: promptLog.PromptLogResult = {
				// A stopped generation RESOLVES with everything it streamed (see
				// architecture/llm-providers.md), so the status has to come from the finish
				// reason: recording it as 'done' would file a cancelled request as a clean one.
				status: result.finishReason === 'cancelled' ? 'cancelled' : 'done',
				endedAt: Date.now(),
				usage: result.usage,
				finishReason: result.finishReason,
				model: result.model,
				provider: result.provider,
				responseContent: result.content || undefined,
				responseThinking: result.thinking ?? undefined
			};
			if (promptLog.patchResult(msg.id, res)) broadcastPromptLog({ type: 'result', id: msg.id, result: res });
		}
		// Before the frame that announces it, so a page told the turn is done can read it.
		const landed = msg.commit
			? commitGeneration(msg.commit, result, {
					generationMs: Math.round(performance.now() - startedAt),
					firstTokenMs: firstTokenAt === null ? null : Math.round(firstTokenAt - startedAt),
					reasoningMs:
						thinkingFirstAt === null || thinkingLastAt === null
							? null
							: Math.round(thinkingLastAt - thinkingFirstAt)
				})
			: null;
		const committedMessageId = landed?.messageId ?? null;
		const spentSteeringIds = landed?.spentSteeringIds ?? [];
		emitGeneration(gen, { t: 'llm-done', id: msg.id, result, committedMessageId, spentSteeringIds });
		settleGeneration(msg.id, gen, { result, committedMessageId, spentSteeringIds });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		emitGeneration(gen, { t: 'llm-error', id: msg.id, message });
		settleGeneration(msg.id, gen, { error: message });
		if (capture) {
			const res: promptLog.PromptLogResult = {
				status: controller.signal.aborted ? 'cancelled' : 'error',
				endedAt: Date.now(),
				error: message
			};
			if (promptLog.patchResult(msg.id, res)) broadcastPromptLog({ type: 'result', id: msg.id, result: res });
		}
	}
}

/**
 * A page claiming a generation it started before its socket went away: it says how many
 * characters of each stream it already applied, and gets back the remainder plus, when the
 * call has already ended, the ending it missed. Applying those in the order they are sent
 * leaves it exactly where a page that never dropped would be.
 *
 * A generation nobody here has heard of (a server restart, a claim past the window, or a
 * request that died in the socket it was written to) is answered as gone. It must never be
 * left hanging: the asking page has a composer locked on it.
 */
function handleLlmAttach(
	ws: ServerWebSocket<SocketData>,
	msg: { id?: unknown; haveContent?: unknown; haveThinking?: unknown }
): void {
	const id = typeof msg.id === 'string' ? msg.id : '';
	const gen = id ? generations.get(id) : undefined;
	if (!gen) {
		ws.send(JSON.stringify({ t: 'llm-attach-miss', id }));
		return;
	}
	gen.ws = ws;
	const haveContent = typeof msg.haveContent === 'number' ? msg.haveContent : 0;
	const haveThinking = typeof msg.haveThinking === 'number' ? msg.haveThinking : 0;
	ws.send(
		JSON.stringify({
			t: 'llm-attached',
			id,
			content: gen.content.slice(haveContent),
			thinking: gen.thinking.slice(haveThinking)
		})
	);
	if (gen.settled) {
		if ('result' in gen.settled) {
			ws.send(
				JSON.stringify({
					t: 'llm-done',
					id,
					result: gen.settled.result,
					committedMessageId: gen.settled.committedMessageId,
					spentSteeringIds: gen.settled.spentSteeringIds
				})
			);
		} else {
			ws.send(JSON.stringify({ t: 'llm-error', id, message: gen.settled.error }));
		}
	}
}

/** The claiming page has the answer and no longer needs the server to hold it. */
function handleLlmRelease(msg: { id?: unknown }): void {
	if (typeof msg.id === 'string' && msg.id) dropGeneration(msg.id);
}

/**
 * Assistant turns in flight, keyed by SESSION. This map is the per-tab lock (one tab =
 * one loop: two concurrent turns would interleave writes into the same persisted
 * context), the abort registry, and the live snapshot a page that connects mid-turn is
 * handed. It is deliberately NOT per-socket state: an assistant turn outlives its socket
 * so a page reload or network blip cannot kill long multi-step work, and the loop
 * commits the finished turn server-side, so the result syncs to every device when it lands.
 */
interface LiveTurn {
	requestId: string;
	controller: AbortController;
	/** The turn's timeline so far, in exactly the shape the panel renders it. */
	steps: AssistantStep[];
	iteration: number;
	/**
	 * What this turn has STOPPED on and is waiting for a person to answer: calls that need
	 * approving, or questions the assistant asked. It rides the LIVE TURN rather than a socket
	 * because the answer may come from any device with the tab open, and because a page that
	 * reloads mid-wait has to be handed the card again, which is what `assistantStatus` does
	 * with it. First answer wins; `resolve` is dropped with it.
	 *
	 * ONE slot, not two: the loop runs a step's calls in order, so it can only ever be waiting
	 * on one of them, and "both pending" must not be representable.
	 */
	pending?:
		| { kind: 'approval'; card: ApprovalCard; resolve: (outcome: ApprovalOutcome) => void }
		| { kind: 'question'; card: QuestionCard; resolve: (outcome: QuestionOutcome) => void };
}
const assistantTurns = new Map<string, LiveTurn>();

/**
 * Folds one outgoing event into the turn's live snapshot, mirroring how the panel builds
 * its own timeline from the same events. A page that reloads mid-turn asks for this
 * snapshot and then keeps applying the deltas that follow, so the screen looks as if it
 * had been watching all along.
 *
 * `assistant-tool-progress` is deliberately NOT folded in: this snapshot is the turn's
 * durable timeline, the same `AssistantStep[]` the loop persists, and a call that has not
 * returned yet has no step. The panel renders those frames in a separate, ephemeral row,
 * and a page that reloads mid-call fills it from the next frame (at most one throttle
 * period away) instead of this array carrying state that can never be committed.
 */
function recordLiveEvent(turn: LiveTurn, event: Record<string, unknown>): void {
	const last = turn.steps[turn.steps.length - 1];
	if (event.t === 'assistant-reply') {
		const delta = String(event.delta);
		if (last?.kind === 'text') last.text += delta;
		else turn.steps.push({ kind: 'text', text: delta });
	} else if (event.t === 'assistant-thinking') {
		const delta = String(event.delta);
		if (last?.kind === 'thinking') last.text += delta;
		else turn.steps.push({ kind: 'thinking', text: delta });
	} else if (event.t === 'assistant-tool-result') {
		turn.steps.push({ kind: 'tool', tool: event.result as AssistantToolResult });
	} else if (event.t === 'assistant-iteration') {
		turn.iteration = Number(event.iteration);
	}
}

/**
 * Takes the card down and tells every page it is spent. Guarded by id so a late answer to an
 * older card cannot settle the one that replaced it, and so the second device to answer is a
 * no-op rather than a second outcome the waiting loop has no room for.
 */
function settlePending(turn: LiveTurn, sessionId: string, requestId: string, askId: string): boolean {
	if (turn.pending?.card.askId !== askId) return false;
	turn.pending = undefined;
	broadcastAssistant({ t: 'assistant-ask-settled', id: requestId, assistantSessionId: sessionId, askId });
	return true;
}

/**
 * Blocks the turn on a decision. Unlimited by design: nothing has been written when this
 * waits, so a turn abandoned here (the user walks away, the server restarts) loses only
 * work that never happened. A stop settles it as a refusal of everything, which is the
 * reading a Stop already has everywhere else in this app.
 */
function askApproval(turn: LiveTurn, sessionId: string, requestId: string, calls: ApprovalCall[]): Promise<ApprovalOutcome> {
	return new Promise((resolve) => {
		const card: ApprovalCard = { askId: crypto.randomUUID(), calls };
		const settle = (outcome: ApprovalOutcome) => {
			if (settlePending(turn, sessionId, requestId, card.askId)) resolve(outcome);
		};
		turn.pending = { kind: 'approval', card, resolve: settle };
		turn.controller.signal.addEventListener('abort', () => settle({ approved: [] }), { once: true });
		broadcastAssistant({ t: 'assistant-approval', id: requestId, assistantSessionId: sessionId, ...card });
	});
}

/**
 * Blocks the turn on the assistant's own questions, the other half of the same wait. Safe
 * for the same reason and then some: nothing has been written and nothing has been asked
 * twice, so a Stop here simply answers `stopped` and the tool fails like any other.
 */
function askQuestions(turn: LiveTurn, sessionId: string, requestId: string, questions: AskQuestion[]): Promise<QuestionOutcome> {
	return new Promise((resolve) => {
		const card: QuestionCard = { askId: crypto.randomUUID(), questions };
		const settle = (outcome: QuestionOutcome) => {
			if (settlePending(turn, sessionId, requestId, card.askId)) resolve(outcome);
		};
		turn.pending = { kind: 'question', card, resolve: settle };
		turn.controller.signal.addEventListener('abort', () => settle({ answers: [], stopped: true }), { once: true });
		broadcastAssistant({ t: 'assistant-question', id: requestId, assistantSessionId: sessionId, ...card });
	});
}

/** One device answered the card. Every device saw it, so the first answer wins and the
 *  rest are no-ops, matched by ask id, never by socket. */
function handleAssistantApprove(msg: { assistantSessionId?: string; askId?: string; approved?: unknown }): void {
	const turn = typeof msg.assistantSessionId === 'string' ? assistantTurns.get(msg.assistantSessionId) : undefined;
	if (turn?.pending?.kind !== 'approval' || turn.pending.card.askId !== msg.askId) return;
	const approved = Array.isArray(msg.approved) ? msg.approved.filter((n): n is number => typeof n === 'number') : [];
	turn.pending.resolve({ approved });
}

/** The same door for a question card. The answers arrive in the order the questions were
 *  asked; anything malformed reads as unanswered rather than throwing under a waiting turn. */
function handleAssistantAnswer(msg: { assistantSessionId?: string; askId?: string; answers?: unknown }): void {
	const turn = typeof msg.assistantSessionId === 'string' ? assistantTurns.get(msg.assistantSessionId) : undefined;
	if (turn?.pending?.kind !== 'question' || turn.pending.card.askId !== msg.askId) return;
	const raw = Array.isArray(msg.answers) ? msg.answers : [];
	const answers: QuestionAnswer[] = turn.pending.card.questions.map((q, i) => {
		const a = (raw[i] ?? {}) as { picked?: unknown; written?: unknown };
		// Only options the card actually offered count: an answer naming something else came
		// from a stale card, and the model would read it as a choice it never presented.
		const offered = new Set(q.options);
		const picked = Array.isArray(a.picked) ? a.picked.filter((p): p is string => typeof p === 'string' && offered.has(p)) : [];
		const written = typeof a.written === 'string' && a.written.trim() ? a.written.trim() : null;
		return { picked: q.multiple ? picked : picked.slice(0, 1), written };
	});
	turn.pending.resolve({ answers });
}

/** Publish one assistant event to every open page. The events belong to the SESSION: a
 *  page that reloaded mid-turn never issued the request, and the socket that did may be
 *  gone, so sending only there is how a running reply vanishes from the screen. */
function broadcastAssistant(event: Record<string, unknown>): void {
	const payload = JSON.stringify(event);
	for (const ws of sockets) ws.send(payload);
}

async function handleAssistantMessage(
	ws: ServerWebSocket<SocketData>,
	msg: AssistantRequest
): Promise<void> {
	if (typeof msg.id !== 'string' || !msg.id || typeof msg.assistantSessionId !== 'string' || !msg.assistantSessionId) return;
	for (const turn of assistantTurns.values()) {
		if (turn.requestId === msg.id) {
			ws.send(JSON.stringify({ t: 'assistant-error', id: msg.id, message: 'Duplicate request id: this request is already running.' }));
			return;
		}
	}
	if (assistantTurns.has(msg.assistantSessionId)) {
		ws.send(
			JSON.stringify({
				t: 'assistant-error',
				id: msg.id,
				message: 'A turn is already running in this assistant tab (possibly from another device). It keeps running on the server; its result appears here when it finishes.'
			})
		);
		return;
	}
	const controller = new AbortController();
	const turn: LiveTurn = { requestId: msg.id, controller, steps: [], iteration: 0 };
	assistantTurns.set(msg.assistantSessionId, turn);

	try {
		await handleAssistant(msg, {
			signal: controller.signal,
			// Every event carries the session (which page is showing this turn) and the
			// request id (which pending promise settles on it), and goes to every open page.
			send: (event) => {
				recordLiveEvent(turn, event);
				broadcastAssistant({ ...event, id: msg.id, assistantSessionId: msg.assistantSessionId });
			},
			// originClientId = null → every client (including this one) refreshes,
			// so the assistant's edits show up live wherever they're displayed.
			broadcast: (scope) => broadcastSync(scope, null),
			// Capture each iteration's assembled prompt into the shared debug log, but
			// only while a device is actually debugging.
			recordPrompt: (entry) => {
				if (!anyDebug()) return;
				promptLog.recordRequest(entry);
				broadcastPromptLog({ type: 'request', entry });
			},
			// Patch the real result onto the recorded prompt. No anyDebug gate here:
			// patchResult no-ops (false) unless the request was captured, which keeps the
			// pair intact even if debugging toggles off mid-turn.
			recordResult: (id, result) => {
				if (promptLog.patchResult(id, result)) broadcastPromptLog({ type: 'result', id, result });
			},
			// The turn blocks here when the tab's approval mode says it must. It is the one
			// place a turn waits on a person, and it is safe to wait forever: nothing has
			// been written yet, so losing the turn costs nothing that happened.
			requestApproval: (calls) => askApproval(turn, msg.assistantSessionId, msg.id, calls),
			askQuestions: (questions) => askQuestions(turn, msg.assistantSessionId, msg.id, questions)
		});
	} catch (e) {
		// Session-addressed like every other event of this turn: pages that already rendered
		// part of it must be told it ended, not left waiting on a turn that is over.
		broadcastAssistant({
			t: 'assistant-error',
			id: msg.id,
			assistantSessionId: msg.assistantSessionId,
			message: e instanceof Error ? e.message : String(e)
		});
	} finally {
		assistantTurns.delete(msg.assistantSessionId);
	}
}

/**
 * Answers "is a turn running in these sessions?" for a page that just connected, on boot
 * or after a reconnect. The snapshot is read and sent in this one synchronous block, so no
 * event can slip between it and the deltas that follow: the page can append them straight
 * onto what it was handed. A session that is missing from the answer has no turn running,
 * which is the page's cue to re-read its transcript (the turn may have finished while it
 * was away).
 */
function handleAssistantStatus(ws: ServerWebSocket<SocketData>, msg: { id: string; sessionIds?: unknown }): void {
	const ids = Array.isArray(msg.sessionIds) ? msg.sessionIds.filter((s): s is string => typeof s === 'string') : [];
	const running = ids.flatMap((sessionId) => {
		const turn = assistantTurns.get(sessionId);
		return turn
			? [
					{
						sessionId,
						steps: turn.steps,
						iteration: turn.iteration,
						// A page that reloads while the turn waits must be handed the card again,
						// or the turn looks hung with no way to answer it.
						...(turn.pending ? { ask: { kind: turn.pending.kind, ...turn.pending.card } } : {})
					}
				]
			: [];
	});
	ws.send(JSON.stringify({ t: 'assistant-status-result', id: msg.id, running }));
}

// ===== Boot =====

// A backup job re-invokes THIS executable with the job in its environment (backup/job.ts
// explains why it is a process rather than a worker). It must not become a second server,
// and above all must not reach `serverDb.open()` below: opening runs the migrations, which
// is the one thing a pre-upgrade snapshot exists to happen before. Top-level await, so
// nothing past this line runs in a child.
if (process.env[JOB_ENV]) {
	await runJobChild();
}

// A setting this process cannot read is a setting it would silently substitute a default for,
// and the two it decides are where the data lives and who can reach it.
if (CONFIG_ISSUES.length > 0) {
	fatal(['ChungusHub could not read its settings, so it has not started.', '', ...CONFIG_ISSUES]);
}
ensureDirs();
ensureConfigFile();
// Refuse a backup folder nested inside the data folder, or the reverse, at boot rather than
// on the second snapshot, which is when it would otherwise become visible: by then the
// snapshots contain each other.
try {
	assertBackupDirUsable();
} catch (error) {
	fatal([
		'ChungusHub cannot use these two folders together, so it has not started.',
		'',
		error instanceof Error ? error.message : String(error)
	]);
}

const startedAt = Date.now();
/** The port actually being served, which is only knowable once the socket is open (a
 *  configured 0 asks the OS to choose). Answered to whoever else tries this data folder. */
let boundPort = PORT;
// Before the restore swap and before any database is opened, which is what this has to stand in
// front of: the folder exists by now (`ensureDirs` above, and the claim needs it to), but from
// here on every line writes into it.
let alreadyRunning: RunningInstance | null = null;
try {
	alreadyRunning = await claimDataDir(DATA_DIR, () => ({
		pid: process.pid,
		port: boundPort,
		startedAt
	}));
} catch (error) {
	// A claim that cannot be settled either way is not a folder going spare: carrying on would
	// be the guess this whole mechanism exists to refuse.
	fatal([
		'ChungusHub could not tell whether another copy is using this data folder, so it has not started.',
		`  ${DATA_DIR}`,
		'',
		error instanceof Error ? error.message : String(error)
	]);
}
if (alreadyRunning) {
	fatal([
		'ChungusHub is already using this data folder, so this copy has not started.',
		`  ${DATA_DIR}`,
		'',
		alreadyRunning.pid
			? `The copy holding it is serving on port ${alreadyRunning.port} (process ${alreadyRunning.pid}).`
			: 'Another copy is holding it.',
		'',
		'Close that one first, or point this copy at a different folder:',
		`  "dataDir" in ${CONFIG_PATH}`
	]);
}

// A marker means a restore was claimed, or was cut short part-way through. Either way the
// swap runs HERE and only here: nothing has opened a database yet, which is the one moment
// this process is able to replace its own database file at all (backup/restore.ts).
const restoredFrom = await resumeInterruptedRestore();
// Read once, after the restore has decided which database this is, and used twice below.
const schemaOnDisk = schemaVersionOnDisk();
/**
 * Data written by a build newer than this one. Migrations only run forward, so this build sees
 * a schema it was never written against: it reads what it knows and writes rows the newer build
 * may not accept back. Said out loud and then allowed, because the alternative is an install
 * that refuses to open the only copy of someone's work, and the pre-upgrade snapshot the newer
 * build took still holds the data as it was.
 */
dataAhead = schemaOnDisk > LATEST_SCHEMA_VERSION;
if (dataAhead) {
	console.log('');
	console.log(`  This data folder was last used by a NEWER ChungusHub (data format ${schemaOnDisk}; this one reads ${LATEST_SCHEMA_VERSION}).`);
	console.log('  Writing here with this build can damage it. Update this copy, or open the folder');
	console.log('  with the newer build again. To go back instead, restore the snapshot taken before');
	console.log('  that upgrade from Settings → Backups.');
}
await snapshotBeforeUpgrade(schemaOnDisk);
// Open the database now: a broken file or failing migration kills the boot loudly
// instead of surfacing on the first request (the handle itself binds lazily, see db.ts).
serverDb.open();
// Stamp the epoch only now: writing it any earlier would mean opening the database, and
// opening runs the migrations the pre-upgrade snapshot above has to land in front of.
if (restoredFrom) serverDb.setSetting('dataEpoch', String(Date.now()));
dataEpoch = Number(serverDb.getSetting('dataEpoch') ?? '0') || 0;
runBootSweeps();
ensureBackupStoreMarkers();
const abandonedSnapshots = sweepAbandonedSnapshots();
if (abandonedSnapshots > 0) {
	console.log(`[backup] cleared ${abandonedSnapshots} half-written snapshot(s) from an interrupted job.`);
}
backupService.configure((scope) => broadcastSync(scope, null));
backupService.pruneNow();
backupService.startSchedule();

/**
 * The most valuable snapshot the app takes, and the only one whose timing carries weight: it
 * has to land before the migrations run, which means before `serverDb.open()`. A schema
 * version of 0 is a fresh install with nothing to protect.
 *
 * A failure here stops the boot instead of upgrading unprotected, because "the backup did
 * not happen" is precisely the sentence nobody reads in a log. The way past it is named on
 * screen rather than left to be guessed, so a full disk is an inconvenience and not a wall.
 */
async function snapshotBeforeUpgrade(onDisk: number): Promise<void> {
	if (onDisk === 0 || onDisk >= LATEST_SCHEMA_VERSION) return;
	if (process.env.CHUNGUS_SKIP_UPGRADE_BACKUP === '1') {
		console.log('  CHUNGUS_SKIP_UPGRADE_BACKUP is set: upgrading the database without a backup.');
		return;
	}
	console.log('');
	console.log(`  Upgrading the database (format ${onDisk} to ${LATEST_SCHEMA_VERSION}).`);
	console.log('  Backing up first. On a large library this takes a moment.');
	try {
		const manifest = await backupService.snapshot(
			'preUpgrade',
			`Before upgrading to database format ${LATEST_SCHEMA_VERSION}`,
			// Nothing may read a setting yet: `getSetting` would open the database, and
			// opening is what runs the migrations this snapshot is standing in front of.
			{ prune: false }
		);
		console.log(`  Backed up as ${manifest.id}.`);
	} catch (error) {
		fatal([
			'ChungusHub could not back up before upgrading the database, so it has not upgraded it.',
			error instanceof Error ? error.message : String(error),
			'Free some disk space and start it again, or set CHUNGUS_SKIP_UPGRADE_BACKUP=1',
			'to upgrade without one.'
		]);
	}
}

/** Where the listening socket is opened. This is the whole of the network-access
 *  switch: off and the port exists on loopback only, so a device on the network has
 *  nothing to connect to rather than something that turns it away. */
function bindHostname(): string {
	return security.isNetworkAccessEnabled() ? HOST : '127.0.0.1';
}

// Second generic is Bun's declarative `routes` path union; we dispatch every path in
// `fetch` below, so it stays at its `never` default.
function serve(hostname: string) {
	return Bun.serve<SocketData>({
		port: PORT,
		hostname,
		// Allow large image uploads.
		maxRequestBodySize: 64 * 1024 * 1024,

		async fetch(req, srv) {
			const url = new URL(req.url);
			const path = url.pathname;

			// Effective client IP. Direct connections use the socket address. The one
			// exception: the Vite dev proxy reaches us from loopback and forwards the
			// real device behind it in X-Forwarded-For (xfwd in vite.config.ts). Trust
			// that header from loopback only, so both gates below see the actual device
			// in dev too. A remote client sending a forged XFF is ignored, and anything
			// local enough to hit loopback already owns the machine.
			const socketIp = srv.requestIP(req)?.address ?? null;
			const forwarded = req.headers.get('x-forwarded-for');
			const clientIp =
				isLoopback(socketIp) && forwarded ? forwarded.split(',')[0].trim() : socketIp;

			// Access gate: only allowlisted IPs (and the loopback host) get past here,
			// unless the allowlist has been switched off in Settings → Security. A denied
			// attempt is remembered so the settings UI can offer one-click allow.
			if (security.isIpAllowlistEnabled() && !isAllowed(clientIp)) {
				recordDenied(clientIp);
				return forbidden(clientIp);
			}

			const host = req.headers.get('host');

			// Login must stay reachable for devices that haven't unlocked yet.
			if (path === '/api/auth/login' && req.method === 'POST') {
				try {
					const { password } = (await req.json()) as { password?: string };
					const ip = clientIp ? normalizeIp(clientIp) : 'unknown';
					if (security.isLockedOut(ip)) return json({ error: 'Too many attempts.' }, 429);
					const token = security.login(String(password ?? ''), ip);
					if (!token) return json({ error: 'Wrong password.' }, security.isLockedOut(ip) ? 429 : 401);
					return json({ ok: true }, 200, { 'set-cookie': security.sessionCookie(token) });
				} catch (e) {
					return json({ error: e instanceof Error ? e.message : String(e) }, 400);
				}
			}

			// The unlock page has a stable URL so the dev proxy can redirect to it too.
			// Already-unlocked (or exempt) devices just bounce home.
			const needsUnlock =
				security.isPasswordEnabled() &&
				!isLoopback(clientIp) &&
				!security.hasValidSession(req.headers.get('cookie'));
			if (path === '/unlock') {
				if (needsUnlock) return loginPage(host);
				return new Response(null, { status: 302, headers: { location: '/' } });
			}

			// Password gate: with a password set, every non-loopback device needs a
			// session cookie. Page loads bounce to the unlock screen; API/files/WS get 401.
			if (needsUnlock) {
				if (path.startsWith('/api/') || path.startsWith('/files/') || path === '/ws') {
					return json({ error: 'Password required.' }, 401);
				}
				return new Response(null, { status: 302, headers: { location: '/unlock' } });
			}

			// Restore in progress: the database is closed and the files under it are being
			// replaced, so there is nothing this process can answer truthfully. Sits below the
			// two security gates on purpose: a device that is not allowed in learns that,
			// not what this install happens to be doing.
			if (maintenance) {
				// Two reads stay open (the Backups page is the surface that has to keep
				// saying what is happening, and it cannot do that through a gate that refuses
				// it), plus the one mutation that ENDS this state: cancelling the claimed
				// restore. All three sit behind the same two security gates as everything else.
				const readable =
					req.method === 'GET' && (path === '/api/backups' || path === '/api/config');
				const cancel = req.method === 'POST' && path === '/api/backups/cancel-restore';
				if (!readable && !cancel) {
					if (path.startsWith('/api/') || path.startsWith('/files/') || path === '/ws') {
						// Both lines, not just the headline: a launching app draws its own card
						// from this and would otherwise name the state without saying what to do.
						return json(
							{ error: maintenance.headline, detail: maintenance.detail, maintenance: true },
							503
						);
					}
					return maintenancePage(maintenance);
				}
			}

			// WebSocket upgrade.
			if (path === '/ws') {
				const clientId = url.searchParams.get('clientId') ?? crypto.randomUUID();
				const ip = clientIp ? normalizeIp(clientIp) : null;
				if (srv.upgrade(req, { data: { clientId, ip } })) return undefined as unknown as Response;
				return new Response('Upgrade failed', { status: 400 });
			}

			// Image files (served directly; access is already gated by IP above).
			if (path.startsWith('/files/backgrounds/')) {
				return serveDefaultBackground(path);
			}
			if (path.startsWith('/files/')) {
				return serveImage(path);
			}

			if (path.startsWith('/api/')) {
				try {
					return await handleApi(req, url, clientIp);
				} catch (e) {
					return json({ error: e instanceof Error ? e.message : String(e) }, 500);
				}
			}

			// Static PWA.
			return serveStatic(path, host);
		},

		websocket: {
			open(ws) {
				sockets.add(ws);
			},
			close(ws) {
				sockets.delete(ws);
				debugSockets.delete(ws);
				// Detach, never abort. A backgrounded phone has this socket torn down by the
				// OS mid-reply, and aborting here threw away the call and every token the
				// reader had already watched arrive. The generation keeps running with nobody
				// listening; whoever comes back claims it (`llm-attach`). Assistant turns
				// survive their socket the same way, in assistantTurns.
				for (const gen of generations.values()) {
					if (gen.ws === ws) gen.ws = null;
				}
			},
			async message(ws, raw) {
				let msg: { t: string; [k: string]: unknown };
				try {
					msg = JSON.parse(String(raw));
				} catch {
					return;
				}
				// `null`, numbers, and other non-object frames parse fine and then explode on
				// property access. Drop anything that isn't a routable message.
				if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
				if (msg.t === 'llm') {
					await handleLlm(ws, msg as never);
				} else if (msg.t === 'assistant') {
					await handleAssistantMessage(ws, msg as never);
				} else if (msg.t === 'assistant-approve') {
					handleAssistantApprove(msg as never);
				} else if (msg.t === 'assistant-answer') {
					handleAssistantAnswer(msg as never);
				} else if (msg.t === 'assistant-status') {
					handleAssistantStatus(ws, msg as never);
				} else if (msg.t === 'debug') {
					// This device toggled its debug panel; track it so the server captures +
					// broadcasts prompt logs only while someone is listening.
					if (msg.on) debugSockets.add(ws);
					else debugSockets.delete(ws);
				} else if (msg.t === 'llm-attach') {
					handleLlmAttach(ws, msg as never);
				} else if (msg.t === 'llm-release') {
					handleLlmRelease(msg as never);
				} else if (msg.t === 'llm-cancel') {
					// Matched by request id across every socket, so a Stop lands after the
					// requesting socket reconnected, exactly like assistant-cancel below.
					generations.get(String(msg.id))?.controller.abort();
				} else if (msg.t === 'assistant-cancel') {
					// Assistant turns are session-keyed, not socket-keyed: match by request id
					// first, and honour an explicit session id so a Stop still lands after the
					// requesting socket reconnected (or from another device).
					for (const turn of assistantTurns.values()) {
						if (turn.requestId === String(msg.id)) turn.controller.abort();
					}
					const sessionId = typeof msg.assistantSessionId === 'string' ? msg.assistantSessionId : '';
					if (sessionId) assistantTurns.get(sessionId)?.controller.abort();
				} else if (msg.t === 'ping') {
					ws.send(JSON.stringify({ t: 'pong' }));
				}
			}
		}
	});
}

/** The socket. A taken port is the likeliest way a first launch ends, so it is answered
 *  in words rather than as an EADDRINUSE trace, and no bind failure is left to raise. */
async function bootServer(hostname: string) {
	try {
		return await serveWhenFree(hostname);
	} catch (error) {
		if ((error as { code?: string }).code !== 'EADDRINUSE') {
			fatal([
				`ChungusHub could not open port ${PORT} on ${hostname}.`,
				error instanceof Error ? error.message : String(error)
			]);
		}
		fatal([
			`Port ${PORT} is already in use, so ChungusHub has nothing to listen on.`,
			'',
			'Close whatever is holding it, or give ChungusHub a port of its own:',
			'',
			`  "port" in ${CONFIG_PATH}`
		]);
	}
}

/**
 * A port is not free the instant its holder stops: the process still has to be torn down, and
 * a predecessor that died a moment ago is exactly what the next launch is racing. Left to fail
 * on the first attempt, a crash costs a restart by hand; waited out, it costs a blink. The wait
 * is bounded and says so on screen, so a port genuinely taken by something else still ends here
 * with the same sentence, a few seconds later.
 */
const BIND_WAIT_MS = 5_000;
const BIND_RETRY_MS = 100;

async function serveWhenFree(hostname: string) {
	const deadline = Date.now() + BIND_WAIT_MS;
	let said = false;
	for (;;) {
		try {
			return serve(hostname);
		} catch (error) {
			if ((error as { code?: string }).code !== 'EADDRINUSE' || Date.now() >= deadline) throw error;
			if (!said) {
				console.log(`  Port ${PORT} is busy. Waiting for it to come free…`);
				said = true;
			}
			await Bun.sleep(BIND_RETRY_MS);
		}
	}
}

let server = await bootServer(bindHostname());
boundPort = server.port ?? PORT;

/**
 * Rebinds run one at a time, in a queue. Two flips arriving together would otherwise
 * both read the current address, both find it stale, both close the socket, and then
 * race each other onto the port: the loser gets EADDRINUSE and the process dies with
 * nothing listening. A double tap on the switch is enough to do it.
 *
 * Each link re-reads the switch rather than carrying the value it was queued with, so
 * a burst collapses to the binding the last flip asked for and the ones behind it find
 * the address already correct and return.
 */
let rebindQueue: Promise<void> = Promise.resolve();

function rebindNetwork(): void {
	rebindQueue = rebindQueue.then(applyBinding);
}

/** Re-open the socket on the host the switch now calls for. Every live connection goes
 *  with the old one, which is the point: a device that was using the app over the
 *  network loses it the moment the network is closed, and the host's own app reconnects
 *  to loopback on its own. */
async function applyBinding(): Promise<void> {
	const hostname = bindHostname();
	if (server.hostname === hostname) return;
	try {
		await server.stop(true);
		// The socket this process just closed can still be holding the port for a moment.
		server = await serveWhenFree(hostname);
		boundPort = server.port ?? PORT;
	} catch (e) {
		// The old socket is already gone and there is nothing honest to fall back to.
		// Staying up would leave a process that looks alive and answers nobody, which
		// is the one outcome worse than stopping.
		fatal([
			`ChungusHub could not re-open its port on ${hostname}:${PORT}, so it is serving nobody.`,
			e instanceof Error ? e.message : String(e)
		]);
	}
	console.log(`  Network access ${security.isNetworkAccessEnabled() ? 'on' : 'off'}: listening on ${hostname}:${server.port}`);
}

// Editing these two files is how a machine with no browser on it is configured, so both
// are applied while the server runs rather than only at boot. A security switch needs
// exactly what its counterpart in Settings → Security already does; the device list
// needs nothing, since every gate reads it per request.
security.watchSecurityFile((change) => {
	if (change.networkAccess) rebindNetwork();
	if (change.tightened) kickAllSockets();
});
watchAllowlistFile();

const allowed = listAllowed();
console.log('');
console.log('  ChungusHub server running');
console.log(`  → http://localhost:${server.port}`);
console.log(`  → data:  ${DATA_DIR}`);
console.log('');
if (!security.isNetworkAccessEnabled()) {
	console.log(`  Access: this machine only. The port is open on ${server.hostname} alone.`);
	console.log('  Open it up in Settings → Security → Network Access, or, with no browser');
	console.log(`  on this machine, set "networkAccessEnabled": true in ${SECURITY_PATH}`);
	console.log('  and save. It applies here without a restart.');
} else if (security.isIpAllowlistEnabled()) {
	console.log('  Access: this machine is always allowed. Other devices must be');
	console.log('  added to the allowlist (Settings → Security → Device Access).');
	if (allowed.length) console.log(`  Allowed IPs: ${allowed.join(', ')}`);
} else {
	console.log('  Access: IP allowlist is OFF. Any device on your network can connect.');
}
if (security.isPasswordEnabled()) console.log('  Password lock: on (localhost is exempt).');

// Portable build: pop the UI in the default browser so double-clicking the
// executable feels like launching an app. CHUNGUS_NO_OPEN=1 suppresses it.
if (IS_COMPILED && !process.env.CHUNGUS_NO_OPEN) {
	const url = `http://localhost:${server.port}`;
	const cmd =
		process.platform === 'win32'
			? ['cmd', '/c', 'start', '', url]
			: process.platform === 'darwin'
				? ['open', url]
				: ['xdg-open', url];
	try {
		Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
	} catch {
		console.log(`  Could not open a browser automatically. Visit ${url}`);
	}
}
console.log('');
