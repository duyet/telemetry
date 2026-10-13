import type { Ctx } from "../types.ts";

/** Owner: agent C. */
export async function projectPage(c: Ctx, slug: string) {
	return c.html(<p>{slug}</p>);
}
