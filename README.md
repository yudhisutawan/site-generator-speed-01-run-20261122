[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/yudhisutawan/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/yudhisutawan/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed — faster drop-in for makefun-site 1.0.0

Entry for `site-generator-speed-01-run-20261122` ("Build a static site faster,
22 November 2026"). `solve.js` is a from-scratch, dependency-free
re-implementation of makefun-site 1.0.0's `build(input)`, written to return
byte-identical output trees while using far less CPU time. `main.ts` is the
kit's driver, unchanged.

## How it is faster (~3.5x the house baseline's `run()` CPU on the practice set)

- **Markdown, single pass.** The reference lexes blocks into token objects
  and then renders them; here blocks are rendered straight from the lines,
  with first-character dispatch instead of a regex test per line.
- **Inline rendering with a regex-guided scan.** Plain runs are flushed
  verbatim (the scanner only stops at a construct or at `&<>"'`), instead of
  escaping every character one by one. Code spans, strong, emphasis and links
  keep the reference's exact semantics, verified by differential fuzzing.
- **Fast HTML escaping.** A regex test short-circuits strings with no special
  characters; otherwise a single replace does the work.
- **Templates compiled to JavaScript.** Each parsed template compiles once per
  build (`new Function`) into a function with direct variable access and
  inlined `if`/`for`/include control flow, instead of walking a node tree
  through a scope chain on every render. Lookup semantics (innermost scope
  first, own properties only, include depth cap 8) are preserved exactly.
- **Cheap primitives.** ASCII fast-path + per-build memo for `slugify`,
  memoized `longDate`, word counting via a whitespace lookup table,
  front matter parsed without splitting the body, reused vars/scope objects
  across renders, reused per-tag card objects, and bulk escaping of fenced
  code bodies.
- **Nothing cached across cases.** Per-build memo tables are reset at the
  start of every `build()` call.

## Verification (local, practice set + fuzzing)

- Practice set: 3/3 cases byte-identical; official kit scorer: `passed: 1`.
- Differential fuzz vs makefun-site 1.0.0: 180 generated sites (60 seeds x 3
  cases), 0 mismatches; unit-level fuzz of slugify (5,200 cases), front
  matter (3,000), Markdown (4,000) and templates (600 templates x 2 var
  sets, parse + render), 0 mismatches.
- Deterministic: two runs of `main.ts` produce byte-identical `answers.json`.
- `run()` CPU time on the practice set (interleaved medians, 20-30 rounds):
  baseline ~506 ms, this entry ~144 ms (~3.5x).

## Files

- `solve.js` — the entry (`run(input)`).
- `main.ts` — the harness driver (kit's, unchanged).
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT.
