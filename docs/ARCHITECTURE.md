# @tinymed/media — architecture

How the package is built and where each thing lives.  
Public contract: [`../README.md`](../README.md). Cutover: [`INTEGRATION.md`](INTEGRATION.md). Numbers: [`BENCHMARKS.md`](BENCHMARKS.md).

This file is the architecture source of truth. If another text disagrees, this one wins (except the code, which wins over both).

---

## 1. Stack (as it is)

| Layer | Technology |
|---|---|
| Runtime | Node.js 22+, ESM |
| Language | TypeScript strict (`exactOptionalPropertyTypes`, `verbatimModuleSyntax`) |
| Engine | Sharp → libvips. The only runtime dependency. Private to `engine/sharp.ts` |
| Tests | `node:test` + generated fixtures |
| Bench | `bench/media.bench.ts` — complete jobs, peak RSS |

Coedula and Faztore independently grew the same Sharp pipeline and drifted. This package exists to own that kernel. A second process, daemon, or plugin registry would add deployment surface without removing the native work.

---

## 2. Non-negotiables

Restrictions, not designs. A change that breaks them does not land.

| ID | Rule |
|---|---|
| **R-01** | Untrusted bytes. Identity is magic bytes + decoder metadata, never client MIME or filename. |
| **R-02** | One logical job = one source + every requested output. All outputs, or a `MediaError`. No partial result. |
| **R-03** | Outputs in a job are sequential. `Promise.all` of native pipelines is forbidden here. |
| **R-04** | Crop is in auto-oriented pixels. The engine orients first. |
| **R-05** | Recipes describe intent; encoded outputs report facts. `srcset` uses `output.width`. |
| **R-06** | One production engine. Sharp is not wrapped in a registry. |
| **R-07** | No storage, HTTP, auth, DB, path, or domain type crosses the boundary. |
| **R-08** | Released presets are frozen. Material change → new version id. |
| **R-09** | Prefer delete/replace over a second kernel or a compatibility barrel. |

Already true in code (do not reopen as if missing): sequential render; queued-byte budget; process-wide `libvipsConcurrency` conflict throws; timeout and caller abort stay distinct codes; EXIF/ICC block source-byte passthrough.

---

## 3. Where code goes

```text
index.ts             public composition; lazy shared processor
   │
   ▼
process.ts           orchestration and result assembly
   ├──────────────► scheduler.ts
   ├──────────────► recipe.ts
   ├──────────────► inspect.ts ─────► engine/sharp.ts
   └────────────────────────────────► engine/sharp.ts

types.ts / limits.ts / errors.ts / presets.ts
        contract and policy leaves
```

| File | Owns |
|---|---|
| `index.ts` | Exports and the shared processor |
| `types.ts` | Engine-independent public data |
| `limits.ts` | Limits, capacity defaults, MIME, encoder policy |
| `errors.ts` | Stable codes and log-safe conversion |
| `inspect.ts` | Sniff + structural validation |
| `recipe.ts` | Recipe and crop validation |
| `presets.ts` | Frozen versioned consumer policies |
| `scheduler.ts` | FIFO admission, byte budget, deadlines, metrics |
| `process.ts` | Logical-job orchestration |
| `engine/sharp.ts` | Metadata, decode, colour, geometry, encode |

Nothing in the engine knows a student, product, Drive path, or database row. `engine/sharp.ts` is the only module allowed to import Sharp.

Do not add `adapters/`, `engines/`, `storage/`, or a transform DSL.

---

## 4. Pipeline

Consumers cannot reorder this:

```text
byte limit → format sniff → declared MIME
→ metadata → page/channel/pixel limits
→ orientation → crop → resize → encode → verify geometry
```

Recipe shape and encoded size are checked **before** scheduler admission.

Metadata inspection does not impose the decode pixel ceiling: the header must be readable to return a typed `pixel_limit_exceeded`. The actual decode still receives `limitInputPixels`.

`inspect()` is not queued. It is a header read. `process()` is the bounded job.

---

## 5. Job model

A processor owns one FIFO queue, an active-job cap, a waiting-job cap, a waiting encoded-byte budget, an execution deadline, and metrics.

Admission reserves an active slot **synchronously**. That avoids a microtask race where several already-resolved admissions observe the same free slot.

Queue cancellation removes the waiter immediately and releases its byte budget.

Abort events do not replay. After dequeue, the scheduler attaches its listener and then reads current signal state, so an abort that won the race cannot start native work.

A timer aborts the internal signal; an in-flight libvips encode may continue until it returns. After the task resolves, the scheduler re-checks elapsed time and abort state before recording success. Timeouts become `processing_timeout`. Caller aborts stay `cancelled`.

JavaScript budgets are per processor. `libvipsConcurrency` is process-wide: the first processor configures it; a later different value throws. The Sharp operation cache is off — uploads are one-shot.

---

## 6. Rendering

Each output starts from encoded source bytes and gets a fresh Sharp pipeline:

```text
decode → auto-orient → sRGB → optional crop → resize → encode → actual geometry
```

A fresh pipeline per derivative avoids retaining one decoded frame for the whole job. Sequential execution keeps those pipelines from overlapping.

JPEG chroma follows source capability: 4:2:0 stays 4:2:0; lossless or already-4:4:4 may keep 4:4:4.

`format: 'source'` may return the original `Uint8Array` only when there is no crop, no orientation change, no EXIF/ICC to strip, unchanged geometry, and re-encoding would not save at least the configured reduction. Do not mutate input or returned passthrough bytes.

Sharp/libvips diagnostics do not escape. Unknown native failures become a safe fallback message. Branch on `code`.

---

## 7. Tests

The suite pins behaviour, not coverage percentage: container inspect, MIME spoof, truncated input, pixel/channel/page limits, EXIF orientations 1–8, oriented crop, `inside`/`cover`, upscale policy, actual encoded geometry, source passthrough vs metadata strip, queue job/byte budgets, queue cancel, timeout, dequeue-abort race, process-wide libvips conflict.

The harness measures complete jobs and peak RSS. Isolated `sharp.resize()` numbers are not capacity evidence.

---

## 8. Deliberately absent

No storage layer, framework adapter, engine registry, worker-pool abstraction, transform DSL, background service, public GET transform, SVG/GIF pipeline, watermark, or AI.

Replaceability is the narrow engine boundary plus the public data contract — not speculative interfaces.

Expand the boundary only with a real consumer and a recorded reason: a new raster format in production, a new primitive both apps need, or VPS measurements that show unused safe capacity. Until then the smallest contract is the correct one.

Priority when they conflict: correctness → clarity → consistency with this repo → reuse → performance → simplicity.
