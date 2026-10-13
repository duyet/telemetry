import { expect, test } from "bun:test";
import { ensureReady } from "../src/db.ts";
import { runRollup } from "../src/rollup.ts";
import { TOP_N } from "../src/types.ts";
import { makeEnv, type TestEnv } from "./fakes.ts";

const DAY = "2026-10-10";
const WEEK_START = "2026-10-04";
const MONTH_START = "2026-09-11";

type Rows = Record<string, unknown>[];
interface Fixture {
	day?: Rows;
	week?: Rows;
	month?: Rows;
	byBlob?: Record<string, Rows>;
}

/**
 * Routes each rollup query to a fixture by its window start and the blob it groups on.
 * Windows nest, so a week or month left unset defaults to the narrower window's rows.
 */
function ae(f: Fixture) {
	const week = f.week ?? f.day ?? [];
	const month = f.month ?? week;
	return (q: string): Rows => {
		const blob = /(blob\d+) AS v/.exec(q)?.[1];
		if (blob) return f.byBlob?.[blob] ?? [];
		if (q.includes(`'${MONTH_START}T00:00:00Z'`)) return month;
		if (q.includes(`'${WEEK_START}T00:00:00Z'`)) return week;
		return f.day ?? [];
	};
}

async function setup(f: Fixture, slugs: string[], createdAt: Record<string, string> = {}): Promise<TestEnv> {
	const t = makeEnv(ae(f));
	await ensureReady(t.env.DB);
	for (const s of slugs) t.db.sqlite.run(`INSERT INTO projects (slug, admin_hash, created_at) VALUES ('${s}', 'x', '${createdAt[s] ?? "2026-01-01"}')`);
	t.db.resetCounters();
	return t;
}

type Stored = { project: string; day: string; dims: Record<string, Record<string, number[]>> };
const stored = (t: TestEnv): Stored[] =>
	(t.db.sqlite.query("SELECT * FROM daily ORDER BY project").all() as { dims: string }[]).map(
		(r) => ({ ...r, dims: JSON.parse(r.dims) }) as unknown as Stored,
	);

test("writes one row per active project with DAU, WAU, MAU and events from the right windows", async () => {
	const t = await setup(
		{
			day: [{ p: "a", users: 3, events: 10 }, { p: "b", users: 1, events: 1 }],
			week: [{ p: "a", users: 5, events: 0 }, { p: "b", users: 2, events: 0 }],
			month: [{ p: "a", users: 9, events: 0 }, { p: "b", users: 4, events: 0 }],
		},
		["a", "b", "idle"],
	);
	expect(await runRollup(t.env, DAY)).toEqual({ projects: 2 });
	expect(stored(t)).toMatchObject([
		{ project: "a", day: DAY, dau: 3, wau: 5, mau: 9, events: 10, source: "ae" },
		{ project: "b", day: DAY, dau: 1, wau: 2, mau: 4, events: 1, source: "ae" },
	]);
});

test("a project quiet on the day still gets a row with its WAU and MAU, so its trend does not drop out", async () => {
	const t = await setup(
		{
			day: [{ p: "busy", users: 2, events: 5 }],
			week: [{ p: "busy", users: 3, events: 0 }, { p: "quiet", users: 3, events: 0 }],
			month: [{ p: "busy", users: 4, events: 0 }, { p: "quiet", users: 6, events: 0 }],
		},
		["busy", "quiet", "dead"],
	);
	expect(await runRollup(t.env, DAY)).toEqual({ projects: 2 });
	expect(stored(t)).toMatchObject([
		{ project: "busy", day: DAY, dau: 2, wau: 3, mau: 4, events: 5 },
		{ project: "quiet", day: DAY, dau: 0, wau: 3, mau: 6, events: 0, source: "ae" },
	]);
});

test("a project only active earlier in the month has no WAU but keeps its MAU", async () => {
	const t = await setup({ day: [], week: [], month: [{ p: "a", users: 5, events: 0 }] }, ["a"]);
	await runRollup(t.env, DAY);
	expect(stored(t)).toMatchObject([{ project: "a", dau: 0, wau: 0, mau: 5, events: 0 }]);
});

test("AE rows for slugs that are not registered are ignored, so junk traffic cannot create D1 rows", async () => {
	const t = await setup(
		{
			day: [{ p: "a", users: 1, events: 1 }, { p: "ghost", users: 99, events: 99 }],
			month: [{ p: "a", users: 1, events: 0 }, { p: "ghost", users: 99, events: 0 }, { p: "ghost2", users: 5, events: 0 }],
		},
		["a"],
	);
	expect(await runRollup(t.env, DAY)).toEqual({ projects: 1 });
	expect(stored(t).map((r) => r.project)).toEqual(["a"]);
});

test("a day with no events writes nothing", async () => {
	const t = await setup({}, ["a"]);
	expect(await runRollup(t.env, DAY)).toEqual({ projects: 0 });
	expect(t.db.writes).toBe(0);
});

test("a prop key stored in different blob positions is merged into one dim, so prop order does not split counts", async () => {
	const t = await setup(
		{
			day: [{ p: "a", users: 3, events: 7 }],
			byBlob: {
				blob9: [
					{ p: "a", v: "command=run", users: 2, events: 5 },
					{ p: "a", v: "mode=fast", users: 1, events: 1 },
				],
				blob10: [
					{ p: "a", v: "command=run", users: 1, events: 2 },
					{ p: "a", v: "command=build", users: 1, events: 1 },
				],
			},
		},
		["a"],
	);
	await runRollup(t.env, DAY);
	const dims = stored(t)[0]?.dims;
	expect(dims["prop:command"]).toEqual({ run: [3, 7], build: [1, 1] });
	expect(dims["prop:mode"]).toEqual({ fast: [1, 1] });
});

test("a prop value containing '=' keeps everything after the first '='", async () => {
	const t = await setup(
		{ day: [{ p: "a", users: 1, events: 1 }], byBlob: { blob9: [{ p: "a", v: "expr=a=b", users: 1, events: 1 }] } },
		["a"],
	);
	await runRollup(t.env, DAY);
	expect(stored(t)[0]?.dims["prop:expr"]).toEqual({ "a=b": [1, 1] });
});

test("built-in dims come from their own blobs and empty values are dropped", async () => {
	const t = await setup(
		{
			day: [{ p: "a", users: 2, events: 4 }],
			byBlob: {
				blob1: [{ p: "a", v: "run", users: 2, events: 4 }],
				blob3: [{ p: "a", v: "1.2.3", users: 2, events: 4 }, { p: "a", v: "", users: 1, events: 1 }],
				blob6: [{ p: "a", v: "VN", users: 2, events: 4 }],
			},
		},
		["a"],
	);
	await runRollup(t.env, DAY);
	expect(stored(t)[0]?.dims).toEqual({ event: { run: [2, 4] }, version: { "1.2.3": [2, 4] }, country: { VN: [2, 4] } });
});

test("each dim keeps only its top values by events so the row stays small", async () => {
	const versions = Array.from({ length: TOP_N + 5 }, (_, i) => ({ p: "a", v: `v${i}`, users: 1, events: i }));
	const t = await setup({ day: [{ p: "a", users: 1, events: 1 }], byBlob: { blob3: versions } }, ["a"]);
	await runRollup(t.env, DAY);
	const kept = Object.keys(stored(t)[0]?.dims.version);
	expect(kept).toHaveLength(TOP_N);
	expect(kept).toContain(`v${TOP_N + 4}`);
	expect(kept).not.toContain("v0");
});

test("AE query count does not grow with projects, because the free plan allows only 10k reads a day", async () => {
	const few = await setup({}, ["a"]);
	await runRollup(few.env, DAY);
	const slugs = Array.from({ length: 30 }, (_, i) => `proj-${i}`);
	const many = await setup({ day: slugs.map((p) => ({ p, users: 1, events: 1 })) }, slugs);
	await runRollup(many.env, DAY);
	expect(many.analytics.queries.length).toBe(few.analytics.queries.length);
	expect(many.analytics.queries.length).toBeLessThanOrEqual(20);
});

test("30 projects are written in 3 multi-row statements, staying under D1's 100 bound parameters", async () => {
	const slugs = Array.from({ length: 30 }, (_, i) => `proj-${i}`);
	const t = await setup({ day: slugs.map((p) => ({ p, users: 1, events: 1 })) }, slugs);
	await runRollup(t.env, DAY);
	expect(t.db.writes).toBe(3);
	expect(stored(t)).toHaveLength(30);
	const inserts = t.db.log.filter((q) => /insert into daily/i.test(q));
	for (const q of inserts) expect((q.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
});

test("rerunning a day replaces its row instead of duplicating it", async () => {
	const t = await setup({ day: [{ p: "a", users: 1, events: 1 }] }, ["a"]);
	await runRollup(t.env, DAY);
	t.analytics.handler = ae({ day: [{ p: "a", users: 7, events: 9 }] });
	await runRollup(t.env, DAY);
	expect(stored(t)).toMatchObject([{ dau: 7, events: 9 }]);
});

test("live data wins over an import for the same day", async () => {
	const t = await setup({ day: [{ p: "a", users: 4, events: 4 }] }, ["a"]);
	t.db.sqlite.run(`INSERT INTO daily VALUES ('a', '${DAY}', 100, 100, 100, 100, '{}', 'import')`);
	await runRollup(t.env, DAY);
	expect(stored(t)).toMatchObject([{ dau: 4, source: "ae" }]);
});

test("with a project given, every query is filtered to it and others are untouched", async () => {
	const t = await setup({ day: [{ p: "a", users: 1, events: 1 }] }, ["a", "b"]);
	await runRollup(t.env, DAY, "a");
	expect(t.analytics.queries.every((q) => q.includes("index1 = 'a'"))).toBe(true);
	expect(stored(t).map((r) => r.project)).toEqual(["a"]);
});

test("re-registering a deleted slug does not inherit the previous owner's events: a project created inside the window is floored at created_at in every AE query", async () => {
	const t = await setup({ day: [{ p: "new", users: 1, events: 1 }] }, ["new", "old"], { new: "2026-10-09T17:13:05.123Z" });
	await runRollup(t.env, DAY);
	const floor =
		" AND (index1 NOT IN ('new') OR (index1 = 'new' AND toUnixTimestamp(timestamp) >= 1791565985))";
	expect(t.analytics.queries.length).toBeGreaterThan(0);
	expect(t.analytics.queries.every((q) => q.includes(floor))).toBe(true);
	expect(t.analytics.queries.some((q) => q.includes("'old'"))).toBe(false);
});

test("several projects created inside the window each get their own floor in one clause", async () => {
	const t = await setup({}, ["a", "b", "c"], { a: "2026-10-01T00:00:00.000Z", b: "2026-09-20T01:02:03.999Z" });
	await runRollup(t.env, DAY);
	const q = t.analytics.queries[0] ?? "";
	expect(q).toContain(
		" AND (index1 NOT IN ('a','b') OR (index1 = 'a' AND toUnixTimestamp(timestamp) >= 1790812800) OR (index1 = 'b' AND toUnixTimestamp(timestamp) >= 1789866123))",
	);
	expect(q).not.toContain("'c'");
});

test("a project created before the window gets no floor, so the SQL stays short however big the registry is", async () => {
	const t = await setup({}, ["a", "b"], { a: `${MONTH_START}T00:00:00.000Z`, b: "2025-01-01T00:00:00.000Z" });
	await runRollup(t.env, DAY);
	expect(t.analytics.queries.some((q) => q.includes("NOT IN"))).toBe(false);
});

test("the floor compares whole Unix seconds, since the binding rejects string timestamps inside OR", async () => {
	const t = await setup({}, ["a"], { a: "2026-10-13T17:13:05.123Z" });
	await runRollup(t.env, "2026-10-14");
	const stamps = t.analytics.queries.flatMap((q) =>
		[...q.matchAll(/index1 = 'a' AND toUnixTimestamp\(timestamp\) >= (\d+)\)/g)].map((m) => m[1]),
	);
	expect(stamps.length).toBeGreaterThan(0);
	for (const stamp of stamps) expect(stamp).toBe(String(Date.UTC(2026, 9, 13, 17, 13, 5) / 1000));
});

test("with a project given, the floor applies to that project alone", async () => {
	const t = await setup({}, ["a", "b"], { a: "2026-10-09T00:00:00.000Z", b: "2026-10-09T00:00:00.000Z" });
	await runRollup(t.env, DAY, "a");
	for (const q of t.analytics.queries) {
		expect(q).toContain("index1 = 'a' AND (index1 NOT IN ('a') OR (index1 = 'a' AND toUnixTimestamp(timestamp) >= 1791504000))");
		expect(q).not.toContain("'b'");
	}
});

test("the cron rollup defaults to yesterday UTC", async () => {
	const t = await setup({ day: [{ p: "a", users: 1, events: 1 }] }, ["a"]);
	await runRollup(t.env);
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	expect(stored(t)[0]?.day).toBe(yesterday);
});
