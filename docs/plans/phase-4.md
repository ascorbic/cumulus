# Phase 4 — policy and polish

Scope (SPEC.md §12, phase 4): `/metadata/{did}/{cid}`, external policy
service with fail-open/closed, `cfg:` tag with purge-on-config-change,
structured logs on the miss path.

## `/metadata/{did}/{cid}`

JSON `{ mime, ext, size, width, height, animated }`, same tags and the same
browser/edge `Cache-Control` split as the blob (§7a's long TTL lives in the
edge header). Dimensions come from the first KB of each allowlisted format:

- JPEG: walk markers to the first SOF (`FFC0`–`FFCF` except `C4`, `C8`, `CC`).
- PNG: IHDR at byte 16. Animated if an `acTL` chunk precedes the first `IDAT`.
- GIF: logical screen at byte 6; animated if more than one image descriptor
  (or a NETSCAPE2.0 loop extension) appears.
- WebP: `VP8 ` frame header, `VP8L` bitstream header, or `VP8X` canvas with
  the animation flag.
- AVIF: `ispe` box under `meta/iprp/ipco`; animated when the brand is `avis`.

Unparseable dimensions → `width`/`height` null, still 200 (the type and size
are known). Obtaining the bytes: `ctx.exports.default.fetch()` self-loopback
if the runtime permits it — the metadata miss then reads the cached verified
original rather than re-fetching the PDS, and §8a's open question is settled
here instead of in phase 7. Otherwise the route shares `serveBlob`'s pipeline
in-process.

## External policy service

`POLICY_URL` set → the `Policy` entrypoint calls
`GET {POLICY_URL}/{did}/{cid}` with a 5 s timeout. Contract (new in this
phase, written into SPEC.md §9): `200` allow, `403` deny, anything else or a
network failure is an outage. Outage under `POLICY_FAIL_OPEN=false` (default)
→ Policy returns `502 no-store` and the blob route returns `502 no-store`;
under `POLICY_FAIL_OPEN=true` → `{ allow: true }` with `no-store`, so a
degraded verdict is never cached. The response body from the service is not
interpreted beyond status.

## `cfg:` tag

`cfg:{hash}` where hash is the first 16 hex chars of SHA-256 over
`BLOB_ALLOWED_MIMETYPES` + `BLOB_MAX_SIZE`. Added to 413 and 415 responses
(the two verdicts those values decide). `GET /admin/config` (auth'd,
`no-store`) returns `{ hash, config }` so an operator can record the hash
before changing config; `POST /admin/purge/config/{hash}` purges it on
`default`. In practice a config change is also a new version, so
`/admin/purge/version/{id}` covers the same ground; `cfg:` is the narrower
handle the spec asks for.

## Structured logs

One `console.log` JSON line per blob miss:
`{ event: "blob", did, cid, status, mime, bytes, verified, identityMs,
policyMs, upstreamMs }`; CID mismatches keep their `console.error`. Queryable
in Workers Logs by `$metadata.message` / the JSON fields.

## Tests

`dimensions.test.ts` with hand-built minimal headers per format (animated
and static variants); metadata route contract; Policy with a stubbed
`POLICY_URL` covering allow/deny/outage × fail-open/closed; `cfg:` tag on
413/415 and the admin config route.
