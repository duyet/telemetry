import type { Context } from "hono";

export interface Bindings {
	DB: D1Database;
	EVENTS: AnalyticsEngineDataset;
	ANALYTICS: AnalyticsSQLBinding;
}

export type App = { Bindings: Bindings };
export type Ctx = Context<App>;

/** One event as a client sends it to `POST /<project>`. */
export interface EventInput {
	event: string;
	/** Random install id persisted by the client. Never stored raw. */
	id?: string;
	version?: string;
	os?: string;
	arch?: string;
	ci?: boolean;
	props?: Record<string, string | number | boolean>;
	/** Occurrence count, default 1. */
	n?: number;
}

/** A validated, normalized event ready to become one AE data point. */
export interface TelemetryEvent {
	event: string;
	/** Hashed user id, 16 hex chars. */
	uid: string;
	version: string;
	os: string;
	arch: string;
	country: string;
	ci: boolean;
	source: "native" | "otlp";
	/** At most MAX_PROPS entries, keys and values at most MAX_PROP_LEN chars. */
	props: Record<string, string>;
	n: number;
}

export interface Project {
	slug: string;
	name: string | null;
	description: string | null;
	homepage: string | null;
	created_at: string;
}

/** A project as the public registry shows it: only projects with rolled-up data in the last 30 days. */
export interface RegistryEntry extends Project {
	/** Daily users for the last 30 closed UTC days, oldest first, zero-filled. */
	series: number[];
	/** Latest closed day's DAU, or 0. */
	dau: number;
}

/** Returned once, in the ingest response, when the first event auto-creates a project. */
export interface CreatedProject {
	slug: string;
	created: true;
	/** Shown once. Only its hash is stored. Needed to rename, rotate, import, or delete. */
	admin_token: string;
	page_url: string;
}

/** dim name → value → [users, events]. Dim names: event, version, os, arch, country, ci, source, prop:<key>. */
export type Dims = Record<string, Record<string, [users: number, events: number]>>;

/** One row of the `daily` table: everything kept long-term for a project-day. */
export interface DailyRow {
	project: string;
	day: string; // YYYY-MM-DD (UTC)
	dau: number;
	wau: number;
	mau: number;
	events: number;
	dims: Dims;
	source: "ae" | "import";
}

export interface Stats {
	project: string;
	days: number;
	generated_at: string;
	summary: {
		/** Latest closed day. */
		dau: number;
		wau: number;
		mau: number;
		/** Events summed over the range. */
		events: number;
		/** Live from AE, cached ~5 min. */
		today: { users: number; events: number };
	};
	series: { day: string; dau: number; events: number }[];
	/** Summed over the range: users are user-days, events are totals. Top 20 per dim. */
	dims: Dims;
}

export const MAX_BATCH = 25;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_PROPS = 8;
export const MAX_PROP_LEN = 64;
export const TOP_N = 20;
