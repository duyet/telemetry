import { beforeEach, expect, test } from "bun:test";
import { resetGuard } from "../src/guard.ts";
import { app } from "../src/index.ts";
import { TOP_N } from "../src/types.ts";
import { addDays, sha256hex, utcDay } from "../src/util.ts";
import { call, makeEnv, type TestEnv } from "./fakes.ts";

beforeEach(resetGuard);

const json = (body: unknown, init: RequestInit & { ip?: string } = {}) => ({
	method: "POST",
	body: JSON.stringify(body),
	...init,
});
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

/** Projects are created by their first event. Returns the admin token from that response. */
async function createWithToken(t: TestEnv, slug = "demo") {
	const res = await call(app, t.env, `/${slug}`, json({ event: "install" }));
	const body = (await res.json()) as { project: { admin_token: string } };
	return body.project.admin_token;
}

const daily = (t: TestEnv, project = "demo") =>
	t.db.sqlite.query("SELECT * FROM daily WHERE project = ? ORDER BY day").all(project) as Record<string, unknown>[];

test("POST /api/projects is gone: the first event creates a project", async () => {
	const t = makeEnv();
	const res = await call(app, t.env, "/api/projects", json({ slug: "demo" }));
	expect([404, 405]).toContain(res.status);
	expect(t.db.sqlite.query("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
});

const day = (ago: number) => addDays(utcDay(), -ago);
const addDaily = (t: TestEnv, project: string, d: string, dau: number) =>
	t.db.sqlite.run(`INSERT INTO daily VALUES ('${project}', '${d}', ${dau}, ${dau}, ${dau}, ${dau}, '{}', 'ae')`);
type Registry = { projects: Record<string, unknown>[] };

test("the public registry lists only projects with rollups in the last 30 days, so spam slugs never show", async () => {
	const t = makeEnv();
	for (const slug of ["active", "stale", "junk"]) await createWithToken(t, slug);
	addDaily(t, "active", day(3), 4);
	addDaily(t, "stale", day(31), 9);
	addDaily(t, "active", utcDay(), 99);
	const list = (await (await call(app, t.env, "/api/projects")).json()) as Registry;
	expect(list.projects.map((p) => p.slug)).toEqual(["active"]);
	expect(list.projects[0]?.dau).toBe(0);
	expect(Object.keys(list.projects[0] as object).sort()).toEqual(
		["created_at", "dau", "description", "homepage", "name", "series", "slug"],
	);
});

test("registry series are 30 closed days oldest first and zero-filled, and dau is yesterday's", async () => {
	const t = makeEnv();
	await createWithToken(t, "aaa");
	await createWithToken(t, "bbb");
	addDaily(t, "aaa", day(30), 7);
	addDaily(t, "aaa", day(2), 5);
	addDaily(t, "bbb", day(1), 3);
	addDaily(t, "bbb", day(10), 2);
	const { projects } = (await (await call(app, t.env, "/api/projects")).json()) as {
		projects: { slug: string; series: number[]; dau: number }[];
	};
	expect(projects.map((p) => [p.slug, p.dau])).toEqual([
		["bbb", 3],
		["aaa", 0],
	]);
	const aaa = projects[1]?.series ?? [];
	expect(aaa).toHaveLength(30);
	expect(aaa[0]).toBe(7);
	expect(aaa[28]).toBe(5);
	expect(aaa.reduce((a, b) => a + b, 0)).toBe(12);
	expect(projects[0]?.series[29]).toBe(3);
	expect(projects[0]?.series[20]).toBe(2);
});

test("the registry costs one D1 query however many projects there are", async () => {
	const t = makeEnv();
	await createWithToken(t, "aaa");
	await createWithToken(t, "bbb");
	addDaily(t, "aaa", day(1), 1);
	addDaily(t, "bbb", day(1), 1);
	t.db.resetCounters();
	await call(app, t.env, "/api/projects");
	expect(t.db.reads + t.db.writes).toBe(1);
});

const patch = (t: TestEnv, body: unknown, token?: string, slug = "demo") =>
	call(app, t.env, `/api/${slug}`, {
		method: "PATCH",
		body: typeof body === "string" ? body : JSON.stringify(body),
		...(token ? auth(token) : {}),
	});
const stored = (t: TestEnv, slug = "demo") =>
	t.db.sqlite.query("SELECT name, description, homepage FROM projects WHERE slug = ?").get(slug);

test("PATCH sets the display name and details, leaves missing fields alone, and never returns secrets", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	const res = await patch(t, { name: "Demo", description: "A demo", homepage: "https://example.com" }, token);
	expect(res.status).toBe(200);
	const { project } = (await res.json()) as { project: Record<string, unknown> };
	expect(project).toMatchObject({ slug: "demo", name: "Demo", description: "A demo", homepage: "https://example.com" });
	expect(Object.keys(project)).not.toContain("admin_hash");
	expect(Object.keys(project)).not.toContain("creator");

	await patch(t, { name: "Renamed" }, token);
	expect(stored(t)).toEqual({ name: "Renamed", description: "A demo", homepage: "https://example.com" });
});

test("PATCH with null or an empty string clears a field", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	await patch(t, { name: "Demo", description: "A demo", homepage: "https://example.com" }, token);
	await patch(t, { description: null, homepage: "" }, token);
	expect(stored(t)).toEqual({ name: "Demo", description: null, homepage: null });
});

test.each([
	["name over 60 chars", { name: "x".repeat(61) }],
	["description over 200 chars", { description: "x".repeat(201) }],
	["a javascript: homepage", { homepage: "javascript:alert(1)" }],
	["a non-url homepage", { homepage: "not a url" }],
	["a homepage over 200 chars", { homepage: `https://example.com/${"x".repeat(200)}` }],
	["a non-string name", { name: 5 }],
	["a slug change, since raw events are stored under the slug", { slug: "other" }],
	["no known field", { color: "red" }],
	["a body that is not an object", [1]],
	["a body that is not JSON", "nope"],
])("PATCH rejects %s with 400 and changes nothing", async (_name, body) => {
	const t = makeEnv();
	const token = await createWithToken(t);
	const res = await patch(t, body, token);
	expect(res.status).toBe(400);
	expect(stored(t)).toEqual({ name: null, description: null, homepage: null });
	expect(t.db.sqlite.query("SELECT slug FROM projects").all()).toEqual([{ slug: "demo" }]);
});

test("PATCH needs the project's own token: 401 without it or with another project's, 404 for unknown projects", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	const other = await createWithToken(t, "other");
	expect((await patch(t, { name: "x" })).status).toBe(401);
	expect((await patch(t, { name: "x" }, "tk_wrong")).status).toBe(401);
	expect((await patch(t, { name: "x" }, other)).status).toBe(401);
	expect((await patch(t, { name: "x" }, token, "ghost")).status).toBe(404);
	expect(stored(t)).toEqual({ name: null, description: null, homepage: null });
});

const rotate = (t: TestEnv, token?: string, slug = "demo") =>
	call(app, t.env, `/api/${slug}/token`, { method: "POST", ...(token ? auth(token) : {}) });

test("rotating the token makes the old one stop working, so a leaked token can be revoked", async () => {
	const t = makeEnv();
	const old = await createWithToken(t);
	const res = await rotate(t, old);
	expect(res.status).toBe(200);
	expect(res.headers.get("cache-control")).toBe("no-store");
	const { admin_token } = (await res.json()) as { admin_token: string };
	expect(admin_token).toMatch(/^tk_[0-9a-f]{48}$/);
	expect(admin_token).not.toBe(old);
	expect(t.db.sqlite.query("SELECT admin_hash FROM projects").get()).toEqual({ admin_hash: await sha256hex(admin_token) });

	expect((await patch(t, { name: "x" }, old)).status).toBe(401);
	expect((await rotate(t, old)).status).toBe(401);
	expect((await patch(t, { name: "x" }, admin_token)).status).toBe(200);
});

test("rotation needs the admin token", async () => {
	const t = makeEnv();
	const token = await createWithToken(t);
	expect((await rotate(t)).status).toBe(401);
	expect((await rotate(t, "tk_wrong")).status).toBe(401);
	expect((await rotate(t, token, "ghost")).status).toBe(404);
	expect(t.db.sqlite.query("SELECT admin_hash FROM projects").get()).toEqual({ admin_hash: await sha256hex(token) });
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
	const again = await call(app, t.env, "/demo", json({ event: "install" }));
	expect(((await again.json()) as { project?: { created: boolean } }).project?.created).toBe(true);
});

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
