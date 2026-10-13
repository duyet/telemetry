import type { Bindings } from "./types.ts";

/** Cron: AE SQL → one `daily` row per active project for `day` (default yesterday UTC). Owner: agent B. */
export async function runRollup(env: Bindings, day?: string, project?: string): Promise<{ projects: number }> {
	throw new Error(`not implemented ${day} ${project} ${Object.keys(env)}`);
}
