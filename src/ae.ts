import { MAX_PROPS, type TelemetryEvent } from "./types.ts";

/** Analytics Engine dataset name; must match cloudflare.config.ts. */
export const DATASET = "telemetry_events";
/**
 * AE SQL as the `analytics` binding speaks it (the unified SQL API, checked against production):
 * schema-qualified table, `"sampleInterval"` for sampling, ISO 8601 timestamps with a zone.
 */
export const TABLE = `events.analyticsEngine."${DATASET}"`;
export const USERS = "count(DISTINCT blob2)";
export const EVENTS = `sum("sampleInterval" * double1)`;

/**
 * Blob layout of one data point. index1 = project slug, double1 = n.
 * Props occupy blob9..blob16 as "key=value".
 */
export const BLOB = {
	event: "blob1",
	uid: "blob2",
	version: "blob3",
	os: "blob4",
	arch: "blob5",
	country: "blob6",
	ci: "blob7",
	source: "blob8",
} as const;
export const PROP_BLOBS = Array.from({ length: MAX_PROPS }, (_, i) => `blob${9 + i}`);

export function toDataPoint(project: string, e: TelemetryEvent): AnalyticsEngineDataPoint {
	const props = Object.entries(e.props)
		.slice(0, MAX_PROPS)
		.map(([k, v]) => `${k}=${v}`);
	return {
		indexes: [project],
		blobs: [e.event, e.uid, e.version, e.os, e.arch, e.country, e.ci ? "1" : "0", e.source, ...props],
		doubles: [e.n],
	};
}

export function writeEvents(ds: AnalyticsEngineDataset, project: string, events: TelemetryEvent[]): void {
	for (const e of events) ds.writeDataPoint(toDataPoint(project, e));
}

/** Run one AE SQL query through the `analytics` binding (no API token needed). */
export async function sql<T extends Record<string, unknown>>(
	binding: AnalyticsSQLBinding,
	query: string,
): Promise<T[]> {
	const res = await binding.query<T>({ query });
	return res.data;
}

/** Quote a string literal for AE SQL. Only for values already validated (slugs, days). */
export function lit(s: string): string {
	return `'${s.replaceAll("'", "''")}'`;
}

/** `timestamp` filter for [from, to) in UTC days; `to` omitted means open-ended. */
export function dayRange(from: string, to?: string): string {
	const start = `timestamp >= ${lit(`${from}T00:00:00Z`)}`;
	return to ? `${start} AND timestamp < ${lit(`${to}T00:00:00Z`)}` : start;
}

/** ISO 8601 with a zone at second precision, the form the unified SQL API takes for `timestamp`. */
export function aeTime(iso: string): string {
	return `${new Date(iso).toISOString().slice(0, 19)}Z`;
}

/**
 * Per-project lower bound on `timestamp`, as a clause to append to a WHERE. Projects not listed are unfiltered.
 * Slugs outlive their owners in AE (90 days), so a re-registered slug must not inherit the old events.
 */
export function sinceFloor(floors: { slug: string; since: string }[]): string {
	if (!floors.length) return "";
	const slugs = floors.map((f) => lit(f.slug)).join(",");
	// Inside OR the binding rejects string timestamps (type error) and CAST, so compare Unix seconds.
	const each = floors
		.map((f) => ` OR (index1 = ${lit(f.slug)} AND toUnixTimestamp(timestamp) >= ${Math.floor(Date.parse(f.since) / 1000)})`)
		.join("");
	return ` AND (index1 NOT IN (${slugs})${each})`;
}
