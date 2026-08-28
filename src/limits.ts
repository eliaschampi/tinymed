import type { MediaFormat } from './types.js';

/**
 * Every finite bound the package enforces, in one auditable place.
 *
 * Defaults are chosen for a 4 GB single-host deployment. Consumers may lower
 * them freely; raising them should follow a benchmark on target hardware.
 */
export interface MediaLimits {
	/** Encoded input ceiling, rejected before any decode is attempted. */
	readonly maxInputBytes: number;
	/** Decoded pixel ceiling (width x height), the primary memory guard. */
	readonly maxPixels: number;
	/** Band ceiling; guards pathological multi-band inputs. */
	readonly maxChannels: number;
	/** Outputs permitted in one recipe. */
	readonly maxOutputs: number;
	/** Longest requested output edge. */
	readonly maxOutputEdge: number;
}

/** Concurrency and backpressure budget for one processor instance. */
export interface MediaCapacity {
	/**
	 * Logical jobs executing at once. One source plus all of its outputs is one
	 * job. Starts at 1 so peak RSS stays predictable before measurement.
	 */
	readonly maxActiveJobs: number;
	/** Jobs allowed to wait. Beyond this, submission fails fast. */
	readonly maxQueuedJobs: number;
	/** Encoded bytes allowed to be retained by waiting jobs. */
	readonly maxQueuedBytes: number;
	/** Deadline for one job, measured from the start of execution. */
	readonly timeoutMs: number;
	/**
	 * libvips worker threads per operation. 1 keeps native memory and thread
	 * usage proportional to `maxActiveJobs`. `0` leaves the global default.
	 */
	readonly libvipsConcurrency: number;
}

export interface MediaProcessorConfig {
	readonly limits?: Partial<MediaLimits>;
	readonly capacity?: Partial<MediaCapacity>;
}

/**
 * Covers a 50 MP camera frame, the largest realistic consumer input, while
 * bounding the memory one hostile image can force us to allocate.
 */
export const DEFAULT_MAX_PIXELS = 50_000_000;

export const DEFAULT_LIMITS: MediaLimits = Object.freeze({
	/** 32 MiB holds any 50 MP JPEG/WebP/AVIF and most 50 MP PNGs. */
	maxInputBytes: 32 * 1024 * 1024,
	maxPixels: DEFAULT_MAX_PIXELS,
	maxChannels: 4,
	maxOutputs: 8,
	maxOutputEdge: 8192
});

export const DEFAULT_CAPACITY: MediaCapacity = Object.freeze({
	maxActiveJobs: 1,
	maxQueuedJobs: 16,
	/** 128 MiB of waiting encoded input; a batch loop blocks rather than grows. */
	maxQueuedBytes: 128 * 1024 * 1024,
	timeoutMs: 30_000,
	libvipsConcurrency: 1
});

/** Canonical MIME for each supported format. */
export const FORMAT_MIME: Readonly<Record<MediaFormat, string>> = Object.freeze({
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	avif: 'image/avif'
});

/**
 * Encoder defaults matching the quality currently shipped by the first
 * consumers, so a cutover is visually neutral. PNG is lossless, so its
 * `quality` is an effort/palette hint rather than a visual dial.
 */
export const DEFAULT_QUALITY: Readonly<Record<MediaFormat, number>> = Object.freeze({
	jpeg: 84,
	png: 100,
	webp: 84,
	avif: 52
});

/**
 * A `'source'` output keeps the original bytes unless re-encoding saves at
 * least this fraction. Re-encoding an already-optimized file for a 1 % gain
 * costs CPU and discards nothing useful.
 */
export const MIN_REDUCTION_RATIO = 0.94;

const intInRange = (value: number, min: number, max: number, field: string): number => {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new RangeError(`${field} must be an integer between ${min} and ${max}`);
	}
	return value;
};

/** Merges caller overrides onto the defaults, rejecting nonsensical values. */
export function resolveLimits(overrides?: Partial<MediaLimits>): MediaLimits {
	const merged = { ...DEFAULT_LIMITS, ...overrides };
	return Object.freeze({
		maxInputBytes: intInRange(merged.maxInputBytes, 1, Number.MAX_SAFE_INTEGER, 'maxInputBytes'),
		maxPixels: intInRange(merged.maxPixels, 1, Number.MAX_SAFE_INTEGER, 'maxPixels'),
		maxChannels: intInRange(merged.maxChannels, 1, 64, 'maxChannels'),
		maxOutputs: intInRange(merged.maxOutputs, 1, 64, 'maxOutputs'),
		maxOutputEdge: intInRange(merged.maxOutputEdge, 1, 65_535, 'maxOutputEdge')
	});
}

export function resolveCapacity(overrides?: Partial<MediaCapacity>): MediaCapacity {
	const merged = { ...DEFAULT_CAPACITY, ...overrides };
	return Object.freeze({
		maxActiveJobs: intInRange(merged.maxActiveJobs, 1, 64, 'maxActiveJobs'),
		maxQueuedJobs: intInRange(merged.maxQueuedJobs, 0, 100_000, 'maxQueuedJobs'),
		maxQueuedBytes: intInRange(
			merged.maxQueuedBytes,
			0,
			Number.MAX_SAFE_INTEGER,
			'maxQueuedBytes'
		),
		timeoutMs: intInRange(merged.timeoutMs, 1, 3_600_000, 'timeoutMs'),
		libvipsConcurrency: intInRange(merged.libvipsConcurrency, 0, 1024, 'libvipsConcurrency')
	});
}
