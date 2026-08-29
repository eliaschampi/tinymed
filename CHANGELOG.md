# Changelog

All notable changes to `@tinymed/media` are documented here.

## Unreleased

- Fixed the process-path `input_too_large` error code (it was a typo and failed typecheck).
- Closed the queued-to-running cancellation race so an abort after dequeue cannot start native work.
- Upgraded Sharp from 0.34.5 to 0.35.4.
- Documented the library with one job per file (README, architecture, integration, benchmarks). Removed `docs/FOUNDATION.md`.
- Kept a single real photograph in `examples/` (portrait JPEG with EXIF). Removed four near-duplicates.
- Recorded the local complete-job benchmark baseline (Node 22.22.2, Sharp 0.35.4, libvips 8.18.6).
- Removed the `ci` package script.

## 0.1.0 — 2026-08-28

- Added validated JPEG, PNG, WebP, and AVIF processing through Sharp/libvips.
- Added deterministic orientation, crop, resize, encode, and verified output geometry.
- Added `webImageV1`, `studentPhotoV1`, and `catalogV1` presets.
- Added bounded logical-job scheduling by active jobs, queued jobs, queued bytes, and execution deadline.
- Added stable `MediaError` codes, cancellation, metrics, behavioral tests, corpus coverage, and a complete-job benchmark harness.
- Hardened terminal timeout/cancellation semantics and process-wide libvips concurrency configuration.
