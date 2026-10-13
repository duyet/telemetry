import type { Ctx } from "../types.ts";

/** Owner: agent C. */
export function landingPage(c: Ctx) {
	return c.html(<p>landing</p>);
}
