# Cumulus — an ATProto blob proxy on Cloudflare Workers Cache

**Spec and implementation plan** · Draft 1 · August 2026

A porxie-class ATProto blob proxy (CID-verified, MIME-filtered, policy-enforced, securely served) built as a single Cloudflare Worker with the new **Workers Cache** (`cache.enabled`, GA July 2026) as its only caching layer. Not the old `caches.default` / CacheStorage API, which is colo-local, doesn't collapse requests and doesn't tier.

Doc references: [Workers Cache overview](https://developers.cloudflare.com/workers/cache/) · [Configuration](https://developers.cloudflare.com/workers/cache/configuration/) · [Cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/) · [Purge](https://developers.cloudflare.com/workers/cache/purge/) · [Limitations](https://developers.cloudflare.com/workers/cache/limitations/)

---

## 1. Goals

- Serve ATProto blobs at `GET /{did}/{cid}` with correctness guarantees: bytes verified against the CID, MIME allowlist enforced, secure headers always present.
- **The edge cache is the purgeable layer.** Takedowns propagate globally via Instant Purge — unlike porxie-behind-a-CDN, where purging the app cache leaves stale copies at the edge.
- Zero-CPU hot path: cache hits never execute the Worker.
- Run for ~£0 at personal scale, $5/mo Workers Paid at moderate scale. No storage: the origin of truth is the PDS; the cache is the only copy we hold.
- Plain admin purge API for the operator, plus **labeller subscriptions** (§7a) so takedowns flow from the ATProto moderation ecosystem rather than a bespoke API. No compat surface with other proxies: real consumers are your own clients and imgproxy, which only need a URL template.

## 2. Non-goals

- Arbitrary image transformation. Fixed Bluesky-compatible presets via an Images binding are an optional module (§8a); free-form resize parameters are not — every parameter combination is a distinct cache entry and a distinct billed transformation, i.e. an amplification surface.
- Blob storage or mirroring. If the PDS dies, blobs eventually expire from cache.
- Handle (`@user.bsky.social`) resolution on the blob path. DIDs only, as porxie does.
- Serving video via HLS repackaging. Raw blobs only (though Range support falls out for free — §6).

## 3. Architecture

One Worker, three entrypoints, three independent caches. Workers Cache keys by **entrypoint + path + query** (host is not in the key; the Worker is zoneless), so each entrypoint is a separate cache namespace with its own purge scope.

```
                        ┌────────────────────────────────────────────┐
 eyeball ──GET /did/cid──▶ default entrypoint          [cache: ON]   │
                        │   parse → canonicalise → verify → serve    │
                        │        │                                   │
                        │        │ ctx.exports (loopback fetch,      │
                        │        ▼  goes through callee's cache)     │
                        │  ┌──────────────┐    ┌──────────────┐      │
                        │  │ Identity     │    │ Policy       │      │
                        │  │ [cache: ON]  │    │ [cache: ON]  │      │
                        │  │ DID → PDS URL│    │ allow/deny   │      │
                        │  └──────────────┘    └──────────────┘      │
 admin ──POST purge─────▶  (never cached: POST + Authorization)      │
                        └────────────────────────────────────────────┘
```

- **`default`** — the blob route, XRPC shims and admin purge endpoints. Caching **enabled**: this is the whole point. `GET`/`HEAD` blob responses are cached; `POST` purge endpoints are never cached (only GET/HEAD are cacheable), so no gateway split is needed.
- **`Identity`** (`WorkerEntrypoint`) — `GET /did/{did}` → `{ pds: "https://…" }`. An in-memory identity cache replaced by a cached, request-collapsed, tiered entrypoint. `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` — identity changes are rare and SWR hides refresh latency.
- **`Policy`** (`WorkerEntrypoint`) — `GET /check/{did}/{cid}` → allow/deny computed from configured labelers (live `queryLabels` for the DID, §7a), the record-level deny set in KV, and optionally an external policy service. `max-age=3600` on allow; **deny decisions get `max-age=86400`** (denies should stick — and they're purge-clearable) and failures under fail-closed get `no-store` (never cache an outage as a verdict).

Loopback calls via `ctx.exports.Identity.fetch()` go through the callee's cache, so a hot DID's resolution costs one subrequest ever per TTL per tier — and concurrent misses collapse to one upstream hit. The hostname in loopback URLs is a placeholder and not part of the key; only the path matters.

The required config, shown here in wrangler.jsonc shape for reference against the Workers Cache docs — in the template (§12 phase 1) the same keys are expressed in `cloudflare.config.ts` via the Cloudflare Vite plugin. If the experimental config format doesn't yet surface `cache` / `exports` / `cross_version_cache`, fall back to a wrangler.jsonc for those keys rather than dropping them:

```jsonc
{
  "name": "cumulus",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-17",
  "cache": { "enabled": true, "cross_version_cache": true },
  "exports": {
    "default":  { "type": "worker", "cache": { "enabled": true } },
    "Identity": { "type": "worker", "cache": { "enabled": true } },
    "Policy":   { "type": "worker", "cache": { "enabled": true } }
  }
}
```

**`cross_version_cache: true` is the right call here and would be wrong almost anywhere else.** The default puts the Worker version in the cache key, cold-caching every deploy. Our content is content-addressed — a cached `/{did}/{cid}` response can never be wrong after a deploy — so we keep the warm cache across versions. The escape hatch if a deploy changes response *headers* (CSP tightening, say): tag every response with `v:{versionId}` via the version metadata binding and purge the old version's tag post-deploy. Include the binding from day one; it costs one tag.

## 4. The blob request lifecycle

### Hit path
Nothing. Cloudflare serves from the lower tier (colo near the eyeball) or upper tier. `Cf-Cache-Status: HIT`. The Worker does not run; no CPU is billed. This is porxie's LFU cache, Varnish and the CDN collapsed into one layer with a global purge API.

### Miss path (the Worker runs)

1. **Parse and canonicalise.** Path must be `/{did}/{cid}` with `did` matching `did:plc:[a-z2-7]{24}` or `did:web:` syntax, `cid` a CIDv1 base32 string (lowercase, `b`-prefixed). Anything non-canonical (uppercase CID, trailing slash, percent-noise) → **`301` to the canonical path with explicit `Cache-Control: public, max-age=86400`**. Never serve bytes from a non-canonical URL: path and query are the cache key verbatim, and every alias URL would be a duplicate cache entry with its own tags. Canonicalise-by-redirect keeps exactly one cached entry per blob. Note the redirect *must* carry explicit Cache-Control — see the heuristic-freshness trap in §5.
2. **Resolve identity.** `ctx.exports.Identity.fetch("http://i/did/" + did)`. Identity resolves `did:plc` via the configured PLC directory and `did:web` via `https://{host}/.well-known/did.json`, extracts the `#atproto_pds` service endpoint, validates it is `https:` with a public hostname. 404/malformed DID doc → blob route returns `404` with `Cache-Control: public, max-age=300` (deliberate short negative caching).
3. **Policy check** (if `POLICY_URL` configured). `ctx.exports.Policy.fetch(...)` → cached verdict. Deny → `403`, `max-age=86400`, tagged like a blob (so `purgeActor`/`purgeBlob` clears cached denials too — this matters: an un-banned actor must not stay 403 for a day). Policy service unreachable → fail-closed `502 no-store` by default, fail-open if configured, mirroring porxie's `--policy-fail-open`.
4. **Fetch the blob.** `GET {pds}/xrpc/com.atproto.sync.getBlob?did={did}&cid={cid}` with a fetch timeout (default 30s). Reject upfront if `Content-Length` exceeds `BLOB_MAX_SIZE` (default 3 MB — the Free-plan CPU cap, see §11; set 25 MB on Paid).
5. **Buffer, count, hash.** Pipe through `crypto.DigestStream("SHA-256")` while accumulating into memory, enforcing the size cap on actual bytes (Content-Length lies). Buffering before serving is deliberate: **you cannot un-send bytes**, so verify-then-serve is the only way to guarantee no invalid byte ever reaches a client or the cache. 25 MB sits comfortably in the 128 MB isolate limit. (For a hypothetical 300 MB blob tier this breaks — you'd need stream-and-abort-on-mismatch semantics, a different correctness contract. Out of scope, flagged in §11.)
6. **Verify the CID.** Decode the CID: require multibase `base32`, version 1, codec `raw` (0x55), multihash `sha2-256`. Compare digest bytes constant-time-ish (they're public, so plain compare is fine really). Mismatch → `502` with `no-store` and a log line — this is either PDS corruption or an attack, never cache it.
7. **Sniff MIME.** Magic-bytes detection on the first ~512 bytes (`file-type` npm package or a hand-rolled table for the image formats — the allowlist is small). Check against `ALLOWED_MIMETYPES` (default `image/jpeg, image/png, image/webp, image/avif, image/gif` — porxie's defaults; **`image/svg+xml` stays excluded**, it's a script container). Sniff failure falls back to `application/octet-stream`, served only if that type is allowlisted. Disallowed → `415`, `public, max-age=86400` (the blob's bytes won't change; the verdict is stable — but tag it, so purge can clear it if the allowlist config changes… actually simpler: include a config-generation tag `cfg:{hash}` on policy-ish responses and purge that tag on config change).
8. **Serve.** Full `200` — never `206` (see §6) — with the header set in §5.

### Request collapsing
A cold viral image arriving as 500 simultaneous requests at one colo runs the Worker **once**; the other 499 join the in-flight stream. The upper tier consolidates across colos. Porxie has no equivalent — every concurrent cold request hits the PDS. This alone justifies the architecture for anything Bluesky-adjacent.

## 5. Response headers — the full contract

Every response the Worker returns MUST set explicit `Cache-Control`. **This is a hard rule, not a style preference**: Workers Cache applies RFC 9111 heuristic freshness to header-less responses — a bare `200` is cached for 2 hours, a bare `404` for 3 minutes, a bare `301` for 20 minutes. Every cached second must be chosen, not inherited. (Explicit directives also skip Cache Deception Armor, which is irrelevant to us anyway — it only inspects `text/*` and `application/*`.)

Successful blob response:

| Header | Value | Why |
|---|---|---|
| `Content-Type` | sniffed type | Never trust the PDS's declared type |
| `Cache-Control` | `public, max-age=31536000, immutable` | Content-addressed → immutable. `public` also keeps the entry cacheable when the request carried an `Authorization` header (RFC 9111 §3.5 — Workers Cache honours this). Longer than porxie's 7 days because purge, not TTL, is our takedown mechanism. Browsers cache it too — see §7 caveat. |
| `Cache-Tag` | `did:{did},cid:{cid},v:{versionId}` | Purge handles. Consumed and stripped by Cloudflare before the client sees it. Constraints honoured by construction: printable ASCII, ≤1024 chars each, ≤1000 per response, matching is case-insensitive (DIDs and base32 CIDs are lowercase; lowercase `did:web` host segments at tag time to be safe). |
| `Content-Security-Policy` | `default-src 'none'; sandbox` | Neutralise anything that slips through sniffing |
| `X-Content-Type-Options` | `nosniff` | Browser must trust our sniff, not re-sniff |
| `Content-Disposition` | `inline; filename="{cid}.{ext}"` | CID as filename — no user-controlled bytes in the header |
| `Cross-Origin-Resource-Policy` | `cross-origin` | It's a public CDN asset |

Error taxonomy (all explicit, all deliberate):

| Case | Status | Cache-Control | Tagged? |
|---|---|---|---|
| Bad DID/CID syntax | 400 | `public, max-age=86400` | no |
| Non-canonical URL | 301 | `public, max-age=86400` | no |
| DID not found / no PDS | 404 | `public, max-age=300` | `did:{did}` |
| Blob not found on PDS | 404 | `public, max-age=300` | `did:`,`cid:` |
| Policy deny | 403 | `public, max-age=86400` | `did:`,`cid:` |
| MIME disallowed | 415 | `public, max-age=86400` | `did:`,`cid:`,`cfg:` |
| CID mismatch | 502 | `no-store` | — |
| PDS timeout/5xx | 502 | `no-store` | — |
| Policy svc down (closed) | 502 | `no-store` | — |
| Over size limit | 413 | `public, max-age=86400` | `did:`,`cid:` |

`stale-if-error`: we deliberately **accept the platform default** (serve last-good stale indefinitely on Worker error). For immutable content this is pure upside — a PDS outage or a Worker bug keeps blobs flowing from cache. It cannot resurrect purged content: purge removes the entry, and stale-serving needs an entry.

`Vary`: never set it. One canonical representation per URL, maximum hit rate, and it sidesteps the verbatim-comparison variant fan-out entirely. Images are pre-compressed; there is no `Accept-Encoding` negotiation worth doing.

## 6. Range requests — free lunch

Workers Cache handles ranges itself: Cloudflare strips the `Range` header before invoking the Worker, the Worker returns the full `200`, the cache stores it and slices `206`s (or `416`s) out of the stored entry. Subsequent range requests are `HIT`s that never run the Worker. Two consequences:

1. The Worker must **never** return `206` — a Worker-produced `206` is treated as uncacheable and discarded. We always return full bodies; the platform does the slicing.
2. Video/audio blobs (if ever allowlisted) get seek-scrubbing for free with one Worker execution per blob. Porxie punts this to the CDN in front.

`HEAD` is also free: `GET` and `HEAD` share one cache entry, and a `HEAD` on a cold cache is internally converted to `GET` so the full asset is fetched and stored.

## 7. Invalidation

Blobs are content-addressed, so invalidation is **moderation and takedown**, never freshness. The mapping from porxie's lexicon endpoints:

| Endpoint | Implementation |
|---|---|
| `POST /admin/purge/actor/{did}` | `purge({ tags: ["did:" + did.toLowerCase()] })` on **every** entrypoint (see below) |
| `POST /admin/purge/blob/{cid}` | `purge({ tags: ["cid:" + cid] })` — path prefixes can't express "this CID under any DID"; tags can |
| `POST /admin/purge/all` | `purge({ purgeEverything: true })` on every entrypoint |

All three require the admin password (Basic auth). They're `POST`s so never cached, and the `Authorization` header would bypass anyway.

**The per-entrypoint scoping problem and its solution.** Purges are scoped to the entrypoint that calls `purge()` — a purge from `default` cannot touch `Policy`'s cached verdicts, even for identical tag names. But `purgeActor` semantically means "forget everything about this DID": their blobs (default), their cached policy decisions (Policy) and arguably their identity resolution (Identity). Solution: each `WorkerEntrypoint` exposes an **RPC method** `purgeTags(tags: string[])` that calls `this.ctx.cache.purge({ tags })` from inside itself. RPC methods bypass caching (correct — they're actions), and the purge executes in the callee's scope. The admin handler fans out:

```ts
const result = await ctx.cache.purge({ tags });          // default's blobs + errors
await ctx.exports.Policy.purgeTags(tags);                 // cached verdicts
await ctx.exports.Identity.purgeTags(["did:" + did]);     // resolution, actor purge only
```

Propagation uses Instant Purge with the same global guarantees as zone purges — this is the headline advantage over any self-hosted-proxy-behind-CDN topology, where the app's purge endpoint and the edge cache don't talk to each other.

**Rate limits**: `purge()` shares the zone purge API's per-plan rate limits, and a rate-limited call returns `success: false` with a descriptive error. The admin API surfaces the result object verbatim. Tag purge is available on all plans; only the rate limits vary by plan. Moderation tooling should batch — `tags` accepts arrays, and `tags` + `pathPrefixes` union in a single call.

**The browser caveat**: purge clears Cloudflare; it cannot claw back `max-age=31536000, immutable` from browsers that already fetched. Every blob proxy has this problem (porxie ships `max-age=604800, immutable` and has it for a week). If legal-takedown latency to *end users* matters more than hit rate, drop the browser-facing `Cache-Control` to something short and put the long TTL in `cloudflare-cdn-cache-control` — highest precedence, consumed and stripped by Cloudflare, invisible downstream. That split is the recommended default, honestly: `Cache-Control: public, max-age=3600` + `cloudflare-cdn-cache-control: max-age=31536000, immutable`.

## 7a. Labeller-driven moderation

The admin purge API is for the operator; **labels are how the ATProto ecosystem talks about moderation**. Subscribing to labelers means never running a takedown service: a `!takedown` from a labeler you trust propagates to your edge without anyone knowing your API exists.

**Which labelers.** The Bluesky Moderation Service (`moderation.bsky.app`) is the one that matters: when Bluesky's T&S acts, their labeler emits a takedown label — including for accounts on third-party PDSes, where the label is the *only* artefact of the decision, and Bluesky's stated direction is to express ever more enforcement as `!takedown` labels rather than PDS-level removals. Enforcing `!takedown` from it inherits a full-time T&S team. Their per-region geographic labelers apply `!hide` for local-law compliance — a UK deployment enforcing the UK one is a sensible OSA posture. Community labelers (badges, content preferences, anti-harassment) emit *filtering* signals, not takedown judgements; a blob proxy should not enforce them by default. Config identifies labelers by DID (a label's `src` is a DID) — resolve each one's `#atproto_labeler` service endpoint from its DID document via the Identity entrypoint, and verify the DID out-of-band when configuring.

**The primitive.** A label is `{src, uri, cid?, val, neg?, exp?, cts, sig}`, where `uri` is a DID (account-level) or an `at://` record URI. Labelers expose two views of the same database: `com.atproto.label.subscribeLabels` (websocket stream with a `seq` cursor) and `com.atproto.label.queryLabels` (HTTP point query). The design uses both, for different halves of the problem.

**Hybrid: account-level pulls, record-level pushes.**

- **Pull — the check.** On a Policy cache miss, query each configured labeler's `queryLabels` for the DID live. No verdict store, no firehose ingestion, no historical backfill: **the labeler is the verdict store**, and mirroring a database you can query is silly. The verdict is cached (allow 1h, deny 24h) and tagged `did:`/`cid:`.
- **Push — the cron as pure purge trigger.** A scheduled drain (default every 5 min) opens `subscribeLabels` per labeler from the persisted cursor — starting at *now* on first run; history is irrelevant because the check side queries live — and turns each enforced event into `purgeTags(["did:…"])` on `default` + `Policy`. It writes nothing else. Negations are the same purge: the next pull sees the label gone and re-allows, which also clears cached 403s (why §5 tags deny responses). Stateless beyond the cursor, and even losing the cursor is benign — replayed purges are idempotent noise.
- **Record-level labels invert the lookup** and are the one place state survives. At check time you hold `(did, cid)` and cannot cheaply ask "which records reference this blob and are any labelled?". So record labels stay push-with-state: the drain fetches the record via `com.atproto.repo.getRecord`, walks it for blob refs (`$link` CIDs), writes `(did, cid)` denials to KV and purges their tags. The set stays small — record-level takedowns are a tiny fraction of enforcement network-wide, and your cache holds a sliver of that. KV therefore stores exactly two things: cursors and this deny set.

**Consumer topology — poll, don't pin.** Workers can open outbound websockets, but an *outbound* socket cannot hibernate (the Hibernation API covers server-side sockets only), so a Durable Object holding the subscription stays resident and bills wall-clock around the clock — for a stream emitting dozens of events per interval. The cron drain catches up in seconds and costs approximately nothing. Enforcement latency = poll interval + Instant Purge propagation: minutes, the correct SLA for moderation. Volume reality check: Bluesky's takedowns run to a few thousand per day network-wide, i.e. tens of purge tags per drain — far inside rate limits.

**Failure modes.** The labeler now sits on your miss path (Policy misses do a live network call, cached an hour). `LABELER_FAIL_OPEN` defaults to **true**, unlike the bespoke `POLICY_URL`: verdicts are cached for an hour, `stale-if-error` keeps previously-served blobs flowing regardless, and failing closed would 502 every cold blob on the network for the duration of a labeler blip — a availability decision about Bluesky's infrastructure, not your policy. Batch purge tags per call, back off on `success: false`, and persist the cursor **per purged batch** (every ~100 events), not once per drain — the drain is then crash-safe at batch granularity with at-least-once, idempotent effects. This is the whole durability story: `subscribeLabels` is a replayable log, so the cursor gives the cron poor-man's-workflow semantics for free — no Workflows, no Queues, no orchestration. (That calculus flips only if enforcing high-volume content labels — millions of events — or if record enrichment fans out towards the per-invocation subrequest ceiling; `!takedown`-class volume is tens of events per tick.) Overlapping drains are harmless for the same reason — both replay from the same cursor and purges are idempotent; guard with a cursor-freshness check if the duplicate purge calls ever grate, never with a lock. Hardening: verify label signatures against the labeler's published signing key rather than trusting transport.

The pleasing property of the whole arrangement: **labels drive purges, the cache is the enforcement point, and the labeler is the memory.** Policy TTLs stop being enforcement latency and become mere fallback bounds — a takedown purges its way into effect within one poll interval regardless of any TTL.



```
GET  /{did}/{cid}               blob (canonical, cached)
GET  /img/{preset}/plain/{did}/{cid}@{format}   resized variant (§8a, optional)
GET  /r/{did}/{collection}/{rkey}/{cid}         record-scoped blob (§8b, scoped mode)
GET  /metadata/{did}/{cid}      blob metadata JSON (phase 4)
POST /admin/purge/actor/{did}   auth'd purge (blobs + verdicts + identity)
POST /admin/purge/blob/{cid}    auth'd purge
POST /admin/purge/all           auth'd purge
POST /admin/purge/version/{id}  auth'd purge of one Worker version's responses (§3 escape hatch)
POST /admin/purge/config/{hash} auth'd purge of `cfg:`-tagged verdicts; GET /admin/config shows the hash
POST /admin/purge/record/{did}/{collection}/{rkey}   auth'd `rec:` purge (scoped mode)
POST /admin/labels/drain        auth'd: run the label (and Jetstream) drain now
GET  /admin/labels/status       auth'd: per-labeler cursor + last drain time
GET  /healthz                   200, no-store
```

There are deliberately **no query-string routes**: query parameters are part of the cache key *in order*, so `?did=X&cid=Y` and `?cid=Y&did=X` would be distinct cache entries for the same blob. Path-only routes make the canonical form the only form.

`/metadata/{did}/{cid}` (dimensions, byte size, sniffed type, animation flag) is its own cached URL: it runs the same fetch-verify pipeline plus header parsing, returns JSON with the same tags, `max-age=31536000`. Cheap because image dimensions live in the first KB of every allowlisted format — no full decode.

## 8a. Optional image resizing (Bluesky-compatible)

Enabled by adding an [Images binding](https://developers.cloudflare.com/images/transform-images/bindings/); absent binding → the `/img/` route 404s. The route shape is `cdn.bsky.app`'s exactly, and the presets are pinned to the appview's own definitions (source of truth: `packages/bsky/src/image/uri.ts` in `bluesky-social/atproto` — re-check on upgrade, don't trust third-party size guides):

| preset | fit | dimensions | notes |
|---|---|---|---|
| `avatar` | cover | 1000×1000 | |
| `banner` | cover | 3000×1000 | |
| `feed_thumbnail` | inside | 2000×2000 | larger than fullsize — correct per source |
| `feed_fullsize` | inside | 1000×1000 | |

All presets output **webp by default** with upscaling permitted (`min: true` in bsky's options); the optional `@{format}` suffix overrides output (`jpeg`, `png`, `webp`). Mapping to the Images binding: bsky's `cover` → `fit: "cover"`, `inside` + upscale → `fit: "contain"`; always `metadata: "none"` — the transform pipeline is where EXIF/GPS gets stripped, which matters for avatars. Verify the exact binding API (`env.IMAGES.input(…).transform(…).output(…)`) against current docs at implementation time; it's newer than most training data too.

**Miss flow:** parse preset/did/cid/format → obtain the **verified original through the blob pipeline via loopback**, never by fetching the PDS directly from the transform path — the original is verified once, cached once, and shared by the raw route and every preset → transform via the binding → serve under the full §5 contract with the same `did:`/`cid:` tags.

The tag design pays off a second time here: `purgeActor`/`purgeBlob` atomically kill the original **and every derived variant** in one tag purge. The porxie+imgproxy topology structurally cannot do this — imgproxy's cache doesn't know the CDN exists.

**Open implementation question:** whether `ctx.exports` permits a self-loopback to the `default` entrypoint. If not, hoist verified-blob serving into an `Origin` entrypoint that both the eyeball route and the transform route call via loopback — cost is originals cached twice (default's eyeball entry + Origin's), which the existing purge fan-out already covers.

**Failures:** transform errors → `502 no-store` (non-raster and oversized inputs are already rejected upstream by the allowlist and size cap). Animated GIF in → the binding preserves animation for gif/webp output; behaviour parity with bsky is approximate, not guaranteed.

**Cost:** transformations are metered separately from Workers — 5,000 unique transformations/month free, then $0.50/1,000. The cache means a transform executes once per variant per cache lifetime, so the bill tracks *unique cold variants*, not traffic. Four presets × your originals is the worst case; in practice consumers request one or two presets per image.

**Compat means shape, not bytes:** bsky's pipeline is sharp, this is Cloudflare's — dimensions and semantics match, encoder output won't. Since the appview emits its own CDN hostnames, the consumers here are your own apps regardless; the value of the compat is familiar, documented semantics, not substitutability.

## 8b. App-scoped mode (deployment variant)

`MODE=scoped` turns the proxy into a private CDN for one app's content: it serves only blobs referenced by records in an allowlisted set of collections. The general route is disabled — one deployment is either open or scoped, because an open route alongside a scoped one is just a bypass.

**Admission is a forward lookup, not a backlink check.** The URL carries the referencing record:

```
GET /r/{did}/{collection}/{rkey}/{cid}
GET /img/{preset}/r/{did}/{collection}/{rkey}/{cid}@{format}    (presets nest the record path in scoped mode)
```

The app has the rkey in hand at render time, so the extra segments are free to generate. On miss: check `collection` against `SCOPED_COLLECTIONS` (exact NSIDs or prefix like `app.example.*`), fetch the record via `com.atproto.repo.getRecord` (its own cached entrypoint, `max-age=3600` — mutability is handled by purge, the TTL is a fallback), walk it for blob refs and require the requested `cid` to be among them, then run the standard §4 pipeline. No index, no scan, no third party on the admission path — and because `getRecord` goes straight to the PDS, a just-posted record serves immediately with no eventual-consistency window.

**Record↔blob is many-to-many, and the design leans on that.** A record can reference several blobs (a post carries up to four images; a video embed has the video plus caption-file blobs; an external embed has a thumb; a profile has avatar and banner) — the admission check is therefore membership (`cid ∈ blobRefs(record)`), never equality. And one blob can be referenced by many records in the same repo — the PDS refcounts blobs and garbage-collects them when the last reference goes. Under this URL scheme the many-to-one direction resolves itself: each referencing record is a distinct URL, hence a distinct cache entry with its own admission. Delete record A while record B still references the blob: A's URLs die, B's keep serving. The cost is that a shared blob may be cached once per referencing record — accepted duplication, bounded by how much your app actually reuses blobs.

**Deletion handling: the tag store is the backlink index.** Every scoped response is tagged `rec:{did}/{collection}/{rkey}` in addition to `did:`/`cid:`. A Jetstream drain — same cron + cursor machinery as §7a, `wantedCollections` filtered to the allowlist, so event volume is the app's own write rate — turns each delete or update event into `purgeTags(["rec:…"])`. Updates purge rather than re-verify: the next request re-runs admission against the current record. The pleasing bit: the cache's tag store *is* the reverse index, automatically scoped to exactly the blobs ever served — the only subset backlinks were needed for — with no storage, no consistency maintenance, and nothing that can drift from the repo. The drain composes with the labeller drain: two cursors, one cron.

**The design deliberately rejected:** ingesting the firehose into a KV membership set of allowed `(did, cid)` pairs. Storage grows with app history, new posts hit a commit-to-drain consistency gap (false 403s at the worst moment — right after a user posts), and it's a second source of truth. Public backlink indexes don't apply either: Constellation (microcosm.blue) indexes at-uris, DIDs and web URLs as link targets — blob refs are ipld `$link` CIDs, which it does not index, so "which records reference this blob" is structurally unanswerable there; and even a blob-aware index would put a third party with partial backfill on the admission path that the forward `getRecord` check makes unnecessary.

Scoped-mode extras in config: `MODE=open|scoped`, `SCOPED_COLLECTIONS`, `JETSTREAM_URL`. Everything else — verification, headers, purge fan-out, labeller enforcement, presets — behaves identically.

## 9. Configuration

Env vars/secrets:

```
ADMIN_PASSWORD          (secret) enables /admin/*; absent → endpoints 404
BLOB_MAX_SIZE           default 3mb (Free-plan safe; 25mb on Paid — see §11 #1)
BLOB_ALLOWED_MIMETYPES  default image/jpeg,image/png,image/webp,image/avif,image/gif
BLOB_FETCH_TIMEOUT      default 30s
PLC_URL                 default https://plc.directory
POLICY_URL              optional external policy service; absent → verdict store only.
                        Contract: GET {POLICY_URL}/{did}/{cid} → 200 allow, 403 deny
                        (body = reason), anything else / timeout (5s) = outage
POLICY_FAIL_OPEN        default false (applies to POLICY_URL outages only)
LABELERS                optional JSON: [{ "did": "did:plc:…", "vals": ["!takedown"] }]
LABELER_FAIL_OPEN       default true (labeler outage ≠ deny; see §7a)
LABELS_KV               KV binding: subscription cursors + record-level deny set
IMAGES                  optional Images binding: enables /img/ presets (§8a)
MODE                    open | scoped (default open; see §8b)
SCOPED_COLLECTIONS      scoped mode: NSIDs or prefixes, e.g. app.example.*
JETSTREAM_URL           scoped mode: Jetstream endpoint for the record drain
BROWSER_MAX_AGE         default 3600 (see §7 split-header rationale)
EDGE_MAX_AGE            default 31536000
```

Plus a cron trigger (default `*/5 * * * *`) for the label drain when `LABELERS` is set. Identity/policy cache TTLs are `Cache-Control` strings baked into the entrypoints, not eviction knobs — there is no cache memory to allocate or idle-expiry to tune; that whole class of configuration evaporates on this platform.

## 10. Cost model

Workers Cache has no separate price: every request bills at the standard Workers request rate whether HIT or MISS; **CPU is billed only when the Worker runs**, i.e. only on misses. No egress fees, no storage.

- **Free plan**: 100k req/day, 10 ms CPU per invocation. Fine for a personal proxy serving small images. The 10 ms cap is the risk: SHA-256 over a multi-MB blob on the miss path may exceed it (see §11).
- **Paid ($5/mo)**: 10M requests included then $0.30/M, 30 s CPU. At Bluesky-image scale (~100KB avg, mostly hits), 10M requests is a lot of proxy. Realistic answer to "almost free": **yes on Free for hobby scale with small blobs, $5 flat for anything serious**.
- **Size limits**: at launch all Workers Caching entries are capped at the Free-plan cacheable size limit regardless of plan (temporary restriction, to be lifted). That limit comfortably exceeds 25 MB blobs; irrelevant for images, worth rechecking before allowlisting video.

## 11. Risks and open questions

1. **CPU accounting for `DigestStream`** — unverified whether native SHA-256 counts fully against the 10 ms Free CPU cap. If it does, a 25 MB blob miss (~15–25 ms of hashing at native throughput) fails on Free. Mitigation: Paid plan, or cap `BLOB_MAX_SIZE` at ~5 MB on Free. **Test empirically in phase 2 — do not guess.** **Measured 2026-08-22 (docs/plans/phase-2.md):** native SHA-256 is billed as CPU at ≈1.1–1.3 ms/MB; a 25 MB verify costs 40–45 ms and a 5 MB one 7–12 ms. Default `BLOB_MAX_SIZE` is therefore 3 MB; Paid deployments set 25 MB.
2. **Free-plan size cap "at launch"** — temporary per the docs; recheck if allowlisting >25 MB types.
3. **Large blobs (Cirrus's 300 MB ambition)** — buffer-and-verify dies at the 128 MB isolate memory limit well before that. A large-blob mode would stream-and-abort on hash mismatch (client sees a truncated body — a *detectable* failure, but bytes were served). Separate design decision; not in this spec.
4. **Purge fan-out atomicity** — the three per-entrypoint purges aren't transactional. A crash between them leaves e.g. blobs purged but policy verdicts cached. All verdicts have finite TTLs, so the window self-heals; document it, don't engineer around it.
5. **Record enrichment races deletion** — a record-level label on an already-deleted record can't be mapped to blob CIDs (`getRecord` 404s). Log it; if the label's `cid` field is present use it directly, otherwise fall back to nothing — the account-level takedown that usually accompanies deletion covers it.
6. **Cache observability** — the computed cache key can't be inspected at launch; debugging is `Cf-Cache-Status` + the Workers observability dashboard. Build the test suite around asserting `Cf-Cache-Status` transitions (MISS→HIT, purge→MISS).

## 12. Implementation plan

**Phase 1 — skeleton and hot path (a weekend)**
Scaffold from the **`ascorbic/worker-template`** template repo (Vite+, `cf` CLI, Cloudflare Vite plugin, `@cloudflare/vitest-plugin`, pnpm) and follow its AGENTS.md setup steps first. Then the §3 config (single entrypoint first; add `exports` in phase 3), route parsing, canonicalisation redirects, DID resolution inline (no Identity entrypoint yet), blob fetch, DigestStream verify, MIME sniff, full §5 header contract. Deploy, confirm `MISS`→`HIT` and that a `Range` request `HIT`s without invoking the Worker.

**Phase 2 — measure**
Empirically answer risk #1: time CPU for 1/5/25 MB verifications on Free. This decides the Free-plan story and the default size cap. While deployed, do a manual `purge({tags})` round-trip as a smoke test of end-to-end purge propagation.

**Phase 3 — entrypoints and purge**
Split out `Identity` and `Policy` entrypoints with per-entrypoint cache config; wire `ctx.exports` loopbacks. Implement the three purge endpoints + `purgeTags` RPC fan-out. Add the `v:{versionId}` tag via the version metadata binding. Flip on `cross_version_cache`.

**Phase 4 — policy and polish**
`/metadata/{did}/{cid}`, external policy service integration with fail-open/closed, config-generation tag (`cfg:`) purge-on-config-change, structured logs on the miss path (DID, CID, sniffed type, verify result, upstream latency).

**Phase 5 — labeller integration**
Pull side first: Policy queries `queryLabels` for the DID against configured labelers, with `LABELER_FAIL_OPEN` semantics. Then the cron drain as purge trigger (cursor-from-now, KV cursor persistence, batched purge fan-out), then record-level enrichment via `getRecord` + the KV deny set, negation handling, `/admin/labels/status`. Signature verification as the stretch goal.

**Phase 6 — tests and hardening**
`@cloudflare/vitest-plugin` (tests run inside workerd; comes with the template) for unit-level (CID decode, sniffing, canonicalisation); a deployed-environment integration suite asserting `Cf-Cache-Status` sequences, purge propagation timing, 301 behaviour and the error-taxonomy Cache-Control values. Fuzz the path parser — it is the entire attack surface for cache poisoning, and the platform's anti-poisoning key components (method-override and forwarded-header keying) only protect against header games, not path games.

**Phase 7 — image presets (optional module)**
The `/img/` route per §8a: preset table, format overrides, loopback-to-original (resolving the self-loopback question first — it decides whether an `Origin` entrypoint exists), Images binding integration, EXIF stripping, tag parity with originals. Independent of phases 5–6; can land any time after phase 3.

**Phase 8 — scoped mode (optional module)**
`/r/` routes, collection allowlist, `Record` entrypoint with admission check, `rec:` tagging, Jetstream drain sharing the cron + cursor machinery, scoped preset routes. Depends on phases 3 and 5 (reuses purge fan-out and drain plumbing).

**Explicitly deferred**: arbitrary transform parameters, multi-region PDS failover, large-blob streaming mode.
