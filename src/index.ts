import { Hono } from "hono";
import { cors } from "hono/cors";
import { ensureReady, projectExists } from "./db.ts";
import { handleIngest, handleOtlp } from "./ingest.ts";
import { agentsMd, installMd, llmsTxt } from "./notes.ts";
import { docsPage } from "./pages/docs.tsx";
import { landingPage } from "./pages/landing.tsx";
import { projectPage } from "./pages/project.tsx";
import { createProject, deleteProject, importRollups, listProjects, rollupProject } from "./projects.ts";
import { runRollup } from "./rollup.ts";
import { getStats, parseDays } from "./stats.ts";
import type { App, Bindings } from "./types.ts";
import { baseUrl, isValidSlug } from "./util.ts";

export const app = new Hono<App>();

app.use("*", async (c, next) => {
	await ensureReady(c.env.DB);
	await next();
});
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], maxAge: 86400 }));

app.get("/health", (c) => c.text("ok"));
app.get("/", landingPage);
app.get("/docs", docsPage);
app.get("/llms.txt", (c) => c.text(llmsTxt(baseUrl(c.req.raw))));
app.get("/AGENTS.md", (c) => c.text(agentsMd(baseUrl(c.req.raw)), 200, { "content-type": "text/markdown; charset=utf-8" }));

app.get("/api/projects", listProjects);
app.post("/api/projects", createProject);
app.get("/api/:proj/stats", async (c) => {
	const slug = c.req.param("proj");
	if (!isValidSlug(slug) || !(await projectExists(c.env.DB, slug))) return c.json({ error: "project not found" }, 404);
	return c.json(await getStats(c.env, slug, parseDays(c.req.query("days"))));
});
app.post("/api/:proj/import", (c) => importRollups(c, c.req.param("proj")));
app.post("/api/:proj/rollup", (c) => rollupProject(c, c.req.param("proj")));
app.delete("/api/:proj", (c) => deleteProject(c, c.req.param("proj")));

app.get("/:proj/install.md", async (c) => {
	const slug = c.req.param("proj");
	if (!isValidSlug(slug) || !(await projectExists(c.env.DB, slug))) return c.text("project not found", 404);
	return c.text(installMd(baseUrl(c.req.raw), slug), 200, { "content-type": "text/markdown; charset=utf-8" });
});
app.post("/:proj/v1/:signal{logs|traces|metrics}", (c) =>
	handleOtlp(c, c.req.param("proj"), c.req.param("signal") as "logs" | "traces" | "metrics"),
);
app.post("/:proj", (c) => handleIngest(c, c.req.param("proj")));
app.get("/:proj", (c) => projectPage(c, c.req.param("proj")));

export default {
	fetch: app.fetch,
	async scheduled(_controller, env, ctx) {
		await ensureReady(env.DB);
		ctx.waitUntil(runRollup(env));
	},
} satisfies ExportedHandler<Bindings>;
