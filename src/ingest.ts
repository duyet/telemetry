import type { Ctx } from "./types.ts";

/** `POST /<project>`: native JSON ingest. Owner: agent A. */
export async function handleIngest(c: Ctx, project: string): Promise<Response> {
	throw new Error(`not implemented: ingest ${project} ${c.req.url}`);
}

/** `POST /<project>/v1/{logs,traces,metrics}`: OTLP/HTTP JSON ingest. Owner: agent A. */
export async function handleOtlp(c: Ctx, project: string, signal: "logs" | "traces" | "metrics"): Promise<Response> {
	throw new Error(`not implemented: otlp ${project} ${signal} ${c.req.url}`);
}
