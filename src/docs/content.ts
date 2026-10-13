/** All human and agent docs content. One source, rendered as HTML (/docs, project page) and served raw (llms.txt, install.md). Owner: agent D. */

export interface Snippet {
	id: string; // "curl" | "ts" | "rust" | "go" | "python" | "browser" | "otlp" | "shell"
	label: string;
	lang: string;
	code: string;
}

/** Markdown below writes code fences as ~~~ so the template literals need no backtick escapes. */
const md = (s: string): string => s.replaceAll("~~~", "```");

/** `herdr-desk` → `HERDR_DESK`, the prefix of the opt-out env vars. */
function envPrefix(project: string): string {
	return project.toUpperCase().replaceAll("-", "_");
}

const EXAMPLE_PROJECT = "my-tool";

/** API reference markdown (rendered at /docs, appended to /llms.txt). */
export function apiMd(base: string): string {
	return md(`# Telemetry API

Anonymous usage telemetry for CLIs, desktop apps, plugins, web apps and servers. Free, self-hostable, runs on Cloudflare Workers. Raw events live 90 days in Workers Analytics Engine. Only daily aggregates are kept long term.

Base URL: \`${base}\`

## Quickstart

1. Pick a slug and send the first event with curl. A new slug is created by its first valid event. There is no signup step.

~~~sh
curl -X POST ${base}/${EXAMPLE_PROJECT} \\
  -H 'content-type: application/json' \\
  -d '{"event":"ping","id":"3f2c9a7e-1d4b-4c8e-9a52-7b1e0d6f4a21","version":"1.0.0","os":"linux","arch":"x64"}'
# {"accepted":1,"dropped":0,"project":{"slug":"${EXAMPLE_PROJECT}","created":true,"admin_token":"tk_...","page_url":"${base}/${EXAMPLE_PROJECT}"}}
~~~

2. Save \`admin_token\` from that response. It is shown once. You need it to rename the project, rotate the token, import or delete.

3. Send more events the same way. Later responses are \`{"accepted":1,"dropped":0}\`, with no token.

4. See it. Open \`${base}/${EXAMPLE_PROJECT}\`, or read the JSON:

~~~sh
curl ${base}/api/${EXAMPLE_PROJECT}/stats
~~~

Today's numbers come from a live query cached for about 5 minutes. Earlier days come from the daily rollup.

## Sending events

\`POST ${base}/<project>\`

The body is one event object, or an array of at most 25 events. Content type \`application/json\`. Max body size is 16 KB.

| Field | Type | Required | Rules |
|---|---|---|---|
| \`event\` | string | yes | Matches \`^[A-Za-z0-9_.:/-]{1,64}$\`. |
| \`id\` | string | no | A random install id that the client creates and keeps, at most 128 chars. The server hashes it with a secret salt and never stores it raw. |
| \`version\` | string | no | The app version. Letters, digits, \`.\`, \`+\`, \`-\`, \`_\`, at most 32 chars. |
| \`os\` | string | no | Free-form lowercase, at most 16 chars of \`[a-z0-9_-]\`. For example \`linux\`, \`darwin\`, \`windows\`. Send what the runtime reports. |
| \`arch\` | string | no | Same rules as \`os\`. \`x64\`, \`x86_64\`, \`arm64\` and \`aarch64\` are all fine. Do not remap them. |
| \`ci\` | boolean | no | True when the event came from a CI run. |
| \`props\` | object | no | At most 8 entries. Keys match \`[a-z0-9_.-]{1,32}\`. Values are string, number or boolean, and are cut to 64 chars. |
| \`n\` | integer | no | Occurrence count, 1 to 1000. Default 1. |

Rules the server applies:

- The country comes from Cloudflare. The client cannot set it.
- The IP address and user agent are never stored.
- Any event with an \`id\` counts that id as an active user for that UTC day. \`install\` and \`ping\` are not special. Days are UTC.
- Without \`id\`, the server uses a hash that rotates every day. That counts daily users (DAU) only. Weekly and monthly users need a stable \`id\`.
- A bad optional field (for example an \`os\` with spaces) is ignored, and the event is still counted. Only a missing or invalid \`event\` drops the event.
- Invalid events in a batch are dropped. The valid ones are kept.
- Identical events in one request are merged into one data point with a summed \`n\`. \`accepted\` counts data points after merging, \`dropped\` counts invalid events.

Responses:

| Status | Meaning |
|---|---|
| 202 | Accepted. Body is \`{"accepted": <number>, "dropped": <number>}\`. When this request created the project, the body also has \`project\` and the token is in the \`x-telemetry-admin-token\` header. See Projects below. |
| 400 | Body is not valid JSON, is not an object or array, has more than 25 events, or has no valid events. |
| 404 | Invalid or reserved slug. |
| 413 | Body is larger than 16 KB. |
| 429 | Per-IP rate limit (with a \`Retry-After\` header in seconds), the project's daily cap, or the new project limit. Do not retry in a loop. |

CORS is open (\`access-control-allow-origin: *\`), so browsers can send events directly.

Batch example:

~~~sh
curl -X POST ${base}/${EXAMPLE_PROJECT} \\
  -H 'content-type: application/json' \\
  -d '[{"event":"run","id":"3f2c9a7e","props":{"command":"build"}},{"event":"run","id":"3f2c9a7e","props":{"command":"test"},"n":3}]'
~~~

## OTLP

Any OpenTelemetry SDK or collector can send to the same project. Only OTLP/HTTP with JSON is supported.

~~~sh
export OTEL_EXPORTER_OTLP_ENDPOINT=${base}/${EXAMPLE_PROJECT}
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
~~~

SDKs append \`/v1/logs\`, \`/v1/traces\` and \`/v1/metrics\` to the endpoint. You can also call them directly:

\`POST ${base}/<project>/v1/{logs,traces,metrics}\`

- Protobuf bodies (any content type other than \`application/json\`) get 415. Set \`OTEL_EXPORTER_OTLP_PROTOCOL=http/json\`.
- gzip bodies (\`content-encoding: gzip\`) are accepted. Other encodings get 415. A body over 256 KB, or over 1 MB after unzip, gets 413.
- At most 250 points per request. The success response is \`{}\`, or \`{"partialSuccess": {...}}\` when records were rejected (invalid event name, empty metric, or over the 250 limit).
- The first export with at least one valid record creates a new project. The admin token is only in the \`x-telemetry-admin-token\` response header, and exporters drop it. Create the project with one curl first (see Quickstart), then point the exporter at it. An export with no valid records to an unknown slug gets 400 and creates nothing.

How OTLP data maps to an event:

| Event field | Source |
|---|---|
| \`event\` | Logs: the \`event.name\` attribute, else the log body when it is a valid event name, else \`log\`. Traces: the span name. Metrics: the metric name. Names must match the native \`event\` rule. |
| \`n\` | Metrics only: the sum of a delta sum, the count of a histogram, or the number of data points for a gauge or cumulative sum. Logs and spans count 1. |
| \`id\` | Attribute \`service.instance.id\`, else \`host.id\`, else \`user.id\`. |
| \`version\` | \`service.version\` |
| \`os\` | \`os.type\` |
| \`arch\` | \`host.arch\` |
| \`props\` | Other record attributes, with the same limits as native props. Attributes that can identify a person or host are dropped (\`user.*\`, \`host.*\`, \`client.*\`, \`url.*\`, \`exception.*\`, and keys containing \`email\`, \`token\`, \`path\`, \`session\`, and similar). |

Set the install id as a resource attribute:

~~~sh
export OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<random-install-id>,service.version=1.0.0
~~~

## Client guidelines

Follow these in every client. They are what makes telemetry safe to ship.

- A variable counts as set when it has any value except empty, \`0\` or \`false\`. This applies to \`DO_NOT_TRACK\`, \`CI\` and the \`<APP>_TELEMETRY_*\` flags.
- Honor \`DO_NOT_TRACK\` and \`<APP>_TELEMETRY_DISABLED\`. Send nothing when either is set. If a config file holds an opt-out and it cannot be read, send nothing.
- Skip sending in CI unless the user opts in with \`<APP>_TELEMETRY_CI=1\`. When opted in, send \`ci: true\`.
- \`<APP>_TELEMETRY_DEBUG=1\` prints the payload and does not send it. It has no side effects: no id file, no daily stamp, no notice.
- Create a random id once and keep it at \`~/.config/<app>/telemetry-id\`, or the platform equivalent. Never derive it from the machine, user, hostname or path. Prefer the tool's own env prefix and config directory when it has one.
- Fail closed. If the id or the daily stamp cannot be saved, send nothing. Otherwise a daemon would send on every tick.
- Send fire-and-forget with a timeout of 1 second or less. Never block the app, never crash it, never retry in a loop.
- Send \`install\` once on first run. Then send at most one \`ping\` per UTC day, plus meaningful events such as a command run. Use the UTC date for the daily gate.
- Show a one-line notice on first run, in the app's user-visible channel: stderr for a CLI, the log or notify channel for a daemon or plugin, the UI for a desktop app. It says what is sent and how to turn it off.
- Send no personal data. No file paths, hostnames, emails, usernames, arguments values or error messages.

Ready-made snippets for curl, shell, TypeScript, Rust, Go, Python and the browser are on each project page, and in \`${base}/<project>/install.md\`.

## Projects

A project is created by its first valid event, native or OTLP. There is no signup step.

- The slug matches \`^[a-z0-9][a-z0-9-]{1,38}$\` and is not a reserved word (\`api\`, \`docs\`, \`fonts\`, \`health\`, \`llms.txt\`, and similar). Other slugs get 404.
- A request with no valid events never creates a project.
- At most 3 new projects per IP and 100 in total per UTC day. Over either cap, the request gets 429 \`{"error": "new project limit reached for today"}\` and nothing is stored. Existing projects are not affected.
- The response that creates the project carries the admin token, once: in the native body as \`project.admin_token\`, and in the \`x-telemetry-admin-token\` header for native and OTLP. Only its hash is stored. It cannot be shown again.
- Save the token from your first curl. If the first event comes from a client that ignores responses, such as a shipped app or an OTLP exporter, the token is lost.
- When two requests create the same slug at the same moment, one gets the token and the other is accepted without it.

List the public projects:

~~~sh
curl ${base}/api/projects
~~~

The response is \`{"projects": [...]}\`. It lists only projects with daily rollups in the last 30 days. Each entry has \`slug\`, \`name\`, \`description\`, \`homepage\`, \`created_at\`, \`series\` (daily users for the last 30 closed UTC days, oldest first) and \`dau\` (yesterday's daily users). A new project shows up after its first nightly rollup at 00:10 UTC. Its page at \`${base}/<project>\` works right away.

### Manage a project

Every change needs the project's admin token in \`Authorization: Bearer <admin_token>\`. A missing or wrong token gets \`401\`. An unknown project gets \`404\`.

Set the display name, description and homepage: \`PATCH ${base}/api/<project>\`

~~~sh
curl -X PATCH ${base}/api/${EXAMPLE_PROJECT} \\
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \\
  -d '{"name":"My Tool","description":"A CLI that does one thing","homepage":"https://example.com"}'
# {"project":{"slug":"${EXAMPLE_PROJECT}","name":"My Tool","description":"A CLI that does one thing","homepage":"https://example.com","created_at":"..."}}
~~~

| Field | Rules |
|---|---|
| \`name\` | At most 60 chars. |
| \`description\` | At most 200 chars. |
| \`homepage\` | An http(s) URL, at most 200 chars. |

A field you leave out stays as it is. \`null\` or \`""\` clears it. A bad field gets \`400\` and changes nothing.

The slug cannot change. Raw events in Analytics Engine are stored under it. Only the display name can change. To move to a new slug, send events to the new slug.

Rotate the admin token, for example after a leak. The old token stops working at once:

~~~sh
curl -X POST ${base}/api/${EXAMPLE_PROJECT}/token -H "Authorization: Bearer $ADMIN_TOKEN"
# {"admin_token":"tk_..."}
~~~

Delete a project and its rollups:

~~~sh
curl -X DELETE ${base}/api/${EXAMPLE_PROJECT} -H "Authorization: Bearer $ADMIN_TOKEN"
~~~

Raw events in Analytics Engine cannot be deleted. They expire after 90 days.

Lost token: there is no self-service reset, because the token is the only proof of ownership. The operator of the deployment can set a new one: \`bun scripts/reset-token.ts <project>\` prints a new token and the D1 command that stores its hash.

## Stats API

\`GET ${base}/api/<project>/stats?days=7|30|90|365\`

Public, no auth. Any other \`days\` value falls back to 30. Response:

~~~json
{
  "project": "${EXAMPLE_PROJECT}",
  "days": 30,
  "generated_at": "2026-10-13T12:00:00.000Z",
  "summary": {
    "dau": 42, "wau": 180, "mau": 510, "events": 9120,
    "today": { "users": 17, "events": 301 }
  },
  "series": [{ "day": "2026-10-12", "dau": 42, "events": 310 }],
  "dims": {
    "event": { "ping": [510, 4100], "run": [220, 5020] },
    "version": { "1.2.0": [400, 7000] },
    "prop:command": { "build": [90, 2000] }
  }
}
~~~

- \`summary.dau\`, \`wau\`, \`mau\` are for the latest closed day. \`summary.events\` is summed over the range.
- \`summary.today\` is live from Analytics Engine and cached for about 5 minutes.
- \`series\` has one entry per day, with zeros for days without data.
- \`dims\` maps a dimension name to values, each as \`[users, events]\`, top 20 per dimension by events. Dimension names are \`event\`, \`version\`, \`os\`, \`arch\`, \`country\`, \`ci\`, \`source\` and \`prop:<key>\`. Users are summed per day, so they are user-days, not unique users.

Rollups run daily at 00:10 UTC. To rebuild one day from live data (admin only, the last 89 days):

~~~sh
curl -X POST "${base}/api/${EXAMPLE_PROJECT}/rollup?day=2026-10-12" -H "Authorization: Bearer $ADMIN_TOKEN"
~~~

## Import and backfill

Use this to bring history from another system. Compute the daily aggregates locally, then upload them. See \`scripts/import.ts\` in the repo, which turns raw NDJSON rows into exact rollups.

\`POST ${base}/api/<project>/import\` with \`Authorization: Bearer <admin_token>\`

~~~json
{
  "rows": [
    {
      "day": "2026-07-01", "dau": 12, "wau": 40, "mau": 90, "events": 150,
      "dims": {
        "event": { "run": [10, 120], "ping": [12, 30] },
        "version": { "1.0.0": [12, 150] },
        "prop:command": { "build": [6, 50] }
      }
    }
  ]
}
~~~

- At most 360 rows per request, one row per day, no future days.
- \`dims\` values are \`[users, events]\`. Dims are cut to the top 20 per dimension. The dims JSON is at most 16 KB.
- Import never overwrites a day that was rolled up from live data. Importing the same day again replaces the earlier import.
- Response: \`{"imported": <rows written>, "skipped": <rows kept as they were>}\`.

## Privacy

- The \`id\` is hashed with a secret salt and the project name (\`sha256\`, first 16 hex chars). The raw id is never written anywhere.
- IP address and user agent are never stored. Without \`id\`, they are mixed into a hash that rotates every day and only counts daily users.
- The country comes from Cloudflare's edge, as a 2-letter code.
- Hashed ids exist only in Analytics Engine and are deleted after 90 days. The database holds only daily counts.
- Stats pages and the stats API are public. Do not send anything you would not publish as an aggregate.

## Limits and free tier

| Limit | Value |
|---|---|
| Body size | 16 KB |
| Events per request | 25 (native), 250 points (OTLP) |
| Rate limit | 60 requests per minute per IP (best effort, per Worker instance) |
| Daily cap | 20,000 data points per project per UTC day, then 429 |
| New projects | 3 per IP and 100 in total per UTC day, then 429 |
| Raw event retention | 90 days |
| Rollups | One row per active project per day, kept long term |

The service is meant to run inside the Cloudflare free plan. Workers allows 100,000 requests per day and Analytics Engine allows 100,000 data points per day, both per account. Sending events to an existing project never writes to D1. The first event of a new project writes one row.

## Self-hosting

~~~sh
git clone https://github.com/duyet/telemetry && cd telemetry && bun install && bunx cf deploy
~~~

- Enable Analytics Engine once per account: Cloudflare dashboard, Workers & Pages, Analytics Engine.
- There are no secrets and no environment variables. The Worker creates its own D1 schema on first request, and generates its own hashing salt.
- \`cf deploy\` creates the D1 database, the Analytics Engine dataset and the daily cron.
- Source: https://github.com/duyet/telemetry
`);
}

/** Project-specific agent playbook served at /<project>/install.md. */
export function installMd(base: string, project: string): string {
	const p = envPrefix(project);
	const url = `${base}/${project}`;
	return md(`# Add telemetry to a repo: ${project}

You are a coding agent. Follow these steps to add anonymous usage telemetry that reports to \`${project}\`.

- Endpoint: \`POST ${url}\`
- Project page (aggregate stats): ${url}
- Stats JSON: ${base}/api/${project}/stats
- Full API reference: ${base}/docs

## Payload

~~~json
{"event":"ping","id":"3f2c9a7e-1d4b-4c8e-9a52-7b1e0d6f4a21","version":"1.2.3","os":"linux","arch":"x64","ci":false,"props":{"command":"build"}}
~~~

| Field | Rules |
|---|---|
| \`event\` | Required. \`^[A-Za-z0-9_.:/-]{1,64}$\`. |
| \`id\` | Random install id the client creates once and keeps. Hashed on the server. |
| \`version\` | At most 32 chars. |
| \`os\`, \`arch\` | Free-form lowercase, at most 16 chars. Send what the runtime gives (\`x64\`, \`x86_64\`, \`arm64\`, \`aarch64\` are all fine). Do not remap. |
| \`ci\` | Boolean. \`true\` for a CI run. |
| \`props\` | At most 8 entries. Keys \`[a-z0-9_.-]{1,32}\`. String, number or boolean values. |
| \`n\` | Optional count, 1 to 1000. |

Success is HTTP 202. The server returns 400, 404, 413 or 429 otherwise. Ignore every response.

## How the server counts

- Any event with an \`id\` counts that id as an active user for that UTC day. \`install\` and \`ping\` are not special.
- So send \`install\` once on first run, then at most one \`ping\` per UTC day, plus a few meaningful events. More pings add no users.
- Days are UTC. The client's daily gate must use the UTC date.
- An event without \`id\` counts daily users only.

## Conventions used below

- **Set.** An env var counts as set for any value except empty, \`0\` or \`false\`. This applies to \`DO_NOT_TRACK\`, \`CI\` and every \`${p}_TELEMETRY_*\` flag.
- **Prefix and paths.** \`${p}_*\` and \`~/.config/${project}/\` are defaults. Prefer the tool's own env prefix and config directory when it has them. For example, a CLI called \`anyr\` that already uses \`ANYR_*\` and \`~/.anyrouter/\` keeps those. Use the defaults only when the tool has no convention. Replace them everywhere below, in the code and in the README.

## Steps

### 1. Detect the language and entry point

Read the repo. Find the language, the runtime, the package manifest, the app version source and the entry point (main function, CLI parser, daemon loop, or app startup). Check the existing env prefix, config directory and config file, and the existing update-check or background code. Reuse them.

### 2. Pick the hook

- A once-a-day gate. Best places are an existing update check, a daemon tick, or startup. Send \`ping\` at most once per UTC day. Keep the last-sent UTC date (\`YYYY-MM-DD\`) in a small file next to the id. Write the stamp first, then send. If the stamp cannot be written, do not send.
- Send \`install\` once, when the id is first created.
- Key commands or features, as separate events (for example \`run\` with \`props.command\`). Keep names short and few. Never put user input in an event name.
- Commands that return before the startup hook, such as \`--version\` and \`--help\`, may stay untracked.
- For an install script, send one \`install\` event. Without an id it counts daily users only. That is fine.

### 3. Add a small telemetry module

Add one file with one function, \`track(event, props)\`. Start from the snippet for this language. Snippets for curl, shell, TypeScript, Rust, Go, Python and the browser are on ${url} (Integrate tab) and in ${base}/docs. The ts, rust, go and python versions already include the id file, the opt-out check, the debug mode, fail-closed id handling and the timeout. They do not include the daily gate: add it.

Use ${url} as the endpoint. Set the app version from the package metadata, not a literal.

### 4. Add opt-out, debug, CI skip, fail-closed and the first-run notice

- Disabled when \`DO_NOT_TRACK\` or \`${p}_TELEMETRY_DISABLED\` is set. Also add a config flag if the app has a config file. If the config file exists but cannot be read, do not send.
- Skip when \`CI\` is set, unless \`${p}_TELEMETRY_CI=1\`. When the opt-in is used, send \`ci:true\`.
- \`${p}_TELEMETRY_DEBUG=1\` prints the payload and sends nothing. It has no side effects: no id file, no stamp, no notice. If there is no id yet, print a placeholder. It may print on every due check.
- Keep the id at \`~/.config/${project}/telemetry-id\` (use the platform config directory). Create it once with a random UUID.
- Fail closed. If the id or the daily stamp cannot be saved, skip sending. Otherwise a daemon would ping on every tick. Do not send without an id (an install script is the one exception).
- On first run, when the id file is created, show one line in the app's user-visible channel: stderr for a CLI, the log or notify channel for a daemon or plugin (stderr may be ignored there), the UI for a desktop app:
  \`${project} collects anonymous usage data. Opt out: ${p}_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Details: ${url}\`

### 5. Add a test

Add a test that proves nothing is sent when \`${p}_TELEMETRY_DISABLED=1\`, when \`DO_NOT_TRACK=1\`, and when \`CI\` is set (and that the CI opt-in sends \`ci:true\`). Also prove:

- the debug mode prints and does not send, and writes no id file or stamp;
- nothing is sent when the id or stamp cannot be written;
- a second due check on the same UTC day sends no second \`ping\`.

Mock or stub the network call and assert it is not made. Use the repo's existing test framework.

### 6. Add a "Telemetry" section to the README

Use this template and adjust it to what the code really sends. Use the tool's real env prefix. Keep the config-file opt-out only if the tool has one. Say where the notice appears (stderr, the log, or the UI).

~~~markdown
## Telemetry

${project} sends anonymous usage data so the maintainers know which versions and platforms are in use.

What is sent: event name (for example \`install\`, \`ping\`, \`run\`), a random install id, app version, OS, CPU architecture, whether it ran in CI, and the country (derived by Cloudflare from the request). An \`install\` event is sent once on first run, then at most one \`ping\` per day.

What is not sent: IP address, user agent, file paths, hostnames, usernames, emails, command arguments, or any file content.

On first run, ${project} prints a one-line notice to <stderr | the log | the UI> that says this.

Opt out: set \`${p}_TELEMETRY_DISABLED=1\` or \`DO_NOT_TRACK=1\`, or <the config-file setting, if the tool has a config file>. Set \`${p}_TELEMETRY_DEBUG=1\` to print what would be sent, without sending it.

Public aggregate stats: ${url}
~~~

### 7. Verify

Required, always possible: a dry run.

1. Run the tests.
2. Run a normal command with \`${p}_TELEMETRY_DEBUG=1\`. Pick a command that reaches the startup hook, not \`--version\` or \`--help\`. Check the printed payload matches the table above and has no personal data. Check that no id file and no stamp were created.

Optional, only when network use is allowed: one real ping.

3. Remove \`DEBUG\`, unset \`CI\`, run the app once, or run:
   \`curl -X POST ${url} -H 'content-type: application/json' -d '{"event":"ping","version":"0.0.0"}'\`
4. Check ${url} or \`curl ${base}/api/${project}/stats\`. The \`summary.today.users\` value updates within about 5 minutes.

## Do not

- Do not send PII: no paths, hostnames, emails, usernames, or argument values. Send flag names or subcommand names only, from a fixed list.
- Do not block the main path. Send in the background with a timeout of 1 second or less.
- Do not retry in a loop. One attempt, ignore the result.
- Do not crash on errors. Wrap the whole send in a catch-all.
- Do not send on every command. At most one \`ping\` per UTC day.
- Do not send when the id or the stamp cannot be saved. Fail closed.
- Do not write files, show the notice or send in debug mode.
- Do not derive the id from hardware, username or paths. It is random and stored in the config directory.
- Do not enable telemetry in CI by default.
`);
}

/** Ready-to-paste prompt behind the "Copy agent prompt" button. */
export function agentPrompt(base: string, project: string): string {
	return `Add anonymous usage telemetry to this repo. Follow ${base}/${project}/install.md exactly. Respect DO_NOT_TRACK, add an opt-out env var and a Telemetry section to the README, never send PII, never block the main path.`;
}

/** Copy-paste client snippets per language for one project. */
export function snippets(base: string, project: string): Snippet[] {
	const url = `${base}/${project}`;
	const p = envPrefix(project);
	const notice = `${project} collects anonymous usage data. Opt out: ${p}_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Details: ${url}`;

	return [
		{
			id: "curl",
			label: "curl",
			lang: "sh",
			code: `curl -fsS -m 1 -X POST ${url} \\
  -H 'content-type: application/json' \\
  -d '{"event":"ping","id":"<random-install-id>","version":"1.0.0","os":"linux","arch":"x64"}'`,
		},
		{
			id: "shell",
			label: "Shell (install script)",
			lang: "sh",
			code: `# Anonymous install ping. Put it near the end of install.sh. No id: counts daily users only.
# An env var is "set" for any value except empty, 0 or false.
truthy() { case $(printf %s "$1" | tr '[:upper:]' '[:lower:]') in ""|0|false) return 1 ;; *) return 0 ;; esac; }
if ! truthy "\${DO_NOT_TRACK-}" && ! truthy "\${${p}_TELEMETRY_DISABLED-}" \\
  && { ! truthy "\${CI-}" || truthy "\${${p}_TELEMETRY_CI-}"; }; then
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m | tr '[:upper:]' '[:lower:]')
  if truthy "\${CI-}"; then ci=true; else ci=false; fi
  body=$(printf '{"event":"install","os":"%s","arch":"%s","ci":%s}' "$os" "$arch" "$ci")
  if truthy "\${${p}_TELEMETRY_DEBUG-}"; then
    echo "[telemetry] $body" >&2
  else
    (curl -fsS -m 1 -X POST -H 'content-type: application/json' -d "$body" ${url} >/dev/null 2>&1 &)
  fi
fi`,
		},
		{
			id: "ts",
			label: "TypeScript (Bun, Node, Deno)",
			lang: "ts",
			code: `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENDPOINT = "${url}";
const VERSION = "0.0.0"; // set from your package metadata
const env = process.env;

// "Set" means any value except empty, 0 or false.
const truthy = (v?: string): boolean => !!v && !["0", "false"].includes(v.toLowerCase());

function enabled(): boolean {
	if (truthy(env.DO_NOT_TRACK) || truthy(env.${p}_TELEMETRY_DISABLED)) return false;
	return !truthy(env.CI) || truthy(env.${p}_TELEMETRY_CI);
}

// Returns undefined when the event must be skipped: the id cannot be saved (fail closed).
// Debug mode never writes. It reads the id, or shows a placeholder.
function installId(debug: boolean): string | undefined {
	const file = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "${project}", "telemetry-id");
	try {
		const id = readFileSync(file, "utf8").trim();
		if (id) return id;
	} catch {}
	if (debug) return "new-install-id";
	try {
		const id = crypto.randomUUID();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, id);
		console.error("${notice}"); // stderr suits a CLI. A daemon or plugin should use its log channel.
		return id;
	} catch {
		return undefined;
	}
}

export function track(event: string, props: Record<string, string | number | boolean> = {}): void {
	try {
		if (!enabled()) return;
		const debug = truthy(env.${p}_TELEMETRY_DEBUG);
		const id = installId(debug);
		if (!id) return;
		const body = JSON.stringify({
			event,
			id,
			version: VERSION,
			os: process.platform,
			arch: process.arch,
			ci: truthy(env.CI),
			props,
		});
		if (debug) {
			console.error("[telemetry]", body);
			return;
		}
		fetch(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			signal: AbortSignal.timeout(1000),
		}).catch(() => {});
	} catch {}
}`,
		},
		{
			id: "rust",
			label: "Rust",
			lang: "rust",
			code: `// Cargo.toml: ureq = "2"
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::{env, fs, thread, time::Duration};

const ENDPOINT: &str = "${url}";

/// "Set" means any value except empty, 0 or false.
fn truthy(key: &str) -> bool {
    env::var(key).map_or(false, |v| !matches!(v.to_ascii_lowercase().as_str(), "" | "0" | "false"))
}

fn enabled() -> bool {
    if truthy("DO_NOT_TRACK") || truthy("${p}_TELEMETRY_DISABLED") {
        return false;
    }
    !truthy("CI") || truthy("${p}_TELEMETRY_CI")
}

fn random_id() -> String {
    // 128 random bits from the std hasher seed, no extra crate needed.
    (0..2).map(|_| format!("{:016x}", RandomState::new().build_hasher().finish())).collect()
}

/// None means skip the event: the id cannot be saved (fail closed).
/// Debug mode never writes. It reads the id, or shows a placeholder.
fn install_id(debug: bool) -> Option<String> {
    let file = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .or_else(|| env::var_os("APPDATA").map(PathBuf::from))?
        .join("${project}")
        .join("telemetry-id");
    if let Ok(id) = fs::read_to_string(&file) {
        if !id.trim().is_empty() {
            return Some(id.trim().to_string());
        }
    }
    if debug {
        return Some("new-install-id".to_string());
    }
    let id = random_id();
    fs::create_dir_all(file.parent()?).ok()?;
    fs::write(&file, &id).ok()?;
    eprintln!("${notice}"); // stderr suits a CLI. A daemon or plugin should use its log channel.
    Some(id)
}

/// Fire and forget. Event names must be plain literals. A short-lived CLI can
/// join the returned handle before exit: the request is bounded by the 1 s timeout.
pub fn track(event: &str) -> Option<thread::JoinHandle<()>> {
    if !enabled() {
        return None;
    }
    let debug = truthy("${p}_TELEMETRY_DEBUG");
    let id = install_id(debug)?;
    let body = format!(
        r#"{{"event":"{event}","id":"{id}","version":"{}","os":"{}","arch":"{}","ci":{}}}"#,
        env!("CARGO_PKG_VERSION"),
        env::consts::OS,
        env::consts::ARCH,
        truthy("CI")
    );
    if debug {
        eprintln!("[telemetry] {body}");
        return None;
    }
    Some(thread::spawn(move || {
        let _ = ureq::post(ENDPOINT)
            .timeout(Duration::from_secs(1))
            .set("content-type", "application/json")
            .send_string(&body);
    }))
}`,
		},
		{
			id: "go",
			label: "Go",
			lang: "go",
			code: `package telemetry

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const endpoint = "${url}"
const version = "0.0.0" // set from your build, for example with -ldflags

// truthy: "set" means any value except empty, 0 or false.
func truthy(key string) bool {
	switch strings.ToLower(os.Getenv(key)) {
	case "", "0", "false":
		return false
	}
	return true
}

func enabled() bool {
	if truthy("DO_NOT_TRACK") || truthy("${p}_TELEMETRY_DISABLED") {
		return false
	}
	return !truthy("CI") || truthy("${p}_TELEMETRY_CI")
}

// installID returns "" when the event must be skipped: the id cannot be saved (fail closed).
// Debug mode never writes. It reads the id, or shows a placeholder.
func installID(debug bool) string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	file := filepath.Join(dir, "${project}", "telemetry-id")
	if b, err := os.ReadFile(file); err == nil {
		if id := strings.TrimSpace(string(b)); id != "" {
			return id
		}
	}
	if debug {
		return "new-install-id"
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	id := hex.EncodeToString(buf)
	if os.MkdirAll(filepath.Dir(file), 0o755) != nil || os.WriteFile(file, []byte(id), 0o600) != nil {
		return ""
	}
	fmt.Fprintln(os.Stderr, "${notice}") // stderr suits a CLI. A daemon or plugin should use its log channel.
	return id
}

// Track sends one event in the background. The channel closes when the attempt
// ends (at most 1 s), so a short-lived CLI can wait on it before exit.
func Track(event string, props map[string]any) <-chan struct{} {
	done := make(chan struct{})
	if !enabled() {
		close(done)
		return done
	}
	debug := truthy("${p}_TELEMETRY_DEBUG")
	id := installID(debug)
	if id == "" {
		close(done)
		return done
	}
	payload := map[string]any{
		"event":   event,
		"id":      id,
		"version": version,
		"os":      runtime.GOOS,
		"arch":    runtime.GOARCH,
		"ci":      truthy("CI"),
	}
	if len(props) > 0 {
		payload["props"] = props
	}
	body, err := json.Marshal(payload)
	if err != nil {
		close(done)
		return done
	}
	if debug {
		fmt.Fprintf(os.Stderr, "[telemetry] %s\\n", body)
		close(done)
		return done
	}
	go func() {
		defer close(done)
		client := http.Client{Timeout: time.Second}
		if resp, err := client.Post(endpoint, "application/json", bytes.NewReader(body)); err == nil {
			resp.Body.Close()
		}
	}()
	return done
}`,
		},
		{
			id: "python",
			label: "Python",
			lang: "python",
			code: `import json
import os
import platform
import sys
import threading
import urllib.request
import uuid
from pathlib import Path

ENDPOINT = "${url}"
VERSION = "0.0.0"  # set from your package metadata


def _truthy(key):
    # "Set" means any value except empty, 0 or false.
    return os.environ.get(key, "").lower() not in ("", "0", "false")


def _enabled():
    if _truthy("DO_NOT_TRACK") or _truthy("${p}_TELEMETRY_DISABLED"):
        return False
    return not _truthy("CI") or _truthy("${p}_TELEMETRY_CI")


def _install_id(debug):
    # Returns None when the event must be skipped: the id cannot be saved (fail closed).
    # Debug mode never writes. It reads the id, or shows a placeholder.
    try:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        file = base / "${project}" / "telemetry-id"
        try:
            found = file.read_text().strip()
            if found:
                return found
        except OSError:
            pass
        if debug:
            return "new-install-id"
        install_id = uuid.uuid4().hex
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(install_id)
        # stderr suits a CLI. A daemon or plugin should use its log channel.
        print("${notice}", file=sys.stderr)
        return install_id
    except Exception:
        return None


def track(event, **props):
    try:
        if not _enabled():
            return
        debug = _truthy("${p}_TELEMETRY_DEBUG")
        install_id = _install_id(debug)
        if not install_id:
            return
        body = {
            "event": event,
            "id": install_id,
            "version": VERSION,
            "os": platform.system().lower(),
            "arch": platform.machine().lower(),
            "ci": _truthy("CI"),
        }
        if props:
            body["props"] = props
        if debug:
            print("[telemetry]", json.dumps(body), file=sys.stderr)
            return

        def send():
            try:
                req = urllib.request.Request(
                    ENDPOINT,
                    json.dumps(body).encode(),
                    {"content-type": "application/json"},
                )
                urllib.request.urlopen(req, timeout=1).close()
            except Exception:
                pass

        # Daemon thread: never delays exit. A very short script may exit before it sends.
        threading.Thread(target=send, daemon=True).start()
    except Exception:
        pass`,
		},
		{
			id: "browser",
			label: "Browser",
			lang: "js",
			code: `const ENDPOINT = "${url}";
const ID_KEY = "${project}-telemetry-id";
const OFF_KEY = "${project}-telemetry-disabled";

export function track(event, props) {
	try {
		if (navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true) return;
		if (localStorage.getItem(OFF_KEY) === "1") return;
		let id = localStorage.getItem(ID_KEY);
		if (!id) {
			id = crypto.randomUUID();
			localStorage.setItem(ID_KEY, id);
		}
		const body = JSON.stringify({ event, id, props });
		navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
	} catch {}
}

// track("ping"); // once per page load or once per day. Never send URLs, paths or user input.`,
		},
		{
			id: "otlp",
			label: "OpenTelemetry (OTLP)",
			lang: "sh",
			code: `export OTEL_EXPORTER_OTLP_ENDPOINT=${url}
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_SERVICE_NAME=${project}
# The install id keeps users distinct. Generate it once and persist it.
export OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<random-install-id>,service.version=1.0.0`,
		},
	];
}

export function llmsTxt(base: string): string {
	return md(`# Telemetry

> Free, self-hosted usage telemetry on Cloudflare Workers. Any project (CLI, desktop app, plugin, web app, server) sends anonymous events with one HTTP POST, or OTLP/HTTP JSON, and gets public aggregate stats. Raw events are kept 90 days, daily rollups are kept long term. No raw ids, IPs or user agents are stored.

## Docs

- [API reference](${base}/docs): sending events, OTLP, projects, stats, import, limits
- [Agent guide](${base}/AGENTS.md): how to add telemetry to any repo, starting from no project
- [Projects](${base}/api/projects): JSON list of active projects (data in the last 30 days)
- Project install playbook: ${base}/<project>/install.md (replace <project> with the slug)
- Project page and stats: ${base}/<project>, JSON at ${base}/api/<project>/stats

## Full API reference

${apiMd(base)}`);
}

export function agentsMd(base: string): string {
	return md(`# Adding telemetry to a repo

Guide for coding agents. Use it when the user asks for usage telemetry, analytics or a phone-home in a project and no telemetry project exists yet. Service: \`${base}\`.

## 1. Create the project with its first event

A project is created by its first valid event. There is no signup step.

Pick a slug: lowercase letters, digits and \`-\`, 2 to 39 chars, usually the repo name. Check that it is free: \`curl -s -o /dev/null -w '%{http_code}' ${base}/api/<slug>/stats\` prints \`404\` for a free slug. If it prints \`200\` and the user does not own it, pick another slug.

Send the first event from your shell, not from the app:

~~~sh
curl -sS -X POST ${base}/<slug> -H 'content-type: application/json' -d '{"event":"ping"}'
# {"accepted":1,"dropped":0,"project":{"slug":"<slug>","created":true,"admin_token":"tk_...","page_url":"${base}/<slug>"}}
~~~

- \`project.admin_token\` is shown once. It is also in the \`x-telemetry-admin-token\` header. Tell the user to save it outside the repo, for example in \`~/.config/telemetry/<slug>.token\`. Never commit it. It is needed to rename the project, rotate the token, import, roll up or delete.
- No \`project\` in the response means the slug already existed.
- \`429\` with \`new project limit reached for today\` means the caps were hit (3 new projects per IP, 100 in total, per UTC day). Try again the next UTC day.
- Optional: set a display name with \`PATCH ${base}/api/<slug>\` (see ${base}/docs). The slug itself cannot change.

## 2. Follow the project playbook

Fetch \`${base}/<slug>/install.md\` and follow it step by step. It has the exact endpoint, payload, snippets for each language, the opt-out rules, a test to add, and a README template.

## Rules

- Anonymous only. No PII: no paths, hostnames, emails, usernames or argument values.
- Honor \`DO_NOT_TRACK\` and \`<APP>_TELEMETRY_DISABLED\` (set means any value except empty, \`0\` or \`false\`). Skip in CI unless \`<APP>_TELEMETRY_CI=1\`. \`<APP>_TELEMETRY_DEBUG=1\` prints the payload instead of sending, with no side effects.
- Fail closed: if the id or the daily stamp cannot be saved, send nothing.
- Fire and forget, timeout 1 second or less, no retries, never block or crash the app.
- Any event with an id counts that id as an active user for the UTC day. Send \`install\` once, then at most one \`ping\` per UTC day, plus a few meaningful events.
- Add a test for the opt-outs and a "Telemetry" section in the README.

## More

- API reference: ${base}/docs (raw: ${base}/llms.txt)
- Stats for a project: ${base}/api/<slug>/stats
`);
}
