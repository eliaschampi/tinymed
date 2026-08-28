import { MediaError, fail } from './errors.js';
import type { MediaCapacity } from './limits.js';

/**
 * Bounded FIFO scheduler for logical image jobs.
 *
 * One source image plus every output requested from it is one job. Admission is
 * gated on two independent budgets — waiting job count and waiting encoded
 * bytes — because a queue that only counts callbacks says nothing about the
 * memory those callbacks retain. Ten queued 20 MB uploads are 200 MB of live
 * buffers regardless of how few promises represent them.
 */

/** Non-sensitive counters for logging and benchmarking. */
export interface MediaMetrics {
	readonly activeJobs: number;
	readonly queuedJobs: number;
	readonly queuedBytes: number;
	readonly completedJobs: number;
	readonly failedJobs: number;
	/** Jobs refused at admission because a budget was full. */
	readonly rejectedJobs: number;
	readonly timedOutJobs: number;
	/** Longest queue wait observed, in milliseconds. */
	readonly peakQueueWaitMs: number;
	readonly peakQueuedBytes: number;
}

/** Timing captured for one executed job. */
export interface JobTiming {
	readonly queueWaitMs: number;
	readonly durationMs: number;
}

export interface JobRequest {
	/** Encoded bytes this job retains while waiting; charged to the byte budget. */
	readonly cost: number;
	/** Per-job execution deadline. Falls back to the processor default. */
	readonly timeoutMs?: number | undefined;
	readonly signal?: AbortSignal | undefined;
}

export interface Scheduler {
	run<T>(
		request: JobRequest,
		task: (signal: AbortSignal) => Promise<T>
	): Promise<{ value: T; timing: JobTiming }>;
	metrics(): MediaMetrics;
}

interface Waiter {
	readonly cost: number;
	readonly start: () => void;
	readonly reject: (error: unknown) => void;
	readonly onAbort: (() => void) | null;
	readonly signal: AbortSignal | undefined;
}

export function createScheduler(capacity: MediaCapacity): Scheduler {
	let activeJobs = 0;
	let queuedBytes = 0;
	let completedJobs = 0;
	let failedJobs = 0;
	let rejectedJobs = 0;
	let timedOutJobs = 0;
	let peakQueueWaitMs = 0;
	let peakQueuedBytes = 0;

	const waiting: Waiter[] = [];

	/**
	 * Promotes waiters while slots are free, in arrival order.
	 *
	 * The slot is reserved here, synchronously, before the waiter's continuation
	 * is scheduled. Resolving first and letting the resumed job increment the
	 * counter would let several waiters claim the same slot.
	 */
	const pump = (): void => {
		while (activeJobs < capacity.maxActiveJobs && waiting.length > 0) {
			const next = waiting.shift();
			if (next === undefined) return;
			queuedBytes -= next.cost;
			if (next.onAbort !== null) next.signal?.removeEventListener('abort', next.onAbort);
			activeJobs++;
			next.start();
		}
	};

	/**
	 * Reserves a slot, or enqueues until one frees up.
	 *
	 * Returns `null` when a slot was taken immediately, so the caller can skip the
	 * `await` entirely. That matters for correctness as much as speed: awaiting an
	 * already-resolved promise yields to the microtask queue, and every job
	 * admitted in that window would observe a stale `activeJobs` and overshoot the
	 * limit. Admission therefore always decides and reserves in one synchronous
	 * turn.
	 */
	const admit = (cost: number, signal: AbortSignal | undefined): Promise<void> | null => {
		// Jumping the queue would starve waiters, so the fast path also requires an
		// empty queue.
		if (activeJobs < capacity.maxActiveJobs && waiting.length === 0) {
			activeJobs++;
			return null;
		}
		if (waiting.length >= capacity.maxQueuedJobs) {
			rejectedJobs++;
			fail('capacity_exceeded', 'Too many image jobs are queued', {
				queuedJobs: waiting.length,
				limit: capacity.maxQueuedJobs
			});
		}
		if (queuedBytes + cost > capacity.maxQueuedBytes) {
			rejectedJobs++;
			fail('capacity_exceeded', 'Queued image bytes exceed the allowed budget', {
				queuedBytes,
				additionalBytes: cost,
				limit: capacity.maxQueuedBytes
			});
		}

		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				cost,
				start: resolve,
				reject,
				// A caller who gives up while waiting must release its byte budget
				// immediately rather than at its eventual turn.
				onAbort:
					signal === undefined
						? null
						: () => {
								const index = waiting.indexOf(waiter);
								if (index === -1) return;
								waiting.splice(index, 1);
								queuedBytes -= cost;
								reject(new MediaError('cancelled', 'Processing was cancelled'));
							},
				signal
			};
			waiting.push(waiter);
			queuedBytes += cost;
			if (queuedBytes > peakQueuedBytes) peakQueuedBytes = queuedBytes;
			if (waiter.onAbort !== null) {
				signal?.addEventListener('abort', waiter.onAbort, { once: true });
			}
		});
	};

	return {
		async run<T>(
			request: JobRequest,
			task: (signal: AbortSignal) => Promise<T>
		): Promise<{ value: T; timing: JobTiming }> {
			const { cost, signal } = request;
			const timeoutMs = request.timeoutMs ?? capacity.timeoutMs;
			if (signal?.aborted === true) {
				fail('cancelled', 'Processing was cancelled');
			}

			const enqueuedAt = performance.now();
			const pending = admit(cost, signal);
			// From here the slot is reserved, so every path must reach the `finally`
			// that releases it.
			if (pending !== null) await pending;

			const startedAt = performance.now();
			const queueWaitMs = startedAt - enqueuedAt;
			if (queueWaitMs > peakQueueWaitMs) peakQueueWaitMs = queueWaitMs;

			// The deadline covers execution only. Queue wait is reported separately
			// so a saturated queue is never misread as slow image processing.
			const controller = new AbortController();
			// Recording the caller abort as it happens is more reliable than reading
			// `signal.aborted` afterwards, and keeps the two abort sources distinct.
			let callerAborted = false;
			const abortOuter = (): void => {
				callerAborted = true;
				controller.abort();
			};
			let timer: NodeJS.Timeout | undefined;

			try {
				signal?.addEventListener('abort', abortOuter, { once: true });
				timer = setTimeout(() => controller.abort(), timeoutMs);
				const value = await task(controller.signal);
				completedJobs++;
				return { value, timing: { queueWaitMs, durationMs: performance.now() - startedAt } };
			} catch (cause) {
				failedJobs++;
				// The task only ever reports `cancelled`; deciding whether that was
				// the caller or our own deadline belongs here, where both are known.
				if (controller.signal.aborted && !callerAborted) {
					timedOutJobs++;
					throw new MediaError('processing_timeout', 'Image processing timed out', { timeoutMs });
				}
				throw cause;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener('abort', abortOuter);
				activeJobs--;
				pump();
			}
		},

		metrics(): MediaMetrics {
			return {
				activeJobs,
				queuedJobs: waiting.length,
				queuedBytes,
				completedJobs,
				failedJobs,
				rejectedJobs,
				timedOutJobs,
				peakQueueWaitMs,
				peakQueuedBytes
			};
		}
	};
}
