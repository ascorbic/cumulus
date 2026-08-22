# Cumulus

An ATProto blob proxy that runs as a single Cloudflare Worker and uses
[Workers Cache](https://developers.cloudflare.com/workers/cache/) as its only
storage. It serves blobs from any PDS at a stable URL, verifies every byte
against the CID before serving, enforces a MIME allowlist by sniffing, and
applies moderation from the ATProto labeler ecosystem by purging the cache.

```
https://your-worker.example/did:plc:<did>/<cid>
```

Cache hits are served by Cloudflare without running the Worker. A miss
resolves the DID, checks policy, fetches the blob from the PDS, hashes it,
sniffs it and stores it. Takedowns arrive as [labels](#labels-and-moderation)
and become cache purges that propagate globally within seconds. Optional
extras: Bluesky-compatible [image presets](#api), a
[scoped mode](#scoped-mode) that turns it into a private CDN for one app,
and an [external policy service](#labels-and-moderation) hook.

## Setup

Requirements: Node 22+, pnpm, a Cloudflare account. The `cf` CLI is in
technical preview at the time of writing.

```sh
git clone https://github.com/ascorbic/cumulus
cd cumulus
pnpm install
pnpm cf auth login
pnpm run deploy
```

The first deploy provisions the KV namespace automatically and fails with
"required secrets have not been set" until the admin password exists. Create
it with:

```sh
pnpm admin:password
```

This generates a random password, sets it as the Worker's secret, and
saves it to `.env` (gitignored) so you can find it later — that file holds
nothing else. Run it again any time to rotate. Then `pnpm run deploy` again.

`pnpm dev` runs it locally (real PLC directory and PDSes, local cache).

## Configuration

Settings are plain values in [`cloudflare.config.ts`](cloudflare.config.ts);
edit them there and deploy. Everything except `ADMIN_PASSWORD` is
checked in, so a clone reproduces the deployment.

| Variable                 | Default                                                | Meaning                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`         | secret                                                 | Basic-auth password for `/admin/*`; set with `pnpm admin:password`.                                                                                                     |
| `BLOB_MAX_SIZE`          | `3mb`                                                  | Largest blob served. 3 MB keeps a miss under the Free plan's 10 ms CPU cap; set `25mb` on Workers Paid.                                                                 |
| `BLOB_ALLOWED_MIMETYPES` | `image/jpeg,image/png,image/webp,image/avif,image/gif` | Sniffed types that may be served. SVG is excluded on purpose: it is a script container, and serving it from a shared origin is an XSS risk even with a restrictive CSP. |
| `BLOB_FETCH_TIMEOUT`     | `30s`                                                  | PDS and directory request timeout.                                                                                                                                      |
| `PLC_URL`                | `https://plc.directory`                                | DID PLC directory.                                                                                                                                                      |
| `BROWSER_MAX_AGE`        | `3600`                                                 | `Cache-Control: max-age` sent to clients.                                                                                                                               |
| `EDGE_MAX_AGE`           | `31536000`                                             | How long Cloudflare keeps an entry. Purge, not expiry, is the takedown mechanism.                                                                                       |
| `LABELERS`               | Bluesky moderation service, `!takedown`                | JSON array of labelers to enforce: `[{"did":"did:plc:…","vals":["!takedown"]}]`. `[]` enforces nothing.                                                                 |
| `LABELER_FAIL_OPEN`      | `true`                                                 | Serve when a labeler is unreachable (the verdict is not cached).                                                                                                        |
| `POLICY_URL`             | none                                                   | External policy service: `GET {POLICY_URL}/{did}/{cid}` → 200 allow, 403 deny.                                                                                          |
| `POLICY_FAIL_OPEN`       | `false`                                                | Serve when the policy service is down.                                                                                                                                  |
| `IMAGES`                 | on                                                     | The Images binding, which enables `/img/` presets. Delete the line to disable them.                                                                                     |
| `MODE`                   | `open`                                                 | `scoped` restricts the proxy to blobs referenced by records in allowlisted collections.                                                                                 |
| `SCOPED_COLLECTIONS`     | none                                                   | Scoped mode: NSIDs or prefixes, e.g. `app.example.post,app.example.*`.                                                                                                  |
| `JETSTREAM_URL`          | none                                                   | Scoped mode: Jetstream endpoint, e.g. `wss://jetstream2.us-east.bsky.network`.                                                                                          |

Changing `MODE` on a running deployment must be followed by
`POST /admin/purge/all`: entries cached under the old mode are served
without running the Worker.

## Front page

`GET /` serves [`site/index.html`](site/index.html) — a plain page saying
what the service is, with an abuse contact pointing at Bluesky support.
Edit it to add your own operator contact, terms or branding; it is bundled
into the Worker at build time and cached for a minute, so an edit is live
within a minute of deploying. Keep it in `site/`: an `index.html` at the repository
root is picked up as a static asset and served with different headers.

## API

Open mode:

```
GET  /{did}/{cid}                          the blob
HEAD /{did}/{cid}                          headers only, same cache entry
GET  /metadata/{did}/{cid}                 { mime, ext, size, width, height, animated }
GET  /img/{preset}/plain/{did}/{cid}       resized variant (IMAGES binding)
GET  /img/{preset}/plain/{did}/{cid}@jpeg  …with an output format: webp (default), jpeg, png
GET  /healthz                              200, never cached
```

Scoped mode replaces the blob and preset routes with record-scoped ones;
the open routes 404:

```
GET  /r/{did}/{collection}/{rkey}/{cid}
GET  /img/{preset}/r/{did}/{collection}/{rkey}/{cid}[@format]
```

`did` is `did:plc:…` or `did:web:…`; `cid` is a base32 CIDv1 (`bafkrei…`,
raw codec, SHA-256). Any alias — uppercase CID, trailing slash,
percent-encoded colons — redirects (301) to the one canonical URL so the
cache holds exactly one entry per blob. Presets are Bluesky's:
`avatar` (1000×1000 cover), `banner` (3000×1000 cover), `feed_thumbnail`
(2000×2000 inside), `feed_fullsize` (1000×1000 inside).

Admin routes take HTTP Basic auth with any username and `ADMIN_PASSWORD`.
They 404 when no password is configured.

```
POST /admin/purge/actor/{did}                     forget everything about an account
POST /admin/purge/blob/{cid}                      one blob, under every DID, every variant
POST /admin/purge/record/{did}/{collection}/{rkey}   scoped-mode record
POST /admin/purge/version/{versionId}             everything served by one Worker version
POST /admin/purge/config/{hash}                   413/415 verdicts from one config (see /admin/config)
POST /admin/purge/all
GET  /admin/config                                effective settings and their hash
GET  /admin/labels/status                         per-labeler cursor and last drain
POST /admin/labels/drain                          run the label/Jetstream drain now
```

Purge responses report the result from each cache scope:
`{ "success": true, "results": { "default": …, "Policy": …, "Identity": …, "Record": … } }`.

## Response behaviour

Every response carries explicit `Cache-Control`. A served blob has:

```
Content-Type: image/jpeg                    from the bytes, never from the PDS
Cache-Control: public, max-age=3600          BROWSER_MAX_AGE
Accept-Ranges: bytes                         Range requests are served from cache as 206
Content-Disposition: inline; filename="{cid}.jpg"
Content-Security-Policy: default-src 'none'; sandbox
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: cross-origin
```

Errors and how long they cache:

| Status | When                                                           | Cached for              |
| ------ | -------------------------------------------------------------- | ----------------------- |
| 301    | non-canonical URL                                              | 1 day                   |
| 400    | malformed DID/CID/preset                                       | 1 day                   |
| 403    | policy deny, or (scoped) blob not referenced by the record     | 1 day, cleared by purge |
| 404    | unknown DID, missing blob or record                            | 5 minutes               |
| 413    | over `BLOB_MAX_SIZE`                                           | 1 day                   |
| 415    | sniffed type not allowlisted                                   | 1 day                   |
| 502    | PDS/directory/labeler failure, CID mismatch, transform failure | never                   |

Verification is strict: the whole blob is buffered and hashed before the
first byte reaches a client or the cache, so a corrupt or substituted blob
is a 502, never a partial image.

## Labels and moderation

The proxy subscribes to the labelers in `LABELERS`. By default that is
Bluesky's moderation service (`did:plc:ar7c4by46qjdydhdevvrndac`) for
`!takedown` labels — the signal Bluesky's trust-and-safety team emits when
it removes an account or post, including for accounts on third-party PDSes
where the label is the only record of the decision. Enforcing it means the
proxy follows network-wide takedowns without any operator action. Two
things happen:

- **On a cache miss**, the policy check asks each labeler (`queryLabels`)
  whether the account carries an enforced label. A deny is a 403 cached for
  a day; an allow is cached for an hour. Nothing is stored locally: the
  labeler is the source of truth.
- **Every five minutes** a cron drain reads each labeler's event stream
  from where it left off and turns enforced labels into cache purges — so a
  takedown takes effect within one poll interval regardless of any TTL.
  Negations are the same purge: the next miss re-checks and re-allows.
  Record-level labels are resolved to the record's blobs and kept in a
  small KV deny set, the only state the proxy holds besides stream cursors.

Community labelers that emit content warnings rather than takedowns are
not enforced unless you list their values; a blob proxy is the wrong place
to apply viewer preferences.

`POLICY_URL` adds your own service to the same check, consulted before
labelers. Label signatures are not verified; transport security is relied
on.

## Scoped mode

`MODE=scoped` makes the proxy a private CDN for one app: a blob is served
only at a URL naming the record that references it
(`/r/{did}/{collection}/{rkey}/{cid}`), and only if the collection is in
`SCOPED_COLLECTIONS` and the record really references that CID (checked
live against the PDS, so a just-published record works immediately). A
Jetstream drain on the same cron purges a record's URLs when it is deleted
or updated. Presets work the same way under `/img/{preset}/r/…`.

## Costs

Workers Cache has no separate price: hits and misses both bill as Workers
requests, and CPU is billed only on misses. Measured on the miss path,
SHA-256 costs about 1.2 ms of CPU per megabyte plus ~3 ms fixed.

- **Free plan** (100k requests/day, 10 ms CPU): fine for a personal proxy
  with the default 3 MB cap.
- **Workers Paid** ($5/month, 10M requests, 30 s CPU): raise
  `BLOB_MAX_SIZE` to `25mb`.
- **Image presets** are billed by Cloudflare Images per unique
  transformation (5,000/month free, then $0.50 per 1,000); the cache means
  each variant is transformed once per cache lifetime.
- KV usage is negligible (cursors and a small deny set).

Purges share the zone purge API's rate limit, and each cache scope counts
separately — one admin purge is four calls. Moderation volume is far inside
the limit; hammering the admin API in a loop is not.

## Development

```sh
pnpm test            # unit and Worker tests, run inside workerd
pnpm test:deployed   # HTTP suite against the deployed Worker (reads ADMIN_PASSWORD from .env)
pnpm check           # format, lint, types
pnpm build
```

## Caveats

- Purge clears Cloudflare, not browsers that already fetched a blob; the
  short `BROWSER_MAX_AGE` bounds that window.
- Identity (DID → PDS) is cached for an hour with a day of
  stale-while-revalidate; a PDS migration can take up to an hour to follow.
- The three per-scope purges in a fan-out are not atomic; every verdict has
  a finite TTL, so a partial purge heals itself.
- Blobs over the isolate's memory budget cannot be verified-then-served;
  there is no streaming mode.
