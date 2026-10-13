import { raw } from "hono/html";
import { agentPrompt } from "../docs/content.ts";
import { queryProjects } from "../projects.ts";
import type { Ctx, Project } from "../types.ts";
import { baseUrl } from "../util.ts";
import { fmtDate } from "./format.ts";
import { CodeBlock, Layout, REPO } from "./layout.tsx";

/** Owner: agent C. */
export async function landingPage(c: Ctx) {
	const base = baseUrl(c.req.raw);
	let projects: Project[] | null;
	try {
		projects = await queryProjects(c.env.DB);
	} catch (err) {
		console.error("queryProjects failed", err);
		projects = null;
	}
	return c.html(<LandingView base={base} projects={projects} />);
}

const CREATE_SCRIPT = `
var f=document.getElementById("create"),out=document.getElementById("created"),err=document.getElementById("create-error");
function put(id,v){var el=document.getElementById(id);if(el)el.textContent=v}
function link(id,v){var el=document.getElementById(id);if(el){el.href=v;el.textContent=v}}
f.addEventListener("submit",function(e){e.preventDefault();err.hidden=true;var btn=f.querySelector("button[type=submit]");btn.disabled=true;
var body={};new FormData(f).forEach(function(v,k){if(v)body[k]=v});
fetch("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){
return r.json().catch(function(){return {}}).then(function(j){
if(!r.ok){err.textContent=j.error||(r.status===409?"That slug is already taken.":r.status===429?"Too many projects created from this address today. Try again tomorrow.":r.status===400?"Check the fields and try again.":"Request failed ("+r.status+").");err.hidden=false;return}
var base=location.origin,s=j.slug;
put("r-token",j.admin_token||"");put("r-url",j.ingest_url||base+"/"+s);put("r-prompt",f.getAttribute("data-prompt").split("{slug}").join(s));
link("r-page",base+"/"+s);link("r-install",base+"/"+s+"/install.md");
f.hidden=true;out.hidden=false;out.scrollIntoView({block:"start"})})
}).catch(function(){err.textContent="Network error. Try again.";err.hidden=false}).then(function(){btn.disabled=false})});
`.trim();

export function LandingView({ base, projects }: { base: string; projects: Project[] | null }) {
	const promptTemplate = agentPrompt(base, "{slug}");
	return (
		<Layout
			title="telemetry · usage telemetry for open-source projects"
			description="Free, self-hosted, privacy-first usage telemetry for CLIs, desktop apps, web and OTLP. Runs on Cloudflare Workers."
		>
			<h1>Usage telemetry for open-source projects</h1>
			<p class="lead">Free, self-hosted and privacy-first. Works for CLIs, desktop apps, web pages and anything that speaks OTLP.</p>
			<p class="row" style="margin-top:20px">
				<a class="btn primary" href="#create">
					Create a project
				</a>
				<a href="/docs">Read the API docs</a>
			</p>

			<h2>How it works</h2>
			<div class="steps">
				<div class="step">
					<h3>Create a project</h3>
					<p class="small muted">Pick a slug. You get an admin token and an ingest URL. No account.</p>
					<CodeBlock id="how-1" code={`curl -X POST ${base}/api/projects \\\n  -d '{"slug":"my-cli"}'`} />
				</div>
				<div class="step">
					<h3>Send events</h3>
					<p class="small muted">One POST per event. The id is a random string your client keeps; it is hashed on arrival.</p>
					<CodeBlock
						id="how-2"
						code={`curl -X POST ${base}/my-cli \\\n  -d '{"event":"ping","id":"<random-id>","version":"1.0.0"}'`}
					/>
				</div>
				<div class="step">
					<h3>See usage</h3>
					<p class="small muted">DAU, WAU, MAU, versions, platforms and countries on a public page, and as JSON.</p>
					<CodeBlock id="how-3" code={`open ${base}/my-cli\ncurl ${base}/api/my-cli/stats?days=30`} />
				</div>
			</div>

			<h2 id="projects">Projects</h2>
			<Registry projects={projects} />

			<h2 id="create">Create a project</h2>
			<div class="card">
				<form id="create" data-prompt={promptTemplate} autocomplete="off">
					<div class="field">
						<label for="slug">Slug</label>
						<input type="text" id="slug" name="slug" required pattern="^[a-z0-9][a-z0-9-]{1,38}$" placeholder="my-cli" />
						<p class="hint">
							Lowercase letters, digits and dashes, 2–39 characters: <code>^[a-z0-9][a-z0-9-]{"{1,38}"}$</code>
						</p>
					</div>
					<div class="field">
						<label for="name">Name</label>
						<input type="text" id="name" name="name" maxlength={80} placeholder="My CLI" />
					</div>
					<div class="field">
						<label for="description">Description</label>
						<input type="text" id="description" name="description" maxlength={200} placeholder="What the project does" />
					</div>
					<div class="field">
						<label for="homepage">Homepage</label>
						<input type="url" id="homepage" name="homepage" placeholder="https://github.com/you/my-cli" />
					</div>
					<button type="submit" class="primary">
						Create project
					</button>
					<p id="create-error" class="err" role="alert" hidden></p>
				</form>
				<div id="created" class="result" hidden>
					<p class="warn">
						<b>Save the admin token now.</b> It is shown once and never again. You need it to import history or delete the
						project.
					</p>
					<dl>
						<dt>Admin token</dt>
						<dd class="code">
							<button type="button" class="copy" data-copy="#r-token" aria-label="Copy admin token">
								Copy
							</button>
							<pre>
								<code id="r-token"></code>
							</pre>
						</dd>
						<dt>Ingest URL</dt>
						<dd class="code">
							<button type="button" class="copy" data-copy="#r-url" aria-label="Copy ingest URL">
								Copy
							</button>
							<pre>
								<code id="r-url"></code>
							</pre>
						</dd>
						<dt>Project page</dt>
						<dd>
							<a id="r-page" href="/"></a>
						</dd>
						<dt>Agent playbook</dt>
						<dd>
							<a id="r-install" href="/"></a>
						</dd>
						<dt>Agent prompt</dt>
						<dd class="code">
							<button type="button" class="copy" data-copy="#r-prompt" aria-label="Copy agent prompt">
								Copy
							</button>
							<pre>
								<code id="r-prompt"></code>
							</pre>
						</dd>
					</dl>
				</div>
			</div>
			<script>{raw(CREATE_SCRIPT)}</script>

			<h2>Add it with your coding agent</h2>
			<p class="muted">
				Every project page has a <b>Copy agent prompt</b> button and a <code>/&lt;project&gt;/install.md</code> playbook. Paste
				the prompt into Claude Code, Codex or Cursor and the agent wires the client in, with opt-out and a README section.
			</p>
			<CodeBlock id="agent-example" code={agentPrompt(base, "my-cli")} wrap />

			<h2>Self-host</h2>
			<p class="muted">One Worker, one D1 database, one Analytics Engine dataset. The schema applies itself on first request.</p>
			<CodeBlock id="selfhost" code={`git clone ${REPO} && cd telemetry && bun install && bunx cf deploy`} />
			<p class="small muted">Enable Analytics Engine once in the Cloudflare dashboard (Workers &amp; Pages → Analytics Engine). Free tier covers it.</p>
		</Layout>
	);
}

function Registry({ projects }: { projects: Project[] | null }) {
	if (projects === null) return <p class="empty">The registry is temporarily unavailable.</p>;
	if (projects.length === 0)
		return (
			<p class="empty">
				No projects yet. <a href="#create">Create the first one.</a>
			</p>
		);
	return (
		<div class="tbl">
			<table>
				<thead>
					<tr>
						<th scope="col">Project</th>
						<th scope="col">Description</th>
						<th scope="col" class="n">
							Created
						</th>
					</tr>
				</thead>
				<tbody>
					{projects.map((p) => (
						<tr>
							<td>
								<a href={`/${p.slug}`}>{p.name || p.slug}</a>
								{p.name && (
									<>
										{" "}
										<span class="muted small">{p.slug}</span>
									</>
								)}
							</td>
							<td class="muted">{p.description}</td>
							<td class="n muted small">
								<time datetime={p.created_at}>{fmtDate(p.created_at)}</time>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
