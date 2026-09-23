/**
 * 16-bit PCM WAV: nothing left to decode, and no encoder padding at either end, so a media
 * element looping one wraps on the exact sample the loop was cut at.
 */

const HEADER_BYTES = 44;

function writeTag(view: DataView, offset: number, tag: string): void {
	for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

/** Samples are clamped to [-1, 1] and rounded to the nearest step; NaN becomes silence. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
	const channelCount = channels.length;
	const frames = channels[0]?.length ?? 0;
	if (channels.some((data) => data.length !== frames)) {
		throw new Error('Every channel of a WAV has to be the same length');
	}
	const blockAlign = channelCount * 2;
	const dataBytes = frames * blockAlign;
	const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
	const view = new DataView(buffer);
	writeTag(view, 0, 'RIFF');
	view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
	writeTag(view, 8, 'WAVE');
	writeTag(view, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channelCount, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * blockAlign, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, 16, true);
	writeTag(view, 36, 'data');
	view.setUint32(40, dataBytes, true);

	// Platform byte order, which is little-endian (what WAV asks for) on every device a browser
	// runs on. A DataView writes the same bytes three and a half times slower.
	const samples = new Int16Array(buffer, HEADER_BYTES);
	for (let ch = 0; ch < channelCount; ch++) {
		const data = channels[ch];
		for (let i = 0, j = ch; i < frames; i++, j += channelCount) {
			const s = data[i];
			samples[j] = Math.round((s > 1 ? 1 : s < -1 ? -1 : s) * 32767);
		}
	}
	return buffer;
}
