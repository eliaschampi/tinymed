import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProcessor, isMediaError, webImageV1 } from '../src/index.js';
import { noiseImage, solidImage } from './fixtures.js';

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

describe('capacity', () => {
	it('rejects work beyond the queued-job budget', async () => {
		// One active job, no queue: everything arriving while busy is refused.
		const processor = createProcessor({
			capacity: { maxActiveJobs: 1, maxQueuedJobs: 0 }
		});
		const image = await noiseImage(1200, 900, 'jpeg');
		const recipe = webImageV1();

		const settled = await Promise.allSettled([
			processor.process(image, recipe),
			processor.process(image, recipe),
			processor.process(image, recipe)
		]);

		const fulfilled = settled.filter((r) => r.status === 'fulfilled');
		const rejected = settled.filter((r) => r.status === 'rejected');
		assert.equal(fulfilled.length, 1, 'exactly one job should run');
		assert.equal(rejected.length, 2);
		for (const failure of rejected) {
			assert.ok(isMediaError(failure.reason, 'capacity_exceeded'));
			// Capacity is transient, so callers need to know a retry is sensible.
			assert.equal(failure.reason.retryable, true);
		}
		assert.equal(processor.metrics().rejectedJobs, 2);
	});

	it('rejects work beyond the queued-byte budget', async () => {
		const image = await noiseImage(1000, 800, 'jpeg');
		// Room for a generous number of jobs, but only for a fraction of the bytes
		// those jobs would retain. The byte budget must bind first.
		const processor = createProcessor({
			capacity: {
				maxActiveJobs: 1,
				maxQueuedJobs: 50,
				maxQueuedBytes: Math.floor(image.byteLength * 1.5)
			}
		});
		const recipe = { outputs: [{ key: 'thumb', format: 'webp' as const, width: 200 }] };

		const settled = await Promise.allSettled(
			Array.from({ length: 6 }, () => processor.process(image, recipe))
		);
		const rejected = settled.filter((r) => r.status === 'rejected');
		assert.ok(rejected.length > 0, 'the byte budget must refuse some work');
		for (const failure of rejected) {
			assert.ok(isMediaError(failure.reason, 'capacity_exceeded'));
		}
		// Everything admitted must have completed successfully.
		for (const success of settled.filter((r) => r.status === 'fulfilled')) {
			assert.equal(success.value.outputs.length, 1);
		}
	});

	it('queues within budget and drains without loss', async () => {
		const processor = createProcessor({
			capacity: { maxActiveJobs: 1, maxQueuedJobs: 8 }
		});
		const image = await noiseImage(600, 400, 'jpeg');
		const recipe = { outputs: [{ key: 'thumb', format: 'webp' as const, width: 120 }] };

		const results = await Promise.all(
			Array.from({ length: 6 }, () => processor.process(image, recipe))
		);
		assert.equal(results.length, 6);
		for (const result of results) assert.equal(result.byKey.thumb!.width, 120);

		const metrics = processor.metrics();
		assert.equal(metrics.completedJobs, 6);
		assert.equal(metrics.rejectedJobs, 0);
		assert.equal(metrics.activeJobs, 0, 'no job may remain active');
		assert.equal(metrics.queuedJobs, 0);
		assert.equal(metrics.queuedBytes, 0, 'the byte budget must be fully released');
	});

	it('never exceeds the active-job limit', async () => {
		const processor = createProcessor({
			capacity: { maxActiveJobs: 2, maxQueuedJobs: 20 }
		});
		const image = await noiseImage(800, 600, 'jpeg');
		const recipe = { outputs: [{ key: 'o', format: 'webp' as const, width: 200 }] };

		let peakActive = 0;
		const observe = setInterval(() => {
			peakActive = Math.max(peakActive, processor.metrics().activeJobs);
		}, 1);
		await Promise.all(Array.from({ length: 10 }, () => processor.process(image, recipe)));
		clearInterval(observe);

		assert.ok(peakActive <= 2, `active jobs peaked at ${peakActive}, limit is 2`);
	});

	it('reports queue wait separately from processing duration', async () => {
		const processor = createProcessor({
			capacity: { maxActiveJobs: 1, maxQueuedJobs: 4 }
		});
		const image = await noiseImage(1400, 1000, 'jpeg');
		const recipe = webImageV1();

		const [first, second] = await Promise.all([
			processor.process(image, recipe),
			processor.process(image, recipe)
		]);

		assert.ok(first !== undefined && second !== undefined);
		// The queued job waited; a saturated queue must not be misreported as slow
		// image processing.
		const queued = second.queueWaitMs > first.queueWaitMs ? second : first;
		assert.ok(queued.queueWaitMs > 0, 'the second job must record a wait');
		assert.ok(queued.durationMs > 0);
		assert.ok(processor.metrics().peakQueueWaitMs > 0);
	});
});

describe('cancellation and timeout', () => {
	it('rejects immediately when the signal is already aborted', async () => {
		const processor = createProcessor();
		const image = await solidImage(100, 100, 'jpeg');
		await rejectsWithCode(
			() =>
				processor.process(
					image,
					{ outputs: [{ key: 'o', format: 'webp' }] },
					{ signal: AbortSignal.abort() }
				),
			'cancelled'
		);
	});

	it('releases the byte budget when a queued job is abandoned', async () => {
		const processor = createProcessor({
			capacity: { maxActiveJobs: 1, maxQueuedJobs: 4 }
		});
		const image = await noiseImage(1200, 900, 'jpeg');
		const recipe = webImageV1();
		const controller = new AbortController();

		const active = processor.process(image, recipe);
		const abandoned = processor.process(image, recipe, { signal: controller.signal });
		controller.abort();

		await assert.rejects(abandoned, (error: unknown) => isMediaError(error, 'cancelled'));
		await active;

		// A caller that gives up while waiting must not hold budget until its turn.
		const metrics = processor.metrics();
		assert.equal(metrics.queuedBytes, 0);
		assert.equal(metrics.queuedJobs, 0);
	});

	it('reports a deadline overrun as a timeout, not a cancellation', async () => {
		// A 1 ms deadline cannot survive a real decode plus encode.
		const processor = createProcessor({ capacity: { timeoutMs: 1 } });
		const image = await noiseImage(2400, 1800, 'jpeg');
		await rejectsWithCode(
			() => processor.process(image, webImageV1()),
			'processing_timeout'
		);
		assert.equal(processor.metrics().timedOutJobs, 1);
	});

	it('distinguishes a caller abort from a deadline overrun', async () => {
		const processor = createProcessor({ capacity: { timeoutMs: 60_000 } });
		const image = await noiseImage(2400, 1800, 'jpeg');
		const controller = new AbortController();
		const pending = processor.process(image, webImageV1(), { signal: controller.signal });
		controller.abort();
		await assert.rejects(pending, (error: unknown) => isMediaError(error, 'cancelled'));
		assert.equal(processor.metrics().timedOutJobs, 0);
	});

	it('honours a per-job timeout override', async () => {
		const processor = createProcessor({ capacity: { timeoutMs: 60_000 } });
		const image = await noiseImage(2400, 1800, 'jpeg');
		await rejectsWithCode(
			() => processor.process(image, webImageV1(), { timeoutMs: 1 }),
			'processing_timeout'
		);
	});
});

describe('processor isolation', () => {
	it('gives each instance an independent budget', async () => {
		const strict = createProcessor({ capacity: { maxActiveJobs: 1, maxQueuedJobs: 0 } });
		const relaxed = createProcessor({ capacity: { maxActiveJobs: 1, maxQueuedJobs: 10 } });
		const image = await noiseImage(900, 700, 'jpeg');
		const recipe = { outputs: [{ key: 'o', format: 'webp' as const, width: 150 }] };

		const settled = await Promise.allSettled([
			strict.process(image, recipe),
			strict.process(image, recipe),
			relaxed.process(image, recipe),
			relaxed.process(image, recipe)
		]);

		assert.equal(settled[0]!.status, 'fulfilled');
		assert.equal(settled[1]!.status, 'rejected', 'the strict queue must refuse');
		assert.equal(settled[2]!.status, 'fulfilled');
		assert.equal(settled[3]!.status, 'fulfilled', 'the relaxed queue is unaffected');
		assert.equal(relaxed.metrics().rejectedJobs, 0);
	});

	it('validates configuration eagerly', () => {
		assert.throws(() => createProcessor({ limits: { maxPixels: 0 } }), RangeError);
		assert.throws(() => createProcessor({ capacity: { maxActiveJobs: 0 } }), RangeError);
		assert.throws(() => createProcessor({ limits: { maxChannels: 1.5 } }), RangeError);
	});

	it('exposes the resolved limits and capacity it will enforce', () => {
		const processor = createProcessor({
			limits: { maxPixels: 1_000_000 },
			capacity: { maxActiveJobs: 3 }
		});
		assert.equal(processor.limits.maxPixels, 1_000_000);
		assert.equal(processor.capacity.maxActiveJobs, 3);
		// Unspecified values fall back to the documented defaults.
		assert.equal(processor.limits.maxChannels, 4);
	});
});
