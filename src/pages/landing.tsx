import { agentPrompt } from "../docs/content.ts";
import { queryRegistry } from "../projects.ts";
import type { Ctx, RegistryEntry } from "../types.ts";
import { baseUrl } from "../util.ts";
import { Sparkline } from "./charts.tsx";
import { compact, full } from "./format.ts";
import { CodeBlock, GITHUB_ICON, LANDING_CSS, Layout, Masthead, MastheadLine, REPO, Rules, Section, type TocEntry } from "./layout.tsx";

/** Owner: frontend agent. */
export async function landingPage(c: Ctx) {
	const base = baseUrl(c.req.raw);
	let projects: RegistryEntry[] | null;
	try {
		projects = await queryRegistry(c.env.DB);
	} catch (err) {
		console.error("queryRegistry failed", err);
		projects = null;
	}
	return c.html(<LandingView base={base} projects={projects} />);
}

export const LANDING_TOC: TocEntry[] = [
	{ id: "how", label: "How it works" },
	{ id: "events", label: "Send events" },
	{ id: "otlp", label: "OpenTelemetry" },
	{ id: "agent", label: "With an agent" },
	{ id: "projects", label: "Projects" },
	{ id: "self-host", label: "Self-host" },
	{ id: "privacy", label: "Privacy" },
];

/** At most this many tiles in the masthead strip. */
export const STRIP_MAX = 5;

export function LandingView({ base, projects }: { base: string; projects: RegistryEntry[] | null }) {
	const count = projects?.length ?? 0;
	const strip = (projects ?? []).slice(0, STRIP_MAX);
	return (
		<Layout
			title="telemetry · usage analytics for open source"
			description="Free, self-hosted usage telemetry for CLIs, desktop apps, web pages and OTLP. One POST creates the project. Runs on Cloudflare Workers."
			toc={LANDING_TOC}
			current="home"
			css={LANDING_CSS}
		>
			<Masthead
				name="telemetry"
				tagline="usage analytics for open source"
				icons={[{ href: REPO, label: "telemetry on GitHub", svg: GITHUB_ICON }]}
			>
				<p class="statement">
					Send one POST from your app and see <em>who uses it</em>. No sign-up: the first event creates the project.
				</p>
				<Strip projects={strip} unavailable={projects === null} />
				<MastheadLine
					items={[
						"/telemetry",
						<a href="#projects">
							{count === 1 ? "1 project, public" : `${count} projects, all public`}
						</a>,
						<a href="https://duyet.net">by duyet</a>,
						"MIT",
						<a href="#self-host">Self-host ↓</a>,
					]}
				/>
			</Masthead>

			<div class="lede">
				<p>
					Daily, weekly and monthly users, versions, platforms and countries, on a public page and as JSON. It works for
					CLIs, desktop apps, web pages and anything that speaks OTLP, and runs inside the Cloudflare free plan.
				</p>
			</div>

			<Section id="how" index={1} title="How it works">
				<ol class="steps">
					<li>
						<span>1</span>
						<span>
							Pick a slug: lowercase letters, digits and dashes, like <code>my-cli</code>.
						</span>
					</li>
					<li>
						<span>2</span>
						<span>Send the first event. It creates the project and returns your admin token, once.</span>
					</li>
					<li>
						<span>3</span>
						<span>
							Open <code>{base}/my-cli</code>.
						</span>
					</li>
				</ol>
				<CodeBlock
					id="how-curl"
					code={`curl -X POST ${base}/my-cli \\\n  -d '{"event":"ping","id":"<random-id>","version":"1.0.0"}'\n\n→ {"accepted":1,"dropped":0,"project":{"slug":"my-cli","created":true,\n    "admin_token":"tk_…","page_url":"${base}/my-cli"}}`}
				/>
				<p class="note">Save the admin token. It renames the project, rotates the token, and imports history.</p>
			</Section>

			<Section id="events" index={2} title="Send events">
				<p>
					One JSON object per event, or an array of up to 25. The <code>id</code> is a random string your client keeps; the
					server hashes it with a secret salt and never stores it raw.
				</p>
				<Rules
					rows={[
						[<code>event</code>, "Required. A name like ping, run or build. Letters, digits, _ . : / and -, up to 64 characters."],
						[<code>id</code>, "Random install id the client persists. With it, users are counted across days. Without it, daily users only."],
						[<code>version</code>, "App version, up to 32 characters."],
						[
							<>
								<code>os</code>, <code>arch</code>
							</>,
							"What the runtime reports: linux, darwin, windows; x64, arm64. Do not remap them.",
						],
						[<code>ci</code>, "true when the event came from a CI run."],
						[<code>props</code>, "Up to 8 extra keys with short string, number or boolean values. Keep them categorical."],
						[<code>n</code>, "Occurrence count, 1 to 1000. Default 1."],
					]}
				/>
				<p class="note">
					The country comes from Cloudflare. The IP and user agent are never stored. Full rules in the{" "}
					<a href="/docs">API docs</a>.
				</p>
			</Section>

			<Section id="otlp" index={3} title="OpenTelemetry">
				<p>Any OpenTelemetry SDK or collector can send to the same project. Point it at the project URL with JSON encoding.</p>
				<CodeBlock id="otlp-env" code={`export OTEL_EXPORTER_OTLP_ENDPOINT=${base}/my-cli\nexport OTEL_EXPORTER_OTLP_PROTOCOL=http/json`} />
				<p class="note">
					Logs, traces and metrics become events. Set <code>service.instance.id</code> as a resource attribute to count users.
				</p>
			</Section>

			<Section id="agent" index={4} title="With an agent">
				<p>
					Every project has a playbook at <code>/&lt;slug&gt;/install.md</code>. Paste this prompt into Claude Code, Codex or
					Cursor and the agent wires the client in, with an opt-out env var and a Telemetry section in the README.
				</p>
				<CodeBlock id="agent-example" code={agentPrompt(base, "my-cli")} wrap />
			</Section>

			<Section id="projects" index={5} title="Projects">
				<Registry projects={projects} />
			</Section>

			<Section id="self-host" index={6} title="Self-host">
				<p>One Worker, one D1 database, one Analytics Engine dataset. The schema applies itself on first request.</p>
				<CodeBlock id="selfhost" code={`git clone ${REPO} && cd telemetry && bun install && bunx cf deploy`} />
				<p class="note">Enable Analytics Engine once in the Cloudflare dashboard, under Workers &amp; Pages. The free tier covers it.</p>
			</Section>

			<Section id="privacy" index={7} title="Privacy">
				<p>Ids are hashed with a secret salt before they are stored, and the raw id is never written anywhere.</p>
				<p>IP addresses and user agents are never stored. Raw events are deleted after 90 days; only daily counts stay.</p>
				<p>Every project page and its JSON are public. Send nothing you would not publish as an aggregate.</p>
			</Section>

			<footer class="colophon">
				<p>
					Free, self-hosted on Cloudflare Workers. <a href={REPO}>Source</a> · <a href="/docs">API docs</a> ·{" "}
					<a href="/llms.txt">llms.txt</a>
				</p>
			</footer>
		</Layout>
	);
}

function Strip({ projects, unavailable }: { projects: RegistryEntry[]; unavailable: boolean }) {
	if (unavailable) return <p class="masthead-empty">The registry is temporarily unavailable.</p>;
	if (projects.length === 0) return <p class="masthead-empty">No active projects yet. The first event you send will appear here.</p>;
	return (
		<div class="masthead-strip">
			{projects.map((p) => (
				<a href={`/${p.slug}`} title={p.name || p.slug}>
					<Sparkline series={p.series} />
					<b>{p.slug}</b>
					<span class="num" title={`${full(p.dau)} users on the latest day`}>
						{compact(p.dau)} users/day
					</span>
				</a>
			))}
		</div>
	);
}

function Registry({ projects }: { projects: RegistryEntry[] | null }) {
	if (projects === null) return <p class="empty">The registry is temporarily unavailable.</p>;
	if (projects.length === 0) return <p class="empty">No active projects yet. Send an event and yours will be the first.</p>;
	return (
		<ul class="rows">
			{projects.map((p) => (
				<li>
					<Sparkline series={p.series} />
					<div class="what">
						<a href={`/${p.slug}`}>{p.name || p.slug}</a>
						{p.name && <span>{p.slug}</span>}
						{p.description && <span>{p.description}</span>}
					</div>
					<div class="dau num" title={`${full(p.dau)} users on the latest day`}>
						{compact(p.dau)} <span>users/day</span>
					</div>
				</li>
			))}
		</ul>
	);
}
