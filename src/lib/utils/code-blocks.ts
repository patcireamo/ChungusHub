/**
 * A copy button on every rendered code block.
 *
 * Added to the parsed HTML by `actions/renderedHtml.ts`, AFTER the sanitizer has run, and
 * never by the markdown renderer. The sanitizer allows no `button`, and widening it would
 * let any reply draw controls of its own; this way the only `button.code-copy` that can
 * exist in rendered prose is one put there by this module, so the click handler below can
 * trust what it finds.
 *
 * It is added to the parsed fragment before that action reconciles it against the screen,
 * not to the live DOM afterwards. The reconciler then sees the button in every version of
 * the HTML, at the same position, and keeps it: a reply still streaming its code block
 * keeps the same button rather than having one removed and re-added on every chunk.
 *
 * It behaves like a turn's own Copy button (MessageActions): a checkmark once the text has
 * actually reached the clipboard, and a toast when it has not.
 */
import { icons, type IconName } from '$lib/components/ui/Icon.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { copyText } from './clipboard';

const TITLE = 'Copy code';
const COPIED_TITLE = 'Copied!';

/** The markup `<Icon>` draws for a stroked icon, at the action bar's 1.75 stroke. */
function iconSvg(name: IconName, className: string): string {
	const paths = icons[name].paths
		.map(
			(d) => `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="${d}"/>`
		)
		.join('');
	return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

/** Wrap every `pre` under `root` in a `.code-block` holding a copy button. */
export function decorateCodeBlocks(root: ParentNode): void {
	for (const pre of root.querySelectorAll('pre')) {
		const doc = pre.ownerDocument;
		const wrapper = doc.createElement('div');
		wrapper.className = 'code-block';

		const button = doc.createElement('button');
		button.type = 'button';
		button.className = 'code-copy';
		button.title = TITLE;
		button.setAttribute('aria-label', TITLE);
		button.innerHTML = iconSvg('copy', 'code-copy-idle') + iconSvg('check', 'code-copy-done');

		pre.replaceWith(wrapper);
		wrapper.append(button, pre);
	}
}

/**
 * Click handler for a rendered prose container: copies the block whose button was pressed,
 * and ignores every other click.
 */
export async function handleCodeCopyClick(event: MouseEvent): Promise<void> {
	if (!(event.target instanceof Element)) return;
	const button = event.target.closest('button.code-copy');
	if (!(button instanceof HTMLButtonElement)) return;
	const pre = button.parentElement?.querySelector(':scope > pre');
	if (!pre) return;

	// A fenced block's text ends in the newline that closed the fence, which nobody
	// pasting the code wants.
	const text = (pre.textContent ?? '').replace(/\n$/, '');

	// The checkmark waits for the copy: claiming it over an empty clipboard sends the
	// user off to paste nothing.
	try {
		await copyText(text);
	} catch {
		toastStore.error('Copy failed. Select the text and copy it by hand.');
		return;
	}
	button.dataset.copied = '';
	button.title = COPIED_TITLE;
	setTimeout(() => {
		delete button.dataset.copied;
		button.title = TITLE;
	}, 1500);
}
