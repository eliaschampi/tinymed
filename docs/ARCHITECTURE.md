# Architecture

The whole component is one sentence: **untrusted encoded raster bytes become validated, deterministic, optimized encoded outputs.** Everything below follows from keeping that sentence small.

## Dependency direction

```text
index.ts             public composition surface
   │
   ▼
process.ts           orchestration and result assembly
   ├──────────────► scheduler.ts
   ├──────────────► recipe.ts
   ├──────────────► inspect.ts ─────► engine/sharp.ts
   └────────────────────────────────► engine/sharp.ts

types.ts / limits.ts / errors.ts / presets.ts
        shared contract and policy leaves
```

Application storage, databases, HTTP, authentication, and domain state are outside this graph.

`engine/sharp.ts` is the only module allowed to import Sharp. It is an implementation boundary, not a plugin system.

## Responsibilities

| File | Responsibility |
|---|---|
| `index.ts` | Public exports and shared lazy processor |
| `types.ts` | Engine-independent public data contract |
| `limits.ts` | Limits, capacity defaults, MIME and encoder policy |
| `errors.ts` | Stable error codes and log-safe error conversion |
| `inspect.ts` | Container sniffing and structural validation |
| `recipe.ts` | Recipe and crop validation |
| `presets.ts` | Frozen versioned consumer policies |
| `scheduler.ts` | FIFO admission, queued-byte budget, deadlines, metrics |
| `process.ts` | Logical-job orchestration and output assembly |
| `engine/sharp.ts` | Metadata, decode, colour, geometry, and encode |

Nothing in the engine knows about a student, product, Drive path, HTTP route, or database row.

## Fixed processing order

```text
byte limit
→ format sniff
→ declared MIME check
→ metadata
→ page/channel/pixel limits
→ orientation
→ crop
→ resize
→ encode
→ verify geometry
```

Consumers cannot reorder this pipeline.

Crop coordinates are defined in auto-oriented source pixels. The engine applies orientation first, so the coordinates a UI measured against are the coordinates the server executes.

## Validation before native work

Recipe shape and encoded byte size are checked before scheduler admission.

Input identity is based on magic bytes and libvips metadata. A forged signature must still agree with the decoder's container view.

Metadata inspection does not impose the decode pixel ceiling because the header must be read to return an accurate typed `pixel_limit_exceeded` error. The actual decode receives `limitInputPixels` as defense in depth.

## Job model

One input plus all requested outputs is one logical job.

A processor owns:

- one FIFO queue;
- a maximum active-job count;
- a maximum waiting-job count;
- a waiting encoded-byte budget;
- an execution deadline;
- queue and throughput metrics.

Admission reserves an active slot synchronously. This avoids a microtask race where several already-resolved admissions could observe the same free slot.

Queue cancellation removes the waiter immediately and releases its byte budget.

## Native concurrency

Outputs in one job are rendered sequentially.

This is a memory invariant, not a style preference. Each independent Sharp pipeline may hold a decoded frame and native working buffers. Parallel derivatives would make peak memory scale with output count.

`maxActiveJobs` and queue budgets are per `MediaProcessor`.

`libvipsConcurrency` is different: Sharp exposes it as process-wide state. The first processor configures it; later processors must request the same value. A conflict throws instead of silently changing or ignoring another workload's native-memory assumptions.

The Sharp operation cache is disabled because uploads are one-shot inputs, not repeated transforms of the same image.

## Deadline semantics

A timer aborts the scheduler's internal signal, but an in-flight native encode may continue until libvips returns.

After the task resolves, the scheduler re-checks both elapsed time and abort state before recording success. Therefore a native operation that completes after timeout, or after caller cancellation, cannot turn a lost deadline into a successful API result.

Timeouts become `processing_timeout`. Caller aborts remain `cancelled`.

## Output rendering

Each output starts from encoded source bytes and gets a fresh Sharp pipeline:

```text
decode
→ auto-orient
→ sRGB
→ optional crop
→ resize
→ format encoder
→ actual encoder geometry
```

A fresh pipeline per derivative keeps the implementation simple and avoids retaining one full decoded frame for the whole job. Sequential execution keeps those pipelines from overlapping.

JPEG chroma follows source capability: a 4:2:0 JPEG is not inflated to 4:4:4, while lossless or already-4:4:4 input can preserve full chroma.

## Source passthrough

A `format: 'source'` output may return the original bytes only when all of these are true:

- no crop;
- no orientation change;
- no EXIF or ICC metadata must be stripped;
- encoded geometry is unchanged;
- re-encoding does not save at least the configured reduction threshold.

This avoids quality loss from pointless re-encoding without weakening metadata policy.

## Error boundary

Sharp/libvips diagnostics do not escape directly.

Known contract failures become `MediaError` with stable codes. Unknown native failures are converted to safe fallback messages. Consumers branch on `code`, never on decoder text.

## Testing

The suite covers:

- supported container inspection;
- MIME mismatch;
- malformed/truncated input;
- pixel/channel/page limits;
- EXIF orientations;
- crop bounds and oriented coordinates;
- `inside` and `cover` geometry;
- upscale policy;
- output formats and actual dimensions;
- source passthrough and metadata stripping;
- queue job/byte budgets;
- queue cancellation;
- execution timeout;
- terminal timeout/cancellation races;
- process-wide libvips configuration.

The benchmark harness measures complete jobs and peak RSS rather than isolated resize calls.

## Deliberately absent

No storage layer, framework adapter, engine registry, worker pool abstraction, transform DSL, background service, or public image endpoint.

Replaceability comes from the narrow engine boundary and public data contract, not speculative interfaces.
