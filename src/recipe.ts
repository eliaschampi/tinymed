import { fail } from './errors.js';
import type { MediaLimits } from './limits.js';
import type { MediaCrop, MediaFit, MediaFormat, MediaOutputFormat, MediaRecipe } from './types.js';

/** A validated output spec with every default resolved. */
export interface PlannedOutput {
	readonly key: string;
	readonly format: MediaOutputFormat;
	readonly width: number | null;
	readonly height: number | null;
	readonly fit: MediaFit;
	readonly quality: number | null;
	readonly allowUpscale: boolean;
}

/** A validated recipe. Only this shape reaches the engine. */
export interface PlannedRecipe {
	readonly crop: MediaCrop | null;
	readonly outputs: readonly PlannedOutput[];
}

const OUTPUT_FORMATS: ReadonlySet<string> = new Set<MediaOutputFormat>([
	'jpeg',
	'png',
	'webp',
	'avif',
	'source'
]);
const FITS: ReadonlySet<string> = new Set<MediaFit>(['inside', 'cover']);

const isPositiveInt = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * Validates a recipe structurally, independently of any image.
 *
 * Runs before decode so a malformed recipe costs nothing, and fails on the
 * first problem to keep errors unambiguous.
 */
export function planRecipe(recipe: MediaRecipe, limits: MediaLimits): PlannedRecipe {
	if (recipe === null || typeof recipe !== 'object') {
		fail('invalid_recipe', 'Recipe must be an object');
	}
	if (!Array.isArray(recipe.outputs) || recipe.outputs.length === 0) {
		fail('invalid_recipe', 'Recipe must request at least one output');
	}
	if (recipe.outputs.length > limits.maxOutputs) {
		fail('invalid_recipe', 'Recipe requests too many outputs', {
			requested: recipe.outputs.length,
			limit: limits.maxOutputs
		});
	}

	const keys = new Set<string>();
	const outputs: PlannedOutput[] = [];

	for (const spec of recipe.outputs) {
		if (spec === null || typeof spec !== 'object') {
			fail('invalid_recipe', 'Each output must be an object');
		}
		if (typeof spec.key !== 'string' || spec.key.length === 0) {
			fail('invalid_recipe', 'Each output requires a non-empty key');
		}
		if (keys.has(spec.key)) {
			fail('invalid_recipe', 'Output keys must be unique', { key: spec.key });
		}
		keys.add(spec.key);

		if (!OUTPUT_FORMATS.has(spec.format)) {
			fail('invalid_recipe', 'Unsupported output format', { key: spec.key });
		}

		const fit = spec.fit ?? 'inside';
		if (!FITS.has(fit)) {
			fail('invalid_recipe', 'Unsupported fit', { key: spec.key });
		}

		for (const [field, value] of [
			['width', spec.width],
			['height', spec.height]
		] as const) {
			if (value === undefined) continue;
			if (!isPositiveInt(value)) {
				fail('invalid_recipe', `Output ${field} must be a positive integer`, { key: spec.key });
			}
			if (value > limits.maxOutputEdge) {
				fail('invalid_recipe', `Output ${field} exceeds the maximum edge`, {
					key: spec.key,
					requested: value,
					limit: limits.maxOutputEdge
				});
			}
		}

		if (spec.quality !== undefined) {
			if (!isPositiveInt(spec.quality) || spec.quality > 100) {
				fail('invalid_recipe', 'Output quality must be an integer between 1 and 100', {
					key: spec.key
				});
			}
		}

		// `cover` needs both edges to define the target box; `inside` accepts one.
		if (fit === 'cover' && !(isPositiveInt(spec.width) && isPositiveInt(spec.height))) {
			fail('invalid_recipe', 'Fit "cover" requires both width and height', { key: spec.key });
		}

		outputs.push({
			key: spec.key,
			format: spec.format,
			width: spec.width ?? null,
			height: spec.height ?? null,
			fit,
			quality: spec.quality ?? null,
			allowUpscale: spec.allowUpscale === true
		});
	}

	return Object.freeze({
		crop: recipe.crop === undefined ? null : planCrop(recipe.crop),
		outputs: Object.freeze(outputs)
	});
}

/** Validates crop shape. Bounds against real geometry are checked after inspection. */
function planCrop(crop: MediaCrop): MediaCrop {
	if (crop === null || typeof crop !== 'object') {
		fail('invalid_crop', 'Crop must be an object');
	}
	const { left, top, width, height } = crop;
	if (!Number.isInteger(left) || !Number.isInteger(top) || left < 0 || top < 0) {
		fail('invalid_crop', 'Crop left/top must be non-negative integers');
	}
	if (!isPositiveInt(width) || !isPositiveInt(height)) {
		fail('invalid_crop', 'Crop width/height must be positive integers');
	}
	return Object.freeze({ left, top, width, height });
}

/**
 * Confirms the crop lies fully inside the auto-oriented source.
 *
 * Oriented dimensions are used deliberately: the caller's UI measured the
 * rectangle against the image as displayed, which is the oriented one.
 */
export function assertCropWithinSource(
	crop: MediaCrop,
	orientedWidth: number,
	orientedHeight: number
): void {
	if (crop.left + crop.width > orientedWidth || crop.top + crop.height > orientedHeight) {
		fail('invalid_crop', 'Crop region is outside the oriented source bounds', {
			left: crop.left,
			top: crop.top,
			width: crop.width,
			height: crop.height,
			orientedWidth,
			orientedHeight
		});
	}
}

/** Resolves `'source'` to the detected input format. */
export function resolveOutputFormat(
	requested: MediaOutputFormat,
	sourceFormat: MediaFormat
): MediaFormat {
	return requested === 'source' ? sourceFormat : requested;
}
