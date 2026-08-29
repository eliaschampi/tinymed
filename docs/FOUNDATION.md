# Foundation

**Document type:** Research foundation / problem boundary  
**Verified snapshot:** 2026-08-28  
**Primary consumers:** Coedula and Faztore  
**Runtime target:** Node.js 22+, Debian-class servers  
**Implemented contract:** [README.md](../README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [INTEGRATION.md](INTEGRATION.md), [BENCHMARKS.md](BENCHMARKS.md)

This file is the ground truth for **why `@tinymed/media` exists and what it must not become**. The live API is the package source and README.

---

## Purpose in one sentence

`@tinymed/media` **turns untrusted encoded raster bytes into validated, deterministic, optimized encoded outputs while leaving storage, authorization, transport, and domain state to the application.**

That sentence is the architectural boundary.

## Why the package exists

Coedula and Faztore independently grew nearly the same Sharp/libvips image pipeline: upload validation, orientation, normalization, WebP derivatives, image-size policy, and application-specific storage.

The duplication was already drifting. Coedula had stronger decoded-pixel and concurrency protection; Faztore had a sibling pipeline with weaker native-work protection. Both applications carried codec and resize policy that was not domain logic.

The extraction is therefore not speculative reuse. Two production consumers already implement the same non-domain responsibility, and their differences are exactly the kind of drift a shared package should prevent.

The package exists to own:

```text
untrusted encoded bytes
        ↓
validated image facts
        ↓
deterministic image policy
        ↓
verified encoded outputs
```

It does not exist to own where those outputs go.

## Why Node + Sharp

v1 is an in-process Node package with Sharp as its only runtime dependency.

A Rust binary, daemon, media microservice, queue service, or plugin system would add process boundaries, deployment state, IPC, supervision, and failure modes without removing the expensive native image work: Sharp already delegates decode, resize, colour conversion, and encode to libvips.

The correct v1 optimization target is therefore the complete job around libvips:

- reject hostile input before decode;
- bound decoded pixels;
- bound active and queued work;
- avoid parallel output pipelines that multiply native memory;
- return actual output geometry;
- keep consumer integration trivial.

A different native engine is a benchmark challenger, not a second production backend. Replace Sharp only if a challenger reaches behavioral parity and demonstrates a material complete-job improvement on target hardware.

## Ownership

| Concern | Owner |
|---|---|
| Encoded-byte ceiling | `@tinymed/media` |
| Format sniffing and MIME consistency | `@tinymed/media` |
| Structural metadata and pixel/page/channel limits | `@tinymed/media` |
| EXIF orientation, crop, resize, encode | `@tinymed/media` |
| Versioned presets | `@tinymed/media` |
| Job scheduling and backpressure | `@tinymed/media` |
| Stable media errors and output facts | `@tinymed/media` |
| Authentication and authorization | application |
| Upload quotas and business rules | application |
| Filesystem/object-storage paths | application |
| Database records and transactions | application |
| Public URLs, cache headers, ETags, CDN | application |
| SvelteKit/Lumi/framework concerns | application |

No Sharp type, filesystem path, URL, database entity, or application domain model crosses the package boundary.

## Input and threat model

Input bytes are untrusted.

Accepted v1 containers:

```text
JPEG
PNG
WebP
AVIF
```

Rejected:

- unknown formats;
- malformed or truncated images;
- declared MIME that contradicts detected bytes;
- animated or multi-page inputs;
- decoded images above the pixel ceiling;
- excessive channel counts;
- invalid crop geometry;
- invalid recipes.

SVG and GIF are intentionally outside the untrusted raster contract.

Validation is cheapest-first:

```text
encoded byte length
→ magic-byte format detection
→ declared MIME consistency
→ decoder metadata
→ page/channel/pixel limits
→ native decode and transform
```

The byte signature is reconciled with libvips metadata before processing. Client MIME is a consistency signal, never the source of truth.

## Security defaults

Default limits are selected to make one hostile upload bounded before throughput is optimized:

```text
max input bytes     32 MiB
max decoded pixels  50,000,000
max channels        4
max outputs         8
max output edge     8192 px
```

The decoder receives the pixel ceiling again as defense in depth.

EXIF orientation is baked into pixels. Outputs are normalized to sRGB. Source-byte passthrough is forbidden when EXIF or an ICC profile must be stripped, so a camera upload cannot republish metadata merely because its encoded size was already efficient.

Errors expose stable codes and safe numeric context. Native decoder messages are not part of the public error surface.

## Memory and concurrency model

One source plus every derivative requested from it is one logical job.

The default processor starts with:

```text
active logical jobs       1
queued jobs              16
queued encoded bytes    128 MiB
execution timeout        30 s
libvips concurrency       1
```

The queue is bounded by retained encoded bytes as well as callback count. A queue of ten 20 MiB uploads is still 200 MiB of live data.

Outputs within a job are encoded sequentially. Running preview, thumbnail, and normalized output through `Promise.all` would create several native pipelines and decoded frames at once, defeating the logical-job memory limit.

JavaScript scheduling budgets are per processor instance. Sharp's libvips concurrency is process-wide. Multiple processors may own separate queues, but they must request the same `libvipsConcurrency`; conflicting configuration fails explicitly.

## Cancellation and deadlines

Native Sharp/libvips work cannot be reliably interrupted once an encode is in flight.

The scheduler therefore treats cancellation as a result boundary, not a promise that native CPU stops immediately:

- a queued caller abort releases its queued-byte budget;
- an in-flight caller abort cannot later return success;
- a job that finishes after its deadline cannot later return success;
- timeout and caller cancellation remain distinct error codes.

This is deliberate honesty about the runtime rather than an abstraction that claims stronger cancellation than the engine provides.

## Output facts

Recipes describe intent; encoded outputs report facts.

For every output the package returns actual width, height, byte length, format, MIME, and transformation flags. Consumers must use these values rather than requested dimensions.

This matters for `srcset`: a portrait image resized *inside* a 1600×1600 box may be 1200 pixels wide. Advertising it as `1600w` is incorrect browser metadata.

## Preset policy

Shared presets stop independent consumers from drifting on dimensions and codec quality.

A released preset is immutable policy. If requirements materially change, add a new preset version rather than changing the meaning of an existing one.

v1 ships:

- `web-image-v1`;
- `student-photo-v1`;
- `catalog-v1`.

Application-specific storage and publication policy stays outside the preset.

## Engine challenger policy

Do not ship two production engines.

A replacement engine must use the same corpus, recipes, limits, and output requirements and achieve behavioral parity. It should replace Sharp only if it demonstrates at least one material target-like improvement:

```text
>= 30% higher complete-job throughput
OR
>= 30% lower p95 complete-job latency
OR
>= 25% lower peak RSS
```

with no meaningful regression in image quality, output size, crop/orientation correctness, malformed-input handling, Debian installation, or operational complexity.

## Deliberately absent

No storage abstraction, media server, daemon, CLI, IPC protocol, plugin registry, CDN, video pipeline, SVG renderer, GIF pipeline, watermark engine, arbitrary filter graph, AI tooling, public GET transformation, or framework adapter.

These are not missing features. They are outside the component.

## Revisit triggers

Expand the boundary only when a real consumer produces evidence for it.

Examples:

- a second production engine proves a material benchmark win;
- a supported consumer requires a new raster format;
- a real workflow requires a new transformation primitive;
- target measurements show the current concurrency defaults leave material safe capacity unused.

Until then, the smallest contract is the correct contract.
