/**
 * Browser glue for lorebook files: download + file read. The actual format conversion lives
 * in `sillytavern.ts`; this only handles the Blob/anchor/FileReader plumbing so components stay
 * free of it. Export is SillyTavern native World Info (its "Import World Info" reads it).
 */
import type { Lorebook } from './types';
import { parseLorebook, toNativeWorldInfo } from './sillytavern';
import { createZip } from '$lib/services/zip';

function sanitizeFilename(name: string): string {
	// Strip only what filesystems reject (reserved punctuation + control chars) so
	// unicode names (ğ, ü, 龍, …) stay intact.
	// eslint-disable-next-line no-control-regex
	const cleaned = (name || '').replace(/[\\/:*?"<>|]|[\x00-\x1f]/g, '').trim();
	return cleaned || 'lorebook';
}

function save(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

function worldInfoBlob(book: Lorebook): Blob {
	return new Blob([JSON.stringify(toNativeWorldInfo(book), null, 2)], {
		type: 'application/json'
	});
}

/** Download a book as SillyTavern-compatible World Info JSON. */
export function downloadLorebook(book: Lorebook): void {
	save(`${sanitizeFilename(book.name)}.json`, worldInfoBlob(book));
}

/**
 * Download several books as one archive. A browser blocks a burst of downloads, so a
 * selection has to arrive as a single file; each book keeps its own World Info JSON
 * inside, which is what SillyTavern's importer and our own both read.
 *
 * Nothing dedupes book names, so two books called the same thing would land as one
 * entry and the archive would quietly hold fewer files than the reader selected.
 */
export function downloadLorebooks(books: Lorebook[]): void {
	if (books.length === 1) return downloadLorebook(books[0]);
	const encoder = new TextEncoder();
	const taken = new Map<string, number>();
	const entries = books.map((book) => {
		const base = sanitizeFilename(book.name);
		const seen = taken.get(base) ?? 0;
		taken.set(base, seen + 1);
		return {
			name: `${seen === 0 ? base : `${base}(${seen + 1})`}.json`,
			data: encoder.encode(JSON.stringify(toNativeWorldInfo(book), null, 2))
		};
	});
	save('lorebooks.zip', createZip(entries));
}

/** Read + parse a lorebook file into a fresh Lorebook. Throws (loudly) on bad JSON / format. */
export async function readLorebookFile(file: File): Promise<Lorebook> {
	const text = await file.text();
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`"${file.name}" is not valid JSON.`);
	}
	const fallbackName = file.name.replace(/\.[^.]+$/, '');
	return parseLorebook(raw, fallbackName);
}
