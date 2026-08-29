import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProcessor, isMediaError } from '../src/index.js';
import { DEFAULT_CAPACITY } from '../src/limits.js';
import { createScheduler } from '../src/scheduler.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('terminal cancellation semantics', () => {
	it('cannot return success after the execution deadline has passed', async () => {
		const scheduler = createScheduler({ ...DEFAULT_CAPACITY, timeoutMs: 5 });

		await assert.rejects(
			() =>
				scheduler.run({ cost: 1 }, async () => {
					await sleep(20);
					return 'late-success';
				}),
			(error: unknown) => isMediaError(error, 'processing_timeout')
		);

		const metrics = scheduler.metrics();
		assert.equal(metrics.completedJobs, 0);
		assert.equal(metrics.failedJobs, 1);
		assert.equal(metrics.timedOutJobs, 1);
	});

	it('cannot return success after the caller aborts an in-flight task', async () => {
		const scheduler = createScheduler({ ...DEFAULT_CAPACITY, timeoutMs: 1_000 });
		const controller = new AbortController();
		const pending = scheduler.run({ cost: 1, signal: controller.signal }, async () => {
			await sleep(20);
			return 'late-success';
		});

		setTimeout(() => controller.abort(), 5);

		await assert.rejects(pending, (error: unknown) => isMediaError(error, 'cancelled'));
		assert.equal(scheduler.metrics().completedJobs, 0);
		assert.equal(scheduler.metrics().failedJobs, 1);
	});

	it('cannot return success if the caller aborted between dequeue and execution', async () => {
		const scheduler = createScheduler({ ...DEFAULT_CAPACITY, maxActiveJobs: 1, timeoutMs: 1_000 });

		let release!: () => void;
		const first = scheduler.run(
			{ cost: 1 },
			() => new Promise<string>((resolve) => (release = () => resolve('first')))
		);

		const controller = new AbortController();
		const second = scheduler.run(
			{ cost: 1, signal: controller.signal },
			async () => 'late-success'
		);

		release();
		queueMicrotask(() => controller.abort());

		await first;
		await assert.rejects(second, (error: unknown) => isMediaError(error, 'cancelled'));
		assert.equal(scheduler.metrics().completedJobs, 1);
		assert.equal(scheduler.metrics().failedJobs, 1);
		assert.equal(scheduler.metrics().timedOutJobs, 0);
	});
});

describe('process-wide engine configuration', () => {
	it('rejects conflicting libvips concurrency instead of silently ignoring it', () => {
		createProcessor({ capacity: { libvipsConcurrency: 1 } });
		assert.doesNotThrow(() => createProcessor({ capacity: { libvipsConcurrency: 1 } }));
		assert.throws(
			() => createProcessor({ capacity: { libvipsConcurrency: 2 } }),
			(error: unknown) => error instanceof RangeError && /process-wide/.test(error.message)
		);
	});
});
