import { expect, test } from "bun:test";
import { app } from "../src/index.ts";
import { TOP_N } from "../src/types.ts";
import { addDays, sha256hex, utcDay } from "../src/util.ts";
import { call, makeEnv, type TestEnv } from "./fakes.ts";

const json = (body: unknown, init: RequestInit & { ip?: string } = {}) => ({
	method: "POST",
	body: JSON.stringify(body),
	...init,
});
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function create(t: TestEnv, slug: string, ip?: string) {
	const res = await call(app, t.env, "/api/projects", json({ slug, name: slug }, { ip }));
	return { res, body: (await res.json()) as Record<string, string> };
}

async function createWithToken(t: TestEnv, slug = "demo") {
	const { body } = await create(t, slug);
	return body.admin_token as string;
}

const daily = (t: TestEnv, project = "demo") =>
	t.db.sqlite.query("SELECT * FROM daily WHERE project = ? ORDER BY day").all(project) as Record<string, unknown>[];

test("create returns the admin token once and only its hash is stored, so a DB leak cannot hijack projects", async () => {
	const t = makeEnv();
	const { res, body } = await create(t, "demo");
	expect(res.status).toBe(201);
	expect(body.admin_token).toMatch(/^tk_[0-9a-f]{48}$/);
	expect(body.otlp_endpoint).toBe("https://telemetry.test/demo");
	expect(body.install_md).toBe("https://telemetry.test/demo/install.md");
	expect(body.stats_url).toBe("https://telemetry.test/api/demo/stats");

	const rows = t.db.sqlite.query("SELECT * FROM projects").all() as { admin_hash: string }[];
	expect(JSON.stringify(rows)).not.toContain(body.admin_token as string);
	expect(rows[0]?.admin_hash).toBe(await sha256hex(body.admin_token as string));
});

test("a created project shows up in the public list without leaking secrets", async () => {
	const t = makeEnv();
	await create(t, "demo");
	const list = (await (await call(app, t.env, "/api/projects")).json()) as { projects: Record<string, unknown>[] };
	expect(list.projects.map((p) => p.slug)).toEqual(["demo"]);
	expect(Object.keys(list.projects[0] as object)).not.toContain("admin_hash");
	expect(Object.keys(list.projects[0] as object)).not.toContain("creator");
});

test("duplicate slugs get 409 so nobody can take over an existing project", async () => {
	const t = makeEnv();
	await create(t, "demo");
	const { res } = await create(t, "demo");
	expect(res.status).toBe(409);
});

test.each([
	["reserved slug", { slug: "api" }],
	["too short slug", { slug: "a" }],
	["uppercase slug", { slug: "Demo" }],
	["missing slug", {}],
	["name over 60 chars", { slug: "demo", name: "x".repeat(61) }],
	["description over 200 chars", { slug: "demo", description: "x".repeat(201) }],
	["javascript: homepage", { slug: "demo", homepage: "javascript:alert(1)" }],
	["non-url homepage", { slug: "demo", homepage: "not a url" }],
])("create rejects %s with 400", async (_name, body) => {
	const t = makeEnv();
	const res = await call(app, t.env, "/api/projects", json(body));
	expect(res.status).toBe(400);
	expect(t.db.sqlite.query("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
});

test("create rejects a body that is not a JSON object", async () => {
	const t = makeEnv();
	expect((await call(app, t.env, "/api/projects", { method: "POST", body: "nope" })).status).toBe(400);
	expect((await call(app, t.env, "/api/projects", json([1]))).status).toBe(400);
});

test("the 6th create in a day from one IP is refused, but another IP is not affected", async () => {
	const t = makeEnv();
	for (let i = 0; i < 5; i++) expect((await create(t, `proj-${i}`, "198.51.100.1")).res.status).toBe(201);
	expect((await create(t, "proj-5", "198.51.100.1")).res.status).toBe(429);
	expect((await create(t, "proj-5", "198.51.100.2")).res.status).toBe(201);
});

test("the creator column holds a salted hash, never the raw IP", async () => {
	const t = makeEnv();
	await create(t, "demo", "198.51.100.1");
	const row = t.db.sqlite.query("SELECT creator FROM projects").get() as { creator: string };
	expect(row.creator).toMatch(/^[0-9a-f]{16}$/);
});

test("delete needs the right token: 404 for unknown projects, 401 for missing or wrong tokens", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	expect((await call(app, t.env, "/api/ghost", { method: "DELETE", ...auth(token) })).status).toBe(404);
	expect((await call(app, t.env, "/api/demo", { method: "DELETE" })).status).toBe(401);
	expect((await call(app, t.env, "/api/demo", { method: "DELETE", ...auth("tk_wrong") })).status).toBe(401);
	expect((await call(app, t.env, "/api/projects")).status).toBe(200);
	expect(t.db.sqlite.query("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 1 });
});

test("a token for one project cannot delete another", async () => {
	const t = makeEnv();
	const tokenA = await createWithToken(t, "aaa");
	await createWithToken(t, "bbb");
	expect((await call(app, t.env, "/api/bbb", { method: "DELETE", ...auth(tokenA) })).status).toBe(401);
});

test("delete removes the project and its rollups so the slug can be reused", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	t.db.sqlite.run("INSERT INTO daily VALUES ('demo', '2026-01-01', 1, 1, 1, 1, '{}', 'ae')");
	const res = await call(app, t.env, "/api/demo", { method: "DELETE", ...auth(token) });
	expect(res.status).toBe(200);
	expect(((await res.json()) as { deleted: boolean }).deleted).toBe(true);
	expect(daily(t)).toEqual([]);
	expect((await create(t, "demo")).res.status).toBe(201);
});

const day = (ago: number) => addDays(utcDay(), -ago);
const row = (d: string, dau = 1, dims: unknown = {}) => ({ day: d, dau, wau: dau, mau: dau, events: dau * 2, dims });
const importRows = (t: TestEnv, token: string, rows: unknown[]) =>
	call(app, t.env, "/api/demo/import", json({ rows }, auth(token)));

test("import never overwrites a day rolled up from live data, but refreshes an earlier import", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	t.db.sqlite.run(`INSERT INTO daily VALUES ('demo', '${day(3)}', 10, 10, 10, 10, '{}', 'ae')`);
	t.db.sqlite.run(`INSERT INTO daily VALUES ('demo', '${day(2)}', 5, 5, 5, 5, '{}', 'import')`);

	const res = await importRows(t, token, [row(day(3), 99), row(day(2), 99), row(day(1), 99)]);
	expect(await res.json()).toEqual({ imported: 2, skipped: 1 });

	const byDay = Object.fromEntries(daily(t).map((r) => [r.day, r]));
	expect(byDay[day(3)]).toMatchObject({ dau: 10, source: "ae" });
	expect(byDay[day(2)]).toMatchObject({ dau: 99, source: "import" });
	expect(byDay[day(1)]).toMatchObject({ dau: 99, source: "import" });
});

test("import needs the admin token", async () => {
	const t = makeEnv();
	await createWithToken(t);
	expect((await importRows(t, "tk_wrong", [row(day(1))])).status).toBe(401);
	expect((await call(app, t.env, "/api/demo/import", json({ rows: [row(day(1))] }))).status).toBe(401);
	expect((await call(app, t.env, "/api/ghost/import", json({ rows: [] }, auth("tk_x")))).status).toBe(404);
	expect(daily(t)).toEqual([]);
});

test.each([
	["a day in the future", [row(addDays(utcDay(), 1))]],
	["an impossible calendar day", [row("2026-02-30")]],
	["a malformed day", [row("yesterday")]],
	["a negative count", [{ ...row(day(1)), dau: -1 }]],
	["a fractional count", [{ ...row(day(1)), events: 1.5 }]],
	["a string count", [{ ...row(day(1)), mau: "3" }]],
	["dims that are an array", [row(day(1), 1, [])]],
	["dims values that are not [users, events]", [row(day(1), 1, { event: { run: 3 } })]],
	["negative dims counts", [row(day(1), 1, { event: { run: [1, -1] } })]],
	["dims over 16KB", [row(day(1), 1, { event: { ["x".repeat(17_000)]: [1, 1] } })]],
	["the same day twice", [row(day(1)), row(day(1))]],
	["no rows", []],
	["more than 360 rows", Array.from({ length: 361 }, (_, i) => row(day(i + 1)))],
])("import rejects %s with 400 and writes nothing", async (_name, rows) => {
	const t = makeEnv();
	const token = await createWithToken(t);
	const res = await importRows(t, token, rows);
	expect(res.status).toBe(400);
	expect(daily(t)).toEqual([]);
});

test("one bad row rejects the whole import, so a retry cannot half-apply", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	const res = await importRows(t, token, [row(day(2)), { ...row(day(1)), dau: -1 }]);
	expect(res.status).toBe(400);
	expect(daily(t)).toEqual([]);
});

test("import keeps only the top values per dim by events, so rows stay small", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	const values = Object.fromEntries(Array.from({ length: TOP_N + 10 }, (_, i) => [`v${i}`, [1, i]]));
	await importRows(t, token, [row(day(1), 1, { version: values })]);
	const stored = JSON.parse(daily(t)[0]?.dims as string) as { version: Record<string, number[]> };
	expect(Object.keys(stored.version)).toHaveLength(TOP_N);
	expect(stored.version.v29).toEqual([1, 29]);
	expect(stored.version.v0).toBeUndefined();
});

test("a full 360-row import stays within D1's 50 queries per invocation", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	t.db.resetCounters();
	const rows = Array.from({ length: 360 }, (_, i) => row(day(i + 1)));
	const res = await importRows(t, token, rows);
	expect(await res.json()).toEqual({ imported: 360, skipped: 0 });
	expect(t.db.reads + t.db.writes).toBeLessThan(40);
});

const rollupCall = (t: TestEnv, token: string | undefined, query = "") =>
	call(app, t.env, `/api/demo/rollup${query}`, { method: "POST", ...(token ? auth(token) : {}) });

test("rollup needs the admin token", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	expect((await rollupCall(t, undefined)).status).toBe(401);
	expect((await rollupCall(t, "tk_wrong")).status).toBe(401);
	expect((await call(app, t.env, "/api/ghost/rollup", { method: "POST", ...auth(token) })).status).toBe(404);
	expect(t.analytics.queries).toEqual([]);
});

test.each([
	["a malformed day", "2026-13-40"],
	["today, whose events are still arriving", utcDay()],
	["a future day", addDays(utcDay(), 3)],
	["a day older than AE retention", addDays(utcDay(), -90)],
])("rollup refuses %s", async (_name, d) => {
	const t = makeEnv();
	const token = await createWithToken(t);
	expect((await rollupCall(t, token, `?day=${d}`)).status).toBe(400);
	expect(t.analytics.queries).toEqual([]);
});

test("rollup defaults to yesterday and only queries the project it was asked for", async () => {
	const t = makeEnv((q) => (q.includes("AS v") ? [] : [{ p: "demo", users: 2, events: 3 }]));
	const token = await createWithToken(t);
	const res = await rollupCall(t, token);
	expect(await res.json()).toEqual({ projects: 1 });
	expect(t.analytics.queries.every((q) => q.includes("index1 = 'demo'"))).toBe(true);
	expect(t.analytics.queries[0]).toContain(`timestamp >= '${day(1)}T00:00:00Z'`);
	expect(daily(t)).toHaveLength(1);
});

test("rollup accepts the oldest day AE still holds", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	expect((await rollupCall(t, token, `?day=${day(89)}`)).status).toBe(200);
});
