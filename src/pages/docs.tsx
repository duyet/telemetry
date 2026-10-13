import { raw } from "hono/html";
import { Marked, type Tokens } from "marked";
import { apiMd } from "../docs/content.ts";
import type { Ctx } from "../types.ts";
import { baseUrl } from "../util.ts";
import { DOCS_CSS, GITHUB_ICON, Layout, Masthead, MastheadLine, REPO, type TocEntry } from "./layout.tsx";

/** Owner: frontend agent. */
export function docsPage(c: Ctx) {
	return c.html(<DocsView base={baseUrl(c.req.raw)} />);
}

/** "Sending events" → "sending-events". Same function for the heading ids and the rail links. */
export function headingId(text: string): string {
	return text
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/&[a-z]+;/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

const md = new Marked({
	gfm: true,
	renderer: {
		heading({ tokens, depth }: Tokens.Heading) {
			const html = this.parser.parseInline(tokens);
			if (depth === 1) return `<h1>${html}</h1>\n`;
			return `<h${depth} id="${headingId(html)}">${html}</h${depth}>\n`;
		},
	},
});

/** Renders our own markdown; the source is trusted, so no sanitizing. The h2 headings become the rail TOC. */
export function renderDocs(markdown: string): { html: string; toc: TocEntry[] } {
	const toc: TocEntry[] = [];
	for (const t of md.lexer(markdown)) {
		if (t.type === "heading" && t.depth === 2) toc.push({ id: headingId(t.text), label: t.text });
	}
	return { html: md.parse(markdown, { async: false }), toc };
}

export function DocsView({ base }: { base: string }) {
	const { html, toc } = renderDocs(apiMd(base));
	return (
		<Layout
			title="API docs · telemetry"
			description="HTTP API reference: sending events, OTLP, stats, projects and import."
			toc={toc}
			current="docs"
			css={DOCS_CSS}
		>
			<Masthead
				name="telemetry"
				href="/"
				tagline="API reference"
				icons={[{ href: REPO, label: "telemetry on GitHub", svg: GITHUB_ICON }]}
			>
				<MastheadLine
					items={[
						"/docs",
						<a href="/llms.txt">llms.txt</a>,
						<a href="/AGENTS.md">AGENTS.md</a>,
						<a href={REPO}>Source</a>,
					]}
				/>
			</Masthead>
			<article class="prose lede">{raw(html)}</article>
		</Layout>
	);
}
