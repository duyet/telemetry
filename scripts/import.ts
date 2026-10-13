/**
 * Turns raw NDJSON events into daily rollups and uploads them to a telemetry project.
 *
 *   bun scripts/import.ts events.ndjson --base https://telemetry.example.dev --project my-tool --dry-run
 *   cat events.ndjson | TELEMETRY_ADMIN_TOKEN=tk_... bun scripts/import.ts --base <url> --project my-tool
 *
 * Input, one JSON object per line: {day, id, event, n?, version?, os?, arch?, country?, props?}
 * Raw ids never leave this machine. Only the aggregates are posted to /api/<project>/import.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type DailyRow, type Dims, MAX_PROP_LEN, TOP_N } from "../src/types.ts";
import { addDays } from "../src/util.ts";

export interface RawRow {
	day: string;
	/** Install id. Empty or missing: the row adds events only, never users. */
	id?: string;
	event: string;
	n?: number;
	version?: string;
	os?: string;
	arch?: string;
	country?: string;
	props?: Record<string, string | number | boolean | null | undefined>;
}

export type Rollup = Omit<DailyRow, "project" | "source">;

/** Rows per POST. The API accepts up to 360. */
const CHUNK = 300;
const WEEK = 7;
const MONTH = 30;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROP_KEY_RE = /^[a-z0-9_.-]{1,32}$/;
const DIM_FIELDS = ["event", "version", "os", "arch", "country"] as const;

type DayAcc = { ids: Set<string>; events: number; dims: Map<string, Map<string, { users: Set<string>; events: number }>> };

function bump(acc: DayAcc, dim: string, value: string, id: string, n: number): void {
	let values = acc.dims.get(dim);
	if (!values) acc.dims.set(dim, (values = new Map()));
	let cell = values.get(value);
	if (!cell) values.set(value, (cell = { users: new Set(), events: 0 }));
	cell.events += n;
	if (id) cell.users.add(id);
}

/**
 * Exact daily rollups. For each day with rows:
 * dau = distinct ids that day; wau, mau = distinct ids over [day-6, day] and [day-29, day];
 * events = sum of n; dims[dim][value] = [distinct ids, events], top 20 by events.
 */
export function rollup(rows: RawRow[]): Rollup[] {
	const days = new Map<string, DayAcc>();
	for (const r of rows) {
		const n = r.n ?? 1;
		let acc = days.get(r.day);
		if (!acc) days.set(r.day, (acc = { ids: new Set(), events: 0, dims: new Map() }));
		const id = r.id ?? "";
		acc.events += n;
		if (id) acc.ids.add(id);
		for (const f of DIM_FIELDS) {
			const v = r[f];
			if (v) bump(acc, f, v, id, n);
		}
		for (const [k, v] of Object.entries(r.props ?? {})) {
			if (v === null || v === undefined || v === "") continue;
			bump(acc, `prop:${k}`, String(v).slice(0, MAX_PROP_LEN), id, n);
		}
	}
	if (days.size === 0) return [];

	// Slide a 7-day and a 30-day window over every calendar day, counting each id once per window.
	const sorted = [...days.keys()].sort();
	const week = new Map<string, number>();
	const month = new Map<string, number>();
	const add = (m: Map<string, number>, ids: Set<string>) => ids.forEach((id) => m.set(id, (m.get(id) ?? 0) + 1));
	const drop = (m: Map<string, number>, ids: Set<string>) =>
		ids.forEach((id) => {
			const left = (m.get(id) ?? 0) - 1;
			if (left > 0) m.set(id, left);
			else m.delete(id);
		});

	const out: Rollup[] = [];
	const last = sorted[sorted.length - 1] as string;
	for (let day = sorted[0] as string; day <= last; day = addDays(day, 1)) {
		const acc = days.get(day);
		if (acc) {
			add(week, acc.ids);
			add(month, acc.ids);
		}
		const leaving = (delta: number) => days.get(addDays(day, -delta))?.ids;
		const outOfWeek = leaving(WEEK);
		const outOfMonth = leaving(MONTH);
		if (outOfWeek) drop(week, outOfWeek);
		if (outOfMonth) drop(month, outOfMonth);
		if (!acc) continue;
		out.push({ day, dau: acc.ids.size, wau: week.size, mau: month.size, events: acc.events, dims: topDims(acc.dims) });
	}
	return out;
}

function topDims(dims: DayAcc["dims"]): Dims {
	const out: Dims = {};
	for (const [dim, values] of dims) {
		const top = [...values]
			.sort((a, b) => b[1].events - a[1].events || (a[0] < b[0] ? -1 : 1))
			.slice(0, TOP_N)
			.map(([value, c]): [string, [number, number]] => [value, [c.users.size, c.events]]);
		out[dim] = Object.fromEntries(top);
	}
	return out;
}

/** Parse NDJSON into rows. Fails loudly with the line number on a bad row. */
export function parseNdjson(text: string): RawRow[] {
	const rows: RawRow[] = [];
	text.split("\n").forEach((line, i) => {
		if (!line.trim()) return;
		const where = `line ${i + 1}`;
		let r: RawRow;
		try {
			r = JSON.parse(line) as RawRow;
		} catch {
			throw new Error(`${where}: not valid JSON`);
		}
		if (typeof r.day !== "string" || !DAY_RE.test(r.day)) throw new Error(`${where}: day must be YYYY-MM-DD`);
		if (typeof r.event !== "string" || !r.event) throw new Error(`${where}: event is required`);
		if (r.n !== undefined && (!Number.isInteger(r.n) || r.n < 1)) throw new Error(`${where}: n must be an integer >= 1`);
		for (const k of Object.keys(r.props ?? {})) {
			if (!PROP_KEY_RE.test(k)) throw new Error(`${where}: prop key "${k}" must match ${PROP_KEY_RE}`);
		}
		rows.push(r);
	});
	return rows;
}

export interface PostOptions {
	base: string;
	project: string;
	token: string;
	fetch?: typeof fetch;
}

/** POST rollups in chunks. Throws on the first non-2xx response. */
export async function postRollups(rollups: Rollup[], opts: PostOptions): Promise<{ imported: number; skipped: number }> {
	const send = opts.fetch ?? fetch;
	const url = `${opts.base.replace(/\/+$/, "")}/api/${opts.project}/import`;
	let imported = 0;
	let skipped = 0;
	for (let i = 0; i < rollups.length; i += CHUNK) {
		const res = await send(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
			body: JSON.stringify({ rows: rollups.slice(i, i + CHUNK) }),
		});
		if (!res.ok) throw new Error(`import failed: HTTP ${res.status} ${await res.text()}`);
		const body = (await res.json()) as { imported: number; skipped: number };
		imported += body.imported;
		skipped += body.skipped;
		console.error(`posted ${Math.min(i + CHUNK, rollups.length)}/${rollups.length} days`);
	}
	return { imported, skipped };
}

/** Print rollups as NDJSON on stdout and a short summary on stderr. */
export function printRollups(rollups: Rollup[]): void {
	for (const r of rollups) console.log(JSON.stringify(r));
	const events = rollups.reduce((n, r) => n + r.events, 0);
	console.error(`${rollups.length} days, ${events} events, ${rollups[0]?.day ?? "-"} .. ${rollups.at(-1)?.day ?? "-"}`);
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			base: { type: "string" },
			project: { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	const rollups = rollup(parseNdjson(readFileSync(positionals[0] ?? 0, "utf8")));
	if (values["dry-run"]) {
		printRollups(rollups);
	} else {
		const token = process.env.TELEMETRY_ADMIN_TOKEN;
		if (!values.base || !values.project || !token) {
			throw new Error("need --base, --project and env TELEMETRY_ADMIN_TOKEN (or pass --dry-run)");
		}
		const res = await postRollups(rollups, { base: values.base, project: values.project, token });
		console.error(`imported ${res.imported}, skipped ${res.skipped} (days already rolled up from live data)`);
	}
}
