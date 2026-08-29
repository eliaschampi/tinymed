# Benchmarks

`pnpm bench` runs `bench/media.bench.ts`. The tables below are a real harness run on this development host. They are **not** the 4 GB Debian VPS gate. Re-run there before raising `maxActiveJobs` or `libvipsConcurrency`.

```text
real target: Debian VPS, 4 GB, same Node as production
headline metric: peak RSS under a realistic concurrent batch
```

---

## Method

Measure complete logical jobs, not isolated `sharp.resize()` calls. A job includes validation, inspect, decode, orient, optional crop, every encode, and geometry verification. Those are the costs that decide capacity on a small VPS.

The harness renders outputs sequentially, same as the processor. It raises `maxInputBytes` to 64 MiB so the synthetic 48 MP JPEG can reach the 50 MP decode ceiling. That override is a bench setting, not a package default.

```sh
pnpm bench
pnpm bench -- --iterations 20 --active 2 --libvips 2 --batch 10
```

| Flag | Default | Meaning |
|---|---:|---|
| `--iterations` | 10 | repeats of inspect / web-image-v1 / crop / student-photo |
| `--active` | 1 | `maxActiveJobs` |
| `--libvips` | 1 | process-wide libvips threads |
| `--batch` | 10 | sequential and concurrent batch size |

libvips threads are process-wide. Sweep concurrency with **separate process** invocations:

```sh
pnpm bench -- --active 1 --libvips 1
pnpm bench -- --active 2 --libvips 2
```

Corpus: one real photograph in `examples/` (3 MP portrait JPEG with EXIF) plus deterministic noise JPEGs at 12 / 24 / 48 MP. Extra near-duplicate photos do not change the contract. Flat-colour fixtures would understate encoded size and encoder work.

| Workload | Represents |
|---|---|
| `inspect` | Header validation of an upload that may still be rejected |
| `web-image-v1` | Write path: normalized + preview + thumb |
| `web-image-v1 + crop` | Same with an extract |
| `student-photo-v1` | Exact 420×420 cover crop |
| `batch xN` | Sequential jobs across the corpus |
| `concurrent batch xN` | Same jobs submitted together; the queue must bound RSS |

Latency is `durationMs + queueWaitMs`. Production pays for wait plus work. Keep the run header with any pasted table:

```text
node <version> | sharp <version> | libvips <version>
activeJobs=1 libvipsConcurrency=1 iterations=10
```

---

## Recorded run — 2026-08-28

Host: Deepin 23.1, Linux 6.12.20 x86_64, 16 cores, 11 GiB RAM. Local Sharp/libvips, not a 4 GB cgroup.

```text
node v22.22.2 | sharp 0.35.4 | libvips 8.18.6
activeJobs=1 libvipsConcurrency=1 iterations=10
```

### Corpus

| sample | MP | encoded |
|---|---:|---:|
| photo.jpg | 3.0 | 0.4 MiB |
| synthetic-4000x3000 | 12.0 | 8.9 MiB |
| synthetic-6000x4000 | 24.0 | 17.8 MiB |
| synthetic-8000x6000 | 48.0 | 35.5 MiB |

`inspect` / `web-image-v1` / crop / student-photo use `photo.jpg`. Batch workloads walk the whole corpus, so their p95 is the 24–48 MP tail.

### Latency and RSS

| workload | jobs | p50 | p95 | p99 | jobs/s | peak RSS | loop p99 |
|---|---:|---:|---:|---:|---:|---:|---:|
| inspect | 10 | 0.7 ms | 16.4 ms | 16.4 ms | 400.61 | 488.5 MiB | 16.4 ms |
| web-image-v1 | 10 | 494.6 ms | 503.9 ms | 503.9 ms | 2.03 | 374.4 MiB | 2.1 ms |
| web-image-v1 + crop | 10 | 459.7 ms | 486.4 ms | 486.4 ms | 2.17 | 393.1 MiB | 2.1 ms |
| student-photo-v1 | 10 | 38.5 ms | 56.4 ms | 56.4 ms | 24.11 | 388.8 MiB | 1.9 ms |
| batch x10 | 10 | 2157.8 ms | 2351.5 ms | 2351.5 ms | 0.60 | 476.7 MiB | 1.9 ms |
| concurrent batch x10 | 10 | 9518.8 ms | 16397.9 ms | 16397.9 ms | 0.61 | 486.1 MiB | 1.8 ms |

Peak RSS overall: **488.5 MiB**. Concurrent batch did not raise RSS above sequential batch: `maxActiveJobs` stayed 1, so extra latency is queue wait (peak 14268.0 ms), not overlapping native work. The batch cycle is one 3 MP photo plus the 12–48 MP synthetics.

```text
completed=50  failed=0  rejected=0  timedOut=0
peakQueueWait=14268.0ms  peakQueuedBytes=133.9MiB
cgroup peak RSS=not measured on this host
```

### Output sizes (web-image-v1)

Actual encoded geometry, not the requested box.

| sample | MP | normalized | preview | thumb |
|---|---:|---|---|---|
| photo.jpg | 3.0 | 1500×2000 318 KiB | 1200×1600 152 KiB | 360×480 23 KiB |
| synthetic-4000x3000 | 12.0 | 2560×1920 2142 KiB | 1600×1200 848 KiB | 480×360 16 KiB |
| synthetic-6000x4000 | 24.0 | 2560×1707 1480 KiB | 1600×1067 655 KiB | 480×320 2 KiB |
| synthetic-8000x6000 | 48.0 | 2560×1920 1398 KiB | 1600×1200 601 KiB | 480×360 1 KiB |

Portrait `photo.jpg` preview is **1200w**, not 1600w. That is why `srcset` must use `output.width`.

Synthetic thumbs of 1–2 KiB are a noise-corpus artifact: incompressible source becomes near-uniform after a 480-long-edge resize. Real photographs will not look like that. Do not treat those thumb sizes as a preset quality signal.

Raising `maxActiveJobs` multiplies the whole job. Raising `libvipsConcurrency` multiplies tile buffers inside one job. Do not add a worker pool, a cache, or a second engine to chase a laptop number.

---

## Still required on the VPS

| Measurement | Why |
|---|---|
| Concurrent-batch process peak RSS | Decides whether the box can share OMR + Postgres |
| Concurrent-batch cgroup peak RSS | Allocator / extra-process cost |
| Event-loop delay during batch | Whether native work starves HTTP |
| Queue rejections under burst | Whether the byte budget binds before RAM |
| 48 MP job RSS at active=1, libvips=1 | Worst-case single upload |
| Same job at active=2 or libvips=2 | Raise only if RSS still fits 4 GB |
| Visual review of crop + EXIF 6 | Geometry, not just timing |
| Image work while OMR is active | Coedula shares the box |

---

## Engine challenger

Do not install `@napi-rs/image` beside Sharp in the production package.

A replacement uses the same corpus, recipes, limits, and output requirements, on the target host, and must show behavioural parity plus at least one of:

```text
>= 30% higher complete-job throughput
OR >= 30% lower p95 complete-job latency
OR >= 25% lower peak RSS
```

with no meaningful regression in quality, output bytes, crop/EXIF correctness, malformed-input handling, Debian install, or operational complexity.

Do not support two production engines. The public API stays unchanged.
