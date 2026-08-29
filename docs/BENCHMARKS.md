# Benchmarks

## Status

`bench/media.bench.ts` is the canonical benchmark harness.

No production benchmark table is committed yet. Numbers from an arbitrary development host would look authoritative without answering the question that matters: **how much complete-job work fits safely on the target Debian server?**

Record canonical results here only after running the harness on target-like infrastructure with the Node, Sharp/libvips, memory limit, and processor settings documented alongside them.

## Method

Measure complete logical jobs, not isolated resize calls.

A real job includes:

```text
validate
â†’ inspect metadata
â†’ decode
â†’ orient
â†’ optional crop
â†’ resize
â†’ encode every output
â†’ verify actual output geometry
```

An isolated `sharp.resize()` microbenchmark hides input validation, decode cost, encoder cost, queue behavior, and native peak memory. Those are exactly the costs that determine safe capacity on a small VPS.

The primary capacity metric is **peak RSS under realistic batch load**. Throughput is optimized only after memory behavior is bounded and predictable.

## Corpus

The harness loads real raster samples from `examples/` when present and adds deterministic synthetic JPEGs at approximately:

| Geometry | Megapixels |
|---|---:|
| 4000Ã—3000 | 12 MP |
| 6000Ã—4000 | 24 MP |
| 8000Ã—6000 | 48 MP |

Synthetic noise is deliberate. Flat-color fixtures compress unrealistically well and understate encoded input size and encoder work.

The benchmark raises its encoded-byte ceiling to 64 MiB so the synthetic worst-case corpus can reach the package's 50 MP decoded-pixel boundary. ThhÈ\ÈH™[˜ÚX\šË[Û›Hİ™\œšYK›İH›ÙXİ[Ûˆ™XÛÛ[Y[™][Û‹‚‚ˆÈÈÛÜšÛØYÂ‚•Hİ\œ™[\›™\ÜÈYX\İ\™\Î‚‚ŸÛÜšÛØYÚ]]^\˜Ú\Ù\ÈŸKK_KK_Ÿ[œÜXİ›Ü›X]ÛY]Y]H˜[Y][ÛˆÚ]İ][Yœ˜[YH›ØÙ\ÜÚ[™ÈŸÙX‹Z[XYÙK]ŒXİ[™\™™YK[İ]]\ØYŸÙX‹Z[XYÙK]ŒH
ÈÜ›ÜÜšY[YÜ›Ü\Èİ[™\™\š]˜]]™\ÈŸİY[\İË]ŒX^XİÜ›ÜYY[]HİÈŸÙ\]Y[X[˜]Úİ\İZ[™YÛÛ\]H›ØœÈŸÛÛ˜İ\œ™[˜]ÚØÚY[\‹Ø˜XÚÜ™\Üİ\™H[™XZÈ”ÔÈ[™\ˆ\œİİX›Z\ÜÚ[Ûˆ‚‘›Üˆ]™\HÛÜšÛØY]™\ÜÎ‚‚‹HLMK[™NHÛÛ\]KZ›Øˆ][˜ŞNÂ‹H›ØœÈ\ˆÙXÛÛ™Â‹HXZÈ›ØÙ\ÜÈ”ÔÎÂ‹H]™[[ÛÜNH[^NÂ‹Hİ[İ]]]\Ë‚‚”›ØÙ\ÜÛÜˆY]šXÜÈY][Û˜[H^ÜÙH]Y]YHØZ]]Y]YYX]HXZËÛÛ\][ÛœË˜Z[\™\Ë™Z™Xİ[ÛœË[™[Y[İ]Ë‚‚ˆÈÈ[›š[™Â‚‘Y˜][‚‚˜ÚœœH[ˆ™[˜Ú˜‚‘^XÚ]Ø\XÚ]N‚‚˜ÚœœH[ˆ™[˜ÚKHKZ]\˜][ÛœÈŒKXXİ]™HHK[Xš\ÈHKX˜]ÚL˜‚HØ\XÚ]HÚ[[™Ù\‚‚˜ÚœœH[ˆ™[˜ÚKHKZ]\˜][ÛœÈŒKXXİ]™HˆK[Xš\ÈHKX˜]ÚŒ˜‚‘È›İÛÛ\\™HÛÈ[œÈ]Ú[™ÙYÛÜœ\Ë›ÙKÔÚ\œ™\œÚ[ÛœË›ØÙ\ÜÛÜˆ[Z]ËÜˆÜİY[[ÜHÚ]İ]™XÛÜ™[™ÈÜÙHY™™\™[˜Ù\Ë‚‚ˆÈÈ\™Ù][ZÙH›ØÙY\™B‚‘›ÜˆH™\İ[ÛÜÙY\[™Î‚‚ŒKˆ\ÙHHØ[YH›ÙHXZ›Üˆ™\œÚ[Ûˆ\È›ÙXİ[Û‹‚Œ‹ˆ[œİ[œ›ÛHHØÚÙš[K‚ŒËˆ™XÛÜ™›ÙXÚ\œ[™Xš\È™\œÚ[ÛœÈš[YHH\›™\ÜË‚ˆ\HHØ[YHÛÛZ[™\‹ØÙÜ›İ\Üˆ”ÈY[[ÜHÛÛœİ˜Z[\È›ÙXİ[Û‹‚Kˆ[ˆÛ˜ÙHÈØ\›Hš[\Ş\İ[H[™˜]]™HXœ˜\HØY[™Ë‚‹ˆ[ˆHYX\İ\™YÛÜšÛØY][\H[Y\Ë‚Ëˆ™XÛÜ™HÛÜœİXZÈ”ÔÈ[™™\™\Ù[]]™HLÜMKÜNK‚ˆ[œÜXİİ]][Y[œÚ[ÛœÈ[™š[HÚ^™\È›ÜˆH™X[ÛÜœ\Ë‚KˆÛÛ\\™H[XYÙH]X[]Hš\İX[H™Y›Ü™HXØÙ\[™ÈHÛÙXËÜ]X[]HÚ[™ÙK‚ŒLˆ™\X]Y\ˆÚ[™Ú[™ÈXİ]™H›ØœÈÜˆXš\ÈÛÛ˜İ\œ™[˜ŞK‚‚’Yˆ]˜Z[X›K™XÛÜ™ÙÜ›İ\XZÈY[[ÜH\ÈÙ[\È›ØÙ\ÜÈ”ÔÎÈ˜]]™H[ØØ]ÜœÈ[™›ØÙ\ÜÈÛ[™ÈØ[ˆXZÙHÚÜXZÜÈ\™ÈØœÙ\™Hœ›ÛH˜]˜TØÜš\[Û™K‚‚ˆÈÈØ\XÚ]HXÚ\Ú[Û‚‚”İ\œ›ÛN‚‚˜^›X^Xİ]™R›ØœÈHB›Xš\ĞÛÛ˜İ\œ™[˜ŞHHB˜‚’[˜Ü™X\ÙHÛ›HÚ[ˆ\™Ù]YX\İ\™[Y[ÈÚİÈ[\ÙYØY™HØ\XÚ]K‚‚H›İYÚ]ØZ[ˆ\È™Z™XİYYˆ]XZÙ\ÈXZÈY[[ÜHY™šXİ[È™YXİÜˆ\Ú\È™X[\İXÈ˜]Ú\ÈÛÜÙHÈHÜİ[Z]ˆHÛX[”ÈÚİ[˜Z[Ú]›İ[™Y˜XÚÜ™\Üİ\™H˜]\ˆ[ˆÚ[ˆHŞ[]XÈ›İYÚ]Ú\[™]\ˆ™HÚ[YHHÓÓHÚ[\‹‚‚ˆÈÈ[™Ú[™HÚ[[™Ù\ˆØ]B‚‘È›İÚ\Ú\œ[™HÚ[[™Ù\ˆ[™Ú[™HÙÙ]\‹‚‚H™\XÙ[Y[]\İš\œİXÚY]™H™Z]š[Ü˜[\š]HÛˆHØ[YHÛÜœ\Ë™XÚ\\Ë[Z]ËX[›Ü›YY[œ]ËÜšY[][Û‹ØÜ›ÜØ\Ù\Ë[™İ]]™\]Z\™[Y[Ëˆ[ˆ]]\İ[[Ûœİ˜]H]X\İÛ™HX]\šX[[\›İ™[Y[‚‚˜^HÌ	HYÚ\ˆÛÛ\]KZ›Øˆ›İYÚ]“Ô‚HÌ	HİÙ\ˆMHÛÛ\]KZ›Øˆ][˜ŞB“Ô‚HIHİÙ\ˆXZÈ”ÔÂ˜‚Ú]›ÈYX[š[™Ù[™YÜ™\ÜÚ[Ûˆ[‚‚‹Hš\İX[]X[]NÂ‹Hİ]]]HÚ^™NÂ‹HÜ›ÜÛÜšY[][ÛˆÛÜœ™Xİ™\ÜÎÂ‹HX[›Ü›YYZ[œ][™[™ÎÂ‹HXšX[ˆ[œİ[][ÛÂ‹HÜ\˜][Û˜[ÛÛ\^]K‚‚HZXÜ›Ø™[˜ÚX\šÈÚ[ˆ\È›İİY™šXÚY[‚‚ˆÈÈ™\İ[È[\]B‚•Ú[ˆ\™Ù]YX\İ\™[Y[È\™H]˜Z[X›K™XÛÜ™[HÚ]H[š\›Û›Y[‚‚˜^™]N‚šÜİÈÔN‚›Y[[ÜH[Z]‚“›ÙN‚”Ú\œ‚›Xš\Î‚›X^Xİ]™R›ØœÎ‚›Xš\ĞÛÛ˜İ\œ™[˜ŞN‚š]\˜][ÛœÎ‚˜˜]Ú‚˜‚•[ˆY‚‚ŸÛÜšÛØYLMHNH›ØœËÜÈXZÈ”ÔÈÛÜNHŸKK_KKNŸKKNŸKKNŸKKNŸKKNŸKKNŸŸ[œÜXİ8 %8 %8 %8 %8 %8 %ŸÙX‹Z[XYÙK]ŒH8 %8 %8 %8 %8 %8 %ŸÙX‹Z[XYÙK]ŒH
ÈÜ›Ü8 %8 %8 %8 %8 %8 %ŸİY[\İË]ŒH8 %8 %8 %8 %8 %8 %Ÿ˜]Ú8 %8 %8 %8 %8 %8 %ŸÛÛ˜İ\œ™[˜]Ú8 %8 %8 %8 %8 %8 %‚“™]™\ˆ™\Ù\™HH™\İ[Y\ˆÚ[™Ú[™ÈH™[˜ÚX\šÈÛÛ˜XİÚ]İ]X\šÚ[™È]\ÈHY™™\™[[‹‚