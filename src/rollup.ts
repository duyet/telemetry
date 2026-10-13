import { aeTime, BLOB, dayRange, EVENTS, lit, PROP_BLOBS, sinceFloor, sql, TABLE, USERS } from "./ae.ts";
import { type Bindings, type DailyRow, type Dims, TOP_N } from "./types.ts";
import { addDays, utcDay } from "./util.ts";

const DIM_BLOBS = Object.entries(BLOB).filter(([name]) => name !== "uid") as [string, string][];
/** D1 allows 100 bound parameters per statement; a row binds 7 (source is a literal). */
const ROWS_PER_STATEMENT = 14;

type AeRow = Record<string, unknown>;
type Totals = { dau: number; wau: number; mau: number; events: number };
type Acc = Totals & { dims: Dims };

/** Add one value's counts into `dims`, summing when the value is already there. */
export function addToDims(dims: Dims, dim: string, value: string, users: number, events: number): void {
	const values = (dims[dim] ??= {});
	const cur = (values[value] ??= [0, 0]);
	cur[0] += users;
	cur[1] += events;
}

/** Keep the TOP_N values per dim by events. */
export function topDims(dims: Dims): Dims {
	const out: Dims = {};
	for (const [dim, values] of Object.entries(dims)) {
		out[dim] = Object.fromEntries(Object.entries(values).sort((a, b) => b[1][1] - a[1][1]).slice(0, TOP_N));
	}
	return out;
}

function window(from: string, to: string, project: string | undefined, floor: string): string {
	const range = dayRange(from, to);
	return (project ? `${range} AND index1 = ${lit(project)}` : range) + floor;
}

/** Users and events per project over [from, to). */
function totals(env: Bindings, from: string, to: string, project: string | undefined, floor: string): Promise<AeRow[]> {
	return sql(
		env.ANALYTICS,
		`SELECT index1 AS p, ${USERS} AS users, ${EVENTS} AS events FROM ${TABLE} WHERE ${window(from, to, project, floor)} GROUP BY p`,
	);
}

/** Users and events per project and value of one blob over [from, to). */
function byBlob(
	env: Bindings,
	blob: string,
	from: string,
	to: string,
	project: string | undefined,
	floor: string,
): Promise<AeRow[]> {
	return sql(
		env.ANALYTICS,
		`SELECT index1 AS p, ${blob} AS v, ${USERS} AS users, ${EVENTS} AS events FROM ${TABLE} WHERE ${window(from, to, project, floor)} GROUP BY p, v`,
	);
}

/**
 * Multi-row upsert, 14 rows per statement to stay under D1's bound-parameter limit.
 * Imports only replace imports: days rolled up from live AE data are never overwritten.
 * Returns the number of rows written.
 */
export async function upsertDaily(
	db: D1Database,
	rows: Omit<DailyRow, "source">[],
	source: DailyRow["source"],
): Promise<number> {
	const guard = source === "import" ? " WHERE daily.source = 'import'" : "";
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
		const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
		const values = chunk.map(() => `(?, ?, ?, ?, ?, ?, ?, '${source}')`).join(", ");
		stmts.push(
			db
				.prepare(
					`INSERT INTO daily (project, day, dau, wau, mau, events, dims, source) VALUES ${values}
					ON CONFLICT(project, day) DO UPDATE SET dau = excluded.dau, wau = excluded.wau, mau = excluded.mau,
					events = excluded.events, dims = excluded.dims, source = excluded.source${guard}`,
				)
				.bind(...chunk.flatMap((r) => [r.project, r.day, r.dau, r.wau, r.mau, r.events, JSON.stringify(r.dims)])),
		);
	}
	if (!stmts.length) return 0;
	const results = await db.batch(stmts);
	return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/**
 * Cron: AE SQL → one `daily` row per active project for `day` (default yesterday UTC).
 * 18 AE queries however many projects there are; AE data for slugs not in `projects` is ignored.
 */
export async function runRollup(
	env: Bindings,
	day: string = addDays(utcDay(), -1),
	project?: string,
): Promise<{ projects: number }> {
	const next = addDays(day, 1);
	const known = project
		? env.DB.prepare("SELECT slug, created_at FROM projects WHERE slug = ?").bind(project)
		: env.DB.prepare("SELECT slug, created_at FROM projects");
	const { results: slugs } = await known.all<{ slug: string; created_at: string }>();

	// Only projects created inside the widest window need a floor, which keeps the SQL short for a big registry.
	const windowStart = `${addDays(day, -29)}T00:00:00Z`;
	const floors = slugs
		.map((r) => ({ slug: r.slug, since: aeTime(r.created_at) }))
		.filter((f) => f.since > windowStart);
	const floor = sinceFloor(floors);
	const [dayRows, weekRows, monthRows, dimRows, propRows] = await Promise.all([
		totals(env, day, next, project, floor),
		totals(env, addDays(day, -6), next, project, floor),
		totals(env, addDays(day, -29), next, project, floor),
		Promise.all(DIM_BLOBS.map(([, blob]) => byBlob(env, blob, day, next, project, floor))),
		Promise.all(PROP_BLOBS.map((blob) => byBlob(env, blob, day, next, project, floor))),
	]);

	const exists = new Set(slugs.map((r) => r.slug));
	const acc = new Map<string, Acc>();
	// Every project active in the 30-day window gets a row, so a quiet day still records its WAU/MAU.
	for (const r of monthRows) {
		const p = String(r.p);
		if (exists.has(p)) acc.set(p, { dau: 0, wau: 0, mau: Number(r.users), events: 0, dims: {} });
	}
	for (const r of weekRows) {
		const a = acc.get(String(r.p));
		if (a) a.wau = Number(r.users);
	}
	for (const r of dayRows) {
		const a = acc.get(String(r.p));
		if (a) {
			a.dau = Number(r.users);
			a.events = Number(r.events);
		}
	}
	DIM_BLOBS.forEach(([dim], i) => {
		for (const r of dimRows[i] ?? []) {
			const a = acc.get(String(r.p));
			const v = String(r.v);
			if (a && v) addToDims(a.dims, dim, v, Number(r.users), Number(r.events));
		}
	});
	for (const rows of propRows) {
		for (const r of rows) {
			const [key, ...rest] = String(r.v).split("=");
			const value = rest.join("=");
			const a = acc.get(String(r.p));
			if (a && key && value) addToDims(a.dims, `prop:${key}`, value, Number(r.users), Number(r.events));
		}
	}

	const out = [...acc].map(([p, a]) => ({ project: p, day, ...a, dims: topDims(a.dims) }));
	await upsertDaily(env.DB, out, "ae");
	return { projects: out.length };
}
