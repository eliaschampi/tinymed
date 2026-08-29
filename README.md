# @tinymed/media

Small server-side image processing for untrusted raster uploads.

`@tinymed/media` turns encoded JPEG, PNG, WebP, or AVIF bytes into validated, deterministic, optimized outputs. It owns image bytes and processing policy only: no storage, transport, authorization, database, framework, or domain state.

## Install

```sh
pnpm add @tinymed/media
```

Requires Node.js 22 or newer. Sharp/libvips is the only runtime dependency and remains private to the package.

## Quick start

```ts
import { processImage, webImageV1 } from '@tinymed/media';

const result = await processImage(uploadedBytes, webImageV1(), {
	declaredMime: file.type
});

for (const output of result.outputs) {
	await store(output.key, output.bytes);
	console.log(output.width, output.height);
}
```

The public contract is intentionally narrow:

```text
encoded bytes + declared MIME + recipe
                  ↓
            @tinymed/media
                  ↓
validated source facts + encoded outputs + actual geometry
                  ↓
        application storage / DB / HTTP
```

## Guarantees

Processing order is fixed:

```text
byte limit
→ format detection
→ declared MIME check
→ metadata and structural limits
→ EXIF orientation
→ optional crop
→ resize
→ encode
→ output verification
```

A processing job is atomic at the API boundary: every requested output is returned or a `MediaError` is thrown. No partial result is exposed.

Input identity comes from magic bytes and decoder metadata, not filenames or client MIME. Animated and multi-page inputs are rejected. Crop coordinates use the auto-oriented source coordinate space.

Output geometry is factual. Use `output.width` and `output.height` for responsive-image metadata; never infer dimensions from the requested resize box.

## API

```ts
inspectImage(input, options?): Promise<MediaSource>;
processImage(input, recipe, options?): Promise<MediaResult>;
createProcessor(config?): MediaProcessor;
```

`inspectImage` validates the input and reads structural metadata without decoding a full frame.

`processImage` runs one logical job using the shared processor.

`createProcessor` creates an independent JavaScript scheduling budget. Sharp/libvips thread concurrency is process-wide, so every processor in one Node process must request the same `libvipsConcurrency`.

### Recipes

A recipe describes wanted outputs, not an operation graph.

```ts
const recipe = {
	crop: { left: 120, top: 40, width: 800, height: 800 },
	outputs: [
		{ key: 'normalized', format: 'source', width: 2560, height: 2560, fit: 'inside' },
		{ key: 'card', format: 'webp', width: 400, height: 400, fit: 'cover' }
	]
};
```

Supported resize modes are `inside` and `cover`. Upscaling is disabled unless an output explicitly enables it.

### Presets

| Preset | Purpose | Outputs |
|---|---|---|
| `webImageV1()` | General application images | normalized 2560 source, preview 1600 WebP, thumb 480 WebP |
| `studentPhotoV1(crop)` | Cropped student identity photo | exact 420×420 WebP |
| `catalogV1(crop?)` | Public catalog/product image | normalized 2560, large 1600, medium 960, thumb 480 |

Released preset behavior is frozen. A materially different policy gets a new preset version.

## Errors

All operational failures use `MediaError` with a stable `code`.

```ts
import { isMediaError } from '@tinymed/media';

try {
	await processImage(bytes, webImageV1());
} catch (error) {
	if (isMediaError(error)) {
		console.error(error.code, error.retryable);
	}
}
```

Codes cover invalid input, MIME mismatch, size/pixel/channel limits, invalid crop/recipe, capacity exhaustion, timeout, cancellation, and processing failure. Messages are intentionally log-safe and do not forward native diagnostics.

## Capacity

Default limits are conservative for small server deployments:

| Limit | Default |
|---|---:|
| Encoded input | 32 MiB |
| Decoded pixels | 50,000,000 |
| Channels | 4 |
| Outputs per job | 8 |
| Output edge | 8192 px |
| Active jobs | 1 |
| Queued jobs | 16 |
| Queued encoded bytes | 128 MiB |
| Execution timeout | 30 s |
| libvips concurrency | 1 process-wide |

Outputs inside one job are rendered sequentially. This is deliberate: parallel native pipelines multiply decoded-frame memory even when JavaScript sees only one logical request.

## Development

```sh
pnpm install
pnpm run format:check
pnpm run lint
pnpm run check
pnpm run test
pnpm run build
pnpm run bench
```

## Documentation

- [Foundation](docs/FOUNDATION.md) — why the package exists, security assumptions, scope, and non-goals.
- [Architecture](docs/ARCHITECTURE.md) — dependency direction, ownership, concurrency, and implementation decisions.
- [Integration](docs/INTEGRATION.md) — consumer ownership and safe adoption patterns.
- [Benchmarks](docs/BENCHMARKS.md) — benchmark method, workloads, metrics, and acceptance gates.

## License

MIT.
