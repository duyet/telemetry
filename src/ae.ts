import { MAX_PROPS, type TelemetryEvent } from "./types.ts";

/** Analytics Engine dataset name; must match cloudflare.config.ts. */
export const DATASET = "telemetry_events";
/** Table reference used in AE SQL FROM clauses. May change after the binding spike. */
export const TABLE = DATASET;

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
