# @tinymed/media

Turns untrusted encoded raster bytes into validated, deterministic, optimized encoded outputs.

One source image in, a complete set of verified derivatives out. Nothing else: no storage, no
transport, no authorization, no domain state.

```ts
import { processImage, webImageV1 } from '@tinymed/media';

const result = await processImage(uploadedBytes, webImageV1(), {
	declaredMime: 'image/jpeg'
});

for (const output of result.outputs) {
	// output.bytes, output.width, output.height are facts about the encoded file.
	await store(output.key, output.bytes);
}
```

## Why

Several applications had each grown their own Sharp pipeline for the same job — validate an upload,
fix its orientation, crop it, resize it, emit WebP derivatives. The duplicates drifted: different
codec settings, different limits, one that regenerated derivatives on the first public request, one
whose concurrency gate wrapped two native pipelines in a single slot, and `srcset` descriptors
derived from requested dimensions instead of actual ones.

This package is the single owner of that policy. Applications keep everything that is genuinely
theirs.

## Install

```sh
pnpm add @tinymed/media
```

Node 22 or newer. Sharp is the only runtime dependency, and it stays private — no Sharp type crosses
the public boundary, so the engine can be replaced without touching consumer code.

## Contract

```text
application
  -> encoded bytes + declared MIME + recipe
  -> @tinymed/media
  -> validated source facts + encoded outputs + actual output geometry
  -> application storage / database / HTTP
```

Processing order is fixed and cannot be reordered by a caller:

```text
byte limit -> format detection -> declared MIME check -> metadata -> pixel/page/channel limits
  -> EXIF orientation -> optional crop -> resize -> encode -> verify
```

Input: JPEG, PNG, WebP, AVIF, single page. Rejected: malformed, truncated, MIME-spoofed, animated,
over-limit, and anything else. SVG and GIF are outside the untrusted raster contract.

## API

Three entry points.

```ts
inspectImage(input, options?): Promise<MediaSource>;
processImage(input, recipe, options?): Promise<MediaResult>;
createProcessor(config?): MediaProcessor;
```

`inspectImage` reads headers only, so it is cheap enough to run before deciding whether to accept an
upload.

```ts
const source = await inspectImage(bytes, { declaredMime: file.type });
// source.orientedWidth / orientedHeight — the coordinate space for any crop
```

`processImage` runs one logical job. Either every requested output is produced, or a `MediaError` is
thrown and nothing is returned. There is no partial result.

`createProcessor` gives a workload its own capacity budget and limits, so an interactive upload path
and a bulk backfill do not starve each other.

```ts
const backfill = createProcessor({
	capacity: { maxActiveJobs: 1, maxQueuedJobs: 64 },
	limits: { maxInputBytes: 16 * 1024 * 1024 }
});
```

## Recipes

A recipe is data describing wanted outputs, not a transformation graph.

```ts
await processImage(bytes, {
	crop: { left: 120, top: 40, width: 800, height: 800 },
	outputs: [
		{ key: 'normalized', format: 'source', width: 2560, height: 2560, fit: 'inside' },
		{ key: 'card', format: 'webp', width: 400, height: 400, fit: 'cover' }
	]
});
```

`fit: 'inside'` preserves aspect ratio within the box; `cover` fills the box exactly and requires
both edges. Upscaling is refused unless `allowUpscale` is set. Omitting both dimensions keeps the
post-crop geometry and re-encodes.

Versioned presets keep independent applications from drifting apart again:

| Preset             | Outputs                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `webImageV1()`     | `normalized` 2560 source format, `preview` 1600 WebP, `thumb` 480 WebP |
| `catalogV1(crop?)` | `normalized` 2560, `large` 1600, `medium` 960, `thumb` 480 WebP   |
| `studentPhotoV1(crop)` | `photo` exactly 420x420 WebP, crop required                  |

A released preset is a frozen policy. A materially different policy becomes a new version.

## Outputs are facts

```ts
interface MediaOutput {
	key: string;
	bytes: Uint8Array;
	mime: string;
	format: 'jpeg' | 'png' | 'webp' | 'avif';
	width: number; // actual encoded width
	height: number; // actual encoded height
	byteLength: number;
	oriented: boolean;
	cropped: boolean;
	resized: boolean;
	reencoded: boolean;
}
```

Read geometry from the output, never from the recipe. A portrait photo resized into a 1600 box is
1200 wide, so `1600w` in a `srcset` would be a lie the browser acts on:

```ts
const srcset = result.outputs.map((o) => `${url(o.key)} ${o.width}w`).join(', ');
```

`reencoded: false` means the original bytes passed through unchanged, because re-encoding an
already-optimized upload would have cost quality for no byte saving. It never happens for a source
carrying EXIF or a colour profile: those must be stripped, which requires a re-encode.

## Crop

Crop coordinates are integer pixels of the **auto-oriented** source — the image as a user sees it,
which is what a cropping UI measured against. The library validates the rectangle and executes it
authoritatively.

```ts
const source = await inspectImage(bytes);
// UI works in source.orientedWidth x source.orientedHeight
```

Order is always orient, crop, resize, encode.

## Errors

Every failure is a `MediaError` with a stable `code`. Branch on the code; never parse messages.

```ts
import { isMediaError } from '@tinymed/media';

try {
	await processImage(bytes, webImageV1());
} catch (error) {
	if (isMediaError(error)) {
		if (error.retryable) return retryLater();
		return reject(error.code); // 'mime_mismatch', 'invalid_crop', ...
	}
	throw error;
}
```

| Code | Meaning | Typical response |
| --- | --- | --- |
| `input_too_large` | encoded bytes above the ceiling | 413 |
| `unsupported_format` | not JPEG/PNG/WebP/AVIF | 415 |
| `mime_mismatch` | declared type contradicts the bytes | 415 |
| `invalid_image` | malformed, truncated or corrupt | 400 |
| `pixel_limit_exceeded` | decoded resolution above the ceiling | 413 |
| `channel_limit_exceeded` | too many bands | 400 |
| `multi_page_not_supported` | animated or multi-page | 415 |
| `invalid_crop` | non-integer, empty or out of bounds | 400 |
| `invalid_recipe` | structurally invalid request | 400 |
| `capacity_exceeded` | queue budget full, `retryable` | 503 + `Retry-After` |
| `processing_timeout` | deadline exceeded, `retryable` | 504 |
| `cancelled` | caller aborted | client disconnect |
| `processing_failed` | encoding failed | 500 |

Messages are static and log-safe: no paths, no personal data, no native diagnostics, no image
contents. Safe numeric context lives in `error.details`.

## Capacity

One source plus all of its outputs is one logical job. A processor bounds active jobs, queued jobs,
queued encoded bytes and execution time.

```ts
const media = createProcessor({
	capacity: {
		maxActiveJobs: 1, // predictable peak RSS first, throughput after measurement
		maxQueuedJobs: 16,
		maxQueuedBytes: 128 * 1024 * 1024,
		timeoutMs: 30_000,
		libvipsConcurrency: 1
	}
});
```

Queued bytes are bounded because a queue that only counts callbacks says nothing about the memory
they retain: ten waiting 20 MB uploads are 200 MB of live buffers. A batch loop should `await` each
job and treat `capacity_exceeded` as backpressure.

Outputs within a job are generated sequentially. `Promise.all([thumb, preview])` looks like one job
but starts several native pipelines, each holding its own decoded frame, so peak memory would scale
with output count instead of with the configured job limit.

```ts
media.metrics();
// { activeJobs, queuedJobs, queuedBytes, completedJobs, failedJobs,
//   rejectedJobs, timedOutJobs, peakQueueWaitMs, peakQueuedBytes }
```

`result.queueWaitMs` and `result.durationMs` are reported separately, so a saturated queue is never
misread as slow image processing.

## Limits

| Limit | Default | Purpose |
| --- | --- | --- |
| `maxInputBytes` | 32 MiB | refuse before any decode |
| `maxPixels` | 50,000,000 | primary memory guard; covers any real camera frame |
| `maxChannels` | 4 | reject pathological band counts |
| `maxOutputs` | 8 | bound work per job |
| `maxOutputEdge` | 8192 | bound output allocation |

## Boundaries

Owned here: encoded-size limits, format detection, declared-MIME verification, metadata inspection,
pixel/page/channel limits, EXIF orientation, crop validation and execution, resize, encode, versioned
presets, bounded scheduling, typed errors, actual output metadata.

Never owned here: authentication, authorization, storage paths, filesystem writes, databases, HTTP
responses, cache headers, publication rules, public file serving, CDN or queue infrastructure, or any
application framework.

## Documentation

- [docs/architecture.md](docs/architecture.md) — internal structure and the reasoning behind it
- [docs/security.md](docs/security.md) — untrusted-input handling and every enforced limit
- [docs/benchmark-methodology.md](docs/benchmark-methodology.md) — how to measure, and measured results
- [docs/integration.md](docs/integration.md) — adopting the package in an application

## Development

```sh
pnpm install
pnpm check   # typecheck
pnpm lint
pnpm test    # 63 behavioural tests
pnpm bench   # complete-job benchmark
pnpm build
```

Test fixtures are generated in code rather than committed as binaries, so every image's intent is
readable. Dropping real photographs into `examples/` enables an additional corpus suite.

## License

MIT
