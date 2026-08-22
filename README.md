# Cumulus

An ATProto blob proxy on Cloudflare Workers, using Workers Cache as its only caching layer.

Serves `GET /{did}/{cid}` with the bytes verified against the CID, a MIME allowlist enforced by magic-byte sniffing, and a fixed secure header set. Cache hits never run the Worker; takedowns propagate by tag purge.

See [docs/SPEC.md](docs/SPEC.md) for the design and implementation plan, and [AGENTS.md](AGENTS.md) for invariants and working notes.

## Commands

```sh
pnpm dev      # dev server
pnpm test     # run tests inside the Workers runtime
pnpm check    # format, lint, and type check
pnpm fix      # same, but auto-fix
pnpm build    # production build
pnpm run deploy   # build and deploy via cf (pnpm deploy is a builtin pnpm command)
```

## Configuration

- [cloudflare.config.ts](cloudflare.config.ts) — the Worker: name, entrypoint, cache settings, bindings. `Env` types are inferred from the bindings declared here and written to `worker-configuration.d.ts` while the dev server runs.
- [compatibility.ts](compatibility.ts) — compatibility date and flags, shared with the test runtime.
- [vite.config.ts](vite.config.ts) — Vite, Vitest, oxlint, and oxfmt.

Runtime settings are listed in SPEC.md §9.
