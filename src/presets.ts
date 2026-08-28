import type { MediaCrop, MediaRecipe } from './types.js';

/**
 * Versioned recipes shared by every consumer.
 *
 * A preset is a released processing policy. Once published, its geometry and
 * quality are frozen; a materially different policy becomes a new version. This
 * is the mechanism that stops independent applications from silently drifting
 * apart on codec settings.
 */

/**
 * General-purpose web image set.
 *
 * `normalized` keeps the source codec so an uploaded PNG stays lossless and a
 * JPEG stays a JPEG. `preview` and `thumb` are always WebP.
 *
 * Every entry uses proportional `inside` resizing, so the given number is the
 * longest edge. Actual encoded width of a portrait output is therefore smaller
 * than that number: read `MediaOutput.width` for `srcset`, never the preset.
 */
export function webImageV1(): MediaRecipe {
	return {
		outputs: [
			{ key: 'normalized', format: 'source', width: 2560, height: 2560, fit: 'inside' },
			{ key: 'preview', format: 'webp', width: 1600, height: 1600, fit: 'inside', quality: 84 },
			{ key: 'thumb', format: 'webp', width: 480, height: 480, fit: 'inside', quality: 72 }
		]
	};
}

/**
 * Square identity photo, cropped by the caller.
 *
 * `cover` plus `allowUpscale` guarantees exactly 420x420, because the consuming
 * layout reserves a fixed box and a smaller asset would break it. This is the
 * one place upscaling is deliberate: the primitive defaults to refusing it.
 *
 * The crop rectangle is required. Framing an identity photo by an automatic
 * centre crop is a product decision this package should not make silently.
 */
export function studentPhotoV1(crop: MediaCrop): MediaRecipe {
	return {
		crop,
		outputs: [
			{
				key: 'photo',
				format: 'webp',
				width: 420,
				height: 420,
				fit: 'cover',
				quality: 88,
				allowUpscale: true
			}
		]
	};
}

/**
 * Catalog image set for public, SEO-relevant pages.
 *
 * Wider ladder and higher quality than `web-image-v1`, because catalog pages
 * are indexed and zoomed. Optional crop lets an admin normalize framing across
 * a product grid.
 */
export function catalogV1(crop?: MediaCrop): MediaRecipe {
	return {
		...(crop === undefined ? {} : { crop }),
		outputs: [
			{ key: 'normalized', format: 'source', width: 2560, height: 2560, fit: 'inside' },
			{ key: 'large', format: 'webp', width: 1600, height: 1600, fit: 'inside', quality: 86 },
			{ key: 'medium', format: 'webp', width: 960, height: 960, fit: 'inside', quality: 84 },
			{ key: 'thumb', format: 'webp', width: 480, height: 480, fit: 'inside', quality: 76 }
		]
	};
}

/** Stable preset identifiers, for logging and stored asset provenance. */
export const PRESET_IDS = Object.freeze({
	webImage: 'web-image-v1',
	studentPhoto: 'student-photo-v1',
	catalog: 'catalog-v1'
} as const);

export type PresetId = (typeof PRESET_IDS)[keyof typeof PRESET_IDS];
