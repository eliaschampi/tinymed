# Changelog

All notable changes to `@tinymed/media` are documented here.

## Unreleased

- Consolidated canonical project documentation and repository quality gates.
- Removed implementation-planning artifacts from the repository root.
- Reduced redundant internal comments while retaining public contracts and non-obvious invariants.

## 0.1.0 — 2026-08-28

- Added validated JPEG, PNG, WebP, and AVIF processing through Sharp/libvips.
- Added deterministic orientation, crop, resize, encode, and verified output geometry.
- Added `webImageV1`, `studentPhotoV1`, and `catalogV1` presets.
- Added bounded logical-job scheduling by active jobs, queued jobs, queued bytes, and execution deadline.
- Added stable `MediaError` codes, cancellation, metrics, behavioral tests, corpus coverage, and benchmark harness.
- Hardened terminal timeout/cancellation semantics and process-wide libvips concurrency configuration.
