# @tinymed/media

Server-side raster processing for untrusted JPEG, PNG, WebP, and AVIF uploads.

The package owns image bytes and processing policy. Storage, HTTP, authorization, and domain state stay in the application.

| Document | Content |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, file homes, pipeline, scheduler |
| [`docs/INTEGRATION.md`](docs/INTEGRATION.md) | Coedula / Faztore cutover |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | Complete-job measurements |

---

## Install

```sh
pnpm add @tinymed/media
```

Node.js 22+. Sharp/libvips is the only runtime dependency and stays private.

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

```text
encoded bytes + declared MIME + recipe
        ↓
  @tinymed/media
        ↓
source facts + encoded outputs + actual geometry
        ↓
application storage / DB / HTTP
```

Identity comes from magic bytes and decoder metadata, not filenames. A job is atomic: every output is returned, or a `MediaError` is thrown. Use `output.width` / `output.height` for `srcset`; never infer them from the recipe.

Interactive crop: `inspectImage` first, then crop in `orientedWidth` × `orientedHeight`.

```ts
const source = await inspectImage(bytes, { declaredMime: file.type });
```

## API

```ts
inspectImage(input, options?): Promise<MediaSource>;
processImage(input, recipe, options?): Promise<MediaResult>;
createProcessor(config?): MediaProcessor;
```

`inspectImage` reads headers; it does not decode a full frame. `processImage` uses one shared processor. `createProcessor` owns an independent JavaScript queue. Sharp's `libvipsConcurrency` is process-wide: every processor in the process must request the same value.

A recipe describes wanted outputs, not an operation graph. Fits: `inside`, `cover`. Upscaling is off unless an output sets `allowUpscale`.

| Preset | Outputs |
|---|---|
| `webImageV1()` | normalized 2560 source, preview 1600 WebP, thumb 480 WebP |
| `studentPhotoV1(crop)` | exact 420×420 WebP |
| `catalogV1(crop?)` | normalized 2560, large 1600, medium 960, thumb 480 |

Released presets are frozen. A different policy gets a new version.

## Errors

Branch on `MediaError.code`, never on `message`. HTTP status and UI copy stay in the application.

```ts
if (isMediaError(error)) console.error(error.code, error.retryable);
```

| Code | retryable |
|---|---|
| `input_too_large` | no |
| `unsupported_format` | no |
| `mime_mismatch` | no |
| `invalid_image` | no |
| `pixel_limit_exceeded` | no |
| `channel_limit_exceeded` | no |
| `multi_page_not_supported` | no |
| `invalid_crop` | no |
| `invalid_recipe` | no |
| `capacity_exceeded` | yes |
| `processing_timeout` | yes |
| `cancelled` | no |
| `processing_failed` | no |

## Capacity

Defaults for a small VPS. Raise `maxActiveJobs` or `libvipsConcurrency` only after a recorded RSS run on that box. See [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

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

Outputs inside one job run sequentially. Parallel native pipelines multiply decoded-frame memory.

## Scripts

| Script | What it does |
|---|---|
| `pnpm run check` | `tsc --noEmit` |
| `pnpm run lint` / `lint:fix` | oxlint |
| `pnpm run format` / `format:check` | Prettier |
| `pnpm run test` | node:test |
| `pnpm run build` | `dist/` |
| `pnpm run bench` | complete-job harness |

## License

MIT.
