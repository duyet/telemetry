import type { Ctx } from "../types.ts";

/** Owner: agent C. */
export function docsPage(c: Ctx) {
	return c.html(<p>docs</p>);
}
