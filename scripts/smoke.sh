#!/usr/bin/env bash
# End-to-end checks against a running deployment: scripts/smoke.sh <base-url>
# Needs curl, jq, gzip. Creates a throwaway project with its first event and deletes it at the end.
# Uses one of the 3 daily new projects for your IP.
set -euo pipefail

BASE="${1:?usage: smoke.sh <base-url>}"
BASE="${BASE%/}"
SLUG="smoke-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TMP="$(mktemp -d)"
TOKEN=""
FAILED=0

pass() { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+ ($2)}"; FAILED=$((FAILED + 1)); }

# check <name> <expected> <actual>
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected $2, got $3"; fi; }
# contains <name> <needle> <file>
contains() { if grep -qF -- "$2" "$3"; then pass "$1"; else fail "$1" "missing: $2"; fi; }

# req <method> <path> [curl args...]: prints the HTTP status, body goes to $TMP/body, headers to $TMP/headers
req() {
  local method="$1" path="$2"
  shift 2
  curl -sS -m 15 -X "$method" -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' "$BASE$path" "$@" || true
}
JSON=(-H 'content-type: application/json')

cleanup() {
  if [ -n "$TOKEN" ]; then
    curl -sS -m 15 -X DELETE -o /dev/null "$BASE/api/$SLUG" -H "Authorization: Bearer $TOKEN" || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "smoke test: $BASE (project $SLUG)"

# 1. health
check "GET /health" 200 "$(req GET /health)"

admin_header() { grep -i '^x-telemetry-admin-token:' "$TMP/headers" | cut -d' ' -f2 | tr -d '\r' || true; }

# 2. the first event creates the project
single='{"event":"smoke","id":"smoke-install-1","version":"0.0.0","os":"linux","arch":"x64","ci":true,"props":{"command":"smoke"}}'
check "first POST /<project> creates it" 202 "$(req POST "/$SLUG" "${JSON[@]}" -d "$single")"
check "first event accepted=1" "1 0" "$(jq -r '"\(.accepted) \(.dropped)"' "$TMP/body")"
check "response says created" true "$(jq -r '.project.created' "$TMP/body")"
TOKEN="$(jq -r '.project.admin_token // empty' "$TMP/body")"
if [ -n "$TOKEN" ]; then pass "create returned an admin token"; else fail "create returned an admin token"; fi
check "token is also in the header" "$TOKEN" "$(admin_header)"
check "create returned page_url" "$BASE/$SLUG" "$(jq -r '.project.page_url' "$TMP/body")"

# 3. later events carry no token
check "second POST /<project>" 202 "$(req POST "/$SLUG" "${JSON[@]}" -d "$single")"
check "second event has no project" null "$(jq -r '.project' "$TMP/body")"
check "second event has no token header" "" "$(admin_header)"
check "brand-new project is not in the registry" false "$(req GET /api/projects >/dev/null; jq --arg s "$SLUG" '[.projects[].slug] | index($s) != null' "$TMP/body")"

# 4. batch (one invalid event is dropped)
check "POST /<project> batch" 202 "$(req POST "/$SLUG" "${JSON[@]}" \
  -d '[{"event":"smoke","id":"smoke-install-2"},{"event":"smoke","id":"smoke-install-3","n":5},{"event":"bad event name!"}]')"
check "batch accepted=2 dropped=1" "2 1" "$(jq -r '"\(.accepted) \(.dropped)"' "$TMP/body")"

# 5. errors
check "bad JSON -> 400" 400 "$(req POST "/$SLUG" "${JSON[@]}" -d '{not json')"
check "no valid events -> 400" 400 "$(req POST "/$SLUG" "${JSON[@]}" -d '{"event":"bad event name!"}')"
check "no valid events to a new slug -> 400" 400 "$(req POST "/nope-$SLUG" "${JSON[@]}" -d '{"event":"bad event name!"}')"
check "... and creates nothing" 404 "$(req GET "/api/nope-$SLUG/stats")"
check "reserved slug -> 404" 404 "$(req POST /docs "${JSON[@]}" -d '{"event":"smoke"}')"
check "invalid slug -> 404" 404 "$(req POST /Bad_Slug "${JSON[@]}" -d '{"event":"smoke"}')"

# 6. OTLP
OTLP='{"resourceLogs":[{"resource":{"attributes":[{"key":"service.instance.id","value":{"stringValue":"smoke-otlp-1"}},{"key":"service.version","value":{"stringValue":"1.0.0"}},{"key":"os.type","value":{"stringValue":"linux"}}]},"scopeLogs":[{"logRecords":[{"body":{"stringValue":"smoke"},"attributes":[{"key":"event.name","value":{"stringValue":"smoke_otlp"}}]}]}]}]}'
check "OTLP logs JSON -> 200" 200 "$(req POST "/$SLUG/v1/logs" "${JSON[@]}" -d "$OTLP")"
printf '%s' "$OTLP" | gzip -c > "$TMP/otlp.gz"
check "OTLP logs gzip -> 200" 200 "$(req POST "/$SLUG/v1/logs" "${JSON[@]}" -H 'content-encoding: gzip' --data-binary "@$TMP/otlp.gz")"
check "OTLP protobuf -> 415" 415 "$(req POST "/$SLUG/v1/logs" -H 'content-type: application/x-protobuf' --data-binary 'x')"

# 7. stats JSON shape
check "GET /api/<project>/stats" 200 "$(req GET "/api/$SLUG/stats?days=7")"
check "stats shape" true "$(jq '(.project | type) == "string" and .days == 7 and (.series | length) == 7 and (.summary.today.users | type) == "number" and (.dims | type) == "object"' "$TMP/body")"
check "stats unknown project -> 404" 404 "$(req GET "/api/nope-$SLUG/stats")"

# 8. pages and agent notes
status="$(req GET "/$SLUG")"
check "GET /<project> page" 200 "$status"
if grep -qi '^content-type: *text/html' "$TMP/headers"; then pass "page is HTML"; else fail "page is HTML"; fi
check "GET /<project>/install.md" 200 "$(req GET "/$SLUG/install.md")"
contains "install.md has the endpoint" "$BASE/$SLUG" "$TMP/body"
check "GET /<project>/install.md unknown -> 404" 404 "$(req GET "/nope-$SLUG/install.md")"
check "GET /docs" 200 "$(req GET /docs)"
check "GET /llms.txt" 200 "$(req GET /llms.txt)"
check "GET /AGENTS.md" 200 "$(req GET /AGENTS.md)"
check "CORS preflight" 204 "$(req OPTIONS "/$SLUG" -H 'origin: https://example.com' -H 'access-control-request-method: POST')"

# 9. maintenance: rename and token rotation
check "PATCH without token -> 401" 401 "$(req PATCH "/api/$SLUG" "${JSON[@]}" -d '{"name":"Smoke test"}')"
check "PATCH /api/<project>" 200 "$(req PATCH "/api/$SLUG" "${JSON[@]}" -H "Authorization: Bearer $TOKEN" -d '{"name":"Smoke test"}')"
check "PATCH set the name" "Smoke test" "$(jq -r '.project.name' "$TMP/body")"
check "PATCH bad homepage -> 400" 400 "$(req PATCH "/api/$SLUG" "${JSON[@]}" -H "Authorization: Bearer $TOKEN" -d '{"homepage":"javascript:alert(1)"}')"
OLD_TOKEN="$TOKEN"
check "POST /api/<project>/token" 200 "$(req POST "/api/$SLUG/token" -H "Authorization: Bearer $OLD_TOKEN")"
NEW_TOKEN="$(jq -r '.admin_token // empty' "$TMP/body")"
if [ -n "$NEW_TOKEN" ] && [ "$NEW_TOKEN" != "$OLD_TOKEN" ]; then
  pass "rotation returned a new token"
  TOKEN="$NEW_TOKEN"
else
  fail "rotation returned a new token"
fi
check "old token stops working -> 401" 401 "$(req PATCH "/api/$SLUG" "${JSON[@]}" -H "Authorization: Bearer $OLD_TOKEN" -d '{"name":"x"}')"

# 10. delete with the rotated token
check "DELETE without token -> 401" 401 "$(req DELETE "/api/$SLUG")"
check "DELETE /api/<project>" 200 "$(req DELETE "/api/$SLUG" -H "Authorization: Bearer $TOKEN")"
TOKEN=""

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED check(s) failed"
  exit 1
fi
echo "all checks passed"
