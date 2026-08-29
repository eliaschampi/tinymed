import sharp from 'sharp';
import { fail, wrapUnknown } from '../errors.js';
import { DEFAULT_QUALITY } from '../limits.js';
import type { MediaCrop, MediaFit, MediaFormat } from '../types.js';

/** Private Sharp/libvips implementation boundary. No Sharp type crosses the public API. */
export interface EngineMetadata {
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
	readonly hasExif: boolean;
	readonly chromaSubsampling: string;
}

export interface RenderPlan {
	readonly format: MediaFormat;
	readonly quality: number | null;
	readonly crop: MediaCrop | null;
	readonly width: number | null;
	readonly height: number | null;
	readonly fit: MediaFit;
	readonly allowUpscale: boolean;
	readonly convertIcc: boolean;
	readonly fullChroma: boolean;
	readonly maxPixels: number;
}

export interface RenderResult {
	readonly bytes: Uint8Array;
	readonly width: number;
	readonly height: number;
}

let configuredConcurrency: number | undefined;

/** Configures process-wide Sharp/libvips state and rejects conflicting thread counts. */
export function configureEngine(concurrency: number): void {
	if (configuredConcurrency !== undefined) {
		if (configuredConcurrency !== concurrency) {
			throw new RangeError(
				`libvipsConcurrency is process-wide and already configured to ${configuredConcurrency}; received ${concurrency}`
			);
		}
		return;
	}

	if (concurrency > 0) sharp.concurrency(concurrency);
	sharp.cache(false);
	configuredConcurrency = concurrency;
}

/** Reads header metadata without applying the full-decode pixel ceiling. */
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

/** Renders one output in the fixed order orient → colour → crop → resize → encode. */
export async function renderOutput(
	bytes: Uint8Array,
	plan: RenderPlan,
	blameInput: boolean
): Promise<RenderResult> {
	try {
		let pipeline = sharp(bytes, {
			failOn: 'truncated',
			sequentialRead: true,
			limitInputPixels: plan.maxPixels
		});

		pipeline = pipeline.rotate();
		pipeline = pipeline.toColourspace('srgb');
		if (plan.convertIcc) {
			pipeline = pipeline.withIccProfile('srgb', { attach: false });
		}

		if (plan.crop !== null) {
			pipeline = pipeline.extract(plan.crop);
		}

		if (plan.width !== null || plan.height !== null) {
			pipeline = pipeline.resize({
				...(plan.width === null ? {} : { width: plan.width }),
				...(plan.height === null ? {} : { height: plan.height }),
				fit: plan.fit,
				position: 'centre',
				withoutEnlargement: !plan.allowUpscale
			});
		}

		const quality = plan.quality ?? DEFAULT_QUALITY[plan.format];
		const { data, info } = await encode(pipeline, plan, quality).toBuffer({
			resolveWithObject: true
		});

		if (!Number.isInteger(info.width) || !Number.isInteger(info.height)) {
			fail('processing_failed', 'Encoder reported invalid output geometry');
		}
		return { bytes: data, width: info.width, height: info.height };
	} catch (cause) {
		// The first render also proves the source can be fully decoded.
		throw wrapUnknown(cause, blameInput ? 'invalid_image' : 'processing_failed');
	}
}

function encode(pipeline: sharp.Sharp, plan: RenderPlan, quality: number): sharp.Sharp {
	switch (plan.format) {
		case 'jpeg':
			return pipeline.jpeg({
				quality,
				mozjpeg: true,
				progressive: true,
				// Preserve source chroma capability instead of blindly forcing 4:4:4 or 4:2:0.
				chromaSubsampling: plan.fullChroma ? '4:4:4' : '4:2:0'
			});
		case 'png':
			return pipeline.png({ compressionLevel: 9, effort: 8 });
		case 'webp':
			return pipeline.webp({ quality, effort: 4 });
		case 'avif':
			return pipeline.avif({ quality, effort: 4 });
	}
}
