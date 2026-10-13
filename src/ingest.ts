import { writeEvents } from "./ae.ts";
import { getSalt, projectExists } from "./db.ts";
import { checkIp, reserve } from "./guard.ts";
import { EVENT_RE, parseOtlp } from "./otlp.ts";
import { autoCreate } from "./projects.ts";
import { type CreatedProject, type Ctx, MAX_BATCH, MAX_BODY_BYTES, MAX_PROP_LEN, MAX_PROPS, type TelemetryEvent } from "./types.ts";
import { isValidSlug, sha256hex, utcDay } from "./util.ts";

const VERSION_RE = /^[\w.+-]{1,32}$/;
const PLATFORM_RE = /^[a-z0-9_-]{1,16}$/;
const PROP_KEY_RE = /^[a-z0-9_.-]{1,32}$/;
const MAX_ID_LEN = 128;
const MAX_N = 1000;

const OTLP_RAW_MAX = 256 * 1024;
const OTLP_MAX = 1024 * 1024;
// Analytics Engine allows 250 writeDataPoint calls per invocation.
const OTLP_MAX_POINTS = 250;
const OTLP_REJECTED_KEY = { logs: "rejectedLogRecords", traces: "rejectedSpans", metrics: "rejectedDataPoints" };

export interface NormCtx {
	source: TelemetryEvent["source"];
	country: string;
	/** Hashed uid for a client id; no usable id falls back to a daily per-ip/ua hash. Memoized per request. */
	uid(id: unknown): Promise<string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function makeCtx(c: Ctx, project: string, source: NormCtx["source"]): NormCtx {
	const salt = getSalt();
	const ip = clientIp(c);
	const ua = c.req.header("user-agent") ?? "";
	const country = (c.req.raw.cf as { country?: unknown } | undefined)?.country;
	const memo = new Map<string, Promise<string>>();
	return {
		source,
		country: typeof country === "string" && /^[A-Za-z]{2}$/.test(country) ? country.toLowerCase() : "",
		uid(id) {
			const key = typeof id === "string" && id.length <= MAX_ID_LEN ? id : "";
			let hash = memo.get(key);
			if (!hash) {
				// The fallback only supports DAU: the day in the hash stops it linking a visitor across days.
				const input = key ? `${salt}|${project}|${key}` : `${salt}|${utcDay()}|${project}|${ip}|${ua}`;
				hash = sha256hex(input).then((h) => h.slice(0, 16));
				memo.set(key, hash);
			}
			return hash;
		},
	};
}

const clientIp = (c: Ctx): string => c.req.header("cf-connecting-ip") ?? "unknown";

function clean(v: unknown, re: RegExp, lower = false): string {
	if (typeof v !== "string") return "";
	const s = lower ? v.toLowerCase() : v;
	return re.test(s) ? s : "";
}

/** Valid props, first MAX_PROPS in input order, then sorted so equal props always fill the same AE blobs. */
function normalizeProps(v: unknown): Record<string, string> {
	const seen = new Map<string, string>();
	if (isRecord(v)) {
		for (const [rawKey, val] of Object.entries(v)) {
			if (seen.size >= MAX_PROPS) break;
			const key = rawKey.toLowerCase();
			const primitive = typeof val === "string" || typeof val === "number" || typeof val === "boolean";
			if (primitive && PROP_KEY_RE.test(key) && !seen.has(key)) seen.set(key, String(val).slice(0, MAX_PROP_LEN));
		}
	}
	return Object.fromEntries([...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function normalizeN(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return 1;
	return Math.min(MAX_N, Math.max(1, Math.round(v)));
}

/** Validates one client event. Returns null when the event name is unusable; other bad fields are blanked. */
export async function normalize(input: unknown, ctx: NormCtx): Promise<TelemetryEvent | null> {
	if (!isRecord(input) || typeof input.event !== "string" || !EVENT_RE.test(input.event)) return null;
	return {
		event: input.event,
		uid: await ctx.uid(input.id),
		version: clean(input.version, VERSION_RE),
		os: clean(input.os, PLATFORM_RE, true),
		arch: clean(input.arch, PLATFORM_RE, true),
		country: ctx.country,
		ci: input.ci === true,
		source: ctx.source,
		props: normalizeProps(input.props),
		n: normalizeN(input.n),
	};
}

async function normalizeAll(inputs: unknown[], ctx: NormCtx): Promise<TelemetryEvent[]> {
	const events = await Promise.all(inputs.map((i) => normalize(i, ctx)));
	return events.filter((e): e is TelemetryEvent => e !== null);
}

/** Identical events (everything but n) become one data point with summed n. Fewer points, same counts. */
export function merge(events: TelemetryEvent[]): TelemetryEvent[] {
	const byKey = new Map<string, TelemetryEvent>();
	for (const e of events) {
		const { n, ...rest } = e;
		const key = JSON.stringify(rest);
		const hit = byKey.get(key);
		if (hit) hit.n += n;
		else byKey.set(key, { ...e });
	}
	return [...byKey.values()];
}

/**
 * Reads a body without ever buffering more than `max` bytes. Null means over the limit.
 * Content-Length is only a fast path; the byte count is what is enforced.
 */
async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number, declared?: string | null) {
	if (declared && Number(declared) > max) {
		await stream?.cancel();
		return null;
	}
	if (!stream) return new Uint8Array();
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

/** Undefined means unparseable; JSON itself can never produce undefined. */
function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
}

export const ADMIN_TOKEN_HEADER = "x-telemetry-admin-token";

/** 404 for invalid or reserved slugs, then the per-IP limit. `known` is answered from isolate memory. */
async function gate(c: Ctx, project: string): Promise<Response | { known: boolean }> {
	if (!isValidSlug(project)) return c.json({ error: "invalid or reserved project slug" }, 404);
	const known = await projectExists(c.env.DB, project);
	const limit = checkIp(clientIp(c));
	if (limit.ok) return { known };
	return c.json({ error: "rate limit exceeded, slow down" }, 429, { "retry-after": String(limit.retryAfter) });
}

/** Creates an unknown project once its events are valid. The token goes in a header too, since an OTLP body must stay OTLP. */
async function createIfNew(c: Ctx, project: string, known: boolean): Promise<CreatedProject | Response | null> {
	if (known) return null;
	const created = await autoCreate(c, project);
	if (created && !(created instanceof Response)) {
		c.header(ADMIN_TOKEN_HEADER, created.admin_token);
		c.header("cache-control", "no-store");
	}
	return created;
}

/** `POST /<project>`: native JSON ingest. A known project costs no D1 call after the first warm-up. */
export async function handleIngest(c: Ctx, project: string): Promise<Response> {
	const gated = await gate(c, project);
	if (gated instanceof Response) return gated;

	const req = c.req.raw;
	const bytes = await readCapped(req.body, MAX_BODY_BYTES, req.headers.get("content-length"));
	if (!bytes) return c.json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413);

	const body = parseJson(bytes);
	if (!Array.isArray(body) && !isRecord(body)) {
		return c.json({ error: "body must be a JSON event object or an array of event objects" }, 400);
	}
	const items: unknown[] = Array.isArray(body) ? body : [body];
	if (items.length > MAX_BATCH) return c.json({ error: `at most ${MAX_BATCH} events per request` }, 400);

	const events = await normalizeAll(items, makeCtx(c, project, "native"));
	if (events.length === 0) {
		return c.json({ error: 'no valid events: "event" is required and must match [A-Za-z0-9_.:/-]{1,64}' }, 400);
	}
	const created = await createIfNew(c, project, gated.known);
	if (created instanceof Response) return created;
	const points = merge(events);
	if (!reserve(project, points.length)) return c.json({ error: "daily limit reached for this project" }, 429);

	writeEvents(c.env.EVENTS, project, points);
	const result = { accepted: points.length, dropped: items.length - events.length };
	return c.json(created ? { ...result, project: created } : result, 202);
}

const OTLP_JSON_HINT = { hint: "set OTEL_EXPORTER_OTLP_PROTOCOL=http/json" };

/** gzip body → bytes, or null when it inflates past `max` (zip bomb guard). */
async function gunzip(raw: Uint8Array, max: number): Promise<Uint8Array | null> {
	const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
	return readCapped(stream, max);
}

/** `POST /<project>/v1/{logs,traces,metrics}`: OTLP/HTTP JSON. */
export async function handleOtlp(c: Ctx, project: string, signal: "logs" | "traces" | "metrics"): Promise<Response> {
	const gated = await gate(c, project);
	if (gated instanceof Response) return gated;

	const req = c.req.raw;
	if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
		return c.json({ error: "only OTLP/HTTP JSON is supported", ...OTLP_JSON_HINT }, 415);
	}
	const encoding = (req.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
	if (encoding !== "gzip" && encoding !== "identity") {
		return c.json({ error: `unsupported content-encoding: ${encoding}`, hint: "use gzip or no compression" }, 415);
	}

	let bytes: Uint8Array | null = await readCapped(req.body, OTLP_RAW_MAX, req.headers.get("content-length"));
	if (!bytes) return c.json({ error: `body exceeds ${OTLP_RAW_MAX} bytes` }, 413);
	if (encoding === "gzip") {
		try {
			bytes = await gunzip(bytes, OTLP_MAX);
		} catch {
			return c.json({ error: "body is not valid gzip" }, 400);
		}
		if (!bytes) return c.json({ error: `decompressed body exceeds ${OTLP_MAX} bytes` }, 413);
	}

	const body = parseJson(bytes);
	if (!isRecord(body)) return c.json({ error: "body must be an OTLP JSON object", ...OTLP_JSON_HINT }, 400);

	const { inputs, total } = parseOtlp(signal, body);
	const events = await normalizeAll(inputs, makeCtx(c, project, "otlp"));
	const merged = merge(events);
	const points = merged.slice(0, OTLP_MAX_POINTS);
	// Excess is counted in merged points, so this is approximate when several records merged into one.
	const rejected = total - events.length + (merged.length - points.length);

	if (!gated.known && points.length === 0) {
		return c.json({ error: "no valid records, so the project was not created", ...OTLP_JSON_HINT }, 400);
	}
	const created = await createIfNew(c, project, gated.known);
	if (created instanceof Response) return created;
	if (!reserve(project, points.length)) return c.json({ error: "daily limit reached for this project" }, 429);
	writeEvents(c.env.EVENTS, project, points);

	if (rejected === 0) return c.json({});
	const errorMessage = `${rejected} rejected: invalid event name, empty metric, or over ${OTLP_MAX_POINTS} points per request`;
	return c.json({ partialSuccess: { [OTLP_REJECTED_KEY[signal]]: rejected, errorMessage } });
}
