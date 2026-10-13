import { raw } from "hono/html";
import { marked } from "marked";
import { apiMd } from "../docs/content.ts";
import type { Ctx } from "../types.ts";
import { baseUrl } from "../util.ts";
import { Layout } from "./layout.tsx";

/** Owner: agent C. */
export function docsPage(c: Ctx) {
	return c.html(<DocsView base={baseUrl(c.req.raw)} />);
}

/** Renders our own markdown; the source is trusted, so no sanitizing. */
export function DocsView({ base }: { base: string }) {
	const html = marked.parse(apiMd(base), { async: false, gfm: true });
	return (
		<Layout title="API docs · telemetry" description="HTTP API reference: sending events, OTLP, stats, projects and import.">
			<article class="prose">{raw(html)}</article>
		</Layout>
	);
}
