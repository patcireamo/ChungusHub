<script module lang="ts">
	// The one platform check in the app. Every surface that names a shortcut reads from here:
	// the Settings row that stands in for this sheet, the welcome landing's kbd chips, the
	// title bar's tooltips.
	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
	export const MOD_KEY = isMac ? '⌘' : 'Ctrl';
	const ALT_KEY = isMac ? '⌥' : 'Alt';

	/** The one spelling of a modified shortcut: modifier, a space, the key. Never
	 *  glued with "+". macOS writes ⌘K, never ⌘+K, and a separator that is wrong
	 *  on one platform is worse than a space that is right on both. Callers that
	 *  render a shortcut TABLE (this sheet) put each key in its own kbd chip
	 *  instead; this helper is for shortcuts named inside a sentence or a chip. */
	export function shortcutLabel(key: string): string {
		return `${MOD_KEY} ${key}`;
	}
</script>

<script lang="ts">
	/**
	 * The keys, drawn from the one list that declares them.
	 *
	 * Nothing about a shortcut is written here: the rows, their order, their labels and the
	 * combination each one answers to all come from `commands/shortcuts.svelte.ts`, so a key
	 * cannot be documented as one thing and bound as another. What this file owns is the
	 * platform's spelling of a modifier and the drawing.
	 */
	import Dialog from './Dialog.svelte';
	import {
		SHORTCUTS,
		SHORTCUT_GROUPS,
		shortcutsSheet,
		type ShortcutDef
	} from '$lib/commands/shortcuts.svelte';

	/** Keys that read as something other than their own name. */
	const KEY_NAMES: Record<string, string> = {
		arrowup: '↑',
		arrowdown: '↓',
		arrowleft: '←',
		arrowright: '→',
		escape: 'Esc'
	};

	function chipsFor(shortcut: ShortcutDef): string[] {
		const binding = shortcut.binding;
		if (binding) {
			const chips: string[] = [];
			if (binding.mod) chips.push(MOD_KEY);
			if (binding.shift) chips.push('Shift');
			if (binding.alt) chips.push(ALT_KEY);
			// One chip per key: a row answering to four of them is one action pointed four ways,
			// and four rows saying nearly the same thing would bury the ones that differ. A row
			// bound by POSITION draws the letter that sits there (`KeyW` reads as W), since a
			// reader looks at their keyboard and not at a code.
			const spellings = binding.key ?? binding.code;
			if (spellings === undefined) {
				throw new Error(`shortcut "${shortcut.id}" binds neither a key nor a code`);
			}
			for (const spelling of Array.isArray(spellings) ? spellings : [spellings]) {
				const key = spelling.startsWith('Key') ? spelling.slice(3) : spelling;
				chips.push(KEY_NAMES[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key));
			}
			return chips;
		}
		// A documentation row cannot spell the modifier itself: MOD_KEY lives here, and the
		// registry importing it would close a cycle. It writes 'mod' and this resolves it.
		if (shortcut.chips) return shortcut.chips.map((chip) => (chip === 'mod' ? MOD_KEY : chip));
		// Fail loud: a row saying neither what to press nor what it binds is a labelled blank,
		// and a sheet that quietly drew one would be worse than no sheet at all.
		throw new Error(`shortcut "${shortcut.id}" declares neither a binding nor chips`);
	}

	const groups = SHORTCUT_GROUPS.map((group) => ({
		...group,
		rows: SHORTCUTS.filter((shortcut) => shortcut.group === group.id)
	})).filter((group) => group.rows.length > 0);
</script>

<Dialog
	open={shortcutsSheet.open}
	onClose={() => shortcutsSheet.close()}
	title="Keyboard shortcuts"
	size="md"
>
	<div class="sheet">
		{#each groups as group (group.id)}
			<section class="group">
				<h3 class="group-title">{group.label}</h3>
				{#each group.rows as row (row.id)}
					<div class="row">
						<span class="row-label">{row.label}</span>
						<span class="row-keys">
							{#each chipsFor(row) as key, i (i)}
								<kbd class="key">{key}</kbd>
							{/each}
						</span>
					</div>
				{/each}
			</section>
		{/each}
	</div>
</Dialog>

<style>
	.sheet {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.group-title {
		margin: 0 0 0.3rem;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-text-muted);
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.28rem 0;
	}

	.row-label {
		font-family: var(--font-ui);
		font-size: 0.82rem;
		color: var(--color-text-secondary);
	}

	.row-keys {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.key {
		min-width: 1.5rem;
		padding: 0.1rem 0.4rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
		font-family: var(--font-ui);
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-primary);
		text-align: center;
	}
</style>
