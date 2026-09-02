/**
 * Build the portable distribution for the current platform:
 *
 *   dist/ChungusHub-portable/
 *     ChungusHub(.exe):    compiled server, Bun runtime embedded
 *     build/:              the built PWA the server serves
 *     defaults/:           bundled presets, skills, characters + backgrounds (first-run seed)
 *     README.txt
 *
 * Zip that folder and it runs on a clean machine: no Bun or Node required.
 * user-data/ is created next to the executable on first run.
 *
 * Run: bun run package
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// The DEFAULT and not this machine's `PORT`: the zip ships without a settings file, so what
// the note has to state is what a fresh install will listen on, not what the build machine does.
import { DEFAULT_PORT } from '../server/config';

const root = process.cwd();
const out = join(root, 'dist', 'ChungusHub-portable');

// package.json is the only place a version is stated and it is not shipped
// beside the executable, so the number has to be baked into the binary. Backups stamp it
// into every snapshot's manifest, which is what tells you later which build wrote one.
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string })
	.version;
if (!version) throw new Error('package.json has no "version"');

function run(cmd: string[]): void {
	console.log(`\n> ${cmd.join(' ')}`);
	const p = Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit', cwd: root });
	if (p.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed (exit ${p.exitCode})`);
}

// 1. Fresh client build.
run([process.execPath, 'run', 'build']);
if (!existsSync(join(root, 'build', 'index.html'))) {
	throw new Error('vite build produced no build/index.html');
}

// 2. Compile the server for this platform.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const exeName = process.platform === 'win32' ? 'ChungusHub.exe' : 'ChungusHub';
const compile = [
	process.execPath,
	'build',
	'--compile',
	'server/index.ts',
	'--define',
	`CHUNGUS_VERSION=${JSON.stringify(version)}`,
	'--outfile',
	join(out, exeName)
];
// The same .ico the browser tab uses, so the file, the taskbar and the tab all carry one
// mark. It is generated from static/icon.svg by `bun run icons`: a missing one would
// otherwise ship an executable wearing the Bun logo.
if (process.platform === 'win32') {
	const icon = join(root, 'static', 'favicon.ico');
	if (!existsSync(icon)) throw new Error('static/favicon.ico is missing. Run `bun run icons`');
	compile.push(`--windows-icon=${icon}`, '--windows-title=ChungusHub');
}
run(compile);

// macOS kills an unsigned arm64 binary on launch, so the signature is part of building
// it rather than a step left to whoever downloads it. `-` is the ad-hoc identity: no
// Apple account involved, enough to run, not enough to clear Gatekeeper's first-launch
// prompt (README.txt below tells the user how to get past that). The verify is not
// ceremony: a truncated or missing signature only shows itself as an instant crash on
// someone else's Mac, which is exactly the failure that has to break the build instead.
if (process.platform === 'darwin') {
	const entitlements = join(root, 'scripts', 'macos-entitlements.plist');
	if (!existsSync(entitlements)) throw new Error('scripts/macos-entitlements.plist is missing');
	const exePath = join(out, exeName);
	run(['codesign', '--force', '--sign', '-', '--entitlements', entitlements, exePath]);
	run(['codesign', '--verify', '--strict', exePath]);
}

// 3. Everything the server reads from disk at runtime. The backgrounds are part of the
// product, not an optional extra: `listBackgrounds` reads them straight from this folder,
// so shipping without them puts an empty picker in front of every first-run user.
cpSync(join(root, 'build'), join(out, 'build'), { recursive: true });
cpSync(join(root, 'defaults', 'presets'), join(out, 'defaults', 'presets'), { recursive: true });
cpSync(join(root, 'defaults', 'skills'), join(out, 'defaults', 'skills'), { recursive: true });
cpSync(join(root, 'defaults', 'characters'), join(out, 'defaults', 'characters'), { recursive: true });
const backgroundsSrc = join(root, 'defaults', 'backgrounds');
if (!existsSync(backgroundsSrc)) throw new Error('defaults/backgrounds is missing');
cpSync(backgroundsSrc, join(out, 'defaults', 'backgrounds'), { recursive: true });

// 4. A short note for people who open the zip. It has to be right about where the
// switches are: a wrong path here sends someone hunting through Settings for a page
// that does not exist, and the network steps only work in this order.
// The ad-hoc signature gets the macOS build running but does not clear Gatekeeper,
// which blocks the first launch behind a message that never says what to do about it.
// Only that build carries the paragraph; anywhere else it is noise.
const firstLaunch =
	process.platform === 'darwin'
		? `
macOS blocks the first launch, because this app is not signed with an Apple
developer certificate. Open System Settings → Privacy & Security, scroll to
the message naming ChungusHub and press Open Anyway. That is once, not every
time you run it.
`
		: process.platform === 'win32'
			? `
Windows shows a blue "Windows protected your PC" screen the first time,
because this app is not signed with a certificate bought from Microsoft.
Press More info, then Run anyway. That is once, not every time.
`
			: '';
writeFileSync(
	join(out, 'README.txt'),
	`ChungusHub portable

Run ${exeName}. A browser opens at http://localhost:${DEFAULT_PORT} and that is the app.
Keep this folder together. Your stories, characters and settings live in the
user-data folder created next to the executable. Keep it out of OneDrive,
Dropbox and any other synced folder: a sync client copying the database while
the app is writing to it can corrupt it.

ChungusHub backs that folder up on its own, into a backups folder beside it,
and always takes one before it upgrades its own database. Settings → Backups
is where you change how often, and where you go back to an earlier one. Both
folders hold your stories and your API keys, so copy them somewhere safe and
treat that copy the way you treat this one.

The port and both folder locations live in chungushub.config.json, written
beside the executable the first time you run it. Change "port" there if
something else on this machine already answers on ${DEFAULT_PORT}, or point
"dataDir" at a folder of your own to keep one workspace while the app itself
is replaced or moved. Set "openBrowser" to false and it serves without
opening one, which is what a machine you are not sitting at wants. If you
reach the app by a name rather than an address, a Tailscale name or your own
domain, put that name in "allowedHostnames", the name alone with no port;
its own address, localhost and this computer's name always work and need
nothing there. Changes apply the next time ChungusHub starts.
${firstLaunch}
To reach the app from your phone or another computer:

  1. On this machine, open Settings → Security and turn on Network Access.
     While it is off, the app runs for this computer alone and there is
     nothing on your network to connect to.

  2. On the other device, go to http://<this-machine's-ip>:${DEFAULT_PORT}
     It lands on a page saying it is not allowed yet. Leave it open.

  3. Back in Settings → Security, that device is now waiting under
     Device Access. Press Allow and it walks straight in.

Password Lock sits below Device Access and asks your other devices for a
password before they can use the app. This computer is never asked.

If this machine has no screen, the switches and the device list live in
files beside the executable. Run ChungusHub once, then edit them in any
text editor. Both apply straight away, with no restart.

    user-data/security.json    set "networkAccessEnabled" to true
    user-data/allowlist.json   add your computer: ["192.168.1.20"]

If you do not know your computer's address, save the first file only and
open http://<this-machine's-ip>:${DEFAULT_PORT} from it. The page you land on names
the address you arrived from and retries on its own, so putting that
address in the second file is all it takes to walk in.
`
);

console.log(`\nPortable build ready: ${out}`);
console.log('Zip that folder to distribute it.');
