# Faztore media processing plan

Status: proposal only; no media implementation is approved.

Review branch: `codex/media-architecture-review`

Preserved unapproved commit:

- `d344665` — bounded/atomic Drive image pipeline

The approved Faztore base remains `627f9e3`; its independent toolchain and Sharp
0.35 update stays on `main`, together with the earlier approved Lumi 0.4 UI work.

## Outcome

Faztore should consume a separate Node-only `media-node` package in the admin
runtime. Lumi remains presentation-only. The anonymous public runtime must not
decode, resize, or encode images; it should serve only pre-generated immutable
assets whose publication state has already been validated.

The first measured engine should be Sharp/libvips behind the package. A
Rust-backed Node engine can replace it only after end-to-end measurement. A
standalone `media-rs` process is not justified by language preference alone.

## Target flow

```text
admin upload / publication
  -> Faztore authorization and product rules
  -> media-node: validate + orient + normalize + generate variants
  -> Faztore atomically stores all required outputs and DB state
  -> publication becomes eligible

anonymous public GET
  -> security-barrier/publication checks
  -> existing immutable file
  -> stream or internal Nginx redirect
  -> zero image processing
```

Missing public derivatives are an invariant violation with telemetry and a
repair/backfill path. They are never regenerated anonymously per request.

## Responsibility split

`media-node` owns:

- detected raster format, declared-MIME verification, and EXIF orientation;
- pixel/decode limits;
- versioned normalization and derivative profiles;
- encoder settings and output metadata;
- actual-pipeline and queued-byte backpressure;
- cancellation, typed errors, and transform metrics.

Faztore owns:

- admin authorization and product/publication rules;
- accepted business media and upload byte limits;
- Drive/product roots, filenames, atomic placement, and cleanup;
- database records, transactions, and public eligibility;
- the read-only public OS/DB boundary;
- HTTP cache, ETag, response status, and file streaming;
- repair/backfill orchestration.

Lumi owns only visual image behavior and src/srcset composition.

## Scope

Phase 1 covers the JPEG, PNG, WebP, and AVIF raster path shared with Coedula:

- auto-orient;
- 50 MP decoded-input ceiling;
- 2560 longest-edge normalization;
- original-format optimization when useful;
- WebP thumb/preview outputs under an approved versioned profile.

Phase 1 also fixes Faztore-specific execution behavior:

- required variants complete before public eligibility;
- no swallowed derivative failures;
- no processor import or fallback transform in the public runtime;
- existing variants are streamed instead of copied through multiple buffers;
- stored actual dimensions drive `srcset` width descriptors.

## Phases

### 0. Preserve and approve

- Keep `d344665` on this review branch.
- Review `plan.md`, `task.md`, and `refactor.md` before any code changes.

### 1. Re-establish public invariants

- Define when a product image is derivative-complete.
- Reject or defer publication until required variants exist.
- Add an authenticated/idempotent repair command for legacy gaps.
- Remove anonymous on-demand processing.
- Stream only verified files from the restricted product-media root.

This phase is planned, not implemented on this branch.

### 2. Establish the shared package

- Build a Node-only package with Sharp private to the implementation.
- Add representative fixtures and typed result/error contracts.
- Use one byte-aware scheduler around actual native output work.
- Keep storage, publication, DB, and HTTP out of the package.

### 3. Atomic Faztore cutover

- Consume the pinned package only from admin/server modules.
- Replace and delete the duplicated codec kernel and local gate in one change.
- Keep the public application free of Sharp and the new processing package.
- Preserve public file URLs and cache compatibility.

### 4. Measure engine and runtime policy

Benchmark on the real 4 GB Debian shape with both Node services running. Compare
tuned Sharp/libvips and `@napi-rs/image` using identical outputs and limits.

Record:

- transform p50/p95/p99 and jobs/second;
- public catalog latency during admin processing;
- process and cgroup peak RSS, swap, and CPU;
- queue wait/rejections and event-loop delay;
- output bytes, actual dimensions, and perceptual quality;
- malformed, truncated, oversized, and decompression-heavy input behavior.

### 5. Release

- Backfill missing required variants before enabling the invariant.
- Pin package/native artifacts and verify a clean Debian install.
- Run focused tests, lint, typecheck, DB checks only if DB code changes, and a
  deployment smoke test for both services.
- Retain an asset-compatible rollback path.

## Open approvals

- Package name and publication channel.
- Whether upload or publication is the atomic derivative-completion boundary;
  recommendation: upload for product media, publication as the final guard.
- Whether Nginx `X-Accel-Redirect` or Node streaming serves public files.
- Actual concurrency and queued-byte budgets from VPS measurement.
- Correct width-based variant dimensions and migration of current portrait
  descriptors.
- Backfill policy for currently published products.
