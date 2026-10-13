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

1. Create a project. The response has an admin token. It is shown once, so save it.

~~~sh
curl -X POST ${base}/api/projects \\
  -H 'content-type: application/json' \\
  -d '{"slug":"${EXAMPLE_PROJECT}","name":"My Tool","homepage":"https://example.com"}'
~~~

2. Send an event.

~~~sh
curl -X POST ${base}/${EXAMPLE_PROJECT} \\
  -H 'content-type: application/json' \\
  -d '{"event":"ping","id":"3f2c9a7e-1d4b-4c8e-9a52-7b1e0d6f4a21","version":"1.0.0","os":"linux","arch":"x64"}'
# {"accepted":1,"dropped":0}
~~~

3. See it. Open \`${base}/${EXAMPLE_PROJECT}\`, or read the JSON:

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
| \`os\` | string | no | Lowercase, at most 16 chars of \`[a-z0-9_-]\`. For example \`linux\`, \`darwin\`, \`windows\`. |
| \`arch\` | string | no | Same rules as \`os\`. For example \`x64\`, \`arm64\`. |
| \`ci\` | boolean | no | True when the event came from a CI run. |
| \`props\` | object | no | At most 8 entries. Keys match \`[a-z0-9_.-]{1,32}\`. Values are string, number or boolean, and are cut to 64 chars. |
| \`n\` | integer | no | Occurrence count, 1 to 1000. Default 1. |

Rules the server applies:

- The country comes from Cloudflare. The client cannot set it.
- The IP address and user agent are never stored.
- Without \`id\`, the server uses a hash that rotates every day. That counts daily users (DAU) only. Weekly and monthly users need a stable \`id\`.
- A bad optional field (for example an \`os\` with spaces) is ignored, and the event is still counted. Only a missing or invalid \`event\` drops the event.
- Invalid events in a batch are dropped. The valid ones are kept.
- Identical events in one request are merged into one data point with a summed \`n\`. \`accepted\` counts data points after merging, \`dropped\` counts invalid events.

Responses:

| Status | Meaning |
|---|---|
| 202 | Accepted. Body is \`{"accepted": <number>, "dropped": <number>}\`. |
| 400 | Body is not valid JSON, is not an object or array, has more than 25 events, or has no valid events. |
| 404 | Unknown project. A project created in the last 30 seconds may answer 404 from another Worker instance. |
| 413 | Body is larger than 16 KB. |
| 429 | Per-IP rate limit (with a \`Retry-After\` header in seconds), or the project's daily cap. Do not retry in a loop. |

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

- Honor \`DO_NOT_TRACK=1\` and \`<APP>_TELEMETRY_DISABLED=1\`. Send nothing when either is set.
- Skip sending in CI unless the user opts in (for example \`<APP>_TELEMETRY_CI=1\`).
- \`<APP>_TELEMETRY_DEBUG=1\` prints the payload and does not send it.
- Create a random id once and keep it at \`~/.config/<app>/telemetry-id\`, or the platform equivalent. Never derive it from the machine, user, hostname or path.
- Send fire-and-forget with a timeout of 1 second or less. Never block the app, never crash it, never retry in a loop.
- Send at most one \`ping\` per day, plus meaningful events such as a command run.
- Print a one-line notice on first run. It says what is sent and how to turn it off.
- Send no personal data. No file paths, hostnames, emails, usernames, arguments values or error messages.

Ready-made snippets for curl, shell, TypeScript, Rust, Go, Python and the browser are on each project page, and in \`${base}/<project>/install.md\`.

## Projects API

List projects:

~~~sh
curl ${base}/api/projects
~~~

Create a project: \`POST ${base}/api/projects\`

| Field | Rules |
|---|---|
| \`slug\` | Required. Matches \`^[a-z0-9][a-z0-9-]{1,38}$\` and is not a reserved word (\`api\`, \`docs\`, \`health\`, \`llms.txt\`, and similar). |
| \`name\` | Optional. At most 60 chars. |
| \`description\` | Optional. At most 200 chars. |
| \`homepage\` | Optional. An http(s) URL, at most 200 chars. |

Response \`201\`:

~~~json
{
  "slug": "${EXAMPLE_PROJECT}",
  "admin_token": "tk_...",
  "page_url": "${base}/${EXAMPLE_PROJECT}",
  "ingest_url": "${base}/${EXAMPLE_PROJECT}",
  "otlp_endpoint": "${base}/${EXAMPLE_PROJECT}",
  "install_md": "${base}/${EXAMPLE_PROJECT}/install.md",
  "stats_url": "${base}/api/${EXAMPLE_PROJECT}/stats"
}
~~~

\`admin_token\` is shown once and cannot be recovered. Only its hash is stored. Errors: \`400\` invalid field, \`409\` slug taken, \`429\` more than 5 creates per day from one IP.

Delete a project and its rollups:

~~~sh
curl -X DELETE ${base}/api/${EXAMPLE_PROJECT} -H "Authorization: Bearer $ADMIN_TOKEN"
~~~

Admin endpoints return \`401\` for a missing or wrong token and \`404\` for an unknown project. Raw events in Analytics Engine cannot be deleted. They expire after 90 days.

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
| Project creates | 5 per day per IP |
| Raw event retention | 90 days |
| Rollups | One row per active project per day, kept long term |

The service is meant to run inside the Cloudflare free plan. Workers allows 100,000 requests per day and Analytics Engine allows 100,000 data points per day, both per account. Sending events never writes to D1.

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
| \`os\`, \`arch\` | Lowercase, at most 16 chars. |
| \`ci\` | Boolean. |
| \`props\` | At most 8 entries. Keys \`[a-z0-9_.-]{1,32}\`. String, number or boolean values. |
| \`n\` | Optional count, 1 to 1000. |

Success is HTTP 202. The server returns 400, 404, 413 or 429 otherwise. Ignore every response.

## Steps

### 1. Detect the language and entry point

Read the repo. Find the language, the runtime, the package manifest, the app version source and the entry point (main function, CLI parser, daemon loop, or app startup). Check the existing config directory convention and the existing update-check or background code. Reuse them.

### 2. Pick the hook

- A once-a-day gate. Best places are an existing update check, a daemon tick, or startup. Send \`ping\` at most once per day. Keep the last-sent date in a small file next to the id.
- Key commands or features, as separate events (for example \`run\` with \`props.command\`). Keep names short and few. Never put user input in an event name.
- For an install script, send one \`install\` event. Without an id it counts daily users only. That is fine.

### 3. Add a small telemetry module

Add one file with one function, \`track(event, props)\`. Start from the snippet for this language. Snippets for curl, shell, TypeScript, Rust, Go, Python and the browser are on ${url} (Integrate tab) and in ${base}/docs. The ts, rust, go and python versions already include the id file, the opt-out check and the timeout.

Use ${url} as the endpoint. Set the app version from the package metadata, not a literal.

### 4. Add opt-out, debug, CI skip and the first-run notice

- Disabled when \`DO_NOT_TRACK=1\` or \`${p}_TELEMETRY_DISABLED=1\`. Also add a config flag if the app has a config file.
- \`${p}_TELEMETRY_DEBUG=1\` prints the payload to stderr and sends nothing.
- Skip when \`CI\` is set, unless \`${p}_TELEMETRY_CI=1\`.
- Keep the id at \`~/.config/${project}/telemetry-id\` (use the platform config directory). Create it once with a random UUID. If the file cannot be written, send without an id.
- On first run, when the id file is created, print one line to stderr:
  \`${project} collects anonymous usage data. Opt out: ${p}_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Details: ${url}\`

### 5. Add a test

Add a test that proves nothing is sent when \`${p}_TELEMETRY_DISABLED=1\`, when \`DO_NOT_TRACK=1\`, and when \`CI\` is set. Mock or stub the network call and assert it is not made. Also assert the debug mode prints and does not send. Use the repo's existing test framework.

### 6. Add a "Telemetry" section to the README

Use this template and adjust it to what the code really sends:

~~~markdown
## Telemetry

${project} sends anonymous usage data so the maintainers know which versions and platforms are in use.

What is sent: event name (for example \`ping\`, \`run\`), a random install id, app version, OS, CPU architecture, whether it ran in CI, and the country (derived by Cloudflare from the request).

What is not sent: IP address, user agent, file paths, hostnames, usernames, emails, command arguments, or any file content.

Opt out: set \`${p}_TELEMETRY_DISABLED=1\` or \`DO_NOT_TRACK=1\`. Set \`${p}_TELEMETRY_DEBUG=1\` to print what would be sent.

Public aggregate stats: ${url}
~~~

### 7. Verify

1. Run the app with \`${p}_TELEMETRY_DEBUG=1\`. Check the printed payload matches the table above and has no personal data.
2. Run the tests.
3. Send one real ping. Remove \`DEBUG\`, unset \`CI\`, run the app once, or run:
   \`curl -X POST ${url} -H 'content-type: application/json' -d '{"event":"ping","version":"0.0.0"}'\`
4. Check ${url} or \`curl ${base}/api/${project}/stats\`. The \`summary.today.users\` value updates within about 5 minutes.

## Do not

- Do not send PII: no paths, hostnames, emails, usernames, or argument values. Send flag names or subcommand names only, from a fixed list.
- Do not block the main path. Send in the background with a timeout of 1 second or less.
- Do not retry in a loop. One attempt, ignore the result.
- Do not crash on errors. Wrap the whole send in a catch-all.
- Do not send on every command. At most one \`ping\` per day.
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
if [ "\${DO_NOT_TRACK-}" != "1" ] && [ "\${${p}_TELEMETRY_DISABLED-}" != "1" ] && [ -z "\${CI-}" ]; then
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m | tr '[:upper:]' '[:lower:]')
  body=$(printf '{"event":"install","os":"%s","arch":"%s"}' "$os" "$arch")
  if [ "\${${p}_TELEMETRY_DEBUG-}" = "1" ]; then
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

function enabled(): boolean {
	if (env.DO_NOT_TRACK === "1" || env.${p}_TELEMETRY_DISABLED === "1") return false;
	return !env.CI || env.${p}_TELEMETRY_CI === "1";
}

function installId(): string | undefined {
	const file = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "${project}", "telemetry-id");
	try {
		return readFileSync(file, "utf8").trim();
	} catch {}
	try {
		const id = crypto.randomUUID();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, id);
		console.error("${notice}");
		return id;
	} catch {
		return undefined; // cannot persist: send without an id
	}
}

export function track(event: string, props: Record<string, string | number | boolean> = {}): void {
	try {
		if (!enabled()) return;
		const body = JSON.stringify({
			event,
			id: installId(),
			version: VERSION,
			os: process.platform,
			arch: process.arch,
			ci: !!env.CI,
			props,
		});
		if (env.${p}_TELEMETRY_DEBUG === "1") {
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

fn enabled() -> bool {
    let on = |k: &str| env::var(k).as_deref() == Ok("1");
    if on("DO_NOT_TRACK") || on("${p}_TELEMETRY_DISABLED") {
        return false;
    }
    env::var_os("CI").is_none() || on("${p}_TELEMETRY_CI")
}

fn random_id() -> String {
    // 128 random bits from the std hasher seed, no extra crate needed.
    (0..2).map(|_| format!("{:016x}", RandomState::new().build_hasher().finish())).collect()
}

fn install_id() -> Option<String> {
    let dir = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .or_else(|| env::var_os("APPDATA").map(PathBuf::from))?
        .join("${project}");
    let file = dir.join("telemetry-id");
    if let Ok(id) = fs::read_to_string(&file) {
        return Some(id.trim().to_string());
    }
    let id = random_id();
    fs::create_dir_all(&dir).ok()?;
    fs::write(&file, &id).ok()?;
    eprintln!("${notice}");
    Some(id)
}

/// Fire and forget. Event names must be plain literals. A short-lived CLI can
/// join the returned handle before exit: the request is bounded by the 1 s timeout.
pub fn track(event: &str) -> Option<thread::JoinHandle<()>> {
    if !enabled() {
        return None;
    }
    let id = install_id().map(|id| format!(r#""id":"{id}","#)).unwrap_or_default();
    let body = format!(
        r#"{{"event":"{event}",{id}"version":"{}","os":"{}","arch":"{}"}}"#,
        env!("CARGO_PKG_VERSION"),
        env::consts::OS,
        env::consts::ARCH
    );
    if env::var("${p}_TELEMETRY_DEBUG").as_deref() == Ok("1") {
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

func enabled() bool {
	if os.Getenv("DO_NOT_TRACK") == "1" || os.Getenv("${p}_TELEMETRY_DISABLED") == "1" {
		return false
	}
	return os.Getenv("CI") == "" || os.Getenv("${p}_TELEMETRY_CI") == "1"
}

// installID returns "" when the id cannot be persisted, so the event is sent without an id.
func installID() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	file := filepath.Join(dir, "${project}", "telemetry-id")
	if b, err := os.ReadFile(file); err == nil {
		return strings.TrimSpace(string(b))
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	id := hex.EncodeToString(buf)
	if os.MkdirAll(filepath.Dir(file), 0o755) != nil || os.WriteFile(file, []byte(id), 0o600) != nil {
		return ""
	}
	fmt.Fprintln(os.Stderr, "${notice}")
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
	payload := map[string]any{
		"event":   event,
		"version": version,
		"os":      runtime.GOOS,
		"arch":    runtime.GOARCH,
		"ci":      os.Getenv("CI") != "",
	}
	if id := installID(); id != "" {
		payload["id"] = id
	}
	if len(props) > 0 {
		payload["props"] = props
	}
	body, err := json.Marshal(payload)
	if err != nil {
		close(done)
		return done
	}
	if os.Getenv("${p}_TELEMETRY_DEBUG") == "1" {
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


def _enabled():
    env = os.environ
    if env.get("DO_NOT_TRACK") == "1" or env.get("${p}_TELEMETRY_DISABLED") == "1":
        return False
    return not env.get("CI") or env.get("${p}_TELEMETRY_CI") == "1"


def _install_id():
    # Returns None when the id cannot be persisted: the event is sent without an id.
    try:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        file = base / "${project}" / "telemetry-id"
        try:
            return file.read_text().strip()
        except OSError:
            pass
        install_id = uuid.uuid4().hex
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(install_id)
        print("${notice}", file=sys.stderr)
        return install_id
    except Exception:
        return None


def track(event, **props):
    try:
        if not _enabled():
            return
        body = {
            "event": event,
            "version": VERSION,
            "os": platform.system().lower(),
            "arch": platform.machine().lower(),
            "ci": bool(os.environ.get("CI")),
        }
        install_id = _install_id()
        if install_id:
            body["id"] = install_id
        if props:
            body["props"] = props
        if os.environ.get("${p}_TELEMETRY_DEBUG") == "1":
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
- [Projects](${base}/api/projects): JSON list of registered projects
- Project install playbook: ${base}/<project>/install.md (replace <project> with the slug)
- Project page and stats: ${base}/<project>, JSON at ${base}/api/<project>/stats

## Full API reference

${apiMd(base)}`);
}

export function agentsMd(base: string): string {
	return md(`# Adding telemetry to a repo

Guide for coding agents. Use it when the user asks for usage telemetry, analytics or a phone-home in a project and no telemetry project exists yet. Service: \`${base}\`.

## 1. Create a project

Pick a slug: lowercase letters, digits and \`-\`, 2 to 39 chars, usually the repo name. Create it:

~~~sh
curl -X POST ${base}/api/projects \\
  -H 'content-type: application/json' \\
  -d '{"slug":"<slug>","name":"<Name>","description":"<one line>","homepage":"<repo url>"}'
~~~

The response has \`admin_token\`. It is shown once. Tell the user to save it (never commit it). It is only needed for admin calls (delete, import, rollup). \`409\` means the slug is taken: pick another one. If the project already exists and the user owns it, skip this step.

## 2. Follow the project playbook

Fetch \`${base}/<slug>/install.md\` and follow it step by step. It has the exact endpoint, payload, snippets for each language, the opt-out rules, a test to add, and a README template.

## Rules

- Anonymous only. No PII: no paths, hostnames, emails, usernames or argument values.
- Honor \`DO_NOT_TRACK=1\` and \`<APP>_TELEMETRY_DISABLED=1\`. Skip in CI unless opted in. \`<APP>_TELEMETRY_DEBUG=1\` prints the payload instead of sending.
- Fire and forget, timeout 1 second or less, no retries, never block or crash the app.
- At most one \`ping\` per day, plus a few meaningful events.
- Add a test for the opt-outs and a "Telemetry" section in the README.

## More

- API reference: ${base}/docs (raw: ${base}/llms.txt)
- Stats for a project: ${base}/api/<slug>/stats
`);
}
