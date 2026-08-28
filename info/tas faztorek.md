# Faztore media processing tasks

This checklist is documentation-first. Checked items are audit or Git
preservation only; no processing implementation has started.

## Review and approval

- [x] Identify `d344665` as the unapproved commit.
- [x] Preserve it on `codex/media-architecture-review`.
- [x] Record the approved base as `627f9e3`.
- [ ] Approve `plan.md` and `refactor.md`.
- [ ] Approve the separate `media-node` package name and release channel.
- [ ] Approve the v1 processing/error contract.
- [ ] Approve a private fixture corpus and benchmark method.
- [ ] Approve an engine-switch threshold.

## Public-serving invariant

- [ ] Inventory missing thumb/preview files for published product media.
- [ ] Add an authenticated dry-run repair/backfill command.
- [ ] Make required variant generation atomic and observable.
- [ ] Stop swallowing derivative-generation failure during upload.
- [ ] Block publication or return a clear admin error while required variants are
      missing.
- [ ] Remove `ensureVariantBuffer(..., { persist: false })` from the anonymous
      route.
- [ ] Ensure the public runtime cannot import Sharp or `media-node`.
- [ ] Serve only an existing verified path by Node stream or internal Nginx
      redirect.
- [ ] Preserve the read-only DB role and product-media filesystem boundary.
- [ ] Treat missing, forbidden, and I/O-failed files as different outcomes.

## Correctness and security

- [ ] Verify actual decoded format against the declared MIME.
- [ ] Reject invalid/corrupt image bytes instead of silently retaining them.
- [ ] Test EXIF orientations and alpha behavior.
- [ ] Enforce byte/pixel limits before expensive fan-out where possible.
- [ ] Add single-flight per source version and derivative profile.
- [ ] Store or return actual output width and height.
- [ ] Correct `srcset` width descriptors for portrait assets.
- [ ] Confirm public ETag/cache behavior remains deterministic after backfill.

## Shared package foundation

- [ ] Create the separate Node-only package after approval.
- [ ] Keep Sharp and all engine-specific types private.
- [ ] Implement actual-format probe, MIME match, orientation, and limits.
- [ ] Implement one versioned upload/variant profile.
- [ ] Implement actual-pipeline and queued-byte backpressure.
- [ ] Return bytes, format/MIME, actual dimensions, and transform flags.
- [ ] Return typed `invalid_input`, `unsupported_format`, `mime_mismatch`,
      `pixel_limit`, `busy`, `cancelled`, and `encode_failed` errors.
- [ ] Expose non-sensitive transform/queue metrics.

## Faztore cutover

- [ ] Add an admin-only Faztore adapter for app policy and error mapping.
- [ ] Update product upload callers atomically.
- [ ] Keep product paths, DB state, publication, cleanup, and HTTP local.
- [ ] Delete the duplicated image kernel and local gate in the same change.
- [ ] Ensure the public build/runtime path does not pull processing native
      artifacts.
- [ ] Confirm no compatibility facade or alternate active pipeline remains.

## Golden fixtures

- [ ] JPEG at EXIF orientations 1–8.
- [ ] 12 MP and near-50 MP JPEGs.
- [ ] Transparent/opaque PNG, WebP, AVIF, and already-optimized sources.
- [ ] Portrait, landscape, and square product media.
- [ ] Truncated, corrupt, MIME-spoofed, and over-limit files.
- [ ] Expected actual dimensions and visually approved output fixtures.
- [ ] Published product with complete derivatives.
- [ ] Published legacy product with a repairable missing derivative.

## Performance validation

- [ ] Benchmark on target-like 4 GB Debian hardware.
- [ ] Keep admin and public systemd services running during the test.
- [ ] Sweep actual transform slots 1 and 2.
- [ ] Sweep `sharp.concurrency()` 1 and 2.
- [ ] Compare sequential and parallel output generation.
- [ ] Compare `MALLOC_ARENA_MAX` and jemalloc if operationally acceptable.
- [ ] Compare tuned Sharp/libvips with `@napi-rs/image` at equal quality.
- [ ] Measure public catalog p95 while admin images are processed.
- [ ] Record latency, throughput, CPU, RSS, swap, queueing, bytes, and quality.
- [ ] Reject an engine change that misses the approved material-win threshold.

## Release gate

- [ ] Backfill dry run is reviewed before mutation.
- [ ] Required published derivatives are complete.
- [ ] `pnpm run lint` passes.
- [ ] `pnpm run check` passes.
- [ ] `git diff --check` passes.
- [ ] Clean Debian install resolves pinned native artifacts.
- [ ] Admin and public service smoke tests pass.
- [ ] Public URLs, ETags, cache policy, and read-only boundaries remain valid.
- [ ] Rollback is documented and tested.
- [ ] User approves merge from the review branch.
