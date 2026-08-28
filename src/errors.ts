/**
 * Stable, engine-independent failure codes.
 *
 * Consumers branch on these codes to derive HTTP status, retry policy and UI
 * copy. They are part of the public contract: a code is never repurposed, and
 * removing one is a breaking change.
 */
export type MediaErrorCode =
	/** Encoded input exceeded the configured byte ceiling. */
	| 'input_too_large'
	/** Bytes decoded to a raster format outside the supported set. */
	| 'unsupported_format'
	/** Caller-declared MIME disagrees with the detected format. */
	| 'mime_mismatch'
	/** Bytes are not a readable image: malformed, truncated or corrupt. */
	| 'invalid_image'
	/** Decoded pixel count exceeded the configured ceiling. */
	| 'pixel_limit_exceeded'
	/** Band count exceeded the configured ceiling. */
	| 'channel_limit_exceeded'
	/** Animated or multi-page input, which v1 does not process. */
	| 'multi_page_not_supported'
	/** Crop geometry is non-integer, empty or outside the oriented source. */
	| 'invalid_crop'
	/** Recipe is structurally invalid or requests unsupported behavior. */
	| 'invalid_recipe'
	/** Processor queue or queued-byte budget is full. Retryable. */
	| 'capacity_exceeded'
	/** Job exceeded its execution deadline. */
	| 'processing_timeout'
	/** Caller aborted the job through its `AbortSignal`. */
	| 'cancelled'
	/** Encoding or verification failed for a reason not covered above. */
	| 'processing_failed';

/** Codes worth retrying with identical input. */
const RETRYABLE: ReadonlySet<MediaErrorCode> = new Set<MediaErrorCode>([
	'capacity_exceeded',
	'processing_timeout'
]);

/**
 * The only error type this package throws.
 *
 * `message` is intentionally short, static and safe to log: it never embeds
 * filesystem paths, native diagnostics or image contents. Numeric context that
 * is safe to expose (limits, actual sizes) travels in `details`.
 */
export class MediaError extends Error {
	override readonly name = 'MediaError';
	readonly code: MediaErrorCode;
	readonly retryable: boolean;
	readonly details: Readonly<Record<string, number | string | boolean>>;

	constructor(
		code: MediaErrorCode,
		message: string,
		details: Record<string, number | string | boolean> = {}
	) {
		super(message);
		this.code = code;
		this.retryable = RETRYABLE.has(code);
		this.details = Object.freeze({ ...details });
	}

	/** Structured, log-safe representation. */
	toJSON(): {
		name: string;
		code: MediaErrorCode;
		message: string;
		retryable: boolean;
		details: Record<string, number | string | boolean>;
	} {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			details: { ...this.details }
		};
	}
}

/** Narrows unknown thrown values to `MediaError`, optionally to one code. */
export function isMediaError(value: unknown, code?: MediaErrorCode): value is MediaError {
	return value instanceof MediaError && (code === undefined || value.code === code);
}

/** Internal helper; keeps throw sites to a single readable line. */
export function fail(
	code: MediaErrorCode,
	message: string,
	details?: Record<string, number | string | boolean>
): never {
	throw new MediaError(code, message, details);
}

/**
 * Converts an unknown engine/runtime rejection into a `MediaError`.
 *
 * Native decoder messages are deliberately dropped rather than forwarded: they
 * are unstable across libvips builds and can echo input bytes.
 */
export function wrapUnknown(cause: unknown, fallback: MediaErrorCode): MediaError {
	if (cause instanceof MediaError) return cause;
	if (cause instanceof Error && cause.name === 'AbortError') {
		return new MediaError('cancelled', 'Processing was cancelled');
	}
	return new MediaError(fallback, FALLBACK_MESSAGE[fallback]);
}

const FALLBACK_MESSAGE: Record<MediaErrorCode, string> = {
	input_too_large: 'Encoded input is too large',
	unsupported_format: 'Image format is not supported',
	mime_mismatch: 'Declared media type does not match the image',
	invalid_image: 'Input is not a readable image',
	pixel_limit_exceeded: 'Image resolution is too large',
	channel_limit_exceeded: 'Image has too many channels',
	multi_page_not_supported: 'Animated or multi-page images are not supported',
	invalid_crop: 'Crop region is invalid',
	invalid_recipe: 'Recipe is invalid',
	capacity_exceeded: 'Processor is at capacity',
	processing_timeout: 'Processing timed out',
	cancelled: 'Processing was cancelled',
	processing_failed: 'Image processing failed'
};
