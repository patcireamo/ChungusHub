/**
 * Shared export substrate: the ChungusHub-native round-trip shape plus the generic browser
 * download/image helpers the SillyTavern exporter and importer both build on.
 *
 * The actual export format is a SillyTavern V2 card (see `sillyTavernExport.ts`), which carries
 * `ExportedLibraryEntry` inside `data.extensions.chungushub`. The same shape also describes our
 * legacy top-level JSON export, so the importer round-trips both.
 *
 * The canvas helpers below are shared with the preset card writer: any card that ships as a
 * picture needs the same "make sure these bytes are a PNG" step, and a second copy of it is
 * a second place for a file to come out unreadable.
 */

import type { LibraryEntry } from '$lib/types/library';
import { imageService } from '$lib/services/imageService';

/** A character version as it travels in an export: content + name, ids kept only to
 *  mark which one was active (importers mint fresh ids). */
export interface ExportedCharacterVersion {
	id: string;
	name: string;
	data: LibraryEntry['data'];
	createdAt: number;
	updatedAt: number;
}

/** ChungusHub-native fidelity block. Carried inside a SillyTavern card's
 *  `data.extensions.chungushub`, and the shape of our legacy top-level JSON export.
 *  Versioned so an importer can branch later. v2 added character versions; v1 files
 *  (no `versions`) import unchanged. */
export interface ExportedLibraryEntry {
	format: 'chungushub.libraryEntry';
	version: 2;
	type: LibraryEntry['type'];
	identity: {
		name: string;
		tags: string[];
	};
	/** The active variant's content: what a version-unaware reader should use. */
	data: LibraryEntry['data'];
	/** Every variant of a versioned character, in creation order. Absent when unversioned. */
	versions?: ExportedCharacterVersion[];
	/** Which of `versions` the entry was on. Absent when unversioned. */
	activeVersionId?: string;
	/** Portrait inlined as a data URL, present only in legacy top-level JSON exports (which the
	 *  importer still reads). Cards omit it; their own art carries the portrait. */
	image?: string | null;
	exportedAt: string;
}

/** Fetch a stored image as a Blob (its `.type` carries the mime), or null when absent. */
export async function fetchImageBlob(imagePath?: string): Promise<Blob | null> {
	if (!imagePath) return null;
	const url = await imageService.getImageUrl(imagePath);
	if (!url) return null;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);
	return response.blob();
}

/** Turn a name into a safe download filename: strips filesystem-hostile characters but keeps
 *  spaces (collapsed) so it reads like the name, e.g. "Unnamed Character.png". */
export function sanitizeFilename(name: string): string {
	const cleaned = name.trim().replace(/[^a-z0-9\-_ ]/gi, '').replace(/\s+/g, ' ');
	return cleaned || 'entry';
}

/** Re-encode any image the browser can decode as PNG, at its original size. A format it
 *  cannot read fails here rather than producing a card no reader can open. */
export async function reencodeToPng(blob: Blob): Promise<Uint8Array> {
	const bitmap = await createImageBitmap(blob);
	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas 2D context unavailable');
	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();
	return canvasToPng(canvas);
}

/**
 * Redraw an image at a fixed size, filling the frame and centre-cropping whatever spills.
 * This is the same fit CSS calls `object-fit: cover`, so a picture lands in a card exactly
 * as it sits in the app. Nothing is stretched: the shorter side decides the scale.
 */
export async function cropToPng(blob: Blob, width: number, height: number): Promise<Uint8Array> {
	const bitmap = await createImageBitmap(blob);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas 2D context unavailable');
	const scale = Math.max(width / bitmap.width, height / bitmap.height);
	const drawWidth = bitmap.width * scale;
	const drawHeight = bitmap.height * scale;
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
	bitmap.close();
	return canvasToPng(canvas);
}

/** A plain panel with one initial on it, for a card whose subject has no art. Colors are
 *  baked rather than read from CSS variables: the file leaves this app's theming behind. */
export async function makePlaceholderPng(name: string, width = 512, height = width): Promise<Uint8Array> {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas 2D context unavailable');
	ctx.fillStyle = '#2a2a33';
	ctx.fillRect(0, 0, width, height);
	const initial = (name.trim()[0] ?? '?').toUpperCase();
	ctx.fillStyle = '#8a8a99';
	// Scale off the shorter side so the letter never overflows a tall or wide frame.
	ctx.font = `600 ${Math.round(Math.min(width, height) * 0.43)}px sans-serif`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(initial, width / 2, height / 2);
	return canvasToPng(canvas);
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(async (blob) => {
			if (!blob) {
				reject(new Error('Failed to encode PNG'));
				return;
			}
			resolve(new Uint8Array(await blob.arrayBuffer()));
		}, 'image/png');
	});
}

/** Prompt a browser download of a blob under the given filename. The anchor is put in the
 *  page before the click and the url revoked after: a detached anchor plus an immediate
 *  revoke drops the download on a blob big enough to matter. */
export function triggerDownload(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}
