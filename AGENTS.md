# AGENTS.md

Free, self-hosted usage telemetry on Cloudflare Workers. Raw events go to Workers Analytics Engine (AE, 90 days). D1 holds the project registry and daily rollups. Read README.md for the product, this file for how to change it.

## Commands

```sh
bun install
bun test                       # unit tests, fake D1 (bun:sqlite) and fake AE
bun run typecheck              # cf workers types && tsc
bun run dev                    # cf dev
bunx cf deploy                 # build and deploy
scripts/smoke.sh <base-url>    # end-to-end checks against a deployment
```

Use the `cf` CLI, not wrangler. Run `cf cli search "<task>"` to find a command. Do not chain nested `--help` calls. The `cf` CLI needs Node 22.18 or newer, and its config does not load under Bun, so Bun is only the package manager and test runner.

## Layout

```
cloudflare.config.ts   Worker, D1 / AE / analytics bindings, daily cron
src/index.ts           Hono app: routes, reserved paths, cron handler
src/types.ts           Shared contracts: events, Project, Dims, DailyRow, Stats, limits
src/util.ts            Slug rules, reserved slugs, sha256, UTC day helpers
src/db.ts              Self-applied schema, salt, isolate project cache
src/ae.ts              AE blob layout, writeDataPoint and SQL wrappers
src/guard.ts           In-memory IP limiter and per-project daily cap
src/ingest.ts          POST /<project>: validate, normalize, hash id, write to AE
src/otlp.ts            OTLP/HTTP JSON to events
src/projects.ts        Create, list, delete, import, manual rollup, admin token
src/rollup.ts          Cron: AE SQL to one daily row per project
src/stats.ts           Stats JSON from D1 rollups plus live today
src/pages/             Server-rendered Hono JSX: layout, landing, project, docs, SVG charts
src/docs/content.ts    All docs text: API reference, install.md playbook, snippets, llms.txt
src/notes.ts           Re-exports agentsMd, installMd, llmsTxt for the router
scripts/import.ts      Raw NDJSON to exact rollups, upload to /api/<project>/import
scripts/import-chmonitor.ts  One-off, read-only export of the old chmonitor D1
scripts/smoke.sh       curl checks against a deployment
skills/add-telemetry/  Claude Code skill that mirrors the install.md playbook
test/                  bun test, one file per module; fakes.ts has the D1 and AE fakes
```

## Invariants

- Ingest never writes D1. The project-exists check uses isolate memory, refreshed from D1 every 5 minutes. A test must fail if an ingest request issues a D1 write.
- Never store the raw id, the IP or the user agent. `uid = sha256(salt | project | id)[:16]`. Without an id the hash is `sha256(salt | day | project | ip | ua)[:16]`.
- The AE blob layout lives in `src/ae.ts` only. Rollup and stats refer to it through `BLOB` and `PROP_BLOBS`.
- D1 allows 100 bound parameters per statement and 50 queries per invocation. Chunk multi-row writes and prefer `db.batch`.
- The schema is applied by the Worker in `src/db.ts`. When you change it, bump `SCHEMA_VERSION` and keep the SQL idempotent.
- Imports never overwrite days rolled up from live AE data.
- API limits are in `src/types.ts` and `src/guard.ts`. When you change one, update `src/docs/content.ts`, README.md and the tests.
- The docs in `src/docs/content.ts` are the contract for clients and agents. Keep field tables, status codes and examples exact. `test/content.test.ts` checks them.

## Style

- TypeScript, tabs, double quotes, `.ts` import extensions.
- Raw SQL, no ORM, no zod, no client-side framework. Add a dependency only with a reason.
- Plain, short English in code, docs and commits. No marketing words, no emoji.
- Tests state why a behavior matters. Prefer a test that fails when the business rule changes.
- Semantic commit messages with a scope, for example `feat(ingest): reject oversized bodies`.
- Never commit admin tokens. They belong in `~/.config/telemetry/`.
