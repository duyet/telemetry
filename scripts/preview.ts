/**
 * Local preview of the real pages with seeded data, no Cloudflare needed.
 *   bun scripts/preview.ts   →  http://localhost:8788
 */
import { app } from "../src/index.ts";
import type { Dims } from "../src/types.ts";
import { addDays, utcDay } from "../src/util.ts";
import { makeEnv } from "../test/fakes.ts";

const PORT = Number(process.env.PORT ?? 8788);
const DAYS = 90;

const PROJECTS = [
	{
		slug: "demo-cli",
		name: "Demo CLI",
		description: "A command line tool that reports usage here.",
		homepage: "https://github.com/duyet/demo-cli",
		scale: 420,
	},
	{
		slug: "pocket-notes",
		name: "Pocket Notes",
		description: "Desktop note taking app for people who like plain text.",
		homepage: "https://pocketnotes.example",
		scale: 90,
	},
	{ slug: "quiet-proxy", name: null, description: null, homepage: null, scale: 12 },
];

let seed = 7;
function rand(): number {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}

function split(total: number, weights: number[]): number[] {
	const sum = weights.reduce((a, b) => a + b, 0);
	return weights.map((w) => Math.round((total * w) / sum));
}

function dim(users: number, events: number, values: string[], weights: number[]): Record<string, [number, number]> {
	const u = split(users, weights);
	const e = split(events, weights);
	const out: Record<string, [number, number]> = {};
	values.forEach((v, i) => {
		if (u[i]! > 0 || e[i]! > 0) out[v] = [u[i]!, e[i]!];
	});
	return out;
}

function dimsFor(dau: number, events: number): Dims {
	return {
		event: dim(dau, events, ["ping", "run", "build", "test", "publish", "error"], [10, 8, 5, 4, 1, 0.5]),
		version: dim(dau, events, ["1.4.0", "1.3.2", "1.3.1", "1.2.0", "1.1.0", "0.9.9"], [6, 4, 2, 1.5, 0.5, 0.2]),
		os: dim(dau, events, ["linux", "darwin", "windows"], [5, 3, 1.5]),
		arch: dim(dau, events, ["x64", "arm64"], [6, 3]),
		country: dim(dau, events, ["US", "DE", "VN", "GB", "IN", "FR", "JP", "BR", "CA", "AU", "NL", "SG"], [8, 4, 4, 3, 3, 2, 2, 1.5, 1.5, 1, 1, 0.8]),
		ci: dim(dau, events, ["false", "true"], [8, 1]),
		source: dim(dau, events, ["native", "otlp"], [9, 1]),
		"prop:command": dim(dau, events, ["build", "dev", "test", "lint", "deploy", "init", "help"], [6, 5, 4, 2, 1, 0.5, 0.3]),
		"prop:shell": dim(dau, events, ["zsh", "bash", "fish", "pwsh"], [5, 4, 1, 0.5]),
	};
}

const { env, db, analytics } = makeEnv(() => [{ users: 97, events: 801 }]);
await app.fetch(new Request("http://localhost/health"), env, {} as ExecutionContext);

const today = utcDay();
for (const p of PROJECTS) {
	db.sqlite.run(
		"INSERT INTO projects (slug, name, description, homepage, admin_hash, created_at) VALUES (?, ?, ?, ?, 'x', ?)",
		[p.slug, p.name, p.description, p.homepage, addDays(today, -DAYS - 20) + "T09:30:00Z"],
	);
	for (let i = DAYS; i >= 1; i--) {
		const day = addDays(today, -i);
		const t = DAYS - i;
		const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
		const weekend = weekday === 0 || weekday === 6 ? 0.55 : 1;
		const trend = 0.7 + (0.5 * t) / DAYS;
		const dau = Math.max(0, Math.round(p.scale * trend * weekend * (1 + 0.15 * Math.sin(t / 4) + (rand() - 0.5) * 0.2)));
		const events = Math.round(dau * (5 + 2 * rand()));
		const wau = Math.round(dau * 3.6);
		const mau = Math.round(dau * 11);
		db.sqlite.run("INSERT INTO daily (project, day, dau, wau, mau, events, dims, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'ae')", [
			p.slug,
			day,
			dau,
			wau,
			mau,
			events,
			JSON.stringify(dimsFor(dau, events)),
		]);
	}
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
Bun.serve({
	port: PORT,
	fetch: (req) => {
		const headers = new Headers(req.headers);
		headers.set("cf-connecting-ip", "203.0.113.7");
		const r = new Request(req.url, { method: req.method, headers, body: req.body });
		Object.defineProperty(r, "cf", { value: { country: "VN" } });
		return app.fetch(r, env, ctx);
	},
});

console.log(`preview: http://localhost:${PORT}  (projects: ${PROJECTS.map((p) => p.slug).join(", ")})`);
console.log(`AE fake answers every query with ${JSON.stringify(analytics.handler(""))}`);
