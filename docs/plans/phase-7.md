# Phase 7 — image presets

Scope (SPEC.md §12, phase 7 / §8a): `GET /img/{preset}/plain/{did}/{cid}[@{format}]`
backed by an Images binding, presets pinned to Bluesky's appview
definitions, loopback-to-original, EXIF stripping, tag parity.

## Verified against sources (2026-08-22)

- `packages/bsky/src/image/uri.ts`: `avatar` cover 1000×1000, `banner`
  cover 3000×1000, `feed_thumbnail` inside 2000×2000, `feed_fullsize`
  inside 1000×1000; all webp by default, `min: true`; bsky's suffix list is
  `jpeg`/`webp`; the spec's `png` is offered too since the binding encodes it.
- Images binding (`env.IMAGES.input(stream).transform({…}).output({…})`):
  `fit` takes `scale-down | contain | pad | squeeze | cover | crop`;
  `output({ format, quality, anim, background })` with `format` in
  `image/jpeg | image/png | image/gif | image/webp | image/avif`; result
  `.response()` / `.contentType()` / `.image()`. The runtime types carry no
  `metadata` transform option (the docs page mentions one) — re-encoding to
  webp/png drops EXIF regardless, and jpeg output is documented to strip
  everything but copyright by default. Declared in config as
  `IMAGES: bindings.images()` when `IMAGES_ENABLED=true` at deploy time;
  absent binding → the route 404s.

## Mapping

| preset | bsky | binding |
|---|---|---|
| avatar | cover 1000² min | `fit: "cover", width: 1000, height: 1000` |
| banner | cover 3000×1000 min | `fit: "cover", width: 3000, height: 1000` |
| feed_thumbnail | inside 2000² min | `fit: "contain", width: 2000, height: 2000` |
| feed_fullsize | inside 1000² min | `fit: "contain", width: 1000, height: 1000` |

`min: true` (upscale permitted) → `contain` rather than `scale-down`.
`anim: true` so animated GIF/WebP stays animated in webp output. Output `format` from the suffix, default `image/webp`.

## Route

`/img/{preset}/plain/{did}/{cid}` and `…/{cid}@{format}`. Canonicalisation:
same rules as the blob path for `did`/`cid`; unknown preset or format → 400
(`max-age=86400`); non-canonical → 301 to the canonical `/img/…` path. The
miss flow loops back to `default` for the verified original (`ctx.exports.
default.fetch`, settled in phase 4), passes any non-200 straight through,
transforms, and serves with the §5 contract (same `did:`/`cid:`/`v:` tags,
sniffed-type-free since the binding reports `contentType()`). Transform
errors → 502 `no-store`. No `IMAGES` binding → 404 `max-age=300`.

## Tests

The binding is remote-only in miniflare, so tests stub `env.IMAGES` with a
fake whose `output()` records the transform chain and returns fixed bytes;
assert preset → options mapping, format suffix handling, 301/400 cases,
pass-through of original errors, and headers/tags. Deployed check: real
transform of the test avatar at each preset, `MISS` → `HIT`, and a
`purge blob` clearing both the original and the variants.

## Deployed results (2026-08-22, version 1d79cbde)

- `IMAGES_ENABLED=true` in `.env` adds the binding at deploy time; the
  route 404s without it.
- Real transforms of the 400×400 test avatar: `avatar` 1000×1000 webp,
  `banner` 3000×1000, `feed_thumbnail` 2000×2000, `feed_fullsize` 1000×1000
  — upscaled as bsky's `min: true` implies; `@jpeg` and `@png` encode too.
  `MISS` → `HIT` per variant.
- `anim: true` is only passed for webp output; the first jpeg/png attempts
  returned 502 and succeeded after that change plus a redeploy (one later
  jpeg failure looked transient — the route now echoes the binding's error
  message in the 502 body so the cause is visible without log access).
- `POST /admin/purge/blob/{cid}` cleared the variant (`MISS` next request);
  the variant's loopback then re-cached the original, so the original's
  following request is a `HIT` by design.
