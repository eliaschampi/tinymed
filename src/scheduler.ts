import { MediaError, fail } from './errors.js';
import type { MediaCapacity } from './limits.js';

/** Bounded FIFO scheduler for logical image jobs. */
export interface MediaMetrics {
	readonly activeJobs: number;
	readonly queuedJobs: number;
	readonly queuedBytes: number;
	readonly completedJobs: number;
	readonly failedJobs: number;
	readonly rejectedJobs: number;
	readonly timedOutJobs: number;
	readonly peakQueueWaitMs: number;
	readonly peakQueuedBytes: number;
}

export interface JobTiming {
	readonly queueWaitMs: number;
	readonly durationMs: number;
}

export interface JobRequest {
	/** Encoded bytes retained while this job waits. */
	readonly cost: number;
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

	// Reserve the slot before resolving a waiter; resumed microtasks must not oversubscribe it.
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

	// Admission and slot reservation happen synchronously to avoid a microtask race.
	const admit = (cost: number, signal: AbortSignal | undefined): Promise<void> | null => {
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
			if (pending !== null) await pending;

			const startedAt = performance.now();
			const queueWaitMs = startedAt - enqueuedAt;
			if (queueWaitMs > peakQueueWaitMs) peakQueueWaitMs = queueWaitMs;

			const controller = new AbortController();
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
				const durationMs = performance.now() - startedAt;

				// Native work can outlive an abort signal; success is checked again at the result boundary.
				if (!callerAborted && durationMs >= timeoutMs) controller.abort();
				if (controller.signal.aborted) {
					throw new MediaError('cancelled', 'Processing was cancelled');
				}

				completedJobs++;
				return { value, timing: { queueWaitMs, durationMs } };
			} catch (cause) {
				failedJobs++;
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
