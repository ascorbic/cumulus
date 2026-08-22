# Phase 2 — measurements

Branch `phase-2-bench`, version `70cc1ab2`, 2026-08-22. Numbers are
`$workers.cpuTimeMs` from Workers Logs (in-Worker timers do not advance during
CPU work). Route: `GET /_bench/{mb}/{method}`, bytes generated in memory so no
network is involved. `fill` allocates and fills the buffer (memcpy of a 64 KB
random seed) and is the baseline; `stream` adds `crypto.DigestStream` in 1 MB
writes (the production path); `subtle` adds one `crypto.subtle.digest` over
the whole buffer.

## DigestStream CPU (risk #1)

CPU ms per invocation, three runs each:

| size | fill | stream | subtle |
|---|---|---|---|
| 1 MB | 1, 1, 0 | 3, 2, 2 | 2, 1, 1 |
| 5 MB | 3, 4, 3 | 12, 7, 10 | 9, 9, 10 |
| 10 MB | 6, 6, 5 | 11, 12, 12 | 12, 12, 18 |
| 25 MB | 16, 23, 13 | 38, 46, 44 | 29, 34, 29 |

Findings:

- **Native SHA-256 is billed as CPU.** Hashing costs ≈1.1–1.3 ms/MB on top of
  the buffer work (stream − fill). The spec's "~15–25 ms for 25 MB" estimate
  was right; total invocation CPU for a 25 MB verify is 40–45 ms.
- **Free plan (10 ms):** a 5 MB blob already lands at 7–12 ms — over the cap
  on bad runs. Safe Free default: **`BLOB_MAX_SIZE=3mb`** (≈5–7 ms), with
  4 MB as the aggressive ceiling. Paid (30 s) is unaffected at any size the
  128 MB isolate can buffer.
- `crypto.subtle.digest` over the assembled buffer is ~25% cheaper than
  `DigestStream` at 25 MB (29–34 vs 38–46 ms) and no worse at small sizes.
  Since the pipeline buffers every byte before serving anyway, hashing the
  final buffer once instead of streaming chunks through `DigestStream` is a
  free win. Candidate change for phase 3; not applied here.
- Real-blob misses through the full pipeline (DID resolution + PDS fetch +
  verify + sniff), for calibration: 63 KB avatar 3–4 ms CPU (wall 0.9–1.1 s,
  almost all upstream latency); 585 KB banner 7 ms. The fixed per-miss
  overhead is therefore ~3 ms, consistent with the bench intercepts.

## Edge TTL split (§7/§9 default)

Deployed with `BROWSER_MAX_AGE=60` while the edge header stayed
`cloudflare-cdn-cache-control: max-age=31536000, immutable`:

- 08:02:58 `MISS`, client sees `cache-control: public, max-age=60`.
- 08:04:37 `HIT`, `age: 97`.

**`cloudflare-cdn-cache-control` is honoured by Workers Cache** and stripped
from the client response; the entry outlived its browser `max-age`. The split
default in §9 is implementable as specified.

## Purge smoke test

Not run in this phase — `ctx.cache.purge` lands with the admin endpoints in
phase 3, whose deploy check covers purge → `MISS`.
