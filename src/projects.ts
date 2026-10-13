import type { Ctx } from "./types.ts";

/** Owner: agent B. */
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
