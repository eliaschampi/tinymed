# Coedula media processing tasks

This checklist is intentionally documentation-first. Checked items are audit or
Git-preservation work only; no processing implementation has started.

## Review and approval

- [x] Identify `84629a8` as the unapproved commit.
- [x] Preserve it on `codex/media-architecture-review`.
- [x] Record the approved base as `c494b7b`.
- [ ] Approve `plan.md` and `refactor.md`.
- [ ] Approve the separate `media-node` repository/package name.
- [ ] Approve the v1 processing contract and typed error taxonomy.
- [ ] Approve fixture handling for private production images.
- [ ] Approve a measurable engine-switch threshold.

## Correctness recovery

- [ ] Add a regression test proving every eligible upload creates `thumb` and
      `preview` before the upload is considered complete.
- [ ] Restore the eager variant call removed by the unapproved extraction.
- [ ] Verify actual decoded format against the accepted declared MIME.
- [ ] Replace `failOn: 'none'`/broad fallback behavior with explicit typed
      invalid-input handling.
- [ ] Separate filesystem `ENOENT` from permission and general I/O errors.
- [ ] Verify SVG and GIF are not accepted by the student-photo raster path.
- [ ] Apply `nosniff` and safe SVG delivery consistently to student-photo
      fallback behavior.
- [ ] Add single-flight protection for concurrent requests for the same asset
      version.

## Shared package foundation

- [ ] Create the separate Node-only package after approval.
- [ ] Keep Sharp private; do not expose its types or pipeline object.
- [ ] Implement actual-format probe and metadata result.
- [ ] Implement strict byte/pixel limits and cancellation.
- [ ] Implement one versioned web-upload profile.
- [ ] Implement one versioned thumb/preview profile.
- [ ] Implement a byte-aware bounded scheduler around actual output pipelines.
- [ ] Return output bytes, detected MIME/format, width, height, and transform
      flags.
- [ ] Return typed `invalid_input`, `unsupported_format`, `pixel_limit`, `busy`,
      `cancelled`, and `encode_failed` errors.
- [ ] Add runtime counters without logging file contents or personal data.

## Golden fixtures

- [ ] JPEG at EXIF orientations 1–8.
- [ ] 12 MP and near-50 MP JPEG camera images.
- [ ] Transparent and opaque PNG.
- [ ] WebP and AVIF sources, including already-optimized files.
- [ ] Portrait, landscape, and square dimensions.
- [ ] Truncated, corrupt, MIME-spoofed, and over-limit inputs.
- [ ] Expected 480/1600 longest-edge outputs with stored actual dimensions.
- [ ] Student-card 900 x 900 center-cover fixture as a later-contract candidate.

## Coedula cutover

- [ ] Add a thin Coedula adapter under `src/lib/server/` for app policy only.
- [ ] Update Drive upload callers atomically.
- [ ] Update student-photo callers without moving student rules into the package.
- [ ] Keep Drive repository, quota, paths, and database writes in Coedula.
- [ ] Keep HTTP response policy in Coedula.
- [ ] Delete the duplicated codec implementation and local gate in the same
      change.
- [ ] Confirm no compatibility barrel or second pipeline remains.
- [ ] Confirm OMR code and browser image preparation are unchanged.

## Performance validation

- [ ] Capture a tuned Sharp/libvips baseline on target-like Debian hardware.
- [ ] Sweep actual pipeline slots 1 and 2.
- [ ] Sweep `sharp.concurrency()` 1 and 2.
- [ ] Compare sequential and parallel derivative generation.
- [ ] Compare glibc with `MALLOC_ARENA_MAX` against jemalloc if operationally
      acceptable.
- [ ] Compare `@napi-rs/image` with identical limits, outputs, and quality.
- [ ] Test Coedula image work while OMR is active.
- [ ] Record p50/p95/p99, throughput, CPU, RSS, queueing, output size, and quality.
- [ ] Reject an engine change that does not meet the approved threshold.

## Release gate

- [ ] All media fixtures pass.
- [ ] `pnpm run lint:fix` passes.
- [ ] `pnpm run check` passes.
- [ ] `git diff --check` passes.
- [ ] Fresh Debian install resolves the pinned native artifacts.
- [ ] Existing image URLs remain compatible.
- [ ] Backfill/repair command is dry-run tested if required.
- [ ] Rollback procedure is documented and tested.
- [ ] User approves merge from the review branch.
