import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ensureReady } from "../src/db.ts";
import { getStats, parseDays, resetStatsCache } from "../src/stats.ts";
import { TOP_N } from "../src/types.ts";
import { addDays, utcDay } from "../src/util.ts";
import { makeEnv, type TestEnv } from "./fakes.ts";

const day = (ago: number) => addDays(utcDay(), -ago);

beforeEach(resetStatsCache);

async function setup(handler?: (q: string) => Record<string, unknown>[]): Promise<TestEnv> {
	const t = makeEnv(handler);
	await ensureReady(t.env.DB);
	return t;
}

function seed(t: TestEnv, ago: number, dau: number, events: number, dims: unknown = {}, project = "demo") {
	t.db.sqlite
		.query("INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?, 'ae')")
		.run(project, day(ago), dau, dau * 2, dau * 3, events, JSON.stringify(dims));
}

test("parseDays only accepts the supported ranges", () => {
	expect([parseDays("7"), parseDays("365"), parseDays("8"), parseDays(undefined)]).toEqual([7, 365, 30, 30]);
});

test("the series has one entry per day ending yesterday, with zeros for days nothing was rolled up", async () => {
	const t = await setup();
	seed(t, 1, 4, 10);
	seed(t, 5, 2, 6);
	const { series } = await getStats(t.env, "demo", 7);
	expect(series).toHaveLength(7);
	expect(series.map((s) => s.day)).toEqual([7, 6, 5, 4, 3, 2, 1].map(day));
	expect(series.map((s) => s.dau)).toEqual([0, 0, 2, 0, 0, 0, 4]);
	expect(series.map((s) => s.events)).toEqual([0, 0, 6, 0, 0, 0, 10]);
});

test("rows outside the range and other projects' rows are not counted", async () => {
	const t = await setup();
	seed(t, 1, 1, 1);
	seed(t, 20, 50, 50);
	seed(t, 1, 70, 70, {}, "other");
	const s = await getStats(t.env, "demo", 7);
	expect(s.summary.events).toBe(1);
});

test("DAU, WAU and MAU come from yesterday's row, since summing them over days would double count users", async () => {
	const t = await setup();
	seed(t, 2, 10, 100);
	seed(t, 1, 4, 40);
	const { summary } = await getStats(t.env, "demo", 7);
	expect(summary).toMatchObject({ dau: 4, wau: 8, mau: 12, events: 140 });
});

test("the summary is zero when the latest row is older than yesterday, so a dead project does not look active", async () => {
	const t = await setup();
	seed(t, 3, 10, 100);
	seed(t, 2, 4, 40);
	const { summary, series } = await getStats(t.env, "demo", 7);
	expect(summary).toMatchObject({ dau: 0, wau: 0, mau: 0, events: 140 });
	expect(series.map((s) => s.dau)).toEqual([0, 0, 0, 0, 10, 4, 0]);
	expect(series.map((s) => s.events)).toEqual([0, 0, 0, 0, 100, 40, 0]);
});

test("an empty project reports zeros instead of failing", async () => {
	const t = await setup();
	const s = await getStats(t.env, "demo", 30);
	expect(s.summary).toEqual({ dau: 0, wau: 0, mau: 0, events: 0, today: { users: 0, events: 0 } });
	expect(s.dims).toEqual({});
	expect(s.series).toHaveLength(30);
});

test("dims are summed over the range, with users becoming user-days", async () => {
	const t = await setup();
	seed(t, 2, 1, 1, { event: { run: [2, 5], build: [1, 1] }, "prop:command": { hosts: [1, 3] } });
	seed(t, 1, 1, 1, { event: { run: [3, 4] }, version: { "1.0.0": [3, 4] } });
	const { dims } = await getStats(t.env, "demo", 7);
	expect(dims.event).toEqual({ run: [5, 9], build: [1, 1] });
	expect(dims["prop:command"]).toEqual({ hosts: [1, 3] });
	expect(dims.version).toEqual({ "1.0.0": [3, 4] });
});

test("summed dims keep only the top values by events", async () => {
	const t = await setup();
	for (let d = 1; d <= 3; d++) {
		const values = Object.fromEntries(Array.from({ length: TOP_N }, (_, i) => [`d${d}v${i}`, [1, i + d]]));
		seed(t, d, 1, 1, { version: values });
	}
	const { dims } = await getStats(t.env, "demo", 7);
	expect(Object.keys(dims.version ?? {})).toHaveLength(TOP_N);
});

test("today comes from one live AE query filtered to the project", async () => {
	const t = await setup(() => [{ users: "3", events: "8" }]);
	const { summary } = await getStats(t.env, "demo", 7);
	expect(summary.today).toEqual({ users: 3, events: 8 });
	expect(t.analytics.queries).toHaveLength(1);
	expect(t.analytics.queries[0]).toContain("index1 = 'demo'");
	expect(t.analytics.queries[0]).toContain(`toDateTime('${utcDay()} 00:00:00')`);
});

test("stats still render from D1 when Analytics Engine fails, because a broken AE must not take the page down", async () => {
	const err = spyOn(console, "error").mockImplementation(() => {});
	const t = await setup(() => {
		throw new Error("AE down");
	});
	seed(t, 1, 4, 10);
	const s = await getStats(t.env, "demo", 7);
	expect(s.summary).toMatchObject({ dau: 4, events: 10, today: { users: 0, events: 0 } });
	expect(err).toHaveBeenCalled();
	err.mockRestore();
});

test("a failed live query is retried on the next fresh read, not cached as zero", async () => {
	const err = spyOn(console, "error").mockImplementation(() => {});
	let fail = true;
	const t = await setup(() => {
		if (fail) throw new Error("AE down");
		return [{ users: 2, events: 2 }];
	});
	await getStats(t.env, "demo", 7);
	fail = false;
	const now = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(now + 61_000);
	expect((await getStats(t.env, "demo", 7)).summary.today).toEqual({ users: 2, events: 2 });
	clock.mockRestore();
	err.mockRestore();
});

test("repeat requests are served from memory with no D1 or AE reads", async () => {
	const t = await setup(() => [{ users: 1, events: 1 }]);
	seed(t, 1, 1, 1);
	const first = await getStats(t.env, "demo", 7);
	t.db.resetCounters();
	const queries = t.analytics.queries.length;
	for (let i = 0; i < 20; i++) expect(await getStats(t.env, "demo", 7)).toBe(first);
	expect(t.db.reads).toBe(0);
	expect(t.analytics.queries).toHaveLength(queries);
});

test("each (project, range) is cached on its own", async () => {
	const t = await setup();
	seed(t, 1, 1, 1);
	await getStats(t.env, "demo", 7);
	t.db.resetCounters();
	await getStats(t.env, "demo", 30);
	await getStats(t.env, "other", 7);
	expect(t.db.reads).toBe(2);
});

test("the live today count is reused for 5 minutes across ranges, so AE reads stay far below 10k a day", async () => {
	const t = await setup(() => [{ users: 1, events: 1 }]);
	const now = Date.now();
	let clock = spyOn(Date, "now").mockReturnValue(now);
	await getStats(t.env, "demo", 7);
	clock.mockRestore();

	clock = spyOn(Date, "now").mockReturnValue(now + 90_000);
	await getStats(t.env, "demo", 30);
	expect(t.analytics.queries).toHaveLength(1);
	clock.mockRestore();

	clock = spyOn(Date, "now").mockReturnValue(now + 5 * 60_000 + 1);
	await getStats(t.env, "demo", 7);
	expect(t.analytics.queries).toHaveLength(2);
	clock.mockRestore();
});

test("the whole result is refreshed from D1 after 60 seconds", async () => {
	const t = await setup();
	seed(t, 1, 1, 1);
	await getStats(t.env, "demo", 7);
	t.db.sqlite.run("UPDATE daily SET dau = 5");
	expect((await getStats(t.env, "demo", 7)).summary.dau).toBe(1);
	const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
	expect((await getStats(t.env, "demo", 7)).summary.dau).toBe(5);
	clock.mockRestore();
});

afterEach(() => {
	resetStatsCache();
});
