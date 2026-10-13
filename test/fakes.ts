import { Database } from "bun:sqlite";
import { resetDbState } from "../src/db.ts";
import type { Bindings } from "../src/types.ts";

type Value = string | number | boolean | null | ArrayBuffer;

/** Minimal D1 adapter over bun:sqlite. Counts queries so tests can assert "no D1 on this path". */
export class FakeD1 {
	readonly sqlite = new Database(":memory:");
	reads = 0;
	writes = 0;
	log: string[] = [];

	prepare(query: string) {
		return new FakeStmt(this, query, []);
	}

	async batch(stmts: FakeStmt[]) {
		const out = [];
		this.sqlite.run("BEGIN");
		try {
			for (const s of stmts) out.push(await s.run());
			this.sqlite.run("COMMIT");
		} catch (e) {
			this.sqlite.run("ROLLBACK");
			throw e;
		}
		return out;
	}

	async exec(query: string) {
		this.sqlite.run(query);
		return { count: 1, duration: 0 };
	}

	track(query: string) {
		this.log.push(query);
		if (/^\s*(select|pragma)/i.test(query)) this.reads++;
		else this.writes++;
	}

	resetCounters() {
		this.reads = 0;
		this.writes = 0;
		this.log = [];
	}
}

class FakeStmt {
	constructor(
		private db: FakeD1,
		private query: string,
		private params: Value[],
	) {}

	bind(...params: Value[]) {
		return new FakeStmt(this.db, this.query, params);
	}

	async first<T>(col?: string): Promise<T | null> {
		this.db.track(this.query);
		const row = this.db.sqlite.query(this.query).get(...(this.params as never[])) as Record<string, unknown> | null;
		if (!row) return null;
		return (col ? row[col] : row) as T;
	}

	async all<T>() {
		this.db.track(this.query);
		const results = this.db.sqlite.query(this.query).all(...(this.params as never[])) as T[];
		return { results, success: true, meta: {} };
	}

	async run() {
		this.db.track(this.query);
		const r = this.db.sqlite.query(this.query).run(...(this.params as never[]));
		return { results: [], success: true, meta: { changes: r.changes } };
	}

	async raw<T>() {
		this.db.track(this.query);
		return this.db.sqlite.query(this.query).values(...(this.params as never[])) as T[];
	}
}

/** Collects AE data points in memory. */
export class FakeDataset {
	points: AnalyticsEngineDataPoint[] = [];
	writeDataPoint(p: AnalyticsEngineDataPoint) {
		this.points.push(p);
	}
}

/** AE SQL fake: tests supply a handler mapping query text → rows. */
export class FakeAnalytics {
	queries: string[] = [];
	constructor(public handler: (query: string) => Record<string, unknown>[] = () => []) {}
	async query<T extends Record<string, unknown>>(req: { query: string }) {
		this.queries.push(req.query);
		const data = this.handler(req.query) as T[];
		return { data, rows: data.length, statistics: { elapsed_ms: 0, rows_read: 0, bytes_read: 0 } };
	}
}

export interface TestEnv {
	env: Bindings;
	db: FakeD1;
	events: FakeDataset;
	analytics: FakeAnalytics;
}

/** Fresh env with empty DB and reset isolate caches. */
export function makeEnv(handler?: (query: string) => Record<string, unknown>[]): TestEnv {
	resetDbState();
	const db = new FakeD1();
	const events = new FakeDataset();
	const analytics = new FakeAnalytics(handler);
	const env = { DB: db, EVENTS: events, ANALYTICS: analytics } as unknown as Bindings;
	return { env, db, events, analytics };
}

/** Executes a request against the app with a fake execution context. */
export async function call(
	app: { fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => Response | Promise<Response> },
	env: Bindings,
	path: string,
	init?: RequestInit & { ip?: string; country?: string },
): Promise<Response> {
	const headers = new Headers(init?.headers);
	headers.set("cf-connecting-ip", init?.ip ?? "203.0.113.7");
	const req = new Request(`https://telemetry.test${path}`, { ...init, headers });
	Object.defineProperty(req, "cf", { value: { country: init?.country ?? "VN" } });
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
		passThroughOnException() {},
		props: {},
	} as unknown as ExecutionContext;
	const res = await app.fetch(req, env, ctx);
	await Promise.all(pending);
	return res;
}
