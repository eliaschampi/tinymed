import type { MediaFormat } from './types.js';

/** Finite bounds enforced before or during processing. */
export interface MediaLimits {
	readonly maxInputBytes: number;
	readonly maxPixels: number;
	readonly maxChannels: number;
	readonly maxOutputs: number;
	readonly maxOutputEdge: number;
}

/**
 * Scheduling budget for one processor.
 *
 * `libvipsConcurrency` is process-wide even though the remaining fields are per processor.
 */
export interface MediaCapacity {
	readonly maxActiveJobs: number;
	readonly maxQueuedJobs: number;
	readonly maxQueuedBytes: number;
	readonly timeoutMs: number;
	/** All processors in one Node process must request the same value. `0` keeps Sharp's default. */
	readonly libvipsConcurrency: number;
}

export interface MediaProcessorConfig {
	readonly limits?: Partial<MediaLimits>;
	readonly capacity?: Partial<MediaCapacity>;
}

export const DEFAULT_MAX_PIXELS = 50_000_000;

export const DEFAULT_LIMITS: MediaLimits = Object.freeze({
	maxInputBytes: 32 * 1024 * 1024,
	maxPixels: DEFAULT_MAX_PIXELS,
	maxChannels: 4,
	maxOutputs: 8,
	maxOutputEdge: 8192
});

export const DEFAULT_CAPACITY: MediaCapacity = Object.freeze({
	maxActiveJobs: 1,
	maxQueuedJobs: 16,
	maxQueuedBytes: 128 * 1024 * 1024,
	timeoutMs: 30_000,
	libvipsConcurrency: 1
});

export const FORMAT_MIME: Readonly<Record<MediaFormat, string>> = Object.freeze({
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	avif: 'image/avif'
});

export const DEFAULT_QUALITY: Readonly<Record<MediaFormat, number>> = Object.freeze({
	jpeg: 84,
	png: 100,
	webp: 84,
	avif: 52
});

/** Keep source bytes unless re-encoding saves at least six percent. */
export const MIN_REDUCTION_RATIO = 0.94;

const intInRange = (value: number, min: number, max: number, field: string): number => {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new RangeError(`${field} must be an integer between ${min} and ${max}`);
	}
	return value;
};

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
