/**
 * Client image service.
 *
 * Thumbnails are still generated in the browser (canvas), but originals and
 * thumbnails are now uploaded to and served from the server so every device
 * shares the same character art. Same public API as before.
 */
import { apiGet, apiSend, apiUpload, fileUrl, getClientId } from '$lib/services/transport';

/** Which entity an image belongs to. Decides its images/<category>/ folder server-side. */
export type ImageCategory =
	| 'characters'
	| 'personas'
	| 'backgrounds'
	| 'chat'
	| 'presets'
	| 'lorebooks';

const THUMBNAIL_MAX_SIZE = 800;
/** Thumbnails are webp, always, and that is a different decision from the stored format
 *  below: a thumbnail is only ever drawn by this app's own tab, while a stored file is what
 *  a model receives. webp is the one format here that keeps an alpha channel at a
 *  photograph's weight, and a thumbnail that drops alpha does not shrink a cut-out, it
 *  fills the removed background back in with black. */
const THUMBNAIL_TYPE = 'image/webp';
const THUMBNAIL_EXTENSION = '.webp';
const THUMBNAIL_QUALITY = 0.85;

/** Stored art is png: one format, so nothing downstream has to ask what it got. webp is
 *  the format that actually breaks things. Local llama.cpp servers cannot decode it and
 *  reject the whole request. */
const STORED_IMAGE_EXTENSION = '.png';
/** png is lossless, so a photograph re-encoded as one lands far over MAX_STORED_BYTES at
 *  any resolution a model can still read. jpeg decodes everywhere png does, so a picture
 *  that misses the budget changes format instead of being shrunk until png fits. */
const FALLBACK_IMAGE_EXTENSION = '.jpg';
const FALLBACK_IMAGE_QUALITY = 0.9;
/** Backgrounds only ever reach the app itself, so they keep their original bytes: a 4K
 *  wallpaper as png costs megabytes for nothing. */
const NORMALIZED_CATEGORIES = new Set<ImageCategory>(['characters', 'personas', 'chat']);

/** The three budgets below are the single gate on what a model-facing image may weigh:
 *  chat and assistant attachments, portraits and gallery art all pass through it, so no
 *  upload surface carries a size rule of its own.
 *
 *  Refused before decoding: past this a file is one the browser would spend seconds on
 *  before we shrank it away anyway. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Long-edge cap for stored art. Providers scale larger images down on their side
 *  (Anthropic past ~1568px, OpenAI past 2048px), so pixels above this are uploaded,
 *  paid for and then discarded upstream. */
const MAX_IMAGE_EDGE = 2048;
/** Per-image budget for the stored file, which is what gets base64'd into a request.
 *  Providers refuse a request carrying an image past ~5MB, and base64 inflates it by a
 *  third, so the file on disk has to clear that with room to spare. */
const MAX_STORED_BYTES = 3.5 * 1024 * 1024;

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whether a dropped/pasted file is a picture at all. A paste handler asks this to decide
 *  whether the event is even its business; whether the picture is *acceptable* is the
 *  separate question below. */
export function isImageFile(file: Blob): boolean {
	return file.type.startsWith('image/');
}

/**
 * The single gate on what may become model-facing art, and the single wording for
 * refusing one. Returns the reason a file cannot be stored, or null when it passes.
 *
 * Every upload surface calls this so a pick is refused before any spinner starts, and
 * `toStoredFormat` asks it again at the door: a surface that forgets still cannot get a
 * bad file through, and none of them carries a size or format rule of its own.
 */
export function imageRejectionReason(file: Blob): string | null {
	const named = file instanceof File && file.name ? `"${file.name}"` : null;
	if (!isImageFile(file)) return `${named ?? 'This file'} is not an image file.`;
	// An SVG is a document, not pixels: stored under a category that keeps original bytes it
	// would be served back as image/svg+xml, a page that runs on this app's own origin.
	if (file.type === 'image/svg+xml') {
		return `${named ?? 'This file'} is an SVG. Use a png, jpg or webp instead.`;
	}
	if (file.size > MAX_SOURCE_BYTES) {
		return `${named ?? 'This image'} is ${megabytes(file.size)}; the limit is ${megabytes(MAX_SOURCE_BYTES)}.`;
	}
	return null;
}

/** Largest size fitting inside a square box without distorting the picture, never upscaling. */
function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
	const scale = Math.min(1, max / Math.max(width, height));
	return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function renderScaled(bitmap: ImageBitmap, width: number, height: number): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Failed to get 2d canvas context');
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(bitmap, 0, 0, width, height);
	return canvas;
}

/** Whether any pixel is less than fully opaque: the one question that decides whether the
 *  jpeg fallback is a size tradeoff or a silent undo of a cutout. */
function hasTransparency(canvas: HTMLCanvasElement): boolean {
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('Failed to get 2d canvas context');
	const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
	for (let i = 3; i < data.length; i += 4) {
		if (data[i] < 255) return true;
	}
	return false;
}

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error(`Failed to encode this image as ${type}`))),
			type,
			quality
		);
	});
}

class ImageService {
	async initialize(): Promise<void> {
		// Storage lives on the server; nothing to set up on the client.
	}

	async saveImage(file: File, category: ImageCategory = 'characters'): Promise<string> {
		const { blob, ext } = await this.toStoredFormat(file, this.getFileExtension(file.name), category);
		let thumb: Blob | null = null;
		try {
			thumb = await this.makeThumbnail(blob);
		} catch (error) {
			// Non-fatal here: the upload goes ahead without one and the server answers
			// thumbnail requests for it with the original (server/files.ts,
			// `resolveImageFile`). The rebuild below is what puts it right afterwards.
			console.error('Failed to generate thumbnail:', error);
		}
		return this.upload(blob, thumb, ext, category, file.name);
	}

	/** Every stored picture, by the path its row names. The one reader is the thumbnail
	 *  rebuild in Settings › Advanced. */
	async listStoredImages(): Promise<string[]> {
		const data = (await apiGet('/api/images')) as { paths: string[] };
		return data.paths;
	}

	/**
	 * Re-encode one stored picture's thumbnail from the original and store it, replacing
	 * whatever stood there. The browser holds the app's only image encoder, so a thumbnail
	 * written by anything other than this tab does not exist.
	 *
	 * Throws on anything that stops it, unlike the upload path above: this runs from a
	 * control that counts what it did, and a picture silently skipped there would leave the
	 * reader with a finished number covering less than it says.
	 */
	async rebuildThumbnail(relativePath: string): Promise<void> {
		const response = await fetch(fileUrl(relativePath));
		if (!response.ok) {
			throw new Error(`Could not read ${relativePath} (HTTP ${response.status})`);
		}
		const thumb = await this.makeThumbnail(await response.blob());
		const form = new FormData();
		form.append('path', relativePath);
		form.append('thumb', thumb);
		await apiUpload('/api/images/thumbnail', form);
	}

	/** Copy a stored picture. The copy lands in the source's own folder unless a category
	 *  names another one, which is what a picture changing owner needs: character and
	 *  persona art live in separate folders. */
	async copyImage(relativePath: string, category?: ImageCategory): Promise<string | null> {
		if (!relativePath) return null;
		const data = (await apiSend('/api/images/copy', 'POST', { path: relativePath, category })) as {
			path: string | null;
		};
		return data.path;
	}

	async deleteImage(relativePath: string): Promise<void> {
		if (!relativePath) return;
		await apiSend('/api/images/delete', 'POST', { path: relativePath });
	}

	async getImageUrl(relativePath: string): Promise<string | null> {
		if (!relativePath) return null;
		return fileUrl(relativePath);
	}

	async getThumbnailUrl(relativePath: string): Promise<string | null> {
		if (!relativePath) return null;
		return fileUrl(this.getThumbnailPath(relativePath));
	}

	/** Synchronous thumbnail URL: the path is derived, no I/O. Handy in reactive lists. */
	thumbnailUrl(relativePath: string | undefined): string | null {
		if (!relativePath) return null;
		return fileUrl(this.getThumbnailPath(relativePath));
	}

	/** Synchronous full-size URL, the pair to `thumbnailUrl`. For the surfaces that draw a
	 *  picture large enough that a thumbnail would be the wrong file (the chat's sprite). */
	imageUrl(relativePath: string | undefined): string | null {
		if (!relativePath) return null;
		return fileUrl(relativePath);
	}

	// Kept for API compatibility; URLs are derived directly now, so there is no cache.
	invalidateCache(_relativePath: string): void {}

	private async upload(
		original: Blob,
		thumb: Blob | null,
		ext: string,
		category: ImageCategory,
		originalName?: string
	): Promise<string> {
		const form = new FormData();
		form.append('file', original);
		if (thumb) form.append('thumb', thumb);
		form.append('ext', ext);
		form.append('category', category);
		// Backgrounds keep their human-readable filename server-side; other
		// categories ignore this and get a UUID.
		if (originalName) form.append('name', originalName);
		// Identify the origin so the server's 'library' sync broadcast skips us. Without
		// this we trigger our own refresh() mid-import and it races the optimistic entry
		// add, wiping the freshly imported character until a page reload.
		form.append('clientId', getClientId());
		const data = (await apiUpload('/api/images', form)) as { path: string };
		return data.path;
	}

	// Thumbnails sit in a thumbnails/ subfolder next to the original, so the category in
	// the stored path (images/<category>/<file>) carries through to its thumbnail. The
	// extension is fixed (every thumbnail is webp), which is what keeps this a derivation
	// rather than a lookup; server/files.ts spells the same convention.
	private getThumbnailPath(originalPath: string): string {
		const idx = originalPath.lastIndexOf('/');
		const dir = originalPath.slice(0, idx); // images/<category>
		const nameWithoutExt = originalPath.slice(idx + 1).replace(/\.[^.]+$/, '');
		return `${dir}/thumbnails/${nameWithoutExt}${THUMBNAIL_EXTENSION}`;
	}

	/**
	 * Normalize an image for the categories whose files reach a model: cap its resolution,
	 * re-encode it as png, and fall back to jpeg when png misses the per-image budget.
	 * Decoding is the browser's, so a format it cannot read fails here instead of on disk
	 * at request time.
	 */
	private async toStoredFormat(
		source: Blob,
		ext: string,
		category: ImageCategory
	): Promise<{ blob: Blob; ext: string }> {
		if (!NORMALIZED_CATEGORIES.has(category)) return { blob: source, ext };
		const refused = imageRejectionReason(source);
		if (refused) throw new Error(refused);

		const bitmap = await createImageBitmap(source);
		const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_IMAGE_EDGE);
		// Already png, already inside both budgets: keep the original bytes. Sending a
		// palette png back through the canvas would re-emit it as 32-bit RGBA, several
		// times its own size, for no gain.
		if (
			ext === STORED_IMAGE_EXTENSION &&
			width === bitmap.width &&
			height === bitmap.height &&
			source.size <= MAX_STORED_BYTES
		) {
			bitmap.close();
			return { blob: source, ext };
		}

		let canvas = renderScaled(bitmap, width, height);
		bitmap.close();
		const png = await encodeCanvas(canvas, 'image/png');
		if (png.size <= MAX_STORED_BYTES) return { blob: png, ext: STORED_IMAGE_EXTENSION };

		// A picture carrying transparency may NOT take the jpeg road: jpeg has no alpha, so
		// the fallback would not degrade the image, it would fill the cut-out area back in
		// with black and hand back the very background the user removed. Shrink until png
		// fits instead: losing pixels is recoverable, losing the cutout is not.
		if (hasTransparency(canvas)) {
			for (let edge = Math.max(canvas.width, canvas.height); edge > 256; ) {
				edge = Math.floor(edge * 0.75);
				const smaller = fitWithin(canvas.width, canvas.height, edge);
				canvas = renderScaled(await createImageBitmap(canvas), smaller.width, smaller.height);
				const retry = await encodeCanvas(canvas, 'image/png');
				if (retry.size <= MAX_STORED_BYTES) return { blob: retry, ext: STORED_IMAGE_EXTENSION };
			}
			throw new Error(
				`This transparent image will not fit in ${megabytes(MAX_STORED_BYTES)} as a png, and converting it would fill the transparency back in.`
			);
		}

		return {
			blob: await encodeCanvas(canvas, 'image/jpeg', FALLBACK_IMAGE_QUALITY),
			ext: FALLBACK_IMAGE_EXTENSION
		};
	}

	/** Throws rather than answering null: each caller decides what a picture without a
	 *  thumbnail costs it, and neither can decide it without the reason. */
	private async makeThumbnail(source: Blob): Promise<Blob> {
		const bitmap = await createImageBitmap(source);
		const { width, height } = fitWithin(bitmap.width, bitmap.height, THUMBNAIL_MAX_SIZE);
		const canvas = renderScaled(bitmap, width, height);
		bitmap.close();
		const thumb = await encodeCanvas(canvas, THUMBNAIL_TYPE, THUMBNAIL_QUALITY);
		// A canvas that cannot encode the format asked for silently answers in png instead,
		// which would put png bytes under a .webp name for every upload from that browser.
		// Say so rather than store the mismatch.
		if (thumb.type !== THUMBNAIL_TYPE) {
			throw new Error(`This browser encoded a ${thumb.type || 'unknown'} thumbnail`);
		}
		return thumb;
	}

	private getFileExtension(filename: string): string {
		const lastDot = filename.lastIndexOf('.');
		if (lastDot === -1) return '.png';
		return filename.slice(lastDot).toLowerCase();
	}
}

export const imageService = new ImageService();
