# Coedula media refactor map

Status: design map only. Paths describe the review branch; no code movement is
approved yet.

## Current findings

### Eager derivative regression

The old Drive upload route generated image variants after writing the source.
The extracted `saveDriveUpload()` in
`src/lib/server/services/drive-file.service.ts` optimizes and writes only the
original. `writeImageVariants()` is left without a caller. The first image view
can therefore perform work that should have completed during upload.

This must be corrected before or as part of any shared-package cutover. It is
not evidence that the extraction layer should remain.

### Duplicate codec kernel

`src/lib/server/services/drive-image.service.ts` duplicates Faztore's core
policy:

- JPEG/PNG/WebP/AVIF decode and re-encode;
- EXIF auto-orientation;
- 50 MP ceiling;
- 2560 longest-edge normalization;
- 480/1600 WebP variants at qualities 72/84;
- reduction threshold and native-work gate.

The stable duplication is the encoded-image transformation kernel. Drive paths,
student behavior, database rows, and response headers are not part of that
kernel.

### Concurrency is not truly bounded

One local gate slot encloses a `Promise.all` of two Sharp pipelines. With two
active logical jobs, four transforms can execute in the process. Each transform
then uses libuv, libvips, and sometimes codec-specific threads. Queued closures
also retain large input buffers.

The scheduler must account for actual native work and queued bytes, not only the
number of JavaScript callbacks.

### Validation and serving gaps

- request MIME is trusted more than decoded format;
- permissive decode and broad catches can preserve an invalid image;
- every filesystem error can be interpreted as a cache miss;
- generated files are read fully into memory before response;
- concurrent misses can repeat the same transform;
- student-photo acceptance/delivery does not fully match the general Drive SVG
  safety policy.

## Target ownership map

| Current concern                        | Target owner                   | Action after approval             |
| -------------------------------------- | ------------------------------ | --------------------------------- |
| Sharp/libvips setup                    | `media-node`                   | Move behind private engine module |
| Format probe and MIME match            | `media-node`                   | Centralize and return metadata    |
| EXIF orientation and raster transforms | `media-node`                   | Centralize                        |
| Pixel/decode limits                    | `media-node`                   | Centralize and test               |
| Variant encoder recipes                | `media-node` versioned profile | Centralize intentionally          |
| Native-work/byte backpressure          | `media-node`                   | Replace local gate                |
| Drive accepted business types          | Coedula                        | Keep                              |
| Drive quota and ACL                    | Coedula                        | Keep                              |
| File paths and atomic placement        | Coedula                        | Keep                              |
| Database writes and student linkage    | Coedula                        | Keep                              |
| HTTP/cache/disposition policy          | Coedula                        | Keep                              |
| Image/srcset presentation              | Lumi                           | Keep presentation-only            |
| OMR preparation/recognition            | Coedula + `omr-rs`             | Exclude                           |

## Proposed narrow contract

The public API should describe Coedula's intent without exposing Sharp or a
generic operation graph:

```ts
type PreparedWebImage = {
  detectedMime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';
  width: number;
  height: number;
  original: EncodedOutput;
  variants: {
    thumb: EncodedOutput;
    preview: EncodedOutput;
  };
};

prepareWebImage(input, {
  declaredMime,
  profile: 'web-image-v1',
  signal
}): Promise<PreparedWebImage>;
```

`EncodedOutput` contains bytes, MIME/format, actual width and height, and flags
such as `oriented`, `resized`, and `reencoded`. The exact exported names remain
subject to package review.

This single logical operation lets the implementation choose safe sequential or
shared-source fan-out without exposing that choice to Coedula. It also prevents
the app from accidentally bypassing package limits.

A later narrow `coverImage()` operation may replace the student-card 900 x 900
crop. It is not required for the first shared cut because it is not duplicated
between Coedula and Faztore.

## Error contract

The package must never decide whether Coedula should keep an upload. It reports
a typed result:

| Code                 | Meaning                                  | Coedula decision          |
| -------------------- | ---------------------------------------- | ------------------------- |
| `invalid_input`      | bytes cannot be decoded safely           | reject upload             |
| `unsupported_format` | detected format is outside the profile   | reject upload             |
| `mime_mismatch`      | declared and detected media disagree     | reject upload             |
| `pixel_limit`        | decoded dimensions exceed policy         | reject upload             |
| `busy`               | bounded queue/byte budget is full        | return retryable response |
| `cancelled`          | caller deadline or abort signal fired    | abort transaction         |
| `encode_failed`      | an approved output could not be produced | reject atomically         |

Coedula maps these to HTTP responses and product copy. The shared package does
not import SvelteKit errors or Spanish messages.

## Atomic migration shape

One approved Coedula change should:

1. add the pinned `media-node` dependency;
2. add the thin Coedula adapter and error mapping;
3. replace every duplicated Drive/student raster caller;
4. restore eager original + derivative completion;
5. remove the local codec policy and local concurrency helper;
6. retain Coedula storage, repository, auth, and HTTP code;
7. pass fixtures, lint, typecheck, and a target-hardware smoke benchmark.

If all callers and the old owner cannot be changed and deleted in the same cut,
the migration is postponed. There will be no compatibility facade or parallel
pipeline.

## Rust decision inside this boundary

`@napi-rs/image` is worth a controlled benchmark because it supports the needed
codecs and uses SIMD resizing. Its published benchmark is not enough: its stack
uses full-frame Rust image buffers and multiple native codec libraries, so the
50 MP/multi-output peak-RSS and hostile-input contract must be demonstrated.

A custom Rust service is a later operational decision, not a prerequisite for
sharing code. If required, it should be resident, privately supervised, and
accept encoded bytes plus a versioned recipe over a Unix socket. It must not
receive Drive paths, database identifiers, student data, ACLs, or HTTP policy.

## Rollback boundary

Generated WebP assets and existing URLs must remain format-compatible across the
cut. Rollback means reverting the Coedula dependency/adapter commit; it must not
require a database rollback or deletion of already-generated variants.
