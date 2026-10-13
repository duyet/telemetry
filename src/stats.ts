import type { Bindings, Stats } from "./types.ts";

export const DAY_RANGES = [7, 30, 90, 365] as const;

export function parseDays(v: string | undefined): number {
	const n = Number(v);
	return (DAY_RANGES as readonly number[]).includes(n) ? n : 30;
}

/** Owner: agent B. */
export async function getStats(env: Bindings, slug: string, days: number): Promise<Stats> {
	throw new Error(`not implemented ${slug} ${days} ${Object.keys(env)}`);
}
