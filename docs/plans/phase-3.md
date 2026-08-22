# Phase 3 — entrypoints and purge

Scope (SPEC.md §12, phase 3): split `Identity` and `Policy` into
`WorkerEntrypoint`s with per-entrypoint cache config, wire `ctx.exports`
loopbacks, implement the three purge endpoints with `purgeTags` RPC fan-out,
add the `v:{versionId}` tag via the version metadata binding, flip on
`crossVersionCache`. Plus the decision carried from phase 2: hash the
assembled buffer once with `crypto.subtle.digest`.

## Config

```ts
cache: { enabled: true, crossVersionCache: true },
exports: {
  Identity: exports.worker({ cache: { enabled: true } }),
  Policy:   exports.worker({ cache: { enabled: true } }),
},
env: {
  VERSION: bindings.versionMetadata(),
  ADMIN_PASSWORD: bindings.secret(),
  LABELS_KV: bindings.kv(...)   // deferred to phase 5 with the deny set
},
```

`default` keeps the top-level cache setting. `ADMIN_PASSWORD` absent → every
`/admin/*` route 404s (§9).

## Entrypoints

- **`Identity`** — `GET /did/{did}` → `{ pds }` JSON, `Cache-Control: public,
  max-age=3600, stale-while-revalidate=86400`, `Cache-Tag: did:{did}`. Not
  found → 404 `max-age=300`, same tag. Directory failure → 502 `no-store`.
  Body of `src/identity.ts` moves here unchanged. `purgeTags(tags)` RPC
  method calls `this.ctx.cache.purge({ tags })`.
- **`Policy`** — `GET /check/{did}/{cid}` → `{ allow: boolean }`. Phase 3 has
  no labelers or `POLICY_URL` yet, so every verdict is allow with
  `max-age=3600` and `did:`/`cid:` tags; the shape, TTLs (allow 1h, deny 24h,
  failure `no-store`) and `purgeTags` land now so phase 4/5 only fill in the
  sources.
- **`default`** — blob route calls
  `ctx.exports.Identity.fetch("http://i/did/" + did)` then
  `ctx.exports.Policy.fetch("http://p/check/" + did + "/" + cid)`.
  Loopback responses are cached in the callee's namespace; the blob route
  only reads them.

## Purge

```
POST /admin/purge/actor/{did}  → default tags [did:], Policy tags [did:], Identity tags [did:]
POST /admin/purge/blob/{cid}   → default tags [cid:], Policy tags [cid:]
POST /admin/purge/all          → purgeEverything on default, Policy, Identity
```

Basic auth against `ADMIN_PASSWORD` (any username). Every response
`no-store`; body is the per-entrypoint `{ success, errors }` results verbatim
(§7). Invalid DID/CID → 400. Fan-out is sequential and non-transactional
(§11 #4).

## Version tag

Every cacheable response (blob, 301, 404, 413, 415, Identity, Policy) adds
`v:{VERSION.id}` to `Cache-Tag`. With `crossVersionCache` on, a deploy that
changes headers is followed by `POST /admin/purge/version/{id}` — a fourth
admin route purging tag `v:{id}` on all three entrypoints. (Not in the spec's
route list; it is the "escape hatch" §3 describes and needs a handle.)

## Hashing

`fetchBlob` keeps the chunked read and byte cap, drops `DigestStream`, and
returns the assembled buffer; the caller hashes it once with
`crypto.subtle.digest("SHA-256", bytes)`.

## Tests

- Unit: Identity/Policy fetch handlers via `exports.Identity.fetch()` with
  stubbed upstream; header/tag contract per response.
- Blob route: loopback calls go through `ctx.exports` in workerd, so existing
  worker tests keep stubbing only `globalThis.fetch` (PLC + PDS).
- Purge: `ctx.cache` is absent in the test runtime unless miniflare surfaces
  it — verify; otherwise stub at the handler boundary and assert the fan-out
  sequence and auth behaviour.

## Deploy check

Purge round-trip (§12 phase 2 carry-over): warm a blob (`HIT`), purge by
actor, expect `MISS`, then by blob, then `all`; check Identity's entry is
cold after an actor purge by timing the next miss. Confirm the cache survives
a no-op redeploy (`crossVersionCache`), then a header-changing deploy +
version purge cold-caches.
