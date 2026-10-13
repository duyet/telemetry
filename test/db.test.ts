import { expect, test } from "bun:test";
import { ensureReady, getSalt, projectExists, resetDbState } from "../src/db.ts";
import { makeEnv } from "./fakes.ts";

test("schema self-applies so `cf deploy` alone is a working install", async () => {
	const { env, db } = makeEnv();
	await ensureReady(env.DB);
	const tables = db.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
	expect(tables.map((t) => (t as { name: string }).name)).toEqual(["daily", "meta", "projects"]);
	expect(getSalt()).toMatch(/^[0-9a-f]{64}$/);
});

test("salt survives a cold start, otherwise every uid would change and WAU/MAU would break", async () => {
	const { env } = makeEnv();
	await ensureReady(env.DB);
	const first = getSalt();
	resetDbState();
	await ensureReady(env.DB);
	expect(getSalt()).toBe(first);
});

test("project lookups are served from isolate memory, not D1", async () => {
	const { env, db } = makeEnv();
	await ensureReady(env.DB);
	db.sqlite.run("INSERT INTO projects (slug, admin_hash, created_at) VALUES ('demo', 'x', '2026-01-01')");
	expect(await projectExists(env.DB, "demo")).toBe(true);
	db.resetCounters();
	for (let i = 0; i < 100; i++) await projectExists(env.DB, "demo");
	for (let i = 0; i < 100; i++) await projectExists(env.DB, "nope");
	expect(db.reads).toBe(0);
});
