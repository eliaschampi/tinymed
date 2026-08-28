import sharp from 'sharp';
import type { MediaFormat } from '../src/types.js';

/**
 * Fixtures are generated rather than committed.
 *
 * Binary fixtures in a repository are opaque: a reviewer cannot see why an image
 * is 3000x2000 or which quadrant is red. Generating them keeps the intent in
 * code, keeps the package small, and lets a single helper produce the whole
 * orientation and geometry matrix.
 */

/** Distinct per-quadrant colours, so a wrong crop or flip is visible and assertable. */
export const QUADRANT = {
	topLeft: { r: 255, g: 0, b: 0 },
	topRight: { r: 0, g: 255, b: 0 },
	bottomLeft: { r: 0, g: 0, b: 255 },
	bottomRight: { r: 255, g: 255, b: 0 }
} as const;

export interface QuadrantOptions {
	readonly width: number;
	readonly height: number;
	readonly format?: MediaFormat;
	readonly quality?: number;
	/** EXIF orientation tag to record without transforming the pixels. */
	readonly orientation?: number;
	readonly alpha?: boolean;
}

/**
 * Builds an image split into four solid colour quadrants.
 *
 * Sampling a pixel then tells you exactly which region of the source survived a
 * crop, and whether orientation was applied in the right direction.
 */
export async function quadrantImage(options: QuadrantOptions): Promise<Buffer> {
	const { width, height, format = 'png', orientation, alpha = false } = options;
	const halfWidth = Math.floor(width / 2);
	const halfHeight = Math.floor(height / 2);
	const channels = alpha ? 4 : 3;
	const raw = Buffer.alloc(width * height * channels);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const colour =
				y < halfHeight
					? x < halfWidth
						? QUADRANT.topLeft
						: QUADRANT.topRight
					: x < halfWidth
						? QUADRANT.bottomLeft
						: QUADRANT.bottomRight;
			const offset = (y * width + x) * channels;
			raw[offset] = colour.r;
			raw[offset + 1] = colour.g;
			raw[offset + 2] = colour.b;
			if (alpha) {
				// Genuinely varying transparency. A uniformly opaque alpha channel
				// would be dropped by every encoder, so it would prove nothing about
				// alpha preservation.
				raw[offset + 3] = y < halfHeight ? 255 : x < halfWidth ? 128 : 0;
			}
		}
	}

	let pipeline = sharp(raw, { raw: { width, height, channels } });
	if (orientation !== undefined) pipeline = pipeline.withMetadata({ orientation });
	return encode(pipeline, format, options.quality);
}

/** A solid-colour image; used where only geometry or byte size matters. */
export async function solidImage(
	width: number,
	height: number,
	format: MediaFormat = 'jpeg',
	background: { r: number; g: number; b: number; alpha?: number } = { r: 40, g: 80, b: 160 }
): Promise<Buffer> {
	return encode(
		sharp({
			create: {
				width,
				height,
				channels: background.alpha === undefined ? 3 : 4,
				background
			}
		}),
		format
	);
}

/**
 * Photographic-looking noise, sized to a target pixel count.
 *
 * Solid colours compress to almost nothing, which would make byte-size and
 * throughput assertions meaningless. Noise keeps encoded size realistic.
 */
export async function noiseImage(
	width: number,
	height: number,
	format: MediaFormat = 'jpeg'
): Promise<Buffer> {
	const raw = Buffer.alloc(width * height * 3);
	// Deterministic PRNG: a fixed corpus makes byte-size assertions reproducible.
	let seed = 0x2f6e2b1;
	for (let i = 0; i < raw.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		raw[i] = (seed >>> 16) & 0xff;
	}
	return encode(sharp(raw, { raw: { width, height, channels: 3 } }), format);
}

/**
 * A JPEG that has already been optimized more aggressively than this package
 * would optimize it, and carries no metadata.
 *
 * Re-encoding such a file cannot save meaningful bytes, so it is the case where
 * passing the original bytes through is the correct behaviour.
 */
export async function preOptimizedJpeg(width: number, height: number): Promise<Buffer> {
	const raw = Buffer.alloc(width * height * 3);
	let seed = 0x51f3d7;
	for (let i = 0; i < raw.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		raw[i] = (seed >>> 16) & 0xff;
	}
	return sharp(raw, { raw: { width, height, channels: 3 } })
		.jpeg({ quality: 60, mozjpeg: true, progressive: true, chromaSubsampling: '4:2:0' })
		.toBuffer();
}

/** An animated WebP, to prove multi-page input is refused. */
export async function animatedWebp(size = 32): Promise<Buffer> {
	const frame = async (colour: string): Promise<Buffer> =>
		sharp({ create: { width: size, height: size, channels: 3, background: colour } })
			.png()
			.toBuffer();
	return sharp([await frame('#ff0000'), await frame('#00ff00')], {
		join: { animated: true }
	})
		.webp()
		.toBuffer();
}

/** Reads back the actual encoded geometry of a produced output. */
export async function probe(bytes: Uint8Array): Promise<{
	format: string;
	width: number;
	height: number;
	channels: number;
	hasAlpha: boolean;
	orientation: number | undefined;
	hasProfile: boolean;
	hasExif: boolean;
	chromaSubsampling: string;
}> {
	const m = await sharp(bytes).metadata();
	return {
		format: m.format ?? 'unknown',
		width: m.width ?? 0,
		height: m.height ?? 0,
		channels: m.channels ?? 0,
		hasAlpha: m.hasAlpha === true,
		orientation: m.orientation,
		hasProfile: m.hasProfile === true,
		hasExif: m.exif !== undefined,
		chromaSubsampling: m.chromaSubsampling ?? ''
	};
}

/** Samples one pixel as `[r, g, b, a]`, for crop and orientation assertions. */
export async function pixelAt(
	bytes: Uint8Array,
	x: number,
	y: number
): Promise<[number, number, number, number]> {
	const { data, info } = await sharp(bytes)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const offset = (y * info.width + x) * info.channels;
	return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0, data[offset + 3] ?? 0];
}

/** Nearest quadrant colour name for a sampled pixel, tolerating codec drift. */
export function nearestQuadrant(pixel: readonly [number, number, number, number]): string {
	let best = 'unknown';
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const [name, colour] of Object.entries(QUADRANT)) {
		const distance =
			(pixel[0] - colour.r) ** 2 + (pixel[1] - colour.g) ** 2 + (pixel[2] - colour.b) ** 2;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = name;
		}
	}
	return best;
}

function encode(pipeline: sharp.Sharp, format: MediaFormat, quality?: number): Promise<Buffer> {
	switch (format) {
		case 'jpeg':
			return pipeline.jpeg({ quality: quality ?? 90 }).toBuffer();
		case 'png':
			return pipeline.png().toBuffer();
		case 'webp':
			return pipeline.webp({ quality: quality ?? 90 }).toBuffer();
		case 'avif':
			return pipeline.avif({ quality: quality ?? 60, effort: 0 }).toBuffer();
	}
}
