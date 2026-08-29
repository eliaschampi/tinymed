import { configureEngine, renderOutput, type RenderPlan } from './engine/sharp.js';
import { fail } from './errors.js';
import { inspectSource } from './inspect.js';
import {
	FORMAT_MIME,
	MIN_REDUCTION_RATIO,
	resolveCapacity,
	resolveLimits,
	type MediaCapacity,
	type MediaLimits,
	type MediaProcessorConfig
} from './limits.js';
import {
	assertCropWithinSource,
	planRecipe,
	resolveOutputFormat,
	type PlannedOutput
} from './recipe.js';
import { createScheduler, type MediaMetrics } from './scheduler.js';
import type {
	MediaCrop,
	MediaInput,
	MediaInspectOptions,
	MediaOutput,
	MediaProcessOptions,
	MediaRecipe,
	MediaResult,
	MediaSource
} from './types.js';

/** One limit set and one JavaScript scheduling budget. */
export interface MediaProcessor {
	/** Validates bytes and returns authoritative facts. Decodes no pixels. */
	inspect(input: MediaInput, options?: MediaInspectOptions): Promise<MediaSource>;
	/** Runs one logical job: all outputs succeed, or the job fails. */
	process(
		input: MediaInput,
		recipe: MediaRecipe,
		options?: MediaProcessOptions
	): Promise<MediaResult>;
	/** Non-sensitive queue and throughput counters. */
	metrics(): MediaMetrics;
	readonly limits: MediaLimits;
	readonly capacity: MediaCapacity;
}

export function createProcessor(config: MediaProcessorConfig = {}): MediaProcessor {
	const limits = resolveLimits(config.limits);
	const capacity = resolveCapacity(config.capacity);
	const scheduler = createScheduler(capacity);
	configureEngine(capacity.libvipsConcurrency);

	return {
		limits,
		capacity,
		metrics: scheduler.metrics,

		async inspect(input, options = {}) {
			throwIfAborted(options.signal);
			const { source } = await inspectSource(input, limits, options.declaredMime);
			return source;
		},

		async process(input, recipe, options = {}) {
			throwIfAborted(options.signal);

			const planned = planRecipe(recipe, limits);
			if (!(input instanceof Uint8Array) || input.byteLength === 0) {
				fail(
					'invalid_image',
					input instanceof Uint8Array ? 'Input is empty' : 'Input must be a Uint8Array'
				);
			}
			if (input.byteLength > limits.maxInputBytes) {
				fail('input_too_lare', 'Encoded input exceeds the maximum allowed size', {
					byteLength: input.byteLength,
					limit: limits.maxInputBytes
				});
			}

			const { value, timing } = await scheduler.run(
				{ cost: input.byteLength, timeoutMs: options.timeoutMs, signal: options.signal },
				async (signal) => {
					const inspected = await inspectSource(input, limits, options.declaredMime);
					const { source } = inspected;
					if (planned.crop !== null) {
						assertCropWithinSource(planned.crop, source.orientedWidth, source.orientedHeight);
					}
					const outputs = await renderAll(input, source, planned.crop, planned.outputs, {
						hasIccProfile: inspected.hasIccProfile,
						hasStrippableMetadata: inspected.hasStrippableMetadata,
						fullChroma: inspected.fullChroma,
						maxPixels: limits.maxPixels,
						signal
					});
					return { source, outputs };
				}
			);

			const byKey: Record<string, MediaOutput> = {};
			for (const output of value.outputs) byKey[output.key] = output;

			return Object.freeze({
				source: value.source,
				outputs: Object.freeze(value.outputs),
				byKey: Object.freeze(byKey),
				queueWaitMs: timing.queueWaitMs,
				durationMs: timing.durationMs
			});
		}
	};
}

interface RenderContext {
	readonly hasIccProfile: boolean;
	readonly hasStrippableMetadata: boolean;
	readonly fullChroma: boolean;
	readonly maxPixels: number;
	readonly signal: AbortSignal;
}

/** Sequential output rendering keeps native decoded-frame memory bounded per logical job. */
async function renderAll(
	input: MediaInput,
	source: MediaSource,
	crop: MediaCrop | null,
	specs: readonly PlannedOutput[],
	context: RenderContext
): Promise<MediaOutput[]> {
	const baseWidth = crop?.width ?? source.orientedWidth;
	const baseHeight = crop?.height ?? source.orientedHeight;

	const outputs: MediaOutput[] = [];
	for (const spec of specs) {
		throwIfAborted(context.signal);

		const format = resolveOutputFormat(spec.format, source.format);
		const plan: RenderPlan = {
			format,
			quality: spec.quality,
			crop,
			width: spec.width,
			height: spec.height,
			fit: spec.fit,
			allowUpscale: spec.allowUpscale,
			convertIcc: context.hasIccProfile,
			fullChroma: context.fullChroma,
			maxPixels: context.maxPixels
		};

		// oxlint-disable-next-line no-await-in-loop -- parallel outputs multiply native memory.
		const rendered = await renderOutput(input, plan, outputs.length === 0);

		// Source passthrough is safe only when geometry and metadata require no rewrite.
		const untouched =
			spec.format === 'source' &&
			crop === null &&
			source.orientation === 1 &&
			!context.hasStrippableMetadata &&
			rendered.width === source.width &&
			rendered.height === source.height;
		const worthwhile = rendered.bytes.byteLength / source.byteLength <= MIN_REDUCTION_RATIO;

		if (untouched && !worthwhile) {
			outputs.push(
				Object.freeze({
					key: spec.key,
					bytes: input,
					mime: source.mime,
					format: source.format,
					width: source.width,
					height: source.height,
					byteLength: source.byteLength,
					oriented: false,
					cropped: false,
					resized: false,
					reencoded: false
				})
			);
			continue;
		}

		outputs.push(
			Object.freeze({
				key: spec.key,
				bytes: rendered.bytes,
				mime: FORMAT_MIME[format],
				format,
				width: rendered.width,
				height: rendered.height,
				byteLength: rendered.bytes.byteLength,
				oriented: source.orientation !== 1,
				cropped: crop !== null,
				resized: rendered.width !== baseWidth || rendered.height !== baseHeight,
				reencoded: true
			})
		);
	}

	return outputs;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) fail('cancelled', 'Processing was cancelled');
}
