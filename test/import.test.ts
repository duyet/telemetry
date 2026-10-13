import { describe, expect, test } from "bun:test";
import { parseNdjson, postRollups, type RawRow, rollup } from "../scripts/import.ts";
import { addDays } from "../src/util.ts";

const row = (day: string, id: string, extra: Partial<RawRow> = {}): RawRow => ({ day, id, event: "run", ...extra });
const find = (rows: RawRow[], day: string) => {
	const r = rollup(rows).find((x) => x.day === day);
	if (!r) throw new Error(`no rollup for ${day}`);
	return r;
};

describe("rollup windows", () => {
	// The whole point of computing locally is exact WAU/MAU. Summing daily counts would double count returning users.
	test("a returning user counts once in wau and mau", () => {
		const rows = [row("2026-03-01", "a"), row("2026-03-02", "a"), row("2026-03-02", "b")];
		expect(find(rows, "2026-03-02")).toMatchObject({ dau: 2, wau: 2, mau: 2, events: 2 });
	});

	test("wau window is exactly [day-6, day]", () => {
		const day = "2026-03-20";
		const rows = [row(addDays(day, -6), "in"), row(addDays(day, -7), "out"), row(day, "today")];
		expect(find(rows, day)).toMatchObject({ dau: 1, wau: 2, mau: 3 });
	});

	test("mau window is exactly [day-29, day]", () => {
		const day = "2026-03-31";
		const rows = [row(addDays(day, -29), "in"), row(addDays(day, -30), "out"), row(day, "today")];
		expect(find(rows, day)).toMatchObject({ dau: 1, wau: 1, mau: 2 });
	});

	test("gaps without rows do not break the windows", () => {
		const rows = [row("2026-01-01", "a"), row("2026-01-20", "b"), row("2026-02-05", "a")];
		expect(find(rows, "2026-01-20")).toMatchObject({ wau: 1, mau: 2 });
		expect(find(rows, "2026-02-05")).toMatchObject({ dau: 1, wau: 1, mau: 2 });
	});

	test("matches a brute-force count on random data", () => {
		let seed = 7;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const rows: RawRow[] = [];
		for (let i = 0; i < 600; i++) rows.push(row(addDays("2026-01-01", rand(90)), `u${rand(40)}`, { n: 1 + rand(3) }));
		const distinct = (from: string, to: string) =>
			new Set(rows.filter((r) => r.day >= from && r.day <= to).map((r) => r.id)).size;
		for (const r of rollup(rows)) {
			expect(r.dau).toBe(distinct(r.day, r.day));
			expect(r.wau).toBe(distinct(addDays(r.day, -6), r.day));
			expect(r.mau).toBe(distinct(addDays(r.day, -29), r.day));
			expect(r.events).toBe(rows.filter((x) => x.day === r.day).reduce((n, x) => n + (x.n ?? 1), 0));
		}
	});

	test("output is one row per day with data, sorted", () => {
		const out = rollup([row("2026-01-03", "a"), row("2026-01-01", "a")]);
		expect(out.map((r) => r.day)).toEqual(["2026-01-01", "2026-01-03"]);
	});
});

describe("event-only rows", () => {
	// Old tables such as chmonitor's `events` have no install id. They must add events, never invented users.
	test("add events and dim events but no users", () => {
		const rows = [row("2026-03-01", "a"), { day: "2026-03-01", event: "app_loaded" }, { day: "2026-03-01", id: "", event: "app_loaded", n: 4 }];
		const r = find(rows, "2026-03-01");
		expect(r).toMatchObject({ dau: 1, wau: 1, mau: 1, events: 6 });
		expect(r.dims.event).toEqual({ app_loaded: [0, 5], run: [1, 1] });
	});

	test("a day with only event-only rows has zero users", () => {
		expect(find([{ day: "2026-03-01", event: "x" }], "2026-03-01")).toMatchObject({ dau: 0, wau: 0, mau: 0, events: 1 });
	});
});

describe("dims", () => {
	test("sum users and events per value, and skip empty values", () => {
		const rows = [
			row("2026-03-01", "a", { version: "1.0", os: "linux", country: "VN", props: { command: "build" } }),
			row("2026-03-01", "a", { version: "1.0", os: "linux", country: "VN", props: { command: "test", empty: "" } }),
			row("2026-03-01", "b", { version: "2.0", os: "", n: 5, props: { command: "build", flag: true } }),
		];
		const { dims } = find(rows, "2026-03-01");
		expect(dims.version).toEqual({ "1.0": [1, 2], "2.0": [1, 5] });
		expect(dims.os).toEqual({ linux: [1, 2] });
		expect(dims.country).toEqual({ VN: [1, 2] });
		expect(dims["prop:command"]).toEqual({ build: [2, 6], test: [1, 1] });
		expect(dims["prop:flag"]).toEqual({ true: [1, 5] });
		expect(dims["prop:empty"]).toBeUndefined();
	});

	test("keep the top 20 values by events", () => {
		const rows = Array.from({ length: 30 }, (_, i) => row("2026-03-01", `u${i}`, { version: `v${i}`, n: i + 1 }));
		const versions = find(rows, "2026-03-01").dims.version ?? {};
		expect(Object.keys(versions)).toHaveLength(20);
		expect(versions.v29).toEqual([1, 30]);
		expect(versions.v10).toEqual([1, 11]);
		expect(versions.v9).toBeUndefined();
	});

	test("prop values are cut to 64 chars like the live endpoint", () => {
		const long = "x".repeat(100);
		const { dims } = find([row("2026-03-01", "a", { props: { k: long } })], "2026-03-01");
		expect(Object.keys(dims["prop:k"] ?? {})).toEqual(["x".repeat(64)]);
	});
});

describe("parseNdjson", () => {
	test("skips blank lines and reports the line of a bad row", () => {
		expect(parseNdjson('{"day":"2026-03-01","event":"a"}\n\n')).toHaveLength(1);
		expect(() => parseNdjson('{"day":"2026-03-01","event":"a"}\nnot json')).toThrow("line 2");
		expect(() => parseNdjson('{"day":"03/01","event":"a"}')).toThrow("day");
		expect(() => parseNdjson('{"day":"2026-03-01"}')).toThrow("event");
		expect(() => parseNdjson('{"day":"2026-03-01","event":"a","n":0}')).toThrow("n must");
		expect(() => parseNdjson('{"day":"2026-03-01","event":"a","props":{"Bad Key":1}}')).toThrow("prop key");
	});
});

describe("postRollups", () => {
	test("posts at most 300 rows per request with the bearer token", async () => {
		const rollups = Array.from({ length: 650 }, (_, i) => ({ day: addDays("2024-01-01", i), dau: 1, wau: 1, mau: 1, events: 1, dims: {} }));
		const calls: { url: string; auth: string | null; rows: number }[] = [];
		const fake = (async (url: string, init: RequestInit) => {
			const rows = JSON.parse(String(init.body)).rows.length;
			calls.push({ url, auth: new Headers(init.headers).get("authorization"), rows });
			return Response.json({ imported: rows - 1, skipped: 1 });
		}) as unknown as typeof fetch;
		const res = await postRollups(rollups, { base: "https://t.example/", project: "p", token: "tk_x", fetch: fake });
		expect(calls.map((c) => c.rows)).toEqual([300, 300, 50]);
		expect(calls.every((c) => c.url === "https://t.example/api/p/import" && c.auth === "Bearer tk_x")).toBe(true);
		expect(res).toEqual({ imported: 647, skipped: 3 });
	});

	test("fails loudly on a non-2xx response", async () => {
		const fake = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
		const r = [{ day: "2026-03-01", dau: 1, wau: 1, mau: 1, events: 1, dims: {} }];
		await expect(postRollups(r, { base: "https://t.example", project: "p", token: "bad", fetch: fake })).rejects.toThrow("401");
	});
});
