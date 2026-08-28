// oxlint-disable no-await-in-loop -- Fixtures are generated and asserted
// sequentially on purpose: it keeps failures attributable to one input and
// keeps peak memory low while large images are built.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { createProcessor, studentPhotoV1, webImageV1, type MediaProcessor } from '../src/index.js';
import { probe } from './fixtures.js';

/**
 * Behaviour against real photographs.
 *
 * Synthetic fixtures pin down geometry and error handling, but they cannot show
 * how the package behaves on genuine camera output: real EXIF blocks, real
 * entropy, and real byte sizes. These assertions run against the sample corpus
 * when it is present, and are skipped in a published checkout where it is not.
 */

const CORPUS_DIR = new URL('../examples/', import.meta.url).pathname;

async function loadCorpus(): Promise<Array<{ name: string; bytes: Buffer }>> {
	try {
		const names = (await readdir(CORPUS_DIR)).filter((n) => /\.(jpe?g|png|webp|avif)$/i.test(n));
		return Promise.all(
			names
				.toSorted()
				.map(async (name) => ({ name, bytes: await readFile(join(CORPUS_DIR, name)) }))
		);
	} catch {
		return [];
	}
}

const corpus = await loadCorpus();

describe('real photograph corpus', { skip: corpus.length === 0 ? 'no examples/ corpus' : false }, () => {
	let processor: MediaProcessor;
	before(() => {
		processor = createProcessor();
	});

	it('inspects every sample as a valid supported image', async () => {
		for (const { name, bytes } of corpus) {
			const source = await processor.inspect(bytes, { declaredMime: 'image/jpeg' });
			assert.equal(source.format, 'jpeg', name);
			assert.ok(source.width > 0 && source.height > 0, name);
			assert.equal(source.byteLength, bytes.byteLength, name);
		}
	});

	it('produces a complete, self-consistent derivative set', async () => {
		for (const { name, bytes } of corpus) {
			const result = await processor.process(bytes, webImageV1());
			assert.equal(result.outputs.length, 3, name);

			for (const output of result.outputs) {
				// Reported geometry must match the encoded file, not the request.
				const actual = await probe(output.bytes);
				assert.equal(actual.width, output.width, `${name}/${output.key} width`);
				assert.equal(actual.height, output.height, `${name}/${output.key} height`);
				assert.equal(output.byteLength, output.bytes.byteLength, `${name}/${output.key} bytes`);
				assert.ok(output.width <= 2560 && output.height <= 2560, `${name}/${output.key} bounded`);
			}

			const { thumb, preview, normalized } = result.byKey;
			assert.ok(thumb !== undefined && preview !== undefined && normalized !== undefined);
			assert.ok(
				thumb.byteLength < preview.byteLength,
				`${name}: thumb must be smaller than preview`
			);
			assert.equal(Math.max(thumb.width, thumb.height), 480, name);
			assert.equal(preview.format, 'webp', name);
		}
	});

	it('strips EXIF from outputs of photos that carry it', async () => {
		const withExif: string[] = [];
		for (const { name, bytes } of corpus) {
			if ((await probe(bytes)).hasExif) withExif.push(name);
		}
		assert.ok(withExif.length > 0, 'corpus should include photos with EXIF metadata');

		for (const { name, bytes } of corpus) {
			const result = await processor.process(bytes, webImageV1());
			for (const output of result.outputs) {
				// Camera EXIF can carry GPS coordinates and device serial numbers.
				// A web derivative must never republish them.
				assert.equal((await probe(output.bytes)).hasExif, false, `${name}/${output.key} EXIF`);
			}
		}
	});

	it('reports the true width of portrait derivatives', async () => {
		const portraits = corpus.filter(async ({ bytes }) => {
			const p = await probe(bytes);
			return p.height > p.width;
		});
		assert.ok(portraits.length > 0);

		for (const { name, bytes } of corpus) {
			const source = await processor.inspect(bytes);
			if (source.orientedHeight <= source.orientedWidth) continue;

			const result = await processor.process(bytes, webImageV1());
			const preview = result.byKey.preview!;
			// The preset asks for a 1600 box. A portrait photo fills it vertically,
			// so advertising "1600w" in a srcset would overstate the real width by a
			// third and make the browser pick the wrong candidate.
			assert.equal(preview.height, 1600, name);
			assert.ok(preview.width < 1600, `${name}: actual width must be below the box`);
			assert.equal(
				preview.width,
				Math.round((source.orientedWidth / source.orientedHeight) * 1600),
				`${name}: width must follow the true aspect ratio`
			);
		}
	});

	it('crops a real photograph to an exact square', async () => {
		const first = corpus[0]!;
		const source = await processor.inspect(first.bytes);
		const size = Math.min(source.orientedWidth, source.orientedHeight);
		const result = await processor.process(
			first.bytes,
			studentPhotoV1({
				left: Math.floor((source.orientedWidth - size) / 2),
				top: 0,
				width: size,
				height: size
			})
		);
		const photo = result.byKey.photo!;
		assert.equal(photo.width, 420);
		assert.equal(photo.height, 420);
		const actual = await probe(photo.bytes);
		assert.equal(actual.width, 420);
		assert.equal(actual.height, 420);
	});

	it('processes the corpus as a bounded batch without loss', async () => {
		const bounded = createProcessor({
			capacity: { maxActiveJobs: 1, maxQueuedJobs: corpus.length, libvipsConcurrency: 1 }
		});
		const results = await Promise.all(
			corpus.map(({ bytes }) => bounded.process(bytes, webImageV1()))
		);

		assert.equal(results.length, corpus.length);
		for (const result of results) assert.equal(result.outputs.length, 3);

		const metrics = bounded.metrics();
		assert.equal(metrics.completedJobs, corpus.length);
		assert.equal(metrics.rejectedJobs, 0);
		assert.equal(metrics.activeJobs, 0);
		assert.equal(metrics.queuedBytes, 0, 'all queued bytes must be released');
		// A real batch must have exercised the queue, not just the fast path.
		assert.ok(metrics.peakQueuedBytes > 0, 'batch should have queued work');
	});

	it('shrinks real photographs substantially', async () => {
		for (const { name, bytes } of corpus) {
			const result = await processor.process(bytes, webImageV1());
			const thumb = result.byKey.thumb!;
			// A 480px WebP thumbnail of a multi-megapixel photo should be a small
			// fraction of the original; this guards against a silent quality or
			// resize regression.
			assert.ok(
				thumb.byteLength < bytes.byteLength * 0.2,
				`${name}: thumb is ${thumb.byteLength}B against a ${bytes.byteLength}B source`
			);
		}
	});
});
