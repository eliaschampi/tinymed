import type { MediaCrop, MediaRecipe } from './types.js';

/** General web image policy shared by applications. */
export function webImageV1(): MediaRecipe {
	return {
		outputs: [
			{ key: 'normalized', format: 'source', width: 2560, height: 2560, fit: 'inside' },
			{ key: 'preview', format: 'webp', width: 1600, height: 1600, fit: 'inside', quality: 84 },
			{ key: 'thumb', format: 'webp', width: 480, height: 480, fit: 'inside', quality: 72 }
		]
	};
}

/** Exact 420×420 student photo from an explicit oriented-source crop. */
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

/** Public catalog policy with a wider responsive ladder. */
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

export const PRESET_IDS = Object.freeze({
	webImage: 'web-image-v1',
	studentPhoto: 'student-photo-v1',
	catalog: 'catalog-v1'
} as const);

export type PresetId = (typeof PRESET_IDS)[keyof typeof PRESET_IDS];
