import { agentPrompt, type Snippet, snippets } from "../docs/content.ts";
import { DAY_RANGES, getStats, parseDays } from "../stats.ts";
import type { Ctx, Project, Stats } from "../types.ts";
import { baseUrl, isValidSlug } from "../util.ts";
import { UsageChart } from "./charts.tsx";
import { compact, dimLabel, fmtDate, full, pct } from "./format.ts";
import { CodeBlock, Layout, NotFoundView } from "./layout.tsx";

/** Owner: agent C. */
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

	return (
		<Layout title={`${name} · telemetry`} description={project.description || `Usage telemetry for ${name}`}>
			<h1>{name}</h1>
			{project.description && <p class="lead">{project.description}</p>}
			<p class="meta">
				{project.homepage && (
					<>
						<a href={project.homepage}>{project.homepage.replace(/^https?:\/\//, "")}</a>
						{" · "}
					</>
				)}
				<code>{project.slug}</code>
				{" · since "}
				<time datetime={project.created_at}>{fmtDate(project.created_at)}</time>
			</p>

			<div class="row" style="margin-top:28px;justify-content:space-between">
				<nav class="range" aria-label="Date range">
					{DAY_RANGES.map((d) => (
						<a href={`/${project.slug}?days=${d}`} aria-current={d === days ? "page" : undefined}>
							{d}d
						</a>
					))}
				</nav>
				<a class="small" href={`/api/${project.slug}/stats?days=${days}`}>
					Stats JSON
				</a>
			</div>

			<dl class="kpis">
				<Kpi label="Today" value={s.today.users} sub={`${compact(s.today.events)} events`} />
				<Kpi label="DAU" value={s.dau} sub="latest day" />
				<Kpi label="WAU" value={s.wau} sub="7-day users" />
				<Kpi label="MAU" value={s.mau} sub="30-day users" />
				<Kpi label="Events" value={s.events} sub={`last ${days} days`} />
			</dl>

			<h2>Daily users and events</h2>
			<figure>
				<UsageChart series={stats.series} />
				<figcaption class="legend">
					<i style="background:#2563eb"></i>daily users
					{"  "}
					<i style="background:#dbe4f5;margin-left:12px"></i>events
					{stats.series.length > 0 && ` · ${stats.series.length} days`}
				</figcaption>
			</figure>

			{!hasData && (
				<p class="empty" style="margin-top:24px">
					No events yet. Send one with the snippets below and it shows up in Today within a few minutes.
				</p>
			)}

			{dims.length > 0 && (
				<>
					<h2>Breakdown</h2>
					<div class="grid2">
						{dims.map(([dim, rows]) => (
							<Breakdown dim={dim} rows={rows} />
						))}
					</div>
				</>
			)}

			<h2 id="integrate">Integrate</h2>
			<p class="muted small">
				Ingest URL <code>{ingest}</code> · OTLP endpoint <code>{ingest}/v1</code>
			</p>
			<Snippets snippets={snippets} />

			<h3 style="margin-top:24px">Add it with your coding agent</h3>
			<p class="small muted">Copy this prompt into Claude Code, Codex or Cursor. It points the agent at the project playbook.</p>
			<CodeBlock id="agent-prompt" code={prompt} wrap />
			<p class="links">
				<a href={`/${project.slug}/install.md`}>install.md</a>
				<a href={`/api/${project.slug}/stats?days=${days}`}>stats JSON</a>
				<a href="/docs">API docs</a>
			</p>

			<hr />
			<p class="small muted">
				Raw events kept 90 days in Analytics Engine; daily aggregates kept in D1. Numbers update daily at 00:10 UTC; Today updates
				every ~5 min. Users are hashed install ids, never IPs.
			</p>
		</Layout>
	);
}

function Kpi({ label, value, sub }: { label: string; value: number; sub: string }) {
	return (
		<div class="kpi">
			<dt>
				<span>{label}</span>
			</dt>
			<dd style="margin:0">
				<b class="num" title={full(value)}>
					{compact(value)}
				</b>
				<small>{sub}</small>
			</dd>
		</div>
	);
}

function Breakdown({ dim, rows }: { dim: string; rows: [string, number, number][] }) {
	const total = rows.reduce((a, r) => a + r[2], 0);
	return (
		<section>
			<h3>{dimLabel(dim)}</h3>
			<div class="tbl">
				<table>
					<thead>
						<tr>
							<th scope="col">Value</th>
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
									{value || <span class="muted">(empty)</span>}
									<i class="bar" style={`width:${pct(events, total)}%`} aria-hidden="true"></i>
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
		</section>
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
