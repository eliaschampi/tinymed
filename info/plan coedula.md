# Coedula media processing plan

Status: proposal only; no media implementation is approved.

Review branch: `codex/media-architecture-review`

Preserved unapproved commit:

- `84629a8` — Drive upload/service extraction and shared serve policy

The approved Coedula base remains `c494b7b`; its independent cookie dependency
fix stays on `main`.

## Outcome

Coedula should consume a separate, server-only `media-node` package for the
duplicated raster pipeline. Lumi remains the UI system. Coedula remains the
owner of Drive, student identity, storage, authorization, database state, and
HTTP behavior.

The first production engine should be Sharp/libvips behind the package boundary.
`@napi-rs/image` is a benchmark candidate. A standalone `media-rs` binary is not
approved unless a real-VPS benchmark proves a material end-to-end advantage.

## Target flow

```text
authenticated Coedula route
  -> validate request and Coedula permissions
  -> media-node: inspect + validate + orient + transform + encode
  -> Coedula: atomically place files and persist Drive/student state
  -> authenticated route streams an existing file
```

There must be no first-view transform and no silent preservation of a malformed
image.

## Responsibility split

`media-node` owns:

- actual-format detection and declared-MIME verification;
- supported raster codec policy;
- EXIF orientation;
- input pixel/decode limits;
- versioned normalization and derivative profiles;
- encoder options and output metadata;
- bounded actual-pipeline scheduling, cancellation, and metrics;
- typed processing failures.

Coedula owns:

- `locals.can(...)`, Drive ACLs, student ownership, and accepted business media;
- upload body limits and Drive quota;
- storage roots, path construction, atomic placement, cleanup, and database rows;
- whether an upload transaction succeeds when derivatives fail;
- cache/disposition/security headers and authenticated file delivery;
- mapping UI variants to generated assets.

Lumi owns only presentation and URL/srcset vocabulary.

## Scope

Phase 1 covers the duplicated JPEG, PNG, WebP, and AVIF upload pipeline:

- auto-orient;
- maximum 50 MP decoded input;
- longest-edge normalization capped at 2560;
- original-format optimization only when useful;
- WebP preview/thumb outputs at the approved dimensions and quality policy.

Phase 1 does not absorb:

- OMR browser preparation or the `omr-rs` recognition algorithm;
- Drive ACL, quota, repository, or route behavior;
- student-card PDF composition;
- SVG/GIF as trusted raster-upload inputs;
- a generic image transformation DSL.

The existing 900 x 900 student-card cover crop can move later through a narrow
operation only after the shared raster contract is stable. Trusted SVG-to-PNG
rendering remains a separate review because it has a different trust model.

## Phases

### 0. Preserve and approve

- Keep `84629a8` on this review branch.
- Review `plan.md`, `task.md`, and `refactor.md` before code changes.
- Confirm the shared package name, contract, and release mechanism.

### 1. Restore correctness before extraction

- Restore eager thumb/preview generation lost by `84629a8`.
- Require decoded format to match allowed declared MIME.
- Stop broad catches from treating invalid input as a valid image.
- Distinguish missing files from permission and I/O failures.

This phase is planned, not implemented on this branch.

### 2. Establish the shared package

- Build a Node-only package with Sharp private to its implementation.
- Add golden fixtures for orientation, alpha, crop dimensions, malformed input,
  and the 50 MP boundary.
- Add a byte-aware bounded queue and one logical job for a source plus outputs.
- Expose semantic operations, metadata, and typed errors only.

### 3. Atomic Coedula cutover

- Replace the duplicated codec kernel and local concurrency helper in one
  change.
- Update all callers and delete the old implementation in the same commit.
- Preserve Coedula storage, DB, ACL, and HTTP adapters locally.
- Do not keep compatibility facades or two active pipelines.

### 4. Benchmark engine candidates

Compare tuned Sharp/libvips with `@napi-rs/image` on representative Coedula and
Faztore files. Measure complete jobs, not raw resize loops:

- p50/p95/p99 and jobs/second;
- CPU time, event-loop delay, queue wait, and rejections;
- process/cgroup peak RSS and native memory behavior;
- output bytes and perceptual quality;
- malformed, truncated, oversized, and orientation correctness.

Rust is promoted only if it satisfies the shared decision threshold documented
in Lumi's companion plan.

### 5. Release

- Pin an exact `media-node` version.
- Verify a clean install on the Debian target.
- Run focused media tests, `pnpm run lint:fix`, and `pnpm run check`.
- Deploy with a documented rollback to the prior Coedula commit and asset
  compatibility preserved.

## Open approvals

- Package publication channel and semantic version policy.
- Whether derivative failure rejects the complete upload or records a repairable
  state; the recommendation is to reject atomically for image uploads.
- Final variant dimensions/quality after visual and performance comparison.
- Maximum queued bytes and concurrency from measured VPS capacity, not guesses.
- Whether existing originals require a derivative backfill before cutover.
