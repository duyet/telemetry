import type { EventInput } from "./types.ts";

export const EVENT_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;

type Json = Record<string, unknown>;
type Prim = string | number | boolean;

const ID_KEYS = ["service.instance.id", "host.id", "user.id", "anonymous.id"];
// Mapped to first-class fields (or useless as a prop), so they stay out of props.
const MAPPED_KEYS = new Set([...ID_KEYS, "service.name", "service.version", "os.type", "host.arch", "ci", "event.name"]);

// Resource attributes carry host and user identity, so only these low-cardinality ones become props.
const RESOURCE_PROPS = new Set([
	"deployment.environment",
	"deployment.environment.name",
	"service.namespace",
	"telemetry.sdk.language",
	"telemetry.sdk.name",
	"telemetry.sdk.version",
	"process.runtime.name",
	"process.runtime.version",
	"os.version",
]);

// Record attributes are app-defined, so keep them unless the key looks identifying. `ip` only matches a whole segment.
const IDENTIFYING = {
	prefixes: [
		"user.", "enduser.", "client.", "server.", "source.", "destination.", "host.", "net.", "network.", "process.",
		"url.", "http.url", "http.target", "http.client_ip", "db.statement", "db.query", "exception.", "code.", "file.",
		"thread.", "k8s.", "container.", "cloud.",
	],
	pattern: /email|password|token|secret|path|cookie|auth|session|(?:^|\.)ip(?:\.|$)|_ip$/,
};

const isIdentifying = (key: string): boolean => {
	const k = key.toLowerCase();
	return IDENTIFYING.prefixes.some((p) => k.startsWith(p)) || IDENTIFYING.pattern.test(k);
};

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Decodes an OTLP JSON AnyValue. Arrays and maps become JSON strings. */
function anyValue(v: unknown): Prim | undefined {
	const a = obj(v);
	if (typeof a.stringValue === "string") return a.stringValue;
	if (typeof a.boolValue === "boolean") return a.boolValue;
	if ("intValue" in a) return Number.isFinite(Number(a.intValue)) ? Number(a.intValue) : undefined;
	if (typeof a.doubleValue === "number") return a.doubleValue;
	if ("arrayValue" in a) return JSON.stringify(list(obj(a.arrayValue).values).map(anyValue));
	if ("kvlistValue" in a) {
		const kvs = list(obj(a.kvlistValue).values).map((kv) => [String(kv.key), anyValue(kv.value)]);
		return JSON.stringify(Object.fromEntries(kvs));
	}
	return undefined;
}

/** KeyValue[] → map, first occurrence of a key wins. */
function attrs(v: unknown): Map<string, Prim> {
	const m = new Map<string, Prim>();
	for (const kv of list(v)) {
		const val = anyValue(kv.value);
		if (typeof kv.key === "string" && val !== undefined && !m.has(kv.key)) m.set(kv.key, val);
	}
	return m;
}

const str = (v: Prim | undefined): string | undefined => (v === undefined ? undefined : String(v));
const truthy = (v: Prim | undefined): boolean => v === true || v === 1 || v === "true" || v === "1";

/**
 * Record attributes win over resource attributes, and come first so they survive the props cap.
 * Both maps feed the mapped fields, but only non-identifying keys reach props.
 */
function toInput(event: string, own: Map<string, Prim>, resource: Map<string, Prim>, n?: number): EventInput {
	const all = new Map(own);
	for (const [k, v] of resource) if (!all.has(k)) all.set(k, v);
	const id = ID_KEYS.map((k) => all.get(k)).find((v) => v !== undefined && v !== "");
	const props = new Map([...own].filter(([k]) => !MAPPED_KEYS.has(k) && !isIdentifying(k)));
	for (const [k, v] of resource) if (RESOURCE_PROPS.has(k) && !props.has(k)) props.set(k, v);
	return {
		event,
		id: str(id),
		version: str(all.get("service.version")),
		os: str(all.get("os.type")),
		arch: str(all.get("host.arch")),
		ci: truthy(all.get("ci")),
		props: Object.fromEntries(props),
		n,
	};
}

function logInput(rec: Json, resource: Map<string, Prim>): EventInput {
	const own = attrs(rec.attributes);
	const named = own.get("event.name");
	const body = obj(rec.body).stringValue;
	const event =
		typeof named === "string" ? named : typeof body === "string" && EVENT_RE.test(body) ? body : "log";
	return toInput(event, own, resource);
}

function spanInput(rec: Json, resource: Map<string, Prim>): EventInput {
	return toInput(String(rec.name ?? ""), attrs(rec.attributes), resource);
}

const DELTA = new Set<unknown>([1, "AGGREGATION_TEMPORALITY_DELTA"]);

function metricCount(m: Json): number {
	if (m.sum) {
		const sum = obj(m.sum);
		const points = list(sum.dataPoints);
		// A cumulative value is a running total re-sent on every export, so summing it would overcount; count exports instead.
		if (!DELTA.has(sum.aggregationTemporality)) return points.length;
		const total = points.reduce((s, p) => s + num(p.asInt ?? p.asDouble), 0);
		return points.length ? Math.max(1, Math.round(total)) : 0;
	}
	if (m.gauge) return list(obj(m.gauge).dataPoints).length;
	const hist = m.histogram ?? m.exponentialHistogram;
	return hist ? list(obj(hist).dataPoints).reduce((s, p) => s + num(p.count), 0) : 0;
}

function metricInput(m: Json, resource: Map<string, Prim>): EventInput | undefined {
	const n = metricCount(m);
	return n > 0 ? toInput(String(m.name ?? ""), new Map(), resource, n) : undefined;
}

const SHAPES = {
	logs: { resource: "resourceLogs", scope: "scopeLogs", record: "logRecords", map: logInput },
	traces: { resource: "resourceSpans", scope: "scopeSpans", record: "spans", map: spanInput },
	metrics: { resource: "resourceMetrics", scope: "scopeMetrics", record: "metrics", map: metricInput },
} as const;

/**
 * OTLP/HTTP JSON → native event inputs. `total` counts every record, span or metric seen,
 * including ones that produced no input, so callers can report how many were rejected.
 */
export function parseOtlp(
	signal: "logs" | "traces" | "metrics",
	body: unknown,
): { inputs: EventInput[]; total: number } {
	const shape = SHAPES[signal];
	const inputs: EventInput[] = [];
	let total = 0;
	for (const rs of list(obj(body)[shape.resource])) {
		const resource = attrs(obj(rs.resource).attributes);
		for (const scope of list(rs[shape.scope])) {
			for (const rec of list(scope[shape.record])) {
				total++;
				const input = shape.map(rec, resource);
				if (input) inputs.push(input);
			}
		}
	}
	return { inputs, total };
}
