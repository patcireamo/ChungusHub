/**
 * Every address in the app that leaves it, in one place.
 *
 * Two surfaces name the same community (the welcome landing and Settings → About) and the
 * bug report is built out of the repo address, so an invite that moves has one place to move
 * in. Nothing here is fetched: these are doors a reader opens, and every call site opens them
 * in a new tab, since the workspace is a live session with unsaved drafts in it.
 */
export const LINKS = {
	docs: 'https://chungushub.mintlify.app/',
	repo: 'https://github.com/patcireamo/ChungusHub',
	license: 'https://github.com/patcireamo/ChungusHub/blob/main/LICENSE',
	/** The two addresses here that never leave the machine: the bundled typefaces' own notice
	 *  and the bundled sounds' credits, each shipping in `static/` and served beside the files
	 *  it covers. A license the app hands the reader has to be readable from an install with no
	 *  internet at all. Both are `.txt` because the server hands any other extension over as a
	 *  download rather than a page. */
	fontLicense: '/fonts/OFL.txt',
	soundCredits: '/sounds/CREDITS.txt',
	discord: 'https://discord.gg/nkm9pe5a9C',
	/** The author's own handle, and the one entry here that is copied rather than opened:
	 *  Discord has no address that reliably resolves a person from their name. It is what a
	 *  reader with no GitHub account is left with, so it is stated where they will look. */
	discordHandle: 'patcireamo'
} as const;

/**
 * A new issue with the report already shaped and the reader's build already in it. What
 * decides whether a report can be acted on is which version, which build and which browser
 * it came from, and those are exactly the three lines nobody thinks to include.
 */
export function newIssueUrl(environment: string): string {
	const body = `**What happened**\n\n\n**What you expected**\n\n\n**Steps to reproduce**\n\n\n---\n${environment}\n`;
	return `${LINKS.repo}/issues/new?body=${encodeURIComponent(body)}`;
}
