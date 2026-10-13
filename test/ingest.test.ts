import { beforeEach, expect, test } from "bun:test";
import { ensureReady } from "../src/db.ts";
import { DAILY_CAP, IP_LIMIT, NEW_PROJECTS_PER_DAY, NEW_PROJECTS_PER_IP_PER_DAY, reserve, resetGuard } from "../src/guard.ts";
import { app } from "../src/index.ts";
import { sha256hex } from "../src/util.ts";
import { call, makeEnv, type TestEnv } from "./fakes.ts";

beforeEach(resetGuard);

async function setup(): Promise<TestEnv> {
	const t = makeEnv();
	await ensureReady(t.env.DB);
	for (const slug of ["demo", "other"]) {
		t.db.sqlite.run(`INSERT INTO projects (slug, admin_hash, created_at) VALUES ('${slug}', 'x', '2026-01-01')`);
	}
	return t;
}

function post(t: TestEnv, path: string, body: unknown, init: Parameters<typeof call>[3] = {}) {
	return call(app, t.env, path, {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
		...init,
	});
}

/** First ingest loads the project list from D1; everything after that must be free. */
async function warm(t: TestEnv) {
	await post(t, "/demo", { event: "warmup" });
	t.events.points.length = 0;
	t.db.resetCounters();
}

const blobs = (t: TestEnv) => t.events.points.map((p) => p.blobs as string[]);

test("ingest does no D1 reads or writes once warm, because the D1 quota is shared account-wide", async () => {
	const t = await setup();
	await warm(t);
	for (let i = 0; i < 5; i++) {
		expect((await post(t, "/demo", { event: "run", id: `install-${i}` })).status).toBe(202);
	}
	expect(t.events.points).toHaveLength(5);
	expect(t.db.reads).toBe(0);
	expect(t.db.writes).toBe(0);
});

test("a reserved or invalid slug is a 404 that writes nothing and costs no D1 call", async () => {
	const t = await setup();
	await warm(t);
	for (const slug of ["api", "docs", "fonts", "_headers", "Bad_Slug", "a"]) {
		const res = await post(t, `/${slug}`, { event: "run" });
		expect(res.status, slug).toBe(404);
		expect(await res.json()).toHaveProperty("error");
	}
	expect(t.events.points).toHaveLength(0);
	expect(t.db.reads + t.db.writes).toBe(0);
});

type Created = { accepted: number; dropped: number; project?: { slug: string; created: true; admin_token: string; page_url: string } };

test("the first event to a new slug creates the project and returns its admin token once, so no signup step is needed", async () => {
	const t = await setup();
	const res = await post(t, "/fresh", { event: "install", id: "a" });
	expect(res.status).toBe(202);
	const body = (await res.json()) as Created;
	expect(body.accepted).toBe(1);
	expect(body.project).toEqual({
		slug: "fresh",
		created: true,
		admin_token: expect.stringMatching(/^tk_[0-9a-f]{48}$/),
		page_url: "https://telemetry.test/fresh",
	});
	const token = body.project?.admin_token ?? "";
	expect(res.headers.get("x-telemetry-admin-token")).toBe(token);
	expect(res.headers.get("cache-control")).toBe("no-store");
	expect(t.events.points).toHaveLength(1);

	const row = t.db.sqlite.query("SELECT * FROM projects WHERE slug = 'fresh'").get() as Record<string, string>;
	expect(JSON.stringify(row)).not.toContain(token);
	expect(row.admin_hash).toBe(await sha256hex(token));
	expect(row.creator).toMatch(/^[0-9a-f]{16}$/);
	expect(JSON.stringify(row)).not.toContain("203.0.113.7");
});

test("later events to a created project carry no token and cost no D1 call, so the token is shown once and ingest stays free", async () => {
	const t = await setup();
	await post(t, "/fresh", { event: "install" });
	t.db.resetCounters();
	const res = await post(t, "/fresh", { event: "ping" });
	expect(res.status).toBe(202);
	expect(await res.json()).toEqual({ accepted: 1, dropped: 0 });
	expect(res.headers.get("x-telemetry-admin-token")).toBeNull();
	expect(t.db.reads + t.db.writes).toBe(0);
});

test("a body with no valid events never creates a project, so junk requests cannot claim slugs", async () => {
	const t = await setup();
	await warm(t);
	for (const body of ["{not json", [], { event: "bad name!" }]) {
		expect((await post(t, "/fresh", body)).status).toBe(400);
	}
	expect(t.db.writes).toBe(0);
	expect(t.db.sqlite.query("SELECT count(*) AS n FROM projects WHERE slug = 'fresh'").get()).toEqual({ n: 0 });
});

test(`one IP creates at most ${NEW_PROJECTS_PER_IP_PER_DAY} projects a day, and the next is refused from memory with no D1 call`, async () => {
	const t = await setup();
	for (let i = 0; i < NEW_PROJECTS_PER_IP_PER_DAY; i++) {
		expect((await post(t, `/new-${i}`, { event: "install" }, { ip: "198.51.100.1" })).status).toBe(202);
	}
	t.db.resetCounters();
	const res = await post(t, "/new-x", { event: "install" }, { ip: "198.51.100.1" });
	expect(res.status).toBe(429);
	expect(await res.json()).toEqual({ error: "new project limit reached for today" });
	expect(t.db.reads + t.db.writes).toBe(0);
	expect((await post(t, "/new-x", { event: "install" }, { ip: "198.51.100.2" })).status).toBe(202);
});

test("the per-IP create cap holds in D1 too, so a fresh isolate cannot be used to get around it", async () => {
	const t = await setup();
	for (let i = 0; i < NEW_PROJECTS_PER_IP_PER_DAY; i++) await post(t, `/new-${i}`, { event: "install" });
	resetGuard();
	expect((await post(t, "/new-x", { event: "install" })).status).toBe(429);
	expect(t.db.sqlite.query("SELECT count(*) AS n FROM projects WHERE slug = 'new-x'").get()).toEqual({ n: 0 });
	t.db.resetCounters();
	expect((await post(t, "/new-y", { event: "install" })).status).toBe(429);
	expect(t.db.reads + t.db.writes).toBe(0);
});

test(`at most ${NEW_PROJECTS_PER_DAY} projects are created a day in total, then new slugs are refused with no D1 call`, async () => {
	const t = await setup();
	const now = new Date().toISOString();
	const insert = t.db.sqlite.prepare("INSERT INTO projects (slug, admin_hash, created_at, creator) VALUES (?, 'x', ?, ?)");
	for (let i = 0; i < NEW_PROJECTS_PER_DAY; i++) insert.run(`bulk-${i}`, now, `creator-${i}`);
	const res = await post(t, "/one-more", { event: "install" }, { ip: "198.51.100.1" });
	expect(res.status).toBe(429);
	t.db.resetCounters();
	expect((await post(t, "/another", { event: "install" }, { ip: "198.51.100.2" })).status).toBe(429);
	expect(t.db.reads + t.db.writes).toBe(0);
	expect((await post(t, "/demo", { event: "run" })).status).toBe(202);
});

test("when another isolate created the slug first, the event is accepted without a token", async () => {
	const t = await setup();
	await warm(t);
	t.db.sqlite.run(`INSERT INTO projects (slug, admin_hash, created_at) VALUES ('raced', 'x', '${new Date().toISOString()}')`);
	const res = await post(t, "/raced", { event: "install" });
	expect(res.status).toBe(202);
	expect(await res.json()).toEqual({ accepted: 1, dropped: 0 });
	expect(res.headers.get("x-telemetry-admin-token")).toBeNull();
	expect(t.db.sqlite.query("SELECT admin_hash FROM projects WHERE slug = 'raced'").get()).toEqual({ admin_hash: "x" });
	t.db.resetCounters();
	expect((await post(t, "/raced", { event: "ping" })).status).toBe(202);
	expect(t.db.reads + t.db.writes).toBe(0);
});

test("the raw client id, ip and user agent never reach Analytics Engine, which keeps data for 90 days", async () => {
	const t = await setup();
	const headers = { "user-agent": "SecretAgent/9.9" };
	await post(t, "/demo", { event: "run", id: "my-install-id-123" }, { headers });
	await post(t, "/demo", { event: "run" }, { headers, ip: "198.51.100.42" });
	const stored = JSON.stringify(t.events.points);
	for (const secret of ["my-install-id-123", "198.51.100.42", "203.0.113.7", "SecretAgent"]) {
		expect(stored).not.toContain(secret);
	}
	for (const b of blobs(t)) expect(b[1]).toMatch(/^[0-9a-f]{16}$/);
});

test("the same install id keeps the same uid across requests, otherwise WAU and MAU would inflate", async () => {
	const t = await setup();
	await post(t, "/demo", { event: "run", id: "abc" });
	await post(t, "/demo", { event: "other", id: "abc" }, { ip: "198.51.100.1" });
	const [a, b] = blobs(t);
	expect(a[1]).toBe(b[1]);
});

test("the same install id gets a different uid per project, so projects cannot be joined", async () => {
	const t = await setup();
	await post(t, "/demo", { event: "run", id: "abc" });
	await post(t, "/other", { event: "run", id: "abc" });
	const [a, b] = blobs(t);
	expect(a[1]).not.toBe(b[1]);
});

test("without an id the uid follows the ip and user agent, so DAU works but nobody is identified", async () => {
	const t = await setup();
	await post(t, "/demo", { event: "run" }, { ip: "198.51.100.1" });
	await post(t, "/demo", { event: "run" }, { ip: "198.51.100.1" });
	await post(t, "/demo", { event: "run" }, { ip: "198.51.100.2" });
	const [a, b, c] = blobs(t);
	expect(a[1]).toBe(b[1]);
	expect(a[1]).not.toBe(c[1]);
});

test("an over-long id is treated as no id instead of being hashed", async () => {
	const t = await setup();
	await post(t, "/demo", { event: "run", id: "x".repeat(129) }, { ip: "198.51.100.1" });
	await post(t, "/demo", { event: "run" }, { ip: "198.51.100.1" });
	const [a, b] = blobs(t);
	expect(a[1]).toBe(b[1]);
});

test("identical events in one request merge into one data point with summed n, saving the AE quota", async () => {
	const t = await setup();
	const res = await post(t, "/demo", [
		{ event: "run", id: "abc", n: 2 },
		{ event: "run", id: "abc", n: 3 },
		{ event: "run", id: "abc" },
		{ event: "build", id: "abc" },
		{ event: "run", id: "different" },
	]);
	expect(await res.json()).toEqual({ accepted: 3, dropped: 0 });
	expect(t.events.points.map((p) => [p.blobs?.[0], p.doubles?.[0]])).toEqual([
		["run", 6],
		["build", 1],
		["run", 1],
	]);
});

test("props given in a different order still merge and land in the same blob positions", async () => {
	const t = await setup();
	await post(t, "/demo", [
		{ event: "run", id: "a", props: { b: 1, a: 2 } },
		{ event: "run", id: "a", props: { a: 2, b: 1 } },
	]);
	expect(t.events.points).toHaveLength(1);
	expect(blobs(t)[0].slice(8)).toEqual(["a=2", "b=1"]);
	expect(t.events.points[0].doubles).toEqual([2]);
});

test("props are capped at 8, keys lowercased, bad keys dropped, values truncated, then sorted", async () => {
	const t = await setup();
	await post(t, "/demo", {
		event: "run",
		id: "a",
		props: {
			zeta: 1,
			Alpha: "a",
			long: "x".repeat(100),
			"bad key!": "dropped",
			nested: { no: "objects" },
			c: true,
			d: 4,
			e: 5,
			f: 6,
			g: 7,
			h: "past the cap",
		},
	});
	expect(blobs(t)[0].slice(8)).toEqual([
		"alpha=a",
		"c=true",
		"d=4",
		"e=5",
		"f=6",
		"g=7",
		`long=${"x".repeat(64)}`,
		"zeta=1",
	]);
});

test("fields are cleaned individually so one bad field does not lose the event", async () => {
	const t = await setup();
	await post(t, "/demo", [
		{ event: "good", id: "a", version: "1.2.3-rc.1+build", os: "Linux", arch: "X64", ci: true },
		{ event: "dirty", id: "a", version: "v 1 !", os: "not an os", arch: 5, ci: "yes" },
	]);
	const [good, dirty] = blobs(t);
	expect(good.slice(0, 1).concat(good.slice(2))).toEqual(["good", "1.2.3-rc.1+build", "linux", "x64", "vn", "1", "native"]);
	expect(dirty.slice(0, 1).concat(dirty.slice(2))).toEqual(["dirty", "", "", "", "vn", "0", "native"]);
});

test("n is an integer between 1 and 1000 so a client cannot inflate counts without bound", async () => {
	const t = await setup();
	await post(t, "/demo", [
		{ event: "a", n: 5000 },
		{ event: "b", n: -3 },
		{ event: "c", n: "7" },
		{ event: "d", n: 2.6 },
		{ event: "e" },
	]);
	expect(t.events.points.map((p) => p.doubles?.[0])).toEqual([1000, 1, 1, 3, 1]);
});

test("country comes from the edge and only when it is a two-letter code", async () => {
	const t = await setup();
	await post(t, "/demo", { event: "run", id: "a" }, { country: "DE" });
	await post(t, "/demo", { event: "run", id: "b" }, { country: "T1" });
	expect(blobs(t).map((b) => b[5])).toEqual(["de", ""]);
});

test("invalid events are dropped and counted, valid siblings are kept", async () => {
	const t = await setup();
	const res = await post(t, "/demo", [{ event: "ok" }, { event: "bad name!" }, "text", { id: "no-event" }, null]);
	expect(res.status).toBe(202);
	expect(await res.json()).toEqual({ accepted: 1, dropped: 4 });
});

test("a request with no valid event is a 400 that says what a valid event looks like", async () => {
	const t = await setup();
	for (const body of [[], [{ event: "no spaces allowed" }], { event: "x".repeat(65) }]) {
		const res = await post(t, "/demo", body);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("event");
	}
	expect(t.events.points).toHaveLength(0);
});

test("malformed bodies are a 400, not a crash", async () => {
	const t = await setup();
	for (const body of ["{not json", "", "42", '"text"', "null"]) {
		const res = await post(t, "/demo", body);
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	}
});

test("a batch is at most 25 events, bigger ones are rejected whole", async () => {
	const t = await setup();
	const batch = (n: number) => Array.from({ length: n }, (_, i) => ({ event: `e${i}` }));
	expect((await post(t, "/demo", batch(26))).status).toBe(400);
	expect(t.events.points).toHaveLength(0);
	expect((await post(t, "/demo", batch(25))).status).toBe(202);
	expect(t.events.points).toHaveLength(25);
});

test("a body over 16 KB is a 413 even when content-length is missing or lies", async () => {
	const t = await setup();
	const big = JSON.stringify({ event: "run", props: { note: "x".repeat(17 * 1024) } });
	expect((await post(t, "/demo", big)).status).toBe(413);
	expect((await post(t, "/demo", big, { headers: { "content-length": "10" } })).status).toBe(413);
	expect((await post(t, "/demo", "{}", { headers: { "content-length": String(big.length) } })).status).toBe(413);
	expect(t.events.points).toHaveLength(0);
});

test("one ip is limited to 60 requests a minute with a Retry-After, other ips are unaffected", async () => {
	const t = await setup();
	for (let i = 0; i < IP_LIMIT; i++) expect((await post(t, "/demo", { event: "run" })).status).toBe(202);
	const res = await post(t, "/demo", { event: "run" });
	expect(res.status).toBe(429);
	expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
	expect(t.events.points).toHaveLength(IP_LIMIT);
	expect((await post(t, "/demo", { event: "run" }, { ip: "198.51.100.9" })).status).toBe(202);
});

test("over the daily cap the request is a 429 that writes nothing, not a partial batch", async () => {
	const t = await setup();
	expect(reserve("demo", DAILY_CAP - 1)).toBe(true);
	const res = await post(t, "/demo", [{ event: "a" }, { event: "b" }]);
	expect(res.status).toBe(429);
	expect(t.events.points).toHaveLength(0);
	expect((await post(t, "/demo", { event: "a" })).status).toBe(202);
	expect((await post(t, "/demo", { event: "a" })).status).toBe(429);
	expect(t.events.points).toHaveLength(1);
});

test("a project at its cap does not stop other projects", async () => {
	const t = await setup();
	reserve("demo", DAILY_CAP);
	expect((await post(t, "/demo", { event: "a" })).status).toBe(429);
	expect((await post(t, "/other", { event: "a" })).status).toBe(202);
});
