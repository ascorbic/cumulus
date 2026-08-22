# Phase 8 — scoped mode

Scope (SPEC.md §12, phase 8 / §8b): `MODE=scoped` turns the deployment into
a private CDN for one app's content. `/r/{did}/{collection}/{rkey}/{cid}`
and `/img/{preset}/r/{did}/{collection}/{rkey}/{cid}[@{format}]` are the
only blob routes; the open `/{did}/{cid}`, `/metadata/…` and
`/img/…/plain/…` routes are disabled (404). Admission is a forward
`getRecord` membership check (invariant 10). A Jetstream drain turns record
deletes/updates into `rec:` tag purges.

## Config

```
MODE                 open | scoped (default open)
SCOPED_COLLECTIONS   comma-separated NSIDs or prefixes ending in `*`
JETSTREAM_URL        e.g. wss://jetstream2.us-east.bsky.network
```

Both routes never coexist: in scoped mode the open routes 404; in open mode
the `/r/` routes 404.

## `Record` entrypoint

`GET /record/{did}/{collection}/{rkey}` → `{ uri, cid, blobs: [cid…] }`,
`max-age=3600`, tags `did:{did}`, `rec:{did}/{collection}/{rkey}`,
`v:`. Resolves the PDS via `Identity`, calls `com.atproto.repo.getRecord`,
walks the value for blob refs. Record missing → 404 `max-age=300` with the
same tags (a just-deleted record stays 404 until the `rec:` purge or TTL —
and a just-created one is served immediately because the PDS is the source).
`purgeTags`/`purgeEverything` RPC like the others, and the admin purge
fan-out includes it (actor purge → `did:` tag; new `POST
/admin/purge/record/{did}/{collection}/{rkey}` → `rec:` tag on default +
Record).

## Admission on the blob miss

`/r/{did}/{collection}/{rkey}/{cid}` → collection must match
`SCOPED_COLLECTIONS` (exact, or prefix `app.example.*`) else 403
`max-age=86400` (config-level, tagged `cfg:`); then `Record` loopback; the
requested `cid` must be in `blobs` else 403 `max-age=86400` tagged `did:`,
`cid:`, `rec:`; then the standard pipeline. Every scoped response (200 and
the tagged errors) carries the `rec:` tag in addition to `did:`/`cid:`/`v:`.
Scoped presets (`/img/{preset}/r/…`) loop back to the scoped original and
inherit its tags.

## Jetstream drain

Shares the cron and the cursor machinery with the label drain: cursor
`cursor:jetstream` in KV (µs timestamp), status `status:jetstream`. Opens
`{JETSTREAM_URL}/subscribe?wantedCollections=…&cursor=…` (JSON frames, not
CBOR). For `kind: "commit"` with `operation` `delete` or `update` on a
wanted collection → purge `rec:{did}/{collection}/{rkey}` on default +
Record. `wantedCollections` accepts prefixes in the same `app.example.*`
form. Batched purges, cursor per batch, idle/budget bounds like the label
drain. First run starts from now (no cursor).

## Tests

Record entrypoint (stubbed PDS), admission (collection allowlist, member vs
non-member cid, missing record), scoped preset path parsing, route gating by
MODE, Jetstream drain with a fake websocket emitting JSON commit events,
admin record purge. Deployed check: switch the deployment to scoped mode
with `SCOPED_COLLECTIONS=app.bsky.actor.profile`, serve the avatar through
`/r/{did}/app.bsky.actor.profile/self/{cid}`, confirm a non-member cid 403s,
run the Jetstream drain once, then switch back to open mode.
