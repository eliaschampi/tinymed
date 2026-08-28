/**
 * Public data contract.
 *
 * Every type here is plain structural data. No engine handle, filesystem path,
 * URL or domain entity crosses this boundary in either direction.
 */

/** Raster formats accepted as input and produced as output. */
export type MediaFormat = 'jpeg' | 'png' | 'webp' | 'avif';

/** Output format selector. `'source'` re-encodes using the detected input format. */
export type MediaOutputFormat = MediaFormat | 'source';

/** Resize behavior. `inside` fits within the box; `cover` fills and centre-crops it. */
export type MediaFit = 'inside' | 'cover';

/** One complete encoded image. Node `Buffer` satisfies this. */
export type MediaInput = Uint8Array;

/** Crop rectangle in integer pixels of the auto-oriented source image. */
export interface MediaCrop {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

/** Authoritative facts about validated input bytes. */
export interface MediaSource {
	readonly format: MediaFormat;
	readonly mime: string;
	readonly byteLength: number;
	/** Width as stored, before EXIF orientation is applied. */
	readonly width: number;
	/** Height as stored, before EXIF orientation is applied. */
	readonly height: number;
	/** Width after EXIF orientation. This is the crop coordinate space. */
	readonly orientedWidth: number;
	/** Height after EXIF orientation. This is the crop coordinate space. */
	readonly orientedHeight: number;
	/** EXIF orientation tag, 1-8. `1` when absent. */
	readonly orientation: number;
	readonly channels: number;
	readonly hasAlpha: boolean;
}

/** One requested output. Describes a desired result, not a processing step. */
export interface MediaOutputSpec {
	/** Caller-chosen identifier, unique within a recipe. */
	readonly key: string;
	readonly format: MediaOutputFormat;
	/** Target width. Omit both dimensions to keep post-crop geometry. */
	readonly width?: number;
	/** Target height. Omit both dimensions to keep post-crop geometry. */
	readonly height?: number;
	/** Defaults to `'inside'`. */
	readonly fit?: MediaFit;
	/** Encoder quality, 1-100. Format-specific default when omitted. */
	readonly quality?: number;
	/** Allow enlarging beyond source geometry. Defaults to `false`. */
	readonly allowUpscale?: boolean;
}

/** A declarative description of the outputs wanted from one source image. */
export interface MediaRecipe {
	/** Applied after orientation, before every resize. */
	readonly crop?: MediaCrop;
	readonly outputs: readonly MediaOutputSpec[];
}

/** One generated output. All geometry describes the actual encoded bytes. */
export interface MediaOutput {
	readonly key: string;
	readonly bytes: Uint8Array;
	readonly mime: string;
	readonly format: MediaFormat;
	/** Actual encoded width. Use this for `srcset` width descriptors. */
	readonly width: number;
	/** Actual encoded height. */
	readonly height: number;
	readonly byteLength: number;
	/** EXIF orientation was baked into the pixels. */
	readonly oriented: boolean;
	/** A crop rectangle was applied. */
	readonly cropped: boolean;
	/** Pixel geometry differs from the post-crop source geometry. */
	readonly resized: boolean;
	/** Bytes were re-encoded. `false` means verified source bytes passed through. */
	readonly reencoded: boolean;
}

/** Complete result of one logical job: validated input facts plus every output. */
export interface MediaResult {
	readonly source: MediaSource;
	readonly outputs: readonly MediaOutput[];
	/** Outputs keyed by `MediaOutputSpec.key`, for direct lookup. */
	readonly byKey: Readonly<Record<string, MediaOutput>>;
	/** Wall-clock milliseconds spent in the queue before execution started. */
	readonly queueWaitMs: number;
	/** Wall-clock milliseconds spent decoding, transforming and encoding. */
	readonly durationMs: number;
}

/** Options common to inspection and processing. */
export interface MediaInspectOptions {
	/** Client-supplied MIME. Verified against detected format when present. */
	readonly declaredMime?: string;
	readonly signal?: AbortSignal;
}

export interface MediaProcessOptions extends MediaInspectOptions {
	/** Overrides the processor's configured timeout for this job. */
	readonly timeoutMs?: number;
}
