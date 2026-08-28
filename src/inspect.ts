import { readMetadata } from './engine/sharp.js';
import { fail } from './errors.js';
import { FORMAT_MIME, type MediaLimits } from './limits.js';
import type { MediaFormat, MediaInput, MediaSource } from './types.js';

/**
 * Format detection and structural validation.
 *
 * Detection reads magic bytes rather than trusting a filename or a
 * client-supplied MIME, because both are attacker-controlled.
 */

/** Bytes needed to identify every supported container. */
const MIN_SNIFF_BYTES = 16;

/**
 * Identifies the container from its signature.
 *
 * Returns `null` for anything unrecognised, and `'avif-sequence'` for animated
 * AVIF, which is detectable here and rejected later with an accurate code
 * rather than a misleading "unsupported format".
 */
function sniffFormat(bytes: Uint8Array): MediaFormat | 'avif-sequence' | null {
	if (bytes.length < MIN_SNIFF_BYTES) return null;

	// JPEG: SOI marker.
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';

	// PNG: 8-byte signature.
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

	// WebP: RIFF container with a WEBP form type.
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

	// AVIF: ISO-BMFF `ftyp` box; the brand distinguishes still from sequence.
	if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
		const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
		if (brand === 'avif') return 'avif';
		if (brand === 'avis') return 'avif-sequence';
	}

	return null;
}

/** MIME spellings accepted for each format, including common legacy aliases. */
const MIME_ALIASES: Readonly<Record<MediaFormat, readonly string[]>> = Object.freeze({
	jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
	png: ['image/png', 'image/apng', 'image/x-png'],
	webp: ['image/webp'],
	avif: ['image/avif']
});

/**
 * libvips container ids that legitimately back each detected format.
 *
 * AVIF arrives as `'heif'` because libvips reports the HEIF family rather than
 * the specific brand; the byte signature remains authoritative.
 */
const EXPECTED_CONTAINERS: Readonly<Record<MediaFormat, readonly string[]>> = Object.freeze({
	jpeg: ['jpeg'],
	png: ['png'],
	webp: ['webp'],
	avif: ['heif', 'avif']
});

/** Verifies a client-declared MIME against the detected format. */
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

/** Public facts plus the internal hints the processor needs, from one read. */
export interface InspectedSource {
	readonly source: MediaSource;
	/** Source carries an ICC profile, so outputs need a gamut transform. */
	readonly hasIccProfile: boolean;
	/**
	 * Source carries metadata that processing is required to remove.
	 *
	 * When true, returning the original bytes unchanged would republish EXIF or a
	 * colour profile, so re-encoding is mandatory.
	 */
	readonly hasStrippableMetadata: boolean;
	/**
	 * Source holds per-pixel colour detail worth encoding at full chroma
	 * resolution: any lossless container, or a JPEG already stored at 4:4:4.
	 */
	readonly fullChroma: boolean;
}

/**
 * Validates untrusted bytes and returns authoritative facts about them.
 *
 * Checks run cheapest-first so hostile input is rejected before it can cost
 * anything: byte length, then signature, then header metadata.
 */
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

	// A signature can be forged onto a different payload; the decoder's view must
	// agree with it before we trust either.
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
