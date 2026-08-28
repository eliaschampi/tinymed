# Tinymed Media Library — Final Implementation Plan

Status: implementation-ready plan.

## Decision

Build an independent server-side Node.js image-processing library named `@tinymed/media`.

Production v1 uses:

- Node.js + TypeScript + ESM
- Sharp/libvips as the only production dependency
- in-process deployment
- one private native implementation

Do not build a Rust binary, Go service, daemon, CLI, or media microservice for v1.

The previous Rust-versus-Node uncertainty was a decision bias, not a requirement. The expensive image work is already native through libvips. An in-process Node package gives the simplest integration, the lowest operational cost, and the best enforcement point for byte, pixel, crop, scheduling, and output contracts. A Rust-backed engine remains a benchmark challenger only if it proves a material end-to-end improvement behind the same public contract.

## Problem being solved

Coedula and Faztore currently solve the same media problem separately:

- Drive image uploads
- batch uploads
- resize/normalization
- WebP derivatives such as thumb and preview
- crop in Coedula student photos
- high-quality product/catalog images in Faztore
- future reuse by Aeduca-like projects

The prior implementations also exposed architectural defects:

- duplicated codec policy between applications
- derivative generation regressions after unapproved extraction
- public Faztore requests able to perform image work
- broad catches that could preserve invalid images
- concurrency gates that undercount native Sharp/libvips work
- queued jobs retaining large encoded buffers
- responsive image metadata derived from requested dimensions instead of actual output dimensions

This plan replaces those local implementations with one small, reusable, measurable library.

## Goal

`@tinymed/media` converts untrusted encoded raster bytes into validated, deterministic, optimized encoded outputs.

The complete boundary is:

```text
application
  -> encoded image bytes + declared MIME + recipe/crop
  -> @tinymed/media
  -> validated source metadata + encoded outputs + actual output metadata
  -> application storage/database/HTTP/domain logic
```

The library owns only image bytes and image-processing policy. It never owns application state.

## Non-negotiable boundaries

`@tinymed/media` owns:

- encoded-size limits
- actual format detection
- declared MIME verification
- structural metadata inspection
- decoded pixel/page/channel limits
- EXIF auto-orientation
- validated crop execution
- resize and encode execution
- versioned recipes/presets
- bounded logical-job scheduling
- typed media errors
- actual output metadata

`@tinymed/media` must not own:

- authentication or authorization
- Drive policy
- product or student business rules
- database reads/writes
- storage roots or filesystem path policy
- HTTP responses, cache headers, ETags, or disposition
- publication eligibility
- public file serving
- SvelteKit or Lumi
- object storage, CDN, or queue infrastructure

Lumi remains presentation-only. Consumers remain responsible for storing files, selecting URLs, and applying permissions.

## Supported v1 input

Accepted static raster formats:

```text
JPEG
PNG
WebP
AVIF
```

Reject:

- malformed or truncated images
- MIME spoofing
- unsupported formats
- animated or multi-page images
- decoded images above the configured pixel limit
- invalid crop geometry
- recipes requiring unsupported behavior

SVG and GIF are outside the untrusted raster contract.

The initial decoded-image ceiling is:

```text
50,000,000 pixels
```

Define one package default encoded-byte ceiling after reviewing current Coedula and Faztore upload requirements. Applications may still apply smaller upload limits.

## Fixed processing order

Consumers cannot reorder the pipeline:

```text
encoded bytes
  -> encoded byte limit
  -> actual format detection
  -> declared MIME verification
  -> metadata inspection
  -> pixel/page/channel validation
  -> EXIF auto-orientation
  -> optional crop
  -> resize
  -> encode
  -> output verification
  -> encoded outputs + actual metadata
```

Never silently preserve or return invalid source bytes after processing failure.

## Crop contract

Crop is part of v1 because Coedula already needs it and Faztore may need it later.

Crop coordinates are integer source pixels in the auto-oriented image coordinate system:

```ts
type MediaCrop = {
  left: number;
  top: number;
  width: number;
  height: number;
};
```

Order is always:

```text
orient -> crop -> resize -> encode
```

The UI may calculate an interactive crop rectangle, but the server-side library validates bounds and executes the authoritative crop.

## Public API

Keep the public surface small:

```ts
inspectImage(input, options?)
processImage(input, recipe, options?)
createProcessor(config?)
```

Conceptual types:

```ts
type MediaInput = Uint8Array;

type MediaInspectOptions = {
  declaredMime?: string;
  signal?: AbortSignal;
};

type MediaProcessOptions = MediaInspectOptions & {
  // deadline, tracing id, and processor overrides if needed
};

type MediaRecipe = {
  crop?: MediaCrop;
  outputs: MediaOutputSpec[];
};

type MediaOutputSpec = {
  key: string;
  format: 'jpeg' | 'png' | 'webp' | 'avif' | 'source';
  width?: number;
  height?: number;
  fit?: 'inside' | 'cover';
  quality?: number;
  allowUpscale?: boolean;
};
```

Every output returns facts, not requested assumptions:

```ts
type MediaOutput = {
  key: string;
  bytes: Uint8Array;
  mime: string;
  format: 'jpeg' | 'png' | 'webp' | 'avif';
  width: number;
  height: number;
  byteLength: number;
  oriented: boolean;
  cropped: boolean;
  resized: boolean;
  reencoded: boolean;
};
```

No Sharp object, Sharp type, filesystem path, URL, database entity, or application domain model crosses the public boundary.

## Recipe model

A recipe is declarative data, not a transformation graph or DSL.

Allowed v1 geometry:

```text
inside
cover
```

Do not add arbitrary filters, blur, watermarking, compositing, color effects, or operation graphs until a real consumer requires them.

Validate recipes before processing. Invalid recipes fail deterministically.

## Shared presets

Provide one versioned shared web preset so Coedula and Faztore cannot drift:

```text
web-image-v1

normalized:
  max edge: 2560
  format: source
  fit: inside

preview:
  max edge: 1600
  format: webp
  fit: inside

thumb:
  max edge: 480
  format: webp
  fit: inside
```

Also provide a narrow student-photo preset:

```text
student-photo-v1

output:
  420 x 420
  format: webp
  fit: cover
  crop: required
```

If Faztore catalog SEO requires different dimensions or quality later, define `catalog-v1` explicitly instead of mutating application code.

Quality values are chosen initially from the current Coedula/Faztore behavior, then finalized through fixture comparison, output-size measurement, and visual review.

## Scheduling and backpressure

One source image plus all requested outputs is one logical job.

The processor must bound:

- active logical jobs
- queued jobs
- queued encoded bytes
- processing time

Start with predictable memory behavior:

```text
active logical jobs: 1
output generation inside a job: sequential
libvips concurrency: 1
```

Then benchmark on the target Debian VPS before increasing concurrency or parallelizing outputs.

Do not treat `Promise.all([thumb, preview])` as bounded native work. That pattern can multiply native memory and thread usage while appearing as one JavaScript job.

Capacity exhaustion returns a stable retryable media error. Batch upload loops must await capacity rather than accumulating unbounded buffers.

## Error contract

Expose stable, typed media errors. Consumers branch on codes and map them to HTTP/UI behavior.

Required codes:

```text
input_too_large
unsupported_format
mime_mismatch
invalid_image
pixel_limit_exceeded
channel_limit_exceeded
multi_page_not_supported
invalid_crop
invalid_recipe
capacity_exceeded
processing_timeout
cancelled
processing_failed
```

Errors must not leak filesystem paths, personal data, native panic output, or raw image contents.

## Output metadata and responsive images

Consumers must store and use actual output dimensions.

For responsive images:

```text
srcset width descriptor = actual encoded width
```

Do not derive `480w` or `1600w` from a requested longest-edge value when the encoded portrait image may have a smaller actual width.

## Consumer integration rules

### Coedula

Coedula owns:

- Drive authorization and ACLs
- student ownership
- upload and quota limits
- storage roots and path construction
- atomic file placement and cleanup
- database records
- HTTP response and delivery policy

Use `web-image-v1` for Drive image uploads and `student-photo-v1` for student photo crops.

Migration requirements:

1. Restore eager derivative generation.
2. Generate normalized, preview, and thumb outputs during upload.
3. Move crop execution through the shared pipeline.
4. Replace every local Sharp pipeline atomically.
5. Delete the old codec kernel and local concurrency gate in the same cutover.
6. Never perform first-view transformation.

### Faztore

Faztore owns:

- admin authorization
- product and publication rules
- product-media storage and paths
- database records and public eligibility
- ETag/cache/status behavior
- Node streaming or internal Nginx redirect
- repair/backfill orchestration

Use `web-image-v1` for Drive images. Use `web-image-v1` or a versioned `catalog-v1` preset for product media if catalog requirements differ.

Migration requirements:

1. Generate all required catalog outputs during admin upload/replacement.
2. Treat missing required derivatives as an incomplete upload or publication blocker.
3. Remove all image processing from the anonymous public runtime.
4. Ensure the public runtime cannot import Sharp or `@tinymed/media`.
5. Public GET only verifies eligibility and streams an existing immutable asset.
6. Missing public derivatives trigger telemetry and authenticated repair/backfill.
7. Store actual output dimensions and use them for srcset.

### Aeduca and future consumers

Do not distort v1 for hypothetical non-Node consumers.

A future Node consumer should use the package directly. If a non-Node consumer later proves a real need, evaluate a separate adapter at that time. The media contract remains reusable regardless.

## Internal architecture

Keep the implementation vertical and small:

```text
src/
  index.ts
  inspect.ts
  process.ts
  recipe.ts
  presets.ts
  limits.ts
  scheduler.ts
  errors.ts
  engine/
    sharp.ts
```

`engine/sharp.ts` is an internal implementation boundary, not a plugin system.

Do not create:

```text
Engine
EngineFactory
EngineRegistry
SharpEngine
RustEngine
Plugin
AdapterFactory
```

until a second production engine actually exists.

Replaceability comes from clean ownership and a small public contract, not speculative abstraction.

## Testing requirements

Build golden behavioral fixtures for:

- JPEG EXIF orientations 1-8
- portrait, landscape, and square images
- 2-5 MP, 12 MP, 24 MP, and near-50 MP inputs
- transparent and opaque PNG
- WebP and AVIF
- already-optimized sources
- crop correctness and invalid crop bounds
- `inside` and `cover` geometry
- upscale prevention
- alpha preservation
- all supported output formats
- malformed, truncated, corrupt, and MIME-spoofed input
- encoded-byte and decoded-pixel limits
- multi-page input rejection
- multi-output job atomicity
- queued-job and queued-byte capacity
- stable error codes
- actual output dimensions and byte lengths

Crop fixtures must make orientation/coordinate mistakes visually and numerically obvious.

## Benchmark gate

Run benchmarks on target-like Debian infrastructure with the same Node version and a 4 GB memory constraint.

Corpus and workloads must represent production:

```text
single inspection
single web-image-v1 job
web-image-v1 with crop
student-photo-v1
three-output generation
10-image batch
concurrent batch
```

Measure complete jobs, not isolated resize calls:

```text
p50/p95/p99
jobs/sec
CPU time
event-loop delay
queue wait
queue rejections
queued jobs
queued bytes
process peak RSS
cgroup peak RSS
output bytes
actual dimensions
visual quality
malformed-input behavior
```

The most important v1 metric is peak RSS under realistic batch load. Throughput matters only after memory behavior is predictable.

## Engine challenger policy

Do not install `@napi-rs/image` in the production package alongside Sharp.

Create a separate benchmark branch/harness using the same corpus, recipes, limits, and output requirements.

Replace Sharp only if the challenger provides full behavioral parity and at least one material improvement:

```text
>= 30% higher throughput
OR
>= 30% lower p95 complete-job latency
OR
>= 25% lower peak RSS
```

with no meaningful regression in:

```text
quality
output bytes
crop correctness
EXIF correctness
malformed-input handling
Debian installation
operational complexity
```

Do not support two production engines.

## Non-goals for v1

Do not build:

- generic media server
- daemon or Unix-socket protocol
- CLI
- plugin architecture
- transform graph
- CDN
- storage abstraction
- video processing
- SVG renderer
- GIF pipeline
- watermark engine
- AI image tooling
- public GET transformation

## Implementation phases

### Phase 1 — Package foundation

- Create the package skeleton.
- Define the public contract, recipe schema, output metadata, limits, and error codes.
- Add `web-image-v1` and `student-photo-v1` presets.
- Keep Sharp private behind `engine/sharp.ts`.
- Add README, LICENSE, CHANGELOG, architecture notes, and security/input-limit documentation.

### Phase 2 — Deterministic Sharp processing

- Implement inspection and validation.
- Implement format detection and declared MIME verification.
- Implement orientation, crop, resize, encode, and output verification.
- Implement job-level atomicity: complete result or typed error.
- Add golden fixtures and behavioral tests.

### Phase 3 — Bounded processor

- Implement logical-job scheduling.
- Add queued-job and queued-byte budgets.
- Add cancellation and timeout behavior.
- Add safe concurrency configuration.
- Add lightweight non-sensitive metrics for queue wait, active jobs, duration, and rejections.

### Phase 4 — Benchmark and package hardening

- Run the full corpus on target-like Debian infrastructure.
- Tune Sharp/libvips concurrency and allocator settings from measurements.
- Benchmark `@napi-rs/image` separately under the same contract.
- Pin exact package and engine versions.
- Verify clean Debian installation.

### Phase 5 — Consumer cutovers

- Integrate Coedula atomically and delete its duplicated codec kernel.
- Integrate Faztore atomically and delete its duplicated codec kernel.
- Remove public-runtime processing from Faztore.
- Backfill missing Faztore derivatives before enforcing the public invariant.
- Preserve existing URLs, cache compatibility, and rollback through dependency/adapter revert.

## Definition of done

v1 is complete when:

- one shared library owns image validation and processing
- Coedula Drive images use it
- Coedula student-photo crop uses it
- Faztore Drive images use it
- Faztore product/catalog generation uses it
- no public request performs image transformation
- malformed input is never silently accepted
- batch uploads are bounded by jobs and queued bytes
- crop coordinates are consistently based on auto-oriented source pixels
- recipe behavior is versioned and deterministic
- output metadata reports actual encoded dimensions
- Sharp is replaceable without changing consumer domain code
- the package can be published and understood without knowing Coedula or Faztore internals
