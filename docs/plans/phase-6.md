# Phase 6 — tests and hardening

Scope (SPEC.md §12, phase 6): unit coverage is already in place from phases
1–5 (CID decode, sniffing, canonicalisation, dimensions, CBOR, labels,
drain). This phase adds the two things still missing: a **deployed
integration suite** asserting `Cf-Cache-Status` sequences, purge
propagation, 301 behaviour and the error-taxonomy `Cache-Control` values;
and a **fuzz test of the path parser**, the whole cache-poisoning surface.

## Deployed integration suite

`test/integration/deployed.test.ts`, run with `pnpm test:deployed` (a
separate vitest project on the Node runner, not workerd — it only does HTTP).
Env: `CUMULUS_URL` (default `https://cumulus.ascorbic.workers.dev`),
`ADMIN_PASSWORD` (from `.env`), a known real blob (`TEST_DID`/`TEST_CID`,
defaulting to the mk.gg avatar).

Sequences:

- purge actor → `MISS` → `HIT` → `HIT` (with `age` advancing);
  HEAD `HIT`; `Range` → `206 HIT` with `Content-Range`; `416` on an
  unsatisfiable range.
- purge blob → `MISS`; purge all → `MISS`; purge version → `MISS`. Each
  purge response `success: true` on every entrypoint.
- Propagation timing: time from purge response to the first `MISS`; the
  suite asserts it is immediate at the test colo and records the number.
- 301 for uppercase CID / trailing slash / percent-encoded colon, with
  `Cache-Control: public, max-age=86400`, and `HIT` on repeat.
- Error taxonomy: 400 (`max-age=86400`), unknown-route 404 (`max-age=300`),
  missing blob 404 (`max-age=300`, `MISS` → `HIT`), `/healthz` `BYPASS`,
  405 `no-store`.
- `/metadata` `MISS` → `HIT`, shape check.
- Header contract on the 200: CSP, nosniff, CORP, Content-Disposition,
  Accept-Ranges, no `Vary`, `cache-tag` absent downstream.

## Path parser fuzz

`test/path.fuzz.test.ts`: a seeded PRNG generates paths from an alphabet of
DID/CID fragments, separators, percent-escapes (valid and broken), unicode,
dots, and case flips. Invariants for every input:

1. `parseBlobPath` never throws.
2. `kind: "blob"` ⇒ `did`/`cid` are canonical (`isValidDid`, `CID_PATTERN`)
   **and** `/${did}/${cid}` equals the input exactly — bytes are never served
   from an alias.
3. `kind: "redirect"` ⇒ the location is itself classified `blob`, and
   differs from the input (no redirect loops, one hop to canonical).
4. Two inputs that decode to the same canonical path get the same
   classification target.

10 000 iterations in CI (fast; the parser is a few regexes).

## Hardening found along the way

Anything the fuzz or the deployed suite turns up is fixed in this phase and
noted below.

## Results (2026-08-22)

- `test/path.fuzz.test.ts`: 10 000 seeded paths, all four invariants hold;
  no parser changes were needed.
- `pnpm test:deployed` (`vitest.deployed.config.ts`, Node runner) against
  version adabe810: 5/5 green — purge → `MISS` observed on the very next
  request, `HIT` after, HEAD `HIT`, `206`/`416` from the entry, 301 aliases
  cached, taxonomy Cache-Control values, `/healthz` `BYPASS`, metadata
  `MISS` → `HIT` with the original still `HIT`.
