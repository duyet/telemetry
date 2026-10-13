import { expect, test } from "bun:test";
import { app } from "../src/index.ts";
import { usageChartSvg } from "../src/pages/charts.tsx";
import { DocsView } from "../src/pages/docs.tsx";
import { compact } from "../src/pages/format.ts";
import { LandingView } from "../src/pages/landing.tsx";
import { emptyStats, orderedDims, ProjectView } from "../src/pages/project.tsx";
import type { Project, Stats } from "../src/types.ts";
import { addDays } from "../src/util.ts";
import { makeEnv, call } from "./fakes.ts";

const BASE = "https://telemetry.test";

const project: Project = {
	slug: "demo-cli",
	name: "Demo CLI",
	description: "A command line tool that reports usage here.",
	homepage: "https://github.com/duyet/demo-cli",
	created_at: "2026-01-05T10:00:00Z",
};

const fixtureSnippets = [
	{ id: "curl", label: "curl", lang: "sh", code: `curl -X POST ${BASE}/demo-cli -d '{"event":"ping"}'` },
	{ id: "ts", label: "TypeScript", lang: "ts", code: `await fetch("${BASE}/demo-cli", { method: "POST" })` },
	{ id: "python", label: "Python", lang: "py", code: `requests.post("${BASE}/demo-cli", json={"event": "ping"})` },
];

function top(prefix: string, n: number, scale: number): Record<string, [number, number]> {
	const out: Record<string, [number, number]> = {};
	for (let i = 0; i < n; i++) out[`${prefix}${i}`] = [Math.round(scale / (i + 1)), Math.round((scale * 4) / (i + 1))];
	return out;
}

/** Stats shaped like B's output: top-20 dims, a series of `days` points. */
export function fixtureStats(days: number): Stats {
	const series = [];
	const end = "2026-10-12";
	for (let i = days - 1; i >= 0; i--) {
		const t = days - 1 - i;
		const dau = Math.round(400 + 120 * Math.sin(t / 5) + (t % 7 === 0 ? -150 : 0) + 80 * Math.sin(t / 31));
		series.push({ day: addDays(end, -i), dau: Math.max(0, dau), events: dau * 7 });
	}
	return {
		project: "demo-cli",
		days,
		generated_at: "2026-10-12T12:00:00Z",
		summary: { dau: 412, wau: 1532, mau: 4821, events: 1_234_567, today: { users: 97, events: 801 } },
		series,
		dims: {
			event: top("ev-", 10, 9000),
			version: top("1.0.", 20, 4000),
			os: { linux: [3000, 20000], darwin: [1200, 9000], windows: [800, 6000] },
			arch: { x64: [4000, 30000], arm64: [1000, 5000] },
			country: top("C", 20, 2500),
			ci: { false: [4500, 31000], true: [500, 4000] },
			"prop:command": top("cmd-", 20, 3000),
			"prop:shell": { zsh: [2000, 12000], bash: [1500, 9000], fish: [200, 1000] },
		},
	};
}

function renderProject(stats: Stats, days = stats.days): string {
	return String(ProjectView({ base: BASE, project, stats, days, snippets: fixtureSnippets, prompt: `Follow ${BASE}/demo-cli/install.md` }));
}

test("project page shows KPIs in compact tabular numbers", () => {
	const html = renderProject(fixtureStats(30));
	for (const label of ["Today", "DAU", "WAU", "MAU", "Events"]) expect(html).toContain(`<span>${label}</span>`);
	expect(html).toContain(">4.8k<");
	expect(html).toContain(">1.2M<");
	expect(html).toContain('title="1,234,567"');
	expect(html).toContain("<h1>Demo CLI</h1>");
	expect(html).toContain('aria-current="page"');
	expect(html).toContain('href="/demo-cli?days=90"');
});

test("chart is an accessible server-rendered SVG", () => {
	const html = renderProject(fixtureStats(30));
	expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Daily users and events, Sep 13 to Oct 12\./);
	expect(html).toContain("<title>Daily users");
	expect(html).toContain("<polyline");
	expect(html).toContain('<path d="M');
	expect(html).toContain(">Sep 13<");
	expect(html).toContain(">Oct 12<");
});

test("chart handles empty, all-zero and single-point series", () => {
	expect(usageChartSvg([])).toContain("No data in this range");
	expect(usageChartSvg([])).not.toContain("<polyline");
	const zero = usageChartSvg([
		{ day: "2026-01-01", dau: 0, events: 0 },
		{ day: "2026-01-02", dau: 0, events: 0 },
	]);
	expect(zero).toContain("No data in this range");
	expect(zero).not.toContain("NaN");
	const one = usageChartSvg([{ day: "2026-01-01", dau: 5, events: 20 }]);
	expect(one).toContain("<circle");
	expect(one).not.toContain("NaN");
	expect(one).toContain("Peak 5 users on Jan 1");
});

test("breakdown tables include prop dims, in order, top 20, sorted by events", () => {
	const html = renderProject(fixtureStats(30));
	expect(html).toContain("prop · command");
	expect(html).toContain("prop · shell");
	expect(html.indexOf("Operating systems")).toBeLessThan(html.indexOf("Countries"));
	expect(html.indexOf("Countries")).toBeLessThan(html.indexOf("prop · command"));
	expect(html).not.toContain("1.0.20<");
	const ordered = orderedDims({ zzz: {}, "prop:b": { x: [1, 1] }, os: { a: [1, 5], b: [2, 9] }, event: { e: [1, 1] } });
	expect(ordered.map(([d]) => d)).toEqual(["event", "os", "prop:b"]);
	expect(ordered[1]![1][0]![0]).toBe("b");
});

test("integrate section renders snippet tabs, prompt and links", () => {
	const html = renderProject(fixtureStats(30));
	expect(html).toContain('<input type="radio" name="snippet" id="tab-curl" checked');
	expect(html).toContain('<label for="tab-python">Python</label>');
	expect(html).toContain('id="code-ts"');
	expect(html).toContain('data-copy="#code-ts"');
	expect(html).toContain('id="agent-prompt"');
	expect(html).toContain("Follow https://telemetry.test/demo-cli/install.md");
	expect(html).toContain('href="/demo-cli/install.md"');
	expect(html).toContain('href="/api/demo-cli/stats?days=30"');
	expect(html).toContain("https://telemetry.test/demo-cli/v1");
});

test("no external scripts, stylesheets or fonts anywhere", () => {
	const pages = [
		renderProject(fixtureStats(30)),
		String(LandingView({ base: BASE, projects: [project] })),
		String(DocsView({ base: BASE })),
	];
	for (const html of pages) {
		expect(html).not.toContain("<script src=");
		expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
		expect(html).not.toContain("fonts.googleapis");
		expect(html).toContain("color-scheme:light");
	}
});

test("project page with 365 days of data stays under 40KB", () => {
	const html = renderProject(fixtureStats(365));
	expect(Buffer.byteLength(html)).toBeLessThan(40 * 1024);
});

test("empty stats render without errors", () => {
	const html = renderProject(emptyStats("demo-cli", 7), 7);
	expect(html).toContain("No events yet");
	expect(html).toContain("No data in this range");
	expect(html).not.toContain("Breakdown");
	expect(html).not.toContain("NaN");
	expect(html).toContain(">0<");
});

test("escapes user-controlled project fields", () => {
	const evil = { ...project, name: '<img src=x onerror="1">', description: "a & b <b>" };
	const html = String(ProjectView({ base: BASE, project: evil, stats: emptyStats("demo-cli", 30), days: 30, snippets: [], prompt: "" }));
	expect(html).not.toContain("<img src=x");
	expect(html).toContain("&lt;img src=x");
	expect(html).toContain("a &amp; b &lt;b&gt;");
});

test("unknown project returns a 404 page with the layout", async () => {
	const { env } = makeEnv();
	const res = await call(app, env, "/nope-x");
	expect(res.status).toBe(404);
	const html = await res.text();
	expect(html).toContain("Project not found");
	expect(html).toContain("<code>nope-x</code>");
	expect(html).toContain('class="site-header"');
	expect(html).toContain('href="/"');
	const bad = await call(app, env, "/Not_Valid");
	expect(bad.status).toBe(404);
});

test("landing page lists projects and has the create form", () => {
	const html = String(LandingView({ base: BASE, projects: [project, { ...project, slug: "other", name: null, description: null }] }));
	expect(html).toContain('id="projects"');
	expect(html).toContain('href="/demo-cli"');
	expect(html).toContain("Demo CLI");
	expect(html).toContain('href="/other">other</a>');
	expect(html).toContain("Jan 5, 2026");
	expect(html).toContain('<form id="create-form"');
	expect(html).toContain('pattern="^[a-z0-9][a-z0-9-]{1,38}$"');
	for (const f of ["slug", "name", "description", "homepage"]) expect(html).toContain(`<label for="${f}">`);
	expect(html).toContain('"/api/projects"');
	expect(html).toContain("curl -X POST https://telemetry.test/my-cli");
	expect(html).toContain("bunx cf deploy");
	expect(html).toContain("Usage telemetry for open-source projects");
	expect(String(LandingView({ base: BASE, projects: [] }))).toContain("No projects yet");
});

test("landing route renders even if the registry query fails", async () => {
	const { env } = makeEnv();
	const res = await call(app, env, "/");
	expect(res.status).toBe(200);
	const html = await res.text();
	expect(html).toContain('<form id="create-form"');
	expect(html).toContain('id="projects"');
});

test("docs page renders markdown inside the layout", async () => {
	const html = String(DocsView({ base: BASE }));
	expect(html).toContain('<article class="prose">');
	expect(html).toMatch(/<h1[^>]*>[^<]*API[^<]*<\/h1>/);
	expect(html).toContain("<code>https://telemetry.test</code>");
	const { env } = makeEnv();
	const res = await call(app, env, "/docs");
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/html");
});

test("compact number formatting", () => {
	expect(compact(0)).toBe("0");
	expect(compact(999)).toBe("999");
	expect(compact(1000)).toBe("1k");
	expect(compact(1234)).toBe("1.2k");
	expect(compact(12345)).toBe("12.3k");
	expect(compact(123456)).toBe("123k");
	expect(compact(1234567)).toBe("1.2M");
});

test("element ids are unique on every page, since the inline scripts find elements by id", () => {
	const pages = [
		renderProject(fixtureStats(30)),
		String(LandingView({ base: BASE, projects: [project] })),
		String(DocsView({ base: BASE })),
	];
	for (const html of pages) {
		const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
		expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
	}
});
