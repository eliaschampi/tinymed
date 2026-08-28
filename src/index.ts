/**
 * `@tinymed/media`
 *
 * Turns untrusted encoded raster bytes into validated, deterministic, optimized
 * encoded outputs. The package owns image bytes and image-processing policy, and
 * nothing else: no storage, no transport, no authorization, no domain state.
 */

import { createProcessor, type MediaProcessor } from './process.js';
import type {
	MediaInput,
	MediaInspectOptions,
	MediaProcessOptions,
	MediaRecipe,
	MediaResult,
	MediaSource
} from './types.js';

export { createProcessor, type MediaProcessor } from './process.js';

export { MediaError, isMediaError, type MediaErrorCode } from './errors.js';

export {
	DEFAULT_CAPACITY,
	DEFAULT_LIMITS,
	DEFAULT_MAX_PIXELS,
	DEFAULT_QUALITY,
	FORMAT_MIME,
	type MediaCapacity,
	type MediaLimits,
	type MediaProcessorConfig
} from './limits.js';

export { PRESET_IDS, catalogV1, studentPhotoV1, webImageV1, type PresetId } from './presets.js';

export type { MediaMetrics } from './scheduler.js';

export type {
	MediaCrop,
	MediaFit,
	MediaFormat,
	MediaInput,
	MediaInspectOptions,
	MediaOutput,
	MediaOutputFormat,
	MediaOutputSpec,
	MediaProcessOptions,
	MediaRecipe,
	MediaResult,
	MediaSource
} from './types.js';

/**
 * Shared processor backing the module-level helpers.
 *
 * Created on first use so importing the package costs nothing. Applications
 * that need their own capacity budget should call `createProcessor` instead;
 * separate instances do not share a queue.
 */
let shared: MediaProcessor | undefined;

const sharedProcessor = (): MediaProcessor => (shared ??= createProcessor());

/**
 * Validates encoded bytes and returns authoritative facts about them.
 *
 * Reads headers only, so it is cheap enough to run before deciding whether to
 * accept an upload. Use `orientedWidth`/`orientedHeight` as the coordinate space
 * for any crop rectangle.
 */
export function inspectImage(
	input: MediaInput,
	options?: MediaInspectOptions
): Promise<MediaSource> {
	return sharedProcessor().inspect(input, options);
}

/**
 * Runs one logical job: one source image and every output the recipe requests.
 *
 * The job is atomic — either every output is produced, or a `MediaError` is
 * thrown and nothing is returned. Read geometry from each output rather than
 * from the recipe: an `inside` resize of a portrait image is narrower than the
 * requested box, and `srcset` descriptors must use the actual encoded width.
 */
export function processImage(
	input: MediaInput,
	recipe: MediaRecipe,
	options?: MediaProcessOptions
): Promise<MediaResult> {
	return sharedProcessor().process(input, recipe, options);
}
