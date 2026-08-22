# Phase 5 — labeller integration

Scope (SPEC.md §12, phase 5 / §7a): pull-side `queryLabels` in Policy with
`LABELER_FAIL_OPEN`; the cron drain as purge trigger (cursor from now, KV
cursor persistence, batched purge fan-out); record-level enrichment via
`getRecord` + the KV deny set; negation handling; `/admin/labels/status`.
Signature verification is the stretch goal and is **not** in this phase.

## Config

```
LABELERS            JSON [{ "did": "did:plc:…", "vals": ["!takedown"] }]
LABELER_FAIL_OPEN   default true
LABELS_KV           bindings.kv() — auto-provisioned on first deploy
cron                triggers.scheduled({ schedule: "*/5 * * * *" })
```

Labelers are identified by DID; the service endpoint comes from the DID
document's `#atproto_labeler` service (`type: AtprotoLabeler`) via a new
`Identity` route `GET /labeler/{did}` → `{ endpoint }`, cached like `/did/`.

## Pull (Policy miss)

For each configured labeler: `GET {endpoint}/xrpc/com.atproto.label.queryLabels?uriPatterns={did}&sources={labelerDid}`
with a 5 s timeout. A label denies when `uri === did` (account level),
`val` is in the labeler's configured `vals`, `neg` is not true, and `exp`
(if present) is in the future. Record-level labels are not queried here —
they come from the KV deny set (`deny:{did}/{cid}`), written by the drain.
Labeler unreachable → `LABELER_FAIL_OPEN=true` (default): `{ allow: true,
degraded: true }` with `no-store`; `false`: 502 `no-store`.

Order on a Policy miss: KV deny set → external policy service (if
configured) → labelers. Any deny short-circuits.

## Drain (cron)

`scheduled()` runs `drain(env, ctx)`:

1. For each labeler, read cursor `cursor:{labelerDid}` from KV. None → open
   `subscribeLabels` without a cursor (live from now); otherwise
   `?cursor={seq}`.
2. Websocket via `fetch(url, { headers: { Upgrade: "websocket" } })` →
   `response.webSocket`. Frames are two concatenated DAG-CBOR items: header
   `{ op, t }` and body. `op: 1, t: "#labels"` → `{ seq, labels }`;
   `t: "#info"` (OutdatedCursor) is logged; `op: -1` is an error frame.
3. Read until the socket has been idle for 2 s (caught up) or the drain's
   budget (20 s per labeler) elapses, then close.
4. Each enforced label (`val` in `vals`) becomes work: account-level →
   purge `did:{did}` on default + Policy (negation identical — the next pull
   re-evaluates, and purging clears cached 403s); record-level →
   `getRecord` via the PDS, walk for blob refs, write `deny:{did}/{cid}` (and
   `rec:{uri}` → cid list) to KV, purge the blob tags; negation deletes those
   keys and purges again. `getRecord` 404 → use the label's `cid` as a
   candidate blob CID if present, else log and skip (§11 #5).
5. Purge tags are batched (≤100 per call) and the cursor is written after
   each batch, so a crash replays at most one batch — idempotent.
6. `status:{labelerDid}` in KV records the last drain time, last seq and
   event count for `/admin/labels/status`.

No Durable Objects, Queues or Workflows (invariant 8). Overlapping drains
are harmless: same cursor, idempotent purges.

## Tests

- `labels.test.ts`: deny filtering (val match, neg, exp), queryLabels client
  shape, labeler endpoint extraction from a DID document.
- Policy: labelers stubbed via `globalThis.fetch` — deny → 24 h verdict;
  outage fail-open → degraded `no-store`; fail-closed → 502; KV deny set
  hit → deny.
- Drain: the stubbed fetch returns a `WebSocketPair` server side that emits
  CBOR frames; assert cursor persistence, batched purge calls (purge stubbed
  at the `purgeTags` boundary — no `ctx.cache` in miniflare), record-level
  KV writes and negation cleanup.
- Admin: `/admin/labels/status` shape.

## Deploy check

Configure `LABELERS` with Bluesky's moderation service
(`did:plc:ar7c4by46qjdydhdevvrndac`), deploy, trigger the cron once, and
confirm `/admin/labels/status` shows a cursor; query a known-labelled DID
through `/check/` and confirm the 403 path caches and purges.

## Deployed results (2026-08-22, version adabe810)

- `bindings.kv()` without an id auto-provisions on `cf deploy`
  (`cumulus-labels-kv`, `c8c78d35…`); no KV CLI step needed.
- Text bindings read deploy-time `process.env` in `cloudflare.config.ts`, so
  `.env` (gitignored) is the operator's settings file. Shell-source it with
  values quoted — `LABELERS='[…]'` — or the JSON loses its quotes.
- First `POST /admin/labels/drain` against `did:plc:ar7c4by46qjdydhdevvrndac`
  (no cursor → live from now) ran 11 s, saw one real `!takedown`, purged one
  tag, stored seq 40830398. The second drain resumed from the cursor
  (`?cursor=40830398`), advanced to 40830399 with zero enforced events.
- A purged blob re-served `200 MISS` with the labeler pull on the Policy miss
  path — no outage logged.
- Gotcha: in workerd, binary websocket frames arrive as `Blob`, not
  `ArrayBuffer`; the reader handles both.
- Not done: label signature verification (stretch goal).
