# cf CLI feedback

Everything here was hit while building and operating
[Cumulus](https://github.com/ascorbic/cumulus): cf 0.6.0 → 0.8.0, Node 24,
macOS, OAuth login (`cf auth login`). Repro commands are as run.

## Bugs

1. **`cf registrar domain-search` is unusable.** Its required query
   parameter is bound to `-q`, which the CLI already uses globally for
   `--quiet`. The help text shows the two merged:
   `-q, --quiet  The search term to find domain suggestions…`. There is no
   way to pass the search term; every invocation fails with
   "Unknown argument: query" or falls into help.

   ```sh
   cf registrar domain-search --query cumulus   # Unknown argument: query
   cf registrar domain-search -q cumulus        # prints help
   ```

2. **`cf registrar domain-check --domains a.com,b.com` rejects valid
   input** — `[1008] None of the provided domains are valid or have
   supported extensions`. The same domains succeed via
   `--body '{"domains":[…]}'`, so the array flag isn't being
   split/serialised correctly.

3. **Invalid flag combinations print the full help dump instead of an
   error.** `cf rulesets create --zone-id X --body '{…}'` prints ~40 lines
   of help with no indication of what was wrong. (The actual problems: it
   wants `-z`, not `--zone-id`, plus required-flag issues.) An
   "unknown argument: zone-id" line would have saved half an hour.

4. **Unknown subcommands fall through to the root command list.**
   `cf registrar domains list` (doesn't exist) prints the entire top-level
   command listing rather than "unknown command 'domains'".

5. **`cf workers subdomains get` exits 1 on success** — prints the correct
   `{"subdomain": …}` JSON and then a non-zero exit code, which breaks
   scripting (`cmd && next` stops).

6. **`--body` doesn't "bypass individual flags" as documented.** For
   `rulesets create`, `--body` alone still failed until
   `--name/--kind/--phase` were also supplied — and then still printed help
   when given `--zone-id` (worked with `-z`).

## Inconsistencies

7. **Zone selection differs per command.** `cf rulesets …` takes
   `-z/--zone`; `cf workers domains update` ignores that and demands
   **both** `--zone-id` and `--zone-name` — redundantly (either identifies
   the zone), and the validation errors surface one missing flag at a
   time, so you fail twice before succeeding.

8. **Error messages reference wrangler.** The unset-secret deploy error
   says "Use `wrangler secret put`… or `wrangler deploy --secrets-file`",
   but the fix in this CLI is `cf workers secrets update` (and cf may not
   have a `--secrets-file`).

9. **`cf workers secrets update` is the create command.** Its own help says
   "Add a secret to a script" but the verb is `update`; there is no
   `create`.

## OAuth / scopes

10. **The CLI ships commands its own login can never authorise.** The OAuth
    scope allowlist (ends at `zone:read`) has no zone WAF/rulesets scope,
    so every `cf rulesets` mutation on a zone 403s with
    `[10000] Authentication error` under `cf auth login`, with no hint that
    the OAuth app simply can't grant this and an API token is needed.

11. **`cf auth login --scopes` rejects unknown scopes** with "One or more
    of the requested scopes are not valid cf OAuth scopes" without listing
    the valid set, and there is no scope-discovery command.

## Nits

12. **Help text is raw API-doc markdown.** `cf registrar domain-check
    --help` prints a wall of prose including `### Workflow` sections and
    agent-oriented instructions ("present pricing to the user") — the
    OpenAPI description pasted verbatim into yargs help.

13. `cf auth whoami` dumps full account objects (enterprise flags, quotas,
    managed-by orgs) where one line per account plus the scope list would
    do.

14. The unset-secret failure happens **after** the full build completes;
    validating declared secrets before building would fail faster.

## Adjacent (config format / vite plugin)

- No way to express a custom domain in `cloudflare.config.ts` —
  `triggers.fetch` covers zone routes only, so a domain attached with
  `cf workers domains update` isn't reconciled by deploy.
- A repo-root `index.html` is silently promoted to a static asset that
  shadows the Worker's `/` route with different headers
  (`max-age=0, must-revalidate`, no charset) — surprising when the file is
  meant as a build input rather than an asset.
