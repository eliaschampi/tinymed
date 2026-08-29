// oxlint-disable no-await-in-loop -- Fixtures are generated and asserted
// sequentially on purpose: it keeps failures attributable to one input and
// keeps peak memory low while large images are built.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import {
	createProcessor,
	isMediaError,
	processImage,
	studentPhotoV1,
	webImageV1,
	type MediaProcessor
} from '../src/index.js';
import {
	nearestQuadrant,
	noiseImage,
	pixelAt,
	preOptimizedJpeg,
	probe,
	quadrantImage,
	solidImage
} from './fixtures.js';

async function rejectsWithCode(run: () => Promise<unknown>, code: string): Promise<void> {
	try {
		await run();
	} catch (error) {
		assert.ok(isMediaError(error), `expected MediaError, received ${String(error)}`);
		assert.equal(error.code, code);
		return;
	}
	assert.fail(`expected rejection with code "${code}"`);
}

describe('output geometry', () => {
	let processor: MediaProcessor;
	before(() => {
		processor = createProcessor();
	});

	it('fits inside the requested box and preserves aspect ratio', async () => {
		const landscape = await noiseImage(1000, 400, 'jpeg');
		const result = await processor.process(landscape, {
			outputs: [{ key: 'thumb', format: 'webp', width: 480, height: 480, fit: 'inside' }]
		});
		const thumb = result.byKey.thumb!;
		assert.equal(thumb.width, 480);
		assert.equal(thumb.height, 192);
		assert.equal(thumb.resized, true);
		// The encoded file must agree with the reported metadata.
		const actual = await probe(thumb.bytes);
		assert.equal(actual.width, thumb.width);
		assert.equal(actual.height, thumb.height);
	});

	it('fills the requested box exactly with cover', async () => {
		const landscape = await noiseImage(1000, 400, 'jpeg');
		const result = await processor.process(landscape, {
			outputs: [
				{ key: 'square', format: 'webp', width: 300, height: 300, fit: 'cover', allowUpscale: true }
			]
		});
		const square = result.byKey.square!;
		assert.equal(square.width, 300);
		assert.equal(square.height, 300);
	});

	it('refuses to upscale unless asked', async () => {
		const small = await noiseImage(100, 80, 'jpeg');
		const result = await processor.process(small, {
			outputs: [
				{ key: 'blocked', format: 'webp', width: 480, height: 480, fit: 'inside' },
				{
					key: 'allowed',
					format: 'webp',
					width: 480,
					height: 480,
					fit: 'cover',
					allowUpscale: true
				}
			]
		});
		assert.equal(result.byKey.blocked!.width, 100, 'must not enlarge by default');
		assert.equal(result.byKey.blocked!.height, 80);
		assert.equal(result.byKey.blocked!.resized, false);
		assert.equal(result.byKey.allowed!.width, 480, 'explicit opt-in enlarges');
	});

	it('keeps source geometry when no dimensions are requested', async () => {
		const image = await noiseImage(321, 123, 'jpeg');
		const result = await processor.process(image, {
			outputs: [{ key: 'same', format: 'webp' }]
		});
		assert.equal(result.byKey.same!.width, 321);
		assert.equal(result.byKey.same!.height, 123);
		assert.equal(result.byKey.same!.resized, false);
		assert.equal(result.byKey.same!.reencoded, true);
	});

	it('reports actual encoded width, which srcset must use', async () => {
		// A portrait image resized by longest edge is narrower than the request.
		// Deriving "1600w" from the recipe would advertise a false width.
		const portrait = await noiseImage(1200, 1600, 'jpeg');
		const result = await processor.process(portrait, webImageV1());
		const preview = result.byKey.preview!;
		assert.equal(preview.height, 1600, 'longest edge matches the preset');
		assert.equal(preview.width, 1200, 'actual width is smaller than the preset number');
		assert.notEqual(preview.width, 1600);
	});
});

describe('crop', () => {
	let processor: MediaProcessor;
	before(() => {
		processor = createProcessor();
	});

	it('crops in oriented source pixels', async () => {
		// 200x100 split into quadrants; take the top-right one only.
		const image = await quadrantImage({ width: 200, height: 100, format: 'png' });
		const result = await processor.process(image, {
			crop: { left: 100, top: 0, width: 100, height: 50 },
			outputs: [{ key: 'out', format: 'png' }]
		});
		const out = result.byKey.out!;
		assert.equal(out.width, 100);
		assert.equal(out.height, 50);
		assert.equal(out.cropped, true);
		// Every corner of the result must come from the top-right quadrant.
		for (const [x, y] of [
			[2, 2],
			[97, 2],
			[2, 47],
			[97, 47]
		] as const) {
			assert.equal(nearestQuadrant(await pixelAt(out.bytes, x, y)), 'topRight');
		}
	});

	it('applies crop after orientation, not before', async () => {
		// Stored 200x100 with orientation 6 displays as 100x200. Cropping the top
		// half of the *displayed* image must yield the visually top half. If crop
		// ran before rotation these coordinates would be out of bounds or wrong.
		const image = await quadrantImage({
			width: 200,
			height: 100,
			format: 'jpeg',
			orientation: 6
		});
		const source = await processor.inspect(image);
		assert.equal(source.orientedWidth, 100);
		assert.equal(source.orientedHeight, 200);

		const result = await processor.process(image, {
			crop: { left: 0, top: 0, width: 100, height: 100 },
			outputs: [{ key: 'out', format: 'png' }]
		});
		const out = result.byKey.out!;
		assert.equal(out.width, 100);
		assert.equal(out.height, 100);
		assert.equal(out.oriented, true);
		assert.equal(out.cropped, true);
		// Orientation 6 rotates 90 degrees clockwise: the stored bottom-left
		// quadrant becomes the displayed top-left.
		assert.equal(nearestQuadrant(await pixelAt(out.bytes, 10, 10)), 'bottomLeft');
	});

	it('rejects a crop outside the oriented bounds', async () => {
		const image = await quadrantImage({ width: 200, height: 100, format: 'png' });
		await rejectsWithCode(
			() =>
				processor.process(image, {
					crop: { left: 150, top: 0, width: 100, height: 50 },
					outputs: [{ key: 'out', format: 'png' }]
				}),
			'invalid_crop'
		);
	});

	it('rejects a crop valid in stored space but invalid once oriented', async () => {
		// Stored 200x100, displayed 100x200. A 200-wide crop is only valid before
		// rotation, and must be refused.
		const image = await quadrantImage({
			width: 200,
			height: 100,
			format: 'jpeg',
			orientation: 6
		});
		await rejectsWithCode(
			() =>
				processor.process(image, {
					crop: { left: 0, top: 0, width: 200, height: 100 },
					outputs: [{ key: 'out', format: 'png' }]
				}),
			'invalid_crop'
		);
	});

	it('rejects malformed crop geometry', async () => {
		const image = await solidImage(100, 100, 'png');
		for (const crop of [
			{ left: -1, top: 0, width: 10, height: 10 },
			{ left: 0, top: 0, width: 0, height: 10 },
			{ left: 0.5, top: 0, width: 10, height: 10 },
			{ left: 0, top: 0, width: 10, height: -5 }
		]) {
			await rejectsWithCode(
				() => processor.process(image, { crop, outputs: [{ key: 'o', format: 'png' }] }),
				'invalid_crop'
			);
		}
	});
});

describe('encoding', () => {
	let processor: MediaProcessor;
	before(() => {
		processor = createProcessor();
	});

	it('produces every supported output format with a correct MIME', async () => {
		const image = await noiseImage(200, 150, 'png');
		const result = await processor.process(image, {
			outputs: [
				{ key: 'jpeg', format: 'jpeg', width: 100 },
				{ key: 'png', format: 'png', width: 100 },
				{ key: 'webp', format: 'webp', width: 100 },
				{ key: 'avif', format: 'avif', width: 100 }
			]
		});
		const expected = {
			jpeg: 'image/jpeg',
			png: 'image/png',
			webp: 'image/webp',
			avif: 'image/avif'
		} as const;
		for (const [key, mime] of Object.entries(expected)) {
			const output = result.byKey[key]!;
			assert.equal(output.mime, mime);
			assert.equal(output.format, key);
			assert.equal(output.byteLength, output.bytes.byteLength);
			assert.ok(output.byteLength > 0);
		}
	});

	it('resolves "source" to the detected input format', async () => {
		for (const format of ['jpeg', 'png', 'webp'] as const) {
			const image = await noiseImage(300, 200, format);
			const result = await processor.process(image, {
				outputs: [{ key: 'normalized', format: 'source', width: 100, height: 100 }]
			});
			assert.equal(result.byKey.normalized!.format, format);
		}
	});

	it('preserves alpha into formats that support it', async () => {
		const transparent = await quadrantImage({
			width: 100,
			height: 100,
			format: 'png',
			alpha: true
		});
		const result = await processor.process(transparent, {
			outputs: [
				{ key: 'png', format: 'png', width: 50 },
				{ key: 'webp', format: 'webp', width: 50 },
				{ key: 'jpeg', format: 'jpeg', width: 50 }
			]
		});
		assert.equal((await probe(result.byKey.png!.bytes)).hasAlpha, true);
		assert.equal((await probe(result.byKey.webp!.bytes)).hasAlpha, true);
		// JPEG has no alpha channel; it must flatten rather than fail.
		assert.equal((await probe(result.byKey.jpeg!.bytes)).hasAlpha, false);
	});

	it('strips EXIF and orientation metadata from outputs', async () => {
		const image = await quadrantImage({
			width: 120,
			height: 60,
			format: 'jpeg',
			orientation: 6
		});
		const result = await processor.process(image, {
			outputs: [{ key: 'out', format: 'jpeg' }]
		});
		const actual = await probe(result.byKey.out!.bytes);
		// Orientation is baked into pixels, so the tag must not survive; a stale
		// tag would make viewers rotate the image a second time.
		assert.equal(actual.orientation, undefined);
		assert.equal(actual.hasExif, false);
		assert.equal(actual.width, 60, 'pixels are rotated');
		assert.equal(actual.height, 120);
	});

	it('passes through already-optimized source bytes instead of re-encoding', async () => {
		// A JPEG already compressed harder than this package would compress it, with
		// no metadata and no geometry change needed. Re-encoding could only cost CPU
		// and a generation of quality for no byte saving.
		const optimized = await preOptimizedJpeg(300, 200);
		assert.equal((await probe(optimized)).hasExif, false, 'fixture must carry no metadata');
		const result = await processor.process(optimized, {
			outputs: [{ key: 'normalized', format: 'source', width: 2560, height: 2560 }]
		});
		const output = result.byKey.normalized!;
		assert.equal(output.reencoded, false);
		assert.equal(output.byteLength, optimized.byteLength);
		assert.equal(output.width, 300);
		assert.equal(output.height, 200);
	});

	it('never passes through bytes that still carry EXIF', async () => {
		// Passthrough skips the metadata strip, so a source with EXIF must always be
		// re-encoded even when no geometry change is needed. Otherwise a camera
		// photo would republish its GPS coordinates.
		const withExif = await quadrantImage({
			width: 300,
			height: 200,
			format: 'jpeg',
			orientation: 1
		});
		assert.equal((await probe(withExif)).hasExif, true, 'fixture must carry EXIF');
		const result = await processor.process(withExif, {
			outputs: [{ key: 'normalized', format: 'source', width: 2560, height: 2560 }]
		});
		assert.equal(result.byKey.normalized!.reencoded, true);
		assert.equal((await probe(result.byKey.normalized!.bytes)).hasExif, false);
	});

	it('re-encodes when it genuinely reduces bytes', async () => {
		// A large low-entropy JPEG saved at quality 100 compresses much further.
		const bloated = await solidImage(1200, 900, 'jpeg');
		const result = await processor.process(bloated, {
			outputs: [{ key: 'normalized', format: 'source', width: 600, height: 600 }]
		});
		assert.equal(result.byKey.normalized!.reencoded, true);
		assert.equal(result.byKey.normalized!.width, 600);
	});
});

describe('recipe validation', () => {
	let processor: MediaProcessor;
	before(() => {
		processor = createProcessor();
	});

	it('rejects structurally invalid recipes before any decoding', async () => {
		const image = await solidImage(100, 100, 'jpeg');
		const invalid: Array<Record<string, unknown>> = [
			{ outputs: [] },
			{ outputs: [{ key: '', format: 'webp' }] },
			{ outputs: [{ key: 'a', format: 'gif' }] },
			{ outputs: [{ key: 'a', format: 'webp', width: 0 }] },
			{ outputs: [{ key: 'a', format: 'webp', width: 1.5 }] },
			{ outputs: [{ key: 'a', format: 'webp', quality: 0 }] },
			{ outputs: [{ key: 'a', format: 'webp', quality: 101 }] },
			{ outputs: [{ key: 'a', format: 'webp', fit: 'fill' }] },
			// `cover` without both edges has no defined target box.
			{ outputs: [{ key: 'a', format: 'webp', width: 100, fit: 'cover' }] },
			// Duplicate keys would silently overwrite each other in `byKey`.
			{
				outputs: [
					{ key: 'dup', format: 'webp' },
					{ key: 'dup', format: 'png' }
				]
			}
		];
		for (const recipe of invalid) {
			await rejectsWithCode(() => processor.process(image, recipe as never), 'invalid_recipe');
		}
	});

	it('enforces the output count and edge ceilings', async () => {
		const limited = createProcessor({ limits: { maxOutputs: 2, maxOutputEdge: 1000 } });
		const image = await solidImage(100, 100, 'jpeg');
		await rejectsWithCode(
			() =>
				limited.process(image, {
					outputs: [
						{ key: 'a', format: 'webp' },
						{ key: 'b', format: 'webp' },
						{ key: 'c', format: 'webp' }
					]
				}),
			'invalid_recipe'
		);
		await rejectsWithCode(
			() => limited.process(image, { outputs: [{ key: 'a', format: 'webp', width: 2000 }] }),
			'invalid_recipe'
		);
	});
});

describe('job atomicity', () => {
	it('returns every output or throws, never a partial set', async () => {
		const processor = createProcessor({ limits: { maxOutputEdge: 4096 } });
		const image = await noiseImage(400, 300, 'jpeg');
		const result = await processor.process(image, {
			outputs: [
				{ key: 'a', format: 'webp', width: 200 },
				{ key: 'b', format: 'webp', width: 100 },
				{ key: 'c', format: 'jpeg', width: 50 }
			]
		});
		assert.equal(result.outputs.length, 3);
		assert.deepEqual(
			result.outputs.map((o) => o.key),
			['a', 'b', 'c']
		);
		for (const output of result.outputs) assert.ok(output.byteLength > 0);
	});

	it('never returns source bytes after a processing failure', async () => {
		const jpeg = await noiseImage(300, 300, 'jpeg');
		const truncated = jpeg.subarray(0, Math.floor(jpeg.length * 0.3));
		const processor = createProcessor();
		await rejectsWithCode(() => processor.process(truncated, webImageV1()), 'invalid_image');
	});
});

describe('presets', () => {
	it('web-image-v1 produces normalized, preview and thumb', async () => {
		const image = await noiseImage(3000, 2000, 'jpeg');
		const result = await processImage(image, webImageV1());
		assert.deepEqual(
			result.outputs.map((o) => o.key),
			['normalized', 'preview', 'thumb']
		);
		assert.equal(result.byKey.normalized!.width, 2560);
		assert.equal(result.byKey.normalized!.format, 'jpeg', 'keeps the source codec');
		assert.equal(result.byKey.preview!.width, 1600);
		assert.equal(result.byKey.preview!.format, 'webp');
		assert.equal(result.byKey.thumb!.width, 480);
		assert.equal(result.byKey.thumb!.format, 'webp');
		// Each smaller derivative must actually be smaller on disk.
		assert.ok(result.byKey.thumb!.byteLength < result.byKey.preview!.byteLength);
	});

	it('student-photo-v1 produces an exact square from a crop', async () => {
		const image = await quadrantImage({ width: 800, height: 600, format: 'jpeg' });
		const result = await processImage(
			image,
			studentPhotoV1({ left: 100, top: 50, width: 300, height: 300 })
		);
		const photo = result.byKey.photo!;
		assert.equal(photo.width, 420);
		assert.equal(photo.height, 420);
		assert.equal(photo.format, 'webp');
		assert.equal(photo.cropped, true);
	});

	it('student-photo-v1 reaches exact dimensions from an undersized crop', async () => {
		// Layout depends on a fixed 420x420 asset, so this preset opts into upscale.
		const image = await quadrantImage({ width: 400, height: 400, format: 'jpeg' });
		const result = await processImage(
			image,
			studentPhotoV1({ left: 0, top: 0, width: 200, height: 200 })
		);
		assert.equal(result.byKey.photo!.width, 420);
		assert.equal(result.byKey.photo!.height, 420);
	});
});

describe('result reporting', () => {
	it('reports source facts and timing alongside outputs', async () => {
		const processor = createProcessor();
		const image = await noiseImage(500, 250, 'png');
		const result = await processor.process(image, {
			outputs: [{ key: 'out', format: 'webp', width: 100 }]
		});
		assert.equal(result.source.format, 'png');
		assert.equal(result.source.width, 500);
		assert.equal(result.source.orientedWidth, 500);
		assert.equal(result.source.byteLength, image.byteLength);
		assert.ok(result.durationMs >= 0);
		assert.ok(result.queueWaitMs >= 0);
		assert.equal(Object.keys(result.byKey).length, result.outputs.length);
	});
});

describe('chroma policy', () => {
	it('does not inflate a 4:2:0 photograph by inventing chroma detail', async () => {
		const processor = createProcessor();
		// Camera JPEGs are almost always 4:2:0. Encoding the derivative at 4:4:4
		// would add colour resolution the pixels never had, and cost bytes for it.
		const photo = await noiseImage(900, 600, 'jpeg');
		assert.equal((await probe(photo)).chromaSubsampling, '4:2:0', 'fixture assumption');
		const result = await processor.process(photo, {
			outputs: [{ key: 'out', format: 'jpeg', width: 900, height: 600 }]
		});
		assert.equal((await probe(result.byKey.out!.bytes)).chromaSubsampling, '4:2:0');
	});

	it('keeps full chroma when the source is lossless', async () => {
		const processor = createProcessor();
		// A PNG source may be a screenshot or diagram, where subsampling would blur
		// text and flat colour edges.
		const graphic = await quadrantImage({ width: 400, height: 400, format: 'png' });
		const result = await processor.process(graphic, {
			outputs: [{ key: 'out', format: 'jpeg', width: 400, height: 400 }]
		});
		assert.equal((await probe(result.byKey.out!.bytes)).chromaSubsampling, '4:4:4');
	});
});
