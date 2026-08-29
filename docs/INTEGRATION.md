# Integration

The package is the same for every consumer. What changes is where bytes come from, where outputs go, and which business rule authorizes the call.

Contract: [`../README.md`](../README.md). How it is built: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Ownership

| Concern | Owner |
|---|---|
| Auth, quotas, business validation | application |
| Storage paths, atomic rename, DB, transactions | application |
| Public URLs, cache, ETag, CDN | application |
| Format, MIME consistency, pixel/page/channel limits | `@tinymed/media` |
| Orientation, crop, resize, encode, presets, actual geometry | `@tinymed/media` |
| Logical-job scheduling and backpressure | `@tinymed/media` |

The package never picks a path, touches a database, or decides whether a student or product may change.

```text
authorize → read bytes → processImage / processor.process
  → complete output set → write temps → commit DB
  → publish / atomic replace → delete previous
```

If processing fails, store nothing from that job. Generate every derivative on the authorized write path, never on first public GET. Switch on `MediaError.code`. Store `output.width` / `output.height`.

Interactive crop: inspect first; send original bytes plus the oriented rectangle. Do not let a browser canvas be the encoder — the display may be oriented while the stored JPEG still has a tag.

Module-level `processImage` shares one processor. Use `createProcessor` when interactive work and a backfill need separate JavaScript queues. They still share one libvips thread pool; a conflicting `libvipsConcurrency` throws `RangeError`.

Passthrough `bytes` may be the same `Uint8Array` as the input. Copy before mutating.

---

## Error mapping

HTTP status is application policy. Coedula-class apps can start from:

```ts
export function mediaHttpStatus(error: unknown): number {
	if (!isMediaError(error)) return 500;
	switch (error.code) {
		case 'input_too_large':
		case 'pixel_limit_exceeded':
			return 413;
		case 'unsupported_format':
		case 'mime_mismatch':
		case 'multi_page_not_supported':
			return 415;
		case 'invalid_image':
		case 'invalid_crop':
		case 'invalid_recipe':
			return 400;
		case 'capacity_exceeded':
			return 503;
		case 'processing_timeout':
			return 504;
		case 'cancelled':
			return 499;
		case 'channel_limit_exceeded':
		case 'processing_failed':
			return 500;
	}
}
```

Retry only `capacity_exceeded` and `processing_timeout`. Do not retry `invalid_image` with the same bytes. Await capacity; do not accumulate unbounded buffers.

Pass `signal: request.signal` when request cancellation matters. A queued abort releases its byte budget. An in-flight encode may finish natively; the API will not report that as success.

---

## Coedula cutover

Coedula keeps `locals.can`, Drive ACL/quota, `DRIVE_STORAGE_ROOT`, atomic rename, `drive_files` / `students.photo_url`, and HTTP delivery.

Replace the local Sharp kernel in the **same** change. No compatibility barrel, no second pipeline. If the cut does not fit, omit it.

### What you are replacing

| Current Coedula behaviour | Problem |
|---|---|
| `failOn: 'none'` | Truncated or hostile bytes can be accepted |
| Client MIME drives the encoder `switch` | Spoofed `image/jpeg` on PNG is trusted |
| JPEG forced to `chromaSubsampling: '4:4:4'` | Camera 4:2:0 photos are inflated |
| `Promise.all([thumb, preview])` inside one gate slot | Two native pipelines at once |
| `ensureVariantBuffer` generates on miss | First-view transform on the read path |
| `optimizeUploadImage` catch returns original bytes | Malformed input is silently stored |
| Gate counts callbacks, not queued bytes | Ten 20 MiB uploads are still 200 MiB live |
| Default 2 concurrent native jobs | Not the conservative VPS default |

### Files that lose Sharp

| File | After |
|---|---|
| `src/lib/server/services/drive-image.service.ts` | Storage + path helpers; call `@tinymed/media` |
| `src/lib/utils/concurrency.ts` | Image work no longer uses it |
| `src/routes/api/drive/upload/+server.ts` | `process` then write all keys |
| `src/lib/server/services/student-photo.service.ts` | `studentPhotoV1(crop)` on original bytes |
| `StudentPhotoUploader.svelte` | Display + oriented crop rect only |

Leave in v1: `student-card.service.ts` PDF/SVG Sharp, `omr-rs`, Drive repository / quota / ACL.

Widen `writeDriveFileBuffer` to `Uint8Array` — Node file APIs accept it; no copy.

```ts
const media = createProcessor({
	capacity: { maxActiveJobs: 1, maxQueuedJobs: 8 }
});

const result = await media.process(originalBuffer, webImageV1(), {
	declaredMime: mimeType,
	signal: request.signal
});

await writeDriveFileBuffer(storagePath, result.byKey.normalized!.bytes);
await writeDriveFileBuffer(previewPath, result.byKey.preview!.bytes);
await writeDriveFileBuffer(thumbPath, result.byKey.thumb!.bytes);
```

| Package key | Coedula file |
|---|---|
| `normalized` | optimized original (`storage_path`) |
| `preview` | `{base}.preview.webp` |
| `thumb` | `{base}.thumb.webp` |

1. Normalized, preview, and thumb exist before commit. Incomplete otherwise.
2. Delete `ensureVariantBuffer`'s generate-on-miss. Missing variant → 404 or authenticated repair.
3. Do not store original bytes on encode failure.
4. Keep atomic rename and the DB transaction in Coedula. Transaction fails → delete the new blobs.
5. Public URLs stay. Only the writer changes.

Student photo today: the browser encodes 420×420 WebP. After cutover the browser measures, the server crops:

```text
inspectImage(originalBytes)
  → UI crop in orientedWidth × orientedHeight
  → POST original bytes + { left, top, width, height }
  → processImage(bytes, studentPhotoV1(crop))
  → Drive blob + students.photo_url
```

In one Coedula change: depend on the package; route Drive and student-photo writes through it; delete `createDriveImagePipeline`, `encodeUploadImage`, `buildVariantBuffer`, image use of `pipelineGate`, and the `Promise.all` variant path. Confirm `src/routes` does not import `sharp`. Confirm OMR and student-card PDF still compile.

---

## Faztore cutover

Faztore keeps admin authorization, product/publication rules, storage, DB, cache/ETag, and repair orchestration.

```text
admin upload / replacement
  → authorize → process(bytes, catalogV1() | webImageV1())
  → write every key → commit DB → publication eligible

anonymous GET
  → eligibility → stream file → no package import
```

Missing public derivatives are an incomplete upload or a repair job. They are never regenerated on an anonymous request. Backfill with a dedicated `createProcessor` (larger `maxQueuedJobs`) before making derivatives mandatory. Keep `libvipsConcurrency` identical to interactive processors. Await each job; do not collect unbounded buffers.

A future Node consumer calls the package directly. Do not distort v1 for a hypothetical non-Node client.

---

## Troubleshooting

| Symptom | Action |
|---|---|
| `mime_mismatch` | Trust the bytes; fix the client or reject |
| `unsupported_format` | SVG/GIF are out of v1; do not add a decoder in the app |
| `invalid_image` | Do not store the original as a fallback |
| `pixel_limit_exceeded` | Reject; do not raise the ceiling per request |
| `invalid_crop` | Inspect first; use oriented bounds |
| `capacity_exceeded` | Await and retry; do not buffer more uploads |
| `processing_timeout` | Retryable; inspect RSS and image size |
| `cancelled` | Do not retry unless the user repeats |
| `RangeError` from `createProcessor` | All processors must share `libvipsConcurrency` |
| Portrait `srcset` looks wrong | Descriptor = `output.width`, not 1600 |
| GET is slow / RSS spikes | Generation still on first view — move it to write |
| Two kernels still exist | Delete `drive-image.service` Sharp in the same change |

Depend on exported types, error codes, versioned presets, and output facts. Do not depend on Sharp options, native diagnostics, or `@tinymed/media/engine/sharp`.
