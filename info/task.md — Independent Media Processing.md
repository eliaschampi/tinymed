# task.md — Independent Media Processing

## Decision

Build `media` as an independent server-side image-processing library.

**Production v1**
- Runtime: Node.js
- Engine: Sharp / libvips
- Deployment: in-process dependency
- Consumers: Coedula, Faztore, future applications
- Engine is private and replaceable.

Do not create a Rust/Go daemon in v1.

Benchmark `@napi-rs/image` behind the same contract before freezing the engine long-term.

---

## Boundary

`media` owns only:

encoded image
→ validation
→ orientation
→ optional crop
→ normalization
→ derivative generation
→ encoded outputs + metadata

It MUST NOT own:

- authentication
- Drive
- database
- storage paths
- product/student rules
- HTTP responses
- SvelteKit
- Lumi
- publication state
- public file serving

Lumi remains presentation-only.

---

## v1 formats

Input:

- JPEG
- PNG
- WebP
- AVIF

Reject:

- malformed/truncated images
- MIME spoofing
- animated images unless explicitly supported later
- decoded images above configured pixel limit
- unsupported formats

SVG remains outside the untrusted raster contract.

---

## Processing order

```text
encoded bytes
    ↓
byte limit
    ↓
detect actual format
    ↓
declared MIME match
    ↓
metadata + pixel limit
    ↓
EXIF auto-orient
    ↓
optional crop
    ↓
normalization / resize
    ↓
generate required outputs
    ↓
encoded bytes + actual metadata
```

Crop coordinates are defined against the **auto-oriented image**, never the raw EXIF coordinate system.

No malformed-input fallback to the original bytes.

---

## API

```ts
prepareImage(input, {
  declaredMime,
  profile,
  crop?,
  signal?
})
```

No generic transformation DSL.

`profile` owns versioned recipes such as:

```text
drive-v1
catalog-v1
student-photo-v1
```

Return:

```ts
{
  source: {
    mime,
    width,
    height
  },

  outputs: {
    original?,
    thumb?,
    preview?,
    ...
  }
}
```

Every output contains:

```text
bytes
mime
width
height
byteLength
oriented
cropped
resized
reencoded
```

Consumers never receive Sharp objects or engine-specific types.

---

## Errors

Typed codes only:

```text
invalid_input
unsupported_format
mime_mismatch
pixel_limit
invalid_crop
busy
cancelled
encode_failed
```

Applications map them to HTTP/UI/business behavior.

---

## Scheduling

One uploaded image + all its outputs = one logical job.

Do not wrap multiple unbounded native pipelines in `Promise.all`.

Scheduler must bound:

```text
active native work
+
queued input bytes
```

Concurrency values are configuration determined by benchmark, not architecture constants.

No processing during anonymous/public GET requests.

---

## Coedula migration

1. Restore eager derivative generation.
2. Move duplicated raster policy into `media`.
3. Move existing crop processing through the same pipeline.
4. Keep Drive/storage/database/auth in Coedula.
5. Delete the old image kernel atomically.
6. Do not keep compatibility pipelines.
7. Never lazily transform on first view.

---

## Faztore migration

1. Generate every required catalog derivative during admin upload.
2. Upload is incomplete if required processing fails.
3. Publication requires derivative completeness.
4. Public runtime never imports `media`, Sharp or another image engine.
5. Public GET only streams an existing immutable asset.
6. Missing derivative = invariant violation + repair/backfill.
7. Store actual width/height for every derivative.
8. `srcset` uses actual widths, never longest-edge aliases.

---

## Benchmark gate

Hardware:

```text
real target-like Debian VPS
4 GB memory constraint
same Node versions as production
```

Corpus:

```text
1–5 MP
12 MP
24+ MP
near 50 MP
portrait
landscape
square
PNG alpha
JPEG EXIF orientations 1–8
WebP
AVIF
corrupt/truncated
MIME spoof
pixel-limit violation
```

Operations:

```text
prepare + 3 outputs
crop + prepare + 3 outputs
batch upload
```

Compare:

```text
Sharp/libvips
@napi-rs/image
```

Measure:

```text
p50 / p95 / p99
jobs/sec
CPU time
process + cgroup peak RSS
event-loop delay
queue wait
rejections
output bytes
actual dimensions
visual-quality parity
malformed-input behavior
```

Test concurrency 1 and 2 first.

For Sharp, benchmark allocator/concurrency settings rather than guessing them.

---

## Engine promotion rule

Replace Sharp only if the challenger preserves all behavior and achieves at least one material production improvement:

```text
>= 30% throughput improvement
OR
>= 30% lower p95
OR
>= 25% lower peak RSS
```

with no meaningful regression in:

```text
quality
output size
input safety
correctness
Debian deployment
operational complexity
```

---

## Deployment

Pin exact engine versions.

Verify installation from a clean Debian host.

No system libvips dependency when using Sharp's supported prebuilt binary.

No per-request child process.

No media daemon.

A resident Unix-socket worker becomes eligible only if future evidence demonstrates a need for:

```text
host-global scheduling
native crash isolation
cross-language consumers
or materially better memory isolation
```

The semantic `media` contract must remain unchanged if that migration ever occurs.

---

## Definition of Done

One processing policy exists.

Coedula and Faztore produce equivalent outputs for equivalent profiles.

No public request performs image transformation.

No malformed raster is silently accepted.

Batch processing has bounded memory/backpressure.

Crop, resize, orientation and derivatives require only one shared implementation.

Sharp can be replaced by a Rust-backed engine without changing application domain code.