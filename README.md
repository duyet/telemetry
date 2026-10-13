# telemetry

Free, self-hosted usage telemetry for CLIs, desktop apps, plugins, web apps and servers. One Cloudflare Worker, one command to deploy.

## Why

- **Free.** Runs inside the Cloudflare free plan. No database writes on the hot path.
- **Tiny.** A Hono app, raw SQL, no framework on the client, no SDK to install.
- **Self-hosted.** `bunx cf deploy` puts it on your own account. No secrets and no env vars.
- **Privacy first.** Random install ids are hashed with a secret salt. IP and user agent are never stored. Raw events expire after 90 days.
- **Works for anything.** One `POST` from any language, or OTLP/HTTP JSON from any OpenTelemetry SDK.
- **Public stats.** Every project gets a page at `/<project>` with users, events and breakdowns.

## How it works

```
client ──POST /<project>──▶ Worker ──▶ Analytics Engine   raw events, 90 days
(CLI, app, web, OTLP)         │                │
                              │                ▼  cron, daily 00:10 UTC
                              │          D1: one row per project per day
                              │          (dau, wau, mau, events, top dims)
                              ▼                │
                    pages and JSON API ◀───────┘
                    /<project>  /api/<project>/stats  /docs
```

- Ingest writes to Analytics Engine only. It never touches D1.
- A daily cron turns raw events into one D1 rollup row per active project.
- Pages and stats read D1 rollups, plus a live count for today (cached about 5 minutes).

## Quickstart (60 seconds)

```sh
BASE=https://telemetry.anyr.workers.dev   # or your own deployment

# 1. create a project. Save admin_token: it is shown once.
curl -X POST $BASE/api/projects -H 'content-type: application/json' \
  -d '{"slug":"my-tool","name":"My Tool"}'

# 2. send an event
curl -X POST $BASE/my-tool -H 'content-type: application/json' \
  -d '{"event":"ping","id":"3f2c9a7e-1d4b-4c8e-9a52-7b1e0d6f4a21","version":"1.0.0","os":"linux","arch":"x64"}'
# {"accepted":1,"dropped":0}

# 3. look at it
open $BASE/my-tool
curl $BASE/api/my-tool/stats
```

## Add to your project with an agent

Create a project, then paste this into Claude Code, Codex or any coding agent:

```
Add anonymous usage telemetry to this repo. Follow https://telemetry.anyr.workers.dev/<project>/install.md exactly. Respect DO_NOT_TRACK, add an opt-out env var and a Telemetry section to the README, never send PII, never block the main path.
```

The playbook at `/<project>/install.md` has the exact endpoint, a snippet for your language, the opt-out rules, a test to add and a README template. There is also a Claude Code skill in [`skills/add-telemetry`](skills/add-telemetry/SKILL.md). With no project yet, point the agent at `/AGENTS.md`.

## API summary

Full reference: `/docs` on your deployment (raw markdown at `/llms.txt`).

| Method and path | What it does |
|---|---|
| `POST /<project>` | Send one event, or an array of up to 25. Returns 202 `{accepted, dropped}`. |
| `POST /<project>/v1/{logs,traces,metrics}` | OTLP/HTTP JSON. Set `OTEL_EXPORTER_OTLP_ENDPOINT=<base>/<project>` and `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`. |
| `GET /api/projects`, `POST /api/projects` | List projects, create one. |
| `GET /api/<project>/stats?days=7\|30\|90\|365` | Public aggregate stats. |
| `POST /api/<project>/import` | Backfill daily rollups (admin token). |
| `POST /api/<project>/rollup?day=YYYY-MM-DD` | Rebuild one day from live data (admin token). |
| `DELETE /api/<project>` | Delete a project and its rollups (admin token). |
| `GET /<project>`, `/<project>/install.md`, `/docs`, `/llms.txt`, `/AGENTS.md` | Pages and agent notes. |

## Self-hosting

```sh
git clone https://github.com/duyet/telemetry && cd telemetry && bun install && bunx cf deploy
```

- Enable Analytics Engine once per account: Cloudflare dashboard, Workers & Pages, Analytics Engine.
- `cf deploy` creates the D1 database, the Analytics Engine dataset and the daily cron.
- The Worker creates its own D1 schema and its own hashing salt on first request.
- Needs Node 22.18 or newer for the `cf` CLI.

CI in `.github/workflows/deploy.yml` tests every PR and deploys on push to `main`. Add the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Without them the deploy job skips itself.

To check a deployment: `scripts/smoke.sh <base-url>`.

## Free tier

| Resource | Free plan | How this service uses it |
|---|---|---|
| Workers requests | 100,000 per day, per account | One per event request or page view. |
| Analytics Engine writes | 100,000 data points per day, per account | One per event. |
| Analytics Engine reads | 10,000 queries per day | About 20 for the daily rollup, plus one per project page view every 5 minutes. |
| Analytics Engine retention | 3 months | Raw events. |
| D1 | 100,000 rows written per day, per account | Rollups only: about 1 row per active project per day. |

Measured on the live deployment (2026-10-13):

- 100 events from 50 installs: D1 row count and file size did not change. Ingest writes only to Analytics Engine.
- A daily rollup runs 18 Analytics Engine queries in total, whatever the number of projects. It writes one D1 row per project active in the last 30 days.
- The project page with 365 days of data is about 11 KB over the wire (brotli), 44 KB uncompressed.
- The live "today" count matched raw Analytics Engine exactly: 3 users, 9 events.

## Privacy

- The client sends a random id. The server hashes it with a secret salt and the project name, keeps 16 hex chars, and never stores the raw id.
- IP address and user agent are never stored. The country comes from Cloudflare.
- Without an id, a hash that rotates daily counts daily users only.
- Hashed ids live only in Analytics Engine and are deleted after 90 days. D1 holds aggregates only.
- Well-behaved clients honor `DO_NOT_TRACK=1` and `<APP>_TELEMETRY_DISABLED=1`, skip CI, and print what they send with `<APP>_TELEMETRY_DEBUG=1`. See the client guidelines in `/docs`.

## Limits

| Limit | Value |
|---|---|
| Body size | 16 KB |
| Events per request | 25 (native), 250 points (OTLP) |
| Props per event | 8, values cut to 64 chars |
| Rate limit | 60 requests per minute per IP, 20,000 points per day per project (best effort, per Worker instance) |
| Project creates | 5 per day per IP |
| Import | 360 rows per request |
| Raw retention | 90 days |

## Development

```sh
bun install
bun test              # unit tests
bun run typecheck     # cf workers types && tsc
bun run dev           # cf dev
```

Scripts:

- `bun scripts/import.ts events.ndjson --base <url> --project <slug> --dry-run`: turn raw NDJSON events into exact daily rollups and upload them. The token comes from `TELEMETRY_ADMIN_TOKEN`.
- `scripts/smoke.sh <base-url>`: end-to-end checks against a deployment.

See [AGENTS.md](AGENTS.md) for the code layout and invariants.

## License

[MIT](LICENSE)
