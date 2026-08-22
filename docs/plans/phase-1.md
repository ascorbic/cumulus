# Phase 1 — skeleton and hot path

Scope (SPEC.md §12, phase 1): single `default` entrypoint, caching enabled,
the blob route end to end, deploy and confirm `MISS`→`HIT` and that `Range`
requests `HIT` without invoking the Worker.

## Platform facts verified against current docs (2026-08-22)

- Cache key = entrypoint + path + query (+ Worker version unless
  `crossVersionCache`). Host and method are not in the key; GET/HEAD share an
  entry.
- Only GET/HEAD are cached. `Authorization` requests and `Set-Cookie`
  responses bypass.
- Heuristic freshness applies to responses without explicit directives —
  hence invariant 1 (every response sets `Cache-Control`).
- `206` is never stored; the platform slices ranges from stored `200`s.
- `ctx.cache.purge({ tags | pathPrefixes | purgeEverything })` is scoped to
  the calling entrypoint. `Cache-Tag` tags: printable ASCII, ≤1024 chars,
  ≤1000/response, case-insensitive match.
- `cloudflare.config.ts` (`@cloudflare/vite-plugin/experimental-config`)
  exposes `cache: { enabled, crossVersionCache }`, `exports: { X:
  exports.worker({ cache }) }` and `bindings.versionMetadata()` natively —
  no wrangler.jsonc fallback needed.
- `crypto.DigestStream` and `ctx.cache` are present in the runtime types.

## Open platform question carried into phase 2

The spec (§7, §9) defaults to a split `Cache-Control: public,
max-age={BROWSER_MAX_AGE}` + `cloudflare-cdn-cache-control:
max-age={EDGE_MAX_AGE}, immutable`. The Workers Cache docs only mention
`Cache-Control`; whether `cloudflare-cdn-cache-control` is honoured (and
stripped) by Workers Cache is unverified. Phase 1 implements the split as
specified. Phase 2 experiment: deploy with `BROWSER_MAX_AGE=60`, request a
blob, wait >60s, request again — a `HIT` proves the edge header is honoured;
an `EXPIRED`/`MISS` means the long TTL must go on `Cache-Control` and
BROWSER_MAX_AGE is unimplementable.

## Modules

- `src/config.ts` — reads `BLOB_MAX_SIZE`, `BLOB_ALLOWED_MIMETYPES`,
  `BLOB_FETCH_TIMEOUT`, `PLC_URL`, `BROWSER_MAX_AGE`, `EDGE_MAX_AGE` from env
  with the §9 defaults.
- `src/path.ts` — parse `/{did}/{cid}`; classify as blob / redirect-to-
  canonical / bad. `did:plc` ids are case-sensitive base32 (uppercase → 400,
  not alias). `did:web` host is case-insensitive → lowercased in the
  canonical form. CID `B…` (base32upper) → lowercased. Trailing slashes and
  percent-encoding → redirect.
- `src/cid.ts` — base32 decode + structural check: v1, codec raw (0x55),
  multihash sha2-256 (0x12, 32 bytes). Returns the digest.
- `src/sniff.ts` — magic bytes for jpeg/png/gif/webp/avif(+avis), plus the
  extension table for `Content-Disposition`.
- `src/identity.ts` — DID → PDS URL, inline (the `Identity` entrypoint is
  phase 3). `did:plc` via `PLC_URL`, `did:web` via `did.json`. Rejects
  non-`https:` and non-public PDS hostnames.
- `src/blob.ts` — `getBlob` fetch with timeout, `Content-Length` pre-check,
  single-pass read into memory + `DigestStream`, actual-byte size cap.
- `src/response.ts` — the §5 header contract for success and the error
  taxonomy; every response sets `Cache-Control`.
- `src/index.ts` — hand-rolled router: `GET|HEAD /{did}/{cid}`,
  `GET /healthz`, everything else 404/405 with explicit `Cache-Control`.
  `Range` is ignored (the platform slices). Never returns 206.

## Tests

Unit (pure, run in workerd): cid decode, sniffing, path classification.
Worker-level: `exports.default.fetch()` with `globalThis.fetch` stubbed for
PLC/PDS; asserts status, `Cache-Control`, `Cache-Tag`, security headers, the
415/413/502/404/301/400 taxonomy, HEAD, Range-ignored, healthz.

Deployed `Cf-Cache-Status` assertions are phase 6's integration suite; phase 1
checks them by hand after deploy.

## Deferred to later phases (on purpose)

`Identity`/`Policy` entrypoints, purge endpoints, `v:{versionId}` tag and
`crossVersionCache` (phase 3); `cfg:` tag, structured logs (phase 4).

## Deployed results (2026-08-22, cumulus.ascorbic.workers.dev)

- Blob: `MISS` → `HIT` → `HIT`. HEAD on the warm entry: `HIT`.
- 301 (uppercase CID): `MISS` → `HIT`, `max-age=86400`. 404 (missing blob):
  `MISS` → `HIT`, `max-age=300`. 400: `max-age=86400`. `/healthz` (`no-store`):
  `BYPASS`.
- `cache-tag` and `cloudflare-cdn-cache-control` are stripped from the
  client-facing response; `cache-control: public, max-age=3600` passes through.
  Whether the edge TTL is honoured remains the phase 2 timed experiment.
- **Range is not sliced.** `Range: bytes=0-99` on a cold entry and on a warm
  entry both return `200` with the full body (`HIT` on the warm entry, so the
  Worker did not run). No `Accept-Ranges`, `206` or `Content-Range` was
  observed. This contradicts SPEC.md §6's "free lunch" claim as currently
  deployed; the response carries no `Accept-Ranges: bytes`, which is the first
  thing to try.
