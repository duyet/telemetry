import { lit, sql, TABLE } from "./ae.ts";
import { addToDims, topDims } from "./rollup.ts";
import type { Bindings, Dims, Stats } from "./types.ts";
import { addDays, utcDay } from "./util.ts";

export const DAY_RANGES = [7, 30, 90, 365] as const;

const STATS_TTL_MS = 60_000;
const TODAY_TTL_MS = 5 * 60_000;

type Today = Stats["summary"]["today"];

// Isolate memory, because the Cache API is a no-op on workers.dev.
const statsCache = new Map<string, { at: number; stats: Stats }>();
const todayCache = new Map<string, { at: number; today: Today }>();

export function parseDays(v: string | undefined): number {
	const n = Number(v);
	return (DAY_RANGES as readonly number[]).includes(n) ? n : 30;
}

/** Test hook: reset isolate caches. */
export function resetStatsCache(): void {
	statsCache.clear();
	todayCache.clear();
}

/** Live AE count for the current UTC day. Failures degrade to zeros so the page still renders. */
async function liveToday(env: Bindings, slug: string, today: string): Promise<Today> {
	const hit = todayCache.get(slug);
	if (hit && Date.now() - hit.at < TODAY_TTL_MS) return hit.today;
	try {
		const [row] = await sql(
			env.ANALYTICS,
			`SELECT count(DISTINCT blob2) AS users, sum(_sample_interval * double1) AS events FROM ${TABLE}
			WHERE index1 = ${lit(slug)} AND timestamp >= toDateTime(${lit(`${today} 00:00:00`)})`,
		);
		const live = { users: Number(row?.users ?? 0), events: Number(row?.events ?? 0) };
		todayCache.set(slug, { at: Date.now(), today: live });
		return live;
	} catch (err) {
		console.error("live today query failed", err);
		return { users: 0, events: 0 };
	}
}

interface DailyRead {
	day: string;
	dau: number;
	wau: number;
	mau: number;
	events: number;
	dims: string;
}

export async function getStats(env: Bindings, slug: string, days: number): Promise<Stats> {
	const key = `${slug}|${days}`;
	const hit = statsCache.get(key);
	if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.stats;

	const today = utcDay();
	const start = addDays(today, -days);
	const [{ results }, live] = await Promise.all([
		env.DB.prepare(
			"SELECT day, dau, wau, mau, events, dims FROM daily WHERE project = ? AND day >= ? AND day < ? ORDER BY day",
		)
			.bind(slug, start, today)
			.all<DailyRead>(),
		liveToday(env, slug, today),
	]);

	const byDay = new Map(results.map((r) => [r.day, r]));
	const series = Array.from({ length: days }, (_, i) => {
		const day = addDays(start, i);
		const r = byDay.get(day);
		return { day, dau: r?.dau ?? 0, events: r?.events ?? 0 };
	});

	const dims: Dims = {};
	let events = 0;
	for (const r of results) {
		events += r.events;
		for (const [dim, values] of Object.entries(JSON.parse(r.dims) as Dims)) {
			for (const [value, [users, n]] of Object.entries(values)) addToDims(dims, dim, value, users, n);
		}
	}
	// Summary describes yesterday; an older row would show a dead project as still active.
	const latest = results.at(-1)?.day === addDays(today, -1) ? results.at(-1) : undefined;

	const stats: Stats = {
		project: slug,
		days,
		generated_at: new Date().toISOString(),
		summary: { dau: latest?.dau ?? 0, wau: latest?.wau ?? 0, mau: latest?.mau ?? 0, events, today: live },
		series,
		dims: topDims(dims),
	};
	statsCache.set(key, { at: Date.now(), stats });
	return stats;
}
