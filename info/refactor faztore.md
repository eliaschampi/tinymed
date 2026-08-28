# Faztore media refactor map

Status: design map only. Paths describe the review branch; no code movement is
approved yet.

## Current findings

### Public requests can encode images

Product upload attempts eager variant generation, but
`src/lib/server/services/drive-file.service.ts` catches and ignores a derivative
failure. The anonymous route
`src/routes/(public)/media/catalog/[fileCode]/+server.ts` then calls
`ensureVariantBuffer(..., { persist: false })` for a missing variant.

Because the public process is read-only, the result is not repaired. A later
request can repeat the same decode/resize/encode work. This conflicts with the
approved two-runtime design and is a larger performance defect than the choice
of implementation language.

### Existing variants are copied through memory

The image service reads generated files into a `Buffer`, and routes convert
again to a `Uint8Array`. Public catalog delivery should stream the verified file
or use an authenticated internal Nginx redirect. Native image libraries should
not participate in public GETs.

### Duplicate codec kernel

`src/lib/server/services/drive-image.service.ts` duplicates Coedula's JPEG,
PNG, WebP, and AVIF policy, including orientation, 50 MP limit, 2560
normalization, 480/1600 derivatives, encoder settings, and concurrency helper.

This encoded-image kernel is shareable. Product/publication state, storage
prefixes, security-barrier views, ETags, and HTTP behavior are Faztore-specific.

### Concurrency is process-local and undercounts work

One gate slot launches two Sharp output pipelines with `Promise.all`. Each Node
service owns a separate gate, while libuv, libvips, and AVIF may add threads. A
JavaScript job count therefore does not equal native transform concurrency. The
queued closures can also retain hundreds of MiB of input buffers before decoded
frames and outputs are counted.

### Responsive width metadata is inaccurate

Both variant dimensions currently mean longest edge, but the catalog advertises
them as `480w` and `1600w`. A portrait output may be 360 x 480 or 1200 x 1600.
The system must store/use actual widths or adopt a genuinely width-based recipe.

## Target ownership map

| Current concern                    | Target owner                   | Action after approval             |
| ---------------------------------- | ------------------------------ | --------------------------------- |
| Sharp/libvips setup                | `media-node`                   | Move behind private engine module |
| Probe, MIME match, orientation     | `media-node`                   | Centralize                        |
| Pixel/decode limits                | `media-node`                   | Centralize and test               |
| Encoder/variant recipes            | `media-node` versioned profile | Centralize intentionally          |
| Native-work/byte backpressure      | `media-node`                   | Replace local gate                |
| Product upload/publication policy  | Faztore admin                  | Keep                              |
| Product storage roots and paths    | Faztore                        | Keep                              |
| DB rows and security-barrier views | Faztore                        | Keep                              |
| Public eligibility and repair      | Faztore                        | Keep                              |
| ETag/cache/status/file streaming   | Faztore public route/Nginx     | Keep                              |
| Image/srcset presentation          | Lumi                           | Keep presentation-only            |

## Proposed narrow contract

The public package API should express the stable web-media operation rather than
expose Sharp or a generic transform graph:

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

Each output reports bytes, MIME/format, actual width/height, and transform flags.
Faztore chooses filenames and atomically publishes those outputs only after all
required results exist.

## Public invariant and repair model

1. Admin processing creates the normalized original and required variants.
2. Faztore places them atomically or cleans up the incomplete set.
3. Publication validation requires all referenced derivatives.
4. Anonymous delivery performs DB/publication/path checks and serves an existing
   file only.
5. Missing variants emit telemetry and return a defined response; an
   authenticated idempotent repair/backfill command performs regeneration.

The repair command owns iteration, product lookup, paths, and write policy.
`media-node` only transforms one validated input job.

## Error contract

| Code                 | Meaning                                | Faztore admin decision     |
| -------------------- | -------------------------------------- | -------------------------- |
| `invalid_input`      | bytes cannot be decoded safely         | reject upload              |
| `unsupported_format` | detected format is outside the profile | reject upload              |
| `mime_mismatch`      | declared and detected media disagree   | reject upload              |
| `pixel_limit`        | decoded dimensions exceed policy       | reject upload              |
| `busy`               | bounded queue/byte budget is full      | retryable admin response   |
| `cancelled`          | caller deadline/abort fired            | abort placement            |
| `encode_failed`      | required output failed                 | do not publish partial set |

The package returns codes and metadata, not SvelteKit errors, product decisions,
or Spanish copy.

## Atomic migration shape

One approved Faztore cut should:

1. add the pinned server-only dependency;
2. add a thin admin adapter and typed error mapping;
3. replace all duplicated raster-processing callers;
4. require complete derivative output before public eligibility;
5. remove processing imports and fallback behavior from the public route;
6. delete the local codec kernel and concurrency helper;
7. preserve storage, DB, publication, security-view, and HTTP owners;
8. pass fixtures, both-runtime smoke tests, and the VPS benchmark gate.

No compatibility facade or two live pipelines remain after the cut.

## Engine and service decision

Sharp/libvips remains the baseline because the expensive work is already native,
its streaming model is mature, and the current code has an explicit pixel
ceiling. `@napi-rs/image` is the serious Rust-backed challenger, but its official
microbenchmarks do not prove 50 MP multi-output RSS, hostile-input limits, or
public/admin coexistence on this host.

If measurements later require a host-global queue or native crash isolation, a
resident Unix-socket worker can sit behind the same contract. The worker should
not be a one-shot binary and must not know product paths, DB identifiers,
publication rules, or public HTTP policy. Its filesystem permissions must remain
narrow enough not to collapse Faztore's admin/public isolation.

## Rollback boundary

The cut must preserve existing file URLs and WebP compatibility. Rollback reverts
the Faztore adapter/dependency and public-route change; it does not roll back the
database or remove assets created by the new implementation. Backfill must be
idempotent and independently stoppable.
