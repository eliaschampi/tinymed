import sharp from 'sharp';
import { fail, wrapUnknown } from '../errors.js';
import { DEFAULT_QUALITY } from '../limits.js';
import type { MediaCrop, MediaFit, MediaFormat } from '../types.js';

/**
 * The only module allowed to import Sharp.
 *
 * This is an implementation boundary, not a plugin system: there is exactly one
 * engine, and it is kept behind a narrow function surface so it can be replaced
 * without touching orchestration or consumer code. No Sharp type is re-exported.
 */

/** Header facts, read without decoding pixels. */
export interface EngineMetadata {
	/** libvips format id. `'heif'` covers AVIF, so callers must reconcile it. */
	readonly container: string;
	readonly width: number;
	readonly height: number;
	readonly orientedWidth: number;
	readonly orientedHeight: number;
	readonly orientation: number;
	readonly channels: number;
	readonly hasAlpha: boolean;
	readonly pages: number;
	readonly hasIccProfile: boolean;
	/** Source carries an EXIF block, which may hold GPS and device identifiers. */
	readonly hasExif: boolean;
	/** Source chroma layout, e.g. `'4:2:0'`. Empty for formats without one. */
	readonly chromaSubsampling: string;
}

/** A fully-resolved instruction for producing one encoded output. */
export interface RenderPlan {
	readonly format: MediaFormat;
	readonly quality: number | null;
	readonly crop: MediaCrop | null;
	readonly width: number | null;
	readonly height: number | null;
	readonly fit: MediaFit;
	readonly allowUpscale: boolean;
	/** Convert through the source ICC profile into sRGB. */
	readonly convertIcc: boolean;
	/**
	 * Encode JPEG chroma at full resolution.
	 *
	 * True for sources that genuinely hold per-pixel colour detail — lossless
	 * formats, or a JPEG already stored at 4:4:4.
	 */
	readonly fullChroma: boolean;
	/** Decode ceiling handed to libvips as defence in depth. */
	readonly maxPixels: number;
}

/** Encoded bytes plus the geometry the encoder actually produced. */
export interface RenderResult {
	readonly bytes: Uint8Array;
	readonly width: number;
	readonly height: number;
}

let configured = false;

/**
 * Applies process-wide libvips settings once.
 *
 * `concurrency` is the main lever on native memory: each worker thread holds
 * its own tile buffers, so leaving it at 1 keeps peak RSS proportional to the
 * number of active jobs. The operation cache is disabled because inputs are
 * one-shot uploads that are never re-processed, so caching only retains memory.
 */
export function configureEngine(concurrency: number): void {
	if (configured) return;
	configured = true;
	if (concurrency > 0) sharp.concurrency(concurrency);
	sharp.cache(false);
}

/**
 * Reads structural metadata.
 *
 * `limitInputPixels: false` is deliberate: this call parses only the header, so
 * it cannot exhaust memory, and refusing here would surface a native message
 * instead of a typed error carrying the actual pixel count.
 */
export async function readMetadata(bytes: Uint8Array): Promise<EngineMetadata> {
	try {
		const m = await sharp(bytes, { limitInputPixels: false, failOn: 'truncated' }).metadata();
		if (
			typeof m.width !== 'number' ||
			typeof m.height !== 'number' ||
			m.width <= 0 ||
			m.height <= 0
		) {
			fail('invalid_image', 'Image reports no usable dimensions');
		}
		const orientation = typeof m.orientation === 'number' ? m.orientation : 1;
		return {
			container: typeof m.format === 'string' ? m.format : 'unknown',
			width: m.width,
			height: m.height,
			orientedWidth: m.autoOrient?.width ?? m.width,
			orientedHeight: m.autoOrient?.height ?? m.height,
			orientation,
			channels: typeof m.channels === 'number' ? m.channels : 0,
			hasAlpha: m.hasAlpha === true,
			pages: typeof m.pages === 'number' ? m.pages : 1,
			hasIccProfile: m.hasProfile === true,
			hasExif: m.exif !== undefined,
			chromaSubsampling: typeof m.chromaSubsampling === 'string' ? m.chromaSubsampling : ''
		};
	} catch (cause) {
		throw wrapUnknown(cause, 'invalid_image');
	}
}

/**
 * Decodes, transforms and encodes one output.
 *
 * The operation order is fixed and is the core geometric guarantee of the
 * package: orient, then crop, then resize, then encode. A fresh decode per
 * output is intentional; sharing one decoded pipeline across outputs would keep
 * a full-resolution frame alive for the whole job.
 *
 * `blameInput` selects the error code for a failure. Truncation and corruption
 * are only detectable during decode, never from the header, so the first render
 * of a job doubles as the integrity check and attributes failure to the input.
 * Once one output has succeeded the bytes are known to decode, and later
 * failures are ours.
 */
export async function renderOutput(
	bytes: Uint8Array,
	plan: RenderPlan,
	blameInput: boolean
): Promise<RenderResult> {
	try {
		let pipeline = sharp(bytes, {
			// Reject truncated and structurally broken input instead of returning
			// a partially-decoded frame.
			failOn: 'truncated',
			sequentialRead: true,
			limitInputPixels: plan.maxPixels
		});

		// 1. Orientation. Bakes the EXIF tag into pixels and drops the tag, so
		//    every later coordinate is in the oriented space the caller sees.
		pipeline = pipeline.rotate();

		// 2. Colour. Guarantees an sRGB output space (also converts CMYK). When
		//    the source carries a profile, transform through it so wide-gamut
		//    input keeps its appearance; `attach: false` avoids paying bytes for
		//    a profile browsers already assume.
		pipeline = pipeline.toColourspace('srgb');
		if (plan.convertIcc) {
			pipeline = pipeline.withIccProfile('srgb', { attach: false });
		}

		// 3. Crop, in oriented source pixels.
		if (plan.crop !== null) {
			pipeline = pipeline.extract(plan.crop);
		}

		// 4. Resize.
		if (plan.width !== null || plan.height !== null) {
			pipeline = pipeline.resize({
				...(plan.width === null ? {} : { width: plan.width }),
				...(plan.height === null ? {} : { height: plan.height }),
				fit: plan.fit,
				position: 'centre',
				withoutEnlargement: !plan.allowUpscale
			});
		}

		// 5. Encode.
		const quality = plan.quality ?? DEFAULT_QUALITY[plan.format];
		const { data, info } = await encode(pipeline, plan, quality).toBuffer({
			resolveWithObject: true
		});

		// The encoder reports the geometry it actually wrote. Trusting this
		// instead of the request is what keeps `srcset` descriptors honest.
		if (!Number.isInteger(info.width) || !Number.isInteger(info.height)) {
			fail('processing_failed', 'Encoder reported invalid output geometry');
		}
		return { bytes: data, width: info.width, height: info.height };
	} catch (cause) {
		throw wrapUnknown(cause, blameInput ? 'invalid_image' : 'processing_failed');
	}
}

/**
 * Per-format encoder settings.
 *
 * Values match the quality already shipped by the first consumers so adopting
 * this package is visually neutral. Effort levels sit where extra CPU stops
 * buying meaningful bytes on server workloads.
 */
function encode(pipeline: sharp.Sharp, plan: RenderPlan, quality: number): sharp.Sharp {
	switch (plan.format) {
		case 'jpeg':
			return pipeline.jpeg({
				quality,
				// Smaller files at equal quality; worth the CPU on write-once assets.
				mozjpeg: true,
				progressive: true,
				// Chroma resolution follows the source. Forcing 4:4:4 on a photograph
				// that was stored as 4:2:0 measurably inflates bytes (over 20 % on the
				// sample corpus) while adding colour detail the pixels never had;
				// forcing 4:2:0 on a lossless source would throw away detail it does.
				chromaSubsampling: plan.fullChroma ? '4:4:4' : '4:2:0'
			});
		case 'png':
			// Lossless: `quality` only steers optional palette quantisation.
			return pipeline.png({ compressionLevel: 9, effort: 8 });
		case 'webp':
			return pipeline.webp({ quality, effort: 4 });
		case 'avif':
			// AVIF encoding is the slowest path by an order of magnitude; effort 4
			// keeps latency usable.
			return pipeline.avif({ quality, effort: 4 });
	}
}
