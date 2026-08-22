# Cumulus

This file provides guidance to agentic coding tools when working with code in this repository.

ATProto blob proxy on Cloudflare Workers using **Workers Cache** (the new
`cache.enabled` platform feature, GA July 2026). Single Worker, three
entrypoints, no storage beyond one KV namespace.

**docs/SPEC.md is the source of truth.** Read it before planning any phase.
Where this file and the spec disagree, the spec wins; flag the conflict.

## Before writing any cache-related code

Workers Cache is NEWER THAN YOUR TRAINING DATA. Do not write cache code from
memory. Fetch these first (or use the Cloudflare docs MCP if available):

- https://developers.cloudflare.com/workers/cache/
- https://developers.cloudflare.com/workers/cache/configuration/
- https://developers.cloudflare.com/workers/cache/cache-keys/
- https://developers.cloudflare.com/workers/cache/purge/
- https://developers.cloudflare.com/workers/cache/limitations/

Specifically: this project does NOT use `caches.default` / the CacheStorage
API anywhere. If you find yourself writing `caches.default.put(...)`, stop —
that is the old colo-local API and its presence is a bug.

## Invariants (violating any of these is a bug, not a style choice)

1. **Every response sets explicit `Cache-Control`.** No exceptions — errors,
   redirects, health checks. Heuristic caching silently caches bare responses.
   The full status → Cache-Control taxonomy is in SPEC.md §5.
2. **Never return `206`.** The platform slices ranges from stored 200s; a
   Worker-produced 206 is discarded as uncacheable. Ignore Range headers.
3. **Verify before serving.** Blob bytes are buffered and SHA-256-checked
   against the CID before any byte reaches the client or cache. No streaming
   passthrough of unverified content.
4. **No query-string routes.** Path-only. Param order fragments cache keys.
5. **Tag everything cacheable** — including 403s and 404s — with
   `did:{did}` / `cid:{cid}` (lowercased) per SPEC.md §5. Untagged deny
   responses cannot be purged and will strand takedowns.
6. **Purges fan out per entrypoint** via `purgeTags` RPC methods (SPEC.md §7).
   A purge from `default` does not touch `Policy`'s cache.
7. **Content-Type comes from magic-byte sniffing**, never from the PDS's
   declared type. `image/svg+xml` stays off the allowlist.
8. **No Durable Objects, Workflows, or Queues.** The label drain is a cron +
   cursor (SPEC.md §7a). If a problem seems to need orchestration, re-read
   §7a's durability argument before adding infrastructure.
9. **The `/img/` transform route derives from the verified original via
   loopback** (SPEC.md §8a) — never fetch the PDS directly from the transform
   path, and never accept free-form resize parameters. Presets are the fixed
   Bluesky-compatible four; verify the Images binding API against current docs
   before use (it is also newer than your training data).
10. **Scoped mode admission is a forward `getRecord` membership check**
    (SPEC.md §8b): the requested cid must be among the record's blob refs, and
    the collection must match the allowlist. Never build a reverse index of
    blob references — the `rec:` tags plus the Jetstream drain ARE the
    backlink index. Open and scoped routes never coexist in one deployment.

## Stack

- **Start from the `ascorbic/worker-template` template repo** and follow its
  AGENTS.md setup steps before anything else. It provides the toolchain:
  Vite+ (`vp`) for dev/build/test/lint, the `cf` CLI for deploys,
  `@cloudflare/vite-plugin` with `cloudflare.config.ts`,
  `@cloudflare/vitest-plugin` (tests run inside workerd), TypeScript strict,
  pnpm. Use the template's commands (`pnpm dev/test/check/deploy`); do not
  introduce wrangler-based workflows alongside it.
- Worker config lives in `cloudflare.config.ts`. The `cache`, `exports` and
  `cross_version_cache` keys from SPEC.md §3 are required — if the config
  format doesn't yet surface them, fall back to wrangler.jsonc for those keys
  and say so; never silently drop them.
- No web framework — the router is a handful of routes; hand-roll it.
- Deployed integration tests assert `Cf-Cache-Status` transitions
  (MISS → HIT, purge → MISS).
- Minimal deps. A CID/multiformats decoder and a magic-bytes table are the
  only candidates; justify anything else.

## Working method

- Implement in the phase order of SPEC.md §12. One phase at a time; plan
  first, get approval, then code. Tests green before the next phase.
- Phase 2 is a measurement gate, not a coding task: it produces real numbers
  (DigestStream CPU on Free plan) that set `BLOB_MAX_SIZE` defaults. Build
  the harness, then stop and ask for deploy + results.
- When a platform behaviour is ambiguous (billing of native crypto, purge
  propagation timing), say so and propose an experiment — do not guess and
  bake the guess into defaults.

## Repository Structure

A standalone Cloudflare Worker built with Vite+ and the Cloudflare Vite plugin.

- `src/index.ts` — the Worker entrypoint
- `test/` — Vitest tests, run inside workerd via `@cloudflare/vitest-plugin`
- `cloudflare.config.ts` — Worker configuration (the experimental `cf`-CLI-native format; there is no wrangler.jsonc)
- `compatibility.ts` — compatibility date/flags, shared between the Worker config and the test runtime
- `vite.config.ts` — unified Vite+ config: Vite plugins, Vitest, oxlint, and oxfmt
- `worker-configuration.d.ts` — generated types; committed. Regenerated automatically while `pnpm dev` runs

## Commands

- `pnpm dev` — start the dev server (`vp dev`; `cf dev` also works and delegates to it)
- `pnpm test` — run tests in the Workers runtime
- `pnpm check` — format check, lint, and type check in one pass (`vp check`)
- `pnpm fix` — apply formatting and safe lint fixes
- `pnpm build` — production build
- `pnpm deploy` — build and deploy (`cf deploy`; requires `cf auth login` or `CLOUDFLARE_API_TOKEN`). Production deploys normally happen via Workers Builds on push to main, not from CI or local machines

## Configuration Architecture

- **`cloudflare.config.ts` is the source of truth for the Worker**: name, entrypoint, compatibility, bindings, observability. It uses the experimental new config format (`experimental.newConfig` in the Vite plugin), which both the `cf` CLI and plain `vp`/Vite commands read. `defineWorker` is imported from `@cloudflare/vite-plugin/experimental-config` — do not import it from `@cloudflare/config` directly, or the generated types stop resolving (the two packages carry different unique symbols).
- The entrypoint uses the `with { type: "cf-worker" }` import attribute. This is what makes `Env` and `exports` inference work — keep that form when changing the entrypoint.
- **Bindings**: declare them in `cloudflare.config.ts` (e.g. `env: { MY_KV: bindings.kv() }` with `bindings` from the same import). The `Env` type in `worker-configuration.d.ts` is inferred from them — run `pnpm dev` briefly after config changes to regenerate it, and commit the result.
- **`compatibility.ts`** exists so the Vitest runtime (`cloudflareTest` in vite.config.ts) always matches the deployed runtime. Extra exports are not allowed in `cloudflare.config.ts` (its exports are schema-validated), which is why this is a separate file.
- **Version pins that must move together**: the `vitest` devDependency and the `vitest` override in `pnpm-workspace.yaml` are pinned to the version bundled by vite-plus (check with `pnpm exec vp toolchain`). `vite` is aliased to `@voidzero-dev/vite-plus-core` (as a devDependency and an override) so every package resolves the same Vite — do not add a real `vite` dependency.

## Testing

- Tests run inside workerd. Import test APIs from `cloudflare:workers` (`env`, `exports`) — `exports.default.fetch()` replaces the deprecated `SELF`, and `env` from `cloudflare:test` is also deprecated.
- `test/env.d.ts` wires the `ProvidedEnv` type to the generated `Env`.
- For integration tests against the production build, use `createTestHarness()` from `wrangler` pointed at the built output (`dist/<worker_name>/wrangler.json` after `pnpm build`).

## Development Workflow

- Uses **pnpm**, wrapped by **Vite+** (`vp`). Format and lint are oxfmt/oxlint via `vp check` — there is no prettier or eslint. Type checking runs inside `vp check` (tsgolint with `typeAware`/`typeCheck` enabled).
- Formatting uses tabs (configured in `vite.config.ts` under `fmt`).
- CI (test.yml) runs `vp check`, `vp test`, and `vp build` via the `voidzero-dev/setup-vp` action.
