# Integration

The package is identical for every consumer. What changes per application is where bytes come from, where outputs are stored, and which business rules authorize the operation.

## Ownership

| Concern | Owner |
|---|---|
| Authentication and authorization | application |
| Upload quotas and business validation | application |
| Storage paths and atomic placement | application |
| Database records and transactions | application |
| Public URLs, cache headers, ETags, CDN | application |
| Format detection and MIME consistency | `@tinymed/media` |
| Pixel/page/channel limits | `@tinymed/media` |
| Orientation, crop, resize, encode | `@tinymed/media` |
| Preset policy and actual output geometry | `@tinymed/media` |
| Logical-job scheduling and backpressure | `@tinymed/media` |

The package never queries an application database, selects a storage path, or decides whether a student or product may be changed.

## Safe upload lifecycle

A typical application flow is:

```text
authenticate + authorize
        ↓
read encoded upload bytes
        ↓
processImage / processor.process
        ↓
receive complete verified output set
        ↓
write temporary files / objects
        ↓
commit application database state
        ↓
publish or atomically replace storage
        ↓
clean previous assets
```

If processing fails, store nothing from the failed job. `@tinymed/media` returns no partial result.

Storage atomicity remains application-owned because files and database rows must usually move together. The package only guarantees that a successful media result contains every requested output.

## Inspect before crop

Interactive crop UIs should inspect the upload first:

```ts
const source = await inspectImage(bytes, { declaredMime: file.type });

// UI crop coordinates must be measured against:
source.orientedWidth;
source.orientedHeight;
```

The authoritative crop is then sent back in integer pixels of that oriented coordinate space.

```ts
const result = await processImage(bytes, studentPhotoV1(crop), {
	declaredMime: file.type
});
```

Do not convert the crop back to the raw EXIF orientation. The package applies orientation before crop.

## Shared and isolated processors

The module-level helpers use one shared processor.

```ts
await processImage(bytes, webImageV1());
```

Use `createProcessor` when workloads need separate JavaScript queue budgets, for example interactive uploads and a controlled backfill:

```ts
const interactive = createProcessor({
	capacity: { maxActiveJobs: 1, maxQueuedJobs: 8 }
});

const backfill = createProcessor({
	capacity: { maxActiveJobs: 1, maxQueuedJobs: 64 }
});
```

Those processors have independent scheduler queues. They do **not** have independent libvips thread pools. Sharp exposes `libvipsConcurrency` as process-wide state, so all processors in one Node process must request the same value. A conflicting value is rejected explicitly.

For small VPS deployments, start with the default `maxActiveJobs: 1` and `libvipsConcurrency: 1`. Increase either only after measuring peak RSS on target-like hardware.

## Presets

Prefer versioned presets over application-local codec settings.

```ts
webImageV1();
studentPhotoV1(crop);
catalogV1(optionalCrop);
```

A consumer may use a custom recipe when its requirement is genuinely different. Do not mutate a released preset to satisfy one application; add a new versioned preset when the shared policy materially changes.

## Store actual geometry

Use the dimensions returned by each output.

```ts
const srcset = result.outputs
	.map((output) => `${urlFor(output.key)} ${output.width}w`)
	.join(', ');
```

Do not derive `480w`, `960w`, or `1600w` from a preset request. An `inside` resize preserves aspect ratio, so a portrait image may encode to a narrower actual width.

## Error mapping

Branch on `MediaError.code`, never on `message`.

```ts
try {
	return await media.process(bytes, webImageV1(), {
		declaredMime: file.type,
		signal: request.signal
	});
} catch (error) {
	if (!isMediaError(error)) throw error;

	switch (error.code) {
		case 'input_too_large':
		case 'pixel_limit_exceeded':
			return rejectUpload(413);
		case 'unsupported_format':
		case 'mime_mismatch':
		case 'multi_page_not_supported':
			return rejectUpload(415);
		case 'invalid_image':
		case 'invalid_crop':
		case 'invalid_recipe':
			return rejectUpload(400);
		case 'capacity_exceeded':
			return retryLater(503);
		case 'processing_timeout':
			return retryLater(504);
		case 'cancelled':
			throw error;
		case 'channel_limit_exceeded':
		case 'processing_failed':
			return failRequest(500);
	}
}
```

HTTP status and UI copy remain consumer policy. Stable codes are the package contract.

## Cancellation

Pass an `AbortSignal` when request cancellation matters.

A queued cancellation releases its queued-byte budget immediately. An in-flight Sharp/libvips encode may continue natively until that operation returns, but the scheduler will not convert an already-aborted or expired job into API success.

Treat `cancelled` as caller cancellation and `processing_timeout` as the processor deadline.

## Coedula cutover

Coedula should keep:

- Drive authorization and ACLs;
- upload and quota policy;
- storage roots and path normalization;
- temporary-file and atomic rename behavior;
- database records;
- HTTP delivery.

Replace the local Sharp image kernel with package calls:

- Drive images → `webImageV1()`;
- student photo crop → `studentPhotoV1(crop)`.

Generate derivatives during the authorized write path. Do not move storage paths, database transactions, or Drive policy into this package.

Delete the old local codec/concurrency kernel in the same cutover so there is one image-processing owner.

## Faztore cutover

Faztore should keep:

- admin authorization;
- product and publication rules;
- media storage paths and database records;
- public cache/ETag/status behavior;
- repair and backfill orchestration.

Use a versioned preset during admin upload or replacement:

- general Drive images → `webImageV1()`;
- catalog/product media → `catalogV1()` when the wider ladder is required.

Anonymous public GET requests should serve already-generated immutable assets. They should not import Sharp or perform first-request image transformation.

Before making derivatives mandatory for publication, run an authenticated backfill and verify completeness.

## Backfills

A backfill is still ordinary bounded media work:

```ts
for (const item of items) {
	await backfill.process(item.bytes, catalogV1());
}
```

Await each logical job or use a producer whose submission rate respects the processor queue budget. Do not collect an unbounded array of upload buffers before processing; queued encoded bytes are a deliberate memory bound.

## Upgrade policy

Application code should depend on:

- exported types;
- stable error codes;
- versioned presets;
- actual output facts.

It should not depend on Sharp options, native diagnostics, or internal module paths.

That keeps engine replacement possible without turning the package into a plugin framework. The package should not accumulate compatibility branches for old application internals.
