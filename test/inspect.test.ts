// oxlint-disable no-await-in-loop -- Fixtures are generated and asserted
// sequentially on purpose: it keeps failures attributable to one input and
// keeps peak memory low while large images are built.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createProcessor, inspectImage, isMediaError, type MediaProcessor } from '../src/index.js';
import { animatedWebp, noiseImage, quadrantImage, solidImage } from './fixtures.js';

/** Asserts that `run` rejects with a specific `MediaError` code. */
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

describe('format detection', () => {
	it('detects each supported format from its bytes', async () => {
		for (const format of ['jpeg', 'png', 'webp', 'avif'] as const) {
			const bytes = await solidImage(64, 48, format);
			const source = await inspectImage(bytes);
			assert.equal(source.format, format, `${format} misdetected`);
			assert.equal(source.width, 64);
			assert.equal(source.height, 48);
		}
	});

	it('reports byte length and alpha from the real image', async () => {
		const opaque = await quadrantImage({ width: 40, height: 40, format: 'png' });
		const transparent = await quadrantImage({ width: 40, height: 40, format: 'png', alpha: true });
		assert.equal((await inspectImage(opaque)).hasAlpha, false);
		assert.equal((await inspectImage(transparent)).hasAlpha, true);
		assert.equal((await inspectImage(opaque)).byteLength, opaque.byteLength);
	});

	it('rejects formats outside the supported set', async () => {
		// A valid GIF header; deliberately outside the untrusted raster contract.
		const gif = Buffer.from('474946383961010001000000210000002c00000000010001000002003b', 'hex');
		await rejectsWithCode(() => inspectImage(gif), 'unsupported_format');
		// An SVG document is text, not a raster container.
		const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
		await rejectsWithCode(() => inspectImage(svg), 'unsupported_format');
	});

	it('rejects empty and undersized input', async () => {
		await rejectsWithCode(() => inspectImage(new Uint8Array(0)), 'invalid_image');
		await rejectsWithCode(() => inspectImage(new Uint8Array([0xff, 0xd8])), 'unsupported_format');
	});
});

describe('declared MIME verification', () => {
	it('accepts a matching MIME and its common aliases', async () => {
		const jpeg = await solidImage(32, 32, 'jpeg');
		for (const declaredMime of ['image/jpeg', 'IMAGE/JPEG', 'image/jpg', 'image/jpeg; charset=x']) {
			const source = await inspectImage(jpeg, { declaredMime });
			assert.equal(source.mime, 'image/jpeg');
		}
	});

	it('rejects a spoofed MIME', async () => {
		const png = await solidImage(32, 32, 'png');
		await rejectsWithCode(() => inspectImage(png, { declaredMime: 'image/jpeg' }), 'mime_mismatch');
	});

	it('trusts detected bytes over a renamed extension', async () => {
		// The classic upload attack: PNG bytes presented as a JPEG.
		const png = await solidImage(32, 32, 'png');
		const source = await inspectImage(png);
		assert.equal(source.format, 'png');
		assert.equal(source.mime, 'image/png');
	});
});

describe('structural validation', () => {
	it('rejects bytes whose header cannot be parsed', async () => {
		// A correct JPEG signature followed by noise.
		const spoofed = Buffer.concat([
			Buffer.from([0xff, 0xd8, 0xff]),
			Buffer.from('not actually an image payload at all')
		]);
		await rejectsWithCode(() => inspectImage(spoofed), 'invalid_image');
	});

	it('rejects truncated bytes when processing decodes them', async () => {
		// Truncation is invisible to a header read: the dimensions sit near the
		// start of the file. `inspect` therefore accepts it, and the decode during
		// `process` is what rejects it — still as bad input, never as our failure.
		const jpeg = await noiseImage(200, 200, 'jpeg');
		const truncated = jpeg.subarray(0, Math.floor(jpeg.length * 0.4));
		const source = await inspectImage(truncated);
		assert.equal(source.width, 200, 'header remains readable');

		const processor = createProcessor();
		await rejectsWithCode(
			() => processor.process(truncated, { outputs: [{ key: 'out', format: 'webp' }] }),
			'invalid_image'
		);
	});

	it('rejects animated input', async () => {
		const animated = await animatedWebp();
		await rejectsWithCode(() => inspectImage(animated), 'multi_page_not_supported');
	});

	it('enforces the encoded byte ceiling before decoding', async () => {
		const processor = createProcessor({ limits: { maxInputBytes: 1024 } });
		const large = await noiseImage(300, 300, 'jpeg');
		assert.ok(large.byteLength > 1024, 'fixture must exceed the configured ceiling');
		await rejectsWithCode(() => processor.inspect(large), 'input_too_large');
	});

	it('enforces the decoded pixel ceiling', async () => {
		const processor = createProcessor({ limits: { maxPixels: 1000 } });
		const image = await solidImage(100, 100, 'jpeg');
		await rejectsWithCode(() => processor.inspect(image), 'pixel_limit_exceeded');
	});

	it('enforces the channel ceiling', async () => {
		const processor = createProcessor({ limits: { maxChannels: 3 } });
		const rgba = await quadrantImage({ width: 20, height: 20, format: 'png', alpha: true });
		await rejectsWithCode(() => processor.inspect(rgba), 'channel_limit_exceeded');
	});

	it('carries safe numeric context and leaks nothing sensitive', async () => {
		const processor = createProcessor({ limits: { maxPixels: 1000 } });
		try {
			await processor.inspect(await solidImage(100, 100, 'jpeg'));
			assert.fail('expected rejection');
		} catch (error) {
			assert.ok(isMediaError(error, 'pixel_limit_exceeded'));
			assert.equal(error.details.pixels, 10_000);
			assert.equal(error.details.limit, 1000);
			assert.equal(error.retryable, false);
			// Messages are logged verbatim, so they must stay free of paths and data.
			assert.doesNotMatch(error.message, /\//);
			assert.equal(error.name, 'MediaError');
		}
	});
});

describe('orientation reporting', () => {
	let processor: MediaProcessor;
	before(() => {
		processor = createProcessor();
	});

	it('exposes oriented dimensions as the crop coordinate space', async () => {
		// Orientations 5-8 transpose the image; 1-4 do not.
		for (const orientation of [1, 2, 3, 4]) {
			const image = await quadrantImage({ width: 200, height: 100, format: 'jpeg', orientation });
			const source = await processor.inspect(image);
			assert.equal(source.orientation, orientation);
			assert.equal(source.orientedWidth, 200, `orientation ${orientation}`);
			assert.equal(source.orientedHeight, 100, `orientation ${orientation}`);
		}
		for (const orientation of [5, 6, 7, 8]) {
			const image = await quadrantImage({ width: 200, height: 100, format: 'jpeg', orientation });
			const source = await processor.inspect(image);
			assert.equal(source.orientation, orientation);
			assert.equal(source.width, 200, `orientation ${orientation} stored width`);
			assert.equal(source.orientedWidth, 100, `orientation ${orientation} oriented width`);
			assert.equal(source.orientedHeight, 200, `orientation ${orientation} oriented height`);
		}
	});

	it('defaults to orientation 1 when no EXIF tag is present', async () => {
		const source = await processor.inspect(await solidImage(50, 30, 'png'));
		assert.equal(source.orientation, 1);
		assert.equal(source.orientedWidth, 50);
		assert.equal(source.orientedHeight, 30);
	});
});
