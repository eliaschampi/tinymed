# task.md — Media Core

## Purpose

Build a small, independent server-side image processing library for Node.js.

The library has one responsibility:

> Convert untrusted encoded raster bytes into validated, normalized, optimized encoded image outputs.

The first production consumers are:

- Coedula
- Faztore

The package must remain independent from both applications and suitable for public use.

---

# Core contract

Media Core owns the complete image-processing lifecycle after encoded bytes enter the library:

```text
encoded bytes
→ inspect
→ validate
→ orient
→ crop
→ resize
→ encode
→ verify output
```

The result must be deterministic at the contract level:

- fixed processing order
- fixed crop coordinate system
- fixed recipe semantics
- stable validation behavior
- actual output metadata
- bounded processing capacity

The library operates only on image bytes and image-processing data.

Application-specific concerns remain outside the package.

---

# Runtime

```text
Node.js
TypeScript
ESM
```

Native image processing is implemented with:

```text
Sharp / libvips
```

Sharp remains an internal implementation detail.

---

# Dependency model

Production dependency:

```text
sharp
```

Keep the package dependency surface minimal.

---

# Public API

The public API should expose only the concepts required by consumers.

Conceptually:

```ts
inspectImage(input, options?)

processImage(input, recipe, options?)
```

A processor instance may be exposed for capacity configuration:

```ts
const media = createProcessor(config)

await media.inspect(input, options)
await media.process(input, recipe, options)
```

The exact implementation shape may evolve during development, but the public surface should remain small and focused.

---

# Input

Accepted input:

```ts
Uint8Array
```

Node `Buffer` is naturally supported through `Uint8Array`.

Input represents one complete encoded image.

Optional inspection context may include:

```ts
{
  declaredMime?: string
}
```

The encoded bytes determine the actual image format.

---

# Supported formats

v1 supports:

```text
JPEG
PNG
WebP
AVIF
```

Each input represents one static image.

---

# Inspection

Inspection extracts authoritative structural information before processing.

At minimum:

```ts
{
  format
  mime

  byteLength

  width
  height

  orientedWidth
  orientedHeight

  channels
  hasAlpha

  orientation
}
```

Inspection must validate the structural constraints required before processing.

The dimensions exposed for crop calculations must include the auto-oriented image dimensions.

---

# Validation

Every input is treated as untrusted.

Validation must enforce finite limits for:

```text
encoded bytes
decoded pixels
channels
pages
output count
output dimensions
crop bounds
queued work
queued encoded bytes
```

Initial decoded image ceiling:

```text
50,000,000 pixels
```

The exact encoded-byte ceiling should be defined once in the package and aligned with the real upload requirements of Coedula and Faztore.

Malformed or truncated encoded images must fail.

If a declared MIME is supplied, it must match the detected image format.

---

# Error contract

Expose stable Media Core errors independent from Sharp.

Required error categories include:

```text
input_too_large
unsupported_format
mime_mismatch
pixel_limit_exceeded
channel_limit_exceeded
multi_page_not_supported
invalid_image
invalid_crop
invalid_recipe
capacity_exceeded
processing_timeout
processing_failed
```

Consumers should be able to branch on the error code without parsing native error messages.

---

# Orientation

EXIF orientation is resolved before geometry is applied.

The effective processing coordinate space is always:

```text
auto-oriented source image
```

This coordinate system must be consistent across:

- inspection
- crop
- Coedula student photos
- Faztore product images
- future consumers

---

# Crop

Crop is part of the core processing model.

Conceptually:

```ts
{
  left
  top
  width
  height
}
```

Coordinates are integer source pixels relative to the auto-oriented source image.

Processing order:

```text
auto-orient
→ crop
→ resize
→ encode
```

The crop must be fully inside the oriented source bounds.

Invalid geometry fails processing.

The UI may calculate the crop interactively, but Media Core remains authoritative for crop validation and execution.

---

# Recipe

Processing is described by a small declarative recipe.

Conceptually:

```ts
{
  crop?: {
    left,
    top,
    width,
    height
  },

  outputs: [
    {
      key,
      format,
      width?,
      height?,
      fit?,
      quality?,
      allowUpscale?
    }
  ]
}
```

The recipe describes desired outputs, not processing steps.

---

# Output geometry

Supported resize behavior:

```text
inside
cover
```

`inside` preserves aspect ratio while fitting inside the requested dimensions.

`cover` fills the requested dimensions while preserving aspect ratio.

Upscaling is disabled by default.

If an output contains no target dimensions, it preserves the post-orientation/post-crop geometry and is re-encoded.

---

# Output formats

Outputs may be encoded as:

```text
JPEG
PNG
WebP
AVIF
```

The recipe may also request re-encoding using the detected source format.

Every processed output is newly encoded.

---

# Metadata policy

Processed outputs should be suitable for web and application storage.

Processing must:

```text
apply source orientation
produce orientation-normalized pixels
normalize colour for web use
remove unnecessary source metadata
avoid carrying private source metadata into generated outputs
```

Output metadata reported by Media Core describes the generated image itself.

---

# Output contract

Every generated output returns actual encoded facts.

Conceptually:

```ts
{
  key

  bytes

  mime
  format

  width
  height

  byteLength

  oriented
  cropped
  resized
  reencoded
}
```

Dimensions must describe the actual encoded file.

Consumers must never infer responsive-image descriptors from requested dimensions.

For example:

```text
srcset width
=
actual encoded width
```

---

# Job model

One source image and all outputs requested from that source form one logical image job.

Example:

```text
source

→ normalized
→ preview
→ thumb
```

belongs to one job.

The complete set succeeds or the job fails.

Consumers should receive either the complete result or an error.

---

# Processing efficiency

The initial optimization target is predictable memory usage under real server workloads.

Large encoded images may decode into hundreds of megabytes of native memory.

The processor therefore controls the number of active image jobs.

Start with:

```text
active logical jobs: 1
```

and benchmark higher concurrency on the production-class Debian environment.

Within one logical job, begin with sequential output generation.

Measure before introducing parallel native output processing.

---

# Capacity

The processor must bound both:

```text
queued jobs
queued encoded bytes
```

This prevents a batch of large images from creating unlimited retained Buffers while waiting for native processing.

Capacity exhaustion should produce a stable Media Core error.

---

# Timeout

Processing must have a finite execution timeout.

The timeout applies to native image work.

Queue waiting and active image processing should remain distinguishable internally for observability and benchmarking.

---

# Web preset

Provide one shared, versioned web-image preset for the current production consumers.

```text
web-image-v1
```

Baseline behavior:

```text
normalized
  max edge: 2560
  format: source format

preview
  max edge: 1600
  format: WebP

thumb
  max edge: 480
  format: WebP
```

All use proportional `inside` resizing.

Quality values should be selected using the existing Coedula/Faztore behavior as the initial reference, then finalized through representative fixtures, output-size measurement and visual comparison.

Once released, the preset defines a stable processing policy.

A materially different policy becomes a new preset version.

---

# Coedula usage

Coedula currently processes images in two relevant flows:

```text
Drive images
Student photos
```

Both should use Media Core.

---

# Coedula Drive images

Current behavior already requires:

```text
normalized upload
preview
thumb
```

Target flow:

```text
uploaded encoded bytes
→ Media Core
→ normalized
→ preview
→ thumb
→ application storage
```

All required image outputs should be generated during the write flow.

Reading an existing Drive image should only retrieve an already generated asset.

Media Core returns bytes and metadata.

Coedula continues to decide:

```text
where files are stored
how storage paths are named
how quota is calculated
which database records reference each image
who can access the asset
```

---

# Coedula student photos

The current student-photo UI already provides interactive crop selection.

Keep the UI responsible for the interaction.

Move authoritative image generation to the server.

Target flow:

```text
original encoded image
+
crop rectangle
↓
Media Core
↓
orientation
↓
crop
↓
resize
↓
WebP student photo
```

Current product requirement:

```text
420 × 420
WebP
```

The crop coordinates supplied by the UI must reference the auto-oriented source image coordinate space.

This gives the student-photo workflow the same validation and image semantics as every other image processed by the package.

---

# Faztore usage

Faztore has two relevant image contexts:

```text
Drive uploads
Product/catalog media
```

Both should use Media Core for raster processing.

---

# Faztore Drive images

Drive image uploads can use the same shared web preset as Coedula:

```text
normalized
preview
thumb
```

Media Core performs validation and image generation.

Faztore owns persistence and Drive metadata.

---

# Faztore product media

Product images should be fully prepared during administrative image changes.

Target flow:

```text
admin upload / replacement
↓
Media Core
↓
all required catalog outputs
↓
persist generated assets
↓
make image available to catalog
```

The public catalog path should operate entirely on already generated encoded files.

This keeps anonymous image requests limited to asset lookup and streaming.

---

# Faztore crop

Product crop can use the same crop contract as student photos.

The product UI may display and modify the crop rectangle.

It sends source-image coordinates to the server.

Media Core executes:

```text
orient
→ crop
→ resize
→ encode required outputs
```

This supports consistent product presentation without introducing product-specific behavior into the library.

---

# Application boundary

The consuming application supplies:

```text
encoded image bytes
optional declared MIME
recipe
optional crop geometry
```

Media Core returns:

```text
validated input metadata
generated encoded outputs
actual output metadata
```

The application then performs its own persistence and domain operations.

This is the complete integration boundary.

---

# Internal structure

Keep internal ownership obvious and small.

A reasonable structure is:

```text
src/
  index.ts
  inspect.ts
  process.ts
  recipe.ts
  preset.ts
  limits.ts
  scheduler.ts
  errors.ts
  engine/
    sharp.ts
```

The exact file decomposition may be adjusted during implementation if a simpler organization emerges.

Architecture should remain vertical:

```text
public contract
↓
validation + processing orchestration
↓
native Sharp implementation
```

---

# Performance model

Benchmark complete image jobs.

Relevant production cost includes:

```text
input inspection
decode
orientation
crop
resize
encoding
multiple outputs
native memory
queued input buffers
```

The primary resource metric on a 4 GB VPS is:

```text
peak RSS under realistic batch load
```

Throughput matters after memory usage remains predictable.

---

# Benchmark corpus

Use representative production images.

Include:

```text
2–5 MP photo
12 MP phone photo
24 MP image
48–50 MP image

portrait
landscape
square

transparent PNG

JPEG
PNG
WebP
AVIF

EXIF orientations 1–8

student-style square crop
product crop

image near pixel limit

corrupt input
truncated input
MIME mismatch
```

The corpus should contain known geometry so orientation and crop correctness can be verified exactly.

---

# Benchmark workloads

Measure:

```text
inspection

single web-image-v1 processing

web-image-v1 with crop

student-photo processing

three-output generation

10-image batch

concurrent batch
```

Record:

```text
p50
p95
p99

jobs/sec

CPU

event-loop delay

peak process RSS
peak cgroup RSS

queued jobs
queued bytes

output byte sizes
actual dimensions
```

Also perform visual comparison for encoding quality.

---

# Tests

The repository should have strong behavioral fixtures for:

```text
format detection

declared MIME verification

encoded-size limits
pixel limits
channel limits

malformed images
truncated images

EXIF orientations 1–8

crop correctness
crop bounds

inside resize
cover resize
upscale prevention

JPEG output
PNG output
WebP output
AVIF output

alpha preservation

metadata normalization

actual output dimensions

multi-output job atomicity

scheduler capacity

queued-byte capacity

stable error codes
```

Crop fixtures should make coordinate errors easy to detect.

---

# Repository quality

The project should be independently publishable and understandable.

Repository essentials:

```text
README.md
LICENSE
CHANGELOG.md

src/

test/
fixtures/

benchmark/

docs/
  architecture.md
  security.md
  benchmark-methodology.md
```

The README should explain the package through its public contract and practical examples.

---

# Quality criteria

The implementation should optimize for:

```text
small public API

few production dependencies

clear ownership

predictable memory usage

correct handling of untrusted input

consistent image geometry

actual output metadata

easy integration in Node applications

simple internal architecture

measurable performance
```

Prefer direct code and explicit invariants over generic infrastructure.

---

# Definition of done

Media Core v1 is complete when:

```text
Coedula Drive images use Media Core

Coedula student-photo generation uses Media Core

Faztore Drive images use Media Core

Faztore product/catalog image generation uses Media Core
```

and the package provides:

```text
one image-processing contract

one crop coordinate system

one processing order

one native implementation

one bounded processor

one shared web-image-v1 preset

one stable error model

one representative benchmark suite
```

The resulting architecture should be:

```text
application
    ↓
encoded bytes + recipe
    ↓
Media Core
    ↓
validated encoded outputs + facts
    ↓
application storage/domain
```

The repository succeeds when image-processing behavior can evolve internally without requiring Coedula or Faztore to understand the native image engine.