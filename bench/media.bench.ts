// oxlint-disable no-await-in-loop -- Sequential awaits are the measurement:
// parallel loading or parallel jobs would distort both latency and peak RSS.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
	createProcessor,
	studentPhotoV1,
	webImageV1,
	type MediaProcessor,
	type MediaRecipe
} from '../src/index.js';

/**
 * Complete-job benchmark harness.
 *
 * Measures whole jobs — validate, decode, orient, crop, resize, encode every
 * output — because that is the unit production pays for. An isolated resize
 * microbenchmark hides decode cost, encoder cost and native memory, which are
 * the parts that actually decide capacity on a small VPS.
 *
 * The headline number is peak RSS under batch load, not throughput. Throughput
 * only matters once memory behaviour is predictable.
 *
 * Usage:
 *   pnpm bench
 *   pnpm bench -- --iterations 20 --active 2 --libvips 2
 */

interface Options {
	readonly iterations: number;
	readonly active: number;
	readonly libvips: number;
	readonly batch: number;
}

function parseOptions(argv: readonly string[]): Options {
	const read = (flag: string, fallback: number): number => {
		const index = argv.indexOf(`--${flag}`);
		if (index === -1) return fallback;
		const value = Number(argv[index + 1]);
		return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
	};
	return {
		iterations: read('iterations', 10),
		active: read('active', 1),
		libvips: read('libvips', 1),
		batch: read('batch', 10)
	};
}

interface Sample {
	readonly name: string;
	readonly bytes: Buffer;
	readonly megapixels: number;
}

/**
 * Builds the corpus.
 *
 * Real photographs are used when available; the synthetic tail covers the
 * high-resolution sizes the sample set lacks. Deterministic noise keeps encoded
 * sizes realistic — solid colours would compress to almost nothing and make
 * every measurement optimistic.
 */
async function buildCorpus(): Promise<Sample[]> {
	const samples: Sample[] = [];
	const dir = new URL('../examples/', import.meta.url).pathname;

	try {
		const names = (await readdir(dir))
			.filter((n) => /\.(jpe?g|png|webp|avif)$/i.test(n))
			.toSorted();
		for (const name of names) {
			const bytes = await readFile(join(dir, name));
			const meta = await sharp(bytes).metadata();
			samples.push({
				name,
				bytes,
				megapixels: ((meta.width ?? 0) * (meta.height ?? 0)) / 1e6
			});
		}
	} catch {
		// No corpus directory; synthetic samples alone still produce a valid run.
	}

	for (const [width, height] of [
		[4000, 3000],
		[6000, 4000],
		[8000, 6000]
	] as const) {
		samples.push({
			name: `synthetic-${width}x${height}`,
			bytes: await noise(width, height),
			megapixels: (width * height) / 1e6
		});
	}

	return samples;
}

async function noise(width: number, height: number): Promise<Buffer> {
	const raw = Buffer.alloc(width * height * 3);
	let seed = 0x2f6e2b1;
	for (let i = 0; i < raw.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		raw[i] = (seed >>> 16) & 0xff;
	}
	return sharp(raw, { raw: { width, height, channels: 3 } })
		.jpeg({ quality: 88 })
		.toBuffer();
}

interface Stats {
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly mean: number;
}

function stats(values: readonly number[]): Stats {
	const sorted = values.toSorted((a, b) => a - b);
	const at = (q: number): number =>
		sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	return {
		p50: at(0.5),
		p95: at(0.95),
		p99: at(0.99),
		mean: sorted.reduce((sum, v) => sum + v, 0) / (sorted.length || 1)
	};
}

const ms = (value: number): string => `${value.toFixed(1)}ms`;
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MiB`;

/** Peak RSS observed while `run` executes; the primary capacity metric. */
async function measure<T>(
	run: () => Promise<T>
): Promise<{ value: T; peakRss: number; ms: number }> {
	let peakRss = process.memoryUsage.rss();
	const poll = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage.rss());
	}, 5);
	const startedAt = performance.now();
	try {
		const value = await run();
		return { value, peakRss, ms: performance.now() - startedAt };
	} finally {
		clearInterval(poll);
	}
}

interface WorkloadResult {
	readonly name: string;
	readonly jobs: number;
	readonly latency: Stats;
	readonly jobsPerSecond: number;
	readonly peakRss: number;
	readonly eventLoopP99: number;
	readonly outputBytes: number;
}

async function runWorkload(
	name: string,
	processor: MediaProcessor,
	jobs: ReadonlyArray<() => Promise<{ durationMs: number; outputBytes: number }>>,
	concurrent: boolean
): Promise<WorkloadResult> {
	const histogram = monitorEventLoopDelay({ resolution: 1 });
	histogram.enable();

	const latencies: number[] = [];
	let outputBytes = 0;

	const measured = await measure(async () => {
		if (concurrent) {
			const settled = await Promise.all(jobs.map((job) => job()));
			for (const item of settled) {
				latencies.push(item.durationMs);
				outputBytes += item.outputBytes;
			}
			return;
		}
		for (const job of jobs) {
			// oxlint-disable-next-line no-await-in-loop
			const item = await job();
			latencies.push(item.durationMs);
			outputBytes += item.outputBytes;
		}
	});

	histogram.disable();

	return {
		name,
		jobs: jobs.length,
		latency: stats(latencies),
		jobsPerSecond: jobs.length / (measured.ms / 1000),
		peakRss: measured.peakRss,
		eventLoopP99: histogram.percentile(99) / 1e6,
		outputBytes
	};
}

function jobFactory(
	processor: MediaProcessor,
	bytes: Buffer,
	recipe: MediaRecipe
): () => Promise<{ durationMs: number; outputBytes: number }> {
	return async () => {
		const result = await processor.process(bytes, recipe, { declaredMime: 'image/jpeg' });
		return {
			durationMs: result.durationMs + result.queueWaitMs,
			outputBytes: result.outputs.reduce((sum, o) => sum + o.byteLength, 0)
		};
	};
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const corpus = await buildCorpus();
	const processor = createProcessor({
		// Pure-noise synthetic JPEGs are an unrealistically incompressible worst
		// case and exceed the package default byte ceiling. The benchmark raises the
		// ceiling deliberately so the corpus reaches the 50 MP decode boundary.
		limits: { maxInputBytes: 64 * 1024 * 1024 },
		capacity: {
			maxActiveJobs: options.active,
			libvipsConcurrency: options.libvips,
			maxQueuedJobs: 1000,
			maxQueuedBytes: 1024 * 1024 * 1024,
			timeoutMs: 300_000
		}
	});

	console.log('# @tinymed/media benchmark');
	console.log(
		`node ${process.version} | sharp ${sharp.versions.sharp} | libvips ${sharp.versions.vips}`
	);
	console.log(
		`activeJobs=${options.active} libvipsConcurrency=${options.libvips} iterations=${options.iterations}`
	);
	console.log(`\n## corpus (${corpus.length} images)`);
	for (const sample of corpus) {
		console.log(
			`  ${sample.name.padEnd(24)} ${sample.megapixels.toFixed(1).padStart(5)} MP  ${mib(sample.bytes.byteLength).padStart(9)}`
		);
	}

	const results: WorkloadResult[] = [];
	const primary = corpus[0];
	if (primary === undefined) throw new Error('corpus is empty');

	// Inspection only: the cost of validating an upload we may reject.
	results.push(
		await runWorkload(
			'inspect',
			processor,
			Array.from({ length: options.iterations }, () => async () => {
				const startedAt = performance.now();
				await processor.inspect(primary.bytes);
				return { durationMs: performance.now() - startedAt, outputBytes: 0 };
			}),
			false
		)
	);

	// One source, three outputs: the standard upload path.
	results.push(
		await runWorkload(
			'web-image-v1',
			processor,
			Array.from({ length: options.iterations }, () =>
				jobFactory(processor, primary.bytes, webImageV1())
			),
			false
		)
	);

	// Crop adds an extract stage before every resize.
	const cropped = await processor.inspect(primary.bytes);
	const cropSize = Math.min(cropped.orientedWidth, cropped.orientedHeight);
	results.push(
		await runWorkload(
			'web-image-v1 + crop',
			processor,
			Array.from({ length: options.iterations }, () =>
				jobFactory(processor, primary.bytes, {
					...webImageV1(),
					crop: { left: 0, top: 0, width: cropSize, height: cropSize }
				})
			),
			false
		)
	);

	results.push(
		await runWorkload(
			'student-photo-v1',
			processor,
			Array.from({ length: options.iterations }, () =>
				jobFactory(
					processor,
					primary.bytes,
					studentPhotoV1({ left: 0, top: 0, width: cropSize, height: cropSize })
				)
			),
			false
		)
	);

	// Sequential batch across the whole corpus, repeated to reach `batch` jobs.
	const batchJobs = Array.from({ length: options.batch }, (_, index) => {
		const sample = corpus[index % corpus.length]!;
		return jobFactory(processor, sample.bytes, webImageV1());
	});
	results.push(await runWorkload(`batch x${options.batch}`, processor, batchJobs, false));

	// Same batch submitted at once: exercises the queue and shows whether peak RSS
	// stays bounded by the scheduler rather than by arrival rate.
	results.push(await runWorkload(`concurrent batch x${options.batch}`, processor, batchJobs, true));

	console.log('\n## results');
	console.log(
		`${'workload'.padEnd(28)}${'jobs'.padStart(5)}${'p50'.padStart(10)}${'p95'.padStart(10)}${'p99'.padStart(10)}${'jobs/s'.padStart(9)}${'peak RSS'.padStart(11)}${'loop p99'.padStart(10)}`
	);
	for (const result of results) {
		console.log(
			result.name.padEnd(28) +
				String(result.jobs).padStart(5) +
				ms(result.latency.p50).padStart(10) +
				ms(result.latency.p95).padStart(10) +
				ms(result.latency.p99).padStart(10) +
				result.jobsPerSecond.toFixed(2).padStart(9) +
				mib(result.peakRss).padStart(11) +
				ms(result.eventLoopP99).padStart(10)
		);
	}

	const metrics = processor.metrics();
	console.log('\n## processor metrics');
	console.log(
		`  completed=${metrics.completedJobs} failed=${metrics.failedJobs} rejected=${metrics.rejectedJobs} timedOut=${metrics.timedOutJobs}`
	);
	console.log(
		`  peakQueueWait=${ms(metrics.peakQueueWaitMs)} peakQueuedBytes=${mib(metrics.peakQueuedBytes)}`
	);

	console.log('\n## output sizes (web-image-v1)');
	for (const sample of corpus) {
		const result = await processor.process(sample.bytes, webImageV1());
		const parts = result.outputs
			.map((o) => `${o.key} ${o.width}x${o.height} ${(o.byteLength / 1024).toFixed(0)}KiB`)
			.join('  ');
		console.log(`  ${sample.name.padEnd(24)} ${parts}`);
	}

	console.log(
		`\npeak RSS overall: ${mib(Math.max(...results.map((r) => r.peakRss)))} (the number that decides VPS capacity)`
	);
}

await main();
