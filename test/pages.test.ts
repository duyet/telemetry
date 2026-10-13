import { expect, test } from "bun:test";
import { app } from "../src/index.ts";
import { sparklineSvg, usageChartSvg } from "../src/pages/charts.tsx";
import { DocsView, headingId } from "../src/pages/docs.tsx";
import { compact } from "../src/pages/format.ts";
import { LandingView, STRIP_MAX } from "../src/pages/landing.tsx";
import { emptyStats, orderedDims, ProjectView } from "../src/pages/project.tsx";
import type { Project, RegistryEntry, Stats } from "../src/types.ts";
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

const entry: RegistryEntry = { ...project, series: Array.from({ length: 30 }, (_, i) => 100 + ((i * 37) % 50)), dau: 412 };

/** `n` distinct registry entries, so the strip and the list can be told apart from the fixture project. */
function entries(n: number): RegistryEntry[] {
	return Array.from({ length: n }, (_, i) => ({ ...entry, slug: `proj-${i}`, name: null, description: null, dau: i }));
}

/** Every `href="#x"` in the rail TOC must point at an element on the same page. */
function tocTargets(html: string): { links: string[]; missing: string[] } {
	const toc = html.match(/<ol class="toc"[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? "";
	const links = [...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
	return { links, missing: links.filter((id) => !html.includes(`id="${id}"`)) };
}

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

test("project page states the KPIs as one sentence with compact tabular numbers", () => {
	const html = renderProject(fixtureStats(30));
	expect(html).toMatch(/<em class="num" title="412">412<\/em> people used it yesterday/);
	expect(html).toContain(">1.5k</span> this week");
	expect(html).toContain(">4.8k</span> this month");
	expect(html).toContain(">97</span> users and");
	expect(html).toContain(">1.2M</span> events in the last 30 days");
	expect(html).toContain('title="1,234,567"');
	expect(html).toContain('<h1 class="title">Demo CLI<span> · A command line tool that reports usage here.</span></h1>');
	expect(html).toContain('href="https://github.com/duyet/demo-cli"');
	expect(html).toContain('href="/demo-cli?days=30" aria-current="page"');
	expect(html).toContain('href="/demo-cli?days=90"');
});

test("chart is an accessible server-rendered SVG", () => {
	const html = renderProject(fixtureStats(30));
	expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Daily users and events, Sep 13 to Oct 12\./);
	expect(html).toContain("<title>Daily users");
	expect(html).toContain("<polyline");
	expect(html).toContain('<path d="M');
	// Scale and date labels are HTML next to the SVG so they stay legible when the SVG shrinks on a phone.
	expect(html).toContain("<span>Sep 13</span>");
	expect(html).toContain("<span>Oct 12</span>");
	expect(html).toMatch(/<span>\d+ users<\/span>/);
	expect(html).not.toMatch(/<text[^>]*>Sep 13</);
});

test("sparkline is a tiny decorative SVG that never produces NaN", () => {
	expect(sparklineSvg([])).not.toContain("<polyline");
	expect(sparklineSvg([0, 0, 0])).not.toContain("NaN");
	expect(sparklineSvg([5])).toContain("<circle");
	const svg = sparklineSvg([1, 4, 2]);
	expect(svg).toContain('aria-hidden="true"');
	expect(svg).toContain("<polyline");
	expect(svg).not.toContain("NaN");
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

test("no external scripts, stylesheets or fonts anywhere; fonts come from /fonts/", () => {
	const pages = [
		renderProject(fixtureStats(30)),
		String(LandingView({ base: BASE, projects: [entry] })),
		String(DocsView({ base: BASE })),
	];
	for (const html of pages) {
		expect(html).not.toContain("<script src=");
		expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
		expect(html).not.toContain("fonts.googleapis");
		expect(html).toContain("color-scheme:light");
		for (const m of html.matchAll(/url\(([^)]+)\)/g)) expect(m[1]).toMatch(/^\/fonts\//);
		for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) expect(m[1]).toMatch(/^(\/fonts\/|data:)/);
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
	expect(html).toContain(">0</em> people used it yesterday");
	expect(tocTargets(html).missing).toEqual([]);
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
	expect(html).toContain("There is no project called <code>nope-x</code>");
	expect(html).toContain('<aside class="rail">');
	expect(html).toContain('<main class="column">');
	expect(html).toContain('href="/"');
	const bad = await call(app, env, "/Not_Valid");
	expect(bad.status).toBe(404);
});

test("landing page lists the registry with sparklines and has no create form", () => {
	const html = String(LandingView({ base: BASE, projects: [entry, { ...entry, slug: "other", name: null, description: null, dau: 1200 }] }));
	expect(html).toContain('id="projects"');
	expect(html).toContain('href="/demo-cli">Demo CLI</a>');
	expect(html).toContain('href="/other">other</a>');
	expect(html).toContain("2 projects, all public");
	expect(html).toContain("1.2k <span>users/day</span>");
	expect(html.match(/<polyline/g)?.length).toBe(4); // two strip tiles and two rows
	expect(html).not.toContain("<form");
	expect(html).not.toContain("Create a project");
	expect(html).not.toContain('"/api/projects"');
	expect(html).toContain("curl -X POST https://telemetry.test/my-cli");
	expect(html).toContain("Save the admin token");
	expect(html).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=https://telemetry.test/my-cli");
	expect(html).toContain("bunx cf deploy");
	expect(html).toContain('href="https://github.com/duyet/telemetry"');
	expect(html).toContain('<a href="https://duyet.net">by duyet</a>');
});

test("masthead strip shows at most five tiles and a quiet line when there are none", () => {
	const many = String(LandingView({ base: BASE, projects: entries(8) }));
	const strip = many.match(/<div class="masthead-strip">([\s\S]*?)<\/div>/)![1]!;
	expect(strip.match(/<a /g)?.length).toBe(STRIP_MAX);
	expect(strip).toContain('href="/proj-4"');
	expect(strip).not.toContain('href="/proj-5"');
	expect(many).toContain("8 projects, all public");
	expect(many).toContain('href="/proj-7"'); // the full list still has it

	const none = String(LandingView({ base: BASE, projects: [] }));
	expect(none).not.toContain('class="masthead-strip"');
	expect(none).toContain("No active projects yet");
	expect(none).toContain("0 projects, all public");

	const down = String(LandingView({ base: BASE, projects: null }));
	expect(down).toContain("temporarily unavailable");
});

test("rail TOC links match section ids on every page", () => {
	const pages = [
		String(LandingView({ base: BASE, projects: [entry] })),
		renderProject(fixtureStats(30)),
		String(DocsView({ base: BASE })),
	];
	for (const html of pages) {
		const { links, missing } = tocTargets(html);
		expect(links.length).toBeGreaterThan(3);
		expect(missing).toEqual([]);
	}
	const { links } = tocTargets(pages[0]!);
	expect(links).toEqual(["how", "events", "otlp", "agent", "projects", "self-host", "privacy"]);
	expect(tocTargets(pages[1]!).links).toEqual(["overview", "users", "breakdown", "integrate"]);
});

test("landing route renders even if the registry query fails", async () => {
	const { env } = makeEnv();
	const res = await call(app, env, "/");
	expect(res.status).toBe(200);
	const html = await res.text();
	expect(html).toContain("No active projects yet");
	expect(html).toContain('id="projects"');
	expect(html).not.toContain("<form");
});

test("docs page renders markdown inside the layout with a TOC from the h2 headings", async () => {
	const html = String(DocsView({ base: BASE }));
	expect(html).toContain('<article class="prose lede">');
	expect(html).toMatch(/<h1[^>]*>[^<]*API[^<]*<\/h1>/);
	expect(html).toContain("<code>https://telemetry.test</code>");
	expect(html).toContain('<h2 id="sending-events">Sending events</h2>');
	expect(html).toContain('<a href="#sending-events">Sending events</a>');
	expect(headingId("Limits & free tier")).toBe("limits-free-tier");
	expect(headingId("<code>OTLP</code> v1")).toBe("otlp-v1");
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
		String(LandingView({ base: BASE, projects: [entry] })),
		String(DocsView({ base: BASE })),
	];
	for (const html of pages) {
		const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
		expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
	}
});
