import type { Ctx, Project } from "./types.ts";

/** Owner: agent B. Used by the landing page and the API. */
export async function queryProjects(db: D1Database): Promise<Project[]> {
	throw new Error(`not implemented ${typeof db}`);
}

export async function listProjects(c: Ctx): Promise<Response> {
	throw new Error(`not implemented ${c.req.url}`);
}
export async function createProject(c: Ctx): Promise<Response> {
	throw new Error(`not implemented ${c.req.url}`);
}
export async function deleteProject(c: Ctx, slug: string): Promise<Response> {
	throw new Error(`not implemented ${slug} ${c.req.url}`);
}
export async function importRollups(c: Ctx, slug: string): Promise<Response> {
	throw new Error(`not implemented ${slug} ${c.req.url}`);
}
export async function rollupProject(c: Ctx, slug: string): Promise<Response> {
	throw new Error(`not implemented ${slug} ${c.req.url}`);
}
