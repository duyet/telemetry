---
name: add-telemetry
description: Add anonymous usage telemetry (analytics, a phone-home, install or daily ping) to a project using the self-hosted telemetry service. Use when the user asks to add usage telemetry, analytics, usage stats, or a phone-home to a CLI, desktop app, plugin, web app or server.
---

# Add telemetry to a project

Adds anonymous usage telemetry that reports to a telemetry service (https://github.com/duyet/telemetry). Default base URL: `https://telemetry.anyr.workers.dev`. This is a placeholder. Use the user's own deployment URL if they give one, and ask if unsure.

In this file `BASE` is the base URL and `<project>` is the project slug.

## 1. Get a project

Ask the user for the project slug. If they have none, pick one (lowercase letters, digits and `-`, 2 to 39 chars, usually the repo name). The first event to a new slug creates the project.

1. Check it is free: `curl -s -o /dev/null -w '%{http_code}' BASE/api/<project>/stats` prints `404` for a free slug.
2. Send the first event from your shell, not from the app:

```sh
curl -sS -X POST BASE/<project> -H 'content-type: application/json' -d '{"event":"ping"}'
```

The response has `project.admin_token` (also in the `x-telemetry-admin-token` header). It is shown once. Tell the user to save it outside the repo. Never write it into the repo. No `project` in the response means the slug already existed. `429` means the new project limit for today (3 per IP, 100 in total) was reached.

Optional: set a display name with `curl -X PATCH BASE/api/<project> -H "Authorization: Bearer <token>" -H 'content-type: application/json' -d '{"name":"<Name>","homepage":"<repo url>"}'`. The slug cannot change.

## 2. Fetch the playbook

Fetch `BASE/<project>/install.md` and follow it. It has the exact endpoint, payload, and a snippet per language. It is the source of truth. If it differs from the steps below, the playbook wins.

## 3. Steps in short

1. Detect the language, runtime, app version source and entry point.
2. Pick the hook: a once-a-day gate (an update check, a daemon tick, or startup) for `ping`, plus a few key commands as events. For an install script, send one `install` event.
3. Add one small telemetry module with a `track(event, props)` function, from the snippet for this language.
4. Add the opt-outs:
   - `DO_NOT_TRACK=1` and `<APP>_TELEMETRY_DISABLED=1` send nothing.
   - `<APP>_TELEMETRY_DEBUG=1` prints the payload and sends nothing.
   - Skip in CI unless `<APP>_TELEMETRY_CI=1`.
   - Keep a random id at `~/.config/<app>/telemetry-id` (or the platform equivalent).
   - Print a one-line first-run notice on stderr.
5. Add a test that opt-out, `DO_NOT_TRACK` and CI each suppress sending.
6. Add a "Telemetry" section to the README: what is sent, what is not sent, how to opt out, and a link to `BASE/<project>`.
7. Verify: run with the debug env and read the payload, then send one real ping and check `BASE/<project>` or `BASE/api/<project>/stats` (today's users update within about 5 minutes).

`<APP>` is the project slug in uppercase with `-` changed to `_`.

## Do not

- Do not send PII: no paths, hostnames, emails, usernames or argument values.
- Do not block the main path. Fire and forget, timeout 1 second or less.
- Do not retry in a loop. Do not crash on errors.
- Do not send more than one `ping` per day.
- Do not enable telemetry in CI by default.
- Do not commit the admin token.
