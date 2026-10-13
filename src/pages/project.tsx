import { agentPrompt, type Snippet, snippets } from "../docs/content.ts";
import { DAY_RANGES, getStats, parseDays } from "../stats.ts";
import type { Ctx, Project, Stats } from "../types.ts";
import { baseUrl, isValidSlug } from "../util.ts";
import { UsageChart } from "./charts.tsx";
import { compact, dimLabel, fmtDate, full, pct } from "./format.ts";
import { CodeBlock, GITHUB_ICON, Layout, Masthead, MastheadLine, NotFoundView, PROJECT_CSS, Section, type TocEntry } from "./layout.tsx";

/** Owner: frontend agent. */
export async function projectPage(c: Ctx, slug: string) {
	const base = baseUrl(c.req.raw);
	if (!isValidSlug(slug)) return c.html(<NotFoundView what={slug} />, 404);
	const project = await c.env.DB.prepare("SELECT slug,name,description,homepage,created_at FROM projects WHERE slug=?")
		.bind(slug)
		.first<Project>();
	if (!project) return c.html(<NotFoundView what={slug} />, 404);

	const days = parseDays(c.req.query("days"));
	let stats: Stats;
	try {
		stats = await getStats(c.env, slug, days);
	} catch (err) {
		console.error("getStats failed", slug, err);
		stats = emptyStats(slug, days);
	}
	return c.html(
		<ProjectView base={base} project={project} stats={stats} days={days} snippets={snippets(base, slug)} prompt={agentPrompt(base, slug)} />,
	);
}

export function emptyStats(project: string, days: number): Stats {
	return {
		project,
		days,
		generated_at: new Date().toISOString(),
		summary: { dau: 0, wau: 0, mau: 0, events: 0, today: { users: 0, events: 0 } },
		series: [],
		dims: {},
	};
}

const DIM_ORDER = ["event", "version", "os", "arch", "country", "ci", "source"];

/** Known dims in a fixed order, then prop:* alphabetically, then anything else. Empty dims are dropped. */
export function orderedDims(dims: Stats["dims"]): [string, [string, number, number][]][] {
	const names = Object.keys(dims).filter((d) => Object.keys(dims[d] ?? {}).length > 0);
	const rank = (d: string) => {
		const i = DIM_ORDER.indexOf(d);
		if (i >= 0) return i;
		return d.startsWith("prop:") ? 100 : 200;
	};
	names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
	return names.map((d) => [
		d,
		Object.entries(dims[d]!)
			.map(([v, [users, events]]) => [v, users, events] as [string, number, number])
			.sort((a, b) => b[2] - a[2] || b[1] - a[1])
			.slice(0, 20),
	]);
}

export const PROJECT_TOC: TocEntry[] = [
	{ id: "overview", label: "Overview" },
	{ id: "users", label: "Users" },
	{ id: "breakdown", label: "Breakdown" },
	{ id: "integrate", label: "Integrate" },
];

const LINK_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h-2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-2M9.5 3h3.5v3.5M13 3l-6 6"/></svg>`;

export function ProjectView({
	base,
	project,
	stats,
	days,
	snippets,
	prompt,
}: {
	base: string;
	project: Project;
	stats: Stats;
	days: number;
	snippets: Snippet[];
	prompt: string;
}) {
	const name = project.name || project.slug;
	const s = stats.summary;
	const dims = orderedDims(stats.dims);
	const ingest = `${base}/${project.slug}`;
	const hasData = stats.series.some((p) => p.dau > 0 || p.events > 0) || s.today.events > 0;
	const home = project.homepage;
	const icons = home
		? [{ href: home, label: home.replace(/^https?:\/\//, ""), svg: /github\.com\//.test(home) ? GITHUB_ICON : LINK_ICON }]
		: [];
	const toc = dims.length > 0 ? PROJECT_TOC : PROJECT_TOC.filter((t) => t.id !== "breakdown");

	return (
		<Layout title={`${name} · telemetry`} description={project.description || `Usage telemetry for ${name}`} toc={toc} current="projects" css={PROJECT_CSS}>
			<Masthead name={name} tagline={project.description} icons={icons}>
				<p class="statement kpi" id="overview">
					<N value={s.dau} /> {s.dau === 1 ? "person" : "people"} used it yesterday ·{" "}
					<span class="num" title={full(s.wau)}>
						{compact(s.wau)}
					</span>{" "}
					this week ·{" "}
					<span class="num" title={full(s.mau)}>
						{compact(s.mau)}
					</span>{" "}
					this month.
				</p>
				<MastheadLine
					items={[
						`/${project.slug}`,
						home && <a href={home}>{home.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a>,
						<>
							since <time datetime={project.created_at}>{fmtDate(project.created_at)}</time>
						</>,
						<a href={`/api/${project.slug}/stats?days=${days}`}>Stats JSON</a>,
					].filter(Boolean)}
				/>
			</Masthead>

			<div class="lede">
				<p class="t2">
					<span class="num" title={full(s.today.users)}>
						{compact(s.today.users)}
					</span>{" "}
					{s.today.users === 1 ? "user" : "users"} and{" "}
					<span class="num" title={full(s.today.events)}>
						{compact(s.today.events)}
					</span>{" "}
					events so far today, live.{" "}
					<span class="num" title={full(s.events)}>
						{compact(s.events)}
					</span>{" "}
					events in the last {days} days.
				</p>
				<ul class="range" aria-label="Date range">
					{DAY_RANGES.map((d) => (
						<li>
							<a href={`/${project.slug}?days=${d}`} aria-current={d === days ? "page" : undefined}>
								{d} days
							</a>
						</li>
					))}
				</ul>
			</div>

			<Section id="users" index={1} title="Daily users">
				<figure class="wide">
					<UsageChart series={stats.series} />
					<figcaption>
						The line is daily users; the bars are events on their own scale.
						{stats.series.length > 0 && ` ${stats.series.length} days.`} Yesterday closes at 00:10 UTC; today refreshes every
						few minutes.
					</figcaption>
				</figure>
				{!hasData && (
					<p class="empty" style="margin-top:24px">
						No events yet. Send one with the snippets below and it shows up here within a few minutes.
					</p>
				)}
			</Section>

			{dims.length > 0 && (
				<Section id="breakdown" index={2} title="Breakdown">
					{dims.map(([dim, rows]) => (
						<Breakdown dim={dim} rows={rows} />
					))}
				</Section>
			)}

			<Section id="integrate" index={dims.length > 0 ? 3 : 2} title="Integrate">
				<p>
					Ingest URL <code>{ingest}</code>, OTLP endpoint <code>{ingest}/v1</code>. Pick a client below, or let an agent do
					it.
				</p>
				<Snippets snippets={snippets} />
				<h3 style="margin-top:28px">With an agent</h3>
				<p class="t2">Copy this prompt into Claude Code, Codex or Cursor. It points the agent at the project playbook.</p>
				<CodeBlock id="agent-prompt" code={prompt} wrap />
				<p class="links">
					<a href={`/${project.slug}/install.md`}>install.md</a>
					<a href={`/api/${project.slug}/stats?days=${days}`}>stats JSON</a>
					<a href="/docs">API docs</a>
				</p>
			</Section>

			<footer class="colophon">
				<p>
					Raw events are kept 90 days in Analytics Engine; daily aggregates stay in D1. Users are hashed install ids, never
					IPs.
				</p>
			</footer>
		</Layout>
	);
}

/** The headline number of the page, in the serif italic with lining figures. */
function N({ value }: { value: number }) {
	return (
		<em class="num" title={full(value)}>
			{compact(value)}
		</em>
	);
}

function Breakdown({ dim, rows }: { dim: string; rows: [string, number, number][] }) {
	const total = rows.reduce((a, r) => a + r[2], 0);
	return (
		<div class="tbl">
			<table>
				<thead>
					<tr>
						<th scope="col">{dimLabel(dim)}</th>
						<th scope="col" class="n" title="Daily users summed over the range">
							User-days
						</th>
						<th scope="col" class="n">
							Events
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(([value, users, events]) => (
						<tr>
							<td>
								{(dim === "country" ? value.toUpperCase() : value) || <span class="muted">(empty)</span>}
								<span class="bar" style={`width:${pct(events, total)}%`} aria-hidden="true"></span>
							</td>
							<td class="n num" title={full(users)}>
								{compact(users)}
							</td>
							<td class="n num" title={full(events)}>
								{compact(events)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** CSS-only tabs: radio inputs + labels; the checked input reveals the panel at the same index. */
function Snippets({ snippets }: { snippets: Snippet[] }) {
	if (snippets.length === 0) return null;
	return (
		<div class="tabs">
			{snippets.map((s, i) => (
				<>
					<input type="radio" name="snippet" id={`tab-${s.id}`} checked={i === 0} />
					<label for={`tab-${s.id}`}>{s.label}</label>
				</>
			))}
			{snippets.map((s) => (
				<div class="panel">
					<CodeBlock id={`code-${s.id}`} code={s.code} lang={s.lang} />
				</div>
			))}
		</div>
	);
}
