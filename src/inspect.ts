import { readMetadata } from './engine/sharp.js';
import { fail } from './errors.js';
import { FORMAT_MIME, type MediaLimits } from './limits.js';
import type { MediaFormat, MediaInput, MediaSource } from './types.js';

const MIN_SNIFF_BYTES = 16;

function sniffFormat(bytes: Uint8Array): MediaFormat | 'avif-sequence' | null {
	if (bytes.length < MIN_SNIFF_BYTES) return null;

	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';

	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return 'png';
	}

	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return 'webp';
	}

	if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
		const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
		if (brand === 'avif') return 'avif';
		if (brand === 'avis') return 'avif-sequence';
	}

	return null;
}

const MIME_ALIASES: Readonly<Record<MediaFormat, readonly string[]>> = Object.freeze({
	jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
	png: ['image/png', 'image/apng', 'image/x-png'],
	webp: ['image/webp'],
	avif: ['image/avif']
});

/** libvips reports AVIF through the HEIF family; the byte signature stays authoritative. */
const EXPECTED_CONTAINERS: Readonly<Record<MediaFormat, readonly string[]>> = Object.freeze({
	jpeg: ['jpeg'],
	png: ['png'],
	webp: ['webp'],
	avif: ['heif', 'avif']
});

function verifyDeclaredMime(declaredMime: string, detected: MediaFormat): void {
	const normalized = declaredMime.trim().toLowerCase().split(';')[0]?.trim() ?? '';
	if (normalized.length === 0) return;
	if (!MIME_ALIASES[detected].includes(normalized)) {
		fail('mime_mismatch', 'Declared media type does not match the image contents', {
			declared: normalized,
			detected: FORMAT_MIME[detected]
		});
	}
}

export interface InspectedSource {
	readonly source: MediaSource;
	readonly hasIccProfile: boolean;
	/** Prevents source-byte passthrough when metadata must be stripped. */
	readonly hasStrippableMetadata: boolean;
	/** Lossless or already-4:4:4 source chroma worth preserving in JPEG output. */
	readonly fullChroma: boolean;
}

/** Validates untrusted bytes cheapest-first and returns authoritative source facts. */
export async function inspectSource(
	input: MediaInput,
	limits: MediaLimits,
	declaredMime?: string
): Promise<InspectedSource> {
	if (!(input instanceof Uint8Array)) {
		fail('invalid_image', 'Input must be a Uint8Array');
	}
	if (input.byteLength === 0) {
		fail('invalid_image', 'Input is empty');
	}
	if (input.byteLength > limits.maxInputBytes) {
		fail('input_too_large', 'Encoded input exceeds the maximum allowed size', {
			byteLength: input.byteLength,
			limit: limits.maxInputBytes
		});
	}

	const sniffed = sniffFormat(input);
	if (sniffed === null) {
		fail('unsupported_format', 'Image format is not supported');
	}
	if (sniffed === 'avif-sequence') {
		fail('multi_page_not_supported', 'Animated images are not supported');
	}
	if (declaredMime !== undefined) {
		verifyDeclaredMime(declaredMime, sniffed);
	}

	const meta = await readMetadata(input);

	// A forged signature must still agree with the decoder's container view.
	if (!EXPECTED_CONTAINERS[sniffed].includes(meta.container)) {
		fail('invalid_image', 'Image contents do not match the container signature');
	}
	if (meta.pages > 1) {
		fail('multi_page_not_supported', 'Animated or multi-page images are not supported', {
			pages: meta.pages
		});
	}
	if (meta.channels > limits.maxChannels) {
		fail('channel_limit_exceeded', 'Image has too many channels', {
			channels: meta.channels,
			limit: limits.maxChannels
		});
	}

	const pixels = meta.width * meta.height;
	if (pixels > limits.maxPixels) {
		fail('pixel_limit_exceeded', 'Image resolution exceeds the maximum allowed', {
			pixels,
			limit: limits.maxPixels,
			width: meta.width,
			height: meta.height
		});
	}

	return {
		source: Object.freeze({
			format: sniffed,
			mime: FORMAT_MIME[sniffed],
			byteLength: input.byteLength,
			width: meta.width,
			height: meta.height,
			orientedWidth: meta.orientedWidth,
			orientedHeight: meta.orientedHeight,
			orientation: meta.orientation,
			channels: meta.channels,
			hasAlpha: meta.hasAlpha
		}),
		hasIccProfile: meta.hasIccProfile,
		hasStrippableMetadata: meta.hasExif || meta.hasIccProfile,
		fullChroma: meta.chromaSubsampling === '' || meta.chromaSubsampling === '4:4:4'
	};
}
