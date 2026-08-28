# task.md — Media Core

## Goal

Create a tiny, independent, open-source server image-processing library.

Primary consumers:

- Coedula
- Faztore

Potential consumers:

- Aeduca
- future Node applications
- third-party projects

The library exists for one reason:

> Turn untrusted encoded raster input into validated, deterministic, optimized encoded outputs.

Nothing else belongs in the core.

---

# Architecture decision

## Runtime

Node.js / TypeScript.

## Native engine

Sharp / libvips.

## Dependency budget

Production direct dependencies:

```text
sharp
```

No:

- queue package
- validation framework
- MIME library
- EXIF library
- storage SDK
- framework adapter
- Rust addon
- Go binary

Use Node and Sharp capabilities directly.

---

# Fundamental rule

Do NOT design an engine framework.

There is only one engine in v1.

```text
src/
  process.ts
  inspect.ts
  recipe.ts
  scheduler.ts
  errors.ts
  engine/
    sharp.ts
```

`engine/sharp.ts` is an internal implementation boundary.

There is no:

```text
Engine
EngineFactory
SharpEngine
RustEngine
EngineRegistry
Plugin
AdapterFactory
```

until a second production engine actually exists.

Replaceability comes from clean ownership, not speculative abstractions.

---

# Public API

Keep the public surface extremely small.

Conceptually:

```ts
inspectImage(input, options?)

processImage(input, recipe, options?)
```

Optionally:

```ts
createProcessor(config)
```

only if processor-level scheduling requires instances.

No Sharp type may cross the public boundary.

Input:

```text
Uint8Array / Buffer
```

Output:

```text
encoded bytes + verified metadata
```

No filesystem paths.

No database objects.

No URLs.

---

# Processing model

Processing order is fixed:

```text
encoded bytes
    ↓
encoded-size limit
    ↓
format detection
    ↓
declared MIME verification
    ↓
metadata inspection
    ↓
pixel / page / channel limits
    ↓
EXIF orientation
    ↓
optional crop
    ↓
resize
    ↓
encode
    ↓
verified outputs
```

Consumers cannot reorder this pipeline.

That prevents a generic transformation DSL from appearing.

---

# Supported v1 input

Only:

```text
JPEG
PNG
WebP
AVIF
```

Reject unsupported raster formats.

Reject animated/multi-page images in v1.

SVG is outside this contract.

GIF is outside this contract.

---

# Safety

Never trust filename extension.

Never trust browser MIME by itself.

Detected format is authoritative.

When declared MIME is supplied:

```text
declared MIME != detected MIME
→ mime_mismatch
```

Enforce:

```text
encoded byte limit
decoded pixel limit
channel limit
single-page input
valid crop bounds
```

Malformed/truncated input fails.

Never silently return the source because processing failed.

The current broad-catch behaviour in Coedula/Faztore must disappear.

---

# Crop contract

Crop is part of v1.

Crop coordinates always reference the:

```text
auto-oriented source image
```

not the raw EXIF orientation.

Order:

```text
orient
→ crop
→ resize
→ encode
```

Use integer source-pixel coordinates.

The UI remains responsible for converting its displayed crop rectangle into source-image coordinates.

The processor validates bounds.

---

# Recipe

Use a small declarative recipe.

It is data, not an operation graph.

Conceptually:

```ts
{
  crop?: ...,

  outputs: [
    {
      key,
      format,
      width?,
      height?,
      fit?,
      quality?
    }
  ]
}
```

Allowed geometry stays deliberately narrow:

```text
inside
cover
```

No arbitrary filters in v1.

No blur.

No watermark.

No compositing.

No colour effects.

Add capabilities only after a real consumer requires them.

---

# Shared preset

The package should provide one versioned neutral web preset used by both Coedula and Faztore.

Example concept:

```text
web-image-v1
```

Current compatibility target:

```text
normalized source: max edge 2560
preview:           max edge 1600 / WebP
thumb:             max edge 480  / WebP
```

The exact quality values are established by fixtures and visual comparison.

The preset belongs to the package so Coedula and Faztore cannot silently drift again.

Third-party consumers may provide another valid recipe without changing the processor.

---

# Output contract

Every output returns actual facts:

```text
key
bytes
mime
format
width
height
byteLength
```

and relevant processing flags:

```text
oriented
cropped
resized
reencoded
```

Never derive `srcset` descriptors from requested dimensions.

Use actual encoded width.

This directly fixes Faztore's current longest-edge / `w` descriptor inconsistency.

---

# Scheduling

One source and all requested outputs form:

```text
ONE logical image job
```

The processor owns bounded native-work scheduling.

Do not treat:

```text
Promise.all([thumb, preview])
```

as one bounded native operation.

Initially optimize for predictable RSS, not maximum theoretical throughput.

Start benchmark configuration at:

```text
logical jobs:       1
libvips concurrency: 1
```

then evaluate:

```text
1 / 2
1 / 2
```

on the actual Debian VPS.

Queue capacity must consider:

```text
number of jobs
+
queued encoded bytes
```

Batch upload must apply backpressure.

No unbounded accumulation of Buffers.

---

# Memory philosophy

The primary performance constraint is not JavaScript CPU.

It is:

```text
decoded image memory
native codec memory
parallel output memory
allocator fragmentation
```

Especially for 24–50 MP input.

Therefore benchmark complete jobs, never isolated resize functions.

---

# Coedula integration

Coedula owns:

```text
Drive
authentication
ACL
quota
student ownership
database
storage paths
filesystem writes
HTTP
```

Media owns:

```text
image validity
orientation
crop
resize
encoding
derivatives
```

Restore eager derivative generation.

No first-view processing.

Student crop should eventually use this same core.

---

# Faztore integration

Catalog processing occurs only during:

```text
admin upload / replacement / repair
```

All required derivatives must exist before an image becomes publicly eligible.

Anonymous catalog requests:

```text
lookup
→ verify
→ stream existing immutable file
```

Never:

```text
GET
→ decode
→ resize
→ encode
```

Missing derivative is an invariant violation.

Repair is an authenticated application operation.

Media core never knows what a Product is.

---

# Aeduca

Do not distort v1 for hypothetical PHP integration.

If Aeduca later requires the same processor and its actual image-processing owner is Node, consume the package directly.

If a future PHP-only consumer genuinely needs the engine, evaluate a separate CLI/service adapter at that moment.

The image contract remains reusable.

The current two real consumers determine v1 architecture.

---

# Engine challenger policy

`@napi-rs/image` must NOT be installed in the production package alongside Sharp.

Create an independent benchmark branch/harness.

Compare:

```text
sharp/libvips
vs
@napi-rs/image
```

using the exact same recipes and corpus.

If Rust wins materially, replace Sharp.

Do not support both.

The public API must remain unchanged.

---

# Benchmark corpus

Include real-world representative images:

```text
2–5 MP phone photo
12 MP phone photo
24–50 MP high-resolution image
portrait
landscape
square
transparent PNG
WebP
AVIF
EXIF orientations 1–8
crop
near pixel limit
corrupt
truncated
MIME spoof
```

Benchmark:

```text
single upload
crop upload
3-output generation
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
queued bytes
output size
actual dimensions
perceptual quality
```

The most important number on the 4 GB VPS is:

```text
peak RSS under realistic batch load
```

not microbenchmark resize time.

---

# Rust promotion threshold

Rust-backed processing replaces Sharp only with behavioral parity and a material measured benefit.

Suggested threshold:

```text
>= 30% throughput improvement

OR

>= 30% lower p95 complete-job latency

OR

>= 25% lower peak RSS
```

without regression in:

```text
quality
output bytes
crop correctness
EXIF correctness
malformed-input handling
Debian deployment
maintenance complexity
```

Otherwise Sharp stays.

---

# Non-goals v1

Explicitly do not build:

```text
generic media server
microservice
daemon
Unix socket protocol
CLI
plugin engine
transform graph
CDN
object storage abstraction
video processing
SVG renderer
GIF pipeline
watermark engine
AI image tools
```

---

# Open-source quality bar

The repository should be independently usable.

It must contain:

```text
README
LICENSE
API contract
architecture rationale
fixtures
golden tests
benchmark harness
security/input-limit documentation
release changelog
```

No references to Coedula/Faztore inside core implementation.

Those projects are consumers and integration examples, not architectural dependencies.

---

# Definition of done

Success means:

```text
one image-processing implementation
one deterministic pipeline
one versioned shared web recipe
one bounded scheduler
one native engine
```

Coedula and Faztore no longer contain Sharp pipelines.

Faztore public requests never transform images.

Coedula crop and derivatives use the shared core.

Large batch uploads cannot cause unbounded native work.

Malformed input cannot silently survive processing.

The library can be published to GitHub/npm and understood without knowing either application.

And replacing Sharp in the future requires changing the processor implementation, not Coedula, Faztore or their domain code.
```
