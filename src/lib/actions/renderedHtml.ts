/**
 * Svelte action: mount rendered HTML into an element and keep every node that did not
 * change.
 *
 * Usage: <div class="prose" use:renderedHtml={html}></div>
 *
 * The transcript paints model output as a string of HTML, and `{@html}` applies one by
 * throwing the whole subtree away and building a fresh one. That is invisible for a settled
 * turn and ruinous for a streaming one, because a reply arrives dozens of times a second
 * and everything the reader is doing inside that subtree lives on the nodes it destroys:
 *
 *   - A folding panel loses the `open` the reader just clicked, so it snaps shut a frame later.
 *   - Worse, the click usually never lands at all. A click fires on the common ancestor of
 *     where the press went down and where it came up, so a panel replaced between the two
 *     hands the event to the container instead and the panel never hears it.
 *   - A text selection collapses the moment the next chunk arrives.
 *
 * So the new HTML is parsed into an inert `<template>` and reconciled against what is on
 * screen: matching nodes are kept and patched, the rest is replaced. Streaming is
 * append-only in practice, which is the case this is best at: the tail grows and
 * everything above it is left alone, still holding its state and still able to take a click.
 *
 * The HTML is trusted to be sanitized already (`utils/markdown.ts` is the only source);
 * nothing here relaxes that, and `<template>` is inert, so nothing in the string can run
 * while it is being parsed.
 *
 * Every code block gets a copy button on the way through (`utils/code-blocks.ts`). It is
 * added to the parsed copy before the reconcile, so the button is part of what is compared
 * and survives a patch like any other node.
 */
import { decorateCodeBlocks, handleCodeCopyClick } from '$lib/utils/code-blocks';

/** One parser for the app, made on first use. Reused rather than created per patch, and
 *  emptied after each one so a discarded subtree isn't held alive by it. Lazy because a
 *  module-level `document` would run at import time, and this module has no business
 *  deciding whether it is being imported somewhere without one. */
let parser: HTMLTemplateElement | null = null;

function patchAttributes(target: Element, source: Element): void {
	// `open` on a panel belongs to the reader, not to the text: a panel that survives a
	// patch keeps whatever they set, while one that arrives fresh is built from the source
	// node and so still honours whatever the reply asked for.
	const readerOwns = target.tagName === 'DETAILS' ? 'open' : null;

	for (const attr of source.attributes) {
		if (attr.name === readerOwns) continue;
		if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
	}
	// Iterated over a copy: removing an attribute mutates the live NamedNodeMap underneath.
	for (const attr of [...target.attributes]) {
		if (attr.name === readerOwns) continue;
		if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
	}
}

/**
 * Reconcile `target`'s children against `source`'s, by position.
 *
 * Positional rather than keyed, because there are no keys to be had: this is rendered
 * markdown, and its only stable identity IS position. It is the right match for the way
 * the input actually changes: a reply grows at its end, so the nodes before that end
 * line up and survive.
 */
function patchChildren(target: Node, source: Node): void {
	let mine = target.firstChild;
	let theirs = source.firstChild;

	while (mine && theirs) {
		const nextMine = mine.nextSibling;
		const nextTheirs = theirs.nextSibling;

		if (mine.nodeType !== theirs.nodeType || mine.nodeName !== theirs.nodeName) {
			// Different kind of node here now: take theirs whole (this moves it out of the
			// template, which is why the next sibling was read first).
			target.replaceChild(theirs, mine);
		} else if (mine.nodeType === Node.TEXT_NODE || mine.nodeType === Node.COMMENT_NODE) {
			if (mine.nodeValue !== theirs.nodeValue) mine.nodeValue = theirs.nodeValue;
		} else {
			patchAttributes(mine as Element, theirs as Element);
			patchChildren(mine, theirs);
		}

		mine = nextMine;
		theirs = nextTheirs;
	}

	while (mine) {
		const next = mine.nextSibling;
		target.removeChild(mine);
		mine = next;
	}
	while (theirs) {
		const next = theirs.nextSibling;
		target.appendChild(theirs);
		theirs = next;
	}
}

function patch(node: HTMLElement, html: string): void {
	parser ??= document.createElement('template');
	parser.innerHTML = html;
	decorateCodeBlocks(parser.content);
	patchChildren(node, parser.content);
	parser.innerHTML = '';
}

export function renderedHtml(node: HTMLElement, html: string) {
	patch(node, html);
	// Delegated rather than bound per button: a patch can replace a block's button, and a
	// listener on the container never has to be re-attached for it.
	node.addEventListener('click', handleCodeCopyClick);
	return {
		update(next: string) {
			patch(node, next);
		},
		destroy() {
			node.removeEventListener('click', handleCodeCopyClick);
		}
	};
}
